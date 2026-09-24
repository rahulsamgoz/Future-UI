import type { EntityContract } from "@ui-intelligence/protocol";
import type { RendererDescriptor } from "@ui-intelligence/runtime-core";
import type { ComponentType } from "react";
import type { RendererProps } from "@ui-intelligence/react";
import { SortSelect, SortSegments } from "./Sort.js";
import { FormStandard, FormCompact } from "./Form.js";
import { PanelStandard } from "./Panel.js";
import { ListVirtual } from "./VirtualList.js";
import { ButtonDefault, ButtonCompact } from "./Button.js";

const catalogEntities = ["catalog.sortControl"];

export const appRendererDescriptors: RendererDescriptor[] = [
  {
    id: "sort.select@1",
    version: 1,
    propertySchema: { align: { type: "enum", values: ["left", "right"], default: "left" } },
    compatibleWith: (c: EntityContract) => catalogEntities.includes(c.entityKey),
    rendersFields: ["sortOrder"],
  },
  {
    id: "sort.segments@1",
    version: 1,
    propertySchema: { align: { type: "enum", values: ["left", "right"], default: "left" } },
    compatibleWith: (c: EntityContract) => catalogEntities.includes(c.entityKey),
    rendersFields: ["sortOrder"],
  },
  {
    id: "form.standard@1",
    version: 1,
    propertySchema: { showBio: { type: "boolean", default: true } },
    compatibleWith: (c: EntityContract) => c.entityKey === "account.profileForm",
    rendersFields: ["profile.name", "profile.email"],
  },
  {
    id: "form.compact@1",
    version: 1,
    propertySchema: { showBio: { type: "boolean", default: false } },
    compatibleWith: (c: EntityContract) => c.entityKey === "account.profileForm",
    rendersFields: ["profile.name", "profile.email"],
  },
  {
    id: "panel.standard@1",
    version: 1,
    propertySchema: { emphasis: { type: "enum", values: ["normal", "high"], default: "normal" } },
    compatibleWith: (c: EntityContract) => c.entityKey === "account.adminPanel",
    rendersFields: ["stats.activeUsers", "stats.conversion"],
  },
  {
    id: "list.virtual@1",
    version: 1,
    propertySchema: { rowHeight: { type: "number", min: 32, max: 96, default: 48 } },
    compatibleWith: (c: EntityContract) => c.entityKey === "account.transactionList",
    rendersFields: ["transaction.id", "transaction.label", "transaction.amount"],
  },
  {
    id: "button.default@1",
    version: 1,
    propertySchema: {
      label: { type: "string", default: "" },
      variant: { type: "enum", values: ["default", "compact"], default: "default" },
    },
    compatibleWith: (c: EntityContract) => c.entityKey === "ui.primaryButton",
    rendersFields: ["label"],
  },
  {
    id: "button.compact@1",
    version: 1,
    propertySchema: {
      label: { type: "string", default: "" },
      variant: { type: "enum", values: ["default", "compact"], default: "compact" },
    },
    compatibleWith: (c: EntityContract) => c.entityKey === "ui.primaryButton",
    rendersFields: ["label"],
  },
];

export const appRendererComponents: Record<string, ComponentType<RendererProps>> = {
  "sort.select@1": SortSelect,
  "sort.segments@1": SortSegments,
  "form.standard@1": FormStandard,
  "form.compact@1": FormCompact,
  "panel.standard@1": PanelStandard,
  "list.virtual@1": ListVirtual,
  "button.default@1": ButtonDefault,
  "button.compact@1": ButtonCompact,
};
