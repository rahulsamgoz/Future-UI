/**
 * Artifact upload + capture publication against the project API
 * (architecture section 12): stage the artifact first, then finalize the
 * capture with an idempotency key.
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

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

export class CaptureUploader {
  async upload(manifest: CaptureManifest, screenshotBytes: Uint8Array, api: UploadApi): Promise<UploadResult> {
    const digest = await hashBytes(screenshotBytes);
    const base = api.baseUrl.replace(/\/$/, "");

    const slotResponse = await fetch(`${base}/v1/projects/${api.projectId}/artifact-uploads`, {
      method: "POST",
      headers: { ...authHeaders(api.token), "content-type": "application/json" },
      body: JSON.stringify({
        mediaType: "image/png",
        byteSize: screenshotBytes.byteLength,
        digest,
        // The capture manifest references this artifact id; the server uses
        // it when creating the artifact record so the reference resolves.
        artifactId: manifest.artifacts.find((a) => a.kind === "screenshot-png")?.artifactId,
      }),
    });
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

    const putResponse = await fetch(uploadUrl, {
      method: "PUT",
      headers: { ...authHeaders(api.token), "content-type": "image/png" },
      body: screenshotBytes as unknown as BodyInit,
    });
    if (!putResponse.ok) {
      throw new UiIntelligenceError("INTERNAL", `artifact upload failed with status ${putResponse.status}`);
    }

    const captureResponse = await fetch(`${base}/v1/projects/${api.projectId}/captures`, {
      method: "POST",
      headers: {
        ...authHeaders(api.token),
        "content-type": "application/json",
        "idempotency-key": manifest.idempotencyKey,
      },
      body: JSON.stringify({ manifest }),
    });
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
