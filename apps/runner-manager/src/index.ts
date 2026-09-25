/**
 * @ui-intelligence/runner-manager — managed historical runner pool (R2
 * stream D). See docs/r2-plan.md part D and docs/architecture.md sections
 * 10-11.
 */
export { buildManager, main, type ManagerOptions } from "./server.js";
export { openDb, migrate, type Db } from "./db.js";
export { RUNNER_SCHEMA_SQL } from "./schema.js";
export {
  claimNextRun,
  completeRun,
  createRun,
  getRun,
  heartbeatWorker,
  registerWorker,
  LEASE_MS,
  WORKER_EXPIRY_MS,
  type CreateRunInput,
  type CompleteRunInput,
  type RunRecord,
  type RunClaim,
  type RunStatus,
  type ScenarioResult,
  type WorkerKind,
  type WorkerStatus,
} from "./store.js";
export { defaultExecutor, defaultEnvironment, type RunExecutor, type RunExecutionInput, type RunExecutionResult } from "./executor.js";
export { runPool, type PoolHandle, type PoolOptions } from "./pool.js";
export { runWorkerLoop, type WorkerLoopOptions } from "./worker.js";
