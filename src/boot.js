// ============================================================
// API — Boot Sequence
// ============================================================
// Bootstraps secrets from Vault (or .env fallback) into
// process.env before any module imports run.
// ============================================================

import { createVaultClient } from "./utils/vault-client.js";

const vault = createVaultClient({
  localEnvFile: "./.env",
  fallbackEnvFile: "../vault-service/.env",
});

const secrets = await vault.fetch();

for (const [key, value] of Object.entries(secrets)) {
  if (process.env[key] === undefined) {
    process.env[key] = value;
  }
}

await import("./index.js");
