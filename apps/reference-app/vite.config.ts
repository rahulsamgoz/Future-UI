import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { uiIntelligencePlugin } from "@ui-intelligence/vite";

export default defineConfig({
  plugins: [
    react(),
    uiIntelligencePlugin({
      projectKey: "reference-app",
      entities: [
        { entityKey: "catalog.productChooser", sourceFile: "src/features/catalog/ProductChooserBoundary.tsx", symbol: "ProductChooserBoundary" },
        { entityKey: "catalog.sortControl", sourceFile: "src/features/catalog/SortControlBoundary.tsx", symbol: "SortControlBoundary" },
        { entityKey: "catalog.relatedProducts", sourceFile: "src/features/catalog/RelatedProductsBoundary.tsx", symbol: "RelatedProductsBoundary" },
        { entityKey: "account.profileForm", sourceFile: "src/features/account/ProfileFormBoundary.tsx", symbol: "ProfileFormBoundary" },
        { entityKey: "account.adminPanel", sourceFile: "src/features/account/AdminPanelBoundary.tsx", symbol: "AdminPanelBoundary" },
        { entityKey: "account.transactionList", sourceFile: "src/features/account/TransactionListBoundary.tsx", symbol: "TransactionListBoundary" },
        { entityKey: "ui.primaryButton", sourceFile: "src/features/shared/ButtonBoundary.tsx", symbol: "ButtonBoundary" }
      ]
    })
  ],
  server: { port: 5173 }
});
