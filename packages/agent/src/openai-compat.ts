/**
 * Generic OpenAI-compatible chat-completions provider. Prompts for JSON
 * candidates constrained to the renderer schemas; network errors never throw
 * — they degrade to an empty candidate list with a note.
 */
import type {
  ModelProvider,
  ProviderCandidate,
  ProviderInput,
  ProviderOutput,
} from "./provider.js";
import { DeterministicProvider } from "./deterministic.js";

export type OpenAICompatOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  /**
   * Declared provider capabilities. Vision input is opt-in: image references
   * are attached as image_url content parts ONLY when `capabilities.vision`
   * is true AND the grounded reference carries a fetchable `url`. The default
   * dev model (space-bunny-free) is text-only, so it stays undeclared and the
   * grounded TEXT summary (real observation content) is the deliverable —
   * vision is never faked for text-only providers.
   */
  capabilities?: { vision?: boolean };
};

function stripFences(content: string): string {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (fenced ? fenced[1] : content).trim();
}

export class OpenAICompatProvider implements ModelProvider {
  readonly id = "openai-compat";

  constructor(private readonly options: OpenAICompatOptions) {}

  async generate(input: ProviderInput): Promise<ProviderOutput> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 30_000);
      let response: Response;
      try {
        response = await fetch(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.options.apiKey}`,
          },
          body: JSON.stringify({
            model: this.options.model,
            messages: [
              { role: "system", content: systemPrompt(input) },
              { role: "user", content: this.userContent(input) },
            ],
            temperature: 0.7,
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        return { candidates: [], degraded: `model provider returned HTTP ${response.status}` };
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content ?? "";
      const parsed = parseCandidates(content);
      const conformant = parsed.filter((c) => this.isSchemaConformant(c, input));
      return { candidates: conformant };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { candidates: [], degraded: `model provider unavailable: ${message}` };
    }
  }

  /**
   * Text-first by default. When the provider declares vision AND grounded
   * image references carry fetchable URLs, they are attached as image_url
   * parts after the text prompt (which still carries the grounded summaries).
   */
  private userContent(
    input: ProviderInput
  ): string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> {
    if (!this.options.capabilities?.vision) return userPrompt(input);
    const images = input.references
      .filter((r) => r.kind === "image" && typeof r.url === "string" && r.url.length > 0)
      .map((r) => ({ type: "image_url" as const, image_url: { url: r.url as string } }));
    if (images.length === 0) return userPrompt(input);
    return [{ type: "text", text: userPrompt(input) }, ...images];
  }

  /** Keep only candidates whose type and properties fit the renderer schemas. */
  private isSchemaConformant(candidate: ProviderCandidate, input: ProviderInput): boolean {
    if (typeof candidate.type !== "string" || typeof candidate.properties !== "object" || candidate.properties === null) {
      return false;
    }
    const schema = input.rendererSchemas.find((s) => s.id === candidate.type);
    if (!schema) return false;
    for (const [key, prop] of Object.entries(schema.propertySchema)) {
      const value = candidate.properties[key];
      if (value === undefined) continue;
      if (prop.type === "number" || prop.type === "integer") {
        if (typeof value !== "number" || Number.isNaN(value)) return false;
        if (prop.min !== undefined && value < prop.min) return false;
        if (prop.max !== undefined && value > prop.max) return false;
      } else if (prop.type === "enum" || prop.values) {
        if (prop.values && !prop.values.includes(value as string | number)) return false;
      } else if (prop.type === "boolean" && typeof value !== "boolean") {
        return false;
      }
    }
    return true;
  }
}

function systemPrompt(input: ProviderInput): string {
  const schemas = input.rendererSchemas
    .map((s) => `${s.id}: ${JSON.stringify(s.propertySchema)}`)
    .join("\n");
  return (
    "You propose UI presentation candidates for a registered entity. " +
    "You must only use the allowed representations and stay within the property schemas. " +
    "Respond with JSON only: {\"candidates\":[{\"type\":\"<representation id>\"," +
    "\"properties\":{...},\"summary\":\"...\"}]}.\n" +
    `Allowed representations: ${input.targetContract.allowedRepresentations.join(", ")}\n` +
    `Renderer property schemas:\n${schemas}`
  );
}

function userPrompt(input: ProviderInput): string {
  const references = input.references.map((r) => `- (${r.kind}) ${r.summary}`).join("\n");
  return (
    `Entity: ${input.targetContract.entityKey}\n` +
    `Data binding: ${input.targetContract.dataBinding}\n` +
    `Actions: ${input.targetContract.actions.join(", ")}\n` +
    (input.instruction ? `Instruction: ${input.instruction}\n` : "") +
    (references ? `References:\n${references}\n` : "") +
    `Return ${input.requestedCandidateCount} diverse candidates.`
  );
}

/** Parse the model response, tolerating fenced code blocks. */
export function parseCandidates(content: string): ProviderCandidate[] {
  const raw = stripFences(content);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = (parsed as { candidates?: unknown })?.candidates;
  if (!Array.isArray(list)) return [];
  const out: ProviderCandidate[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.type !== "string" || rec.type.length === 0) continue;
    if (typeof rec.properties !== "object" || rec.properties === null) continue;
    const originKind =
      rec.originKind === "historical_adaptation" || rec.originKind === "recorded_history"
        ? rec.originKind
        : "generated";
    out.push({
      type: rec.type,
      properties: rec.properties as Record<string, unknown>,
      originKind,
      summary: typeof rec.summary === "string" ? rec.summary : "",
    });
  }
  return out;
}

/** Build a provider from the UI_INTEL_MODEL_* environment variables. */
export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): ModelProvider {
  const { UI_INTEL_MODEL_BASE_URL, UI_INTEL_MODEL_API_KEY, UI_INTEL_MODEL_NAME, UI_INTEL_MODEL_VISION } = env;
  if (UI_INTEL_MODEL_BASE_URL && UI_INTEL_MODEL_API_KEY && UI_INTEL_MODEL_NAME) {
    return new OpenAICompatProvider({
      baseUrl: UI_INTEL_MODEL_BASE_URL,
      apiKey: UI_INTEL_MODEL_API_KEY,
      model: UI_INTEL_MODEL_NAME,
      // Vision stays undeclared unless the operator explicitly opts in;
      // space-bunny-free (the dev model) is text-only.
      capabilities: UI_INTEL_MODEL_VISION === "1" || UI_INTEL_MODEL_VISION === "true" ? { vision: true } : undefined,
    });
  }
  // Deterministic provider is the default dev provider (spec section 8).
  return new DeterministicProvider();
}
