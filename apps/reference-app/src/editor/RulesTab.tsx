import { useState } from "react";
import type { JsonValue, SemanticRule } from "@ui-intelligence/protocol";
import { newId } from "@ui-intelligence/protocol";
import { useAppServices } from "../Services.js";
import { allEntityContracts } from "../contracts.js";

type ViewportChoice = "any" | "desktop" | "mobile";
type RouteChoice = "any" | "catalog" | "account";

const COMPACT_REPRESENTATION = "button.compact@1";

/**
 * Rules tab (R2 part C): create/list/enable/disable/delete persistent
 * semantic rules from validated dropdowns. Rules are hints — they never
 * override an explicit personal preference.
 */
export function RulesTab() {
  const { preferences } = useAppServices();
  const [rules, setRules] = useState<SemanticRule[]>(() => preferences.rules.list());
  const [name, setName] = useState("");
  const [entityKey, setEntityKey] = useState(allEntityContracts[0]!.entityKey);
  const [representation, setRepresentation] = useState(
    allEntityContracts[0]!.allowedRepresentations[0]!,
  );
  const [viewportClass, setViewportClass] = useState<ViewportChoice>("any");
  const [route, setRoute] = useState<RouteChoice>("any");
  const [compact, setCompact] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  function selectEntity(next: string) {
    setEntityKey(next);
    const contract = allEntityContracts.find((c) => c.entityKey === next);
    setRepresentation(contract?.allowedRepresentations[0] ?? "");
    setCompact(false);
  }

  async function persist(rules: SemanticRule[]) {
    await preferences.setRules(rules);
    setRules(preferences.rules.list());
  }

  async function createRule(e: React.FormEvent) {
    e.preventDefault();
    const contract = allEntityContracts.find((c) => c.entityKey === entityKey);
    if (!contract || !representation) {
      setStatus("Choose an entity and representation.");
      return;
    }
    if (!contract.allowedRepresentations.includes(representation)) {
      setStatus(`"${representation}" is not allowed for ${entityKey}.`);
      return;
    }
    const properties: Record<string, JsonValue> =
      representation === COMPACT_REPRESENTATION && compact ? { variant: "compact" } : {};
    const rule: SemanticRule = {
      ruleId: newId("rule"),
      version: 1,
      name: name.trim() || `${entityKey} → ${representation}`,
      enabled: true,
      conditions: {
        ...(route === "any" ? {} : { route }),
        ...(viewportClass === "any" ? {} : { viewportClass }),
        entityKey,
      },
      action: { representation, properties },
      contractVersion: contract.contractVersion,
      createdAt: new Date().toISOString(),
    };
    try {
      await persist([...rules, rule]);
      setStatus("Rule created.");
      setName("");
      setCompact(false);
    } catch (error) {
      setStatus(`Could not save rule: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function toggleRule(rule: SemanticRule) {
    try {
      await persist(rules.map((r) => (r.ruleId === rule.ruleId ? { ...r, enabled: !r.enabled } : r)));
      setStatus(rule.enabled ? "Rule disabled." : "Rule enabled.");
    } catch (error) {
      setStatus(`Could not update rule: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function deleteRule(rule: SemanticRule) {
    try {
      await persist(rules.filter((r) => r.ruleId !== rule.ruleId));
      setStatus("Rule deleted.");
    } catch (error) {
      setStatus(`Could not delete rule: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return (
    <div data-testid="rules-panel">
      <p className="muted small">
        Rules are hints: explicit preferences win, then rules (later rules win), then the contract
        default. Rules never override your explicit choices.
      </p>

      <form className="rule-form" onSubmit={(e) => void createRule(e)} data-testid="rule-create">
        <label className="field">
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. compact on mobile"
            data-testid="rule-name"
          />
        </label>
        <label className="field">
          Entity
          <select value={entityKey} onChange={(e) => selectEntity(e.target.value)} data-testid="rule-entity">
            {allEntityContracts.map((c) => (
              <option key={c.entityKey} value={c.entityKey}>
                {c.entityKey}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Representation
          <select
            value={representation}
            onChange={(e) => setRepresentation(e.target.value)}
            data-testid="rule-representation"
          >
            {(allEntityContracts.find((c) => c.entityKey === entityKey)?.allowedRepresentations ?? []).map(
              (r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ),
            )}
          </select>
        </label>
        <label className="field">
          Viewport
          <select
            value={viewportClass}
            onChange={(e) => setViewportClass(e.target.value as ViewportChoice)}
            data-testid="rule-viewport"
          >
            <option value="any">any</option>
            <option value="desktop">desktop</option>
            <option value="mobile">mobile</option>
          </select>
        </label>
        <label className="field">
          Route
          <select
            value={route}
            onChange={(e) => setRoute(e.target.value as RouteChoice)}
            data-testid="rule-route"
          >
            <option value="any">any</option>
            <option value="catalog">catalog</option>
            <option value="account">account</option>
          </select>
        </label>
        {representation === COMPACT_REPRESENTATION && (
          <label className="field">
            <input
              type="checkbox"
              checked={compact}
              onChange={(e) => setCompact(e.target.checked)}
              data-testid="rule-compact"
            />{" "}
            compact variant
          </label>
        )}
        <button type="submit" className="btn primary" data-testid="rule-submit">
          Create rule
        </button>
      </form>

      {status && <div className="editor-status" data-testid="rules-status">{status}</div>}

      <ul className="rule-list" data-testid="rule-list">
        {rules.length === 0 && <li className="muted small">No rules yet.</li>}
        {rules.map((rule) => (
          <li key={rule.ruleId} className="rule-item" data-testid="rule-item">
            <div className="candidate-head">
              <strong>{rule.name}</strong>
              <span className={`origin ${rule.enabled ? "origin-history" : ""}`}>
                {rule.enabled ? "enabled" : "disabled"}
              </span>
            </div>
            <div className="muted small">
              when:{" "}
              {[
                rule.conditions.route ? `route ${rule.conditions.route}` : null,
                rule.conditions.viewportClass ? `${rule.conditions.viewportClass} viewport` : null,
                rule.conditions.entityKey ? rule.conditions.entityKey : null,
              ]
                .filter(Boolean)
                .join(", ") || "always"}
            </div>
            <div className="muted small">
              then: {rule.action.representation}{" "}
              {Object.keys(rule.action.properties).length > 0 &&
                `(${JSON.stringify(rule.action.properties)})`}
            </div>
            <div className="candidate-actions">
              <button className="btn small" onClick={() => void toggleRule(rule)} data-testid="rule-toggle">
                {rule.enabled ? "Disable" : "Enable"}
              </button>
              <button className="btn small danger" onClick={() => void deleteRule(rule)} data-testid="rule-delete">
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
