# Reference app (R2 stream H). Vite build → nginx:alpine serving the built
# SPA with /v1 proxied to the api service (the app's editor defaults to
# same-origin /v1 when VITE_API_BASE is unset). Build context is the
# REPOSITORY ROOT: docker build -f apps/reference-app/Dockerfile .
FROM node:22-slim AS builder
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm ci
# Host tsbuildinfo files would make tsc -b consider projects up-to-date and
# skip emitting into the fresh container — remove them before building.
RUN find . -name '*.tsbuildinfo' -not -path './node_modules/*' -delete
# The vite plugin stamps the build identity from git; without .git the
# fallback commit "unknown" is used (dev-profile images are not history
# sources — see architecture section 10).
RUN npx tsc -b
RUN sh -c 'cd apps/reference-app && npx vite build'

FROM nginx:alpine AS runtime
COPY apps/reference-app/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/apps/reference-app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
CMD ["nginx", "-g", "daemon off;"]
