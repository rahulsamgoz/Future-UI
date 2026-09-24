import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CaptureManifest, FastifyInstance } from "./helpers.js";
import { buildTestApp, post, put } from "./helpers.js";

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const PROJECT = "proj_reference_app";
const AUTH = { authorization: "Bearer dev-token" };
const JSON_HEADERS = { "content-type": "application/json", ...AUTH };

describe("ui-intelligence api", () => {
  let app: FastifyInstance;
  let cleanup: () => void;
  let screenshotPng: Buffer;
  let screenshotDigest: string;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "ui-intel-api-"));
    cleanup = () => undefined;
    const built = await buildTestApp(dir);
    app = built.app;
    cleanup = built.cleanup;
    screenshotPng = Buffer.from("fake-png-bytes-for-testing");
    screenshotDigest = sha256(screenshotPng);
  });

  afterAll(async () => {
    await app?.close();
    cleanup?.();
  });

  it("rejects unauthenticated requests with 401 ErrorResponse and x-trace-id", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/projects" });
    expect(res.statusCode).toBe(401);
    expect(res.headers["x-trace-id"]).toBeTruthy();
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(body.traceId).toBe(res.headers["x-trace-id"]);
  });

  it("returns the seeded project and runtime manifest", async () => {
    const projects = await app.inject({ method: "GET", url: "/v1/projects", headers: AUTH });
    expect(projects.statusCode).toBe(200);
    const list = JSON.parse(projects.body);
    expect(list.projects.map((p: { id: string }) => p.id)).toContain(PROJECT);

    const manifest = await app.inject({ method: "GET", url: `/v1/projects/${PROJECT}/runtime-manifest`, headers: AUTH });
    expect(manifest.statusCode).toBe(200);
    const parsed: CaptureManifest = JSON.parse(manifest.body) as never; // shape check only
    expect(parsed.entities).toBeUndefined; // runtime manifest, not capture manifest
    const runtime = JSON.parse(manifest.body);
    expect(runtime.entities.map((e: { entityKey: string }) => e.entityKey)).toContain("catalog.productChooser");
    expect(runtime.rendererSchemas["grid@1"].columns).toEqual({ type: "number", min: 1, max: 4, default: 3 });
  });

  describe("artifact uploads", () => {
    it("rejects a digest mismatch with 422", async () => {
      const slot = await post(app, `/v1/projects/${PROJECT}/artifact-uploads`, {
        mediaType: "image/png",
        byteSize: screenshotPng.byteLength,
        digest: screenshotDigest,
      });
      expect(slot.statusCode).toBe(201);
      const { slotId, uploadUrl } = JSON.parse(slot.body);
      expect(uploadUrl).toBe(`/v1/artifacts/${slotId}`);

      const wrong = await put(app, `/v1/artifacts/${slotId}`, Buffer.from("not the bytes we declared"));
      expect(wrong.statusCode).toBe(422);
    });

    it("accepts correct bytes and returns an artifact id", async () => {
      const slot = await post(app, `/v1/projects/${PROJECT}/artifact-uploads`, {
        mediaType: "image/png",
        byteSize: screenshotPng.byteLength,
        digest: screenshotDigest,
      });
      const { slotId } = JSON.parse(slot.body);
      const done = await put(app, `/v1/artifacts/${slotId}`, screenshotPng);
      expect(done.statusCode).toBe(200);
      expect(JSON.parse(done.body).artifactId).toBeTruthy();

      // Slot cannot be reused.
      const replay = await put(app, `/v1/artifacts/${slotId}`, screenshotPng);
      expect(replay.statusCode).toBe(409);
    });
  });

  describe("capture ingest", () => {
    let artifactId: string;

    beforeAll(async () => {
      const slot = await post(app, `/v1/projects/${PROJECT}/artifact-uploads`, {
        mediaType: "image/png",
        byteSize: screenshotPng.byteLength,
        digest: screenshotDigest,
      });
      artifactId = JSON.parse((await put(app, `/v1/artifacts/${JSON.parse(slot.body).slotId}`, screenshotPng)).body).artifactId;
    });

    function manifest(overrides: Partial<CaptureManifest> = {}): CaptureManifest {
      return {
        captureId: "cap_test_1",
        spec: {
          protocolVersion: 1,
          projectId: PROJECT,
          commitSha: "deadbeef",
          buildArtifactDigest: "bd_1",
          scenario: {
            id: "catalog-desktop-signed-in",
            recipeDigest: "rd1",
            route: "/catalog",
            fixtureDigest: "fd1",
            role: "shopper",
            featureFlagsDigest: "ff1",
            viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
            locale: "en-US",
            timeZone: "UTC",
            colorScheme: "light",
            reducedMotion: false,
          },
          environment: {
            runnerImageDigest: "ri",
            browserRevision: "br",
            fontsDigest: "fo",
            adapterVersion: "av",
            captureToolVersion: "ct",
            redactionPolicyDigest: "rp",
          },
        },
        capturedAt: "2026-01-15T10:00:00.000Z",
        gitParents: [],
        observations: [
          {
            occurrenceId: "occ_1",
            captureId: "cap_test_1",
            explicitAnchor: "catalog.productChooser",
            visibleText: "product chooser with widgets and prices",
            bounds: [{ x: 0, y: 0, width: 600, height: 400 }],
            coordinateSpace: "document-css-pixels",
            sourceLinks: [],
            completeness: "complete-for-scenario",
            limitations: [],
          },
          {
            occurrenceId: "occ_2",
            captureId: "cap_test_1",
            explicitAnchor: "catalog.sortControl",
            visibleText: "sort control for products",
            bounds: [{ x: 0, y: 420, width: 200, height: 36 }],
            coordinateSpace: "document-css-pixels",
            sourceLinks: [],
            completeness: "complete-for-scenario",
            limitations: [],
          },
        ],
        artifacts: [{ artifactId, kind: "screenshot-png", digest: screenshotDigest, byteSize: screenshotPng.byteLength, mimeType: "image/png" }],
        buildOutcome: "succeeded",
        redactionMasks: [],
        scrollOffsets: { x: 0, y: 0 },
        idempotencyKey: "cap-001",
        ...overrides,
      };
    }

    it("requires the idempotency-key header", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/v1/projects/${PROJECT}/captures`,
        headers: JSON_HEADERS,
        payload: manifest(),
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects a manifest referencing a missing artifact", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/v1/projects/${PROJECT}/captures`,
        headers: { ...JSON_HEADERS, "idempotency-key": "cap-missing" },
        payload: manifest({ captureId: "cap_missing", idempotencyKey: "cap-missing", artifacts: [{ artifactId: "art_nope", kind: "screenshot-png", digest: screenshotDigest, byteSize: screenshotPng.byteLength, mimeType: "image/png" }] }),
      });
      expect(res.statusCode).toBe(422);
    });

    it("ingests capture + occurrences + job idempotently", async () => {
      const first = await app.inject({
        method: "POST",
        url: `/v1/projects/${PROJECT}/captures`,
        headers: { ...JSON_HEADERS, "idempotency-key": "cap-001" },
        payload: manifest(),
      });
      expect(first.statusCode).toBe(201);
      const { captureId } = JSON.parse(first.body);

      // Replay with same key + same manifest digest returns the existing capture.
      const replay = await app.inject({
        method: "POST",
        url: `/v1/projects/${PROJECT}/captures`,
        headers: { ...JSON_HEADERS, "idempotency-key": "cap-001" },
        payload: manifest(),
      });
      expect(replay.statusCode).toBe(200);
      expect(JSON.parse(replay.body).captureId).toBe(captureId);

      // Same key + different manifest => 409.
      const conflict = await app.inject({
        method: "POST",
        url: `/v1/projects/${PROJECT}/captures`,
        headers: { ...JSON_HEADERS, "idempotency-key": "cap-001" },
        payload: manifest({ observations: manifest().observations.slice(0, 1) }),
      });
      expect(conflict.statusCode).toBe(409);
      expect(JSON.parse(conflict.body).error.code).toBe("IDEMPOTENCY_MISMATCH");

      // Capture summary lists the ingest.
      const list = await app.inject({ method: "GET", url: `/v1/projects/${PROJECT}/captures`, headers: AUTH });
      expect(list.statusCode).toBe(200);
      expect(JSON.parse(list.body).captures.some((c: { captureId: string }) => c.captureId === captureId)).toBe(true);
    });
  });

  describe("resolve", () => {
    it("resolves text to a single entity", async () => {
      const res = await post(app, `/v1/projects/${PROJECT}/resolve`, {
        target: { kind: "text", text: "sort control" },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe("resolved");
      expect(body.entityKey).toBe("catalog.sortControl");
    });

    it("resolves a selection by entity id or key", async () => {
      const res = await post(app, `/v1/projects/${PROJECT}/resolve`, {
        target: { kind: "selection", entityId: "ent_catalog_product_chooser", runtimeInstanceId: "rt1" },
      });
      expect(JSON.parse(res.body).status).toBe("resolved");
    });

    it("answers screenshot grounding honestly as no_match", async () => {
      const res = await post(app, `/v1/projects/${PROJECT}/resolve`, {
        target: { kind: "screenshot", artifactId: "art_1" },
      });
      const body = JSON.parse(res.body);
      expect(body.status).toBe("no_match");
      expect(body.reason).toContain("screenshot grounding");
    });
  });

  describe("entity history", () => {
    it("returns paginated observations with coverage gaps", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/v1/projects/${PROJECT}/entities/catalog.productChooser/history?limit=10`,
        headers: AUTH,
      });
      expect(res.statusCode).toBe(200);
      const page = JSON.parse(res.body);
      expect(page.observations.length).toBeGreaterThan(0);
      expect(page.observations[0].evidenceLabel).toBe("captured_at_build");
      expect(page.observations[0].commitSha).toBe("deadbeef");
      const kinds = page.gaps.map((g: { kind: string }) => g.kind);
      expect(kinds).toContain("not_captured");
    });

    it("404s for unknown entities", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/v1/projects/${PROJECT}/entities/nope/history`,
        headers: AUTH,
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("proposals", () => {
    let proposalId: string;

    it("creates a queued proposal from a selection target", async () => {
      const res = await post(app, `/v1/projects/${PROJECT}/proposals`, {
        request: {
          requestId: "req_1",
          operation: "propose_change",
          target: { kind: "selection", entityId: "ent_catalog_product_chooser", runtimeInstanceId: "rt_1" },
          references: [],
          instruction: "make it a compact grid",
          appBuildId: "build_dev_1",
          requestedCandidateCount: 4,
        },
      });
      expect(res.statusCode).toBe(202);
      proposalId = JSON.parse(res.body).proposalId;
      expect(proposalId).toBeTruthy();
    });

    it("422s with candidates when the target is ambiguous", async () => {
      // Both catalog entities share the word "products" in their captured text.
      const res = await post(app, `/v1/projects/${PROJECT}/proposals`, {
        request: {
          requestId: "req_2",
          operation: "propose_change",
          target: { kind: "text", text: "product chooser and sort control for products" },
          references: [],
          instruction: "",
          appBuildId: "build_dev_1",
          requestedCandidateCount: 2,
        },
      });
      expect(res.statusCode).toBe(422);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe("AMBIGUOUS_TARGET");
      expect(body.error.details.candidates.length).toBeGreaterThanOrEqual(2);
    });

    it("processes the job inline to ready with validated candidates", async () => {
      const get1 = await app.inject({ method: "GET", url: `/v1/projects/${PROJECT}/proposals/${proposalId}`, headers: AUTH });
      expect(JSON.parse(get1.body).status).toBe("queued");

      const { processJobInline } = await import("../src/processor.js");
      const jobRow = JSON.parse(
        (
          await app.inject({ method: "GET", url: `/v1/projects/${PROJECT}/jobs?limit=50`, headers: AUTH })
        ).body
      ).jobs.find((j: { kind: string; payload: { proposalId?: string } }) => j.kind === "proposal" && j.payload.proposalId === proposalId);
      const status = await processJobInline(app.db, PROJECT, jobRow.jobId);
      expect(status).toBe("succeeded");

      const get2 = await app.inject({ method: "GET", url: `/v1/projects/${PROJECT}/proposals/${proposalId}`, headers: AUTH });
      const body = JSON.parse(get2.body);
      expect(body.status).toBe("ready");
      expect(body.candidates.length).toBeGreaterThanOrEqual(2);
      for (const candidate of body.candidates) {
        expect(candidate.validation.passed).toBe(true);
        expect(candidate.validation.specificationDigest).toMatch(/^[0-9a-f]{32}$/);
        expect(["generated", "historical_adaptation", "recorded_history"]).toContain(candidate.origin.kind);
      }
    });

    it("accepts a candidate and exports the specification", async () => {
      const get = await app.inject({ method: "GET", url: `/v1/projects/${PROJECT}/proposals/${proposalId}`, headers: AUTH });
      const { candidates } = JSON.parse(get.body);
      const candidateId = candidates[0].candidateId;

      const accept = await post(app, `/v1/projects/${PROJECT}/proposals/${proposalId}/accept`, { candidateId });
      expect(accept.statusCode).toBe(200);
      expect(JSON.parse(accept.body).accepted).toBe(true);

      const exp = await app.inject({ method: "POST", url: `/v1/projects/${PROJECT}/proposals/${proposalId}/export`, headers: AUTH });
      expect(exp.statusCode).toBe(200);
      const exported = JSON.parse(exp.body);
      expect(exported.format).toBe("ui-intelligence/specification@1");
      const spec = JSON.parse(exported.contents);
      expect(spec.candidateId).toBe(candidateId);
      expect(spec.requiredRendererVersions).toBeTruthy();
      expect(spec.provenance.validationDigest).toBeTruthy();
    });
  });

  describe("jobs: lease semantics", () => {
    let jobId: string;

    beforeAll(async () => {
      const plan = await post(app, `/v1/projects/${PROJECT}/history-plans`, {
        input: {
          repository: "https://github.com/example/reference-app",
          branches: ["main"],
          windowStart: "2026-01-01T00:00:00.000Z",
          windowEnd: "2026-02-01T00:00:00.000Z",
          scenarioIds: ["catalog-desktop-signed-in"],
          maxBuilds: 5,
          renderBudgetMs: 60000,
          timezone: "UTC",
        },
      });
      expect(plan.statusCode).toBe(201);
      const planBody = JSON.parse(plan.body);
      expect(planBody.selectedCommits.length).toBeGreaterThan(0); // synced/ingested commit in window

      const run = await app.inject({
        method: "POST",
        url: `/v1/projects/${PROJECT}/history-plans/${planBody.planId}/runs`,
        headers: AUTH,
        payload: {},
      });
      expect(run.statusCode).toBe(202);
      jobId = JSON.parse(run.body).jobId;
    });

    it("claims a queued job and hands out a lease", async () => {
      const claim = await post(app, `/v1/projects/${PROJECT}/jobs/${jobId}/claim`, { workerId: "w1" });
      expect(claim.statusCode).toBe(200);
      const body = JSON.parse(claim.body);
      expect(body.leaseToken).toBeTruthy();
      expect(body.leaseExpiresAt > new Date().toISOString()).toBe(true);

      // Second claim while the lease is active conflicts.
      const conflict = await post(app, `/v1/projects/${PROJECT}/jobs/${jobId}/claim`, { workerId: "w2" });
      expect(conflict.statusCode).toBe(409);
    });

    it("rejects heartbeats and completes with a wrong token (409)", async () => {
      const badHeartbeat = await post(app, `/v1/projects/${PROJECT}/jobs/${jobId}/heartbeat`, { leaseToken: "lease_wrong" });
      expect(badHeartbeat.statusCode).toBe(409);
      expect(JSON.parse(badHeartbeat.body).error.code).toBe("JOB_LEASE_LOST");

      const badComplete = await post(app, `/v1/projects/${PROJECT}/jobs/${jobId}/complete`, {
        leaseToken: "lease_wrong",
      });
      expect(badComplete.statusCode).toBe(409);
    });

    it("extends the lease with the right token", async () => {
      const job = JSON.parse((await app.inject({ method: "GET", url: `/v1/projects/${PROJECT}/jobs/${jobId}`, headers: AUTH })).body);
      const hb = await post(app, `/v1/projects/${PROJECT}/jobs/${jobId}/heartbeat`, { leaseToken: job.leaseToken });
      expect(hb.statusCode).toBe(200);
      expect(JSON.parse(hb.body).leaseExpiresAt >= job.leaseExpiresAt).toBe(true);
    });

    it("completes idempotently and rejects late claims", async () => {
      const job = JSON.parse((await app.inject({ method: "GET", url: `/v1/projects/${PROJECT}/jobs/${jobId}`, headers: AUTH })).body);
      const done = await post(app, `/v1/projects/${PROJECT}/jobs/${jobId}/complete`, {
        leaseToken: job.leaseToken,
        result: { ok: true },
      });
      expect(done.statusCode).toBe(200);
      expect(JSON.parse(done.body).status).toBe("succeeded");

      // Second complete with the same lease: 200 no-op.
      const replay = await post(app, `/v1/projects/${PROJECT}/jobs/${jobId}/complete`, {
        leaseToken: job.leaseToken,
        result: { ok: true },
      });
      expect(replay.statusCode).toBe(200);

      // Claiming a terminal job conflicts.
      const lateClaim = await post(app, `/v1/projects/${PROJECT}/jobs/${jobId}/claim`, { workerId: "w3" });
      expect(lateClaim.statusCode).toBe(409);
    });

    it("allows reclaiming a job whose lease expired", async () => {
      const plan = await post(app, `/v1/projects/${PROJECT}/history-plans`, {
        input: {
          repository: "https://github.com/example/reference-app",
          branches: ["main"],
          windowStart: "2026-03-01T00:00:00.000Z",
          windowEnd: "2026-04-01T00:00:00.000Z",
          scenarioIds: [],
          maxBuilds: 2,
          renderBudgetMs: 1000,
          timezone: "UTC",
        },
      });
      const run = await app.inject({
        method: "POST",
        url: `/v1/projects/${PROJECT}/history-plans/${JSON.parse(plan.body).planId}/runs`,
        headers: AUTH,
        payload: {},
      });
      const secondJobId = JSON.parse(run.body).jobId;

      const claim1 = JSON.parse((await post(app, `/v1/projects/${PROJECT}/jobs/${secondJobId}/claim`, { workerId: "w1" })).body);
      // Simulate worker death: expire the lease.
      app.db.prepare("UPDATE jobs SET lease_expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", secondJobId);
      const claim2 = await post(app, `/v1/projects/${PROJECT}/jobs/${secondJobId}/claim`, { workerId: "w2" });
      expect(claim2.statusCode).toBe(200);
      expect(JSON.parse(claim2.body).leaseToken).not.toBe(claim1.leaseToken);
      const job = JSON.parse((await app.inject({ method: "GET", url: `/v1/projects/${PROJECT}/jobs/${secondJobId}`, headers: AUTH })).body);
      expect(job.attempt).toBe(2);
    });
  });

  describe("project isolation", () => {
    it("returns 404 when another project reads a foreign artifact", async () => {
      // Create a second project directly in the DB.
      app.db
        .prepare("INSERT OR IGNORE INTO projects (id, tenant_id, name, repository, policy_revision, created_at) VALUES (?, 'local', 'other', 'repo', 1, ?)")
        .run("proj_other", new Date().toISOString());

      const slot = JSON.parse(
        (
          await post(app, `/v1/projects/${PROJECT}/artifact-uploads`, {
            mediaType: "image/png",
            byteSize: screenshotPng.byteLength,
            digest: screenshotDigest,
          })
        ).body
      );
      const artifact = JSON.parse((await put(app, `/v1/artifacts/${slot.slotId}`, screenshotPng)).body);

      const own = await app.inject({
        method: "GET",
        url: `/v1/artifacts/${artifact.artifactId}/raw?projectId=${PROJECT}`,
        headers: AUTH,
      });
      expect(own.statusCode).toBe(200);

      const foreign = await app.inject({
        method: "GET",
        url: `/v1/artifacts/${artifact.artifactId}/raw?projectId=proj_other`,
        headers: AUTH,
      });
      expect(foreign.statusCode).toBe(404);
    });
  });
});
