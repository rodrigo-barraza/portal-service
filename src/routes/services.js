// ============================================================
// API Portal — Services Route
// ============================================================
// GET  /services              — returns health status for all services
//                               and infrastructure backing stores.
// POST /services/check        — trigger a fresh health check.
// POST /services/:id/restart  — restart a containerized service.
// POST /services/:id/stop     — stop a containerized service.
// POST /services/:id/start    — start a containerized service.
// Enriches each item with resolved dependency graph edges.
//
// Uses Docker Engine API over Unix socket (mounted from the host)
// for container lifecycle operations.
// ============================================================

import { Router } from "express";
import http from "http";
import ServiceRegistryService from "../services/ServiceRegistryService.js";
import InfrastructureRegistryService from "../services/InfrastructureRegistryService.js";
import { SERVICES } from "../config.js";
import logger from "../utils/logger.js";

const router = Router();

const DOCKER_SOCKET = "/var/run/docker.sock";

// ── Docker Engine API helper ─────────────────────────────────
/**
 * Make a request to the Docker Engine API over the Unix socket.
 * @param {string} method - HTTP method
 * @param {string} path - API path (e.g. /containers/prism-service/restart)
 * @param {{ timeout?: number }} [opts]
 * @returns {Promise<{ statusCode: number, body: string }>}
 */
function dockerRequest(method, path, { timeout = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: DOCKER_SOCKET,
        path,
        method,
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ statusCode: res.statusCode, body }));
      },
    );

    req.setTimeout(timeout, () => {
      req.destroy(new Error(`Docker API timeout after ${timeout}ms`));
    });

    req.on("error", reject);
    req.end();
  });
}

/**
 * Build a lookup map (id → name) and compute the inverse dependency graph.
 * Returns both `dependsOn` (resolved to {id, name}) and `dependedOnBy`.
 */
function enrichWithDependencies(services, infrastructure) {
  const all = [...services, ...infrastructure];

  // id → name lookup
  const nameMap = Object.fromEntries(all.map((s) => [s.id, s.name]));

  // Normalize a dependency entry — handles raw string IDs,
  // structured { id, criticality } objects, and already-enriched
  // { id, name, criticality } objects from cached status.
  const rawId = (dep) => (typeof dep === "string" ? dep : dep.id);
  const rawCriticality = (dep) =>
    typeof dep === "string" ? "required" : dep.criticality || "required";

  // Compute inverse: dependedOnBy[targetId] = [{ id, name, criticality }, ...]
  const inverseMap = {};
  for (const item of all) {
    for (const dep of item.dependsOn || []) {
      const id = rawId(dep);
      if (!inverseMap[id]) inverseMap[id] = [];
      inverseMap[id].push({
        id: item.id,
        name: item.name,
        criticality: rawCriticality(dep),
      });
    }
  }

  // Enrich each item — resolve names and carry criticality
  for (const item of all) {
    item.dependsOn = (item.dependsOn || []).map((dep) => {
      const id = rawId(dep);
      return {
        id,
        name: nameMap[id] || id,
        criticality: rawCriticality(dep),
      };
    });
    item.dependedOnBy = inverseMap[item.id] || [];
  }

  return { services, infrastructure };
}

/**
 * GET /services
 * Returns the current health status of all registered services
 * plus infrastructure backing stores (MongoDB, MinIO, etc.).
 * If ?refresh=true, forces a fresh health check before responding.
 */
