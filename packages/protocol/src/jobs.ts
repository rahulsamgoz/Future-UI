/**
 * Durable job contracts (protocol section 11).
 * Delivery is at least once, not assumed exactly once.
 */
import { z } from "zod";

export const jobStatusSchema = z.enum(["queued", "running", "succeeded", "failed", "cancelled"]);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export type JobStage =
  | "planning"
  | "building"
  | "capturing"
  | "indexing"
  | "embedding"
  | "lineage"
  | "finalizing"
  | "done";

export type JobKind =
  | "history_scan"
  | "capture"
  | "index_capture"
  | "embedding"
  | "proposal";

export type JobRecord = {
  jobId: string;
  projectId: string;
  kind: JobKind;
  status: JobStatus;
  stage: JobStage;
  payload: unknown;
  deduplicationKey: string | null;
  attempt: number;
  maxAttempts: number;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

export type LeaseClaim = {
  jobId: string;
  leaseToken: string;
  leaseExpiresAt: string;
};

/** Bounded retry with backoff. */
export function backoffMs(attempt: number): number {
  return Math.min(30_000, 250 * 2 ** Math.max(0, attempt - 1));
}

/** Resource limits enforced per job (protocol section 11). */
export type JobResourceLimits = {
  maxBuildTimeMs: number;
  maxCaptureCount: number;
  maxArtifactBytes: number;
  maxModelCalls: number;
};
