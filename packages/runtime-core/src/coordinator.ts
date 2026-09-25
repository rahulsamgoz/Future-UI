/**
 * Operation coordinator (architecture sections 8-9): coordinates local
 * preference application with the host adapter's renderer switcher, using
 * optimistic concurrency on preference revisions.
 */
import {
  UiIntelligenceError,
  newId,
} from "@ui-intelligence/protocol";
import type {
  ApplicationId,
  ApplicationRecord,
  JsonValue,
  PreferenceKey,
  PreferenceRecord,
  Proposal,
} from "@ui-intelligence/protocol";

/**
 * Structural store port implemented by the preferences package (memory and
 * IndexedDB stores). All multi-record mutations are transactional in the
 * store; a revision mismatch inside a transaction is signaled by throwing a
 * UiIntelligenceError with code "STALE_REVISION" whose details carry the
 * currentRevision (the preferences package defines a PreferenceConflictError
 * subclass with exactly that shape).
 */
export type ApplicationParticipantInput = {
  key: PreferenceKey;
  previousRevision: number;
  previousDigest: string | null;
  proposedDigest: string | null;
  contractVersion?: number;
};

export type ProposedSpecificationEntry = {
  digest: string;
  requiredRendererVersions: Record<string, number>;
};

export interface PreferenceStoreLike {
  beginApplication(
    applicationId: string,
    participants: ApplicationParticipantInput[],
    proposed: Record<string, ProposedSpecificationEntry>,
  ): Promise<void>;
  finalizeApplication(applicationId: string): Promise<void>;
  rollbackApplication(applicationId: string, reason: string): Promise<void>;
  getApplication(applicationId: string): Promise<ApplicationRecord | null>;
  undoApplication(applicationId: string): Promise<{ restored: string[]; conflicts?: string[] }>;
  getPreference(key: PreferenceKey): Promise<PreferenceRecord | null>;
  recoverPending(): Promise<string[]>;
}

/** Host adapter port for one renderer switch (architecture section 6). */
export type RendererSwitcher = {
  canSwitch(): { allowed: true } | { allowed: false; reason: string };
  exportState(): JsonValue;
  validateState(state: JsonValue, destinationRenderer: string): boolean;
  importState(state: JsonValue): void;
  commit(): Promise<void>;
};

export type ApplicationSpecification = {
  digest: string;
  proposal: Proposal;
  requiredRendererVersions: Record<string, number>;
  contractVersion?: number;
};

export type ApplyResult = {
  applicationId: string;
  status: "active" | "failed" | "conflict";
};

export type UndoResult = { restored: string[]; conflicts?: string[] };

export function isRevisionConflict(error: unknown): error is UiIntelligenceError {
  return error instanceof UiIntelligenceError && error.code === "STALE_REVISION";
}

/** Derive the destination renderer id from a proposal (entity scope). */
export function destinationRendererOf(proposal: Proposal): string {
  const presentation = proposal.presentation as { type?: unknown } | null | undefined;
  if (
    presentation &&
    typeof presentation === "object" &&
    typeof presentation.type === "string"
  ) {
    return presentation.type;
  }
  return "";
}

export class OperationCoordinator {
  /**
   * Apply a validated specification as one local preference transaction:
   * record the pending application (previous revisions/digests) in the store,
   * switch the renderer through the host adapter, and finalize — or roll
   * back. A revision conflict is reported without touching the UI.
   *
   * The EXPECTED revision is `readSet.preferenceRevision` — the revision the
   * proposal was generated against (what the user saw) — NOT a fresh read of
   * the store. The store re-checks it transactionally in beginApplication,
   * so an apply built on a stale view returns { status: "conflict" } instead
   * of overwriting a newer revision written in the meantime.
   */
  async apply(
    store: PreferenceStoreLike,
    key: PreferenceKey,
    specification: ApplicationSpecification,
    readSet: { preferenceRevision: number },
    switcher: RendererSwitcher,
  ): Promise<ApplyResult> {
    const current = await store.getPreference(key);
    const applicationId = newId<ApplicationId>("app");
    const participant: ApplicationParticipantInput = {
      key,
      // Expected previous revision: what the caller's read set observed. A
      // mismatch against the store's CURRENT revision is a conflict.
      previousRevision: readSet.preferenceRevision,
      previousDigest: current?.activeSpecificationDigest ?? null,
      proposedDigest: specification.digest,
      ...(specification.contractVersion !== undefined
        ? { contractVersion: specification.contractVersion }
        : {}),
    };

    try {
      await store.beginApplication(applicationId, [participant], {
        [key.scopeKey]: {
          digest: specification.digest,
          requiredRendererVersions: specification.requiredRendererVersions,
        },
      });
    } catch (error) {
      if (isRevisionConflict(error)) {
        return { applicationId, status: "conflict" };
      }
      throw error;
    }

    const rollback = async (reason: string): Promise<ApplyResult> => {
      await store.rollbackApplication(applicationId, reason);
      return { applicationId, status: "failed" };
    };

    const destinationRenderer = destinationRendererOf(specification.proposal);

    try {
      const canSwitch = switcher.canSwitch();
      if (!canSwitch.allowed) {
        return rollback(`renderer switch disallowed: ${canSwitch.reason}`);
      }
      const state = switcher.exportState();
      if (!switcher.validateState(state, destinationRenderer)) {
        return rollback("destination renderer rejected the exported state");
      }
      switcher.importState(state);
      await switcher.commit();
    } catch (error) {
      return rollback(
        `renderer switch failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      await store.finalizeApplication(applicationId);
    } catch (error) {
      if (isRevisionConflict(error)) {
        // A concurrent operation won the revision race. Mark this losing
        // application failed so it does not linger as pending until startup
        // recovery; the caller restores the previous live view.
        try {
          await store.rollbackApplication(applicationId, "finalize conflict: concurrent revision change");
        } catch {
          /* record already terminal */
        }
        return { applicationId, status: "conflict" };
      }
      throw error;
    }
    return { applicationId, status: "active" };
  }

  /**
   * Undo an active application inside one store transaction. A participant
   * whose revision moved on is reported in conflicts and NOT overwritten.
   */
  async undo(store: PreferenceStoreLike, applicationId: string): Promise<UndoResult> {
    return store.undoApplication(applicationId);
  }

  /** Interrupted commits recover to the previous confirmed version at startup. */
  async recoverAtStartup(store: PreferenceStoreLike): Promise<string[]> {
    return store.recoverPending();
  }
}
