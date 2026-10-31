# Build from the repo root: docker build -f apps/web/Dockerfile .
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
RUN npm ci --workspace @crawl/core --workspace @crawl/web --include-workspace-root
COPY packages/core packages/core
COPY apps/web apps/web
ARG VITE_TILES_URL
ARG VITE_GLYPHS_URL
RUN npm run build -w @crawl/core && npm run build -w @crawl/web

FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
