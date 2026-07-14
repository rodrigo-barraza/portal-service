import { Request, Response } from "express";
// ─── Entry Point ────────────────────────────────────────────

import http from "node:http";
import express from "express";
import cors from "cors";

import { errorHandler } from "./utils/errors.ts";
import { getErrorMessage, MILLISECONDS_PER_MINUTE } from "@rodrigo-barraza/utilities-library";
import { installShutdownHandlers, registerCleanup } from "@rodrigo-barraza/utilities-library/service";
import logger from "./utils/logger.ts";
import { requestLoggerMiddleware } from "./middleware/RequestLoggerMiddleware.ts";
import MongoWrapper from "./wrappers/MongoWrapper.ts";
import { PORT, MONGO_URI, MONGO_DB_NAME, PROJECTS, initializeRegistry } from "./config.ts";
import type { VaultRegistry } from "./types.ts";
import { COLLECTIONS } from "./constants.ts";
import ServiceRegistryService from "./services/ServiceRegistryService.ts";
import InfrastructureRegistryService from "./services/InfrastructureRegistryService.ts";
import ContainerMetricsService from "./services/ContainerMetricsService.ts";

// Routes
import healthRouter from "./routes/HealthRoutes.ts";
import servicesRouter from "./routes/ServicesRoutes.ts";
import statsRouter from "./routes/StatsRoutes.ts";
import logsRouter from "./routes/LogsRoutes.ts";
import integrationsRouter from "./routes/IntegrationsRoutes.ts";
import storageRouter from "./routes/StorageRoutes.ts";
import googleAnalyticsRouter from "./routes/GoogleAnalyticsRoutes.ts";
import devicesRouter from "./routes/DevicesRoutes.ts";
import containersRouter from "./routes/ContainersRoutes.ts";
import sessionAnalyticsRouter from "./routes/SessionAnalyticsRoutes.ts";
import googleCloudUsageRouter from "./routes/GoogleCloudUsageRoutes.ts";


// ─── Process Lifecycle ─────────────────────────────────────────────

// Graceful shutdown on SIGTERM/SIGINT — runs everything registered via
// registerCleanup (timers, Mongo, the HTTP server).
installShutdownHandlers({ logger });

// Crash guards: Node ≥15 kills the process on any unhandled promise
// rejection. Log loudly and survive instead — per-request error paths
// already handle their own failures. (Same rationale as prism-service.)
process.on("unhandledRejection", (reason: unknown) => {
  const detail =
    reason instanceof Error
      ? `${reason.message}\n${reason.stack}`
      : JSON.stringify(reason);
  logger.error(`[process] Unhandled promise rejection (survived): ${detail}`);
});
process.on("uncaughtException", (error: Error, origin: string) => {
  logger.error(
    `[process] Uncaught exception (${origin}, survived): ${error.message}\n${error.stack}`,
  );
});

// ─── Express App ───────────────────────────────────────────────────

const app = express();

// ── CORS — restrict to portal client + local development ──────
const ALLOWED_ORIGINS = [
  process.env.AUTH_URL,            // e.g. https://portal.rod.dev (from Vault)
  process.env.PORTAL_CLIENT_URL,   // e.g. http://192.168.86.2:4000 (from Vault registry)
  process.env.PORTAL_SERVICE_PUBLIC_URL?.replace(/^https?:\/\/api\./, 'https://'),  // derive client origin from API domain
].filter(Boolean);

