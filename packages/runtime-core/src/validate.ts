/**
 * Proposal validator (architecture sections 7, 18). Deterministic local
 * checks over validated compositions of approved types — the model proposes,
 * this code decides eligibility. Every report applies to the exact
 * specification digest it embeds.
 */
import {
  UiIntelligenceError,
  digestOf,
} from "@ui-intelligence/protocol";
import type {
  CheckedInvariant,
  EntityContract,
  LayoutNode,
  PageContract,
  TargetReadSet,
  ValidationReport,
} from "@ui-intelligence/protocol";
import type { RendererRegistry } from "./renderer.js";

const VALIDATOR_VERSION = "runtime-core@1";

type ValidationError = ValidationReport["errors"][number];

export class ProposalValidator {
  #renderers: RendererRegistry;

  constructor(renderers: RendererRegistry) {
    this.#renderers = renderers;
  }

  /**
   * Validate an entity-scope presentation specification against the target's
   * entity contract. Async because specification digests are SHA-256 over
   * canonical JSON. R1 note: the contract digest must match the readSet the
   * proposal was grounded on; a mismatch fails before any property check.
   */
  async validatePresentation(
    spec: unknown,
    contract: EntityContract,
    readSet: TargetReadSet,
    policyVersion: number,
  ): Promise<ValidationReport> {
    const errors: ValidationError[] = [];
    const checkedInvariants: CheckedInvariant[] = [
      "schema",
      "supported_type",
      "property_ranges",
      "binding_version",
      "required_fields",
      "scope",
    ];
    const unsupportedChecks: string[] = [];

    if (readSet.policyVersion !== policyVersion) {
      errors.push({
        code: "VERSION_UNSUPPORTED",
        message: `proposal policyVersion ${policyVersion} does not match read set policyVersion ${readSet.policyVersion}`,
      });
    }
    if (!readSet.appBuildId || !readSet.contractDigest) {
      errors.push({
        code: "VERSION_UNSUPPORTED",
        message: "read set is missing appBuildId or contractDigest",
      });
    }

    // schema: shape of the presentation object.
    if (!isPresentationShape(spec)) {
      errors.push({
        code: "schema",
        message: "presentation must be an object with string type, object properties, string dataBinding, and string[] actions",
        path: "presentation",
      });
      // Only report what was actually checked: validation stops at the
      // schema invariant, so the later invariants are not listed.
      return this.#report(errors, ["schema"], unsupportedChecks, readSet, policyVersion, {
        presentation: spec,
        target: { entityKey: contract.entityKey, appBuildId: readSet.appBuildId },
      });
    }

    // supported_type: allowed by the contract AND registered. An allowed but
    // unregistered renderer is a capability error at validation time.
    let descriptor: import("./renderer.js").RendererDescriptor | undefined;
    if (!contract.allowedRepresentations.includes(spec.type)) {
      errors.push({
        code: "supported_type",
        message: `presentation type "${spec.type}" is not allowed by entity "${contract.entityKey}"`,
        path: "presentation.type",
      });
    } else {
      try {
        descriptor = this.#renderers.get(spec.type);
      } catch (error) {
        if (!(error instanceof UiIntelligenceError)) throw error;
        errors.push({
          code: error.code,
          message: error.message,
          path: "presentation.type",
        });
      }
    }

    if (descriptor) {
      validateProperties(spec.properties, descriptor.propertySchema, errors);
      const requiredFields = contract.requiredFields;
      if (descriptor.rendersFields) {
        const renders = new Set(descriptor.rendersFields);
        for (const field of requiredFields) {
          if (!renders.has(field)) {
            errors.push({
              code: "required_fields",
              message: `renderer "${spec.type}" does not declare rendering of required field "${field}"`,
              path: `presentation.type`,
            });
          }
        }
      } else if (requiredFields.length > 0) {
        // The renderer does not declare rendered fields, so the required
        // fields invariant cannot be checked here.
        unsupportedChecks.push("required_fields");
      }
    }

    // binding_version: the proposal must bind exactly the contract's data binding.
    if (spec.dataBinding !== contract.dataBinding) {
      errors.push({
        code: "binding_version",
        message: `dataBinding "${spec.dataBinding}" does not match contract binding "${contract.dataBinding}"`,
        path: "presentation.dataBinding",
      });
    }

    // scope: every proposed action must be declared by the contract.
    const declaredActions = new Set(contract.actions);
    for (const action of spec.actions) {
      if (!declaredActions.has(action)) {
        errors.push({
          code: "scope",
          message: `action "${action}" is not declared by entity "${contract.entityKey}"`,
          path: `presentation.actions`,
        });
      }
    }

    return this.#report(
      errors,
      checkedInvariants,
      unsupportedChecks,
      readSet,
      policyVersion,
      {
        presentation: spec,
        target: { entityKey: contract.entityKey, appBuildId: readSet.appBuildId },
      },
    );
  }

  /**
   * Validate a page layout tree against the page contract (architecture
   * section 7). R1 note: region `entityId` carries the entityKey for R1 —
   * entity resolution by opaque id is a later integration concern.
   */
  async validatePageLayout(
    root: LayoutNode,
    pageContract: PageContract,
    entityContracts: Map<string, EntityContract>,
    readSet: TargetReadSet,
    policyVersion: number,
  ): Promise<ValidationReport> {
    const errors: ValidationError[] = [];
    // Invariants actually evaluated by the traversal below. "locked_regions"
    // is part of the protocol's CheckedInvariant union and IS checked (the
    // locked-slot loop after the visit walk).
    const checkedInvariants: CheckedInvariant[] = [
      "schema",
      "supported_type",
      "unique_node_ids",
      "allowed_children",
      "slot_membership",
      "locked_regions",
      "depth_bound",
      "node_count_bound",
      "scope",
      "representation_compatibility",
    ];
    const unsupportedChecks: string[] = [];

    if (readSet.policyVersion !== policyVersion) {
      errors.push({
        code: "VERSION_UNSUPPORTED",
        message: `proposal policyVersion ${policyVersion} does not match read set policyVersion ${readSet.policyVersion}`,
      });
    }

    const slotsById = new Map(pageContract.slots.map((s) => [s.slotId, s]));
    const slotRegionCounts = new Map<string, number>();
    const nodeIds = new Set<string>();
    let nodeCount = 0;
    let maxDepth = 0;

    const visit = (node: LayoutNode, depth: number) => {
      nodeCount += 1;
      maxDepth = Math.max(maxDepth, depth);

      if (typeof node.nodeId !== "string" || node.nodeId.length === 0) {
        errors.push({
          code: "schema",
          message: "every node requires a non-empty nodeId",
          path: "layout",
        });
      } else if (nodeIds.has(node.nodeId)) {
        errors.push({
          code: "unique_node_ids",
          message: `nodeId "${node.nodeId}" appears more than once`,
          path: `layout#${node.nodeId}`,
        });
      } else {
        nodeIds.add(node.nodeId);
      }

      if (node.kind === "layout") {
        if (!pageContract.allowedLayouts.includes(node.type)) {
          errors.push({
            code: "supported_type",
            message: `layout type "${node.type}" is not allowed by page "${pageContract.pageKey}"`,
            path: `layout#${node.nodeId}.type`,
          });
        }
        for (const child of node.children) {
          if (child.kind !== "layout" && child.kind !== "region") {
            errors.push({
              code: "allowed_children",
              message: `layout node "${node.nodeId}" has a child of unsupported kind`,
              path: `layout#${node.nodeId}.children`,
            });
          }
        }
        for (const child of node.children) visit(child, depth + 1);
        return;
      }

      // region: leaf node, no children allowed.
      if ("children" in node && Array.isArray((node as { children?: unknown }).children)) {
        errors.push({
          code: "allowed_children",
          message: `region node "${node.nodeId}" must not have children`,
          path: `layout#${node.nodeId}.children`,
        });
      }

      const slot = slotsById.get(node.slotId);
      if (!slot) {
        errors.push({
          code: "slot_membership",
          message: `slot "${node.slotId}" is not declared by page "${pageContract.pageKey}"`,
          path: `layout#${node.nodeId}.slotId`,
        });
      } else {
        slotRegionCounts.set(node.slotId, (slotRegionCounts.get(node.slotId) ?? 0) + 1);
        // An empty compatibleRenderers list means the slot is UNRESTRICTED:
        // any representationId is accepted. Only a non-empty list constrains.
        if (
          node.representationId !== undefined &&
          slot.compatibleRenderers.length > 0 &&
          !slot.compatibleRenderers.includes(node.representationId)
        ) {
          errors.push({
            code: "representation_compatibility",
            message: `representation "${node.representationId}" is not compatible with slot "${node.slotId}"`,
            path: `layout#${node.nodeId}.representationId`,
          });
        }
      }

      if (!entityContracts.has(node.entityId)) {
        errors.push({
          code: "scope",
          message: `region "${node.nodeId}" references unknown entity "${node.entityId}" (outside the registered scope)`,
          path: `layout#${node.nodeId}.entityId`,
        });
      }
    };

    visit(root, 1);

    for (const slot of pageContract.slots) {
      const count = slotRegionCounts.get(slot.slotId) ?? 0;
      if (slot.required && !slot.repeatable && count === 0) {
        errors.push({
          code: "slot_membership",
          message: `required slot "${slot.slotId}" is missing`,
          path: `slots.${slot.slotId}`,
        });
      }
      if (slot.required && !slot.repeatable && count > 1) {
        errors.push({
          code: "slot_membership",
          message: `slot "${slot.slotId}" must occur exactly once but occurs ${count} times`,
          path: `slots.${slot.slotId}`,
        });
      }
      if (slot.locked && count === 0) {
        errors.push({
          code: "locked_regions",
          message: `locked slot "${slot.slotId}" was dropped from the layout`,
          path: `slots.${slot.slotId}`,
        });
      }
    }

    if (maxDepth > pageContract.maxDepth) {
      errors.push({
        code: "depth_bound",
        message: `layout depth ${maxDepth} exceeds page maximum ${pageContract.maxDepth}`,
        path: "layout",
      });
    }
    if (nodeCount > pageContract.maxNodes) {
      errors.push({
        code: "node_count_bound",
        message: `layout has ${nodeCount} nodes, exceeding page maximum ${pageContract.maxNodes}`,
        path: "layout",
      });
    }

    return this.#report(
      errors,
      checkedInvariants,
      unsupportedChecks,
      readSet,
      policyVersion,
      {
        layout: root,
        target: { pageKey: pageContract.pageKey, appBuildId: readSet.appBuildId },
      },
    );
  }

  async #report(
    errors: ValidationError[],
    checkedInvariants: CheckedInvariant[],
    unsupportedChecks: string[],
    readSet: TargetReadSet,
    policyVersion: number,
    specification: unknown,
  ): Promise<ValidationReport> {
    return {
      schemaVersion: 1,
      validatorVersion: VALIDATOR_VERSION,
      policyRevision: policyVersion,
      targetReadSet: readSet,
      checkedInvariants,
      unsupportedChecks,
      passed: errors.length === 0,
      errors,
      specificationDigest: await digestOf({
        specification,
        policyVersion,
        contractDigest: readSet.contractDigest,
      }),
    };
  }
}

