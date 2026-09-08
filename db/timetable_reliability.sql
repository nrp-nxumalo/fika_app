CREATE TABLE IF NOT EXISTS timetable_sources (
  id bigserial PRIMARY KEY,
  operator text NOT NULL CHECK (operator IN ('GABS', 'MyCiti')),
  source_key text NOT NULL,
  route_name text NOT NULL DEFAULT '',
  direction_names text[] NOT NULL DEFAULT '{}',
  service_day_coverage text[] NOT NULL DEFAULT '{}',
  official_source_url text NOT NULL,
  source_effective_date date,
  last_downloaded_at timestamptz,
  last_seen_at timestamptz,
  last_manually_verified_on date,
  current_pdf_sha256 text CHECK (
    current_pdf_sha256 IS NULL OR current_pdf_sha256 ~ '^[0-9a-f]{64}$'
  ),
  current_content_sha256 text CHECK (
    current_content_sha256 IS NULL OR current_content_sha256 ~ '^[0-9a-f]{64}$'
  ),
  parser_version text NOT NULL,
  import_version text NOT NULL,
  status text NOT NULL DEFAULT 'changed_review_required' CHECK (
    status IN ('verified', 'changed_review_required', 'withdrawn')
  ),
  approved_version_id bigint,
  pending_version_id bigint,
  consecutive_missing_checks integer NOT NULL DEFAULT 0 CHECK (
    consecutive_missing_checks >= 0
  ),
  withdrawn_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (operator, source_key)
);

CREATE TABLE IF NOT EXISTS timetable_source_versions (
  id bigserial PRIMARY KEY,
  source_id bigint NOT NULL REFERENCES timetable_sources(id) ON DELETE CASCADE,
  previous_version_id bigint REFERENCES timetable_source_versions(id) ON DELETE SET NULL,
  pdf_sha256 text NOT NULL CHECK (pdf_sha256 ~ '^[0-9a-f]{64}$'),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  source_url text NOT NULL,
  source_effective_date date,
  first_downloaded_at timestamptz NOT NULL DEFAULT now(),
  last_downloaded_at timestamptz NOT NULL DEFAULT now(),
  http_etag text,
  http_last_modified text,
  parser_version text NOT NULL,
  import_version text NOT NULL,
  route_name text NOT NULL DEFAULT '',
  direction_names text[] NOT NULL DEFAULT '{}',
  service_day_coverage text[] NOT NULL DEFAULT '{}',
  extraction jsonb NOT NULL,
  comparison jsonb NOT NULL DEFAULT '{}'::jsonb,
  pdf_bytes bytea NOT NULL,
  pdf_size_bytes bigint NOT NULL CHECK (pdf_size_bytes > 0),
  review_status text NOT NULL DEFAULT 'pending' CHECK (
    review_status IN ('pending', 'approved', 'rejected', 'superseded')
  ),
  approved_by text,
  approved_at timestamptz,
  review_note text,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, pdf_sha256, parser_version, import_version)
);

CREATE INDEX IF NOT EXISTS idx_timetable_source_versions_source_downloaded
  ON timetable_source_versions (source_id, first_downloaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_timetable_source_versions_review
  ON timetable_source_versions (review_status, first_downloaded_at DESC);

CREATE TABLE IF NOT EXISTS timetable_source_check_runs (
  id bigserial PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running' CHECK (
    status IN ('running', 'succeeded', 'partial_failure', 'failed')
  ),
  sources_discovered integer NOT NULL DEFAULT 0,
  sources_downloaded integer NOT NULL DEFAULT 0,
  sources_unchanged integer NOT NULL DEFAULT 0,
  sources_changed integer NOT NULL DEFAULT 0,
  sources_failed integer NOT NULL DEFAULT 0,
  operator_results jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text
);

CREATE TABLE IF NOT EXISTS timetable_source_check_results (
  id bigserial PRIMARY KEY,
  check_run_id bigint NOT NULL REFERENCES timetable_source_check_runs(id) ON DELETE CASCADE,
  source_id bigint REFERENCES timetable_sources(id) ON DELETE SET NULL,
  operator text NOT NULL,
  source_key text NOT NULL,
  source_url text NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now(),
  http_status integer,
  outcome text NOT NULL CHECK (
    outcome IN ('new', 'changed', 'unchanged', 'missing', 'failed')
  ),
  pdf_sha256 text,
  duration_ms integer,
  error text
);

