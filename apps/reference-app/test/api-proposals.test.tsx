import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UiRuntimeProvider } from "@ui-intelligence/react";
import { ServicesContext, type AppServices } from "../src/Services.js";
import { PreferenceService } from "../src/app/PreferenceService.js";
import { createAppKernel } from "../src/kernel.js";
import { LocalGenerator } from "../src/editor/LocalGenerator.js";
import { createCart } from "../src/data/catalog.js";
import { allEntityContracts } from "../src/contracts.js";
import { App } from "../src/App.js";

/**
 * Editor ↔ API proposal integration (audit fix): the editor must call the real
 * POST /v1/projects/:p/proposals path with the user instruction + staged
 * references, poll to terminal, and render the API candidates with their
 * validation digests. When the API is unreachable it falls back to the local
 * generator with a visible "offline · local" badge — never a silent swap.
 */

const API_CANDIDATE = {
  candidateId: "cand_api_1",
  presentation: {
    type: "grid@1",
    properties: { columns: 3, density: "compact" },
    dataBinding: "catalog.products@1",
    actions: ["product.open@1", "cart.add@1"],
  },
  origin: { kind: "generated", referenceIds: [] },
  validation: {
    schemaVersion: 1,
    validatorVersion: "spec@1",
    policyRevision: 1,
    targetReadSet: {
      appBuildId: "build_test_1",
      contractDigest: "contract_digest_current",
      policyVersion: 1,
      preferenceRevision: 0,
      entityVersions: {},
    },
    checkedInvariants: [],
    unsupportedChecks: [],
    passed: true,
    errors: [],
    specificationDigest: "sha256:api-validation-digest-1",
  },
  summary: "grid@1 candidate (generated)",
};

type Call = { method: string; url: string; body?: unknown };

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function buildServices(): AppServices {
  const kernel = createAppKernel();
  for (const contract of allEntityContracts) {
    kernel.registerEntity(contract, {
      data: {
        contract: { id: "placeholder", version: 1, schemaDigest: "sha256:placeholder" },
        getSnapshot: () => ({ revision: "none", status: "loading" as const, value: null }),
        subscribe: () => () => {},
      },
      actions: {},
    });
  }
  const preferences = new PreferenceService();
  const generator = new LocalGenerator(kernel);
  return { kernel, preferences, generator, cart: createCart(), apiBaseUrl: null };
}

function editorJourney() {
  const services = buildServices();
  const withServices = (ui: React.ReactNode) => (
    <ServicesContext.Provider value={services}>
      <UiRuntimeProvider kernel={services.kernel}>{ui}</UiRuntimeProvider>
    </ServicesContext.Provider>
  );
  return { services, withServices };
}

