// ============================================================
// API — Boot Sequence
// ============================================================
// Bootstraps secrets from Vault (or .env fallback) into
// process.env, then fetches the service registry and
// initializes the config module before any routes load.
// ============================================================

import { createVaultClient } from "./utils/vault-client.js";

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
const registry = await vault.fetchRegistry();

const { initializeRegistry, injectLmStudioInstances } = await import("./config.js");
initializeRegistry(registry);
injectLmStudioInstances();

// ── 3. Start the server ───────────────────────────────────────
await import("./index.js");
