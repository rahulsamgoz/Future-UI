/**
 * Built-in specification validator implementing the protocol's
 * VariantValidator port semantics (spec section 8 step 4: deterministic
 * server checks decide eligibility; the provider is never trusted).
 */
import {
  proposalSchema,
  presentationSchema,
  type CheckedInvariant,
  type TargetReadSet,
  type ValidationReport,
} from "@ui-intelligence/protocol";
import type { RendererPropertySchema } from "./provider.js";
import { syncDigest } from "./digest.js";

export type SpecValidatorOptions = {
  /** Approved representation ids for the target entity, e.g. ["grid@1"]. */
  allowedRepresentations: string[];
  /** Property schemas per representation id. */
  propertySchemas: Record<string, Record<string, RendererPropertySchema>>;
  /** Expected data binding reference, e.g. "catalog.products@1". */
  dataBinding?: string;
  /** Approved action references; candidates may not introduce new actions. */
  allowedActions?: string[];
};

export class SpecValidator {
  static readonly VALIDATOR_VERSION = "spec-validator@1";
  readonly version = SpecValidator.VALIDATOR_VERSION;

  constructor(private readonly options: SpecValidatorOptions) {}

  validate(spec: unknown, readSet: TargetReadSet, policyVersion: number): ValidationReport {
    const errors: Array<{ code: string; message: string; path?: string }> = [];
    const checked: CheckedInvariant[] = [];

    const envelope = proposalSchema.safeParse(spec);
    checked.push("schema");
    if (!envelope.success) {
      for (const issue of envelope.error.issues) {
        errors.push({
          code: "schema_invalid",
          message: issue.message,
          path: issue.path.map(String).join("."),
        });
      }
      return this.report(errors, checked, readSet, policyVersion, spec);
    }

    const parsed = envelope.data;

    // Scope: entity-scope proposals must point at a version in the read set.
    checked.push("scope");
    if (parsed.target.scope !== "entity") {
      errors.push({ code: "scope_unsupported", message: `scope "${parsed.target.scope}" is not supported in R1 validation`, path: "target.scope" });
    }
    if (readSet.entityVersions[parsed.target.entityId] !== parsed.target.entityVersionId) {
      errors.push({
        code: "stale_target",
        message: "target entity version is not in the current read set",
        path: "target.entityVersionId",
      });
    }

    const presentation = presentationSchema.safeParse(parsed.presentation);
    checked.push("schema");
    if (!presentation.success) {
      for (const issue of presentation.error.issues) {
        errors.push({
          code: "presentation_invalid",
          message: issue.message,
          path: `presentation.${issue.path.map(String).join(".")}`,
        });
      }
      return this.report(errors, checked, readSet, policyVersion, spec);
    }

    const pres = presentation.data;

    // Supported type: the provider cannot expand the authorized target.
    checked.push("supported_type");
    if (!this.options.allowedRepresentations.includes(pres.type)) {
      errors.push({
        code: "unsupported_type",
        message: `representation "${pres.type}" is not approved for this entity`,
        path: "presentation.type",
      });
    } else {
      checked.push("property_ranges");
      const schema = this.options.propertySchemas[pres.type] ?? {};
      for (const [key, prop] of Object.entries(schema)) {
        const value = pres.properties[key];
        const error = checkProperty(key, prop, value);
        if (error) errors.push({ code: "property_range", message: error, path: `presentation.properties.${key}` });
      }
      // Strict properties: any key NOT declared in the renderer schema is
      // rejected, so provider-injected extra keys (style, html, handlers...)
      // can never pass validation. Mirrors runtime-core's validator.
      for (const key of Object.keys(pres.properties)) {
        if (!(key in schema)) {
          errors.push({
            code: "property_range",
            message: `unknown property "${key}" is not in the renderer schema`,
            path: `presentation.properties.${key}`,
          });
        }
      }
    }

    // Binding version: candidates must use the entity's declared binding.
    checked.push("binding_version");
    if (this.options.dataBinding && pres.dataBinding !== this.options.dataBinding) {
      errors.push({
        code: "binding_mismatch",
        message: `data binding "${pres.dataBinding}" does not match contract "${this.options.dataBinding}"`,
        path: "presentation.dataBinding",
      });
    }

    // Actions: no invented permissions from action names.
    checked.push("required_fields");
    if (this.options.allowedActions) {
      for (const action of pres.actions) {
        if (!this.options.allowedActions.includes(action)) {
          errors.push({
            code: "unauthorized_action",
            message: `action "${action}" is not in the entity contract`,
            path: "presentation.actions",
          });
        }
      }
    }

    return this.report(errors, checked, readSet, policyVersion, spec);
  }

  private report(
    errors: Array<{ code: string; message: string; path?: string }>,
    checked: CheckedInvariant[],
    readSet: TargetReadSet,
    policyVersion: number,
    spec: unknown
  ): ValidationReport {
    return {
      schemaVersion: 1,
      validatorVersion: this.version,
      policyRevision: policyVersion,
      targetReadSet: readSet,
      checkedInvariants: checked,
      unsupportedChecks: [],
      passed: errors.length === 0,
      errors,
      specificationDigest: syncDigest(spec),
    };
  }
}

function checkProperty(key: string, prop: RendererPropertySchema, value: unknown): string | null {
  if (value === undefined) return null; // absence falls back to renderer default
  if (prop.type === "number" || prop.type === "integer") {
    if (typeof value !== "number" || Number.isNaN(value)) return `property "${key}" must be a number`;
    if (prop.min !== undefined && value < prop.min) return `property "${key}" is below the minimum ${prop.min}`;
    if (prop.max !== undefined && value > prop.max) return `property "${key}" is above the maximum ${prop.max}`;
    return null;
  }
  if (prop.type === "enum" || prop.values) {
    if (prop.values && !prop.values.includes(value as string | number)) {
      return `property "${key}" must be one of: ${prop.values!.join(", ")}`;
    }
    return null;
  }
  if (prop.type === "boolean" && typeof value !== "boolean") {
    return `property "${key}" must be a boolean`;
  }
  return null;
}
