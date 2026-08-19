# GraphRAG Studio — working context

Studio is being extended from a GraphRAG demo into a **document librarian** for a
Master's-thesis corpus. Branch: `feat/thesis-librarian`.

**Read the docs before changing anything.** They are the contracts, written before the code:

| Read this | Before touching |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | anything structural |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md) | the schema, labels, or the cache |
| [docs/AGENTS.md](docs/AGENTS.md) | the crew |
| [docs/API.md](docs/API.md) | any route or MCP tool |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | setup, env vars, troubleshooting |
| [docs/adr/](docs/adr/) | anything one of the five ADRs already decided |

The sibling library `../graphrag-agent` is **edited as part of this work** and has its own
`CLAUDE.md`. Read it too — the relative-path fix lives there, not here.

---

## Status

| Milestone | State |
|---|---|
| **M0 documentation** | done — 5 docs + 5 ADRs + README repositioned |
| **M1 ingest that scales** | **in progress** — 2 of 4 pieces done |
| M2 SQLite document layer | not started |
| M3 librarian crew | not started |
| M4 library UI | not started |
| M5 MCP server | not started |
| M6 restructure proposals | gated behind all of the above |

### M1 detail

| Piece | State |
|---|---|
| Relative-path source fix | **done** — in `graphrag-agent`, see its CLAUDE.md |
| Content-hash extraction cache | **done** — `backend/app/cache.py`, 16 tests |
| Bounded concurrency around `extract_chunk` | **next** |
| Resumable ingest walker + skip list | not started |

Tests currently green: **22 studio + 21 graphrag-agent**.

**Nothing is committed.** Aravind rejected the `git add`; ask before committing. No
Co-Authored-By lines.

---

## The one idea to understand first

`Entity.mentions` holds chunk ids. `chunk_text()` builds them as `f"{source}#{i}"`. So:

```
entity → mentions[] → chunk_id → rsplit("#", 1)[0] → source document
```

That join already exists and is currently discarded. Inverted, it gives labels and
document relatedness with no classifier and no extra LLM calls. `doc_entities` *is* that
inverted index, not a cache of something computed elsewhere.

`graphrag_agent.source_of(chunk_id)` is the canonical inverse — use it, don't re-split by hand.

---

## The failure mode this project keeps hitting

**Silent cross-attribution.** Twice now, a plausible design would have quietly attributed one
document's content to another, with no error and no visible symptom:

1. **`source=p.name`** (fixed) — the corpus has many `README.md` files; basename identity
   merged them into one phantom document whose labels were the union of unrelated files.
2. **Caching `Extraction` objects verbatim** (avoided) — an `Extraction` embeds `chunk.id` in
   `Entity.mentions` and `Relation.evidence`. Replaying a cached one for a different chunk
   with identical text would attribute its entities to whichever document was cached *first*.
   Two files sharing one boilerplate paragraph is enough to trigger it.

Before adding anything that moves extraction data between chunks or documents, ask what it
binds to and whether that binding is still correct at the destination. Assume there will be
no error message.

---

## Hard rules

- **Propose, never move.** Nothing relocates, renames or deletes a file as a side effect.
  Restructuring emits a reviewable diff; applying is separate and writes a reversible
  manifest first. The corpus is a live thesis. ([ADR 0004](docs/adr/0004-propose-never-move.md))
- **Develop against a copy of the corpus.** The real tree is
  `C:\Users\Aravind\Desktop\workspace\AI`, owned by the THESIS workspace. Never write to it.
  Point `CORPUS_ROOT` at a copy.
- **Unverified claims are dropped, not downgraded.** A `supersedes` link the Critic will not
  confirm never reaches the database. No confidence-threshold escape hatch.
- **One LLM abstraction.** The crew calls `graphrag_agent.llm.LLM` (`complete`,
  `complete_json`). Do **not** add LangChain chat models or `ChatClaudeCode` — the provider
  switch already handles `api|codex|claude|gemini|off` including subscription auth.
  ([ADR 0005](docs/adr/0005-langgraph-over-crewai.md))
