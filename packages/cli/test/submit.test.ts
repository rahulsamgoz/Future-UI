/**
 * Unit tests for `history submit` (R2 stream D): argv parsing and request
 * shape against a fetch stub. No manager server is started.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgv } from "../src/args.js";
import { main } from "../src/cli.js";

type RecordedCall = { url: string; method: string; headers: Record<string, string>; body: unknown };

function fakeResponse(status: number, body: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("history submit argv parsing", () => {
  it("parses command positionals and flags", () => {
    const parsed = parseArgv([
      "history",
      "submit",
      "--repo",
      "https://github.com/example/app.git",
      "--commit",
      "abc123",
      "--scenarios",
      "catalog-default-desktop,catalog-empty-desktop",
      "--manager",
      "http://localhost:8900",
    ]);
    expect(parsed.command).toEqual(["history", "submit"]);
    expect(parsed.flags).toEqual({
      repo: "https://github.com/example/app.git",
      commit: "abc123",
      scenarios: "catalog-default-desktop,catalog-empty-desktop",
      manager: "http://localhost:8900",
    });
  });
});

describe("history submit request shape", () => {
  it("POSTs the run to the manager and polls to completion", async () => {
    const calls: RecordedCall[] = [];
    const runPayload = {
      projectId: "proj_reference_app",
      repoUrl: "https://github.com/example/app.git",
      commitSha: "abc123",
      scenarios: ["catalog-default-desktop", "catalog-empty-desktop"],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET") as string;
        const headers = (init?.headers ?? {}) as Record<string, string>;
        calls.push({ url, method, headers, body: init?.body ? JSON.parse(String(init.body)) : null });
        if (method === "POST" && url.endsWith("/v1/runs")) {
          return fakeResponse(202, { runId: "run_test_1" });
        }
        if (method === "GET" && url.endsWith("/v1/runs/run_test_1")) {
          if (calls.filter((c) => c.method === "GET").length === 1) {
            return fakeResponse(200, { runId: "run_test_1", status: "running", attempt: 1, results: null });
          }
          return fakeResponse(200, {
            runId: "run_test_1",
            status: "succeeded",
            attempt: 1,
            error: null,
            results: [
              { scenarioId: "catalog-default-desktop", status: "captured", captureId: "capture_1" },
              { scenarioId: "catalog-empty-desktop", status: "captured", captureId: "capture_2" },
            ],
          });
        }
        return fakeResponse(404, { error: { code: "NOT_FOUND", message: `unexpected ${method} ${url}` } });
      })
    );

    const exit = await main([
      "history",
      "submit",
      "--repo",
      runPayload.repoUrl,
      "--commit",
      runPayload.commitSha,
      "--scenarios",
      "catalog-default-desktop,catalog-empty-desktop",
      "--manager",
      "http://manager.test",
      "--project",
      "proj_reference_app",
    ]);
    expect(exit).toBe(0);

    // Request shape: POST /v1/runs with bearer auth and the full run payload.
    const submit = calls[0];
    expect(submit.method).toBe("POST");
    expect(submit.url).toBe("http://manager.test/v1/runs");
    expect(submit.headers.authorization).toBe("Bearer dev-token");
    expect(submit.body).toEqual(runPayload);

    // Polling: GET /v1/runs/:id with bearer auth until terminal.
    const polls = calls.filter((c) => c.method === "GET");
    expect(polls.length).toBeGreaterThanOrEqual(2);
    for (const poll of polls) {
      expect(poll.url).toBe("http://manager.test/v1/runs/run_test_1");
      expect(poll.headers.authorization).toBe("Bearer dev-token");
    }
  });

  it("fails when scenarios are missing", async () => {
    const exit = await main(["history", "submit", "--repo", "https://example.test/a", "--commit", "abc"]);
    expect(exit).toBe(1);
  });

  it("reports a non-202 submission failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse(401, { error: { code: "UNAUTHORIZED", message: "missing or invalid credentials" } }))
    );
    const exit = await main([
      "history",
      "submit",
      "--repo",
      "https://example.test/a",
      "--commit",
      "abc",
      "--scenarios",
      "s1",
      "--manager",
      "http://manager.test",
    ]);
    expect(exit).toBe(1);
  });
});
