# Build from the repo root: docker build -f apps/api/Dockerfile .
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @crawl/core --workspace @crawl/api --include-workspace-root
COPY packages/core packages/core
COPY apps/api apps/api
RUN npm run build -w @crawl/core && npm run build -w @crawl/api && npm prune --omit=dev --workspace @crawl/api --workspace @crawl/core

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/core/package.json packages/core/package.json
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/apps/api/package.json apps/api/package.json
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/data apps/api/data
WORKDIR /app/apps/api
RUN mkdir -p storage && chown node:node storage
USER node
EXPOSE 4000
CMD ["node", "dist/server.js"]
