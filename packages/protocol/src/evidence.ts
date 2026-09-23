/**
 * Evidence labels (protocol section 5) and lifecycle states.
 */

/** What the system may claim about a piece of UI evidence. */
export const EVIDENCE_LABELS = [
  "captured_at_build",
  "reconstructed_from_commit",
  "replayed_artifact",
  "source_only",
  "unavailable",
] as const;
export type EvidenceLabel = (typeof EVIDENCE_LABELS)[number];

/** Evidence kinds for source provenance links. */
export const SOURCE_LINK_EVIDENCE = ["registered", "instrumented", "inferred"] as const;
export type SourceLinkEvidence = (typeof SOURCE_LINK_EVIDENCE)[number];

/** Lineage relation kinds (protocol section 4). */
export const LINEAGE_RELATIONS = [
  "continues_as",
  "split_into",
  "merged_into",
  "replaces",
] as const;
export type LineageRelation = (typeof LINEAGE_RELATIONS)[number];

export type ReviewState = "candidate" | "accepted" | "rejected";
