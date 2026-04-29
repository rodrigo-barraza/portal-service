// ============================================================
// Vault Client — Secret + Registry Bootstrap Utility
// ============================================================
// Fetches secrets and infrastructure config from the Vault
// service, which serves as the single source of truth for
// both secrets and service topology.
//
// Resolution order for secrets (first wins per key):
//   1. process.env (manual env vars, Docker --env)
//   2. Local .env  (project-level overrides for local dev)
//   3. Vault       (production secret server)
//   4. Fallback    (shared vault-service/.env for offline dev)
//
// Resolution order for service URLs:
//   1. process.env override (e.g. PRISM_SERVICE_URL)
//   2. Local .env override
//   3. Vault registry (auto-constructed from DEFAULT_HOST + port)
//   4. Localhost fallback (dev-only, no DEFAULT_HOST set)
//
// Usage (in any service's boot.js):
//
//   import { createVaultClient } from "./utils/vault-client.js";
//
//   const vault = createVaultClient({
//     localEnvFile: "./.env",               // project-level overrides
//     fallbackEnvFile: "../vault-service/.env", // shared fallback
//   });
//
//   // Fetch secrets (existing behavior)
//   const secrets = await vault.fetch();
//
//   // Fetch the full infrastructure registry
//   const registry = await vault.fetchRegistry();
//   // registry.services        → [{id, label, port, url, ...}, ...]
//   // registry.infrastructure  → [{id, label, type, url, ...}, ...]
//
//   // Resolve a single service URL (with fallback chain)
//   const toolsUrl = await vault.resolveServiceUrl("tools-service");
//   // → "http://192.168.86.2:5590" (or localhost fallback)
//
// For local development:
//   cp .env.example .env
//   Fill in only the values you need to override.
//
// Configuration:
//   The client reads VAULT_SERVICE_URL and VAULT_SERVICE_TOKEN from process.env
//   (or from the local .env), or you can pass them directly.
// ============================================================

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

// ── Default Configuration ──────────────────────────────────────
const DEFAULT_VAULT_SERVICE_URL = "http://192.168.86.2:5599";
const FETCH_TIMEOUT_MS = 3_000;

/**
 * Parse a .env file into a key-value object.
 * Supports quoted values, comments, and blank lines.
 */
function parseEnvFile(filePath) {
  const absolutePath = resolve(filePath);

  if (!existsSync(absolutePath)) {
    return null;
  }

  const content = readFileSync(absolutePath, "utf-8");
  const parsed = {};

  for (const line of content.split("\n")) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    parsed[key] = value;
  }

  return parsed;
}

/**
 * Create a Vault client instance.
 *
 * @param {object} options
 * @param {string} [options.localEnvFile]      - Project-level .env for local dev overrides (highest priority)
 * @param {string} [options.vaultUrl]          - Vault service URL (default: http://192.168.86.2:5599)
 * @param {string} [options.vaultToken]        - Bearer token for Vault auth
 * @param {string} [options.fallbackEnvFile]   - Path to shared .env file for offline fallback (lowest priority)
 * @param {string[]} [options.keys]            - Specific keys to request from Vault (omit for all)
 * @param {string} [options.prefix]            - Filter Vault keys by prefix
 * @param {string} [options.exclude]           - Exclude Vault keys matching these prefixes (comma-separated)
 */
