import type { EntityContract, PageContract } from "@ui-intelligence/protocol";

/** Registered semantic boundaries (protocol section 6). */
export const productChooserContract: EntityContract = {
  entityKey: "catalog.productChooser",
  contractVersion: 1,
  dataBinding: "catalog.products@1",
  allowedRepresentations: ["carousel@1", "grid@1", "table@1"],
  actions: ["product.open@1", "cart.add@1"],
  requiredFields: ["product.id", "product.name", "product.price"],
  stateFields: ["selectedProductId", "sortOrder", "filters"],
  constraints: { preserveActions: true, preservePriceVisibility: true, maximumColumns: 4 },
};

export const relatedProductsContract: EntityContract = {
  entityKey: "catalog.relatedProducts",
  contractVersion: 1,
  dataBinding: "catalog.products@1",
  allowedRepresentations: ["carousel@1", "grid@1"],
  actions: ["product.open@1", "cart.add@1"],
  requiredFields: ["product.id", "product.name", "product.price"],
  stateFields: [],
  constraints: { preserveActions: true, preservePriceVisibility: true, maximumColumns: 4 },
};

export const sortControlContract: EntityContract = {
  entityKey: "catalog.sortControl",
  contractVersion: 1,
  dataBinding: "catalog.sortState@1",
  allowedRepresentations: ["sort.select@1", "sort.segments@1"],
  actions: ["catalog.sort@1"],
  requiredFields: ["sortOrder"],
  stateFields: ["sortOrder"],
  constraints: { preserveActions: true, preservePriceVisibility: false },
};

export const profileFormContract: EntityContract = {
  entityKey: "account.profileForm",
  contractVersion: 1,
  dataBinding: "account.profile@1",
  allowedRepresentations: ["form.standard@1", "form.compact@1"],
  actions: ["account.saveProfile@1"],
  requiredFields: ["profile.name", "profile.email"],
  stateFields: ["name", "email", "bio", "dirty"],
  constraints: { preserveActions: true, preservePriceVisibility: false },
};

export const adminPanelContract: EntityContract = {
  entityKey: "account.adminPanel",
  contractVersion: 1,
  dataBinding: "account.adminStats@1",
  allowedRepresentations: ["panel.standard@1"],
  actions: [],
  requiredFields: ["stats.activeUsers", "stats.conversion"],
  stateFields: [],
  constraints: { preserveActions: false, preservePriceVisibility: false },
};

export const transactionListContract: EntityContract = {
  entityKey: "account.transactionList",
  contractVersion: 1,
  dataBinding: "account.transactions@1",
  allowedRepresentations: ["list.virtual@1"],
  actions: [],
  requiredFields: ["transaction.id", "transaction.label", "transaction.amount"],
  stateFields: ["scrollTop"],
  constraints: { preserveActions: false, preservePriceVisibility: false },
};

export const buttonContract: EntityContract = {
  entityKey: "ui.primaryButton",
  contractVersion: 1,
  dataBinding: "ui.label@1",
  allowedRepresentations: ["button.default@1", "button.compact@1"],
  actions: ["ui.action@1"],
  requiredFields: ["label"],
  stateFields: [],
  constraints: { preserveActions: true, preservePriceVisibility: false },
};

/** Page contracts (protocol section 7). */
export const catalogPageContract: PageContract = {
  pageKey: "catalog",
  contractVersion: 1,
  slots: [
    {
      slotId: "chooser",
      entityKey: "catalog.productChooser",
      required: true,
      locked: false,
      repeatable: false,
      compatibleRenderers: ["carousel@1", "grid@1", "table@1"],
    },
    {
      slotId: "sort",
      entityKey: "catalog.sortControl",
      required: true,
      locked: false,
      repeatable: false,
      compatibleRenderers: ["sort.select@1", "sort.segments@1"],
    },
    {
      slotId: "related",
      entityKey: "catalog.relatedProducts",
      required: false,
      locked: false,
      repeatable: false,
      compatibleRenderers: ["carousel@1", "grid@1"],
    },
  ],
  allowedLayouts: ["stack@1", "grid@1", "split@1"],
  maxDepth: 4,
  maxNodes: 16,
};

export const accountPageContract: PageContract = {
  pageKey: "account",
  contractVersion: 1,
  slots: [
    {
      slotId: "profile",
      entityKey: "account.profileForm",
      required: true,
      locked: false,
      repeatable: false,
      compatibleRenderers: ["form.standard@1", "form.compact@1"],
    },
    {
      slotId: "admin",
      entityKey: "account.adminPanel",
      required: true,
      locked: true,
      repeatable: false,
      compatibleRenderers: ["panel.standard@1"],
    },
    {
      slotId: "transactions",
      entityKey: "account.transactionList",
      required: false,
      locked: false,
      repeatable: false,
      compatibleRenderers: ["list.virtual@1"],
    },
  ],
  allowedLayouts: ["stack@1", "split@1", "grid@1"],
  maxDepth: 4,
  maxNodes: 16,
};

export const allEntityContracts: EntityContract[] = [
  productChooserContract,
  relatedProductsContract,
  sortControlContract,
  profileFormContract,
  adminPanelContract,
  transactionListContract,
  buttonContract,
];

export function contractByKey(key: string): EntityContract | undefined {
  return allEntityContracts.find((c) => c.entityKey === key);
}
