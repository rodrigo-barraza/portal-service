# ============================================================
# Portal Service — Multi-stage Dockerfile
# ============================================================
# Express BFF aggregator that federates data from every service in
# the fleet. TypeScript runs directly on Node's type stripping
# (node src/boot.ts); boot.ts pulls secrets from Vault at startup.
# ============================================================

# ── Stage 1: Install dependencies ─────────────────────────────
FROM node:26-alpine AS deps
WORKDIR /app
# Pin to package.json's packageManager and disable pnpm's
# self-provisioning — otherwise pnpm re-fetches itself into the
# cache-mounted store's .tmp and fails with an ENOENT rename on
# lock.yaml (same as portal-client).
ENV npm_config_manage_package_manager_versions=false
RUN npm install -g pnpm@11.8.0
# utilities-library is a git-hosted dependency (codeload HTTPS tarball —
# no SSH agent needed)
RUN apk add --no-cache git
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ── Stage 2: Typecheck, then prune to production deps ─────────
FROM deps AS build
WORKDIR /app
COPY . .
RUN pnpm run typecheck
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

# Production node_modules + the TypeScript sources Node runs directly
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
