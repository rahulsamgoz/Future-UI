# Studio console (R2 stream H). Vite build → nginx:alpine serving the SPA
# with /v1 proxied to the api service. Build context is the REPOSITORY ROOT:
#   docker build -f apps/studio/Dockerfile .
# VITE_API_BASE is empty at build time so the SPA calls /v1 same-origin.
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
RUN VITE_API_BASE= sh -c 'cd apps/studio && npx vite build'

FROM nginx:alpine AS runtime
COPY apps/studio/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/apps/studio/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
CMD ["nginx", "-g", "daemon off;"]