beforeEach(() => {
  cleanup();
  window.location.hash = "#/";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("editor proposal API integration", () => {
  it("POSTs the instruction + staged history reference, polls, and renders API candidates with API digests", async () => {
    const { withServices } = editorJourney();
    const calls: Call[] = [];
    let pollCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ method, url, body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (url.includes("/.ui-intelligence/manifest.json")) {
        return jsonResponse(200, { buildId: "build_test_1" });
      }
      if (url.includes("/v1/projects/reference-app/proposals") && method === "POST") {
        return jsonResponse(202, { proposalId: "prop_editor_1", jobId: "job_1" });
      }
      if (url.includes("/v1/projects/reference-app/proposals/prop_editor_1")) {
        pollCount += 1;
        if (pollCount === 1) return jsonResponse(200, { proposalId: "prop_editor_1", status: "generating", candidates: [] });
        return jsonResponse(200, {
          proposalId: "prop_editor_1",
          status: "ready",
          candidates: [API_CANDIDATE],
          failure: null,
          acceptedCandidateId: null,
        });
      }
      if (url.includes("/history")) {
        return jsonResponse(200, {
          observations: [
            {
              occurrenceId: "occ_1",
              captureId: "cap_h1",
              commitSha: "abc1234567890",
              capturedAt: "2026-01-01T00:00:00.000Z",
              scenarioId: "catalog-desktop",
              evidenceLabel: "captured_at_build",
              anchor: "catalog.productChooser.grid",
              visibleText: "Grid of 24 products",
              bounds: [{ x: 0, y: 0, width: 100, height: 40 }],
              completeness: "complete-for-scenario",
              screenshotArtifactId: null,
              summary: "catalog.productChooser.grid: Grid of 24 products",
            },
          ],
          gaps: [],
          nextCursor: null,
        });
      }
      return jsonResponse(404, { error: "unexpected url" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    render(withServices(<App />));
    await user.click(await screen.findByTestId("editor-open", undefined, { timeout: 4000 }));
    await user.click(screen.getByTestId("select-mode"));
    await user.click((await screen.findAllByText("Aurora Lamp"))[0]);
    await waitFor(() => expect(screen.getByTestId("generate")).toBeTruthy());

    // Stage a history reference from the History tab.
    await user.click(screen.getByRole("tab", { name: "history" }));
    await user.click(screen.getByTestId("load-history"));
    await waitFor(() => expect(screen.getAllByTestId("use-as-reference").length).toBeGreaterThan(0));
    await user.click(screen.getAllByTestId("use-as-reference")[0]);

    // Back to candidates: the staged reference shows as a chip.
    await user.click(screen.getByRole("tab", { name: "candidates" }));
    await waitFor(() => expect(screen.getAllByTestId("reference-chip").length).toBe(1));

    await user.type(screen.getByTestId("instruction-input"), "make it a compact grid");
    await user.click(screen.getByTestId("generate"));

    await waitFor(() => expect(screen.getAllByTestId("candidate").length).toBe(1), { timeout: 8000 });

    // The POST carried the real instruction, the selection target, and the staged reference.
    const post = calls.find((c) => c.method === "POST" && String(c.url).includes("/v1/projects/reference-app/proposals"));
    expect(post).toBeTruthy();
    const request = (post!.body as { request: Record<string, unknown> }).request;
    expect(request.instruction).toBe("make it a compact grid");
    expect(request.target).toMatchObject({ kind: "selection", entityId: "catalog.productChooser" });
    expect(request.appBuildId).toBe("build_test_1");
    expect(request.references).toEqual([{ kind: "history", captureId: "cap_h1" }]);

    // API candidate rendered with the API validation digest and NO offline badge.
    const candidate = screen.getAllByTestId("candidate")[0]!;
    expect(candidate.textContent).toContain("grid@1");
    expect(candidate.querySelector(".digest")?.getAttribute("title")).toBe("sha256:api-validation-digest-1");
    expect(screen.queryByTestId("offline-badge")).toBeNull();
    expect(screen.queryByTestId("offline-badge")).toBeNull();
  });

  it("falls back to the local generator with a visible offline badge when the API is unreachable", async () => {
    const { withServices } = editorJourney();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed: network unreachable");
      })
    );

    const user = userEvent.setup();
    render(withServices(<App />));
    await user.click(await screen.findByTestId("editor-open", undefined, { timeout: 4000 }));
    await user.click(screen.getByTestId("select-mode"));
    await user.click((await screen.findAllByText("Aurora Lamp"))[0]);
    await waitFor(() => expect(screen.getByTestId("generate")).toBeTruthy());

    await user.type(screen.getByTestId("instruction-input"), "compact please");
    await user.click(screen.getByTestId("generate"));

    // Local candidates render, clearly labeled offline · local.
    await waitFor(() => expect(screen.getAllByTestId("offline-badge").length).toBeGreaterThan(0));
    const candidate = screen.getAllByTestId("candidate")[0]!;
    expect(candidate.textContent).toContain("offline · local");
    expect(screen.getByTestId("editor-status").textContent).toContain("API proposals unavailable");
  });

  it("renders a degraded-note warning when the API proposal carries a degraded note (closure-2 GAP B)", async () => {
    const { withServices } = editorJourney();
    let pollCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.includes("/.ui-intelligence/manifest.json")) {
        return jsonResponse(200, { buildId: "build_test_1" });
      }
      if (url.includes("/v1/projects/reference-app/proposals") && method === "POST") {
        return jsonResponse(202, { proposalId: "prop_degraded_1", jobId: "job_d1" });
      }
      if (url.includes("/v1/projects/reference-app/proposals/prop_degraded_1")) {
        pollCount += 1;
        if (pollCount === 1) return jsonResponse(200, { proposalId: "prop_degraded_1", status: "generating", candidates: [] });
        return jsonResponse(200, {
          proposalId: "prop_degraded_1",
          status: "ready",
          candidates: [API_CANDIDATE],
          failure: null,
          degraded: "1 image reference(s) ignored: provider not vision-capable",
          acceptedCandidateId: null,
        });
      }
      return jsonResponse(404, { error: "unexpected url" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    render(withServices(<App />));
    await user.click(await screen.findByTestId("editor-open", undefined, { timeout: 4000 }));
    await user.click(screen.getByTestId("select-mode"));
    await user.click((await screen.findAllByText("Aurora Lamp"))[0]);
    await waitFor(() => expect(screen.getByTestId("generate")).toBeTruthy());

    await user.type(screen.getByTestId("instruction-input"), "use image");
    await user.click(screen.getByTestId("generate"));

    await waitFor(() => expect(screen.getAllByTestId("candidate").length).toBe(1), { timeout: 8000 });
    // The degraded note renders alongside the candidates.
    expect(screen.getByTestId("degraded-note").textContent).toContain("image reference(s) ignored");
  });
});
