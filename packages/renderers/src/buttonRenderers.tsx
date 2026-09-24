/**
 * Approved button presentations (spec section 7): button.default@1 and
 * button.compact@1 share one presentational component whose `variant`
 * property selects the class. Compatible with any generic label contract
 * whose allowed representations include the renderer id.
 */
import type { EntityContract, JsonValue } from "@ui-intelligence/protocol";
import { invokeAction } from "./productRenderers.js";
import type { RendererEntry, RendererProps } from "./types.js";

function labelFromData(value: JsonValue): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const label = (value as Record<string, JsonValue>).label;
    if (typeof label === "string") return label;
  }
  return null;
}

export function ButtonRenderer({
  contract,
  data,
  actions,
  properties,
  onActionComplete,
}: RendererProps) {
  const label =
    typeof properties.label === "string" ? properties.label : (labelFromData(data.value) ?? "Button");
  const variant = properties.variant === "compact" ? "compact" : "default";
  const primaryAction = contract.actions[0];

  const handleClick = () => {
    if (!primaryAction) return;
    void invokeAction(actions, primaryAction, {}, data, onActionComplete);
  };

  return (
    <button type="button" className={`ui-btn ui-btn--${variant}`} onClick={handleClick} style={{ cursor: "pointer" }}>
      {label}
    </button>
  );
}

function buttonCompatible(representationId: string) {
  return (contract: EntityContract): boolean => contract.allowedRepresentations.includes(representationId);
}

export const buttonRenderers: Record<string, RendererEntry> = {
  "button.default@1": {
    component: ButtonRenderer,
    descriptor: {
      id: "button.default@1",
      version: 1,
      propertySchema: {
        label: { type: "string", default: "Button" },
        variant: { type: "enum", values: ["default", "compact"], default: "default" },
      },
      compatibleWith: buttonCompatible("button.default@1"),
    },
  },
  "button.compact@1": {
    component: ButtonRenderer,
    descriptor: {
      id: "button.compact@1",
      version: 1,
      propertySchema: {
        label: { type: "string", default: "Button" },
        variant: { type: "enum", values: ["default", "compact"], default: "compact" },
      },
      compatibleWith: buttonCompatible("button.compact@1"),
    },
  },
};
