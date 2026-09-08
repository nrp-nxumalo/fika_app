# FikaApp 🚌

**FikaApp** is a simple, user-friendly transit timetable viewer built with **JavaScript**. It aims to make accessing and understanding public transport schedules—like those of MyCiTi Bus and Golden Arrow—much 
easier than downloading static PDFs from transit websites.

## 🚀 Features

- 🔍 **Searchable Timetables**: Quickly search for a specific route’s schedule.
- 🔁 **Route Direction Toggle**: Flip between outbound and return directions for any route using a convenient radio button.
- 🧭 **Cleaner UI**: No more sifting through PDF documents—FikaApp presents the data in a clean and readable format.
- 📱 **Saved Offline Timetables**: Pin timetable data in the browser and reopen it from one offline-ready hub.
- 🚌 **Current Support**: Displays **MyCiTi** and **Golden Arrow** timetables.
- 🛠️ **Coming Soon**: Integration of train schedules.

## 🛠 Tech Stack

- React/JavaScript
- HTML & CSS

## 📦 Future Plans

- Add support for train timetables.
- Mobile-first UX enhancements.

## Preview 
[Watch the demo](https://youtu.be/RCbFUW39EwI)

## Search-friendly timetable URLs

Public timetable pages use the route's stable agency and operator code:

```text
/timetables/golden-arrow/route-0004-atlantis-cape-town
/timetables/myciti/route-214a-parklands-table-view
```

Numeric database IDs remain internal to `/schedule_times/:id` and `/api/v2/schedule_times/:id`. Historic numeric page URLs are stored in `route_url_aliases` and redirect with HTTP 301. Timetable replacement imports preserve these aliases before deleting routes.

## Saved timetables and offline access

Timetables pinned with **Save offline** appear at `/saved-timetables`. Saved route metadata and timetable payloads remain in that browser's IndexedDB; they are not attached to an account or synced between devices. The production service worker caches only the application shell and static assets so the saved hub and cached timetable URLs can cold-start without a network connection. API timetable payloads are not stored in Cache Storage.

Offline access requires at least one successful online visit on the browser. Removing a timetable from the saved hub unpins it but leaves the normal short-lived recent-view cache behavior intact.

## Timetable source verification

The maintained verification implementation lives in `timetable_verification/`. It keeps the operator-specific PDF layouts behind `MyCitiAdapter` and `GabsAdapter`, while sharing HTTP pacing, SHA-256 fingerprinting, canonical data, comparisons, PostgreSQL persistence, and audit planning. This keeps Python - the language already used by the original scrapers and extractors - without turning the two very different PDF formats into one large parser class.

The daily workflow is deliberately review-gated:

1. Crawl each official catalogue once, sequentially, with an identifying user agent, at least 1.5 seconds plus jitter between requests to the same host, bounded retries, and `Retry-After` support.
2. Download every PDF even when its filename is unchanged and calculate SHA-256 over the actual bytes.
3. Parse to deterministic canonical JSON and calculate a second content hash. Parser failures and zero-timetable PDFs are quarantined with the captured PDF; they cannot be published.
4. Store the registry, immutable PDF evidence, extraction, departure-count/time diff, check result, and dated event in PostgreSQL. A changed version becomes `changed_review_required`; the job never writes passenger-facing timetable rows.
5. Review the exact captured PDF and comparison at `/admin/timetable-reliability`. `Approve and publish` applies the candidate in one transaction and clears the affected API cache. Withdrawal is also explicit and attributable.
6. Build one stratified human audit queue per week, targeting 200 departure cells and enforcing at least 100. The queue covers both operators, direction ordinals, service days, first and last departures, and footnoted trips when those categories are available.

Golden Arrow regular and public-holiday PDFs can describe the same directions. Publication therefore composes independent `weekday`, `saturday`, `sunday`, and `public_holiday` families with trip-level source/version provenance; approving a holiday PDF cannot erase regular service. A later withdrawal restores the next-newest approved contribution for that family.

### Accuracy claim

**Source accuracy** means Fika displays the timetable published in the cited operator PDF. The registry, review history, and weekly count are evidence for that claim, for example: `198 of 200 sampled departures matched the cited operator PDF.`

**Operational punctuality** means the bus actually arrives at that time. Fika does not currently measure live vehicle operations and does not claim to prove punctuality.

### Local verification

Python and dependency versions are pinned in `.python-version` and `requirements.txt`.

```bash
python -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m unittest discover -s tests_python -v
```

Exercise a small live source sample without database writes:

```bash
.venv/bin/python -m timetable_verification.check_sources \
  --dry-run --operator myciti --limit 1
```

Run the real checker only against the intended database:

```bash
DATABASE_URL='postgresql://...' \
  .venv/bin/python -m timetable_verification.check_sources
```

Parser revisions are operator-specific: MyCiTi uses `PARSER_VERSION` and Golden Arrow uses `GABS_PARSER_VERSION` in `timetable_verification/__init__.py`. Bump only the parser whose output semantics changed. The checker records an exact-PDF reparse that produces identical canonical content as unchanged; only a changed canonical extraction is staged for review. Canonical publication changes still require an `IMPORT_VERSION` bump.

If an operator regenerates a PDF so its byte-level SHA-256 changes but its full canonical timetable content does not, the checker keeps the new PDF as evidence and leaves the already-published timetable verified; no approval or republishing is required. Zero changed/added/removed departure cells alone are not treated as equivalence because route metadata, stops, service days, or footnotes may still have changed.

### Render and review runbook

`render.yaml` defines `fika-timetable-source-daily` at `01:17 UTC` (`03:17` in Johannesburg). It is a separate native Python cron from the Node web service and weekly Search Console job. Render cron files are ephemeral, so raw versioned PDFs and evidence are stored in PostgreSQL rather than on the cron filesystem.

Set these values:

- Daily cron: `DATABASE_URL`.
- Web service: `DATABASE_URL`, `TIMETABLE_ADMIN_USERNAME`, and `TIMETABLE_ADMIN_PASSWORD`. If the timetable credentials are absent, the existing `SEO_REPORT_USERNAME` and `SEO_REPORT_PASSWORD` are used.
- Optional pacing controls: `TIMETABLE_REQUEST_INTERVAL_SECONDS` (never below 1.5), `TIMETABLE_REQUEST_JITTER_SECONDS`, `TIMETABLE_HTTP_RETRIES`, and `TIMETABLE_HTTP_TIMEOUT_SECONDS`.
- Optional audit target: `TIMETABLE_AUDIT_SAMPLE_SIZE` (default 200; never below 100).

Operational steps:

1. Inspect a non-successful daily run and every `changed_review_required` or missing source in the private review page.
2. Compare the stored PDF, route/directions, service-day coverage, effective dates, departure counts, changed times, stops, and footnotes. Record a meaningful review note before approval.
3. Do not approve a parser-failure candidate. Fix the parser, bump its version, run the checker again, and review the new extraction.
4. Complete every weekly audit sample in the private page. The public `/data-reliability` page shows the exact match count only after all samples are reviewed; any mismatch marks its sources for review.
5. Treat `/data-reliability` warnings as evidence gaps. A failed/old daily check, an audit older than ten days, or a timetable publication newer than the audit makes the public evidence non-current.

The original sibling scripts are useful historical references, but they sit outside this Git/Render service root and skip already named files. Do not schedule `refresh_fika_timetables.sh`: it deletes production schedules before reimporting and bypasses the review gate. The package and approval workflow above are the maintained path.

## GA4 analytics

Set `GA4_MEASUREMENT_ID` on the production web service to a valid GA4 web-stream ID such as `G-ABC123`. The server injects the ID at runtime; if it is absent or invalid, analytics remains disabled. Local CRA development can optionally use `REACT_APP_GA4_MEASUREMENT_ID`.

When configured, GA4 loads automatically and uses its first-party `_ga` cookie to distinguish browsers and sessions. An informational analytics notice links to the privacy policy and remembers when it has been dismissed in that browser. Fika's privacy policy discloses this processing and its legitimate-interest basis. Advertising storage, Google Signals, and ad personalization remain disabled. Fika sends route codes and controlled interaction categories, but never raw search text, stop names, timetable contents, contact details, URL query strings, or raw errors.

Configure the GA4 property as follows:

- Disable Enhanced Measurement's browser-history page changes because Fika sends explicit SPA page views.
- Disable Enhanced Measurement's automatic site search so `q` parameters are never collected as search terms.
- Register event dimensions for `agency`, `route_code`, `search_location`, `selection_source`, `query_length_bucket`, `data_source`, `online_state`, `saved_state`, `direction`, `service_day`, and `failure_type`.
- Register numeric event metrics for `result_count` and `saved_count`.
- Mark `timetable_viewed` as a key event, use 14-month event-data retention, and leave Google Signals and ad personalization disabled.
- Verify single page views and custom events in Tag Assistant or DebugView before using the production stream for reporting.

To seed all known numeric URLs from the pre-replacement backup into a target database, run from the parent project directory:

```bash
.venv/bin/python seed_route_url_aliases.py \
  --backup backups/fika_20260802_before_gabs_v2_replace.dump \
  --database-url "$DATABASE_URL"
```

## Weekly Search Console import

The weekly job stores property totals separately from top query/page rows so reports do not mistake Search Console's omitted or anonymized queries for the property total. It re-pulls an overlapping 21-day finalized-data window, paginates at 25,000 rows, and checks impression-bearing URLs using non-following HEAD requests.

Required secrets:

- `DATABASE_URL`: the Render Postgres internal connection URL for the cron job.
- `GSC_SERVICE_ACCOUNT_JSON`: the full service-account JSON (plain JSON or base64 encoded). Add its `client_email` to the exact `https://www.fika.net.za/` Search Console property with read access.
- `GSC_SITE_URL`: defaults to `https://www.fika.net.za/`.

The included `render.yaml` defines `fika-gsc-weekly` for Mondays at `04:00 UTC` (`06:00` in Johannesburg). Render prompts for both secrets when the Blueprint is first created. The same cron can also be created manually with build command `npm ci`, command `npm run sync:gsc`, and schedule `0 4 * * 1`.

Run the initial backfill after credentials are configured:

```bash
npm run backfill:gsc
```

To tie the first SEO deployment to the report while running a sync:

```bash
npm run sync:gsc -- --event="Stable route-code URLs and Search Console SEO rollout" --event-date=2026-08-02
```

The importer creates these tables idempotently: `gsc_daily_metrics`, `gsc_search_rows`, `gsc_sync_runs`, `gsc_seo_events`, and `gsc_url_checks`.

## Private search performance report

Set these secrets on the Render web service:

- `SEO_REPORT_USERNAME`
- `SEO_REPORT_PASSWORD`

Then open `/admin/search-performance`. The report uses HTTP Basic authentication and always returns `Cache-Control: no-store` and `X-Robots-Tag: noindex, nofollow`.

After the route URL deployment, submit `/sitemap.xml` in Search Console and inspect the Atlantis and Mamre hubs plus routes 234, 246, and Golden Arrow 0004. Avoid further title changes for 28 days unless correcting a defect.

### Daily trip views and independent GABS sections

The selected day filters individual trips, including trips whose weekly patterns overlap. Columns sort by the first scheduled stop in stop order, then trip ID. Each header shows the first listed time, final served stop and operating days; its dialog lists the served stops. `via` remains an untimed passage and `--` means the trip does not serve that stop. Existing v2 and offline payloads need no conversion.

GABS PDFs are document evidence, not publication units. `GabsAdapter.parse_document` returns `sections` (timetable number, physical PDF pages, canonical extraction/hash or local error), `issues` for uncertain document boundaries, and `complete`. Each canonical section contains one direction. Legends belong to that section and its continuation pages. `parse_pdf` remains a strict aggregate compatibility API; the daily checker and dry run use the section result. MyCiTi retains its route workflow and import version.

`fika-gabs-parser/2.0.0` and `fika-gabs-sections/2.0.0` introduce section staging. `timetable_sections` stores per-document section state, `timetable_section_versions` stores immutable content and review history, and `timetable_section_observations` links unchanged content to every captured PDF. An unchanged section in a regenerated PDF supplies additional evidence without publication or another content review. Identical copies in separate catalogue documents share one logical change alert; selecting a different publishing source remains explicit. Explicit withdrawal still requires fresh review on reappearance. An audit mismatch also requires fresh review even if the PDF is unchanged.

The admin page groups copies by timetable number and canonical content, with direct comparisons against the preferred copy. It prefers an own-route PDF, then the newest effective date. Equal-priority differences require an explicit revision choice. Source overrides apply only to that exact revision; replacement revisions require review. Small stored family fingerprints keep reliability lists from loading every stop-time extraction. Publication continues to compose weekday, Saturday, Sunday and public-holiday families independently. Source, document-version and section-version provenance are retained on trips and audit samples. Existing route names and URLs are preserved when a section is published.

Rollout:

1. The trip display can ship independently of the section backend.
2. Deploy the additive schema and section-aware web/checker code together. Pause the old checker during the transition.
3. Backfill approved GABS evidence with `python -m timetable_verification.migrate_sections --database-url "$DATABASE_URL"`. This uses the publication lock, preserves trip/stop-time IDs and times, validates trip provenance, then enables section mode. It is idempotent; the new checker also performs it before downloads.
4. Reparse stored evidence with `python -m timetable_verification.reparse_sections`, then run `python -m timetable_verification.check_sources --operator gabs` for current downloads. Newly valid or changed sections enter independent review. In the supplied mixed example, 004901 can be approved without approving or modifying 005001.
5. Review document issues and section comparisons in `/admin/timetable-reliability`; check `/api/reliability` for document diagnostics and section summaries. Approvals and withdrawals invalidate affected timetable caches and open audits.

Recovery and rollback:

- Failed downloads or incomplete parsing do not imply section withdrawal. Absence from a completely parsed PDF flags review and retains published service. Reparse captured evidence after fixing the parser; never manually edit an approved extraction.
- To reverse a content choice, approve the reviewed replacement copy or withdraw that section copy; eligible approved contributions are restored. Conflicting fallback copies require explicit reviewer selection.
- For a code rollback, pause the checker and section approval actions and keep the additive tables/provenance intact. Passenger timetable payloads and saved copies remain compatible with the older UI. Do not re-enable whole-document GABS publishing after section approvals: its approved bundle no longer represents all published section revisions. Restore a coordinated database backup before reverting that publication workflow.
- Review events distinguish document checks, section approval/withdrawal and migration; no external alerts or automatic passenger-data publication are introduced.

Run regression tests with the pinned Python dependencies, `npm test`, and `CI=true npm test --prefix client -- --watchAll=false --runInBand`. For actual PostgreSQL/Node transaction coverage, set `FIKA_SECTION_TEST_DSN` to an isolated test database and run `python -m unittest tests_python.test_sections_integration -v`; tests create and remove unique schemas. The supplied PDFs are stored as base64 fixtures. The integration tests cover independent approval, conflicting sources, withdrawal fallback, stale revisions, unchanged PDF evidence, audit provenance and migration idempotence.

Reparse the latest captured PDFs without network access using `python -m timetable_verification.reparse_sections --source-key 004901` (omit the key for all captured GABS documents). This preserves the actual download timestamps and does not record a fresh catalogue check or publish any trips. It is useful when an official URL returns 404 after the evidence was captured.
