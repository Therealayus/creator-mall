-- Creator Mall control plane.
--
-- Shape: normalised where rows are queried (sources, sessions, knowledge
-- versions, events), JSONB where they are read as a whole. That keeps the
-- schema reviewable without pretending every collection deserves a table.
--
-- Applied by: npm run db:migrate

CREATE TABLE IF NOT EXISTS cm_meta (
  id             integer PRIMARY KEY DEFAULT 1,
  schema_version integer     NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cm_meta_singleton CHECK (id = 1)
);

CREATE TABLE IF NOT EXISTS cm_platform (
  id         text PRIMARY KEY,
  slug       text NOT NULL UNIQUE,
  name       text NOT NULL,
  status     text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  doc        jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS cm_source (
  id           text PRIMARY KEY,
  domain       text NOT NULL,
  platform     text,
  active       boolean NOT NULL DEFAULT true,
  last_status  text,
  checked_at   timestamptz,
  facts        integer NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  doc          jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS cm_source_platform_idx ON cm_source (platform);
CREATE INDEX IF NOT EXISTS cm_source_domain_idx ON cm_source (domain);

CREATE TABLE IF NOT EXISTS cm_snapshot (
  id           text PRIMARY KEY,
  platform_id  text NOT NULL REFERENCES cm_platform (id) ON DELETE CASCADE,
  captured_at  timestamptz NOT NULL,
  state_hash   text NOT NULL,
  doc          jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS cm_snapshot_platform_idx ON cm_snapshot (platform_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS cm_event (
  id          text PRIMARY KEY,
  platform_id text,
  detected_at timestamptz NOT NULL,
  risk_level  text NOT NULL,
  status      text NOT NULL,
  doc         jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS cm_event_platform_idx ON cm_event (platform_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS cm_event_risk_idx ON cm_event (risk_level);

CREATE TABLE IF NOT EXISTS cm_proposal (
  id         text PRIMARY KEY,
  event_id   text,
  kind       text NOT NULL,
  status     text NOT NULL,
  risk_level text NOT NULL,
  created_at timestamptz NOT NULL,
  doc        jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS cm_proposal_status_idx ON cm_proposal (status, risk_level);

CREATE TABLE IF NOT EXISTS cm_knowledge_document (
  id         text PRIMARY KEY,
  slug       text NOT NULL UNIQUE,
  topic      text,
  status     text NOT NULL,
  updated_at timestamptz NOT NULL,
  doc        jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS cm_knowledge_version (
  id          text PRIMARY KEY,
  document_id text NOT NULL REFERENCES cm_knowledge_document (id) ON DELETE CASCADE,
  version     integer NOT NULL,
  status      text NOT NULL,
  expires_at  timestamptz,
  created_at  timestamptz NOT NULL,
  doc         jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS cm_knowledge_version_doc_idx ON cm_knowledge_version (document_id, version DESC);
CREATE INDEX IF NOT EXISTS cm_knowledge_version_expiry_idx ON cm_knowledge_version (expires_at);

CREATE TABLE IF NOT EXISTS cm_knowledge_chunk (
  id         text PRIMARY KEY,
  version_id text NOT NULL REFERENCES cm_knowledge_version (id) ON DELETE CASCADE,
  ordinal    integer NOT NULL,
  text       text NOT NULL,
  doc        jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS cm_knowledge_chunk_version_idx ON cm_knowledge_chunk (version_id, ordinal);

CREATE TABLE IF NOT EXISTS cm_knowledge_fact (
  id     text PRIMARY KEY,
  key    text NOT NULL,
  status text NOT NULL,
  doc    jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS cm_account (
  id         text PRIMARY KEY,
  email      text NOT NULL,
  role       text NOT NULL,
  status     text NOT NULL,
  created_at timestamptz NOT NULL,
  doc        jsonb NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS cm_account_email_idx ON cm_account (lower(email));

CREATE TABLE IF NOT EXISTS cm_session (
  id         text PRIMARY KEY,
  account_id text NOT NULL REFERENCES cm_account (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  doc        jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS cm_session_account_idx ON cm_session (account_id);
CREATE INDEX IF NOT EXISTS cm_session_expiry_idx ON cm_session (expires_at);

CREATE TABLE IF NOT EXISTS cm_creator_profile (
  id         text PRIMARY KEY,
  updated_at timestamptz NOT NULL,
  doc        jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS cm_notification (
  id         text PRIMARY KEY,
  creator_id text NOT NULL,
  created_at timestamptz NOT NULL,
  doc        jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS cm_notification_creator_idx ON cm_notification (creator_id, created_at DESC);

CREATE TABLE IF NOT EXISTS cm_impact (
  id         text PRIMARY KEY,
  creator_id text NOT NULL,
  event_id   text,
  level      text NOT NULL,
  doc        jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS cm_impact_creator_idx ON cm_impact (creator_id);

CREATE TABLE IF NOT EXISTS cm_prompt_version (
  id         text PRIMARY KEY,
  prompt_key text NOT NULL,
  version    integer NOT NULL,
  status     text NOT NULL,
  created_at timestamptz NOT NULL,
  doc        jsonb NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS cm_prompt_key_version_idx ON cm_prompt_version (prompt_key, version);

CREATE TABLE IF NOT EXISTS cm_template (
  id             text PRIMARY KEY,
  platform_id    text NOT NULL,
  capability_key text NOT NULL,
  status         text NOT NULL,
  doc            jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS cm_template_platform_idx ON cm_template (platform_id);

CREATE TABLE IF NOT EXISTS cm_job_run (
  id          text PRIMARY KEY,
  finished_at timestamptz NOT NULL,
  status      text NOT NULL,
  doc         jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS cm_job_run_finished_idx ON cm_job_run (finished_at DESC);

CREATE TABLE IF NOT EXISTS cm_dependency_edge (
  id        serial PRIMARY KEY,
  from_kind text NOT NULL,
  from_ref  text NOT NULL,
  to_kind   text NOT NULL,
  to_ref    text NOT NULL,
  relation  text NOT NULL,
  doc       jsonb NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS cm_dependency_edge_uniq ON cm_dependency_edge (from_kind, from_ref, to_kind, to_ref, relation);

CREATE TABLE IF NOT EXISTS cm_preference_observation (
  id         text PRIMARY KEY,
  creator_id text NOT NULL,
  at         timestamptz NOT NULL,
  kind       text NOT NULL,
  doc        jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS cm_preference_observation_creator_idx ON cm_preference_observation (creator_id, at DESC);

CREATE TABLE IF NOT EXISTS cm_preference (
  id         text PRIMARY KEY,
  creator_id text NOT NULL,
  key        text NOT NULL,
  value      text NOT NULL,
  enabled    boolean NOT NULL DEFAULT true,
  doc        jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS cm_preference_creator_idx ON cm_preference (creator_id);

-- Learning counters live beside the observations they are derived from.
CREATE TABLE IF NOT EXISTS cm_preference_counter (
  id         text PRIMARY KEY,
  creator_id text NOT NULL,
  value      text NOT NULL,
  weight     integer NOT NULL DEFAULT 0
);
