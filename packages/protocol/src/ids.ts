/**
 * Opaque, branded identifier types (protocol section 4: The identity model).
 *
 * Component definition, semantic purpose, current instance, and historical
 * screenshot are deliberately distinct IDs. Never collapse them.
 */

declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type ProjectId = Brand<string, "ProjectId">;
export type EntityId = Brand<string, "EntityId">;
export type EntityVersionId = Brand<string, "EntityVersionId">;
export type OccurrenceId = Brand<string, "OccurrenceId">;
export type RuntimeInstanceId = Brand<string, "RuntimeInstanceId">;
export type CaptureId = Brand<string, "CaptureId">;
export type BuildId = Brand<string, "BuildId">;
export type CommitSha = Brand<string, "CommitSha">;
export type ArtifactId = Brand<string, "ArtifactId">;
export type ProposalId = Brand<string, "ProposalId">;
export type ApplicationId = Brand<string, "ApplicationId">;
export type SourceDefinitionId = Brand<string, "SourceDefinitionId">;
export type CapabilityId = Brand<string, "CapabilityId">;
export type JobId = Brand<string, "JobId">;
export type RequestId = Brand<string, "RequestId">;
export type TraceId = Brand<string, "TraceId">;
export type HistoryPlanId = Brand<string, "HistoryPlanId">;

/** Allocate an opaque ID with a readable prefix. */
export function newId<T extends string>(prefix: string): T {
  const uuid = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}_${uuid.replace(/-/g, "").slice(0, 24)}` as T;
}

/** SHA-256 hex digest of a canonical JSON serialization. */
export async function digestOf(value: unknown): Promise<string> {
  const canonical = canonicalJson(value);
  const bytes = new TextEncoder().encode(canonical);
  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Deterministic JSON serialization: object keys sorted lexicographically. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}
