// ─── Entry Point ────────────────────────────────────────────

import http from "node:http";
import express, { type Request, type Response } from "express";
import cors from "cors";
import { getErrorMessage, MILLISECONDS_PER_MINUTE } from "@rodrigo-barraza/utilities-library";
import { installShutdownHandlers, registerCleanup } from "@rodrigo-barraza/utilities-library/service";

import { errorHandler, notFoundHandler } from "./utils/errors.ts";
import logger from "./utils/logger.ts";
import { requestLoggerMiddleware } from "./middleware/RequestLoggerMiddleware.ts";
import MongoWrapper from "./wrappers/MongoWrapper.ts";
import {
  PORT,
  MONGO_URI,
  MONGO_DB_NAME,
  PRISM_MONGO_DB_NAME,
  TOOLS_MONGO_DB_NAME,
  PROJECTS,
  WATCHDOG_EVALUATE_INTERVAL_MS,
} from "./config.ts";
import ServiceRegistryService from "./services/ServiceRegistryService.ts";
import InfrastructureRegistryService from "./services/InfrastructureRegistryService.ts";
import ContainerMetricsService from "./services/ContainerMetricsService.ts";
import DockerStatsService from "./services/DockerStatsService.ts";
import WatchdogService from "./services/WatchdogService.ts";
import ScreenshotService from "./services/ScreenshotService.ts";
import GoogleAnalyticsService from "./services/GoogleAnalyticsService.ts";
import GoogleCloudUsageService from "./services/GoogleCloudUsageService.ts";
import { reloadRegistry } from "./services/RegistryRefreshService.ts";

// Routes
import healthRouter from "./routes/HealthRoutes.ts";
import servicesRouter from "./routes/ServicesRoutes.ts";
import serviceControlRouter from "./routes/ServiceControlRoutes.ts";
import repositoryInsightsRouter from "./routes/RepositoryInsightsRoutes.ts";
import statsRouter from "./routes/StatsRoutes.ts";
import logsRouter from "./routes/LogsRoutes.ts";
import integrationsRouter from "./routes/IntegrationsRoutes.ts";
import storageRouter from "./routes/StorageRoutes.ts";
import googleAnalyticsRouter from "./routes/GoogleAnalyticsRoutes.ts";
import devicesRouter from "./routes/DevicesRoutes.ts";
import containersRouter from "./routes/ContainersRoutes.ts";
import sessionAnalyticsRouter from "./routes/SessionAnalyticsRoutes.ts";
import externalApisRouter from "./routes/ExternalApisRoutes.ts";
import watchdogRouter from "./routes/WatchdogRoutes.ts";

// ─── Process Lifecycle ─────────────────────────────────────────────

// Graceful shutdown on SIGTERM/SIGINT — runs everything registered via
// registerCleanup (timers, Mongo, gRPC clients, Chromium, the HTTP server).
installShutdownHandlers({ logger });

// Crash guards: Node ≥15 kills the process on any unhandled promise
// rejection. Log loudly and survive instead — per-request error paths
// already handle their own failures. (Same rationale as prism-service.)
process.on("unhandledRejection", (reason: unknown) => {
  const detail = reason instanceof Error ? `${reason.message}\n${reason.stack}` : JSON.stringify(reason);
  logger.error(`[process] Unhandled promise rejection (survived): ${detail}`);
});
process.on("uncaughtException", (error: Error, origin: string) => {
  logger.error(`[process] Uncaught exception (${origin}, survived): ${error.message}\n${error.stack}`);
});

// ─── Express App ───────────────────────────────────────────────────

const app = express();

// ── CORS — restrict to portal client + local development ──────
const ALLOWED_ORIGINS = [
  process.env.AUTH_URL, // e.g. https://portal.rod.dev (from Vault)
  process.env.PORTAL_CLIENT_URL, // e.g. http://localhost:4000 (from Vault registry)
  process.env.PORTAL_SERVICE_PUBLIC_URL?.replace(/^https?:\/\/api\./, "https://"), // derive client origin from API domain
].filter(Boolean);