export function createVaultClient(options = {}) {
  const { localEnvFile, fallbackEnvFile, keys, prefix, exclude } = options;

  // ── Internal state ─────────────────────────────────────────
  // Cached after first fetch so registry calls can reuse them.
  let _localOverrides = null;
  let _vaultUrl = null;
  let _vaultToken = null;
  let _cachedRegistry = null;

  /**
   * Resolve vault connection parameters from local overrides or process.env.
   * Called lazily on first use and cached for the lifetime of the client.
   */
  function resolveVaultConnection() {
    if (_vaultUrl !== null) return;

    // Load local .env overrides (if not already loaded)
    if (localEnvFile && _localOverrides === null) {
      _localOverrides = parseEnvFile(localEnvFile) || {};
    }

    const local = _localOverrides || {};

    _vaultUrl =
      options.vaultUrl ||
      local.VAULT_SERVICE_URL ||
      process.env.VAULT_SERVICE_URL ||
      DEFAULT_VAULT_SERVICE_URL;

    _vaultToken =
      options.vaultToken ||
      local.VAULT_SERVICE_TOKEN ||
      process.env.VAULT_SERVICE_TOKEN ||
      "";
  }

  return {
    /**
     * Fetch and merge secrets from all sources.
     *
     * Merge order (later sources fill in gaps, never overwrite):
     *   1. Local .env       → project-level overrides
     *   2. Vault service    → production secrets
     *   3. Fallback .env    → shared vault-service/.env for offline dev
     *
     * Returns: plain object of { KEY: "value" } pairs.
     */
    async fetch() {
      const merged = {};

      // ── 1. Local .env (highest priority) ────────────────────
      if (localEnvFile) {
        const local = parseEnvFile(localEnvFile);
        if (local) {
          Object.assign(merged, local);
          _localOverrides = local;
          console.warn(`📋 Local .env → loaded ${Object.keys(local).length} overrides`);
        }
      }

      // Resolve vault connection from local overrides or process.env
      resolveVaultConnection();

      // ── 2. Vault service ────────────────────────────────────
      if (_vaultToken) {
        try {
          const params = new URLSearchParams();
          if (keys?.length) params.set("keys", keys.join(","));
          if (prefix) params.set("prefix", prefix);
          if (exclude) params.set("exclude", exclude);

          const queryString = params.toString();
          const url = `${_vaultUrl}/secrets${queryString ? "?" + queryString : ""}`;

          const res = await fetch(url, {
            headers: { Authorization: `Bearer ${_vaultToken}` },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          });

          if (!res.ok) {
            throw new Error(`HTTP ${res.status} — ${res.statusText}`);
          }

          const secrets = await res.json();

          // Merge — local .env values take precedence
          for (const [key, value] of Object.entries(secrets)) {
            if (merged[key] === undefined) {
              merged[key] = value;
            }
          }

          console.warn(`🔐 Vault → loaded ${Object.keys(secrets).length} secrets`);
        } catch (err) {
          console.warn(`⚠️  Vault unreachable (${err.message})`);
        }
      } else {
        console.warn("⚠️  No VAULT_SERVICE_TOKEN set — skipping Vault");
      }

      // ── 3. Fallback: shared .env file ───────────────────────
      if (fallbackEnvFile) {
        const fallback = parseEnvFile(fallbackEnvFile);
        if (fallback) {
          let filled = 0;
          for (const [key, value] of Object.entries(fallback)) {
            if (merged[key] === undefined) {
              merged[key] = value;
              filled++;
            }
          }
          if (filled > 0) {
            console.warn(`📄 Fallback .env → filled ${filled} remaining vars`);
          }
        }
      }

      if (Object.keys(merged).length === 0) {
        console.warn("⚠️  No secrets loaded from any source");
      }

      return merged;
    },


    /**
     * Fetch the full infrastructure registry from the Vault service.
     *
     * Returns an object with:
     *   - services[]        — enriched with resolved URLs
     *   - infrastructure[]  — enriched with resolved URLs
     *   - version           — manifest schema version
     *
     * The result is cached after the first successful fetch.
     */
    async fetchRegistry() {
      if (_cachedRegistry) return _cachedRegistry;

      resolveVaultConnection();

      if (!_vaultToken) {
        console.warn("⚠️  No VAULT_SERVICE_TOKEN set — cannot fetch registry");
        return { version: 0, services: [], infrastructure: [] };
      }

      try {
        const url = `${_vaultUrl}/registry`;

        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${_vaultToken}` },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });

        if (!res.ok) {
          throw new Error(`HTTP ${res.status} — ${res.statusText}`);
        }

        _cachedRegistry = await res.json();
        console.warn(`📋 Registry → ${_cachedRegistry.services?.length || 0} services, ${_cachedRegistry.infrastructure?.length || 0} infrastructure`);
        return _cachedRegistry;
      } catch (err) {
        console.warn(`⚠️  Registry unreachable (${err.message})`);
        return { version: 0, services: [], infrastructure: [] };
      }
    },


    /**
     * Resolve a single service URL by its ID.
     *
     * Resolution order:
     *   1. process.env[urlEnv]  (e.g. PRISM_SERVICE_URL in environment)
     *   2. Local .env override
     *   3. Vault registry       (resolved URL from master .env)
     *   4. http://localhost:{port}  (from manifest port field)
     *
     * @param {string} serviceId — e.g. "prism-service", "tools-service"
     * @returns {Promise<string|null>} — resolved URL, or null if service not found
     */
    async resolveServiceUrl(serviceId) {
      const registry = await this.fetchRegistry();
      const service = (registry.services || []).find((s) => s.id === serviceId);

      if (!service) {
        console.warn(`⚠️  Service "${serviceId}" not found in registry`);
        return null;
      }

      // 1. process.env override
      if (service.urlEnv && process.env[service.urlEnv]) {
        return process.env[service.urlEnv];
      }

      // 2. Local .env override
      const local = _localOverrides || {};
      if (service.urlEnv && local[service.urlEnv]) {
        return local[service.urlEnv];
      }

      // 3. Vault-resolved URL (already enriched by the registry endpoint)
      if (service.url) {
        return service.url;
      }

      // 4. Localhost fallback
      if (service.port) {
        return `http://localhost:${service.port}`;
      }

      return null;
    },


    /**
     * Resolve a single infrastructure URL by its ID.
     *
     * @param {string} infraId — e.g. "mongodb", "minio"
     * @returns {Promise<string|null>} — resolved URL, or null if not found
     */
    async resolveInfraUrl(infraId) {
      const registry = await this.fetchRegistry();
      const infra = (registry.infrastructure || []).find((i) => i.id === infraId);

      if (!infra) {
        console.warn(`⚠️  Infrastructure "${infraId}" not found in registry`);
        return null;
      }

      // 1. process.env override
      if (infra.urlEnv && process.env[infra.urlEnv]) {
        return process.env[infra.urlEnv];
      }

      // 2. Local .env override
      const local = _localOverrides || {};
      if (infra.urlEnv && local[infra.urlEnv]) {
        return local[infra.urlEnv];
      }

      // 3. Vault-resolved URL
      if (infra.url) {
        return infra.url;
      }

      return null;
    },


    /**
     * Clear the cached registry, forcing the next fetchRegistry() to
     * re-fetch from the Vault service.
     */
    clearRegistryCache() {
      _cachedRegistry = null;
    },
  };
}
