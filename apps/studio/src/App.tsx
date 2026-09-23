import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ApiClient, type ProjectSummary } from "./api.js";
import { OverviewPage } from "./pages/Overview.js";
import { HistoryConsole } from "./pages/HistoryConsole.js";
import { ProposalsInspector } from "./pages/ProposalsInspector.js";

export type PageKey = "overview" | "history" | "proposals";

const PAGES: Array<{ key: PageKey; label: string }> = [
  { key: "overview", label: "Overview" },
  { key: "history", label: "History console" },
  { key: "proposals", label: "Proposals" },
];

export function App({ client = new ApiClient() }: { client?: ApiClient }) {
  const [page, setPage] = useState<PageKey>("overview");
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    client
      .listProjects()
      .then((res) => {
        setProjects(res.projects);
        if (res.projects.length > 0) setProjectId((current) => current ?? res.projects[0]!.id);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [client]);

  return (
    <div className="app">
      <header className="topbar">
        <h1>UI Intelligence — Studio</h1>
        <nav className="tabs">
          {PAGES.map((p) => (
            <button key={p.key} className={`tab${page === p.key ? " active" : ""}`} onClick={() => setPage(p.key)}>
              {p.label}
            </button>
          ))}
        </nav>
        <label className="project-picker">
          Project:{" "}
          <select value={projectId ?? ""} onChange={(e) => setProjectId(e.target.value)}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </header>
      {error ? <div className="error-banner">{error}</div> : null}
      <main className="content">
        {!projectId ? (
          <p className="empty">Loading projects…</p>
        ) : page === "overview" ? (
          <OverviewPage client={client} projectId={projectId} />
        ) : page === "history" ? (
          <HistoryConsole client={client} projectId={projectId} />
        ) : (
          <ProposalsInspector client={client} projectId={projectId} />
        )}
      </main>
    </div>
  );
}

export function mountStudio(element: Element): void {
  createRoot(element).render(<App />);
}
