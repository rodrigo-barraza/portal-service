// ============================================================
// API Portal — Services Route
// ============================================================
// GET  /services          — returns health status for all Sun services
//                           and infrastructure backing stores.
// POST /services/check    — trigger a fresh health check.
// POST /services/:id/restart — restart a containerized service via SSH.
// Enriches each item with resolved dependency graph edges.
// ============================================================

import { Router } from "express";
import { execFile } from "child_process";
import { promisify } from "util";
import ServiceRegistryService from "../services/ServiceRegistryService.js";
import InfrastructureRegistryService from "../services/InfrastructureRegistryService.js";
import { SERVICES, DEVICES } from "../config.js";
import logger from "../utils/logger.js";

const execFileAsync = promisify(execFile);
const router = Router();

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
 * Returns the current health status of all registered Sun services
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
 * Restart a containerized service on the remote host via SSH + Docker Compose.
 * Only works for services that have a `dockerProject` in their config
 * and run on a device with an `sshAlias`.
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

    const device = DEVICES[svc.device];
    if (!device?.sshAlias) {
      return res.status(400).json({ error: `No SSH access configured for device: ${svc.device}` });
    }

    const dockerBin = device.dockerBin || "docker";
    const composeDir = `/volume1/docker/${svc.dockerProject}`;
    const sshCmd = `cd '${composeDir}' && sudo ${dockerBin} compose restart`;

    logger.info(`[Restart] ${svc.name} → ssh ${device.sshAlias} "${sshCmd}"`);

    const { stdout, stderr } = await execFileAsync("ssh", [
      "-o", "ConnectTimeout=5",
      "-o", "BatchMode=yes",
      device.sshAlias,
      sshCmd,
    ], { timeout: 30_000 });

    logger.success(`[Restart] ${svc.name} restarted successfully`);

    // Trigger a fresh health check after a short delay
    setTimeout(() => {
      ServiceRegistryService.checkAll().catch(() => {});
    }, 3000);

    res.json({
      success: true,
      service: svc.name,
      message: "Container restarted",
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    });
  } catch (err) {
    logger.error(`[Restart] Failed: ${err.message}`);
    next(err);
  }
});

export default router;
