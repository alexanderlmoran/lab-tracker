// Recipe engine, Phase 3: load recipes = built-in catalog + DB overrides.
//
// The DB (via the app's /api/worker/recipes endpoint) holds overrides/additions
// managed from Settings → Scrapers; a DB row wins over the built-in of the same
// key. Any failure (endpoint down, table absent, env unset) cleanly falls back
// to the catalog, so behavior is unchanged until someone adds DB rows. Cached
// for a minute to keep the /run hot path cheap.

import { request } from "undici";
import { RECIPES } from "./catalog.js";
import type { LabRecipe } from "./types.js";

const BASE = process.env.TRACKER_BASE_URL;
const SECRET = process.env.WORKER_SHARED_SECRET;
const TTL_MS = 60_000;

let cache: { at: number; recipes: LabRecipe[] } | null = null;

export async function loadRecipes(now = Date.now()): Promise<LabRecipe[]> {
  if (cache && now - cache.at < TTL_MS) return cache.recipes;
  const recipes = await mergeWithDb(RECIPES);
  cache = { at: now, recipes };
  return recipes;
}

async function mergeWithDb(builtins: LabRecipe[]): Promise<LabRecipe[]> {
  if (!BASE || !SECRET) return builtins;
  try {
    const res = await request(`${BASE}/api/worker/recipes`, {
      method: "GET",
      headers: { authorization: `Bearer ${SECRET}` },
    });
    if (res.statusCode !== 200) {
      await res.body.dump();
      return builtins;
    }
    const json = (await res.body.json()) as { recipes?: LabRecipe[] };
    const overrides = json.recipes ?? [];
    if (overrides.length === 0) return builtins;
    const byKey = new Map(builtins.map((r) => [r.key, r]));
    for (const o of overrides) byKey.set(o.key, o); // DB overrides / adds by key
    return [...byKey.values()];
  } catch {
    return builtins; // network/parse error → safe fallback
  }
}
