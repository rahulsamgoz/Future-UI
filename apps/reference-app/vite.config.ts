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
  server: {
    port: 5173,
    host: "0.0.0.0",
    allowedHosts: true,
    // Same-origin API access in dev: /v1 is forwarded to the local API so
    // the browser never makes a cross-origin call (works on localhost AND
    // through the public preview proxy).
    proxy: {
      "/v1": {
        target: process.env.UI_INTEL_API_TARGET ?? "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
});
