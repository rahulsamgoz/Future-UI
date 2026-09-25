import type { EntityContract } from "@ui-intelligence/protocol";

/**
 * Registered semantic boundaries for the Next.js demo (protocol section 6).
 *
 * SAME entity keys and allowed representations as the Vite reference app
 * (apps/reference-app/src/contracts.ts) — the protocol is framework-neutral,
 * so the demo redeclares the contracts locally rather than importing across
 * apps. A capture/proposal written against the reference app resolves here.
 */

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

export const allEntityContracts: EntityContract[] = [
  productChooserContract,
  buttonContract,
];
