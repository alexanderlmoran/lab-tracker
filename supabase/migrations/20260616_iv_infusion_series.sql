-- Local infusion-series ledger — own the per-patient sequence number ("this is
-- the patient's 30th PC infusion") instead of re-deriving it from PracticeBetter
-- note titles on every post. That re-derivation was fragile (free-text title
-- parsing) and racy (the auto-post drain fired before the enrich pass stamped a
-- number, so PC notes posted titled "Phosphatidylcholine Infusion" with no #).
--
-- Model: one row per (zenoti_guest_id, series). `last_number` is the highest
-- infusion number we've assigned. We SEED `last_number` ONCE from PB's highest
-- "Infusion #N" (worker reads PB a single time per patient — never again), then
-- INCREMENT it locally at post time. New patients PB has never seen seed at 0 →
-- their first PC posts as #1.
--
-- `series` generalizes the ledger beyond PC (EBOO/EBO2 are also numbered ad-hoc),
-- though only 'pc' is wired today.
--
-- DDL is applied via the Supabase dashboard SQL editor (there is no DB connection
-- string / CLI / service token in this env — see docs/PLAYBOOK.md).

create table if not exists iv_infusion_series (
  zenoti_guest_id    text not null,
  series             text not null default 'pc',
  -- highest infusion number assigned so far (the patient's current count).
  last_number        integer not null default 0,
  -- last vial count we posted ("20+2") — a prefill hint for the next visit; the
  -- authoritative per-visit vials still come from the chart / Zenoti consumables.
  last_vial_count    text,
  -- human-readable, for debugging the ledger by eye.
  patient_full_name  text,
  -- true once bootstrapped from PB. Until seeded we DON'T assign a number (we
  -- hold the post) so we never restart an established patient at #1.
  seeded             boolean not null default false,
  updated_at         timestamptz not null default now(),
  primary key (zenoti_guest_id, series)
);

-- Fast "which guests still need a one-time PB seed?" scan.
create index if not exists iv_infusion_series_seeded_idx
  on iv_infusion_series (series, seeded);
