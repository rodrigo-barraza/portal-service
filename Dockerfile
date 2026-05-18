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
COPY package.json package-lock.json ./
RUN apk add --no-cache git
RUN npm ci

# ── Stage 2: Build TypeScript ─────────────────────────────────
FROM deps AS build
WORKDIR /app
COPY . .
RUN npm run build
# Prune devDependencies for the runtime image
RUN npm prune --omit=dev

# ── Stage 3: Runtime ──────────────────────────────────────────
FROM node:26-alpine
WORKDIR /app

# Copy production node_modules and compiled dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# Non-root user for security
RUN addgroup --system --gid 1001 portal && \
    adduser --system --uid 1001 portal
USER portal

EXPOSE 4001

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 -O /dev/null http://127.0.0.1:4001/health || exit 1

CMD ["node", "dist/boot.js"]
