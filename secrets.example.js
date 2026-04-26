// ============================================================
// API — Secrets Template
// ============================================================
// Secrets are resolved from (in priority order):
//   1. process.env (manual env vars, Docker --env)
//   2. Vault service (via src/boot.js → VAULT_URL + VAULT_TOKEN)
//   3. Fallback .env file (../vault/.env)
//
// See vault/.env.example for the full list of variables.
// ============================================================

// API_PORT=4001
// MONGO_URI=mongodb://user:password@<host>:27017/?directConnection=true&replicaSet=rs0&authSource=admin
// API_MONGO_DB_NAME=portal
// PORTAL_URL=http://localhost:5173
// PORTAL_API_URL=http://localhost:4001
// PRISM_URL=http://192.168.86.2:7777
// TOOLS_API_URL=http://localhost:5590
// SESSIONS_URL=http://localhost:5557
// RETINA_URL=http://localhost:3333
// LIGHTS_URL=http://localhost:4444
// LUPOS_URL=
// VAULT_URL=http://192.168.86.2:5599
// ROD_DEV_URL=http://192.168.86.2:3000
// LM_STUDIO_URL=http://localhost:1234
// LM_STUDIO_2_URL=
// MINIO_ENDPOINT=http://<host>:9000
// MINIO_ACCESS_KEY=
// MINIO_SECRET_KEY=
