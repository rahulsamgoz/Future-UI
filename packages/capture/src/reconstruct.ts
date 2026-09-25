/**
 * Historical reconstruction (architecture section 10, planning/execution
 * steps 4-6): re-materialize a historical commit as a runnable app, capture
 * its declared scenarios, and publish the captures durably to the history API
 * with verified provenance before a scenario counts as captured.
 *
 * The executor lives in packages/capture (not an app) so the index-worker
 * scan path, the runner-manager executor, and the coverage script can all use
 * the same publication path without cross-app imports.
 *
 * Provenance binding: manifest.spec.commitSha is the reconstructed commit and
 * buildArtifactDigest is the digest of the served tree, so a capture can never
 * be attributed to a commit that was not actually reconstructed.
 */
import { execFile, execFileSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { digestOf } from "@ui-intelligence/protocol";
import type { CaptureEnvironment, CaptureManifest } from "@ui-intelligence/protocol";
import { hashBytes, ScenarioRunner } from "./scenario-runner.js";
import { CaptureUploader } from "./uploader.js";
import type { UploadApi } from "./uploader.js";
import { standardScenarios } from "./scenarios.js";
import type { RedactionPolicy, ScenarioRecipe } from "./types.js";

export type { UploadApi } from "./uploader.js";

export type ReconstructionOutcome = "captured" | "expected_failure" | "failed";

export type ScenarioReconstruction = {
  scenarioId: string;
  outcome: ReconstructionOutcome;
  /** Real capture id — only set when publication was verified. */
  captureId?: string;
  artifactId?: string;
  /** SHA-256 of the published screenshot bytes. */
  sha256?: string;
  occurrenceCount?: number;
  /** True when an already-published capture with the same build digest was reused (spec section 11 dedup). */
  deduplicated?: boolean;
  error?: string;
};

export type CommitReconstruction = {
  commitSha: string;
  buildArtifactDigest: string;
  intentionallyUnbuildable: boolean;
  scenarios: ScenarioReconstruction[];
};

export type ReconstructCommitArgs = {
  /** Local path to the repository holding commitSha. */
  repoDir?: string;
  /** Repository URL. Only local paths are supported in the dev profile. */
  repoUrl?: string;
  commitSha: string;
  /** Scenario ids (resolved against standardScenarios) or explicit recipes. */
  scenarios?: Array<string | ScenarioRecipe>;
  api: UploadApi;
  environment?: CaptureEnvironment;
  redactionPolicy?: RedactionPolicy;
  /**
   * Marker string that declares an intentionally unbuildable revision. When a
   * commit's sources contain it, a scenario failure is recorded as an EXPECTED
   * failure — never faked into a success.
   */
  unbuildableMarker?: string;
  /** Injection seam for tests. */
  deps?: {
    uploader?: Pick<CaptureUploader, "upload">;
    runner?: ScenarioRunner;
    fetch?: typeof fetch;
  };
  onLog?: (message: string) => void;
};

/** Source-tree marker declared by the fixture corpus's unbuildable commit. */
export const UNBUILDABLE_MARKER = "INTENTIONALLY_UNBUILDABLE";

// ---------------------------------------------------------------------------
// Recipe tolerance
// ---------------------------------------------------------------------------

/**
 * Adapt a standard scenario recipe for the fixture corpus (audit finding 3b):
 * recipes are used AS-IS. Routes are no longer rewritten to "/" (that rewrite
 * made every account capture hit the catalog page) and readiness selectors are
 * no longer loosened (the recipes' selectors match the anchors the fixture
 * commits really declare — catalog.productChooser at "/", account.profileForm
 * at "/#/account", which the fixture's host page hash-routes to account.html).
 * Interactions and viewports apply as-is.
 */
export function tolerantRecipe(recipe: ScenarioRecipe): ScenarioRecipe {
  return { ...recipe };
}

/** Resolve scenario ids/recipes to tolerant recipes. */
export function resolveScenarios(scenarios?: Array<string | ScenarioRecipe>): ScenarioRecipe[] {
  const all = standardScenarios();
  const list = scenarios ?? all;
  return list.map((entry) => {
    if (typeof entry !== "string") return tolerantRecipe(entry);
    const recipe = all.find((r) => r.id === entry);
    if (!recipe) throw new Error(`unknown scenario id "${entry}"`);
    return tolerantRecipe(recipe);
  });
}

// ---------------------------------------------------------------------------
// Worktree materialization
// ---------------------------------------------------------------------------

/** Resolve repoUrl to a local directory; remote clones are not configured. */
function resolveLocalRepo(repoUrl?: string): string | undefined {
  if (!repoUrl) return undefined;
  if (/^[a-z]+:\/\//i.test(repoUrl)) {
    throw new Error("remote clone not configured in dev profile: pass a local repoDir (fixture corpora are local)");
  }
  return repoUrl;
}

/** Extract the commit into a temp worktree; returns a cleanup function. */
export function materializeCommit(repoDir: string, commitSha: string): { dir: string; cleanup: () => void } {
  const workRoot = mkdtempSync(path.join(tmpdir(), "ui-intel-reconstruct-"));
  const worktreeDir = path.join(workRoot, "worktree");
  try {
    execFileSync("git", ["worktree", "add", "--detach", worktreeDir, commitSha], { cwd: repoDir, stdio: "pipe" });
  } catch (error) {
    rmSync(workRoot, { recursive: true, force: true });
    throw new Error(
      `cannot reconstruct commit ${commitSha} from ${repoDir}: ${(error as Error).message}`,
    );
  }
  return {
    dir: worktreeDir,
    cleanup: () => {
      try {
        execFileSync("git", ["worktree", "remove", "--force", worktreeDir], { cwd: repoDir, stdio: "pipe" });
      } catch {
        // Best effort; the temp root is removed below regardless.
      }
      rmSync(workRoot, { recursive: true, force: true });
    },
  };
}

/** Recursively list files below dir (relative, sorted). */
function listFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.name === ".git") continue;
    if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

