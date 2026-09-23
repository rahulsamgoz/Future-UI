/**
 * Deterministic provider (spec section 8 step 3: "Prefer four diverse
 * candidates, not four cosmetically different duplicates"). Produces
 * reproducible, meaningfully varied candidates from a small PRNG.
 */
import type {
  ModelProvider,
  ProviderCandidate,
  ProviderInput,
  ProviderOutput,
} from "./provider.js";
import { fnv1a, mulberry32 } from "./digest.js";

export class DeterministicProvider implements ModelProvider {
  readonly id = "deterministic";

  async generate(input: ProviderInput): Promise<ProviderOutput> {
    const seed = input.seed ?? fnv1a(input.instruction || input.targetContract.entityKey);
    const rand = mulberry32(seed);
    const representations = input.targetContract.allowedRepresentations;
    if (representations.length === 0) {
      return { candidates: [], degraded: "target contract allows no representations" };
    }

    const count = Math.max(1, Math.min(input.requestedCandidateCount, representations.length * 2));
    const historyReferences = input.references.filter((r) => r.kind === "history");
    const candidates: ProviderCandidate[] = [];

    for (let i = 0; i < count; i += 1) {
      const type = representations[i % representations.length];
      const schema = input.rendererSchemas.find((s) => s.id === type)?.propertySchema ?? {};
      const properties: Record<string, unknown> = {};
      for (const [key, prop] of Object.entries(schema)) {
        properties[key] = this.propertyValue(prop, rand);
      }

      const baseName = type.split("@")[0] ?? type;
      const historyMatch = historyReferences.find((r) => r.summary.toLowerCase().includes(baseName.toLowerCase()));
      const originKind = historyMatch
        ? "recorded_history"
        : historyReferences.length > 0
          ? "historical_adaptation"
          : "generated";

      candidates.push({
        type,
        properties,
        originKind,
        summary:
          `${type} variant ${i + 1}` +
          (historyMatch ? ` adapted from history reference "${historyMatch.summary}"` : "") +
          (input.instruction ? ` — ${input.instruction.slice(0, 80)}` : ""),
      });
    }

    return { candidates };
  }

  private propertyValue(
    prop: { type: string; values?: (string | number)[]; min?: number; max?: number; default?: unknown },
    rand: () => number
  ): unknown {
    if (prop.type === "number" || prop.type === "integer") {
      const min = prop.min ?? 0;
      const max = prop.max ?? (prop.min !== undefined ? prop.min + 3 : 10);
      if (max <= min) return min;
      const value = min + Math.floor(rand() * (max - min + 1));
      return prop.type === "integer" ? value : min + rand() * (max - min);
    }
    if (prop.type === "enum" || prop.values) {
      const values = prop.values ?? [];
      if (values.length === 0) return prop.default ?? null;
      return values[Math.floor(rand() * values.length)]!;
    }
    if (prop.type === "boolean") return rand() < 0.5;
    if (prop.default !== undefined) return prop.default;
    return "";
  }
}
