-- Conversation pins are fixed at creation: owner, Brain release, behavior, corpus and creation time.
-- Status, the run guard and updated_at stay current-state fields. 001's provider trigger still applies.
CREATE OR REPLACE FUNCTION esp_conversation_pins_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id
        OR NEW.owner_subject_id IS DISTINCT FROM OLD.owner_subject_id
        OR NEW.brain_release_id IS DISTINCT FROM OLD.brain_release_id
        OR NEW.behavior_version IS DISTINCT FROM OLD.behavior_version
        OR NEW.behavior_hash IS DISTINCT FROM OLD.behavior_hash
        OR NEW.corpus_release_id IS DISTINCT FROM OLD.corpus_release_id
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
        RAISE EXCEPTION 'conversation pins are immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS conversation_pins_immutable ON conversation;
CREATE TRIGGER conversation_pins_immutable
    BEFORE UPDATE ON conversation
    FOR EACH ROW EXECUTE FUNCTION esp_conversation_pins_immutable();
