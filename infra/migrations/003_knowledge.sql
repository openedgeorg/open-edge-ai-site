-- Separate knowledge records. Original objects are immutable.
-- esp_mcp can read them and cannot write them. Derived chunks live in later generations.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE SCHEMA IF NOT EXISTS knowledge;
REVOKE ALL ON SCHEMA knowledge FROM PUBLIC;

CREATE TABLE IF NOT EXISTS knowledge.corpus_release (
    id text PRIMARY KEY,
    status text NOT NULL CHECK (status IN ('draft', 'reviewed', 'production', 'withdrawn')),
    embedding_revision text NOT NULL,
    embedding_dimension integer NOT NULL CHECK (embedding_dimension = 384),
    tokenizer_revision text NOT NULL,
    created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge.source_object (
    corpus_release_id text NOT NULL REFERENCES knowledge.corpus_release (id),
    source_id text NOT NULL,
    version text NOT NULL,
    title text NOT NULL,
    content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    authority text NOT NULL,
    authority_rank integer NOT NULL,
    effective_date timestamptz,
    supersedes text,
    status text NOT NULL CHECK (status IN ('active', 'withdrawn', 'historical')),
    source_owner text NOT NULL,
    visibility text NOT NULL CHECK (visibility IN ('public', 'internal')),
    object_ref text NOT NULL,
    byte_length integer NOT NULL CHECK (byte_length >= 0),
    locator_start integer NOT NULL CHECK (locator_start >= 0),
    locator_end integer NOT NULL CHECK (locator_end >= locator_start),
    PRIMARY KEY (corpus_release_id, source_id, version),
    CONSTRAINT source_locator_within_object CHECK (locator_end <= byte_length)
);

CREATE TABLE IF NOT EXISTS knowledge.index_generation (
    corpus_release_id text NOT NULL REFERENCES knowledge.corpus_release (id),
    generation integer NOT NULL CHECK (generation > 0),
    embedding_revision text NOT NULL,
    tokenizer_revision text NOT NULL,
    dimension integer NOT NULL CHECK (dimension = 384),
    built_at timestamptz NOT NULL,
    PRIMARY KEY (corpus_release_id, generation)
);

CREATE TABLE IF NOT EXISTS knowledge.source_chunk (
    corpus_release_id text NOT NULL,
    generation integer NOT NULL,
    source_id text NOT NULL,
    version text NOT NULL,
    chunk_index integer NOT NULL CHECK (chunk_index >= 0),
    locator_start integer NOT NULL CHECK (locator_start >= 0),
    locator_end integer NOT NULL CHECK (locator_end >= locator_start),
    chunk_text text NOT NULL,
    embedding vector(384),
    visibility text NOT NULL CHECK (visibility IN ('public', 'internal')),
    status text NOT NULL CHECK (status IN ('active', 'withdrawn', 'historical')),
    effective_date timestamptz,
    tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', chunk_text)) STORED,
    PRIMARY KEY (corpus_release_id, generation, source_id, version, chunk_index),
    FOREIGN KEY (corpus_release_id, generation)
        REFERENCES knowledge.index_generation (corpus_release_id, generation),
    FOREIGN KEY (corpus_release_id, source_id, version)
        REFERENCES knowledge.source_object (corpus_release_id, source_id, version)
);

CREATE INDEX IF NOT EXISTS source_chunk_tsv_idx
    ON knowledge.source_chunk USING gin (tsv);
CREATE INDEX IF NOT EXISTS source_chunk_corpus_idx
    ON knowledge.source_chunk (corpus_release_id, generation);

CREATE TABLE IF NOT EXISTS knowledge.claim (
    corpus_release_id text NOT NULL REFERENCES knowledge.corpus_release (id),
    claim_id text NOT NULL,
    claim_text text NOT NULL,
    status text NOT NULL CHECK (status IN ('active', 'withdrawn')),
    PRIMARY KEY (corpus_release_id, claim_id)
);

CREATE TABLE IF NOT EXISTS knowledge.claim_citation (
    corpus_release_id text NOT NULL,
    claim_id text NOT NULL,
    source_id text NOT NULL,
    version text NOT NULL,
    locator_start integer NOT NULL CHECK (locator_start >= 0),
    locator_end integer NOT NULL CHECK (locator_end >= locator_start),
    PRIMARY KEY (corpus_release_id, claim_id, source_id, version, locator_start),
    FOREIGN KEY (corpus_release_id, claim_id)
        REFERENCES knowledge.claim (corpus_release_id, claim_id),
    FOREIGN KEY (corpus_release_id, source_id, version)
        REFERENCES knowledge.source_object (corpus_release_id, source_id, version)
);

CREATE TABLE IF NOT EXISTS knowledge.concept (
    corpus_release_id text NOT NULL REFERENCES knowledge.corpus_release (id),
    concept_id text NOT NULL,
    definition text NOT NULL,
    status text NOT NULL CHECK (status IN ('active', 'withdrawn')),
    PRIMARY KEY (corpus_release_id, concept_id)
);

CREATE TABLE IF NOT EXISTS knowledge.concept_relationship (
    corpus_release_id text NOT NULL,
    concept_id text NOT NULL,
    related_id text NOT NULL,
    PRIMARY KEY (corpus_release_id, concept_id, related_id),
    FOREIGN KEY (corpus_release_id, concept_id)
        REFERENCES knowledge.concept (corpus_release_id, concept_id)
);

CREATE TABLE IF NOT EXISTS knowledge.current_value (
    corpus_release_id text NOT NULL,
    value_key text NOT NULL,
    source_id text NOT NULL,
    version text NOT NULL,
    value_text text NOT NULL,
    unit text,
    effective_date timestamptz,
    authority text NOT NULL,
    authority_rank integer NOT NULL,
    status text NOT NULL CHECK (status IN ('active', 'withdrawn', 'historical')),
    PRIMARY KEY (corpus_release_id, value_key, source_id, version),
    FOREIGN KEY (corpus_release_id, source_id, version)
        REFERENCES knowledge.source_object (corpus_release_id, source_id, version)
);

CREATE TABLE IF NOT EXISTS knowledge.asset_object (
    corpus_release_id text NOT NULL REFERENCES knowledge.corpus_release (id),
    asset_id text NOT NULL,
    version text NOT NULL,
    mime text NOT NULL,
    content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    object_ref text NOT NULL,
    alt text NOT NULL,
    source_id text NOT NULL,
    visibility text NOT NULL CHECK (visibility IN ('public', 'internal')),
    status text NOT NULL CHECK (status IN ('active', 'withdrawn')),
    PRIMARY KEY (corpus_release_id, asset_id, version)
);

CREATE OR REPLACE FUNCTION knowledge.reject_rewrite()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'knowledge records are immutable' USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS source_object_immutable ON knowledge.source_object;
CREATE TRIGGER source_object_immutable
    BEFORE UPDATE OR DELETE ON knowledge.source_object
    FOR EACH ROW EXECUTE FUNCTION knowledge.reject_rewrite();

DROP TRIGGER IF EXISTS corpus_release_immutable ON knowledge.corpus_release;
CREATE TRIGGER corpus_release_immutable
    BEFORE UPDATE OR DELETE ON knowledge.corpus_release
    FOR EACH ROW EXECUTE FUNCTION knowledge.reject_rewrite();

DROP TRIGGER IF EXISTS claim_immutable ON knowledge.claim;
CREATE TRIGGER claim_immutable
    BEFORE UPDATE OR DELETE ON knowledge.claim
    FOR EACH ROW EXECUTE FUNCTION knowledge.reject_rewrite();

DROP TRIGGER IF EXISTS claim_citation_immutable ON knowledge.claim_citation;
CREATE TRIGGER claim_citation_immutable
    BEFORE UPDATE OR DELETE ON knowledge.claim_citation
    FOR EACH ROW EXECUTE FUNCTION knowledge.reject_rewrite();

DROP TRIGGER IF EXISTS concept_immutable ON knowledge.concept;
CREATE TRIGGER concept_immutable
    BEFORE UPDATE OR DELETE ON knowledge.concept
    FOR EACH ROW EXECUTE FUNCTION knowledge.reject_rewrite();

DROP TRIGGER IF EXISTS concept_relationship_immutable ON knowledge.concept_relationship;
CREATE TRIGGER concept_relationship_immutable
    BEFORE UPDATE OR DELETE ON knowledge.concept_relationship
    FOR EACH ROW EXECUTE FUNCTION knowledge.reject_rewrite();

DROP TRIGGER IF EXISTS current_value_immutable ON knowledge.current_value;
CREATE TRIGGER current_value_immutable
    BEFORE UPDATE OR DELETE ON knowledge.current_value
    FOR EACH ROW EXECUTE FUNCTION knowledge.reject_rewrite();

DROP TRIGGER IF EXISTS asset_object_immutable ON knowledge.asset_object;
CREATE TRIGGER asset_object_immutable
    BEFORE UPDATE OR DELETE ON knowledge.asset_object
    FOR EACH ROW EXECUTE FUNCTION knowledge.reject_rewrite();

DROP TRIGGER IF EXISTS index_generation_immutable ON knowledge.index_generation;
CREATE TRIGGER index_generation_immutable
    BEFORE UPDATE OR DELETE ON knowledge.index_generation
    FOR EACH ROW EXECUTE FUNCTION knowledge.reject_rewrite();

DROP TRIGGER IF EXISTS source_chunk_immutable ON knowledge.source_chunk;
CREATE TRIGGER source_chunk_immutable
    BEFORE UPDATE OR DELETE ON knowledge.source_chunk
    FOR EACH ROW EXECUTE FUNCTION knowledge.reject_rewrite();

GRANT USAGE ON SCHEMA knowledge TO esp_mcp, esp_publisher, esp_app;
GRANT SELECT ON ALL TABLES IN SCHEMA knowledge TO esp_mcp, esp_app;
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA knowledge TO esp_publisher;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA knowledge FROM esp_mcp;
