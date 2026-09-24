import { useEffect, useState } from "react";
import type { ApiClient, ProposalDetailDto, ProposalSummaryDto } from "../api.js";

export function ProposalsInspector({ client, projectId }: { client: ApiClient; projectId: string }) {
  const [proposals, setProposals] = useState<ProposalSummaryDto[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProposalDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    client
      .listProposals(projectId)
      .then((res) => {
        setProposals(res.proposals);
        setSelectedId((current) => current ?? res.proposals[0]?.proposalId ?? null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [client, projectId]);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    client
      .getProposal(projectId, selectedId)
      .then((d) => !cancelled && setDetail(d))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [client, projectId, selectedId]);

  if (error) return <p className="error-banner">{error}</p>;

  return (
    <div className="page two-column">
      <section className="panel">
        <h2>Proposals</h2>
        {proposals.length === 0 ? (
          <p className="empty">No proposals yet.</p>
        ) : (
          <ul className="proposal-list">
            {proposals.map((p) => (
              <li key={p.proposalId}>
                <button className={`proposal-link${selectedId === p.proposalId ? " active" : ""}`} onClick={() => setSelectedId(p.proposalId)}>
                  {p.proposalId.slice(0, 18)}… · <span className={`chip chip-status-${p.status}`}>{p.status}</span> ·{" "}
                  {p.candidateCount} candidate{p.candidateCount === 1 ? "" : "s"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2>Candidates</h2>
        {!detail ? (
          <p className="empty">Select a proposal.</p>
        ) : detail.failure ? (
          <p className="error-banner">
            {detail.failure.code}: {detail.failure.message}
          </p>
        ) : detail.candidates.length === 0 ? (
          <p className="empty">No candidates yet (status: {detail.status}).</p>
        ) : (
          <ul className="candidate-list">
            {detail.candidates.map((c) => (
              <li key={c.candidateId} className="candidate">
                <header>
                  <strong>{c.presentation.type}</strong>{" "}
                  <span className={`chip chip-origin-${c.origin.kind}`}>{c.origin.kind}</span>{" "}
                  {detail.acceptedCandidateId === c.candidateId ? <span className="chip chip-accepted">accepted</span> : null}
                </header>
                <p className="muted">{c.summary}</p>
                <p>
                  Properties: <code>{JSON.stringify(c.presentation.properties)}</code>
                </p>
                <p className="muted">
                  Binding: {c.presentation.dataBinding} · Validation:{" "}
                  <span className={c.validation.passed ? "ok" : "failed"}>{c.validation.passed ? "passed" : "failed"}</span> · digest{" "}
                  <code>{c.validation.specificationDigest}</code>
                </p>
                {c.validation.errors.length > 0 ? (
                  <ul className="errors">
                    {c.validation.errors.map((e, i) => (
                      <li key={i}>
                        {e.code}: {e.message}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
