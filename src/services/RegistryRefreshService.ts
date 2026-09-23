// ─── Registry Refresh ───────────────────────────────────────
// Applies vault registries: the one boot.ts fetched, the deferred
// recovery when vault wasn't ready at boot, the 5-minute hot reload, and
// POST /services/reload. Changes are detected over the whole document
// (projects, infrastructure, devices) — not just the project count — so
// edits to an existing entry hot-reload too.

import { initializeRegistry, PROJECTS } from "../config.ts";
import type { VaultRegistry } from "../types.ts";
import { fetchVaultRegistry } from "../vault.ts";
import ServiceRegistryService from "./ServiceRegistryService.ts";
import InfrastructureRegistryService from "./InfrastructureRegistryService.ts";

let appliedFingerprint: string | null = null;

function registryFingerprint(registry: VaultRegistry): string {
  return JSON.stringify([
    registry.projects,
    registry.infrastructure ?? [],
    registry.devices ?? [],
  ]);
}

export function hasProjects(
  registry: VaultRegistry | null | undefined,
): registry is VaultRegistry {
  return Array.isArray(registry?.projects) && registry.projects.length > 0;
}

/** Hydrate config from a registry and remember what was applied. */
export function applyRegistry(registry: VaultRegistry): void {
  initializeRegistry(registry);
  appliedFingerprint = registryFingerprint(registry);
}

export interface RegistryReloadResult {
  changed: boolean;
  previousCount: number;
  newCount: number;
}

/**
 * Fetch the registry from vault and apply it if it changed (or always,
 * with `force`). Returns null — keeping the current registry — when vault
 * answers with no projects (e.g. still booting).
 */
export async function reloadRegistry({
  force = false,
}: { force?: boolean } = {}): Promise<RegistryReloadResult | null> {
  const registry = await fetchVaultRegistry();
  if (!hasProjects(registry)) return null;

  const previousCount = Object.keys(PROJECTS).length;
  const changed = registryFingerprint(registry) !== appliedFingerprint;

  if (changed || force) {
    applyRegistry(registry);
    // Probe new/changed entries now rather than on the next 60s tick
    ServiceRegistryService.checkAll().catch(() => {});
    InfrastructureRegistryService.checkAll().catch(() => {});
  }

  return { changed, previousCount, newCount: Object.keys(PROJECTS).length };
}
