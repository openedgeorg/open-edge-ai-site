-- Current coordination metadata only. No message, turn, transcript, or job table.
CREATE TABLE IF NOT EXISTS schema_migrations (
    filename text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'esp_app') THEN
        CREATE ROLE esp_app LOGIN PASSWORD 'esp_app';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'esp_gateway') THEN
        CREATE ROLE esp_gateway LOGIN PASSWORD 'esp_gateway';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'esp_mcp') THEN
        CREATE ROLE esp_mcp LOGIN PASSWORD 'esp_mcp';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'esp_publisher') THEN
        CREATE ROLE esp_publisher LOGIN PASSWORD 'esp_publisher';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qualification_admin') THEN
        CREATE ROLE qualification_admin LOGIN PASSWORD 'qualification_admin';
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS conversation (
    id uuid PRIMARY KEY,
    owner_subject_id text NOT NULL,
    provider text NOT NULL CHECK (provider IN ('openai', 'xai')),
    brain_release_id text NOT NULL,
    behavior_version text NOT NULL,
    behavior_hash text NOT NULL CHECK (behavior_hash ~ '^[0-9a-f]{64}$'),
    corpus_release_id text NOT NULL,
    status text NOT NULL CHECK (status IN ('active', 'closed')),
    active_provider_session_id uuid,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS harness_instance (
    id uuid PRIMARY KEY,
    provider text NOT NULL CHECK (provider IN ('openai', 'xai')),
    worker_id text NOT NULL,
    process_incarnation_id uuid NOT NULL,
    deployment_ref text NOT NULL,
    native_storage_unit_id text NOT NULL,
    lifecycle_status text NOT NULL CHECK (
        lifecycle_status IN ('starting', 'ready', 'draining', 'suspect', 'failed', 'stopped')
    ),
    resident_session_limit integer NOT NULL CHECK (resident_session_limit >= 0),
    active_turn_limit integer NOT NULL CHECK (active_turn_limit >= 0),
    last_heartbeat_at timestamptz NOT NULL,
    drain_started_at timestamptz
);

CREATE TABLE IF NOT EXISTS provider_session (
    id uuid PRIMARY KEY,
    conversation_id uuid NOT NULL REFERENCES conversation (id),
    provider text NOT NULL CHECK (provider IN ('openai', 'xai')),
    session_generation integer NOT NULL CHECK (session_generation >= 1),
    is_current boolean NOT NULL,
    native_session_id text,
    model text,
    brain_release_id text NOT NULL,
    brain_hash text NOT NULL CHECK (brain_hash ~ '^[0-9a-f]{64}$'),
    behavior_version text NOT NULL,
    behavior_hash text NOT NULL CHECK (behavior_hash ~ '^[0-9a-f]{64}$'),
    corpus_release_id text NOT NULL,
    deployment_ref text NOT NULL,
    runtime_state text NOT NULL CHECK (
        runtime_state IN (
            'starting', 'warm_idle', 'running', 'cancelling', 'draining',
            'unloaded', 'suspect', 'recovering', 'unavailable'
        )
    ),
    harness_instance_id uuid REFERENCES harness_instance (id),
    runtime_incarnation_id uuid,
    native_storage_unit_id text,
    state_location text,
    ownership_epoch bigint NOT NULL,
    owner_lease_expires_at timestamptz,
    active_agent_run_id uuid,
    current_request_id text,
    current_native_work_ref text,
    active_agent_run_expires_at timestamptz,
    recovery_count integer NOT NULL DEFAULT 0 CHECK (recovery_count >= 0),
    last_failure_code text,
    cancel_requested_at timestamptz,
    recovery_started_at timestamptz,
    recovery_deadline_at timestamptz,
    created_at timestamptz NOT NULL,
    last_used_at timestamptz NOT NULL,
    UNIQUE (conversation_id, session_generation)
);

CREATE UNIQUE INDEX IF NOT EXISTS provider_session_one_current
    ON provider_session (conversation_id)
    WHERE is_current;

CREATE INDEX IF NOT EXISTS provider_session_instance_idx
    ON provider_session (harness_instance_id);

CREATE TABLE IF NOT EXISTS brain_release (
    version text PRIMARY KEY,
    sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    behavior_version text NOT NULL,
    behavior_sha256 text NOT NULL CHECK (behavior_sha256 ~ '^[0-9a-f]{64}$'),
    source_revision text NOT NULL,
    artifact_ref text NOT NULL,
    behavior_artifact_ref text NOT NULL,
    corpus_release_id text NOT NULL,
    status text NOT NULL CHECK (status IN ('draft', 'reviewed', 'production', 'withdrawn')),
    created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_qualification (
    id text PRIMARY KEY,
    design_assumption_id text NOT NULL,
    provider text NOT NULL CHECK (provider IN ('openai', 'xai')),
    harness_revision text,
    image_digest text,
    configuration_digest text,
    transport_digest text,
    storage_profile text,
    tool_policy_digest text,
    status text NOT NULL CHECK (status IN ('pending', 'validated', 'invalidated')),
    resident_session_limit integer,
    active_turn_limit integer,
    acceptance_budgets_ref text,
    evidence_bundle_ref text,
    failed_criteria text[] NOT NULL DEFAULT ARRAY[]::text[],
    reviewed_by text,
    reviewed_at timestamptz,
    CONSTRAINT validated_record_complete CHECK (
        status <> 'validated'
        OR (
            reviewed_by IS NOT NULL
            AND reviewed_at IS NOT NULL
            AND evidence_bundle_ref IS NOT NULL
            AND acceptance_budgets_ref IS NOT NULL
            AND harness_revision IS NOT NULL
            AND image_digest IS NOT NULL
            AND configuration_digest IS NOT NULL
            AND transport_digest IS NOT NULL
            AND storage_profile IS NOT NULL
            AND tool_policy_digest IS NOT NULL
            AND resident_session_limit IS NOT NULL
            AND active_turn_limit IS NOT NULL
        )
    )
);

CREATE TABLE IF NOT EXISTS provider_deployment (
    id text PRIMARY KEY,
    provider text NOT NULL CHECK (provider IN ('openai', 'xai')),
    model text NOT NULL,
    harness_revision text NOT NULL,
    configuration_digest text NOT NULL,
    gateway_route text NOT NULL,
    recovery_qualification_ref text,
    shared_process_qualification_id text REFERENCES runtime_qualification (id),
    deployed_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_capacity (
    provider text PRIMARY KEY CHECK (provider IN ('openai', 'xai')),
    policy text NOT NULL,
    healthy boolean NOT NULL,
    active_limit integer NOT NULL CHECK (active_limit >= 0)
);

CREATE TABLE IF NOT EXISTS capacity_slot (
    scope text NOT NULL CHECK (scope IN ('resident', 'active', 'provider')),
    scope_id text NOT NULL,
    slot_number integer NOT NULL CHECK (slot_number >= 0),
    holder_provider_session_id uuid,
    reservation_epoch bigint,
    PRIMARY KEY (scope, scope_id, slot_number)
);

CREATE OR REPLACE FUNCTION esp_conversation_provider_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.provider IS DISTINCT FROM OLD.provider THEN
        RAISE EXCEPTION 'provider is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS conversation_provider_immutable ON conversation;
CREATE TRIGGER conversation_provider_immutable
    BEFORE UPDATE ON conversation
    FOR EACH ROW EXECUTE FUNCTION esp_conversation_provider_immutable();

CREATE OR REPLACE FUNCTION esp_session_identity_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    conv_provider text;
BEGIN
    SELECT provider INTO conv_provider FROM conversation WHERE id = NEW.conversation_id;
    IF conv_provider IS NULL OR conv_provider IS DISTINCT FROM NEW.provider THEN
        RAISE EXCEPTION 'retained generation provider mismatch' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF NEW.provider IS DISTINCT FROM OLD.provider
            OR NEW.ownership_epoch < OLD.ownership_epoch
            OR NEW.brain_release_id IS DISTINCT FROM OLD.brain_release_id
            OR NEW.brain_hash IS DISTINCT FROM OLD.brain_hash
            OR NEW.behavior_version IS DISTINCT FROM OLD.behavior_version
            OR NEW.behavior_hash IS DISTINCT FROM OLD.behavior_hash
            OR NEW.corpus_release_id IS DISTINCT FROM OLD.corpus_release_id
            OR NEW.deployment_ref IS DISTINCT FROM OLD.deployment_ref
            OR (OLD.model IS NOT NULL AND NEW.model IS DISTINCT FROM OLD.model)
            OR (OLD.native_session_id IS NOT NULL AND NEW.native_session_id IS DISTINCT FROM OLD.native_session_id)
        THEN
            RAISE EXCEPTION 'pin or epoch mutation rejected' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS provider_session_identity_guard ON provider_session;
CREATE TRIGGER provider_session_identity_guard
    BEFORE INSERT OR UPDATE ON provider_session
    FOR EACH ROW EXECUTE FUNCTION esp_session_identity_guard();

CREATE OR REPLACE FUNCTION esp_guard_matches_current_mapping() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    sess_conversation uuid;
    sess_current boolean;
BEGIN
    IF NEW.active_provider_session_id IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT conversation_id, is_current
      INTO sess_conversation, sess_current
      FROM provider_session
     WHERE id = NEW.active_provider_session_id;
    IF sess_conversation IS NULL OR sess_conversation <> NEW.id OR sess_current IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'guard must reference the conversation''s own current mapping' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS conversation_guard_consistency ON conversation;
CREATE CONSTRAINT TRIGGER conversation_guard_consistency
    AFTER INSERT OR UPDATE ON conversation
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION esp_guard_matches_current_mapping();

CREATE OR REPLACE VIEW current_authority AS
SELECT
    c.id::text AS conversation_id,
    c.owner_subject_id,
    c.provider,
    ps.id::text AS provider_session_id,
    ps.session_generation,
    ps.is_current,
    ps.native_session_id,
    ps.active_agent_run_id::text AS active_agent_run_id,
    ps.harness_instance_id::text AS harness_instance_id,
    ps.runtime_incarnation_id::text AS runtime_incarnation_id,
    ps.ownership_epoch,
    ps.owner_lease_expires_at,
    ps.active_agent_run_expires_at,
    ps.brain_release_id,
    ps.brain_hash,
    ps.behavior_version,
    ps.behavior_hash,
    ps.corpus_release_id,
    ps.deployment_ref,
    ps.model,
    COALESCE(rq.status, 'pending') AS qualification_status,
    transaction_timestamp() AS database_time,
    ps.runtime_state,
    c.active_provider_session_id::text AS guard_provider_session_id,
    (ps.cancel_requested_at IS NOT NULL) AS cancel_requested,
    ps.recovery_count,
    ps.recovery_started_at,
    ps.recovery_deadline_at,
    ps.current_request_id,
    ps.current_native_work_ref
FROM provider_session AS ps
JOIN conversation AS c ON c.id = ps.conversation_id
LEFT JOIN provider_deployment AS pd ON pd.id = ps.deployment_ref
LEFT JOIN runtime_qualification AS rq ON rq.id = pd.shared_process_qualification_id
WHERE ps.is_current;

CREATE OR REPLACE VIEW knowledge_authority AS
SELECT
    conversation_id,
    provider_session_id,
    provider,
    active_agent_run_id,
    ownership_epoch,
    runtime_incarnation_id,
    corpus_release_id,
    qualification_status,
    database_time,
    guard_provider_session_id,
    cancel_requested
FROM current_authority;

REVOKE ALL ON conversation, provider_session, harness_instance, brain_release,
    runtime_qualification, provider_deployment, provider_capacity, capacity_slot
    FROM esp_gateway, esp_mcp;
GRANT SELECT ON current_authority TO esp_gateway;
GRANT SELECT ON knowledge_authority TO esp_mcp;
GRANT SELECT, INSERT, UPDATE, DELETE ON conversation, provider_session, harness_instance,
    provider_capacity, capacity_slot TO esp_app;
GRANT SELECT ON brain_release, provider_deployment, runtime_qualification, current_authority TO esp_app;
GRANT SELECT, INSERT, UPDATE ON brain_release TO esp_publisher;
GRANT SELECT, INSERT, UPDATE ON runtime_qualification TO qualification_admin;
