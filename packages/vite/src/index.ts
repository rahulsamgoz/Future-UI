/**
 * Vite plugin (architecture sections 6, 16): build identity and two separate
 * manifests.
 *
 * - PUBLIC manifest (`/.ui-intelligence/manifest.json`): only permitted entity
 *   keys, page keys, protocol version, build id, adapter capabilities, and
 *   runtime contract refs. Never contains source paths, symbols, or the commit.
 * - PRIVATE manifest (configurable `privateOutDir`, default
 *   `dist-private/ui-intelligence/private-manifest.json`): commit SHA, per-entity
 *   source file, symbol, instrumentation version, and content hash.
 *   This file is .gitignore'd by convention and MUST NEVER be served publicly;
 *   it is only consumed by the developer CLI and capture tooling.
 *
 * Also provides the virtual module `virtual:ui-intelligence/manifest` so app
 * code can read the public manifest at build time.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PROTOCOL_VERSION } from "@ui-intelligence/protocol";
import type { Plugin, ResolvedConfig } from "vite";

export type UiIntelligenceEntityInput = {
  /** Developer-assigned semantic anchor, e.g. "catalog.productChooser". */
  entityKey: string;
  /** Optional page key the entity belongs to. */
  pageKey?: string;
  /** Source file (repo-relative) registered for this boundary. Private only. */
  sourceFile?: string;
  /** Exported symbol registered for this boundary. Private only. */
  symbol?: string;
};

export type UiIntelligencePluginOptions = {
  projectKey: string;
  entities: UiIntelligenceEntityInput[];
  /** Directory (relative to the project root) for the private manifest. Default "dist-private/ui-intelligence". */
  privateOutDir?: string;
  /** Append an instrumentation tag comment to registered source files. Default false. */
  annotate?: boolean;
  /** Instrumentation version stamped into the private manifest. Default 1. */
  instrumentationVersion?: number;
};

export const VIRTUAL_MANIFEST_ID = "virtual:ui-intelligence/manifest";
const RESOLVED_VIRTUAL_MANIFEST_ID = "\0virtual:ui-intelligence/manifest";
export const PUBLIC_MANIFEST_FILE = ".ui-intelligence/manifest.json";
export const PRIVATE_MANIFEST_FILE = "private-manifest.json";
export const DEFAULT_PRIVATE_OUT_DIR = "dist-private/ui-intelligence";

/** Capabilities advertised to the runtime/agent (public information). */
export const ADAPTER_CAPABILITIES = {
  frameworks: ["react"],
  selection: ["button", "repeated-instance", "component", "section", "page"],
  representations: ["carousel@1", "grid@1", "table@1"],
  virtualModule: VIRTUAL_MANIFEST_ID,
  protocolVersion: PROTOCOL_VERSION,
} as const;

export type PublicManifest = {
  protocolVersion: number;
  buildId: string;
  projectKey: string;
  entities: Array<{ entityKey: string; pageKey?: string }>;
  adapterCapabilities: typeof ADAPTER_CAPABILITIES;
  runtimeContractRefs: string[];
};

export type PrivateManifestEntity = {
  entityKey: string;
  pageKey?: string;
  sourceFile: string;
  symbol: string;
  instrumentationVersion: number;
  contentHash: string;
};

export type PrivateManifest = {
  protocolVersion: number;
  buildId: string;
  commitSha: string;
  notice: string;
  entities: PrivateManifestEntity[];
};

