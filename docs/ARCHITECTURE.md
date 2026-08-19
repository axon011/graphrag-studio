# Architecture

Studio started as a viewer for a knowledge graph. This document describes what it is
becoming: a **librarian for a document corpus**, where the knowledge graph is the
machinery underneath rather than the product itself.

## The problem this shape solves

The target corpus is a Master's-thesis working tree — 132 markdown and 308 LaTeX files
(3.7 MB) accumulated over two years, with directories like
`archive/root_clutter/archive_outdated_docs/`. Two questions are hard to answer today and
they need different machinery:

| Question | Answered by |
|---|---|
| "What is this corpus *about*, and how do the ideas connect?" | the knowledge graph (already built) |
| "Which *file* holds the current Zero-T ablation, and which are dead drafts?" | the document layer (new) |

The first is about concepts. The second is about files. Studio v0 only modelled the first,
which is why `store.py` represents a document as `self._docs = 0` — an integer counter.

## Layers

```
┌──────────────────────── Next.js frontend ─────────────────────────┐
│  Library view (new)                    Graph view (exists)        │
│  · document table                      · force-directed graph     │
│  · auto-labels + concept filter        · subgraph highlight/dim   │
│  · crew abstracts + status badges      · chat with citations      │
└───────────────────────────┬───────────────────────────────────────┘
                            │ HTTP (typed client in lib/api.ts)
┌───────────────────────────▼──────── FastAPI ──────────────────────┐
│  new:     /api/docs  /api/docs/{id}  /api/search                  │
│           /api/ingest  /api/enrich                                │
│  exists:  /api/build /api/upload /api/ask /api/graph /api/reset   │
├───────────────────────────────────────────────────────────────────┤
│  Librarian crew — LangGraph, Langfuse-traced            (new, M3) │
│      Cataloguer → Linker → Critic ─┬─ accept                      │
│                                    └─ repair ↺ (capped)           │
├───────────────────────────────────────────────────────────────────┤
│  Persistence — SQLite                                   (new, M2) │
│      documents · doc_entities · doc_links · chunk_cache           │
├───────────────────────────────────────────────────────────────────┤
│  graphrag-agent (library)                            (exists)     │
│      chunk → extract → KnowledgeGraph → find/k_hop → answer       │
└───────────────────────────────────────────────────────────────────┘
```

The dependency direction never inverts: the frontend knows about the API, the API knows
about the crew and the store, and `graphrag-agent` knows about none of them. It stays a
standalone library that is useful without Studio.

## The document ↔ concept join

This is the load-bearing idea, and it needs no new extraction pass.

`graphrag-agent` already records where every entity was seen. In `models.py`, `Entity.mentions`
is a list of **chunk ids**, and `chunk.py` builds those ids as `f"{source}#{i}"`. So the join
already exists in data that is being thrown away today:

```
entity ──mentions[]──▶ chunk_id ──rsplit("#", 1)[0]──▶ source document
```

Invert it and two features fall out for free:

- **Labels.** A document's labels are the entities its chunks mention, ranked by mention
  count. No classifier, no second model, no separate taxonomy to maintain.
- **Relatedness.** Two documents are related in proportion to the entities they share. This
  is a SQL `GROUP BY` over `doc_entities`, not an LLM call.

`doc_entities` is therefore not a cache of something computed elsewhere — it *is* the
inverted index, materialised once at ingest.

### Why `source` must become a relative path

`load_chunks()` in `chunk.py` currently sets `source=p.name`, the basename only. The target
corpus contains many files named `README.md`. Under the join above they all resolve to the
same source string and silently merge into one phantom document whose labels are the union
of unrelated files.

Source becomes the **repo-relative path** (`Adaptive_prune/docs/README.md`). This is a
correctness fix in the library, not a Studio-local workaround. See
[ADR 0003](adr/0003-relative-path-as-source.md).

## Request flows

### Ingest — `POST /api/ingest`

```
path ──▶ walk (respecting .gitignore)
      ──▶ for each file: read, hash, chunk
      ──▶ chunk_cache lookup by sha256
             hit  ──▶ reuse stored extraction   (no LLM call)
             miss ──▶ extract_chunk  (bounded worker pool)
      ──▶ merge extractions into KnowledgeGraph  (single-threaded)
      ──▶ upsert documents + doc_entities
      ──▶ persist KG via KnowledgeGraph.save()
```

