let cached: string | null = null;

/** Build identity. Set from the Vite plugin's virtual manifest when available. */
export function getBuildId(): string {
  if (cached) return cached;
  cached =
    (globalThis as { __UI_INTEL_BUILD_ID__?: string }).__UI_INTEL_BUILD_ID__ ?? "dev-build-local";
  return cached;
}

export async function loadBuildId(): Promise<void> {
  try {
    const specifier = "virtual:ui-intelligence/manifest";
    const manifest = (await import(/* @vite-ignore */ specifier)) as { buildId?: string };
    if (manifest?.buildId) {
      (globalThis as { __UI_INTEL_BUILD_ID__?: string }).__UI_INTEL_BUILD_ID__ = manifest.buildId;
      cached = null;
    }
  } catch {
    // Not running under the Vite plugin (tests, plain node) — keep local fallback.
  }
}
