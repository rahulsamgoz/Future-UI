/**
 * Visual crop matching for screenshot grounding (spec section 13). Pure,
 * dependency-light (pngjs only): decode, box-filter downscale, and a
 * normalized region-similarity score. Scores are similarity ranks only —
 * never displayed as confidence percentages.
 */
import { PNG } from "pngjs";

/** RGBA image, row-major, 4 bytes per pixel. */
export type DecodedImage = { width: number; height: number; data: Uint8Array };

/** Region in image pixel coordinates. */
export type Rect = { x: number; y: number; width: number; height: number };

/** Width both crop and candidate region are downscaled to before comparison. */
const MATCH_WIDTH = 64;

/** Synchronously decode a PNG. Throws on malformed bytes. */
export function decodePng(bytes: Uint8Array): DecodedImage {
  const png = PNG.sync.read(Buffer.from(bytes));
  return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
}

/**
 * Box-filter downscale to `targetWidth` pixels wide (never upsamples; the
 * output width is min(image.width, targetWidth)), height scaled
 * proportionally. Each output pixel averages its source box, so the result
 * is deterministic and robust to resizing noise.
 */
export function downsample(image: DecodedImage, targetWidth: number): DecodedImage {
  if (image.width < 1 || image.height < 1) return { width: 0, height: 0, data: new Uint8Array(0) };
  const width = Math.max(1, Math.min(image.width, Math.round(targetWidth)));
  const height = Math.max(1, Math.round((image.height * width) / image.width));
  const out = new Uint8Array(width * height * 4);
  for (let ty = 0; ty < height; ty++) {
    const y0 = Math.floor((ty * image.height) / height);
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * image.height) / height));
    for (let tx = 0; tx < width; tx++) {
      const x0 = Math.floor((tx * image.width) / width);
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * image.width) / width));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let y = y0; y < y1 && y < image.height; y++) {
        for (let x = x0; x < x1 && x < image.width; x++) {
          const i = (y * image.width + x) * 4;
          r += image.data[i];
          g += image.data[i + 1];
          b += image.data[i + 2];
          n++;
        }
      }
      const o = (ty * width + tx) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = 255;
    }
  }
  return { width, height, data: out };
}

/** Clamp a region to image bounds; out-of-bounds regions shrink, never grow. */
function clampRegion(image: DecodedImage, region: Rect): Rect {
  const x = Math.max(0, Math.min(Math.round(region.x), image.width - 1));
  const y = Math.max(0, Math.min(Math.round(region.y), image.height - 1));
  const right = Math.max(x + 1, Math.min(Math.round(region.x + region.width), image.width));
  const bottom = Math.max(y + 1, Math.min(Math.round(region.y + region.height), image.height));
  return { x, y, width: right - x, height: bottom - y };
}

function extractRegion(image: DecodedImage, region: Rect): DecodedImage {
  const data = new Uint8Array(region.width * region.height * 4);
  for (let y = 0; y < region.height; y++) {
    const src = ((region.y + y) * image.width + region.x) * 4;
    data.set(image.data.subarray(src, src + region.width * 4), y * region.width * 4);
  }
  return { width: region.width, height: region.height, data };
}

/**
 * Normalized similarity between `crop` and the `region` of `haystack`, in
 * [0, 1]: both are downscaled to a common width, then the per-channel mean
 * absolute difference (RGB, normalized to [0, 1]) is computed and
 * score = 1 - mad. Out-of-bounds regions are clamped. Degenerate inputs
 * (zero-area region or crop) score 0. Deterministic.
 */
export function matchCrop(haystack: DecodedImage, crop: DecodedImage, region: Rect): { score: number } {
  if (haystack.width < 1 || haystack.height < 1 || crop.width < 1 || crop.height < 1) {
    return { score: 0 };
  }
  if (!(region.width > 0) || !(region.height > 0)) return { score: 0 };
  const clamped = clampRegion(haystack, region);
  if (clamped.width < 1 || clamped.height < 1) return { score: 0 };
  const extracted = extractRegion(haystack, clamped);
  const commonWidth = Math.max(1, Math.min(MATCH_WIDTH, extracted.width, crop.width));
  const a = downsample(extracted, commonWidth);
  const b = downsample(crop, commonWidth);
  const height = Math.min(a.height, b.height);
  if (height < 1) return { score: 0 };
  let total = 0;
  let count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < commonWidth; x++) {
      const ia = (y * a.width + x) * 4;
      const ib = (y * b.width + x) * 4;
      for (let c = 0; c < 3; c++) {
        total += Math.abs(a.data[ia + c] - b.data[ib + c]);
        count++;
      }
    }
  }
  if (count === 0) return { score: 0 };
  const mad = total / count / 255;
  return { score: Math.max(0, Math.min(1, 1 - mad)) };
}

export type GroundCandidate = {
  occurrenceId: string;
  entityKey: string;
  captureId: string;
  screenshotDigest: string;
  /** Occurrence bounds in document CSS pixels. */
  bounds: Rect;
  /** Capture scroll offsets (document → screenshot translation). */
  scroll: { x: number; y: number };
};

export type GroundResult = { occurrenceId: string; entityKey: string; captureId: string; score: number };

/** Minimal cache contract so callers can share decoded screenshots across calls. */
export type DecodedImageCache = {
  get(digest: string): DecodedImage | null | undefined;
  set(digest: string, image: DecodedImage | null): void;
};

/**
 * Rank candidates by comparing the crop against each occurrence's region
 * (bounds minus scroll offset) within its screenshot. Results are sorted by
 * score descending (ties broken by occurrenceId for determinism). Candidates
 * whose screenshot cannot be loaded or decoded are omitted. Corrupt bytes
 * never throw — they just drop the candidate.
 */
export function groundScreenshot(
  crop: DecodedImage,
  candidates: GroundCandidate[],
  loadScreenshot: (digest: string) => Uint8Array | null,
  decodedCache?: DecodedImageCache
): GroundResult[] {
  const cache: DecodedImageCache = decodedCache ?? new Map<string, DecodedImage | null>();
  const results: GroundResult[] = [];
  for (const candidate of candidates) {
    let image = cache.get(candidate.screenshotDigest);
    if (image === undefined) {
      const bytes = loadScreenshot(candidate.screenshotDigest);
      let decoded: DecodedImage | null = null;
      if (bytes) {
        try {
          decoded = decodePng(bytes);
        } catch {
          decoded = null; // corrupt or unsupported bytes: omit the candidate
        }
      }
      image = decoded;
      cache.set(candidate.screenshotDigest, image);
    }
    if (!image) continue;
    const region: Rect = {
      x: candidate.bounds.x - candidate.scroll.x,
      y: candidate.bounds.y - candidate.scroll.y,
      width: candidate.bounds.width,
      height: candidate.bounds.height,
    };
    results.push({
      occurrenceId: candidate.occurrenceId,
      entityKey: candidate.entityKey,
      captureId: candidate.captureId,
      score: matchCrop(image, crop, region).score,
    });
  }
  results.sort((a, b) => b.score - a.score || a.occurrenceId.localeCompare(b.occurrenceId));
  return results;
}
