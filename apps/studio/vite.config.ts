import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server config. `VITE_API_BASE` / `VITE_API_TOKEN` point the studio at
// the local API (dev profile only — see infra/dev/README.md).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
  },
});
