/**
 * Audit finding 4: page-scope proposal generation through the real API —
 * the POST /v1/projects/:p/proposals route accepts page targets, and the
 * processor validates the provider's layout candidates against the page
 * contract with runtime-core's ProposalValidator.validatePageLayout.
 */
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ProviderInput } from "@ui-intelligence/agent";
import type { PageContract } from "@ui-intelligence/protocol";
import { processProposal } from "../src/processor.js";
import { buildTestApp, post } from "./helpers.js";

const PROJECT = "proj_reference_app";

const pageContract: PageContract = {
  pageKey: "catalog",
  contractVersion: 1,
  slots: [
    { slotId: "chooser", entityKey: "catalog.productChooser", required: true, locked: false, repeatable: false, compatibleRenderers: ["carousel@1", "grid@1", "table@1"] },
    { slotId: "sort", entityKey: "catalog.sortControl", required: true, locked: false, repeatable: false, compatibleRenderers: ["sort.select@1", "sort.segments@1"] },
    { slotId: "related", entityKey: "catalog.relatedProducts", required: false, locked: false, repeatable: false, compatibleRenderers: ["carousel@1", "grid@1"] },
  ],
  allowedLayouts: ["stack@1", "grid@1", "split@1"],
  maxDepth: 4,
  maxNodes: 16,
};

function pageRequest() {
  return {
    requestId: `req_page_${Math.random().toString(36).slice(2, 8)}`,
    operation: "propose_change" as const,
    target: { kind: "page" as const, pageKey: "catalog", pageContract },
    references: [],
    instruction: "split the catalog page",
    appBuildId: "build_dev",
    requestedCandidateCount: 3,
  };
}

describe("page-scope proposal generation (audit finding 4)", () => {
  const dir = mkdtempSync(join("/tmp", "ui-intel-page-"));
  const appRef = buildTestApp(dir);
  let cleanup: () => void;

  afterAll(() => {
    cleanup?.();
  });

  it("accepts a page target, generates LAYOUT candidates, and validates them against the page contract", async () => {
    const { app, cleanup: done } = await appRef;
    cleanup = done;

    const res = await post(app, `/v1/projects/${PROJECT}/proposals`, { request: pageRequest() });
    expect(res.statusCode).toBe(202);
    const { proposalId } = JSON.parse(res.body) as { proposalId: string };

    // Default (deterministic) provider: proposes one layout per allowed type
    // with schema-derived properties.
    await processProposal(app.db, PROJECT, proposalId, { store: app.store });
    const poll = await app.inject({ method: "GET", url: `/v1/projects/${PROJECT}/proposals/${proposalId}`, headers: { authorization: "Bearer dev-token" } });
    const body = JSON.parse(poll.body) as { status: string; candidates: Array<{ presentation: { kind: string; type: string; children: Array<{ kind: string; slotId: string }> }; validation: { passed: boolean; targetReadSet: { policyVersion: number } } }> };
    expect(body.status).toBe("ready");
    expect(body.candidates.length).toBeGreaterThanOrEqual(2);

    for (const candidate of body.candidates) {
      expect(candidate.presentation.kind).toBe("layout");
      expect(candidate.validation.passed).toBe(true);
      // Every declared slot survives as a region — required slots preserved.
      const slotIds = candidate.presentation.children.filter((c) => c.kind === "region").map((c) => c.slotId);
      expect(slotIds).toEqual(["chooser", "sort", "related"]);
    }
    const types = body.candidates.map((c) => c.presentation.type);
    expect(types).toEqual(expect.arrayContaining(["stack@1", "grid@1", "split@1"]));
  });

  it("rejects a provider layout type that is outside the page contract's allowedLayouts", async () => {
    const { app, cleanup: done } = await appRef;
    cleanup = done;

    const res = await post(app, `/v1/projects/${PROJECT}/proposals`, { request: pageRequest() });
    const { proposalId } = JSON.parse(res.body) as { proposalId: string };

    const seen: ProviderInput[] = [];
    await processProposal(app.db, PROJECT, proposalId, {
      provider: {
        id: "rogue",
        async generate(input: ProviderInput) {
          seen.push(input);
          return {
            candidates: [{ type: "carousel@1", properties: { perView: 2 }, originKind: "generated", summary: "not a layout" }],
          };
        },
      },
    });

    // The provider is constrained to the allowed layouts in its prompt.
    expect(seen[0]!.targetContract.allowedRepresentations).toEqual(["stack@1", "grid@1", "split@1"]);
    const row = app.db.prepare("SELECT status, failure_json FROM proposals WHERE id = ?").get(proposalId) as { status: string; failure_json: string };
    expect(row.status).toBe("failed");
    expect(JSON.parse(row.failure_json).message).toContain('layout type "carousel@1" is not allowed by page "catalog"');
  });

  it("rejects a page target whose pageKey does not match the contract", async () => {
    const { app, cleanup: done } = await appRef;
    cleanup = done;
    const request = pageRequest();
    (request.target as { pageKey: string }).pageKey = "account";
    const res = await post(app, `/v1/projects/${PROJECT}/proposals`, { request });
    expect(res.statusCode).toBe(422);
  });
});