app.use(
  cors({
    origin(origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) {
      // Allow requests with no origin (server-to-server, curl, health checks)
      if (!origin) return callback(null, true);
      // Allow any localhost port (local development)
      if (/^http:\/\/localhost(:\d+)?$/.test(origin)) return callback(null, true);
      // Allow private-network IPs (LAN access via IP address)
      if (/^http:\/\/(192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/.test(origin)) return callback(null, true);
      // Allow whitelisted origins
      if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
      // Disallowed: respond without CORS headers (browser blocks) instead
      // of routing an Error through the 500 handler for every stray origin.
      callback(null, false);
    },
    credentials: true,
    maxAge: 86_400, // cache preflight for 24h — avoids OPTIONS storms
  }),
);
app.use(express.json({ limit: "5mb" }));
app.use(requestLoggerMiddleware);

// ─── Endpoint Registry ────────────────────────────────────────────

const ENDPOINTS = {
  rest: ["/health", "/services", "/devices", "/containers", "/stats", "/logs", "/integrations", "/object-store", "/google-analytics", "/session-analytics", "/cloud-usage"],
};

// ─── Root Health Check ─────────────────────────────────────────────

app.get("/", (_req: Request, res: Response) => {
  res.json({
    name: "API",
    version: "1.0.0",
    status: "ok",
    uptime: process.uptime(),
    endpoints: ENDPOINTS,
  });
});

// ─── Mount Routes ──────────────────────────────────────────────────

app.use("/health", healthRouter);
app.use("/services", servicesRouter);
app.use("/stats", statsRouter);
app.use("/logs", logsRouter);
app.use("/integrations", integrationsRouter);
app.use("/object-store", storageRouter);
app.use("/google-analytics", googleAnalyticsRouter);

app.use("/devices", devicesRouter);
app.use("/containers", containersRouter);
app.use("/session-analytics", sessionAnalyticsRouter);
app.use("/cloud-usage", googleCloudUsageRouter);

// ─── Error Handler (must be last) ──────────────────────────────────

app.use(errorHandler);

// ─── Startup ───────────────────────────────────────────────────────

(async () => {
  // Connect to MongoDB
  await MongoWrapper.createClient(String(MONGO_DB_NAME), String(MONGO_URI));
  registerCleanup(async () => MongoWrapper.closeAll());

  // Ensure indexes for query performance
  try {
    const db = MongoWrapper.getDb(String(MONGO_DB_NAME));
    if (db) {
      await Promise.all([
        db
          .collection(COLLECTIONS.SERVICE_SNAPSHOTS)
          .createIndex({ timestamp: -1 }),
      ]);
      logger.success("Database indexes ensured");

      // Ensure time-series collection for container metrics
      await ContainerMetricsService.ensureCollection();
    }
  } catch (error: unknown) {
    logger.error(`Failed to ensure indexes: ${getErrorMessage(error)}`);
  }

  // ── Deferred Registry Recovery ─────────────────────────────────
  // If the registry was empty at boot (vault wasn't ready), keep
  // retrying in the background until we get services populated.
  const registryProjectCount = Object.keys(PROJECTS).length;
  if (registryProjectCount === 0) {
    logger.warn("[Registry] No registry projects from boot — scheduling deferred recovery");

    const DEFERRED_INTERVAL_MS = 10_000;
    const MAX_DEFERRED_ATTEMPTS = 30; // give up after 5 minutes
    let deferredAttempt = 0;

    const deferredTimer = setInterval(async () => {
      deferredAttempt++;

      try {
        const { vault } = await import("./boot.js");
        vault.clearRegistryCache();
        const registry = await vault.fetchRegistry();

        if (registry.projects?.length > 0) {
          const { initializeRegistry } = await import("./config.js");
          initializeRegistry(registry as unknown as import("./types.ts").VaultRegistry);

          // Run initial health checks now that we have services
          ServiceRegistryService.checkAll().catch(() => {});
          InfrastructureRegistryService.checkAll().catch(() => {});

          logger.success(`[Registry] Deferred recovery succeeded on attempt ${deferredAttempt}`);
          clearInterval(deferredTimer);
        } else if (deferredAttempt >= MAX_DEFERRED_ATTEMPTS) {
          logger.error("[Registry] Deferred recovery exhausted — giving up");
          clearInterval(deferredTimer);
        } else {
          logger.warn(`[Registry] Deferred attempt ${deferredAttempt}/${MAX_DEFERRED_ATTEMPTS} — still empty`);
        }
      } catch (error: unknown) {
        logger.warn(`[Registry] Deferred attempt ${deferredAttempt} failed: ${getErrorMessage(error)}`);
        if (deferredAttempt >= MAX_DEFERRED_ATTEMPTS) {
          clearInterval(deferredTimer);
        }
      }
    }, DEFERRED_INTERVAL_MS);
  }

  // Initial health check of all services (fire-and-forget)
  Promise.all([
    ServiceRegistryService.checkAll(),
    InfrastructureRegistryService.checkAll(),
  ])
    .then(([serviceResults, infraResults]) => {
      const serviceHealthyCount = serviceResults.filter((result) => result && result.healthy).length;
      const infraHealthyCount = infraResults.filter((result) => result && result.healthy).length;
      logger.info(
        `[ServiceRegistry] ${serviceHealthyCount}/${serviceResults.length} services healthy`,
      );
      logger.info(
        `[InfraRegistry] ${infraHealthyCount}/${infraResults.length} infrastructure healthy`,
      );
    })
    .catch((error: unknown) => {
      logger.warn(`[Registry] Initial check failed: ${getErrorMessage(error)}`);
    });

  // Periodic health checks every 60 seconds
  const healthCheckTimer = setInterval(() => {
    ServiceRegistryService.checkAll().catch(() => {});
    InfrastructureRegistryService.checkAll().catch(() => {});
  }, MILLISECONDS_PER_MINUTE);
  registerCleanup(() => clearInterval(healthCheckTimer));

  // ── Periodic Registry Refresh ──────────────────────────────────
  // Re-fetch the vault registry every 5 minutes so new projects
  // (e.g. notes-service, notes-client) are picked up without
  // requiring a portal-service container restart.
  const REGISTRY_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

  // Compare full registry content, not just the project count — otherwise
  // edits to an existing project (URL, device, dependsOn) never hot-reload.
  let lastRegistrySnapshot = "";

  const registryRefreshTimer = setInterval(async () => {
    try {
      const { vault } = await import("./boot.js");
      vault.clearRegistryCache();
      const registry = await vault.fetchRegistry();

      if (registry?.projects?.length > 0) {
        const snapshot = JSON.stringify(registry.projects);

        if (snapshot !== lastRegistrySnapshot) {
          const currentCount = Object.keys(PROJECTS).length;
          lastRegistrySnapshot = snapshot;
          initializeRegistry(registry as unknown as VaultRegistry);
          logger.info(`[Registry] Hot-reloaded — ${currentCount} → ${registry.projects.length} projects`);

          // Trigger health checks for any newly registered services
          ServiceRegistryService.checkAll().catch(() => {});
          InfrastructureRegistryService.checkAll().catch(() => {});
        }
      }
    } catch (error: unknown) {
      logger.warn(`[Registry] Periodic refresh failed: ${getErrorMessage(error)}`);
    }
  }, REGISTRY_REFRESH_INTERVAL_MS);
  registerCleanup(() => clearInterval(registryRefreshTimer));

  // Start server. Wrap express in http.createServer so we can disable the
  // default 5-minute requestTimeout, which would otherwise sever active SSE
  // streams (/logs follow, /object-store/buckets/stream) at exactly 300s.
  const server = http.createServer(app);
  server.requestTimeout = 0;
  server.listen(PORT, () => {
    logger.success(`API is running on port ${PORT}`);
    ENDPOINTS.rest.forEach((ep: string) =>
      logger.info(`  REST  →  http://localhost:${PORT}${ep}`),
    );
  });
  registerCleanup(() => new Promise<void>((resolve) => server.close(() => resolve())));
})().catch((error: unknown) => {
  logger.error(`Fatal startup failure: ${getErrorMessage(error)}`);
  process.exit(1);
});

