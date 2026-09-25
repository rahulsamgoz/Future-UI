# Index worker (R2 stream H). Multi-stage; build context is the REPOSITORY
# ROOT: docker build -f apps/index-worker/Dockerfile .
# Shares the API's SQLite volume so both see the same job queue.
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
RUN npm prune --omit=dev
RUN mkdir -p /out/apps/index-worker \
 && cp package.json /out/ \
 && cp -r node_modules /out/node_modules \
 && for d in packages/*/; do n=$(basename "$d"); mkdir -p "/out/packages/$n"; cp "$d/package.json" "/out/packages/$n/"; if [ -d "$d/dist" ]; then cp -r "$d/dist" "/out/packages/$n/dist"; fi; done \
 && cp apps/index-worker/package.json /out/apps/index-worker/ \
 && cp -r apps/index-worker/dist /out/apps/index-worker/dist
# next/@next (SWC) and sharp's @img binaries serve the Next.js demo only and
# are not imported by this service — dropped from the runtime image.
RUN rm -rf /out/node_modules/next /out/node_modules/@next /out/node_modules/@img

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    UI_INTEL_DB=/app/data/ui-intelligence.sqlite
RUN mkdir -p /app/data
COPY --from=builder /out ./
# The worker bootstraps its schema from this file (same SQL as apps/api).
COPY infra/dev/schema.sql /app/infra/dev/schema.sql
ENV UI_INTEL_SCHEMA=/app/infra/dev/schema.sql
# Polls the shared SQLite job queue; liveness is monitored via restart policy.
CMD ["node", "apps/index-worker/dist/main.js"]
