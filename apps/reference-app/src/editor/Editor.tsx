import { useCallback, useEffect, useState } from "react";
import type { JsonValue, LayoutNode, StateAdapter } from "@ui-intelligence/protocol";
import { useSelection } from "@ui-intelligence/react";
import type { RuntimeInstanceInfo } from "@ui-intelligence/runtime-core";
import { createControlledDataProvider, createStubActionBindings } from "@ui-intelligence/renderers";
import { useAppServices } from "../Services.js";
import { digestOf } from "@ui-intelligence/protocol";
import { type LocalCandidate, validatedCandidate } from "./LocalGenerator.js";
import { RulesTab } from "./RulesTab.js";
import { appRendererMap } from "../kernel.js";

type Tab = "select" | "candidates" | "batch" | "page" | "rules" | "history";

/**
 * End-user editor: select a boundary (click), inspect alternatives, preview
 * with controlled data and stub actions, accept, and undo. Preview actions
 * can never charge, submit, or modify live records.
 */
export function Editor() {
  const { kernel, preferences, generator, apiBaseUrl } = useAppServices();
  const selection = useSelection();
  const [open, setOpen] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [tab, setTab] = useState<Tab>("select");
  const [selected, setSelected] = useState<RuntimeInstanceInfo | null>(null);
  const [batchTargets, setBatchTargets] = useState<RuntimeInstanceInfo[]>([]);
  const [candidates, setCandidates] = useState<LocalCandidate[]>([]);
  const [generating, setGenerating] = useState(false);
  const [previewCandidate, setPreviewCandidate] = useState<LocalCandidate | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [lastApplicationId, setLastApplicationId] = useState<string | null>(null);
  const [history, setHistory] = useState<Array<{ captureId: string; evidenceLabel: string; commitSha: string; capturedAt: string; summary: string } | string> | null>(null);

  // Selection mode: intercept clicks at capture phase; never trigger app actions.
  useEffect(() => {
    if (!selectMode) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as (EventTarget & { composedPath?: () => Array<EventTarget | null> }) | null;
      if (!target) return;
      // Prefer the composed path (portals included); fall back to the ancestor
      // chain where composedPath is unavailable (e.g. jsdom).
      let path: Array<EventTarget | null>;
      if (typeof target.composedPath === "function") {
        path = target.composedPath();
      } else {
        path = [];
        let node: HTMLElement | null = target as HTMLElement;
        while (node) {
          path.push(node);
          node = node.parentElement;
        }
        path.push(document);
        path.push(window);
      }
      const instance = selection.selectFromEvent({ composedPath: () => path });
      if (instance) {
        e.preventDefault();
        e.stopPropagation();
        setSelected(instance);
        setTab("candidates");
        setCandidates([]);
        setSelectMode(false);
        setStatus(null);
      }
    };
    document.addEventListener("click", handler, true);
    return () => document.removeEventListener("click", handler, true);
  }, [selectMode, selection]);

  const switcherFor = useCallback((instance: RuntimeInstanceInfo) => {
    const state: StateAdapter | undefined = instance.bindings.state;
    return {
      canSwitch: () => (state ? state.canSwitch() : { allowed: true as const }),
      exportState: () => (state ? state.exportState() : null),
      validateState: (s: JsonValue, destination: string) =>
        state ? state.validateState(s, destination) : s === null,
      importState: (s: JsonValue) => {
        if (state && s !== null) state.importState(s);
      },
      commit: async () => {
        /* live view update happens in the preference transaction commit */
      },
    };
  }, []);

  async function generateFor(instance: RuntimeInstanceInfo) {
    setGenerating(true);
    setStatus(null);
    try {
      const result = await generator.candidatesFor(instance, "", [], 4);
      setCandidates(result);
      if (result.length === 0) setStatus("No valid candidates for this target's contract.");
    } finally {
      setGenerating(false);
    }
  }

  async function acceptCandidate(candidate: LocalCandidate) {
    if (!selected) return;
    const scopeKey = selected.contract.entityKey + (instanceKeyOf(selected) ? `#${instanceKeyOf(selected)}` : "");
    const readSet = await kernel.currentReadSet(selected.contract.entityKey, 1);
    const result = await preferences.apply(
      scopeKey,
      selected.contract.entityKey,
      {
        representation: candidate.representation,
        properties: candidate.properties,
        digest: candidate.digest,
        requiredRendererVersions: candidate.requiredRendererVersions,
        contractVersion: candidate.contractVersion,
        dataBindingId: candidate.dataBindingId,
        actionIds: candidate.actionIds,
      },
      switcherFor(selected),
      readSet
    );
    if (result.status === "active" && result.applicationId) {
      setLastApplicationId(result.applicationId);
      setStatus(`Applied ${candidate.representation}.`);
    } else {
      setStatus(`Could not apply: ${result.reason ?? result.status}`);
    }
  }

  function instanceKeyOf(instance: RuntimeInstanceInfo): string | null {
    const el = instance.getNode() as HTMLElement | null;
    return el?.getAttribute?.("data-ui-instance") ?? null;
  }

  async function undoLast() {
    const appId = lastApplicationId ?? (await preferences.lastApplication())?.applicationId;
    if (!appId) {
      setStatus("Nothing to undo.");
      return;
    }
    const result = await preferences.undo(appId);
    setStatus(
      result.conflicts && result.conflicts.length
        ? `Undone except: ${result.conflicts.join(", ")} (newer edits kept)`
        : "Undone."
    );
    setLastApplicationId(null);
  }

  // --- Batch: finite set of compatible controls across routes ---
  function addSelectedToBatch() {
    if (selected && !batchTargets.some((t) => t.runtimeInstanceId === selected.runtimeInstanceId)) {
      setBatchTargets((b) => [...b, selected]);
    }
  }

  async function applyBatchCompact() {
    if (batchTargets.length === 0) return;
    const participants = [];
    for (const instance of batchTargets) {
      const contract = instance.contract;
      if (!contract.allowedRepresentations.includes("button.compact@1")) continue;
      // The batch path goes through the SAME validation and content digest
      // as generated candidates — never bypass the validator.
      const candidate = await validatedCandidate(
        kernel,
        instance,
        "button.compact@1",
        { variant: "compact" },
        "generated",
        "Compact button variant"
      );
      if (!candidate) continue;
      const instanceKey = instanceKeyOf(instance);
      const scopeKey = instanceKey ? `${contract.entityKey}#${instanceKey}` : contract.entityKey;
      participants.push({
        scopeKey,
        entityKey: contract.entityKey,
        candidate,
        switcher: switcherFor(instance),
        readSet: await kernel.currentReadSet(contract.entityKey, 1),
      });
    }
    if (participants.length === 0) {
      setStatus("No compatible button targets in the batch.");
      return;
    }
    const result = await preferences.applyBatch(participants);
    if (result.status === "active" && result.applicationId) {
      setLastApplicationId(result.applicationId);
      setStatus(`Batch applied to ${participants.length} target(s).`);
    } else {
      setStatus(`Batch failed: ${result.reason ?? result.status}${result.failedScopeKey ? ` (at ${result.failedScopeKey})` : ""}`);
    }
  }

  // --- Page composition ---
  const pageKey = typeof window !== "undefined" && window.location.hash.startsWith("#/account") ? "account" : "catalog";
  const [layoutCandidates, setLayoutCandidates] = useState<Array<{ layout: LayoutNode; validation: { passed: boolean } }>>([]);
  const [previewLayout, setPreviewLayout] = useState<LayoutNode | null>(null);

  async function generateLayouts() {
    const contracts = await import("../contracts.js");
    const pageContract =
      pageKey === "account" ? contracts.accountPageContract : contracts.catalogPageContract;
    const entityContracts = new Map(contracts.allEntityContracts.map((c) => [c.entityKey, c]));
    const currentLayout: LayoutNode = previewLayout ?? defaultLayoutFor(pageKey);
    const result = await generator.layoutCandidatesFor(pageContract, entityContracts, currentLayout, 3);
    setLayoutCandidates(result.filter((r) => r.validation.passed));
  }

  async function acceptLayout(layout: LayoutNode) {
    // Digest covers the ENTIRE layout tree (canonical JSON), not just the
    // root type — structurally different layouts must not share a digest.
    const layoutDigest = await digestOf(layout);
    const result = await preferences.apply(
      `page:${pageKey}`,
      `page:${pageKey}`,
      {
        representation: "layout",
        properties: { layout } as unknown as Record<string, JsonValue>,
        digest: `layout-${pageKey}-${layoutDigest}`,
        requiredRendererVersions: { [layout.kind === "layout" ? layout.type : "region"]: 1 },
        contractVersion: 1,
        dataBindingId: "",
        actionIds: [],
      },
      {
        canSwitch: () => ({ allowed: true }),
        exportState: () => null,
        validateState: () => true,
        importState: () => {},
        commit: async () => {},
      },
      await kernel.currentReadSet(pageKey, 1)
    );
    if (result.status === "active" && result.applicationId) {
      setLastApplicationId(result.applicationId);
      setStatus(`Page layout applied (${layout.kind === "layout" ? layout.type : "region"}).`);
    } else {
      setStatus(`Could not apply layout: ${result.reason ?? result.status}`);
    }
  }

  // --- History (local proxy or remote service) ---
  async function loadHistory() {
    try {
      const token = (import.meta.env.VITE_API_TOKEN as string | undefined) ?? "dev-token";
      // Same-origin /v1 goes through the dev-server proxy; an absolute
      // VITE_API_BASE overrides it (tests, custom deployments).
      const base = apiBaseUrl ?? "";
      const res = await fetch(
        `${base}/v1/projects/reference-app/entities/${encodeURIComponent(selected?.contract.entityKey ?? "catalog.productChooser")}/history?access_token=${encodeURIComponent(token)}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const page = (await res.json()) as { observations: Array<{ captureId: string; evidenceLabel: string; commitSha: string; capturedAt: string; summary: string }> };
      setHistory(page.observations);
    } catch (error) {
      setHistory([`History unavailable: ${error instanceof Error ? error.message : String(error)}`]);
    }
  }

  // --- Screenshot grounding (spec section 13 journey) ---
  // Uploads a PNG crop via the artifact slot flow, then asks the API to
  // resolve it against authorized captures. Similarity ranks are shown
  // without invented confidence percentages.
  async function groundUpload(file: File | undefined) {
    if (!file) return;
    const push = (line: string) => setHistory((prev) => [...(prev ?? []), line]);
    try {
      const token = (import.meta.env.VITE_API_TOKEN as string | undefined) ?? "dev-token";
      const base = apiBaseUrl ?? "";
      const bytes = new Uint8Array(await file.arrayBuffer());
      const hash = await crypto.subtle.digest("SHA-256", bytes);
      const digest = Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
      const slotRes = await fetch(`${base}/v1/projects/reference-app/artifact-uploads`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ mediaType: "image/png", byteSize: bytes.byteLength, digest }),
      });
      if (!slotRes.ok) throw new Error(`HTTP ${slotRes.status}`);
      const { slotId } = (await slotRes.json()) as { slotId: string };
      const putRes = await fetch(`${base}/v1/artifacts/${slotId}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream", authorization: `Bearer ${token}` },
        body: bytes,
      });
      if (!putRes.ok) throw new Error(`HTTP ${putRes.status}`);
      const { artifactId } = (await putRes.json()) as { artifactId: string };
      const resolveRes = await fetch(`${base}/v1/projects/reference-app/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ target: { kind: "screenshot", artifactId } }),
      });
      if (!resolveRes.ok) throw new Error(`HTTP ${resolveRes.status}`);
      const result = (await resolveRes.json()) as
        | { status: "resolved"; entityKey: string }
        | { status: "ambiguous"; candidates: Array<{ entityKey: string }> }
        | { status: "no_match"; reason: string };
      if (result.status === "resolved") {
        push(`Grounded: resolved → ${result.entityKey}`);
      } else if (result.status === "ambiguous") {
        push(`Grounded: ambiguous — ${result.candidates.map((c) => c.entityKey).join(", ")}; select the intended region`);
      } else {
        push(`Grounded: no match — ${result.reason}`);
      }
    } catch (error) {
      push(`Grounded: failed — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function exportSpec() {
    const accepted = previewCandidate ?? candidates[0];
    if (!accepted) {
      setStatus("Nothing accepted yet to export.");
      return;
    }
    const spec = {
      format: "ui-intelligence/specification@1",
      target: { entityKey: selected?.contract.entityKey, scope: "entity" },
      presentation: { type: accepted.representation, properties: accepted.properties },
      requiredRendererVersions: accepted.requiredRendererVersions,
      provenance: { origin: accepted.originKind, generatedAt: new Date().toISOString(), tool: "reference-app local generator" },
    };
    const blob = new Blob([JSON.stringify(spec, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "ui-intelligence-spec.json";
    a.click();
    URL.revokeObjectURL(url);
    setStatus("Specification exported.");
  }

  if (!open) {
    return (
      <button className="editor-fab" onClick={() => setOpen(true)} data-testid="editor-open" aria-label="Open UI editor">
        ✦ Edit UI
      </button>
    );
  }

  return (
    <>
      <aside className="editor" data-testid="editor-panel" role="complementary" aria-label="UI editor">
        <header className="editor-header">
          <strong>UI Editor</strong>
          <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Close editor">✕</button>
        </header>
        <nav className="editor-tabs" role="tablist">
          {(["select", "candidates", "batch", "page", "rules", "history"] as Tab[]).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "tab active" : "tab"} onClick={() => setTab(t)} data-testid={t === "rules" ? "rules-tab" : undefined}>
              {t}
            </button>
          ))}
        </nav>
        <div className="editor-body">
          {tab === "select" && (
            <div>
              <p className="muted small">
                Click any region to select it. Repeated regions need distinct instance keys for instance-level preferences.
              </p>
              <button className={`btn ${selectMode ? "danger" : "primary"}`} onClick={() => setSelectMode((s) => !s)} data-testid="select-mode">
                {selectMode ? "Cancel selection" : "Select a region"}
              </button>
              {selected && (
                <div className="selection-info" data-testid="selection-info">
                  <div><strong>{selected.contract.entityKey}</strong></div>
                  <div className="muted small">{instanceKeyOf(selected) ? `instance: ${instanceKeyOf(selected)}` : "entity scope"}</div>
                  <div className="muted small">{selected.contract.allowedRepresentations.join(" · ")}</div>
                </div>
              )}
            </div>
          )}

          {tab === "candidates" && (
            <div>
              {!selected && <p className="muted small">Select a region first (Select tab).</p>}
              {selected && (
                <>
                  <button className="btn primary" onClick={() => void generateFor(selected)} disabled={generating} data-testid="generate">
                    {generating ? "Generating…" : "Show alternatives"}
                  </button>
                  <ul className="candidate-list">
                    {candidates.map((c) => (
                      <li key={c.candidateId} className="candidate" data-testid="candidate">
                        <div className="candidate-head">
                          <strong>{c.representation}</strong>
                          <span className={`origin origin-${c.originKind}`}>{c.originKind.replace("_", " ")}</span>
                        </div>
                        <div className="muted small">{c.summary}</div>
                        <div className="muted small digest" title={c.digest}>digest {c.digest.slice(0, 12)}…</div>
                        <div className="candidate-actions">
                          <button className="btn small" onClick={() => setPreviewCandidate(c)}>Preview</button>
                          <button className="btn small primary" onClick={() => void acceptCandidate(c)} data-testid="accept">Accept</button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}

          {tab === "batch" && (
            <div>
              <p className="muted small">
                Finite batch: add registered buttons on this route and the other route, then apply one compact
                preference revision to all of them.
              </p>
              <button className="btn" onClick={addSelectedToBatch} disabled={!selected}>Add selected target</button>{" "}
              <button className="btn primary" onClick={() => void applyBatchCompact()} disabled={batchTargets.length === 0} data-testid="apply-batch">
                Apply compact to {batchTargets.length} target(s)
              </button>
              <ul className="muted small batch-list">
                {batchTargets.map((t) => (
                  <li key={t.runtimeInstanceId}>{t.contract.entityKey}{instanceKeyOf(t) ? `#${instanceKeyOf(t)}` : ""}</li>
                ))}
              </ul>
            </div>
          )}

          {tab === "page" && (
            <div>
              <p className="muted small">Page composition for <strong>{pageKey}</strong>. Locked and required slots are preserved.</p>
              <button className="btn primary" onClick={() => void generateLayouts()} data-testid="generate-layouts">Show layouts</button>
              <ul className="candidate-list">
                {layoutCandidates.map((l, i) => (
                  <li key={i} className="candidate">
                    <div className="candidate-head"><strong>{l.layout.kind === "layout" ? l.layout.type : "region"}</strong></div>
                    <div className="candidate-actions">
                      <button className="btn small" onClick={() => setPreviewLayout(l.layout)}>Preview</button>
                      <button className="btn small primary" onClick={() => void acceptLayout(l.layout)}>Accept</button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {tab === "rules" && <RulesTab />}

          {tab === "history" && (
            <div>
              <button className="btn primary" onClick={() => void loadHistory()} data-testid="load-history">Load history</button>
              <label className="field">
                Ground screenshot:
                <input
                  type="file"
                  accept="image/png"
                  data-testid="ground-upload"
                  onChange={(e) => {
                    void groundUpload(e.target.files?.[0]);
                    e.currentTarget.value = "";
                  }}
                />
              </label>
              {history && (
                <ul className="history-list">
                  {history.map((h, i) =>
                    typeof h === "string" ? (
                      <li key={i} className="muted small">{h}</li>
                    ) : (
                      <li key={h.captureId} className="history-item">
                        <span className={`evidence evidence-${h.evidenceLabel}`}>{h.evidenceLabel}</span>
                        <span className="mono small">{h.commitSha.slice(0, 8)}</span>
                        <span className="muted small">{new Date(h.capturedAt).toLocaleDateString()}</span>
                        <div className="muted small">{h.summary}</div>
                      </li>
                    )
                  )}
                </ul>
              )}
            </div>
          )}
        </div>
        <footer className="editor-footer">
          <button className="btn small" onClick={() => void undoLast()} data-testid="undo">Undo</button>
          <button className="btn small" onClick={() => void exportSpec()}>Export spec</button>
          {status && <div className="editor-status" data-testid="editor-status">{status}</div>}
          <div className="muted small">
            {preferences.persistenceAvailable ? "Saved on this device (IndexedDB)" : "Session-only: persistence unavailable"}
          </div>
        </footer>
      </aside>

      {previewCandidate && selected && (
        <div className="preview-overlay" role="dialog" aria-label="Preview" data-testid="preview-overlay">
          <div className="preview-card">
            <header className="preview-header">
              <strong>Preview — {previewCandidate.representation}</strong>
              <button className="icon-btn" onClick={() => setPreviewCandidate(null)} aria-label="Close preview">✕</button>
            </header>
            <p className="muted small">
              Controlled data · stub actions (no live mutations). Origin: {previewCandidate.originKind.replace("_", " ")}.
            </p>
            <div className="preview-stage" data-testid="preview-stage">
              <PreviewRenderer
                rendererId={previewCandidate.representation}
                properties={previewCandidate.properties}
                instance={selected}
              />
            </div>
            <footer>
              <button className="btn primary" onClick={() => { void acceptCandidate(previewCandidate); setPreviewCandidate(null); }} data-testid="preview-accept">Accept</button>
              <button className="btn" onClick={() => setPreviewCandidate(null)}>Close</button>
            </footer>
          </div>
        </div>
      )}

      {previewLayout && (
        <div className="preview-overlay" role="dialog" aria-label="Layout preview" data-testid="layout-preview-overlay">
          <div className="preview-card wide">
            <header className="preview-header">
              <strong>Layout preview — {previewLayout.kind === "layout" ? previewLayout.type : "region"}</strong>
              <button className="icon-btn" onClick={() => setPreviewLayout(null)} aria-label="Close preview">✕</button>
            </header>
            <p className="muted small">Layout shape only; regions render their current content.</p>
            <div className="preview-stage">
              <LayoutPreviewShape layout={previewLayout} />
            </div>
            <footer>
              <button className="btn primary" onClick={() => { void acceptLayout(previewLayout); setPreviewLayout(null); }}>Accept</button>
              <button className="btn" onClick={() => setPreviewLayout(null)}>Close</button>
            </footer>
          </div>
        </div>
      )}
    </>
  );
}

function PreviewRenderer({
  rendererId,
  properties,
  instance,
}: {
  rendererId: string;
  properties: Record<string, JsonValue>;
  instance: RuntimeInstanceInfo;
}) {
  const Renderer = appRendererMap()[rendererId] as React.ComponentType<Record<string, unknown>> | undefined;
  if (!Renderer) return <div className="muted">Renderer not available for preview.</div>;
  const snapshot = instance.bindings.data.getSnapshot();
  const controlled = createControlledDataProvider(snapshot.value, `preview-${snapshot.revision}`);
  const stubs = createStubActionBindings(instance.contract.actions) as unknown as Record<string, unknown>;
  return (
    <Renderer
      contract={instance.contract}
      data={controlled.getSnapshot()}
      actions={stubs}
      state={instance.bindings.state}
      properties={properties}
    />
  );
}

function LayoutPreviewShape({ layout }: { layout: LayoutNode }) {
  if (layout.kind === "region") {
    return <div className="preview-region" data-slot={layout.slotId}>{layout.slotId}</div>;
  }
  const children = layout.children.map((c, i) => <LayoutPreviewShape key={i} layout={c} />);
  return (
    <div className={`preview-layout preview-${layout.type}`}>
      {children}
    </div>
  );
}

function defaultLayoutFor(pageKey: string): LayoutNode {
  return {
    kind: "layout",
    nodeId: "root",
    type: "stack@1",
    properties: {},
    children: pageKey === "account"
      ? [
          { kind: "region", nodeId: "r-profile", slotId: "profile", entityId: "account.profileForm" },
          { kind: "region", nodeId: "r-admin", slotId: "admin", entityId: "account.adminPanel" },
        ]
      : [
          { kind: "region", nodeId: "r-sort", slotId: "sort", entityId: "catalog.sortControl" },
          { kind: "region", nodeId: "r-chooser", slotId: "chooser", entityId: "catalog.productChooser" },
        ],
  };
}

