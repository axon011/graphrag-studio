# Data model

Studio v0 kept everything in memory: one `KnowledgeGraph` and an integer document counter.
This document specifies the SQLite layer that replaces the counter, and the join that turns
graph entities into document labels.

Two stores, deliberately separate:

- **`kg.json`** — the knowledge graph, written by `KnowledgeGraph.save()`. Entities,
  relations, chunk text. Owned by `graphrag-agent`.
- **`librarian.db`** — SQLite. Documents, the entity↔document index, crew output, and the
  extraction cache. Owned by Studio.

The graph is derived data: delete `kg.json` and it can be rebuilt from `chunk_cache` with no
LLM calls. The database is the durable half.

## Schema

```sql
CREATE TABLE documents (
    id           INTEGER PRIMARY KEY,
    path         TEXT    NOT NULL UNIQUE,   -- repo-relative, forward slashes
    sha256       TEXT    NOT NULL,          -- of the file bytes
    bytes        INTEGER NOT NULL,
    mtime        REAL    NOT NULL,          -- source file mtime, epoch seconds
    chunk_count  INTEGER NOT NULL DEFAULT 0,
    ingested_at  TEXT    NOT NULL,          -- ISO-8601 UTC

    -- crew output (M3); NULL until enriched
    title        TEXT,
    abstract     TEXT,
    doc_type     TEXT,                      -- paper|notes|meeting|report|config|unknown
    status       TEXT,                      -- current|draft|superseded|unknown
    enriched_at  TEXT
);

CREATE INDEX idx_documents_status ON documents(status);
CREATE INDEX idx_documents_type   ON documents(doc_type);


CREATE TABLE doc_entities (
    doc_id     INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    entity_id  TEXT    NOT NULL,            -- slugified name, matches KG node id
    mentions   INTEGER NOT NULL,            -- chunks of this doc mentioning the entity
    PRIMARY KEY (doc_id, entity_id)
);

CREATE INDEX idx_doc_entities_entity ON doc_entities(entity_id);


CREATE TABLE doc_links (
    src_id      INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    dst_id      INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    type        TEXT    NOT NULL,           -- supersedes|derived_from|duplicates|cites
    confidence  REAL    NOT NULL,           -- 0..1, from the Linker
    rationale   TEXT    NOT NULL,           -- why; shown in the UI, never hidden
    created_at  TEXT    NOT NULL,
    PRIMARY KEY (src_id, dst_id, type)
);

CREATE INDEX idx_doc_links_dst ON doc_links(dst_id);


CREATE TABLE chunk_cache (
    key             TEXT PRIMARY KEY,       -- "{extractor}:{sha256}"
    sha256          TEXT NOT NULL,          -- of chunk TEXT, not the file
    extractor       TEXT NOT NULL,          -- 'llm' | 'offline'
    model           TEXT NOT NULL,          -- provider that produced it, for forensics
    extraction_json TEXT NOT NULL,          -- chunk-id-FREE payload; see below
    created_at      TEXT NOT NULL
);

CREATE INDEX idx_chunk_cache_extractor ON chunk_cache(extractor);
```

`doc_links` has no `UNIQUE(src_id, dst_id)`: two documents can legitimately be connected by
more than one relation type. The primary key includes `type` for that reason.

## The entity ↔ document join

Nothing new is extracted to populate `doc_entities`. The trace already exists in
`graphrag-agent` and is currently discarded.

`Entity.mentions` (`models.py`) holds chunk ids. `chunk_text()` (`chunk.py`) builds them as:

```python
Chunk(id=f"{source}#{i}", text=w, source=source)
```

So the document is recoverable from any chunk id:

```python
def source_of(chunk_id: str) -> str:
    return chunk_id.rsplit("#", 1)[0]
```

At ingest, walk the graph once and count:

```python
counts: dict[tuple[str, str], int] = {}
for entity_id, data in kg.g.nodes(data=True):
    for chunk_id in data.get("mentions", []):
        counts[(source_of(chunk_id), entity_id)] = \
            counts.get((source_of(chunk_id), entity_id), 0) + 1
```

That dictionary is `doc_entities`. Two features derive from it directly:

**Labels** — a document's top concepts:

```sql
SELECT entity_id, mentions FROM doc_entities
WHERE doc_id = ? ORDER BY mentions DESC LIMIT 5;
```

**Relatedness / Linker shortlist** — documents sharing concepts, without an LLM:

```sql
SELECT b.doc_id, COUNT(*) AS shared, SUM(MIN(a.mentions, b.mentions)) AS weight
FROM doc_entities a
JOIN doc_entities b ON a.entity_id = b.entity_id AND b.doc_id != a.doc_id
WHERE a.doc_id = ?
GROUP BY b.doc_id
HAVING shared >= :min_shared
ORDER BY weight DESC
LIMIT :k;
```

