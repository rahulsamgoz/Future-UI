/**
 * Small pure-TS helpers shared by the agent package.
 */

/** Deterministic 32-bit FNV-1a hash (seed derivation, identity digests). */
export function fnv1a(input: string, seed = 0x811c9dc5): number {
  let hash = seed | 0;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Non-cryptographic 128-bit identity digest (four FNV-1a variants) over a
 * canonical serialization. Used for validation-report spec digests in the dev
 * profile; it establishes identity, not integrity against an adversary.
 */
export function syncDigest(value: unknown): string {
  const canonical = stableStringify(value);
  const parts = [0x811c9dc5, 0x01000193, 0x9dc5811c, 0xdeadbeef].map((seed) => fnv1a(canonical, seed).toString(16).padStart(8, "0"));
  return parts.join("");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

/** mulberry32 PRNG: small, fast, reproducible from an integer seed. */
export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
