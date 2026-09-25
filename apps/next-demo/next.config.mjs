/**
 * Static export (R2 stream A): `next build` emits a fully static site into
 * `out/` that any static file server can serve — no server runtime concerns.
 * Capture (ScenarioRunner) and the editor journey hit plain HTTP, which is
 * exactly what a static export provides.
 */
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
};

export default nextConfig;
