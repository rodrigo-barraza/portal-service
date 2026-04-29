// ============================================================
// API — Secrets Template
// ============================================================
// Secrets are resolved from (in priority order):
//   1. process.env (manual env vars, Docker --env)
//   2. Vault service (via src/boot.js → VAULT_SERVICE_URL + VAULT_SERVICE_TOKEN)
//   3. Fallback .env file (../vault-service/.env)
//
// Service URLs are now resolved from the Vault service registry
// (services.json). You no longer need to configure them here.
//
// See vault-service/.env.example for the full list of variables.
// ============================================================

// PORTAL_SERVICE_PORT=4001
// MONGO_URI=mongodb://user:password@<host>:27017/?directConnection=true&replicaSet=rs0&authSource=admin
// PORTAL_SERVICE_MONGO_DB_NAME=portal
// MINIO_ENDPOINT=http://<host>:9000
// MINIO_ACCESS_KEY=
// MINIO_SECRET_KEY=
