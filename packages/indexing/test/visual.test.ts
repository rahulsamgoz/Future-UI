/**
 * Visual crop matcher tests (spec section 13). Synthetic PNGs are generated
 * in-test with pngjs; scores are similarity ranks, never confidence claims.
 */
import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import { decodePng, downsample, groundScreenshot, matchCrop, type DecodedImage, type Rect } from "../src/visual.js";

/** Solid-color PNG of the given size. */
function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = rgb[0];
    png.data[i + 1] = rgb[1];
    png.data[i + 2] = rgb[2];
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

/** 200x200 image with four distinct 100x100 colored quadrants. */
function quadrantPng(): Buffer {
  const png = new PNG({ width: 200, height: 200 });
  const colors: Array<[number, number, number]> = [
    [200, 30, 30], // red (top-left)
    [30, 200, 30], // green (top-right)
    [30, 30, 200], // blue (bottom-left)
    [200, 200, 30], // yellow (bottom-right)
  ];
  for (let y = 0; y < 200; y++) {
    for (let x = 0; x < 200; x++) {
      const idx = (200 * y + x) << 2;
      const c = colors[(y < 100 ? 0 : 2) + (x < 100 ? 0 : 1)];
      png.data[idx] = c[0];
      png.data[idx + 1] = c[1];
      png.data[idx + 2] = c[2];
      png.data[idx + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

function cropRegion(image: DecodedImage, region: Rect): Buffer {
  const png = new PNG({ width: region.width, height: region.height });
  for (let y = 0; y < region.height; y++) {
    for (let x = 0; x < region.width; x++) {
      const src = ((region.y + y) * image.width + (region.x + x)) * 4;
      const dst = (region.width * y + x) << 2;
      png.data[dst] = image.data[src];
      png.data[dst + 1] = image.data[src + 1];
      png.data[dst + 2] = image.data[src + 2];
      png.data[dst + 3] = image.data[src + 3];
    }
  }
  return PNG.sync.write(png);
}

const QUADRANTS: Array<{ name: string; region: Rect }> = [
  { name: "red", region: { x: 0, y: 0, width: 100, height: 100 } },
  { name: "green", region: { x: 100, y: 0, width: 100, height: 100 } },
  { name: "blue", region: { x: 0, y: 100, width: 100, height: 100 } },
  { name: "yellow", region: { x: 100, y: 100, width: 100, height: 100 } },
];

describe("decodePng / downsample", () => {
  it("decodes a PNG to RGBA dimensions", () => {
    const image = decodePng(solidPng(24, 12, [1, 2, 3]));
    expect(image.width).toBe(24);
    expect(image.height).toBe(12);
    expect(image.data.length).toBe(24 * 12 * 4);
  });

  it("downscales with a box filter to the target width", () => {
    const image = decodePng(solidPng(100, 50, [10, 20, 30]));
    const small = downsample(image, 64);
    expect(small.width).toBe(64);
    expect(small.height).toBe(32);
    // Solid color is preserved through the box filter.
    expect(small.data[0]).toBe(10);
    expect(small.data[1]).toBe(20);
    expect(small.data[2]).toBe(30);
  });

  it("never upsamples past the source width", () => {
    const image = decodePng(solidPng(8, 8, [0, 0, 0]));
    expect(downsample(image, 64).width).toBe(8);
  });
});

describe("matchCrop", () => {
  const haystack = decodePng(quadrantPng());

  it("scores an exact crop of the correct region ~1.0 and other regions low", () => {
    const crop = decodePng(cropRegion(haystack, QUADRANTS[0].region));
    for (const q of QUADRANTS) {
      const { score } = matchCrop(haystack, crop, q.region);
      if (q.name === "red") expect(score).toBeGreaterThan(0.99);
      else expect(score).toBeLessThan(0.9);
    }
  });

  it("still ranks the correct region first when the crop was resized", () => {
    // The red quadrant rendered at a smaller size (e.g. device-scale change).
    const smallRed = decodePng(solidPng(37, 41, [200, 30, 30]));
    const scores = QUADRANTS.map((q) => ({ name: q.name, score: matchCrop(haystack, smallRed, q.region).score }));
    scores.sort((a, b) => b.score - a.score);
    expect(scores[0].name).toBe("red");
    expect(scores[0].score).toBeGreaterThan(0.99);
  });

  it("clamps out-of-bounds regions without throwing", () => {
    const crop = decodePng(cropRegion(haystack, QUADRANTS[0].region));
    expect(() => matchCrop(haystack, crop, { x: 150, y: 150, width: 400, height: 400 })).not.toThrow();
    expect(matchCrop(haystack, crop, { x: -50, y: -50, width: 150, height: 150 }).score).toBeGreaterThanOrEqual(0);
  });

  it("returns score 0 for degenerate inputs instead of throwing", () => {
    const crop = decodePng(solidPng(4, 4, [0, 0, 0]));
    expect(matchCrop(haystack, crop, { x: 199, y: 199, width: 0, height: 0 }).score).toBe(0);
    expect(matchCrop(haystack, { width: 0, height: 0, data: new Uint8Array(0) }, QUADRANTS[0].region).score).toBe(0);
  });
});

describe("groundScreenshot", () => {
  const haystack = decodePng(quadrantPng());
  const redCrop = decodePng(cropRegion(haystack, QUADRANTS[0].region));
  const digest = "d".repeat(64);

  function candidate(occurrenceId: string, region: Rect) {
    return {
      occurrenceId,
      entityKey: `catalog.${occurrenceId}`,
      captureId: "cap_1",
      screenshotDigest: digest,
      bounds: region,
      scroll: { x: 0, y: 0 },
    };
  }

  it("ranks the matching region first and sorts descending", () => {
    const results = groundScreenshot(redCrop, QUADRANTS.map((q) => candidate(q.name, q.region)), () => quadrantPng());
    expect(results).toHaveLength(4);
    expect(results[0].occurrenceId).toBe("red");
    expect(results[0].score).toBeGreaterThan(0.99);
    for (let i = 1; i < results.length; i++) expect(results[i].score).toBeLessThanOrEqual(results[i - 1].score);
  });

  it("accounts for scroll offsets when locating the region", () => {
    // Same red quadrant, but the page was scrolled 120px down when captured.
    const results = groundScreenshot(
      redCrop,
      [{ ...candidate("red", { x: 0, y: 120, width: 100, height: 100 }), scroll: { x: 0, y: 120 } }],
      () => quadrantPng()
    );
    expect(results[0].score).toBeGreaterThan(0.99);
  });

  it("omits candidates whose screenshot cannot be loaded or decoded (corrupt bytes)", () => {
    const corrupt = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]);
    const corruptDigest = "c".repeat(64);
    const missingDigest = "m".repeat(64);
    // One candidate with no bytes, one with corrupt bytes, one good.
    const results = groundScreenshot(
      redCrop,
      [{ ...candidate("missing", QUADRANTS[0].region), screenshotDigest: missingDigest }, { ...candidate("corrupt", QUADRANTS[0].region), screenshotDigest: corruptDigest }, candidate("red", QUADRANTS[0].region)],
      (d) => (d === missingDigest ? null : d === corruptDigest ? corrupt : quadrantPng())
    );
    expect(results.map((r) => r.occurrenceId)).toEqual(["red"]);
  });

  it("reuses the provided decoded-image cache across calls", () => {
    const cache = new Map<string, DecodedImage | null>();
    const candidates = QUADRANTS.map((q) => candidate(q.name, q.region));
    let loads = 0;
    const load = () => {
      loads++;
      return quadrantPng();
    };
    groundScreenshot(redCrop, candidates, load, cache);
    groundScreenshot(redCrop, candidates, load, cache);
    expect(loads).toBe(1); // second call hit the cache
  });
});
