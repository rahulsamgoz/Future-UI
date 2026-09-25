/**
 * Managed worker pool (R2 stream D): `runPool(count, opts)` keeps `count`
 * capture-runner workers alive against the manager. Two modes:
 *
 * - process (default): spawns `count` child processes running the
 *   capture-runner entrypoint (node apps/capture-runner/dist/main.js) with
 *   RUNNER_MANAGER_URL/APP_URL env pointing at the manager and the app under
 *   capture. Dead workers are restarted (bounded backoff) unless stopping.
 * - embedded (opts.executor set): runs `count` in-process worker loops with
 *   the injected executor — used by tests and by embedders that must not
 *   spawn browsers.
 *
 * Workers heartbeat every 10s; the manager re-queues runs of dead workers.
 * Bounded: one run per worker at a time (enforced by the manager).
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runWorkerLoop } from "./worker.js";
import type { RunExecutor } from "./executor.js";

const RESPAWN_DELAY_MS = 2000;

export type PoolOptions = {
  managerUrl: string;
  token?: string;
  /** App under capture (passed to workers as APP_URL). */
  appUrl: string;
  /** Override the capture-runner entrypoint (default: sibling app dist). */
  runnerEntry?: string;
  /** When set the pool runs embedded in-process workers instead of children. */
  executor?: RunExecutor;
  heartbeatMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
  onLog?: (message: string) => void;
};

export type PoolHandle = {
  stop(): Promise<void>;
  /** Child pids (empty in embedded mode). */
  children(): ChildProcess[];
};
function defaultRunnerEntry(): string {
  // apps/runner-manager/dist/pool.js → apps/capture-runner/dist/main.js
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..", "apps", "capture-runner", "dist", "main.js");
}

/** Spawn/restart loop for one child worker slot. */
function runChildSlot(index: number, count: number, opts: PoolOptions, children: Set<ChildProcess>): void {
  if (opts.signal?.aborted) return;
  const entry = opts.runnerEntry ?? defaultRunnerEntry();
  const log = opts.onLog ?? (() => undefined);
  const child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      RUNNER_MANAGER_URL: opts.managerUrl,
      RUNNER_TOKEN: opts.token ?? process.env.RUNNER_TOKEN ?? "dev-token",
      APP_URL: opts.appUrl,
      WORKER_SLOT: String(index),
      POOL_SIZE: String(count),
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  children.add(child);
  log(`pool: spawned worker slot ${index} (pid ${child.pid}) -> ${entry}`);
  child.once("exit", (code) => {
    children.delete(child);
    if (opts.signal?.aborted) return;
    log(`pool: worker slot ${index} exited (code ${code}); respawning in ${RESPAWN_DELAY_MS}ms`);
    setTimeout(() => runChildSlot(index, count, opts, children), RESPAWN_DELAY_MS);
  });
}

/**
 * Start a pool of `count` workers. Returns a handle; stop() aborts children
 * (SIGTERM) or embedded loops and resolves once they are gone.
 */
export function runPool(count: number, opts: PoolOptions): PoolHandle {
  if (count < 1) throw new Error("runPool requires count >= 1");
  const owned = new AbortController();
  const ownsSignal = opts.signal === undefined;
  const signal = opts.signal ?? owned.signal;
  const children = new Set<ChildProcess>();
  const loops: Array<Promise<void>> = [];

  if (opts.executor) {
    for (let i = 0; i < count; i += 1) {
      loops.push(
        runWorkerLoop({
          managerUrl: opts.managerUrl,
          token: opts.token,
          executor: opts.executor,
          appUrl: opts.appUrl,
          heartbeatMs: opts.heartbeatMs,
          pollMs: opts.pollMs,
          signal,
          onLog: opts.onLog,
        }).catch(() => undefined)
      );
    }
  } else {
    for (let i = 0; i < count; i += 1) {
      runChildSlot(i, count, opts, children);
    }
  }

  return {
    children: () => [...children],
    async stop() {
      if (ownsSignal) owned.abort();
      for (const child of children) {
        child.kill("SIGTERM");
      }
      for (const loop of loops) {
        await loop;
      }
    },
  };
}