CREATE INDEX IF NOT EXISTS idx_timetable_check_results_run
  ON timetable_source_check_results (check_run_id, operator, source_key);
CREATE INDEX IF NOT EXISTS idx_timetable_check_results_source
  ON timetable_source_check_results (source_id, checked_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS timetable_source_events (
  id bigserial PRIMARY KEY,
  source_id bigint REFERENCES timetable_sources(id) ON DELETE SET NULL,
  source_version_id bigint REFERENCES timetable_source_versions(id) ON DELETE SET NULL,
  check_run_id bigint REFERENCES timetable_source_check_runs(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  actor text NOT NULL DEFAULT 'system',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_timetable_source_events_occurred
  ON timetable_source_events (occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_timetable_source_events_source
  ON timetable_source_events (source_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS timetable_audit_runs (
  id bigserial PRIMARY KEY,
  audit_week date NOT NULL,
  target_sample_size integer NOT NULL CHECK (target_sample_size >= 100),
  sampled_count integer NOT NULL DEFAULT 0,
  matched_count integer NOT NULL DEFAULT 0,
  mismatched_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'planned' CHECK (
    status IN ('planned', 'in_progress', 'completed', 'cancelled')
  ),
  citation_text text,
  reviewer text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (matched_count >= 0 AND mismatched_count >= 0),
  CHECK (matched_count + mismatched_count <= sampled_count)
);

-- Earlier revisions used one row per week.  Keeping cancelled queues makes the
-- audit history explainable when a publication invalidates work in progress,
-- while this partial index still prevents two active queues racing each other.
ALTER TABLE timetable_audit_runs
  DROP CONSTRAINT IF EXISTS timetable_audit_runs_audit_week_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_timetable_audit_runs_active_week
  ON timetable_audit_runs (audit_week)
  WHERE status IN ('planned', 'in_progress');

CREATE TABLE IF NOT EXISTS timetable_audit_samples (
  id bigserial PRIMARY KEY,
  audit_run_id bigint NOT NULL REFERENCES timetable_audit_runs(id) ON DELETE CASCADE,
  source_id bigint NOT NULL REFERENCES timetable_sources(id) ON DELETE RESTRICT,
  source_version_id bigint NOT NULL REFERENCES timetable_source_versions(id) ON DELETE RESTRICT,
  operator text NOT NULL,
  route_code text NOT NULL,
  route_name text NOT NULL,
  direction_code text,
  direction_name text NOT NULL,
  direction_ordinal integer NOT NULL,
  service_day text NOT NULL,
  trip_ordinal integer NOT NULL,
  stop_name text NOT NULL,
  stop_sequence integer NOT NULL,
  expected_departure text NOT NULL,
  raw_departure text,
  sample_kind text NOT NULL CHECK (
    sample_kind IN ('first_departure', 'last_departure', 'footnote', 'standard')
  ),
  footnote_markers text[] NOT NULL DEFAULT '{}',
  matched boolean,
  reviewer_note text,
  reviewed_at timestamptz,
  UNIQUE (audit_run_id, source_version_id, route_code, direction_name,
          service_day, trip_ordinal, stop_sequence, sample_kind)
);

CREATE INDEX IF NOT EXISTS idx_timetable_audit_samples_run
  ON timetable_audit_samples (audit_run_id, operator, direction_ordinal, service_day);

ALTER TABLE directions
  ADD COLUMN IF NOT EXISTS timetable_source_id bigint REFERENCES timetable_sources(id) ON DELETE SET NULL;
ALTER TABLE directions
  ADD COLUMN IF NOT EXISTS timetable_source_version_id bigint REFERENCES timetable_source_versions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_directions_timetable_source
  ON directions (timetable_source_id);

-- GABS publishes overlapping PDFs for the same direction (for example, a
-- public-holiday PDF alongside the regular weekday/weekend PDF).  Provenance
-- therefore belongs on each published trip/service family rather than only on
-- the direction row.  These columns also let withdrawal restore the next
-- newest approved source version without disturbing unrelated service days.
ALTER TABLE trips
  ADD COLUMN IF NOT EXISTS timetable_source_id bigint REFERENCES timetable_sources(id) ON DELETE SET NULL;
ALTER TABLE trips
  ADD COLUMN IF NOT EXISTS timetable_source_version_id bigint REFERENCES timetable_source_versions(id) ON DELETE SET NULL;
ALTER TABLE trips
  ADD COLUMN IF NOT EXISTS timetable_effective_date date;
ALTER TABLE trips
  ADD COLUMN IF NOT EXISTS timetable_service_family text CHECK (
    timetable_service_family IS NULL OR
    timetable_service_family IN ('weekday', 'saturday', 'sunday', 'public_holiday')
  );
ALTER TABLE trips
  ADD COLUMN IF NOT EXISTS timetable_trip_ordinal integer CHECK (
    timetable_trip_ordinal IS NULL OR timetable_trip_ordinal > 0
  );

CREATE INDEX IF NOT EXISTS idx_trips_timetable_source
  ON trips (timetable_source_id, timetable_service_family);
CREATE INDEX IF NOT EXISTS idx_trips_timetable_source_version
  ON trips (timetable_source_version_id, timetable_trip_ordinal);

-- Documents remain immutable evidence; GABS review/publication lives on sections.
ALTER TABLE timetable_sources ADD COLUMN IF NOT EXISTS section_mode boolean NOT NULL DEFAULT false;
ALTER TABLE timetable_source_versions ADD COLUMN IF NOT EXISTS document_issues jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE TABLE IF NOT EXISTS timetable_sections (
  id bigserial PRIMARY KEY,
  source_id bigint NOT NULL REFERENCES timetable_sources(id) ON DELETE RESTRICT,
  timetable_number text NOT NULL CHECK (timetable_number ~ '^[0-9]{6}$'),
  status text NOT NULL DEFAULT 'changed_review_required' CHECK (status IN ('verified','changed_review_required','withdrawn')),
  approved_version_id bigint,
  pending_version_id bigint,
  last_seen_document_version_id bigint REFERENCES timetable_source_versions(id),
  missing_from_document boolean NOT NULL DEFAULT false,
  audit_review_required boolean NOT NULL DEFAULT false,
  last_manually_verified_on date,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, timetable_number)
);
CREATE TABLE IF NOT EXISTS timetable_section_versions (
  id bigserial PRIMARY KEY,
  section_id bigint NOT NULL REFERENCES timetable_sections(id) ON DELETE RESTRICT,
  document_version_id bigint NOT NULL REFERENCES timetable_source_versions(id) ON DELETE RESTRICT,
  previous_version_id bigint REFERENCES timetable_section_versions(id),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  extraction jsonb,
  parse_error text,
  review_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_pages integer[] NOT NULL DEFAULT '{}',
  comparison jsonb NOT NULL DEFAULT '{}'::jsonb,
  review_status text NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending','approved','rejected','superseded')),
  approved_by text,
  approved_at timestamptz,
  review_note text,
  published_at timestamptz,
  source_override boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((extraction IS NULL) <> (parse_error IS NULL))
);
CREATE TABLE IF NOT EXISTS timetable_section_observations (
  section_version_id bigint NOT NULL REFERENCES timetable_section_versions(id) ON DELETE RESTRICT,
  document_version_id bigint NOT NULL REFERENCES timetable_source_versions(id) ON DELETE RESTRICT,
  source_pages integer[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (section_version_id, document_version_id)
);
CREATE INDEX IF NOT EXISTS idx_timetable_sections_number ON timetable_sections(timetable_number);
CREATE INDEX IF NOT EXISTS idx_timetable_section_versions_section ON timetable_section_versions(section_id, id);
ALTER TABLE trips ADD COLUMN IF NOT EXISTS timetable_section_version_id bigint REFERENCES timetable_section_versions(id);
CREATE INDEX IF NOT EXISTS idx_trips_timetable_section_version ON trips(timetable_section_version_id);
ALTER TABLE timetable_audit_samples ADD COLUMN IF NOT EXISTS section_version_id bigint REFERENCES timetable_section_versions(id);

ALTER TABLE timetable_sections ADD COLUMN IF NOT EXISTS audit_review_required boolean NOT NULL DEFAULT false;
ALTER TABLE timetable_section_versions ADD COLUMN IF NOT EXISTS review_summary jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE timetable_section_versions DROP CONSTRAINT IF EXISTS timetable_section_versions_section_id_document_version_id_key;
