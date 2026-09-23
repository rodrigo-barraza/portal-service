// ─── Boot Sequence ──────────────────────────────────────────
// Secrets must be in process.env before config.ts is evaluated, so
// everything past step 1 is imported dynamically.

import { createLogger } from "@rodrigo-barraza/utilities-library/node";
import type { VaultRegistry } from "./types.ts";
import { vault, fetchVaultRegistry } from "./vault.ts";

const bootLogger = createLogger("portal");

// ── 1. Fetch secrets → process.env ────────────────────────────
const secrets = await vault.fetch();

for (const [key, value] of Object.entries(secrets)) {
  if (process.env[key] === undefined) {
    process.env[key] = value;
  }
}

// ── 2. Fetch registry → initialize config ─────────────────────
// Vault may not be fully ready yet (Docker Compose boot race), so retry
// the registry fetch a few times; index.ts keeps retrying in the
// background if it is still empty.
const REGISTRY_RETRIES = 5;
const REGISTRY_RETRY_DELAY_MS = 2_000;

const { applyRegistry, hasProjects } = await import("./services/RegistryRefreshService.ts");

let registry: VaultRegistry | null = null;

for (let attempt = 1; attempt <= REGISTRY_RETRIES; attempt++) {
  registry = await fetchVaultRegistry();
  if (hasProjects(registry)) break;

  if (attempt < REGISTRY_RETRIES) {
    bootLogger.warn(`Registry empty (attempt ${attempt}/${REGISTRY_RETRIES}) — retrying in ${REGISTRY_RETRY_DELAY_MS}ms…`);
    await new Promise((resolve) => setTimeout(resolve, REGISTRY_RETRY_DELAY_MS));
  }
}

if (hasProjects(registry)) {
  applyRegistry(registry);
}

// ── 3. Start the server ───────────────────────────────────────
await import("./index.ts");