Two properties matter more than speed. **Resumability**: state is committed per batch, so a
crash costs one batch rather than the whole run. **Cache-first**: editing one file and
re-ingesting costs one extraction, not 4,900 — which is the difference between a tool used
once and a tool used daily.

Merging is deliberately single-threaded. `KnowledgeGraph._merge_entity` mutates a shared
`networkx` graph; only extraction is parallel.

### Search — `GET /api/search?q=`

```
query ──▶ KnowledgeGraph.find(q)      → seed entity ids   (exists)
      ──▶ KnowledgeGraph.k_hop(seeds) → expanded entities (exists)
      ──▶ doc_entities join           → ranked documents  (new)
```

Concept-aware search reusing retrieval code that already works. A search for "pruning"
returns documents about Zero-T and DynamicViT even where the literal word is absent,
because the graph connects them.

### Enrich — `POST /api/enrich`

Runs the librarian crew over documents lacking an abstract. See
[AGENTS.md](AGENTS.md) for the crew itself.

## What is reused, and why

### From `graphrag-agent` (a dependency)

| Reused | Where | Why not rewrite |
|---|---|---|
| `chunk_text` / `load_chunks` | `chunk.py` | Overlapping windows on word boundaries, already tuned |
| `extract_chunk` | `extract.py` | Prompt + JSON parsing for entity/relation extraction |
| `KnowledgeGraph` | `graph.py` | `find`, `k_hop`, `triples`, `evidence_chunks`, JSON `save`/`load` |
| `LLM` | `llm.py` | Provider switch `api\|codex\|claude\|gemini\|off`, including subscription-backed CLI providers |

**The crew uses this `LLM` class, not LangChain's chat models.** `multi-agent-pipeline` uses
`ChatClaudeCode` because it is LangChain-native, but this repo already has a working provider
abstraction with `complete()` and `complete_json()` — including running on a Claude
subscription with no API key. Introducing a second LLM stack would mean two config surfaces,
two retry policies and two failure modes for no gain. LangGraph orchestrates; `LLM` calls.
See [ADR 0005](adr/0005-langgraph-over-crewai.md).

### From `multi-agent-pipeline` (patterns, copied — not a dependency)

| Pattern | Source file | How it is used here |
|---|---|---|
| `StateGraph` with a conditional repair edge | `app/graph/pipeline.py` | Crew topology |
| Adversarial review + bounded repair | `app/agents/critic.py` | Critic contract |
| Per-claim verdict model | `app/models/schemas.py` (`CritiqueVerdict`) | Verdict shape |
| Langfuse tracing that no-ops without keys | `app/observability.py` | Copied nearly verbatim |

`observability.py` is worth copying rather than reinventing: it degrades to no-ops when
`LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` are unset, so agent code carries no conditional
tracing logic and the test suite needs no Langfuse at all.

Copying rather than depending is deliberate — `multi-agent-pipeline` is a portfolio project
with its own release cadence, and coupling two unrelated repos to share four files would be
the worse trade.

## Design constraints

**Propose, never move.** Nothing in this system relocates, renames or deletes a file as a
side effect. Restructuring emits a reviewable diff; applying it is a separate explicit action
that writes a reversible manifest first. The corpus is a live thesis; an auto-mover is one
bug away from unrecoverable. See [ADR 0004](adr/0004-propose-never-move.md).

**Unverified claims are dropped, not downgraded.** When the Critic will not confirm a
`supersedes` link, it does not become a low-confidence link — it disappears. A wrong
"superseded" badge on a current draft is worse than no badge.

**Offline must keep working.** `GRAPHRAG_LLM=off` runs the heuristic extractor and the whole
test suite with no network. The document layer, search and UI must all work in that mode;
only crew enrichment degrades.

**Single user, single corpus.** `GraphStore` is one global instance. Multi-tenancy is not a
goal and its absence is what keeps the code small. See
[ADR 0002](adr/0002-sqlite-over-postgres.md).
