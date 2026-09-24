/**
 * Artifact upload + capture publication against the project API
 * (architecture section 12): stage the artifact first, then finalize the
 * capture with an idempotency key. Transient failures (network errors,
 * 5xx, 429) are retried with bounded exponential backoff; other 4xx
 * responses fail immediately.
 */
import { hashBytes } from "./scenario-runner.js";
import type { CaptureManifest } from "@ui-intelligence/protocol";
import { UiIntelligenceError } from "@ui-intelligence/protocol";

export type UploadApi = {
  baseUrl: string;
  token: string;
  projectId: string;
};

export type UploadResult = { captureId: string };

type ArtifactSlot = {
  slotId: string;
  uploadUrl: string;
};

const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 250;

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/** Backoff for the 0-based retry index: 250ms, 500ms, ... */
function retryDelayMs(retryIndex: number): number {
  return RETRY_BASE_DELAY_MS * 2 ** retryIndex;
}

/**
 * Fetch with bounded retries (review capture#11): network errors and 5xx/429
 * responses are retried up to MAX_ATTEMPTS total attempts; other 4xx
 * responses fail immediately. Returns the first definitive response (ok, or
 * a non-retryable failure) or, after exhausting retries, the last retryable
 * response — or rethrows the last network error.
 */
async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  let lastResponse: Response | null = null;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt - 1)));
    }
    try {
      const response = await fetch(url, init);
      if (response.ok || !isRetryableStatus(response.status)) {
        return response;
      }
      lastResponse = response;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastResponse) return lastResponse;
  throw lastError ?? new Error(`request to ${url} failed after ${MAX_ATTEMPTS} attempts`);
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

export class CaptureUploader {
  async upload(manifest: CaptureManifest, screenshotBytes: Uint8Array, api: UploadApi): Promise<UploadResult> {
    if (manifest.artifacts.length === 0) {
      // Fail fast: a manifest with zero artifacts cannot reference the
      // staged artifact, so the publication would be silently incomplete.
      throw new UiIntelligenceError(
        "INTERNAL",
        "capture manifest has no artifacts; refusing to upload a capture without a screenshot artifact",
      );
    }
    const digest = await hashBytes(screenshotBytes);
    const base = api.baseUrl.replace(/\/$/, "");

    const slotResponse = await fetchWithRetry(
      `${base}/v1/projects/${api.projectId}/artifact-uploads`,
      {
        method: "POST",
        headers: { ...authHeaders(api.token), "content-type": "application/json" },
        body: JSON.stringify({
          mediaType: "image/png",
          byteSize: screenshotBytes.byteLength,
          digest,
          // The capture manifest references this artifact id; the server uses
          // it when creating the artifact record so the reference resolves.
          // Undefined is acceptable when the manifest carries no screenshot
          // artifact entry.
          artifactId: manifest.artifacts.find((a) => a.kind === "screenshot-png")?.artifactId,
        }),
      },
    );
    if (slotResponse.status !== 201) {
      throw new UiIntelligenceError("INTERNAL", `artifact-uploads failed with status ${slotResponse.status}`, {
        details: await safeJson(slotResponse),
      });
    }
    const slot = (await slotResponse.json()) as ArtifactSlot;
    // The API may return an absolute URL or a path relative to its base.
    const uploadUrl = slot.uploadUrl.startsWith("http")
      ? slot.uploadUrl
      : new URL(slot.uploadUrl, `${base}/`).toString();

    // PUT retries reuse the SAME slot URL: a failed byte upload must never
    // re-allocate a slot — only the initial POST above allocates one.
    const putResponse = await fetchWithRetry(uploadUrl, {
      method: "PUT",
      headers: { ...authHeaders(api.token), "content-type": "image/png" },
      body: screenshotBytes as unknown as BodyInit,
    });
    if (!putResponse.ok) {
      throw new UiIntelligenceError("INTERNAL", `artifact upload failed with status ${putResponse.status}`);
    }

    const captureResponse = await fetchWithRetry(
      `${base}/v1/projects/${api.projectId}/captures`,
      {
        method: "POST",
        headers: {
          ...authHeaders(api.token),
          "content-type": "application/json",
          "idempotency-key": manifest.idempotencyKey,
        },
        body: JSON.stringify({ manifest }),
      },
    );
    if (!captureResponse.ok) {
      throw new UiIntelligenceError("INTERNAL", `captures failed with status ${captureResponse.status}`, {
        details: await safeJson(captureResponse),
      });
    }
    const { captureId } = (await captureResponse.json()) as { captureId: string };
    return { captureId };
  }
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}
