// ─── Services Routes ────────────────────────────────────────
// Registry health: the service + infrastructure status list, forced
// re-checks, and registry hot-reload. Lifecycle actions live in
// ServiceControlRoutes, GitHub metadata in RepositoryInsightsRoutes —
// all three are mounted at /services.

import { Router, type Request, type Response } from "express";
import { HttpError } from "@rodrigo-barraza/utilities-library/service";
import ServiceRegistryService from "../services/ServiceRegistryService.ts";
import InfrastructureRegistryService from "../services/InfrastructureRegistryService.ts";
import WatchdogService from "../services/WatchdogService.ts";
import { reloadRegistry } from "../services/RegistryRefreshService.ts";
import logger from "../utils/logger.ts";
import { ServiceDependencyEnricher } from "./helpers/ServiceDependencyEnricher.ts";

const router = Router();

/** Watchdog state (push-heartbeat age, down-since) the portal cards render beside checkedAt. */
function withWatchdogState<Item extends object>(item: Item, stateId: string) {
  const state = WatchdogService.getState(stateId);
  if (!state) return item;
  return {
    ...item,
    watchdogStatus: state.status,
    lastHeartbeatAt: state.lastHeartbeatAtMs !== null ? new Date(state.lastHeartbeatAtMs).toISOString() : null,
    downSince: state.unhealthySinceMs !== null ? new Date(state.unhealthySinceMs).toISOString() : null,
  };
}

async function servicesResponse(refresh: boolean) {
  const [services, infrastructure] = refresh
    ? await Promise.all([ServiceRegistryService.checkAll(), InfrastructureRegistryService.checkAll()])
    : [ServiceRegistryService.list(), InfrastructureRegistryService.list()];

  const enriched = ServiceDependencyEnricher.enrich(services, infrastructure);
  return {
    services: enriched.services.map((service) => withWatchdogState(service, service.id)),
    infrastructure: enriched.infrastructure.map((infra) => withWatchdogState(infra, `infra:${infra.id}`)),
  };
}

router.get("/", async (req: Request, res: Response) => {
  res.json(await servicesResponse(req.query.refresh === "true"));
});

router.post("/check", async (_req: Request, res: Response) => {
  res.json(await servicesResponse(true));
});

router.post("/reload", async (_req: Request, res: Response) => {
  const result = await reloadRegistry({ force: true });
  if (!result) {
    throw new HttpError("Vault returned empty registry", 502);
  }

  const { previousCount, newCount } = result;
  logger.success(`[Registry] Manual reload — ${previousCount} → ${newCount} projects`);

  res.json({
    success: true,
    previousCount,
    newCount,
    delta: newCount - previousCount,
    message: `Registry reloaded: ${previousCount} → ${newCount} projects`,
  });
});

export default router;