This query is what keeps the crew affordable: the Linker adjudicates a bounded shortlist per
document instead of all 440 × 439 pairs. See [AGENTS.md](AGENTS.md).

## `path` is the document identity

`path` is repo-relative with forward slashes, e.g. `Adaptive_prune/docs/README.md`.

This is not cosmetic. `load_chunks()` currently sets `source=p.name` — the basename. The
target corpus contains many `README.md` files; under the join above every one of them
resolves to the same source string and merges into a single phantom document whose labels
are the union of unrelated files. The bug is silent: no error, just quietly wrong labels.

Consequences of the fix:

- `source` in `Chunk` and chunk ids are relative paths, so ids look like
  `Adaptive_prune/docs/README.md#3`.
- `rsplit("#", 1)` still works — `#` does not occur in these paths. Any path containing `#`
  is rejected at ingest with a clear error rather than being silently mis-parsed.
- Paths are normalised to forward slashes on Windows so the database is portable.

See [ADR 0003](adr/0003-relative-path-as-source.md).

## Cache keys

`chunk_cache.sha256` hashes the **chunk text**, not the file. Chunking is a pure function of
(text, size, overlap), so a chunk that survives an edit elsewhere in the file keeps its hash
and its cached extraction. Editing one paragraph of a large document re-extracts the affected
chunks, not the document.

The stored key prefixes that hash with the extractor class:

```python
key = f"{extractor}:{hashlib.sha256(chunk.text.encode('utf-8')).hexdigest()}"
```

`documents.sha256` hashes the **file** bytes, and is a different thing: it answers "has this
file changed since ingest?" for incremental re-ingest.

### Chunk ids are stripped before storing

This is what makes the cache safe rather than merely fast, and it is easy to get wrong.

An `Extraction` is **bound to the chunk it came from**. `extract.py` writes the chunk id into
every entity and every relation:

```python
Entity(name=n, mentions=[chunk.id])          # ← chunk id
Relation(..., evidence=chunk.id)             # ← chunk id
```

Chunk ids encode the source document (`alpha/README.md#0`). So caching an `Extraction`
verbatim and replaying it for a different chunk with identical text would attribute those
entities to the document the extraction was *first* seen in — the same class of silent
cross-attribution as the basename bug in [ADR 0003](adr/0003-relative-path-as-source.md), and
just as invisible.

The cache therefore stores an id-free payload — entity names and types, relation endpoints,
types and descriptions — and rebinds `mentions` and `evidence` to the requesting chunk on
read. `app/cache.py` implements this as `dumps()` / `loads(payload, chunk_id)`, and
`test_cache.py` asserts it directly: identical text in two documents yields a cache hit whose
mentions point at the *requesting* document.

### Offline extractions are quarantined

`GRAPHRAG_LLM=off` uses a heuristic extractor whose output is far weaker than an LLM's.
Reusing it once a real provider is configured would leave a corpus permanently degraded with
nothing to indicate why.

The extractor class (`llm` or `offline`) is part of the cache key, so the two never mix.
Ingesting offline and then re-ingesting with a provider re-extracts everything, which is the
correct cost.

## Lifecycle

| Event | Effect |
|---|---|
| File ingested first time | `documents` row inserted; `doc_entities` populated; chunks cached |
| File unchanged, re-ingest | `sha256` matches → skipped entirely, no chunking, no LLM |
| File edited, re-ingest | `doc_entities` deleted and rebuilt for that doc; changed chunks re-extracted; crew fields kept but `enriched_at` cleared so the crew revisits it |
| File deleted from disk | Row kept, marked stale. `doc_links` referencing it survive so history is not lost |
| `POST /api/reset` | Clears the graph only. **Never** touches `documents`, `doc_links` or `chunk_cache` |

That last row matters. In v0 `/api/reset` was harmless because it dropped an in-memory graph.
Once documents are durable, reset must not delete the corpus — it rebuilds the graph, which
the cache makes cheap.

## Not in this model

- **PDF, JSON, CSV, notebooks.** Markdown and LaTeX only for now. PDFs need a text-extraction
  stage; JSON/CSV are data, and entity extraction over them is mostly noise.
- **Full-text search.** Search goes through the concept graph. If literal substring search is
  wanted later, SQLite FTS5 over chunk text is the natural addition — the chunks are already
  stored in `kg.json`.
- **Embeddings / vector search.** The graph is the retrieval mechanism here. Adding a vector
  index is a real option later, but it is a different retrieval strategy, not a schema detail.
- **Multi-user.** No `user_id` anywhere. Single user, single corpus, one global store.