router.get("/", async (req, res, next) => {
  try {
    let services, infrastructure;

    if (req.query.refresh === "true") {
      [services, infrastructure] = await Promise.all([
        ServiceRegistryService.checkAll(),
        InfrastructureRegistryService.checkAll(),
      ]);
    } else {
      services = ServiceRegistryService.list();
      infrastructure = InfrastructureRegistryService.list();
    }

    res.json(enrichWithDependencies(services, infrastructure));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /services/check
 * Trigger a fresh health check for all services and infrastructure.
 */
router.post("/check", async (_req, res, next) => {
  try {
    const [services, infrastructure] = await Promise.all([
      ServiceRegistryService.checkAll(),
      InfrastructureRegistryService.checkAll(),
    ]);
    res.json(enrichWithDependencies(services, infrastructure));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /services/:id/restart
 * Restart a containerized service via Docker Engine API.
 */
router.post("/:id/restart", async (req, res, next) => {
  try {
    const { id } = req.params;
    const svc = SERVICES[id];

    if (!svc) {
      return res.status(404).json({ error: `Unknown service: ${id}` });
    }

    if (!svc.dockerProject) {
      return res.status(400).json({ error: `${svc.name} is not a containerized service` });
    }

    const container = svc.dockerProject;
    logger.info(`[Restart] ${svc.name} → Docker API /containers/${container}/restart`);

    const result = await dockerRequest("POST", `/containers/${container}/restart?t=10`);

    if (result.statusCode === 204) {
      logger.success(`[Restart] ${svc.name} restarted successfully`);

      // Trigger a fresh health check after a short delay
      setTimeout(() => {
        ServiceRegistryService.checkAll().catch(() => {});
      }, 3000);

      res.json({
        success: true,
        service: svc.name,
        message: "Container restarted",
      });
    } else {
      const msg = tryParseDockerError(result.body) || `Docker API error: ${result.statusCode}`;
      logger.error(`[Restart] Failed for ${svc.name}: ${msg}`);
      res.status(502).json({ error: msg });
    }
  } catch (err) {
    logger.error(`[Restart] Failed: ${err.message}`);
    next(err);
  }
});

/**
 * POST /services/:id/stop
 * Stop a containerized service via Docker Engine API.
 */
router.post("/:id/stop", async (req, res, next) => {
  try {
    const { id } = req.params;
    const svc = SERVICES[id];

    if (!svc) {
      return res.status(404).json({ error: `Unknown service: ${id}` });
    }

    if (!svc.dockerProject) {
      return res.status(400).json({ error: `${svc.name} is not a containerized service` });
    }

    const container = svc.dockerProject;
    logger.info(`[Stop] ${svc.name} → Docker API /containers/${container}/stop`);

    const result = await dockerRequest("POST", `/containers/${container}/stop?t=10`);

    if (result.statusCode === 204 || result.statusCode === 304) {
      logger.success(`[Stop] ${svc.name} stopped successfully`);

      setTimeout(() => {
        ServiceRegistryService.checkAll().catch(() => {});
      }, 3000);

      res.json({
        success: true,
        service: svc.name,
        message: result.statusCode === 304 ? "Container already stopped" : "Container stopped",
      });
    } else {
      const msg = tryParseDockerError(result.body) || `Docker API error: ${result.statusCode}`;
      logger.error(`[Stop] Failed for ${svc.name}: ${msg}`);
      res.status(502).json({ error: msg });
    }
  } catch (err) {
    logger.error(`[Stop] Failed: ${err.message}`);
    next(err);
  }
});

/**
 * POST /services/:id/start
 * Start a containerized service via Docker Engine API.
 */
router.post("/:id/start", async (req, res, next) => {
  try {
    const { id } = req.params;
    const svc = SERVICES[id];

    if (!svc) {
      return res.status(404).json({ error: `Unknown service: ${id}` });
    }

    if (!svc.dockerProject) {
      return res.status(400).json({ error: `${svc.name} is not a containerized service` });
    }

    const container = svc.dockerProject;
    logger.info(`[Start] ${svc.name} → Docker API /containers/${container}/start`);

    const result = await dockerRequest("POST", `/containers/${container}/start`);

    if (result.statusCode === 204 || result.statusCode === 304) {
      logger.success(`[Start] ${svc.name} started successfully`);

      setTimeout(() => {
        ServiceRegistryService.checkAll().catch(() => {});
      }, 3000);

      res.json({
        success: true,
        service: svc.name,
        message: result.statusCode === 304 ? "Container already running" : "Container started",
      });
    } else {
      const msg = tryParseDockerError(result.body) || `Docker API error: ${result.statusCode}`;
      logger.error(`[Start] Failed for ${svc.name}: ${msg}`);
      res.status(502).json({ error: msg });
    }
  } catch (err) {
    logger.error(`[Start] Failed: ${err.message}`);
    next(err);
  }
});

/**
 * Try to extract a message from a Docker API error response body.
 */
function tryParseDockerError(body) {
  try {
    return JSON.parse(body).message;
  } catch {
    return null;
  }
}

export default router;
