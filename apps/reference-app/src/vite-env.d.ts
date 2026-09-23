/// <reference types="vite/client" />

declare module "virtual:ui-intelligence/manifest" {
  const manifest: {
    protocolVersion: number;
    buildId: string;
    projectKey: string;
    entities: Array<{ entityKey: string; pageKey?: string }>;
    adapterCapabilities: Record<string, boolean>;
  };
  export default manifest;
}

interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
  readonly VITE_API_TOKEN?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
