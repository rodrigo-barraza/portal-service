// ─── Vault Client ───────────────────────────────────────────
// One client for the whole process: boot.ts pulls secrets and the first
// registry through it, RegistryRefreshService the hot reloads.

import { createVaultClient } from "@rodrigo-barraza/utilities-library/vault";
import type { VaultRegistry } from "./types.ts";

export const vault = createVaultClient();

/**
 * A fresh registry, bypassing the client's cache. The library types only
 * the fields every service shares; portal reads the whole document
 * (devices, dependsOn, watchdog, …), described by VaultRegistry.
 */
export async function fetchVaultRegistry(): Promise<VaultRegistry | null> {
  vault.clearRegistryCache();
  return (await vault.fetchRegistry()) as unknown as VaultRegistry | null;
}
