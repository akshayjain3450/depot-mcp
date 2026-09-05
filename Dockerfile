# Multi-stage build. The runtime image contains only production node_modules, dist/, and the
# license files. No token is baked in: pass DEPOT_TOKEN at run time, e.g.
#   docker run -i --rm -e DEPOT_TOKEN depot-mcp
# The server speaks MCP over stdio, so `-i` is required and `-t` must not be used.

FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM gcr.io/distroless/nodejs20-debian12:nonroot
LABEL org.opencontainers.image.title="depot-mcp" \
      org.opencontainers.image.description="Read-only MCP server for Depot (depot.dev): CI failure diagnosis, build forensics, usage" \
      org.opencontainers.image.source="https://github.com/akshayjain3450/depot-mcp" \
      org.opencontainers.image.licenses="Apache-2.0 with Commons Clause 1.0 (see LICENSE)" \
      org.opencontainers.image.vendor="Community project, not affiliated with Depot"
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY LICENSE NOTICE ./
# distroless nodejs images use `node` as the entrypoint.
CMD ["dist/index.js"]