/** Digest of the served tree: hash over sorted (path, bytes) pairs. */
export async function digestTree(dir: string): Promise<string> {
  const parts: Uint8Array[] = [];
  const enc = new TextEncoder();
  for (const rel of listFiles(dir)) {
    parts.push(enc.encode(rel));
    parts.push(enc.encode("\0"));
    parts.push(readFileSync(path.join(dir, rel)));
    parts.push(enc.encode("\0"));
  }
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    merged.set(p, offset);
    offset += p.byteLength;
  }
  return hashBytes(merged);
}

/** True when any source file in the tree declares the unbuildable marker. */
export function declaresUnbuildable(dir: string, marker: string): boolean {
  for (const rel of listFiles(dir)) {
    try {
      if (statSync(path.join(dir, rel)).size > 1024 * 1024) continue;
      if (readFileSync(path.join(dir, rel), "utf8").includes(marker)) return true;
    } catch {
      // Binary or unreadable file: skip.
    }
  }
  return false;
}

/**
 * Build identity for a LIVE-APP capture (audit finding 3d): SHA-256 over the
 * first response's HTML instead of the constant "runner-managed" digest, so
 * captures of different served builds deduplicate differently. Throws when
 * the app URL is not readable — a capture against an unreadable app would be
 * worthless anyway.
 */
export async function digestServedPage(appUrl: string, doFetch: typeof fetch = fetch): Promise<string> {
  const response = await doFetch(appUrl);
  if (!response.ok) {
    throw new Error(`cannot read served page at ${appUrl} for build digest (status ${response.status})`);
  }
  const html = await response.text();
  return hashBytes(new TextEncoder().encode(html));
}

// ---------------------------------------------------------------------------
// Static serving
// ---------------------------------------------------------------------------

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
};

/**
 * Tiny static file server (ephemeral port). The fixture corpus has no build
 * step — serving IS the build for this corpus. Real applications would run
 * their build pipeline here and serve the built output instead.
 *
 * Route mapping (audit finding 3b): /account serves account.html so the
 * account scenarios capture the account page; every other document path
 * falls back to index.html (the fixture host page hash-routes /#/account to
 * the same account page).
 */
