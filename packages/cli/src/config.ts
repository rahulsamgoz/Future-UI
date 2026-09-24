/** Local CLI configuration stored in .ui-intelligence/config.json under cwd. */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export type Config = {
  projectKey: string;
  projectId: string;
  apiBaseUrl: string;
  token: string;
  repository: string;
  devUrl?: string;
  createdAt: string;
};

export function configPath(cwd: string): string {
  return path.join(cwd, ".ui-intelligence", "config.json");
}

export async function loadConfig(cwd: string): Promise<Config | null> {
  try {
    const raw = await readFile(configPath(cwd), "utf8");
    return JSON.parse(raw) as Config;
  } catch {
    return null;
  }
}

export type InitOptions = {
  project: string;
  api: string;
  repo: string;
  force?: boolean;
  /** Defaults to env UI_INTELLIGENCE_TOKEN. */
  token?: string;
  devUrl?: string;
  now?: Date;
};

export async function initConfig(
  cwd: string,
  options: InitOptions
): Promise<{ config: Config; configPath: string; created: boolean }> {
  const filePath = configPath(cwd);
  const exists = await stat(filePath)
    .then(() => true)
    .catch(() => false);
  if (exists && !options.force) {
    throw new Error(`config already exists at ${filePath}; pass --force to overwrite`);
  }
  const config: Config = {
    projectKey: options.project,
    projectId: options.project,
    apiBaseUrl: options.api,
    token: options.token ?? process.env.UI_INTELLIGENCE_TOKEN ?? "",
    repository: options.repo,
    devUrl: options.devUrl,
    createdAt: (options.now ?? new Date()).toISOString(),
  };
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return { config, configPath: filePath, created: true };
}
