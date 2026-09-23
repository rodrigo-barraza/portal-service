# Portal Service — Infrastructure Observability API

Backend-for-frontend (BFF) for the developer portal. Federates the fleet's health, Docker container stats and logs, object storage, web analytics (GA4 + first-party sessions), external-API usage, and repository metadata behind one API — and turns the health polling into Discord alerts (watchdog).

**Port:** `4001` · **Runtime:** Node.js 26, TypeScript run directly via type stripping (`node src/boot.ts`) · **Framework:** Express 5 · **DB:** MongoDB

Consumers: `portal-client` (the dashboard) and `tools-service` (`PortalFetcher`, for agent tools).

## Architecture

```
src/
├── boot.ts          # vault secrets → process.env, registry → config, then index.ts
├── index.ts         # Express app, timers, graceful shutdown
├── config.ts        # env + registry hydration (PROJECTS / INFRASTRUCTURE / DEVICES)
├── vault.ts         # the process's vault client
├── routes/          # one router per mount; helpers/ holds pure request logic
├── services/        # registry health, Docker, MinIO, GA, Cloud Monitoring, watchdog…
├── utils/           # errors, request helpers, deduped TTL cache, logger
└── wrappers/        # Docker Engine API, GitHub, Mongo
```

- **Registry** comes from vault at boot, is re-fetched every 5 minutes (any change to projects, infrastructure or devices hot-reloads), and on `POST /services/reload`.
- **Health**: every project and infrastructure entry is probed every 60 s. Concurrent callers share one round; a healthy service must fail two consecutive rounds to show as down.
- **Watchdog**: a 30 s pass turns sustained health transitions and push-heartbeat silence into Discord alerts — one message per pass, however many targets changed. State is in memory; a restart re-pages still-down services after the confirm window (deliberate).
- **Errors** are always `{ "error": "<message>" }`. Unexpected 5xx errors answer `"Internal server error"`, and their detail stays in the log.

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/`, `/health` | Service info / liveness |
| `GET` | `/services` | Health of all services + infrastructure (`?refresh=true` re-probes), with dependency edges and watchdog state |
| `POST` | `/services/check` | Re-probe everything (same body as `?refresh=true`) |
| `POST` | `/services/reload` | Re-fetch the vault registry |
| `POST` | `/services/:id/restart` · `stop` · `start` | Lifecycle action on a registry project's container |
| `GET` / `POST` | `/services/:id/rollback-status` · `/services/:id/rollback` | Swap `:latest` ↔ `:previous` and recreate the container |
| `GET` | `/services/sizes` · `/services/languages` · `/services/analysis` | GitHub repo size, Linguist languages, detected import/API edges |
| `POST` | `/containers/:name/restart` · `stop` · `start` `?device=` | Lifecycle action on any container by name |
| `GET` | `/containers/previews/:domain` | Cached screenshot of a registered client domain |
| `GET` | `/devices` | Hosts with their services, infrastructure and live hardware specs |
| `GET` | `/stats/containers` · `/stats/containers/history` · `/stats/containers/metrics` | Live Docker stats, 5 s ring buffer, persisted 30 s samples (7-day TTL) |
| `GET` | `/stats/system` · `/stats/storage` | Docker disk usage · MinIO bucket totals |
| `POST` | `/stats/invalidate` | Drop the Docker stats caches |
| `GET` | `/logs` · `/logs/:container` | Loggable containers · SSE log stream (`?tail&follow=1&level&search&since&device`) |
| `GET` | `/integrations` | Configured third-party keys (configured flag + 8-hex SHA-256 fingerprint only) |
| `GET` / `DELETE` | `/object-store/…` | Buckets (+ SSE stream), objects, stat, download (Range), search, delete |
| `GET` | `/google-analytics/…` | GA4 reports per registry property |
| `GET` | `/session-analytics/…` | Proxy to sessions-service `/stats/*` |
| `GET` | `/external-apis` · `/external-apis/timeseries` | Third-party API usage (Cloud Monitoring + prism + tools-service) |
| `POST` / `GET` | `/watchdog/heartbeat/:token/:projectId[/fail]` · `/watchdog` | Healthchecks.io-compatible push heartbeat · watchdog state |

Auth on the destructive endpoints is deliberately deferred for now.

## Docker Integration

Container lifecycle, stats and logs go through the **Docker Engine API**: the mounted socket (`/var/run/docker.sock`) on the NAS and `tcp://` endpoints for remote hosts, both taken from the registry's `devices`.

## Development

```bash
pnpm install
pnpm dev             # node --watch src/boot.ts (needs vault reachable, or the env it would provide)
pnpm typecheck       # tsc --noEmit
pnpm lint            # oxlint
pnpm test            # vitest
pnpm deploy          # build + deploy to the NAS via ../deploy-kit
```

Every host, port and URL comes from vault (`vault-service/projects.json`). Nothing is hardcoded here.
