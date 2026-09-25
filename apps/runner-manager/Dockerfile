# Runner manager (R2 streams D+H). Multi-stage; build context is the
# REPOSITORY ROOT: docker build -f apps/runner-manager/Dockerfile .
#
# The manager schedules capture runs and leases them to workers. Workers
# joining from OUTSIDE the container (dev machine, CI) need a browser stack:
#   RUNNER_MANAGER_URL=http://<host>:8900 APP_URL=http://<app> \
#     node apps/capture-runner/dist/main.js
# Set RUNNER_POOL_COUNT>0 to spawn child workers from this container — that
# requires playwright + chromium inside the image (not included in slim).
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
RUN mkdir -p /out/apps/runner-manager \
 && cp package.json /out/ \
 && cp -r node_modules /out/node_modules \
 && for d in packages/*/; do n=$(basename "$d"); mkdir -p "/out/packages/$n"; cp "$d/package.json" "/out/packages/$n/"; if [ -d "$d/dist" ]; then cp -r "$d/dist" "/out/packages/$n/dist"; fi; done \
 && cp apps/runner-manager/package.json /out/apps/runner-manager/ \
 && cp -r apps/runner-manager/dist /out/apps/runner-manager/dist
# next/@next (SWC) and sharp's @img binaries serve the Next.js demo only and
# are not imported by this service — dropped from the runtime image.
RUN rm -rf /out/node_modules/next /out/node_modules/@next /out/node_modules/@img

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    RUNNER_DB=/app/data/runner.sqlite \
    APP_URL=http://reference-app:80 \
    RUNNER_POOL_COUNT=0 \
    PORT=8900
RUN mkdir -p /app/data
COPY --from=builder /out ./
EXPOSE 8900
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8900)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/runner-manager/dist/server.js"]
