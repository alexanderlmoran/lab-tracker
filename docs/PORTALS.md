# Portal registry — every login this project touches

Single source of truth for **where each portal lives, who logs in, and whether it's
automated**. Built from the curated Chrome bookmarks (`bookmarks_6_17_26.html`) +
the saved Chrome passwords (`Chrome_Passwords.csv`). Both raw files are **gitignored**
(local only) — this doc is the committed, password-free version.

**Credentials:** scraped labs read creds from `.env.local` (env var names below);
everything else has its login in `Chrome_Passwords.csv` (local) — **no passwords in
this file or git**. For a manual portal, drive it with **Claude-in-Chrome** against
Alex's logged-in session (see `.claude/skills/live-capture`), or build an HTTP scraper
(pattern: `worker/src/scrapers/*` + a row in `src/lib/scrapers/registry.ts`).

> When you add/move a portal, update this table **and** `src/lib/scrapers/registry.ts`
> (the portal-health probe + scraper dispatch read from there).

## Core apps & infrastructure

| Portal | URL | Login (user) | Creds | Role |
|---|---|---|---|---|
| **The app (Centner Labs)** | https://www.centnerlabs.com (prod; alias lab-tracker-one.vercel.app) | alex@centnerhb.com | Supabase auth | Lab Tracker itself (`/labs`, IV `/labs/iv`) |
| **Zenoti** | https://ids.zenoti.com/Account/Login (tenant `centnerwellness`) | alex@centnerwellness.com | env `ZENOTI_*` | Appt sync + guest profiles (HTTP, headless session) |
| **PracticeBetter** | https://my.practicebetter.io | alex@centnerhb.com | env `PB_*` | Lab uploads + IV notes (egress via Tailscale exit node) |
| **Gmail (labs@)** | https://mail.google.com (labs@centnerhb.com) | labs@centnerhb.com | env `GOOGLE_*` OAuth | Inbound lab-email ingest + Kennedy→BodyBio forward |
| **Supabase** | https://supabase.com/dashboard/project/oohgjlatfkdckopmbpcc | alex@centnerhb.com | env `SUPABASE_*` | Postgres + Auth + Storage |
| **FedEx** | https://www.fedex.com/secure-login | track key `…bda5`, pickup `CW2333` | env `FEDEX_*` | Tracking (`FEDEX_API_KEY`=track/bda5) + pickup (`FEDEX_PICKUP_API_KEY`=db74) |
| **UPS** | https://id.ups.com | Centnerwellness | csv | Cyrex ships UPS — not integrated (manual) |

## Scraped labs — automated (creds in `.env.local`)

| Lab | Login URL | Creds | Scraper | Notes |
|---|---|---|---|---|
| **Access** | https://accessmedlab.com/ · https://access.labsvc.net/labgen/ | env `ACCESS_*` | ✅ HTTP | labgen ExtJS; `+repdown` POST |
| **Cyrex** | https://www.cyrexlabs.com/Home/tabid/40/Default.aspx | env `CYREX_*` | ✅ HTTP | DNN/RadGrid; search by requisition# |
| **Doctors Data** | https://www.doctorsdata.com/sign-in | env `DOCTORSDATA_*` | ✅ HTTP | ASP.NET auto-login; report-by-ReportURL |
| **Genova (GDX)** | https://www.gdx.net/mygdx/login | env `GENOVA_*` | ✅ HTTP | reCAPTCHA+MFA → periodic manual re-auth (session) |
| **GlycanAge** | https://partners.glycanage.com/ | env `GLYCANAGE_*` | ✅ HTTP | Firebase auto-login (tenant `partners-0ly75`) |
| **SpectraCell** | https://spec-portal.com/ (Orchard Copia) | env `SPECTRACELL_*` | ✅ HTTP | slow; activate row → Print Selected |
| **Vibrant** | https://portal.vibrant-wellness.com/ | env `VIBRANT_*` | ✅ HTTP | AllSummaryReport route (whole order) |
| **Kennedy Krieger** | _email-only (no portal)_ | — | 📧 email | Gmail ingest → forward to BodyBio |

## Manual / Claude-Chrome lab portals (bookmarked, creds in `Chrome_Passwords.csv`)

No scraper yet — log in via Claude-in-Chrome on Alex's session, or build a scraper.

| Portal | Login URL | Login (user) | Notes |
|---|---|---|---|
| **Infectolabs** | https://infectolab.qbench.net/ | info@centnerhb.com | QBench LIMS |
| **Microbiome Labs** | https://microbiomelabs.com/my-account/ | info@nextwavehb.com | WooCommerce account |
| **MicroGen Diagnostics (orders)** | https://microgendx.com/my-account/ | labs@centnerhb.com | ordering |
| **MicroGenDX Provider Portal** | https://providerportal.microgendx.com/requisitions | LABSCHB | requisitions/results |
| **RGCC** | results: https://www.rgcc-group.com/ · bookmark is the **training** site usa-rgcccollege.talentlms.com | — | in `registry.ts` (no scraper); results portal ≠ bookmarked training site |
| **TruDiagnostic (TrueAge)** | https://portal.trudiagnostic.com/sign-in | labs@centnerhb.com | epigenetic age |
| **SpectraCell Provider** | https://www.spectracell.com/user-sign-in | LABS@CENTNERHB.COM | separate from the spec-portal Copia scraper |

## Pharmacy

| Portal | Login URL | Login (user) | Notes |
|---|---|---|---|
| **Wellness Pharmacy (Pharmetika)** | https://wellnessrx.pharmetika.com/provider_access/login | Sbarbour | compounding Rx |
| **Vertisis** | https://vertisis.net/ | _no stored cred_ | compounding pharmacy |

## Reference Google Sheets (read-only context)

| Sheet | URL |
|---|---|
| Lab Shipping | https://docs.google.com/spreadsheets/d/10E2y2ofEjVNnt9Vp-N38rQ3NdhFkoEJXkofiMN1ghtA/edit |
| Lab Tracker - Complete (legacy) | https://docs.google.com/spreadsheets/d/1nC6UX3i26nBY-bHqLElQ5AdN_TBaCZPxQwWozHRznJI/edit |
| Client Journey | https://docs.google.com/spreadsheets/d/1AxSYTroAKt2GRnw2NBD28m_0KuNil25b8z9yF-_VjnA/edit |

## Other bookmarked apps (not Lab Tracker core)

GoHighLevel (CRM, app.gohighlevel.com), Orders (SharePoint dlccapitalmgmt), Peptide
Research Institute / Peptide Calculator (reference). Listed for completeness; no
integration.
