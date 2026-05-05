// ============================================================
// API — Boot Sequence
// ============================================================
// Bootstraps secrets from Vault (or .env fallback) into
// process.env, then fetches the service registry and
// initializes the config module before any routes load.
// ============================================================

import { createVaultClient } from "@rodrigo-barraza/utilities/vault";

const vault = createVaultClient({
  localEnvFile: "./.env",
  fallbackEnvFile: "../vault-service/.env",
});

// ── 1. Fetch secrets → process.env ────────────────────────────
const secrets = await vault.fetch();

for (const [key, value] of Object.entries(secrets)) {
  if (process.env[key] === undefined) {
    process.env[key] = value;
  }
}

// ── 2. Fetch registry → initialize config ─────────────────────
// Vault may not be fully ready yet (Docker Compose boot race),
// so retry the registry fetch a few times before falling back.
const REGISTRY_RETRIES = 5;
const REGISTRY_RETRY_DELAY_MS = 2_000;

let registry = null;

for (let attempt = 1; attempt <= REGISTRY_RETRIES; attempt++) {
  vault.clearRegistryCache();
  registry = await vault.fetchRegistry();

  if (registry.services?.length > 0) break;

  if (attempt < REGISTRY_RETRIES) {
    console.warn(`⏳ Registry empty (attempt ${attempt}/${REGISTRY_RETRIES}) — retrying in ${REGISTRY_RETRY_DELAY_MS}ms…`);
    await new Promise((r) => setTimeout(r, REGISTRY_RETRY_DELAY_MS));
  }
}

const { initializeRegistry, injectLmStudioInstances } = await import("./config.js");
initializeRegistry(registry);
injectLmStudioInstances();

// Export vault client so index.js can schedule a deferred re-fetch
// if the registry was empty at boot time.
export { vault };

// ── 3. Start the server ───────────────────────────────────────
await import("./index.js");
