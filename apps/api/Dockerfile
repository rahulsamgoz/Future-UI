# UI Intelligence API (R2 stream H). Multi-stage: node:22-slim builder →
# node:22-slim runtime. Build context is the REPOSITORY ROOT:
#   docker build -f apps/api/Dockerfile .
FROM node:22-slim AS builder
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm ci
# Host tsbuildinfo files would make tsc -b consider projects up-to-date and
# skip emitting into the fresh container — remove them before building.
RUN find . -name '*.tsbuildinfo' -not -path './node_modules/*' -delete
RUN npx tsc -b
# Keep only production dependencies (workspace links stay intact).
RUN npm prune --omit=dev
# Assemble the runtime tree: manifests, node_modules, and built output only.
RUN mkdir -p /out/apps/api \
 && cp package.json /out/ \
 && cp -r node_modules /out/node_modules \
 && for d in packages/*/; do n=$(basename "$d"); mkdir -p "/out/packages/$n"; cp "$d/package.json" "/out/packages/$n/"; if [ -d "$d/dist" ]; then cp -r "$d/dist" "/out/packages/$n/dist"; fi; done \
 && cp apps/api/package.json /out/apps/api/ \
 && cp -r apps/api/dist /out/apps/api/dist
# next/@next (SWC) and sharp's @img binaries serve the Next.js demo only and
# are not imported by this service — dropped from the runtime image.
RUN rm -rf /out/node_modules/next /out/node_modules/@next /out/node_modules/@img

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    UI_INTEL_DB=/app/data/ui-intelligence.sqlite \
    UI_INTEL_STORE=/app/data/artifacts \
    PORT=8787
RUN mkdir -p /app/data
COPY --from=builder /out ./
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/server.js"]
