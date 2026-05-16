// ─── Entry Point ────────────────────────────────────────────

import express from "express";
import cors from "cors";

import { errorHandler } from "./utils/errors.js";
import logger from "./utils/logger.js";
import { requestLoggerMiddleware } from "./middleware/RequestLoggerMiddleware.js";
import MongoWrapper from "./wrappers/MongoWrapper.js";
import { PORT, MONGO_URI, MONGO_DB_NAME, PROJECTS } from "./config.js";
import { COLLECTIONS } from "./constants.js";
import ServiceRegistryService from "./services/ServiceRegistryService.js";
import InfrastructureRegistryService from "./services/InfrastructureRegistryService.js";

// Routes
import healthRouter from "./routes/HealthRoutes.js";
import servicesRouter from "./routes/ServicesRoutes.js";
import statsRouter from "./routes/StatsRoutes.js";
import logsRouter from "./routes/LogsRoutes.js";
import integrationsRouter from "./routes/IntegrationsRoutes.js";
import storageRouter from "./routes/StorageRoutes.js";
import googleAnalyticsRouter from "./routes/GoogleAnalyticsRoutes.js";
import devicesRouter from "./routes/DevicesRoutes.js";

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
    origin(origin, callback) {
      // Allow requests with no origin (server-to-server, curl, health checks)
      if (!origin) return callback(null, true);
      // Allow any localhost port (local development)
      if (/^http:\/\/localhost(:\d+)?$/.test(origin)) return callback(null, true);
      // Allow private-network IPs (LAN access via IP address)
      if (/^http:\/\/(192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/.test(origin)) return callback(null, true);
      // Allow whitelisted origins
      if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
      callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: true,
  }),
);
app.use(express.json({ limit: "5mb" }));
app.use(requestLoggerMiddleware);

// ─── Endpoint Registry ────────────────────────────────────────────

const ENDPOINTS = {
  rest: ["/health", "/services", "/devices", "/stats", "/logs", "/integrations", "/object-store", "/google-analytics"],
};

// ─── Root Health Check ─────────────────────────────────────────────

app.get("/", (_req, res) => {
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

// ─── Error Handler (must be last) ──────────────────────────────────

app.use(errorHandler);

// ─── Startup ───────────────────────────────────────────────────────

(async () => {
  // Connect to MongoDB
  await MongoWrapper.createClient(MONGO_DB_NAME, MONGO_URI);

  // Ensure indexes for query performance
  try {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (db) {
      await Promise.all([
        db
          .collection(COLLECTIONS.SERVICE_SNAPSHOTS)
          .createIndex({ timestamp: -1 }),
      ]);
      logger.success("Database indexes ensured");
    }
  } catch (error) {
    logger.error(`Failed to ensure indexes: ${error.message}`);
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
          initializeRegistry(registry);

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
      } catch (error) {
        logger.warn(`[Registry] Deferred attempt ${deferredAttempt} failed: ${error.message}`);
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
    .then(([svcResults, infraResults]) => {
      const svcHealthy = svcResults.filter((s) => s.healthy).length;
      const infraHealthy = infraResults.filter((s) => s.healthy).length;
      logger.info(
        `[ServiceRegistry] ${svcHealthy}/${svcResults.length} services healthy`,
      );
      logger.info(
        `[InfraRegistry] ${infraHealthy}/${infraResults.length} infrastructure healthy`,
      );
    })
    .catch((error) => {
      logger.warn(`[Registry] Initial check failed: ${error.message}`);
    });

  // Periodic health checks every 60 seconds
  setInterval(() => {
    ServiceRegistryService.checkAll().catch(() => {});
    InfrastructureRegistryService.checkAll().catch(() => {});
  }, 60_000);

  // Start server
  app.listen(PORT, () => {
    logger.success(`API is running on port ${PORT}`);
    ENDPOINTS.rest.forEach((ep) =>
      logger.info(`  REST  →  http://localhost:${PORT}${ep}`),
    );
  });
})();