- **Offline must keep working.** `GRAPHRAG_LLM=off` runs the heuristic extractor and the whole
  test suite with no network. Ingest, labels, search and the UI all work in that mode; only
  crew enrichment is skipped.
- **`source` is the repo-relative path**, never the basename.
  ([ADR 0003](docs/adr/0003-relative-path-as-source.md))
- **`/api/reset` clears the graph only.** Never documents, links or the cache.
- **No Co-Authored-By in commits.** Don't commit unless asked.

---

## Cost model — the constraint behind most decisions

3.7 MB of markdown + LaTeX → **~4,900 chunks → 440 documents**. Those numbers are an order of
magnitude apart and the design leans on the difference:

- Extraction runs per chunk, so it must be **cached by content hash** — otherwise every run
  is ~2.7 hours (serial, one LLM call per chunk) and a crash loses all of it.
- The crew runs per **document**, never per chunk.
- Linker candidate pairs come from a **SQL entity-overlap shortlist**, not from the model.
  Pairwise adjudication would be ~96,000 calls.

If a change makes the crew chunk-level, or makes the Linker consider all pairs, it is wrong.

---

## `app/cache.py` — what to know before using it

```python
cache = ExtractionCache(path, extractor=extractor_class(llm.provider))
found = cache.get_many(chunks)              # one query for the batch
# ... extract only the misses ...
cache.put_many([(chunk, ext) for ...], model=llm.provider)
```

- **Key is `f"{extractor}:{sha256(chunk.text)}"`.** Text hash, not file hash. A chunk that
  survives an edit elsewhere in its file keeps its cached extraction.
- **`dumps()` strips chunk ids; `loads(payload, chunk_id)` rebinds them.** Never store an
  `Extraction` directly — see the failure mode above.
- **`llm` and `offline` extractions never mix.** Ingesting with `GRAPHRAG_LLM=off` and then
  re-ingesting with a provider re-extracts everything, which is the correct cost — otherwise
  a corpus stays permanently degraded with no signal.
- **Use `get_many` / `put_many` in loops.** Per-chunk `get()` is thousands of round trips and
  defeats the point.
- **Thread-safe by construction** — each call opens its own connection, because extraction
  runs on a worker pool and sqlite3 connections are not shareable across threads.
- Changing `GRAPHRAG_CHUNK_SIZE` or `GRAPHRAG_CHUNK_OVERLAP` moves every boundary and
  invalidates the whole cache. Settle those before the first large ingest.

---

## Layout

```
backend/app/
  main.py          routes
  store.py         GraphStore — the seam between HTTP and the engine
  schemas.py       Pydantic request/response models
  cache.py         extraction cache                     (M1, done)
  db.py            SQLite document layer                (M2)
  agents/          librarian crew                       (M3)
  observability.py Langfuse, no-ops without keys        (M3)
  mcp_server.py    MCP adapter over the service layer   (M5)
backend/tests/
  test_cache.py    16 tests                             (M1, done)
frontend/
  app/             App Router pages
  components/      GraphView.tsx, plus library components (M4)
  lib/api.ts       typed fetch client
```

`graphrag-agent` is installed editable from `../graphrag-agent`.

---

## Conventions

- Python: type hints, `from __future__ import annotations`, Pydantic at the HTTP boundary.
- Frontend: no UI library. Plain CSS in `app/globals.css`; follow `GraphView.tsx`.
- SQL: plain SQL, no ORM. Migrations guarded by `PRAGMA user_version`.
  Set `PRAGMA foreign_keys = ON` per connection — SQLite defaults it off.
- Tests run offline (`GRAPHRAG_LLM=off`), no network, no API key. Keep it that way.
  Note the studio suite takes ~80s; that is the heuristic extractor, not a hang.
- When a decision has a defensible alternative, write an ADR rather than a comment.
- When a doc turns out to be wrong once code exists, **fix the doc in the same change**.
  `DATA_MODEL.md`'s cache section was rewritten this way when the chunk-id binding surfaced.