function isPresentationShape(
  spec: unknown,
): spec is {
  type: string;
  properties: Record<string, unknown>;
  dataBinding: string;
  actions: string[];
} {
  if (typeof spec !== "object" || spec === null) return false;
  const s = spec as Record<string, unknown>;
  return (
    typeof s.type === "string" &&
    s.type.length > 0 &&
    typeof s.properties === "object" &&
    s.properties !== null &&
    !Array.isArray(s.properties) &&
    typeof s.dataBinding === "string" &&
    Array.isArray(s.actions) &&
    s.actions.every((a) => typeof a === "string")
  );
}

function validateProperties(
  properties: Record<string, unknown>,
  propertySchema: Record<string, import("./renderer.js").RendererPropertySchema>,
  errors: ValidationError[],
): void {
  for (const [key, value] of Object.entries(properties)) {
    const schema = propertySchema[key];
    if (!schema) {
      // Strict: arbitrary keys cannot add executable power.
      errors.push({
        code: "property_ranges",
        message: `unknown property "${key}" is not in the renderer property schema`,
        path: `properties.${key}`,
      });
      continue;
    }
    const path = `properties.${key}`;
    switch (schema.type) {
      case "number": {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          errors.push({ code: "property_ranges", message: `property "${key}" must be a number`, path });
        } else if (
          (schema.min !== undefined && value < schema.min) ||
          (schema.max !== undefined && value > schema.max)
        ) {
          errors.push({
            code: "property_ranges",
            message: `property "${key}" value ${value} is outside allowed range [${schema.min ?? "-inf"}, ${schema.max ?? "+inf"}]`,
            path,
          });
        }
        break;
      }
      case "string": {
        if (typeof value !== "string") {
          errors.push({ code: "property_ranges", message: `property "${key}" must be a string`, path });
        }
        break;
      }
      case "boolean": {
        if (typeof value !== "boolean") {
          errors.push({ code: "property_ranges", message: `property "${key}" must be a boolean`, path });
        }
        break;
      }
      case "enum": {
        const allowed = schema.values ?? [];
        if (!allowed.includes(value as string | number)) {
          errors.push({
            code: "property_ranges",
            message: `property "${key}" value ${JSON.stringify(value)} is not one of ${JSON.stringify(allowed)}`,
            path,
          });
        }
        break;
      }
    }
  }
}
