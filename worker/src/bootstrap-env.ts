// Side-effect module: load .env.local into process.env BEFORE any other module
// reads it. Several modules (e.g. tracker-client.ts) read process.env at import
// time and throw on a missing TRACKER_BASE_URL / WORKER_SHARED_SECRET — and ES
// imports evaluate before the importing module's body, so a loadEnvLocal() call
// inside server.ts would run too late. Importing this FIRST guarantees the env is
// loaded before those modules evaluate. No-op on Fly (env already set; no file).
import { loadEnvLocal } from "./lib/load-env.js";

loadEnvLocal();
