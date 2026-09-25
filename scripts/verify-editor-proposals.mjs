#!/usr/bin/env node
/**
 * Live verification (audit fix: editor → real proposal API with grounded
 * references). POSTs a proposal with a real user instruction and a history
 * reference, polls to terminal, and prints the candidates exactly as the
 * editor would render them.
 *
 * Usage:
 *   node scripts/verify-editor-proposals.mjs \
 *     [--base http://localhost:8787] [--token dev-token] \
 *     [--project reference-app] [--capture <captureId>] [--entity catalog.productChooser]
 *
 * With no --capture, the first capture of the project's product-chooser
 * entity is used, mirroring the editor's "Use as reference" flow.
 */

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const BASE = arg("--base", "http://localhost:8787");
const TOKEN = arg("--token", "dev-token");
const PROJECT = arg("--project", "reference-app");
const ENTITY = arg("--entity", "catalog.productChooser");

const headers = { "content-type": "application/json", authorization: `Bearer ${TOKEN}` };
const url = (path) => `${BASE}${path}`;

async function main() {
  console.log(`verify-editor-proposals: base=${BASE} project=${PROJECT}`);

  // 1. Resolve project id (name → id), like the editor's same-origin proxy does.
  const projectsRes = await fetch(url("/v1/projects"), { headers });
  if (!projectsRes.ok) throw new Error(`GET /v1/projects → HTTP ${projectsRes.status}`);
  const projects = (await projectsRes.json()).projects ?? [];
  const project = projects.find((p) => p.name === PROJECT || p.id === PROJECT);
  if (!project) throw new Error(`project "${PROJECT}" not found`);
  console.log(`project: ${project.id}`);

  // 2. Pick a history capture (the editor stages these via "Use as reference").
  let captureId = arg("--capture");
  if (!captureId) {
    const histRes = await fetch(
      url(`/v1/projects/${project.id}/entities/${encodeURIComponent(ENTITY)}/history?limit=1`),
      { headers }
    );
    if (!histRes.ok) throw new Error(`GET history → HTTP ${histRes.status}`);
    const history = await histRes.json();
    const obs = (history.observations ?? [])[0];
    if (!obs) throw new Error("no history observations available for a reference");
    captureId = obs.captureId;
    console.log(
      `history reference staged: capture=${captureId} anchor=${obs.anchor} text=${JSON.stringify(obs.visibleText)}`
    );
  } else {
    console.log(`history reference staged: capture=${captureId} (explicit)`);
  }

  // 3. POST the proposal exactly like apps/reference-app Editor.generateFor().
  const request = {
    requestId: `req_verify_${Date.now().toString(36)}`,
    operation: "propose_change",
    target: { kind: "selection", entityId: ENTITY, runtimeInstanceId: "ri_verify" },
    references: [{ kind: "history", captureId }],
    instruction: "Make the product list denser, matching the captured layout",
    appBuildId: "verify-editor-proposals",
    requestedCandidateCount: 4,
  };
  const postRes = await fetch(url(`/v1/projects/${project.id}/proposals`), {
    method: "POST",
    headers,
    body: JSON.stringify({ request }),
  });
  if (postRes.status !== 202) throw new Error(`POST proposals → HTTP ${postRes.status}: ${await postRes.text()}`);
  const { proposalId, jobId } = await postRes.json();
  console.log(`proposal queued: proposalId=${proposalId} jobId=${jobId}`);

  // 4. Poll to terminal.
  let proposal;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    const pollRes = await fetch(url(`/v1/projects/${project.id}/proposals/${proposalId}`), { headers });
    if (!pollRes.ok) throw new Error(`GET proposal → HTTP ${pollRes.status}`);
    proposal = await pollRes.json();
    if (proposal.status === "ready" || proposal.status === "failed") break;
    process.stdout.write(`  poll: ${proposal.status}\n`);
  }
  if (!proposal || (proposal.status !== "ready" && proposal.status !== "failed")) {
    throw new Error("proposal polling timed out");
  }

  // 5. Report honestly.
  if (proposal.status === "failed") {
    console.log(`proposal FAILED: ${JSON.stringify(proposal.failure)}`);
    process.exitCode = 1;
    return;
  }

  console.log(`proposal READY with ${proposal.candidates.length} candidate(s):`);
  for (const c of proposal.candidates) {
    console.log(
      `  - ${c.presentation?.type ?? "?"} origin=${c.origin?.kind ?? "?"} ` +
        `digest=${c.validation?.specificationDigest ?? "?"} passed=${c.validation?.passed ?? "?"}\n` +
        `    properties=${JSON.stringify(c.presentation?.properties ?? {})}\n` +
        `    summary=${c.summary ?? ""}`
    );
  }
}

main().catch((error) => {
  console.error(`verify-editor-proposals FAILED: ${error.message}`);
  process.exitCode = 1;
});
