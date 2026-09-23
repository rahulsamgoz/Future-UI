import { useEffect, useState } from "react";
import type { ApiClient, CaptureSummaryDto, JobRecordDto, ProjectSummary } from "../api.js";

export function OverviewPage({ client, projectId }: { client: ApiClient; projectId: string }) {
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [jobs, setJobs] = useState<JobRecordDto[]>([]);
  const [captures, setCaptures] = useState<CaptureSummaryDto[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([client.listJobs(projectId), client.listCaptures(projectId), client.listProjects()])
      .then(([jobRes, captureRes, projectRes]) => {
        if (cancelled) return;
        setJobs(jobRes.jobs);
        setCaptures(captureRes.captures);
        setProject(projectRes.projects.find((p) => p.id === projectId) ?? null);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [client, projectId]);

  if (error) return <p className="error-banner">{error}</p>;

  // Coverage summary: captures per scenario plus declared scenarios with none.
  const capturedByScenario = new Map<string, number>();
  for (const c of captures) capturedByScenario.set(c.scenarioId, (capturedByScenario.get(c.scenarioId) ?? 0) + 1);
  const declared = project?.declaredScenarios ?? [];
  const gapScenarios = declared.filter((s) => !capturedByScenario.has(s));

  return (
    <div className="page">
      <section className="panel">
        <h2>Scan / job progress</h2>
        {jobs.length === 0 ? (
          <p className="empty">No jobs yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Kind</th>
                <th>Status</th>
                <th>Stage</th>
                <th>Attempt</th>
                <th>Created</th>
                <th>Last error</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.jobId}>
                  <td>{j.kind}</td>
                  <td>
                    <span className={`chip chip-status-${j.status}`}>{j.status}</span>
                  </td>
                  <td>{j.stage}</td>
                  <td>
                    {j.attempt}/{j.maxAttempts}
                  </td>
                  <td>{new Date(j.createdAt).toLocaleString()}</td>
                  <td className="muted">{j.lastError ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <h2>Coverage</h2>
        <p className="muted">{captures.length} captures ingested for this project.</p>
        <ul className="coverage">
          {[...capturedByScenario.entries()].map(([scenario, count]) => (
            <li key={scenario}>
              {scenario}: {count} capture{count === 1 ? "" : "s"}
            </li>
          ))}
          {gapScenarios.map((scenario) => (
            <li key={scenario} className="gap">
              {scenario}: <span className="chip chip-unavailable">coverage gap</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
