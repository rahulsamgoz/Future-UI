import { newId } from "@ui-intelligence/protocol";
import type { RendererProps } from "@ui-intelligence/react";

/**
 * Registered primary button presentations. The app owns the action wiring so
 * the live action binding is always a host function, never spec text.
 */
function renderButton(props: RendererProps, variant: "default" | "compact") {
  const label =
    (props.properties.label as string) ||
    ((props.data.value as { label?: string })?.label ?? "Button");
  const action = props.actions["ui.action@1"];
  return (
    <button
      type="button"
      className={`btn primary ${variant}`}
      data-testid="primary-button"
      onClick={() => {
        void action?.invoke({ label }, { invocationId: newId("inv"), signal: new AbortController().signal });
      }}
    >
      {label}
    </button>
  );
}

export function ButtonDefault(props: RendererProps) {
  return renderButton(props, "default");
}

export function ButtonCompact(props: RendererProps) {
  return renderButton(props, "compact");
}