export function serveStatic(dir: string): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const pathname = decodeURIComponent(url.pathname).replace(/^\/+/, "");
        let rel: string;
        if (pathname === "" || pathname === "/") rel = "index.html";
        else if (pathname === "account" || pathname === "account/") rel = "account.html";
        else rel = pathname;
        const abs = path.resolve(dir, rel);
        if (!abs.startsWith(path.resolve(dir) + path.sep) && abs !== path.resolve(dir)) {
          res.writeHead(403).end("forbidden");
          return;
        }
        const bytes = readFileSync(abs);
        res.writeHead(200, { "content-type": MIME_TYPES[path.extname(abs)] ?? "application/octet-stream" });
        res.end(bytes);
      } catch {
        res.writeHead(404).end("not found");
      }
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Build adapter (GAP B: React/Vite and other build-required frameworks)
// ---------------------------------------------------------------------------

export type BuildAdapterConfig = {
  /** Directory inside the materialized worktree where the app lives (default "."). */
  appDir?: string;
  /** Install command (default "npm ci"). */
  installCommand?: string;
  /** Build command (default "npm run build"). */
  buildCommand?: string;
  /** Output directory relative to appDir (default "dist"). */
  outDir?: string;
  /** Build timeout in milliseconds (default 120_000). */
  timeoutMs?: number;
  /** Env vars to forward (default ["NODE_ENV", "CI"]). */
  envAllowlist?: string[];
};

export type HistoryManifest = {
  buildAdapter?: BuildAdapterConfig;
};

/** Read ui-intel.history.json from the materialized worktree if present. */
export function readHistoryManifest(dir: string): HistoryManifest | undefined {
  const manifestPath = path.join(dir, "ui-intel.history.json");
  if (!existsSync(manifestPath)) return undefined;
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8")) as HistoryManifest;
  } catch {
    return undefined;
  }
}