const LOCALHOST_ORIGIN_PATTERN = /^http:\/\/localhost(:\d+)?$/;
const PRIVATE_NETWORK_ORIGIN_PATTERN =
  /^http:\/\/(192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/;

app.use(
  cors({
    origin(origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) {
      // No origin: server-to-server, curl, health checks. Otherwise any
      // localhost port (local development), private-network IPs (LAN
      // access via IP address), or a whitelisted origin. Disallowed
      // origins get no CORS headers (the browser blocks) instead of an
      // Error routed through the 500 handler for every stray origin.
      const allowed =
        !origin ||
        LOCALHOST_ORIGIN_PATTERN.test(origin) ||
        PRIVATE_NETWORK_ORIGIN_PATTERN.test(origin) ||
        ALLOWED_ORIGINS.includes(origin);
      callback(null, allowed);
    },
    credentials: true,
    maxAge: 86_400, // cache preflight for 24h — avoids OPTIONS storms
  }),
);
// No global body parser: no route reads a JSON body (the watchdog
// heartbeat parses its own small text body). Parsing up to 5 MB of JSON
// on every POST to a public API was pure attack surface.
app.use(requestLoggerMiddleware);

// ─── Endpoint Registry ────────────────────────────────────────────

const ENDPOINTS = {
  rest: ["/health", "/services", "/devices", "/containers", "/stats", "/logs", "/integrations", "/object-store", "/google-analytics", "/session-analytics", "/external-apis", "/watchdog"],
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
app.use("/services", serviceControlRouter);
app.use("/services", repositoryInsightsRouter);
app.use("/stats", statsRouter);
app.use("/logs", logsRouter);
app.use("/integrations", integrationsRouter);
app.use("/object-store", storageRouter);
app.use("/google-analytics", googleAnalyticsRouter);
app.use("/devices", devicesRouter);
app.use("/containers", containersRouter);
app.use("/session-analytics", sessionAnalyticsRouter);
app.use("/external-apis", externalApisRouter);
app.use("/watchdog", watchdogRouter);

// ─── Not Found + Error Handler (must be last) ──────────────────────

app.use(notFoundHandler);
app.use(errorHandler);

// ─── Startup ───────────────────────────────────────────────────────

/** Re-run both health rounds, logging (never throwing) on failure. */
function checkRegistryHealth(): Promise<unknown> {
  return Promise.all([ServiceRegistryService.checkAll(), InfrastructureRegistryService.checkAll()]).catch(
    (error: unknown) => {
      logger.warn(`[Registry] Health round failed: ${getErrorMessage(error)}`);
    },
  );
}

/** Deferred recovery: vault had no registry at boot — keep retrying until it does. */
function scheduleDeferredRegistryRecovery(): void {
  const DEFERRED_INTERVAL_MS = 10_000;
  const MAX_DEFERRED_ATTEMPTS = 30; // give up after 5 minutes
  let deferredAttempt = 0;

  logger.warn("[Registry] No registry projects from boot — scheduling deferred recovery");

  const deferredTimer = setInterval(async () => {
    deferredAttempt++;
    try {
      const result = await reloadRegistry();
      if (result) {
        logger.success(`[Registry] Deferred recovery succeeded on attempt ${deferredAttempt}`);
        clearInterval(deferredTimer);
        return;
      }
      logger.warn(`[Registry] Deferred attempt ${deferredAttempt}/${MAX_DEFERRED_ATTEMPTS} — still empty`);
    } catch (error: unknown) {
      logger.warn(`[Registry] Deferred attempt ${deferredAttempt} failed: ${getErrorMessage(error)}`);
    }

    if (deferredAttempt >= MAX_DEFERRED_ATTEMPTS) {
      logger.error("[Registry] Deferred recovery exhausted — giving up");
      clearInterval(deferredTimer);
    }
  }, DEFERRED_INTERVAL_MS);
  registerCleanup(() => clearInterval(deferredTimer));
}

(async () => {
  // Connect to MongoDB
  await MongoWrapper.createClient(String(MONGO_DB_NAME), String(MONGO_URI));
  registerCleanup(async () => MongoWrapper.closeAll());

  // Read-only connections to sibling databases for the External APIs
  // dashboard (prism LLM request log + tools-service usage buckets).
  // Non-fatal: the dashboard degrades to Google-only data without them.
  for (const externalDbName of new Set([PRISM_MONGO_DB_NAME, TOOLS_MONGO_DB_NAME])) {
    if (externalDbName === MONGO_DB_NAME) continue;
    try {
      await MongoWrapper.createClient(String(externalDbName), String(MONGO_URI));
    } catch (error: unknown) {
      logger.warn(`External usage database "${externalDbName}" unavailable: ${getErrorMessage(error)}`);
    }
  }

  // Time-series collection (+ its index) for persisted container metrics
  await ContainerMetricsService.ensureCollection();

  if (Object.keys(PROJECTS).length === 0) {
    scheduleDeferredRegistryRecovery();
  }

  // Initial health check of all services (fire-and-forget)
  Promise.all([ServiceRegistryService.checkAll(), InfrastructureRegistryService.checkAll()])
    .then(([serviceResults, infraResults]) => {
      const serviceHealthyCount = serviceResults.filter((result) => result.healthy).length;
      const infraHealthyCount = infraResults.filter((result) => result.healthy).length;
      logger.info(`[ServiceRegistry] ${serviceHealthyCount}/${serviceResults.length} services healthy`);
      logger.info(`[InfraRegistry] ${infraHealthyCount}/${infraResults.length} infrastructure healthy`);
    })
    .catch((error: unknown) => {
      logger.warn(`[Registry] Initial check failed: ${getErrorMessage(error)}`);
    });

  // Periodic health checks every 60 seconds
  const healthCheckTimer = setInterval(() => void checkRegistryHealth(), MILLISECONDS_PER_MINUTE);
  registerCleanup(() => clearInterval(healthCheckTimer));
  registerCleanup(() => InfrastructureRegistryService.closeHealthCheckClient());

  // Docker stats ring buffer (+ persisted metrics every 30s)
  DockerStatsService.startCollector();
  registerCleanup(() => DockerStatsService.stopCollector());

  // Watchdog: turn the health caches + push heartbeats into Discord
  // alerts on sustained state transitions (see WatchdogService).
  const watchdogTimer = setInterval(() => {
    WatchdogService.evaluate().catch((error: unknown) => {
      logger.error(`[Watchdog] Evaluation failed: ${getErrorMessage(error)}`);
    });
  }, WATCHDOG_EVALUATE_INTERVAL_MS);
  registerCleanup(() => clearInterval(watchdogTimer));

  // ── Periodic Registry Refresh ──────────────────────────────────
  // Re-fetch the vault registry every 5 minutes so new or edited projects
  // are picked up without a portal-service restart; reloadRegistry
  // compares the whole document against what is applied.
  const REGISTRY_REFRESH_INTERVAL_MS = 5 * MILLISECONDS_PER_MINUTE;
  const registryRefreshTimer = setInterval(async () => {
    try {
      const result = await reloadRegistry();
      if (result?.changed) {
        logger.info(`[Registry] Hot-reloaded — ${result.previousCount} → ${result.newCount} projects`);
      }
    } catch (error: unknown) {
      logger.warn(`[Registry] Periodic refresh failed: ${getErrorMessage(error)}`);
    }
  }, REGISTRY_REFRESH_INTERVAL_MS);
  registerCleanup(() => clearInterval(registryRefreshTimer));

  // Long-lived clients that hold sockets or child processes
  registerCleanup(() => ScreenshotService.shutdown());
  registerCleanup(() => GoogleAnalyticsService.close());
  registerCleanup(() => GoogleCloudUsageService.close());

  // Start server. Wrap express in http.createServer so we can disable the
  // default 5-minute requestTimeout, which would otherwise sever active SSE
  // streams (/logs follow, /object-store/buckets/stream) at exactly 300s.
  const server = http.createServer(app);
  server.requestTimeout = 0;
  server.listen(PORT, () => {
    logger.success(`API is running on port ${PORT}`);
    ENDPOINTS.rest.forEach((endpoint: string) => logger.info(`  REST  →  http://localhost:${PORT}${endpoint}`));
  });
  registerCleanup(
    () =>
      new Promise<void>((resolve) => {
        // Open SSE streams would otherwise hold close() until the shutdown timeout
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
})().catch((error: unknown) => {
  logger.error(`Fatal startup failure: ${getErrorMessage(error)}`);
  process.exit(1);
});
