-- Whole-process revocation fence (P §12.6 step 1; D4). The incarnation key alone, derived exactly as
-- esp_try_fence derives it, so the two always contend. Unlike esp_try_fence it waits, bounded by the
-- caller's lock_timeout. While it is queued, PostgreSQL grants no later conflicting request, so new
-- shared dispatch and admission fences on the incarnation fail at once and cannot starve a revocation.
CREATE OR REPLACE FUNCTION esp_await_incarnation_fence(incarnation_id text) RETURNS boolean
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended(incarnation_id, 1));
    RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION esp_await_incarnation_fence(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION esp_await_incarnation_fence(text) TO esp_app;
