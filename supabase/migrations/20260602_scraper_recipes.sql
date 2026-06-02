-- Recipe engine, Phase 3: DB-backed scraper recipes.
--
-- The worker's worker/src/recipes/catalog.ts holds the BUILT-IN recipes. This
-- table holds OVERRIDES / ADDITIONS managed from Settings → Scrapers. At runtime
-- the worker merges them (a DB row wins over the built-in of the same `key`) and
-- falls back to catalog-only if this table is empty or unreachable — so an
-- unapplied migration or empty table changes nothing.
--
-- A recipe row mirrors the worker LabRecipe type: transport + a strategy object
-- per axis (auth/discovery/pdf) stored as jsonb (strategy name + config), plus
-- the match/ready config. No secrets live here — configs reference env-var NAMES.

create table if not exists scraper_recipes (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique,           -- SCRAPERS registry key, e.g. "glycanage"
  lab_name    text not null,                  -- must equal lab_cases.lab_name
  transport   text not null default 'http',   -- 'http' | 'browser'
  auth        jsonb not null,                 -- { strategy, config }
  discovery   jsonb not null,                 -- { strategy, config, perCase? }
  pdf         jsonb not null,                 -- { strategy, config }
  match_cfg   jsonb,                           -- { refLooksLike? }
  ready_cfg   jsonb,                           -- { equals: [...] } | { mode: "presence" }
  enabled     boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists scraper_recipes_key_idx on scraper_recipes (key);

drop trigger if exists set_scraper_recipes_updated_at on scraper_recipes;
create trigger set_scraper_recipes_updated_at
  before update on scraper_recipes
  for each row execute function set_updated_at();
