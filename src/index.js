// ============================================================
// API — Entry Point
// ============================================================
// Express 5 BFF aggregator for the Sun ecosystem developer portal.
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

import devicesRouter from "./routes/devices.js";

// ─── Express App ───────────────────────────────────────────────────

const app = express();

app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(requestLoggerMiddleware);

// ─── Endpoint Registry ────────────────────────────────────────────

const ENDPOINTS = {
  rest: ["/health", "/services", "/devices", "/stats", "/logs"],
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
