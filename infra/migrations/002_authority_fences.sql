-- Dispatch fences. Lock the incarnation first, then the mapping. Never the reverse.
-- Shared locks cover a current-authority recheck. Exclusive locks cover revocation.

CREATE OR REPLACE FUNCTION esp_try_fence(
    incarnation_id text,
    mapping_id text,
    exclusive boolean
) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
    incarnation_key bigint;
    mapping_key bigint;
    incarnation_locked boolean;
    mapping_locked boolean;
BEGIN
    incarnation_key := hashtextextended(incarnation_id, 1);
    mapping_key := hashtextextended(mapping_id, 2);
    IF exclusive THEN
        incarnation_locked := pg_try_advisory_xact_lock(incarnation_key);
        IF NOT incarnation_locked THEN
            RETURN false;
        END IF;
        mapping_locked := pg_try_advisory_xact_lock(mapping_key);
    ELSE
        incarnation_locked := pg_try_advisory_xact_lock_shared(incarnation_key);
        IF NOT incarnation_locked THEN
            RETURN false;
        END IF;
        mapping_locked := pg_try_advisory_xact_lock_shared(mapping_key);
    END IF;
    RETURN mapping_locked;
END;
$$;

REVOKE ALL ON FUNCTION esp_try_fence(text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION esp_try_fence(text, text, boolean) TO esp_app, esp_gateway;

CREATE INDEX IF NOT EXISTS provider_session_incarnation_current_idx
    ON provider_session (runtime_incarnation_id, id)
    WHERE is_current;