/** Resolve the current git commit SHA for the project being built. */
export function resolveCommitSha(cwd: string): string {
  try {
    const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
    if (result.status === 0) {
      const sha = result.stdout.trim();
      if (/^[0-9a-f]{40}$/i.test(sha)) return sha;
    }
  } catch {
    // fall through to "unknown"
  }
  return "unknown";
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Build identity: hash of the vite config identity + resolved entry files.
 *
 * The PUBLIC buildId never contains the commit SHA or a prefix of it — the
 * raw commit stays in the private manifest only. The public id is derived
 * from a one-way hash so it still changes when the commit changes.
 */
export function computeBuildId(args: {
  commitSha: string;
  configFile: string | undefined;
  inputs: unknown;
}): string {
  const identity = sha256Hex(
    JSON.stringify({
      commit: args.commitSha,
      config: args.configFile ?? "(inline)",
      inputs: args.inputs ?? null,
    })
  );
  return args.commitSha === "unknown" ? `unknown-${identity.slice(0, 16)}` : identity.slice(0, 28);
}

async function hashFileContent(rootDir: string, sourceFile: string | undefined, entityKey: string): Promise<string> {
  if (!sourceFile) return sha256Hex(`unregistered:${entityKey}`);
  try {
    const content = await readFile(path.resolve(rootDir, sourceFile), "utf8");
    return sha256Hex(content);
  } catch {
    return sha256Hex(`unreadable:${sourceFile}`);
  }
}

export function uiIntelligencePlugin(options: UiIntelligencePluginOptions): Plugin {
  const privateOutDir = options.privateOutDir ?? DEFAULT_PRIVATE_OUT_DIR;
  const instrumentationVersion = options.instrumentationVersion ?? 1;
  const annotate = options.annotate ?? false;

  let config: ResolvedConfig | undefined;
  let commitSha = "unknown";
  let buildId = "";
  let publicManifest: PublicManifest | undefined;
  let privateManifest: PrivateManifest | undefined;
  const sourceTagged = new Set<string>();

  function computeManifests(): void {
    if (!config) return;
    const rootDir = config.root ?? process.cwd();
    commitSha = resolveCommitSha(rootDir);
    buildId = computeBuildId({
      commitSha,
      configFile: config.configFile,
      inputs: config.build?.rollupOptions?.input ?? null,
    });
    publicManifest = {
      protocolVersion: PROTOCOL_VERSION,
      buildId,
      projectKey: options.projectKey,
      entities: options.entities.map((e) =>
        e.pageKey === undefined
          ? { entityKey: e.entityKey }
          : { entityKey: e.entityKey, pageKey: e.pageKey }
      ),
      adapterCapabilities: ADAPTER_CAPABILITIES,
      runtimeContractRefs: [
        `/${PUBLIC_MANIFEST_FILE}`,
        VIRTUAL_MANIFEST_ID,
      ],
    };
    privateManifest = {
      protocolVersion: PROTOCOL_VERSION,
      buildId,
      commitSha,
      notice:
        "PRIVATE build manifest: contains source file paths and commit SHA. " +
        "Never serve this file publicly; keep it out of version control.",
      entities: [],
    };
    sourceTagged.clear();
    for (const entity of options.entities) {
      if (entity.sourceFile) sourceTagged.add(path.resolve(rootDir, entity.sourceFile));
      void hashFileContent(rootDir, entity.sourceFile, entity.entityKey).then((contentHash) => {
        if (!privateManifest) return;
        const existing = privateManifest.entities.find((e) => e.entityKey === entity.entityKey);
        const entry: PrivateManifestEntity = {
          entityKey: entity.entityKey,
          ...(entity.pageKey === undefined ? {} : { pageKey: entity.pageKey }),
          sourceFile: entity.sourceFile ?? "(unregistered)",
          symbol: entity.symbol ?? "(anonymous)",
          instrumentationVersion,
          contentHash,
        };
        if (existing) Object.assign(existing, entry);
        else privateManifest.entities.push(entry);
      });
    }
  }

  return {
    name: "ui-intelligence",
    enforce: "pre",

    configResolved(resolved) {
      config = resolved;
      computeManifests();
    },

    resolveId(source) {
      if (source === VIRTUAL_MANIFEST_ID) return RESOLVED_VIRTUAL_MANIFEST_ID;
      return null;
    },

    load(id) {
      if (id === RESOLVED_VIRTUAL_MANIFEST_ID) {
        const manifest = publicManifest ?? {
          protocolVersion: PROTOCOL_VERSION,
          buildId: "unknown",
          projectKey: options.projectKey,
          entities: options.entities.map((e) => ({ entityKey: e.entityKey })),
          adapterCapabilities: ADAPTER_CAPABILITIES,
          runtimeContractRefs: [],
        };
        // JSON.parse wrapper prevents bundlers from tree-shaking manifest
        // properties that app code has not read yet.
        return `export default JSON.parse(${JSON.stringify(JSON.stringify(manifest))});\n`;
      }
      return null;
    },

    transform(code, id) {
      if (!annotate) return null;
      const resolvedPath = id.split("?")[0];
      if (!sourceTagged.has(resolvedPath)) return null;
      const entity = options.entities.find(
        (e) => e.sourceFile && path.resolve(config?.root ?? process.cwd(), e.sourceFile) === resolvedPath
      );
      if (!entity) return null;
      return {
        code: `${code}\n/* ui-intelligence: ${entity.entityKey} */\n`,
        map: null,
      };
    },

    generateBundle() {
      if (!publicManifest) return;
      this.emitFile({
        type: "asset",
        fileName: PUBLIC_MANIFEST_FILE,
        source: `${JSON.stringify(publicManifest, null, 2)}\n`,
      });
    },

    async closeBundle() {
      if (!publicManifest || !privateManifest) return;
      privateManifest.entities.sort((a, b) => (a.entityKey < b.entityKey ? -1 : a.entityKey > b.entityKey ? 1 : 0));
      const rootDir = config?.root ?? process.cwd();
      const publicPath = path.resolve(rootDir, config?.build?.outDir ?? "dist", PUBLIC_MANIFEST_FILE);
      const privateDir = path.resolve(rootDir, privateOutDir);
      const privatePath = path.join(privateDir, PRIVATE_MANIFEST_FILE);
      await mkdir(privateDir, { recursive: true });
      await writeFile(privatePath, `${JSON.stringify(privateManifest, null, 2)}\n`, "utf8");
      // eslint-disable-next-line no-console
      console.log(`[ui-intelligence] public manifest:  ${publicPath}`);
      // eslint-disable-next-line no-console
      console.log(
        `[ui-intelligence] private manifest: ${privatePath} (never serve publicly; gitignore by convention)`
      );
    },
  };
}
