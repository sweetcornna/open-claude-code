# ---- Stage 1: Install deps + build ----
FROM oven/bun:1 AS builder
WORKDIR /app

ARG VERSION=0.2.0

# Copy package files for install. No lockfile is copied: the monorepo `bun.lock`
# is workspace-shaped and cannot be resolved from this single package.json, so
# every direct dependency is pinned to an exact version there instead (keep it
# that way — caret ranges would make image builds non-reproducible).
COPY packages/remote-control-server/package.json ./package.json

# Install all dependencies (including devDeps for vite build)
RUN bun install

# Copy source code
COPY packages/remote-control-server/src ./src
COPY packages/remote-control-server/tsconfig.json ./tsconfig.json

# Copy web frontend source and build it
COPY packages/remote-control-server/web ./web
RUN bun run build:web

# Build backend
RUN bun build src/index.ts --outfile=dist/server.js --target=bun \
    --define "process.env.RCS_VERSION=\"${VERSION}\"" && \
    bun build src/admin.ts --outfile=dist/admin.js --target=bun

# ---- Stage 2: Runtime ----
FROM oven/bun:1-slim AS runtime

ARG VERSION=0.2.0
ENV NODE_ENV=production
ENV RCS_VERSION=${VERSION}

WORKDIR /app

# Copy built artifacts
COPY --from=builder /app/dist/server.js ./dist/server.js
COPY --from=builder /app/dist/admin.js ./dist/admin.js
COPY --from=builder /app/web/dist ./web/dist

VOLUME /app/data

EXPOSE 3000

# `bun -e`, not `bun run -e`: the latter is not a flag `bun run` understands, so
# it prints usage and exits 0 — the container would report healthy forever.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://localhost:3000/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["bun", "run", "dist/server.js"]
