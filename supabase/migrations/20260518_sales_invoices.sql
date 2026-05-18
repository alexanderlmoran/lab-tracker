-- Stores raw rows from Centner sales/invoice CSV imports for the
-- developer-only Sales viewer (/labs/sales).
--
-- Separate from lab_cases because:
--   • not every invoice line becomes a lab case (non-lab line items are
--     filtered out by the importer);
--   • a sales row carries financial fields (collected, due, payment type)
--     that don't belong on lab_cases.
--
-- Upsert key: (invoice_no, item_name, service_date, guest_name). Re-importing
-- the same CSV updates the existing row in place instead of duplicating.
-- 2026-05-18.

create table if not exists sales_invoices (
  id              uuid primary key default gen_random_uuid(),
  source_format   text not null check (source_format in ('guest-sales', 'item-sales')),
  bulk_import_id  uuid,
  guest_name      text not null,
  email           text,
  service_date    date not null,
  invoice_no      text not null,
  item_name       text not null,
  item_type       text,
  guest_code      text,
  center_code     text,
  center_name     text,
  item_code       text,
  qty             numeric(10,2),
  sales_ex_tax    numeric(12,2),
  collected       numeric(12,2),
  due             numeric(12,2),
  payment_type    text,
  raw_row         jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create unique index if not exists sales_invoices_dedup_idx
  on sales_invoices (invoice_no, item_name, service_date, guest_name);

create index if not exists sales_invoices_service_date_idx
  on sales_invoices (service_date desc);

create index if not exists sales_invoices_guest_name_idx
  on sales_invoices (guest_name);

create index if not exists sales_invoices_bulk_import_id_idx
  on sales_invoices (bulk_import_id);

drop trigger if exists set_sales_invoices_updated_at on sales_invoices;
create trigger set_sales_invoices_updated_at
  before update on sales_invoices
  for each row execute function set_updated_at();

alter table sales_invoices enable row level security;
