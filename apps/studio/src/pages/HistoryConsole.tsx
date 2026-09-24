import { useEffect, useState } from "react";
import { evidenceLabelClass, type ApiClient, type HistoryPageDto, type ObservationDto, type RuntimeManifest } from "../api.js";

export function HistoryConsole({ client, projectId }: { client: ApiClient; projectId: string }) {
  const [manifest, setManifest] = useState<RuntimeManifest | null>(null);
  const [entityKey, setEntityKey] = useState<string>("");
  const [scenario, setScenario] = useState<string>("");
  const [page, setPage] = useState<HistoryPageDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Compare view: two selected captures' screenshots rendered side by side.
  const [selected, setSelected] = useState<ObservationDto[]>([]);
  const [screenshotUrls, setScreenshotUrls] = useState<Record<string, string>>({});

  // Screenshot grounding (spec section 13): upload a crop, show the result.
  const [groundResult, setGroundResult] = useState<string | null>(null);

  async function groundScreenshot(file: File | undefined): Promise<void> {
    if (!file) return;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = await client.groundScreenshot(projectId, bytes);
      if (result.status === "resolved") {
        setGroundResult(`Grounded: resolved → ${result.entityKey}`);
      } else if (result.status === "ambiguous") {
        setGroundResult(
          `Grounded: ambiguous — ${result.candidates.map((c) => c.entityKey).join(", ")}; select the intended region`
        );
      } else {
        setGroundResult(`Grounded: no match — ${result.reason}`);
      }
    } catch (e) {
      setGroundResult(`Ground screenshot failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  useEffect(() => {
    client.getRuntimeManifest(projectId).then((m) => {
      setManifest(m);
      setEntityKey((current) => current || m.entities[0]?.entityKey || "");
    }).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [client, projectId]);

  useEffect(() => {
    if (!entityKey) return;
    let cancelled = false;
    client
      .getEntityHistory(projectId, entityKey, { scenario: scenario || undefined, limit: 50 })
      .then((res) => !cancelled && setPage(res))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [client, projectId, entityKey, scenario]);

  async function toggleCompare(obs: ObservationDto): Promise<void> {
    setSelected((current) => {
      const exists = current.find((o) => o.captureId === obs.captureId);
      if (exists) return current.filter((o) => o.captureId !== obs.captureId);
      const next = [...current, obs].slice(-2);
      return next;
    });
    if (!obs.screenshotArtifactId) return;
    if (screenshotUrls[obs.screenshotArtifactId]) return;
    try {
      const blob = await client.fetchArtifactBlob(projectId, obs.screenshotArtifactId);
      setScreenshotUrls((urls) => ({ ...urls, [obs.screenshotArtifactId!]: URL.createObjectURL(blob) }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (error) return <p className="error-banner">{error}</p>;

  const comparePair = selected.slice(0, 2);

  return (
    <div className="page">
      <section className="panel">
        <h2>Filters</h2>
        <label className="field">
          Entity:{" "}
          <select value={entityKey} onChange={(e) => setEntityKey(e.target.value)}>
            {(manifest?.entities ?? []).map((e) => (
              <option key={e.entityKey} value={e.entityKey}>
                {e.entityKey}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Scenario:{" "}
          <input
            type="text"
            placeholder="all scenarios"
            value={scenario}
            onChange={(e) => setScenario(e.target.value)}
          />
        </label>
      </section>

      <section className="panel">
        <h2>Ground screenshot</h2>
        <label className="field">
          Upload a PNG crop:
          <input
            type="file"
            accept="image/png"
            data-testid="ground-upload"
            onChange={(e) => {
              void groundScreenshot(e.target.files?.[0]);
              e.currentTarget.value = "";
            }}
          />
        </label>
        {groundResult ? <p className="muted">{groundResult}</p> : null}
      </section>

      <section className="panel">
        <h2>Timeline</h2>
        {!page ? (
          <p className="empty">Loading…</p>
        ) : page.observations.length === 0 ? (
          <p className="empty">No observations for this entity/scenario yet.</p>
        ) : (
          <ul className="timeline">
            {page.observations.map((obs) => (
              <li key={obs.occurrenceId} className="timeline-item">
                <span className={evidenceLabelClass(obs.evidenceLabel)}>{obs.evidenceLabel}</span>
                <span className="commit" title={obs.commitSha}>
                  {obs.commitSha.slice(0, 8)}
                </span>
                <span className="muted">{new Date(obs.capturedAt).toLocaleString()}</span>
                <span className="scenario">{obs.scenarioId}</span>
                <span className="summary">{obs.summary}</span>
                <button className="compare-toggle" onClick={() => toggleCompare(obs)}>
                  {selected.some((o) => o.captureId === obs.captureId) ? "✓ selected" : "compare"}
                </button>
              </li>
            ))}
          </ul>
        )}
        {page?.nextCursor ? <p className="muted">More observations available (cursor: {page.nextCursor.slice(0, 8)}…)</p> : null}
      </section>

      {page && page.gaps.length > 0 ? (
        <section className="panel">
          <h2>Coverage gaps</h2>
          <ul className="gaps">
            {page.gaps.map((g) => (
              <li key={`${g.scenarioId}-${g.kind}`}>
                <span className={`chip ${g.kind === "unbuildable" ? "chip-unavailable" : "chip-source"}`}>{g.kind}</span>{" "}
                {g.scenarioId}: {g.reason}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="panel">
        <h2>Side-by-side compare ({comparePair.length}/2 selected)</h2>
        {comparePair.length === 0 ? (
          <p className="empty">Select two captures from the timeline.</p>
        ) : (
          <div className="compare">
            {comparePair.map((obs) => (
              <figure key={obs.captureId} className="compare-pane">
                <figcaption>
                  {obs.scenarioId} @ {obs.commitSha.slice(0, 8)}{" "}
                  <span className={evidenceLabelClass(obs.evidenceLabel)}>{obs.evidenceLabel}</span>
                  <br />
                  <span className="muted">
                    {obs.anchor ?? "unanchored"} · {obs.completeness}
                  </span>
                </figcaption>
                {obs.screenshotArtifactId && screenshotUrls[obs.screenshotArtifactId] ? (
                  <img src={screenshotUrls[obs.screenshotArtifactId]} alt={`capture ${obs.captureId}`} />
                ) : (
                  <div className="no-screenshot">{obs.screenshotArtifactId ? "loading screenshot…" : "no screenshot artifact"}</div>
                )}
              </figure>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
