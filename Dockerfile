# ============================================================
# Portal — Multi-stage Dockerfile
# ============================================================
# API BFF aggregator — Express server that federates
# data from all Sun services. Uses boot.js to fetch secrets
# from Vault at startup.
# ============================================================

# ── Stage 1: Install dependencies ─────────────────────────────
FROM node:26-alpine AS deps
WORKDIR /app
RUN npm install -g pnpm
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN apk add --no-cache git
RUN --mount=type=ssh \
    --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ── Stage 2: Build TypeScript ─────────────────────────────────
FROM deps AS build
WORKDIR /app
COPY . .
RUN pnpm run typecheck
# Prune devDependencies for the runtime image
RUN pnpm prune --prod

# ── Stage 3: Runtime ──────────────────────────────────────────
FROM node:26-alpine
WORKDIR /app

# System Chromium for Playwright site screenshots (/containers/previews).
# Alpine has no Playwright-bundled browser build, so Playwright is pointed
# at the apk Chromium instead — same pattern as tools-service.
RUN apk add --no-cache chromium font-noto font-noto-emoji
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Copy production node_modules and compiled dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/package.json ./package.json

# Non-root user for security
RUN addgroup --system --gid 1001 portal && \
    adduser --system --uid 1001 portal
USER portal

EXPOSE 4001

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 -O /dev/null http://127.0.0.1:4001/health || exit 1

CMD ["node", "src/boot.ts"]
