// ============================================================
// API — Entry Point
// ============================================================
// Express 5 BFF aggregator for the developer portal.
// Federates data from Prism, Tools API, Sessions, and other services.
// ============================================================

import express from "express";
import cors from "cors";

import { errorHandler } from "./utils/errors.js";
import logger from "./utils/logger.js";
import { requestLoggerMiddleware } from "./middleware/RequestLoggerMiddleware.js";
import MongoWrapper from "./wrappers/MongoWrapper.js";
import { PORT, MONGO_URI, MONGO_DB_NAME } from "./config.js";
import { COLLECTIONS } from "./constants.js";
import ServiceRegistryService from "./services/ServiceRegistryService.js";
import InfrastructureRegistryService from "./services/InfrastructureRegistryService.js";

// Routes
import healthRouter from "./routes/health.js";
import servicesRouter from "./routes/services.js";
import statsRouter from "./routes/stats.js";
import logsRouter from "./routes/logs.js";
import integrationsRouter from "./routes/integrations.js";

import devicesRouter from "./routes/devices.js";

// ─── Express App ───────────────────────────────────────────────────

const app = express();

// ── CORS — restrict to portal client + local development ──────
const ALLOWED_ORIGINS = [
  process.env.AUTH_URL,            // e.g. https://portal.rod.dev (from Vault)
  "http://localhost:4000",
  "http://localhost:4001",
].filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // Allow requests with no origin (server-to-server, curl, health checks)
      if (!origin) return callback(null, true);
      // Allow any localhost port (local development)
      if (/^http:\/\/localhost(:\d+)?$/.test(origin)) return callback(null, true);
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
  rest: ["/health", "/services", "/devices", "/stats", "/logs", "/integrations"],
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
  } catch (err) {
    logger.error(`Failed to ensure indexes: ${err.message}`);
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
    .catch((err) => {
      logger.warn(`[Registry] Initial check failed: ${err.message}`);
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
