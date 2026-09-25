/**
 * Runner-manager client for `history submit` (R2 stream D, plan part D):
 * POSTs a capture run to the manager and polls it to completion.
 */

export type ManagerResult = {
  status: number;
  ok: boolean;
  body: unknown;
};

export type RunScenarioResult = {
  scenarioId: string;
  status: "captured" | "failed";
  captureId?: string;
  error?: string;
};

export type RunView = {
  runId: string;
  status: "queued" | "running" | "succeeded" | "failed";
  projectId: string;
  repoUrl: string;
  commitSha: string;
  scenarios: string[];
  attempt: number;
  error: string | null;
  results: RunScenarioResult[] | null;
  createdAt: string;
  updatedAt: string;
};

export type SubmitRunInput = {
  managerUrl: string;
  token: string;
  projectId: string;
  repoUrl: string;
  commitSha: string;
  scenarios: string[];
};

function managerErrorMessage(result: ManagerResult): string {
  const body = result.body as { error?: { message?: string } | string; message?: string } | null;
  if (typeof body?.error === "string") return body.error;
  if (body?.error && typeof body.error === "object" && typeof body.error.message === "string") return body.error.message;
  return body?.message ?? JSON.stringify(body ?? {});
}

export type SubmitRunOptions = {
  /** Fetch implementation (injectable for tests). */
  fetchImpl?: typeof fetch;
};

export async function managerRequest(
  managerUrl: string,
  token: string,
  method: string,
  apiPath: string,
  body?: unknown,
  options: SubmitRunOptions = {}
): Promise<ManagerResult> {
  const base = managerUrl.replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${base}${apiPath}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    throw new Error(`runner-manager request failed (${method} ${apiPath}): ${(error as Error).message}`);
  }
  const text = await response.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: response.status, ok: response.ok, body: parsed };
}

/** POST /v1/runs → 202 {runId}. */
export async function submitRun(input: SubmitRunInput, options: SubmitRunOptions = {}): Promise<string> {
  const result = await managerRequest(
    input.managerUrl,
    input.token,
    "POST",
    "/v1/runs",
    {
      projectId: input.projectId,
      repoUrl: input.repoUrl,
      commitSha: input.commitSha,
      scenarios: input.scenarios,
    },
    options
  );
  if (result.status !== 202) {
    throw new Error(`run submission failed (${result.status}): ${managerErrorMessage(result)}`);
  }
  return (result.body as { runId: string }).runId;
}

export type WaitForRunOptions = SubmitRunOptions & {
  pollMs?: number;
  timeoutMs?: number;
  onPoll?: (run: RunView) => void;
};

/** Poll GET /v1/runs/:id until a terminal status. */
export async function waitForRun(managerUrl: string, token: string, runId: string, options: WaitForRunOptions = {}): Promise<RunView> {
  const pollMs = options.pollMs ?? 2000;
  const deadline = Date.now() + (options.timeoutMs ?? 600_000);
  let last: RunView | null = null;
  for (;;) {
    const result = await managerRequest(managerUrl, token, "GET", `/v1/runs/${runId}`, undefined, options);
    if (!result.ok) {
      throw new Error(`run polling failed (${result.status}): ${managerErrorMessage(result)}`);
    }
    last = result.body as RunView;
    options.onPoll?.(last);
    if (last.status === "succeeded" || last.status === "failed") return last;
    if (Date.now() >= deadline) {
      throw new Error(`run ${runId} did not reach a terminal state (last status: ${last.status})`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
