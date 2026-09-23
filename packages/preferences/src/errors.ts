/**
 * Structured error semantics for the preference stores (architecture
 * section 9). Optimistic-concurrency conflicts are thrown (not returned)
 * so they can abort in-flight IndexedDB transactions; every conflict is a
 * UiIntelligenceError with code STALE_REVISION, which the runtime-core
 * coordinator detects structurally.
 */
import { UiIntelligenceError } from "@ui-intelligence/protocol";
import type { PreferenceKey } from "@ui-intelligence/protocol";

export class PreferenceConflictError extends UiIntelligenceError {
  readonly currentRevision: number;
  readonly expectedRevision: number;
  readonly conflictKey: PreferenceKey;

  constructor(
    message: string,
    options: {
      conflictKey: PreferenceKey;
      expectedRevision: number;
      currentRevision: number;
    },
  ) {
    super("STALE_REVISION", message, {
      details: {
        key: options.conflictKey,
        expectedRevision: options.expectedRevision,
        currentRevision: options.currentRevision,
      },
    });
    this.name = "PreferenceConflictError";
    this.currentRevision = options.currentRevision;
    this.expectedRevision = options.expectedRevision;
    this.conflictKey = options.conflictKey;
  }
}

/** Composite string identity for a preference key (debug/undo reporting). */
export function preferenceKeyToString(key: PreferenceKey): string {
  return `${key.profileId}\u0000${key.projectId}\u0000${key.scope}\u0000${key.scopeKey}`;
}
