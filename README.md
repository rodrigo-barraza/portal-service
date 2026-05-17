# Portal — Infrastructure Observability API

Backend-for-frontend (BFF) aggregator for the developer portal dashboard. Federates data from Prism, Tools API, and other services to provide unified health monitoring, log streaming, usage statistics, device topology, and API integration auditing across the entire ecosystem.

**Port:** `4001` · **Runtime:** Node.js (TypeScript) · **Framework:** Express 5 · **DB:** MongoDB

## Architecture

### Directory Structure

```
portal-service/
├── src/
│   ├── middleware/          # Request logging
│   ├── routes/              # Express route handlers (6 routes)
│   ├── services/            # Registry, infrastructure, stats aggregation
│   ├── utils/               # Logger, error handler
│   └── wrappers/            # MongoDB connection wrapper
├── tests/                   # Vitest test suites
└── package.json
```

### Core Services

| Service | Purpose |
|---|---|
| **ServiceRegistryService** | Periodic health checks for all registered services (60s interval), cached status |
| **InfrastructureRegistryService** | Health monitoring for backing stores (MongoDB, MinIO) |
| **StatsAggregatorService** | Cached usage stats from Prism admin API (30s TTL) |

### Boot Sequence

1. Fetches secrets + project registry from Vault via `@rodrigo-barraza/utilities-library/vault`
2. Builds `SERVICES`, `INFRASTRUCTURE`, and `DEVICES` maps from the registry
3. Runs initial health check of all services and infrastructure
4. Starts periodic health checks every 60 seconds
5. If registry was empty at boot (Vault not ready), retries every 10s for up to 5 minutes

## API Endpoints

### Services

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/services` | Health status of all services + infrastructure. `?refresh=true` forces fresh check |
| `POST` | `/services/check` | Trigger a fresh health check |
| `POST` | `/services/:id/restart` | Restart a containerized service via Docker Engine API |
| `POST` | `/services/:id/stop` | Stop a containerized service |
| `POST` | `/services/:id/start` | Start a containerized service |

### Devices

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/devices` | Device topology — all hosts with their services and health status |

### Stats

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/stats` | Aggregated usage overview from Prism |
| `GET` | `/stats/breakdown` | Request breakdown by period (`?period=24h\|7d\|30d`) |
| `GET` | `/stats/projects` | Per-project usage stats |
| `POST` | `/stats/invalidate` | Force-clear the stats cache |

### Logs

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/logs` | List services that support log streaming |
| `GET` | `/logs/:id` | Stream container logs via SSE (`?tail=200&follow=1`) |

### Integrations

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/integrations` | Configured API integrations grouped by category, with masked keys |

### System

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/` | Service info with endpoint listing |

## Docker Integration

Container lifecycle operations (restart, stop, start) and log streaming are performed via the **Docker Engine API** over the mounted Unix socket (`/var/run/docker.sock`). The socket must be mounted into the container for these features to work.

## Prerequisites

- **Node.js** v20+ (TypeScript)
- **MongoDB** — service snapshot persistence
- **Vault Service** — registry and secrets at boot
- **Docker socket mount** — for container management and log streaming

## Tech Stack

| Dependency | Purpose |
|---|---|
| Express 5 | HTTP framework |
| MongoDB | Database driver |
| MinIO | S3-compatible storage client |
| Vitest | Testing framework |

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Configure secrets
cp secrets.example.ts secrets.ts
# Edit secrets.ts with your MongoDB URI, Vault credentials, etc.

# 3. Start the server
npm run dev        # Development (auto-reload with nodemon)
npm start          # Production
```

## Scripts

```bash
npm run start         # Start server
npm run dev           # Start with auto-reload (nodemon)
npm run lint          # Run ESLint
npm run lint:fix      # Auto-fix lint issues
npm run format        # Format with Prettier
npm run format:check  # Check formatting
npm test              # Run tests (Vitest)
npm run test:watch    # Run tests in watch mode
npm run deploy        # Deploy to production
npm run deploy:dry    # Validate deployment without deploying
```

## Deploy

```bash
npm run deploy          # Full deploy to Synology NAS
npm run deploy:dry      # Validate without deploying
```
