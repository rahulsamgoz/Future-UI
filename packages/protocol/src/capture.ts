/**
 * Capture contracts (protocol section 5).
 * An application does not have one appearance per commit: capture is defined
 * by both build and scenario.
 */
import { z } from "zod";
import { canonicalJson } from "./ids.js";
import type { ArtifactId, CaptureId, EntityVersionId, OccurrenceId, SourceDefinitionId } from "./ids.js";
import type { EvidenceLabel, SourceLinkEvidence } from "./evidence.js";

export const PROTOCOL_VERSION = 1;

export const colorSchemeSchema = z.enum(["light", "dark"]);

export const scenarioSchema = z.object({
  id: z.string().min(1),
  recipeDigest: z.string().min(1),
  route: z.string().min(1),
  fixtureDigest: z.string().min(1),
  role: z.string().min(1),
  featureFlagsDigest: z.string().min(1),
  viewport: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    deviceScaleFactor: z.number().positive(),
  }),
  locale: z.string().min(1),
  timeZone: z.string().min(1),
  colorScheme: colorSchemeSchema,
  reducedMotion: z.boolean(),
});
export type Scenario = z.infer<typeof scenarioSchema>;

export const environmentSchema = z.object({
  runnerImageDigest: z.string(),
  browserRevision: z.string(),
  fontsDigest: z.string(),
  adapterVersion: z.string(),
  captureToolVersion: z.string(),
  redactionPolicyDigest: z.string(),
});
export type CaptureEnvironment = z.infer<typeof environmentSchema>;

export const captureSpecSchema = z.object({
  protocolVersion: z.literal(1),
  projectId: z.string().min(1),
  commitSha: z.string().min(1),
  buildArtifactDigest: z.string().min(1),
  scenario: scenarioSchema,
  environment: environmentSchema,
});
export type CaptureSpec = z.infer<typeof captureSpecSchema>;

export const boundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

export const sourceLinkSchema = z.object({
  definitionId: z.string().min(1),
  evidence: z.enum(["registered", "instrumented", "inferred"]),
});

export const observationSchema = z.object({
  occurrenceId: z.string().min(1),
  captureId: z.string().min(1),
  parentOccurrenceId: z.string().optional(),
  entityVersionId: z.string().optional(),
  explicitAnchor: z.string().optional(),
  role: z.string().optional(),
  visibleText: z.string().optional(), // already sanitized
  bounds: z.array(boundsSchema).min(1),
  coordinateSpace: z.literal("document-css-pixels"),
  sourceLinks: z.array(sourceLinkSchema),
  screenshotArtifactId: z.string().optional(),
  domArtifactId: z.string().optional(),
  completeness: z.enum(["complete-for-scenario", "partial"]),
  limitations: z.array(z.string()),
});
export type Observation = z.infer<typeof observationSchema>;

/** Full capture manifest stored/published after ingestion. */
export const captureManifestSchema = z.object({
  captureId: z.string().min(1),
  spec: captureSpecSchema,
  capturedAt: z.string().datetime(),
  gitParents: z.array(z.string()),
  observations: z.array(observationSchema),
  artifacts: z.array(
    z.object({
      artifactId: z.string().min(1),
      kind: z.enum(["screenshot-png", "dom-package", "manifest-json"]),
      digest: z.string().min(1),
      byteSize: z.number().int().nonnegative(),
      mimeType: z.string(),
    })
  ),
  buildOutcome: z.enum(["succeeded", "failed"]),
  failureReason: z.string().optional(),
  redactionMasks: z.array(z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })).default([]),
  scrollOffsets: z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 }),
  idempotencyKey: z.string().min(1),
});
export type CaptureManifest = z.infer<typeof captureManifestSchema>;

export type CaptureRequestKey = string;

/** Canonical serialization used to build the capture request key (spec
 * section 11: canonical serialization — key order must not matter). */
export function captureRequestKey(spec: CaptureSpec): CaptureRequestKey {
  return canonicalJson([
    spec.protocolVersion,
    spec.projectId,
    spec.commitSha,
    spec.buildArtifactDigest,
    spec.scenario,
    spec.environment,
  ]);
}

/** A stored capture record with its evidence label. */
export type CaptureRecord = {
  captureId: CaptureId;
  projectId: string;
  buildId: string;
  scenarioId: string;
  commitSha: string;
  evidenceLabel: EvidenceLabel;
  manifest: CaptureManifest;
  createdAt: string;
};

export type { ArtifactId, CaptureId, EntityVersionId, OccurrenceId, SourceDefinitionId, SourceLinkEvidence };
