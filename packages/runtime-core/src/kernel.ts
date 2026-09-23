/**
 * Runtime kernel (architecture sections 6, 9, 18): holds entity contracts,
 * page contracts, the renderer registry, and the instance registry, and
 * derives the public runtime manifest and target read sets.
 */
import {
  UiIntelligenceError,
  digestOf,
  newId,
} from "@ui-intelligence/protocol";
import type {
  ActionBinding,
  AdapterCapabilities,
  DataBinding,
  EntityContract,
  PageContract,
  RuntimeManifest,
  StateAdapter,
  TargetReadSet,
} from "@ui-intelligence/protocol";
import type { InstanceRegistry } from "./instance.js";
import type { RendererRegistry } from "./renderer.js";

export type EntityBindings = {
  data: DataBinding;
  actions: Record<string, ActionBinding>;
  state?: StateAdapter;
};

export type RuntimeKernelOptions = {
  buildId: string;
  adapterCapabilities?: Partial<AdapterCapabilities>;
};

const DEFAULT_ADAPTER_CAPABILITIES: AdapterCapabilities = {
  observation: true,
  sourceLinking: false,
  tokenOverrides: true,
  representationReplacement: true,
  composition: true,
  stateTransfer: true,
  historicalExecution: false,
};

export class RuntimeKernel {
  readonly renderers: RendererRegistry;
  readonly instances: InstanceRegistry;
  readonly buildId: string;
  readonly adapterCapabilities: AdapterCapabilities;

  #entities = new Map<string, { contract: EntityContract; bindings: EntityBindings }>();
  #pages = new Map<string, PageContract>();

  constructor(
    renderers: RendererRegistry,
    instances: InstanceRegistry,
    options: RuntimeKernelOptions,
  ) {
    this.renderers = renderers;
    this.instances = instances;
    this.buildId = options.buildId;
    this.adapterCapabilities = {
      ...DEFAULT_ADAPTER_CAPABILITIES,
      ...options.adapterCapabilities,
    };
  }

  /**
   * Register a semantic boundary. A duplicate entityKey is a configuration
   * error, never grounds for merging entities (architecture section 4).
   * For R1 the entityId equals the entityKey; stable keys are project-scoped.
   */
  registerEntity(
    contract: EntityContract,
    bindings: EntityBindings,
  ): { entityId: string } {
    if (this.#entities.has(contract.entityKey)) {
      throw new UiIntelligenceError(
        "SCHEMA_INVALID",
        `entityKey "${contract.entityKey}" is already registered; key collisions are configuration errors and are never merged`,
      );
    }
    this.#entities.set(contract.entityKey, { contract, bindings });
    return { entityId: contract.entityKey };
  }

  registerPage(contract: PageContract): void {
    if (this.#pages.has(contract.pageKey)) {
      throw new UiIntelligenceError(
        "SCHEMA_INVALID",
        `pageKey "${contract.pageKey}" is already registered`,
      );
    }
    this.#pages.set(contract.pageKey, contract);
  }

  getEntity(
    entityKey: string,
  ): { contract: EntityContract; bindings: EntityBindings } | undefined {
    return this.#entities.get(entityKey);
  }

  listEntities(): Array<{ contract: EntityContract; bindings: EntityBindings }> {
    return [...this.#entities.values()];
  }

  getPage(pageKey: string): PageContract | undefined {
    return this.#pages.get(pageKey);
  }

  listPages(): PageContract[] {
    return [...this.#pages.values()];
  }

  /** Public manifest: references only, no executable content. */
  async manifest(): Promise<RuntimeManifest> {
    const rendererVersions: Record<string, number> = {};
    for (const descriptor of this.renderers.list()) {
      rendererVersions[descriptor.id] = descriptor.version;
    }
    return {
      protocolVersion: 1,
      rendererVersions,
      adapterCapabilities: this.adapterCapabilities,
      entities: [...this.#entities.values()].map(({ contract }) => ({
        entityKey: contract.entityKey,
        contractVersion: contract.contractVersion,
        allowedRepresentations: [...contract.allowedRepresentations],
        dataBinding: contract.dataBinding,
        actions: [...contract.actions],
      })),
      pages: [...this.#pages.values()].map((page) => ({
        pageKey: page.pageKey,
        contractVersion: page.contractVersion,
        slots: page.slots.map((slot) => slot.slotId),
      })),
      buildId: this.buildId,
      contractDigest: await this.contractDigest(),
    };
  }

  /** Digest over the canonical registration data (contracts only, no bindings). */
  async contractDigest(): Promise<string> {
    return digestOf({
      entities: [...this.#entities.values()]
        .map(({ contract }) => contract)
        .sort((a, b) => (a.entityKey < b.entityKey ? -1 : 1)),
      pages: [...this.#pages.values()].sort((a, b) =>
        a.pageKey < b.pageKey ? -1 : 1,
      ),
    });
  }

  /** Current read set for a target: build, contract digest, policy, revisions. */
  async currentReadSet(
    targetEntityKey: string,
    policyVersion: number,
    preferenceRevision = 0,
  ): Promise<TargetReadSet> {
    const entityVersions: Record<string, string> = {};
    const registration = this.#entities.get(targetEntityKey);
    if (registration) {
      entityVersions[targetEntityKey] = `${targetEntityKey}@${registration.contract.contractVersion}`;
    }
    return {
      appBuildId: this.buildId,
      contractDigest: await this.contractDigest(),
      policyVersion,
      preferenceRevision,
      entityVersions,
    };
  }

  /** Allocate a new runtime instance id for a mounted occurrence. */
  newRuntimeInstanceId(): string {
    return newId("rtinst");
  }
}
