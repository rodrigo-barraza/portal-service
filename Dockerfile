# ============================================================
# API — Multi-stage Dockerfile
# ============================================================
# API BFF aggregator — Express server that federates
# data from all Sun services. Uses boot.js to fetch secrets
# from Vault at startup.
# ============================================================

# --- Dependencies ---
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- Production ---
FROM node:22-alpine
WORKDIR /app

# Copy pre-built node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source
COPY . .

# Non-root user for security
RUN addgroup --system --gid 1001 api && \
    adduser --system --uid 1001 api
USER api

EXPOSE 4001

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 -O /dev/null http://127.0.0.1:4001/health || exit 1

CMD ["node", "src/boot.js"]