/** Promise wrapper around execFile with timeout and max-buffer protection. */
function execFilePromise(
  command: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; maxOutput: number; env?: NodeJS.ProcessEnv }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      { cwd: opts.cwd, env: opts.env, timeout: opts.timeoutMs, maxBuffer: opts.maxOutput },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${command} ${args.join(" ")} failed: ${error.message}\nstdout: ${stdout}\nstderr: ${stderr}`));
        } else {
          resolve({ stdout, stderr });
        }
      }
    );
  });
}

/**
 * Build + serve a materialized commit that declares a build adapter in
 * ui-intel.history.json. Runs install + build with resource limits, then serves
 * the built output directory on an ephemeral port. Falls back to serveStatic
 * when no manifest is present so existing static-fixture repos keep working.
 */
export async function buildAndServe(
  materializedDir: string,
  manifest: HistoryManifest
): Promise<{ baseUrl: string; close: () => Promise<void>; buildOutDir: string }> {
  const config: Required<BuildAdapterConfig> = {
    appDir: manifest.buildAdapter?.appDir ?? ".",
    installCommand: manifest.buildAdapter?.installCommand ?? "npm ci",
    buildCommand: manifest.buildAdapter?.buildCommand ?? "npm run build",
    outDir: manifest.buildAdapter?.outDir ?? "dist",
    timeoutMs: manifest.buildAdapter?.timeoutMs ?? 120_000,
    envAllowlist: manifest.buildAdapter?.envAllowlist ?? ["NODE_ENV", "CI", "npm_config_cache"],
  };

  const appDir = path.resolve(materializedDir, config.appDir);
  const outDir = path.resolve(appDir, config.outDir);
  const maxOutput = 2 * 1024 * 1024; // 2 MB stdout+stderr cap

  const allowedEnv: NodeJS.ProcessEnv = {};
  for (const key of config.envAllowlist) {
    if (process.env[key] !== undefined) allowedEnv[key] = process.env[key];
  }
  allowedEnv["PATH"] = process.env.PATH ?? "";
  allowedEnv["HOME"] = process.env.HOME ?? "";

  const installArgs = config.installCommand.split(/\s+/).filter(Boolean);
  const installCmd = installArgs.shift()!;
  await execFilePromise(installCmd, installArgs, { cwd: appDir, timeoutMs: config.timeoutMs, maxOutput, env: allowedEnv });

  const buildArgs = config.buildCommand.split(/\s+/).filter(Boolean);
  const buildCmd = buildArgs.shift()!;
  await execFilePromise(buildCmd, buildArgs, { cwd: appDir, timeoutMs: config.timeoutMs, maxOutput, env: allowedEnv });

  const server = await serveStatic(outDir);
  return {
    baseUrl: server.baseUrl,
    close: server.close,
    buildOutDir: outDir,
  };
}

// ---------------------------------------------------------------------------
// Durable publication + verification
// ---------------------------------------------------------------------------

/**
 * Verify publication through the project API (spec section 11: publish only
 * after required objects and checksums are verified): the capture must be
 * retrievable, carry occurrences, and its screenshot bytes must be readable
 * from the raw artifact endpoint.
 */
export async function verifyPublication(
  api: UploadApi,
  captureId: string,
  artifactId: string,
  opts?: { fetch?: typeof fetch },
): Promise<{ occurrenceCount: number; byteLength: number }> {
  const doFetch = opts?.fetch ?? fetch;
  const base = api.baseUrl.replace(/\/$/, "");
  const headers = { authorization: `Bearer ${api.token}` };

  const captureResponse = await doFetch(`${base}/v1/projects/${api.projectId}/captures/${captureId}`, { headers });
  if (!captureResponse.ok) {
    throw new Error(`publication verification failed: capture ${captureId} not retrievable (status ${captureResponse.status})`);
  }
  const { manifest } = (await captureResponse.json()) as { manifest: { observations: unknown[] } };
  const occurrenceCount = manifest.observations.length;
  if (occurrenceCount <= 0) {
    throw new Error(`publication verification failed: capture ${captureId} has no occurrences`);
  }

  const rawResponse = await doFetch(
    `${base}/v1/artifacts/${artifactId}/raw?projectId=${encodeURIComponent(api.projectId)}`,
    { headers },
  );
  if (!rawResponse.ok) {
    throw new Error(`publication verification failed: artifact ${artifactId} bytes not retrievable (status ${rawResponse.status})`);
  }
  const byteLength = (await rawResponse.arrayBuffer()).byteLength;
  if (byteLength === 0) {
    throw new Error(`publication verification failed: artifact ${artifactId} bytes are empty`);
  }
  return { occurrenceCount, byteLength };
}

export type PublishedCapture = {
  captureId: string;
  artifactId: string;
  sha256: string;
  occurrenceCount: number;
  /** True when an already-published capture was reused (spec section 11 dedup). */
  deduplicated?: boolean;
};

function isIdempotencyConflict(error: unknown): boolean {
  const message = (error as Error).message ?? "";
  return message.includes("409") || message.includes("IDEMPOTENCY_MISMATCH");
}

/**
 * Upload + verify one capture. Returns the REAL capture id only after the
 * capture and its artifact bytes are retrievable from the history API.
 *
 * With `dedupe` (commit, scenario, build digest), an idempotency conflict —
 * the same request key was already published (spec section 11: equivalent
 * work is deduplicated) — resolves to the EXISTING verified capture instead
 * of failing the publication.
 */
export async function publishCapture(args: {
  manifest: Parameters<CaptureUploader["upload"]>[0];
  screenshotBytes: Uint8Array;
  api: UploadApi;
  uploader?: Pick<CaptureUploader, "upload">;
  fetch?: typeof fetch;
  dedupe?: { commitSha: string; scenarioId: string; buildArtifactDigest: string };
}): Promise<PublishedCapture> {
  const uploader = args.uploader ?? new CaptureUploader();
  let captureId: string;
  try {
    ({ captureId } = await uploader.upload(args.manifest, args.screenshotBytes, args.api));
  } catch (error) {
    if (args.dedupe && isIdempotencyConflict(error)) {
      const existing = await findPublishedCapture({ api: args.api, ...args.dedupe, fetch: args.fetch });
      if (existing) return { ...existing, deduplicated: true };
    }
    throw error;
  }
  const screenshot = args.manifest.artifacts.find((a) => a.kind === "screenshot-png");
  if (!screenshot) throw new Error("manifest has no screenshot artifact; cannot verify publication");
  const { occurrenceCount } = await verifyPublication(args.api, captureId, screenshot.artifactId, {
    fetch: args.fetch,
  });
  return { captureId, artifactId: screenshot.artifactId, sha256: screenshot.digest, occurrenceCount };
}

/**
 * History API connection from the environment (dev profile):
 * HISTORY_API_URL, HISTORY_API_TOKEN (default dev-token), HISTORY_API_PROJECT
 * (default the seeded reference project). Undefined when HISTORY_API_URL is
 * not configured — callers must then report scenarios as failed instead of
 * reporting unpublished captures as captured.
 */
export function historyApiFromEnv(): UploadApi | undefined {
  const baseUrl = process.env.HISTORY_API_URL;
  if (!baseUrl) return undefined;
  return {
    baseUrl,
    token: process.env.HISTORY_API_TOKEN ?? "dev-token",
    projectId: process.env.HISTORY_API_PROJECT ?? "proj_reference_app",
  };
}

// ---------------------------------------------------------------------------
// Commit reconstruction
// ---------------------------------------------------------------------------

/**
 * Find an already-published capture for (commit, scenario, build digest): the
 * request key deduplicates equivalent work (spec section 11), so re-running a
 * reconstruction REUSES the published capture instead of re-capturing — a
 * second capture of the identical spec would be rejected by the history API
 * (idempotency mismatch) anyway.
 */
export async function findPublishedCapture(args: {
  api: UploadApi;
  commitSha: string;
  scenarioId: string;
  buildArtifactDigest: string;
  fetch?: typeof fetch;
}): Promise<PublishedCapture | undefined> {
  const doFetch = args.fetch ?? fetch;
  const base = args.api.baseUrl.replace(/\/$/, "");
  const headers = { authorization: `Bearer ${args.api.token}` };
  const listResponse = await doFetch(
    `${base}/v1/projects/${args.api.projectId}/captures` +
      `?commit=${encodeURIComponent(args.commitSha)}&scenario=${encodeURIComponent(args.scenarioId)}`,
    { headers },
  );
  if (!listResponse.ok) return undefined;
  const { captures } = (await listResponse.json()) as { captures: Array<{ captureId: string }> };
  for (const entry of captures) {
    try {
      const detail = await doFetch(
        `${base}/v1/projects/${args.api.projectId}/captures/${entry.captureId}`,
        { headers },
      );
      if (!detail.ok) continue;
      const { manifest } = (await detail.json()) as {
        manifest: CaptureManifest;
      };
      if (manifest.spec.buildArtifactDigest !== args.buildArtifactDigest) continue;
      const screenshot = manifest.artifacts.find((a) => a.kind === "screenshot-png");
      if (!screenshot) continue;
      const { occurrenceCount } = await verifyPublication(args.api, entry.captureId, screenshot.artifactId, {
        fetch: args.fetch,
      });
      return { captureId: entry.captureId, artifactId: screenshot.artifactId, sha256: screenshot.digest, occurrenceCount };
    } catch {
      // Unusable candidate; keep looking.
    }
  }
  return undefined;
}

/**
 * Reconstruct one commit and capture its declared scenarios:
 * 1. materialize the commit (git worktree) into a temp dir;
 * 2. serve the static tree on an ephemeral port (serving IS the build for the
 *    fixture corpus — real apps would run their build here);
 * 3. run every scenario recipe, upload via CaptureUploader, and VERIFY
 *    publication (capture retrievable, occurrences > 0, artifact bytes
 *    readable) before counting the scenario as captured. A capture already
 *    published for the same (commit, scenario, build digest) is reused.
 * 4. record scenario failures honestly; for a commit that declares the
 *    unbuildable marker, failures are EXPECTED failures.
 */
export async function reconstructCommit(args: ReconstructCommitArgs): Promise<CommitReconstruction> {
  const log = args.onLog ?? (() => undefined);
  const repoDir = args.repoDir ?? resolveLocalRepo(args.repoUrl);
  if (!repoDir) {
    throw new Error("reconstruction requires repoDir (or a local repoUrl); remote clone not configured in dev profile");
  }

  const marker = args.unbuildableMarker ?? UNBUILDABLE_MARKER;
  const recipes = resolveScenarios(args.scenarios);
  const redactionPolicy: RedactionPolicy = args.redactionPolicy ?? { version: "1", masks: [] };
  const materialized = materializeCommit(repoDir, args.commitSha);
  const manifest = readHistoryManifest(materialized.dir);
  const adapterVersion = manifest?.buildAdapter ? "build-adapter" : "static-fixture";
  const environment: CaptureEnvironment = args.environment ?? {
    runnerImageDigest: "reconstruct-local",
    browserRevision: "bundled-playwright",
    fontsDigest: "unknown",
    adapterVersion,
    captureToolVersion: "1.0.0",
    redactionPolicyDigest: await digestOf(redactionPolicy),
  };

  let server: { baseUrl: string; close: () => Promise<void> };
  let buildOutDir: string | undefined;
  if (manifest?.buildAdapter) {
    log(`reconstruct ${args.commitSha}: build adapter detected in ui-intel.history.json`);
    const built = await buildAndServe(materialized.dir, manifest);
    server = built;
    buildOutDir = built.buildOutDir;
  } else {
    server = await serveStatic(materialized.dir);
  }
  try {
    const servedDir = buildOutDir ?? materialized.dir;
    const buildArtifactDigest = await digestTree(servedDir);
    const intentionallyUnbuildable = declaresUnbuildable(materialized.dir, marker);
    log(
      `reconstruct ${args.commitSha}: serving ${servedDir} at ${server.baseUrl} ` +
        `(digest ${buildArtifactDigest.slice(0, 12)}…, unbuildable=${intentionallyUnbuildable})`,
    );

    const runner =
      args.deps?.runner ?? new ScenarioRunner({ baseUrl: server.baseUrl, adapterVersion, redactionPolicy });
    const results: ScenarioReconstruction[] = [];
    let firstUnbuildableFailure: string | undefined;

    for (const recipe of recipes) {
      const remaining = firstUnbuildableFailure !== undefined;
      // Spec section 11: equivalent work is deduplicated by request key —
      // reuse an already-published capture of the same (commit, scenario,
      // build digest) instead of re-capturing.
      try {
        const existing = await findPublishedCapture({
          api: args.api,
          commitSha: args.commitSha,
          scenarioId: recipe.id,
          buildArtifactDigest,
          fetch: args.deps?.fetch,
        });
        if (existing) {
          results.push({ scenarioId: recipe.id, outcome: "captured", ...existing, deduplicated: true });
          log(`reconstruct ${args.commitSha}: reused published ${recipe.id} -> ${existing.captureId}`);
          continue;
        }
      } catch {
        // Dedup lookup is an optimization; fall through to capture.
      }
      try {
        const { manifest, screenshotBytes } = await runner.execute(recipe, {
          projectId: args.api.projectId,
          commitSha: args.commitSha,
          buildArtifactDigest,
          environment,
        });
        let published: PublishedCapture;
        try {
          published = await publishCapture({
            manifest,
            screenshotBytes,
            api: args.api,
            uploader: args.deps?.uploader,
            fetch: args.deps?.fetch,
          });
        } catch (publishError) {
          // A concurrent/previous publication of the identical spec wins:
          // resolve the dedup instead of failing the scenario.
          if (!isIdempotencyConflict(publishError)) throw publishError;
          const dedup = await findPublishedCapture({
            api: args.api,
            commitSha: args.commitSha,
            scenarioId: recipe.id,
            buildArtifactDigest,
            fetch: args.deps?.fetch,
          });
          if (!dedup) throw publishError;
          published = dedup;
        }
        results.push({ scenarioId: recipe.id, outcome: "captured", ...published });
        log(`reconstruct ${args.commitSha}: captured ${recipe.id} -> ${published.captureId}`);
      } catch (error) {
        const message = (error as Error).message;
        if (remaining) {
          // The commit already proved itself unbuildable: skip the remaining
          // scenarios instead of burning identical browser timeouts.
          results.push({
            scenarioId: recipe.id,
            outcome: "expected_failure",
            error: `skipped after first unbuildable failure (${firstUnbuildableFailure})`,
          });
        } else if (intentionallyUnbuildable) {
          firstUnbuildableFailure = message;
          results.push({ scenarioId: recipe.id, outcome: "expected_failure", error: message });
          log(`reconstruct ${args.commitSha}: expected failure for ${recipe.id}: ${message}`);
        } else {
          results.push({ scenarioId: recipe.id, outcome: "failed", error: message });
          log(`reconstruct ${args.commitSha}: FAILED ${recipe.id}: ${message}`);
        }
      }
    }
    return { commitSha: args.commitSha, buildArtifactDigest, intentionallyUnbuildable, scenarios: results };
  } finally {
    // Nested finally (closure review): a rejecting server.close() must not
    // skip materialized.cleanup() — that would leak the git worktree and its
    // temp directory on every failed reconstruction.
    try {
      await server.close();
    } finally {
      materialized.cleanup();
    }
  }
}

// ---------------------------------------------------------------------------
// Managed-run execution (runner-manager executor + capture-runner managed mode)
// ---------------------------------------------------------------------------

/** True when repoUrl names a LOCAL path (dev profile); remote URLs do not. */
export function isLocalRepoPath(repoUrl?: string): boolean {
  if (!repoUrl) return false;
  return !/^[a-z]+:\/\//i.test(repoUrl) && !repoUrl.startsWith("git@");
}

export type ManagedScenarioResult = {
  scenarioId: string;
  status: "captured" | "failed";
  captureId?: string;
  artifactId?: string;
  error?: string;
};

export type ManagedRunProvenance = {
  mode: "reconstructed" | "live-app";
  commitSha?: string;
  repoUrl?: string;
  note?: string;
};

export type ManagedRunOutcome = {
  provenance: ManagedRunProvenance;
  results: ManagedScenarioResult[];
};

export type ManagedRunArgs = {
  projectId: string;
  /** Local path (triggers REAL commit reconstruction) or remote/absent (live app). */
  repoUrl?: string;
  commitSha: string;
  scenarios: string[];
  /** Base URL of the app under capture (live-app path). */
  appUrl: string;
  /** History API for durable publication; without it nothing can count as captured. */
  api?: UploadApi;
  redactionPolicy?: RedactionPolicy;
  onLog?: (message: string) => void;
  /** Injection seams for tests. */
  deps?: {
    uploader?: Pick<CaptureUploader, "upload">;
    runner?: Pick<ScenarioRunner, "execute">;
    fetch?: typeof fetch;
    reconstruct?: typeof reconstructCommit;
  };
};

/**
 * Execute one managed run honestly (audit finding 3d). Two modes:
 *
 * - LOCAL repoUrl: reconstruct the ACTUAL commit (git worktree -> static
 *   serve -> capture -> durable publish -> verify via reconstructCommit) and
 *   report provenance mode "reconstructed". Captures carry that commit sha
 *   and the real tree digest — the commit binding is VERIFIED.
 * - REMOTE/absent repoUrl: capture the configured APP_URL, computing
 *   buildArtifactDigest from the served page's first response HTML (never a
 *   constant), and report provenance {mode: "live-app"} with the honest note
 *   that the commit binding is asserted, not verified. A scenario is never
 *   reported "captured" without durable publication + verification, and an
 *   intentionally unbuildable reconstruction failure is reported as a failed
 *   scenario with its expected-failure reason — never as a success.
 */
export async function executeManagedRun(args: ManagedRunArgs): Promise<ManagedRunOutcome> {
  const log = args.onLog ?? (() => undefined);
  const api = args.api;

  if (isLocalRepoPath(args.repoUrl)) {
    const repoDir = args.repoUrl as string;
    if (!api) {
      return {
        provenance: { mode: "reconstructed", commitSha: args.commitSha, repoUrl: repoDir },
        results: args.scenarios.map((scenarioId) => ({
          scenarioId,
          status: "failed" as const,
          error: "history API not configured (HISTORY_API_URL): reconstruction cannot be durably published",
        })),
      };
    }
    log(`run reconstruction: local repo ${repoDir} @ ${args.commitSha}`);
    const reconstruction = await (args.deps?.reconstruct ?? reconstructCommit)({
      repoDir,
      commitSha: args.commitSha,
      scenarios: args.scenarios,
      api,
      onLog: log,
    });
    return {
      provenance: {
        mode: "reconstructed",
        commitSha: args.commitSha,
        repoUrl: repoDir,
        note: "captures reconstructed from the actual commit (worktree -> serve -> capture -> publish -> verify)",
      },
      results: reconstruction.scenarios.map((scenario) => {
        const result: ManagedScenarioResult = {
          scenarioId: scenario.scenarioId,
          status: scenario.outcome === "captured" ? "captured" : "failed",
        };
        if (scenario.captureId) result.captureId = scenario.captureId;
        if (scenario.artifactId) result.artifactId = scenario.artifactId;
        if (scenario.error && scenario.outcome !== "captured") {
          result.error =
            scenario.outcome === "expected_failure"
              ? `expected failure (intentionally unbuildable commit): ${scenario.error}`
              : scenario.error;
        }
        return result;
      }),
    };
  }

  // Live-app path: capture the configured APP_URL with an honest build digest
  // and honest provenance.
  const redactionPolicy: RedactionPolicy = args.redactionPolicy ?? { version: "1", masks: [] };
  let buildArtifactDigest: string;
  try {
    buildArtifactDigest = await digestServedPage(args.appUrl, args.deps?.fetch);
  } catch (error) {
    return {
      provenance: {
        mode: "live-app",
        commitSha: args.commitSha,
        note: "commit binding asserted, not verified — remote/absent repoUrl",
      },
      results: args.scenarios.map((scenarioId) => ({
        scenarioId,
        status: "failed" as const,
        error: (error as Error).message,
      })),
    };
  }
  const runner =
    args.deps?.runner ?? new ScenarioRunner({ baseUrl: args.appUrl, adapterVersion: "unknown", redactionPolicy });
  const environment: CaptureEnvironment = {
    runnerImageDigest: "local",
    browserRevision: "bundled-playwright",
    fontsDigest: "unknown",
    adapterVersion: "unknown",
    captureToolVersion: "1.0.0",
    redactionPolicyDigest: await digestOf(redactionPolicy),
  };
  const results: ManagedScenarioResult[] = [];
  for (const scenarioId of args.scenarios) {
    const recipe = standardScenarios().find((r) => r.id === scenarioId);
    if (!recipe) {
      results.push({ scenarioId, status: "failed", error: `unknown scenario id "${scenarioId}"` });
      continue;
    }
    try {
      const { manifest, screenshotBytes } = await runner.execute(recipe, {
        projectId: args.projectId,
        commitSha: args.commitSha,
        buildArtifactDigest,
        environment,
      });
      if (!api) {
        results.push({
          scenarioId,
          status: "failed",
          error: "history API not configured (HISTORY_API_URL): capture executed but NOT durably published",
        });
        continue;
      }
      const published = await publishCapture({
        manifest,
        screenshotBytes,
        api,
        uploader: args.deps?.uploader,
        fetch: args.deps?.fetch,
        // Spec section 11: equivalent work is deduplicated by (commit,
        // scenario, build digest) — here with the REAL served-page digest.
        dedupe: { commitSha: args.commitSha, scenarioId: recipe.id, buildArtifactDigest },
      });
      results.push({ scenarioId, status: "captured", captureId: published.captureId, artifactId: published.artifactId });
    } catch (error) {
      results.push({ scenarioId, status: "failed", error: (error as Error).message });
    }
  }
  return {
    provenance: {
      mode: "live-app",
      commitSha: args.commitSha,
      note: "commit binding asserted, not verified — remote/absent repoUrl",
    },
    results,
  };
}
