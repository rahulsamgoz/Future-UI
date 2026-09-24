/** Minimal argv parsing for the ui-intelligence CLI (no commander). */

export type ParsedArgs = {
  /** Positional tokens, e.g. ["history", "plan"]. */
  command: string[];
  /** Flags without the leading "--", e.g. { window: "6mo", force: true }. */
  flags: Record<string, string | boolean>;
};

export function parseArgv(argv: string[]): ParsedArgs {
  const command: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[body] = next;
          i += 1;
        } else {
          flags[body] = true;
        }
      }
    } else {
      command.push(token);
    }
    i += 1;
  }
  return { command, flags };
}

export function flagString(flags: Record<string, string | boolean>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

export function flagBool(flags: Record<string, string | boolean>, name: string): boolean {
  return flags[name] === true || flags[name] === "true";
}

export function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
