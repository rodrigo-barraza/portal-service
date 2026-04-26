// ============================================================
// Portal API — Secrets Template
// ============================================================
// Copy this file to secrets.js and fill in your real values.
//   cp secrets.example.js secrets.js
// ============================================================

// Server
export const PORT = 4001;

// MongoDB
export const MONGO_URI = "mongodb://user:password@<host>:27017/?directConnection=true&replicaSet=rs0&authSource=admin";
export const MONGO_DB_NAME = "";

// Upstream Sun services (used for health checks + data aggregation)
export const PRISM_URL = "http://localhost:7777";
export const TOOLS_API_URL = "http://localhost:5590";
export const SESSIONS_URL = "http://localhost:5557";
export const RETINA_URL = "http://localhost:3333";
export const LIGHTS_URL = "http://localhost:4444";
export const LUPOS_URL = "";

// LM Studio instances
export const LM_STUDIO_URL = "http://localhost:1234";
export const LM_STUDIO_2_URL = "";

// MinIO (S3-compatible object storage on NAS)
export const MINIO_ENDPOINT = "http://<host>:9000";
export const MINIO_ACCESS_KEY = "";
export const MINIO_SECRET_KEY = "";
