# GraphRAG Studio

A **document librarian** built on GraphRAG. Point it at a folder of notes, drafts and papers:
it builds a typed **knowledge graph** from them, labels every file with the concepts it
actually covers, makes the whole corpus searchable by idea rather than by filename, and lets
you **chat over k-hop subgraph retrieval** with citations back to the exact relations it used.

Plain vector RAG retrieves *passages*. GraphRAG retrieves *structure*, so it can answer
multi-hop questions ("how is X connected to Y?") that flat retrieval misses. Studio puts a
visual, interactive face on that — and then uses the same graph to answer a different
question: *which file do I actually need?*

```
 ┌── Next.js + TypeScript frontend ──┐        ┌── FastAPI backend ──────┐
 │  library view + concept search    │  HTTP  │  /api/docs   /search    │
 │  force-directed graph view        │ ─────▶ │  /api/ingest /enrich    │
 │  chat panel + citations           │        │  /api/ask    /graph     │
 └───────────────────────────────────┘        └──────────┬──────────────┘
                                                          │
                              ┌───────────────────────────┼────────────────┐
                              │                           │                │
                   ┌──────────▼─────────┐   ┌─────────────▼──────┐  ┌──────▼──────┐
                   │ librarian crew     │   │ SQLite             │  │ graphrag-   │
                   │ LangGraph, traced  │   │ docs · labels ·    │  │ agent (lib) │
                   │ Catalogue→Link→    │   │ links · cache      │  │ extract→KG  │
                   │ Critic ↺ repair    │   │                    │  │ →k-hop      │
                   └────────────────────┘   └────────────────────┘  └─────────────┘
```

The graph engine is the separate [`graphrag-agent`](https://github.com/axon011/graphrag-agent)
library — Studio is the application layer on top of it.

## Why

The corpus that drove this is a Master's-thesis working tree: 132 markdown and 308 LaTeX
files accumulated over two years, containing directories like

```
Adaptive_prune/archive/old_docs/
Adaptive_prune/archive/root_clutter/archive_outdated_docs/
```

An archive nested inside `root_clutter` inside another archive. Finding the current version
of anything meant grepping, and no tool could answer *"which files cover the Zero-T pruning
ablation, and which of them are dead drafts?"*

The insight that makes it cheap: the knowledge graph already records which chunks mention
each entity, and chunk ids carry their source document. Invert that and **a document's labels
are the concepts it mentions** — no classifier, no second model, no taxonomy to maintain.

## Demo

![GraphRAG Studio](docs/screenshot-home.png)

_The knowledge graph built from a document set — entities coloured by type, sized by mention
count. Ask a question and the retrieved subgraph lights up while the rest dims._

### On a real corpus — a Master's-thesis repository

Pointed at a thesis repo on efficient Vision Transformer inference and run with a **Claude
subscription (OAuth, no API key)**, Studio extracted **52 entities and 49 relations** from
the project's documentation. Asking a question highlights the retrieved subgraph (below) and
dims the rest:

![GraphRAG Studio on a thesis repository](docs/screenshot-thesis.png)

The payoff is the **multi-hop** question — the kind flat vector RAG struggles with because
the answer is an explicit *relationship*, not a passage:

> **Q:** How is Zero-T Pruning related to Weighted PageRank?
>
> **A:** Zero-T Pruning **uses** Weighted PageRank as its core algorithm. It runs Weighted
> PageRank on a layer's attention matrix to score each token's contribution to the global
> context (the CLS token), then prunes the rest.
>
> _cited edge:_ `Zero-T Pruning --uses--> Weighted PageRank`

The agent linked the question to the `Zero-T Pruning` entity, expanded its k-hop
neighbourhood, and answered from the subgraph — citing the exact relation it traversed.

## The librarian crew

Graph labels are cheap and topical. They cannot tell a final report from a superseded draft,
or explain *why* two documents overlap. A small LangGraph crew adds that judgement:

**Cataloguer** (title, abstract, type, status) → **Linker** (typed `supersedes` /
`derived_from` / `duplicates` links) → **Critic** → bounded **Repair**.

The Critic is load-bearing rather than decorative. It reviews claims it did not author, and
anything it will not confirm is **dropped, not downgraded** — an unconfirmed `supersedes`
never reaches the database or the UI. Every run is traced to Langfuse when keys are present,
and no-ops cleanly when they are not.

Cost is controlled by operating on **documents (440), never chunks (4,900)**, and by
shortlisting Linker candidate pairs with a SQL entity-overlap query instead of asking a model
about all 96,000 pairs.

## MCP

The same capability is exposed over MCP, so a coding agent working in the corpus can use it:

`search_docs` · `get_document` · `get_labels` · `find_related` · `ingest_path`

No MCP tool moves, renames or deletes anything. See
[ADR 0004](docs/adr/0004-propose-never-move.md).

## Stack

- **Frontend:** Next.js 15 (App Router), TypeScript, React 19, `react-force-graph-2d`
- **Backend:** FastAPI, Pydantic, SQLite, LangGraph, the `graphrag-agent` package
- **Observability:** Langfuse, optional — absent keys degrade to no-ops
- **LLM:** provider-agnostic via `graphrag-agent`
  (`GRAPHRAG_LLM=api|codex|claude|gemini|off`). Runs end to end offline with the heuristic
  extractor, and can use a **Claude Code / Codex CLI subscription instead of an API key**.

## Run it

```bash
# backend
cd backend
pip install -r requirements.txt
pip install -e ../../graphrag-agent      # the graph engine (editable)
uvicorn app.main:app --reload --port 8000

# frontend
cd frontend
cp .env.local.example .env.local         # points at http://localhost:8000
npm install && npm run dev               # http://localhost:3000
```

Then ingest a corpus:

```bash
curl -X POST localhost:8000/api/ingest \
     -H 'content-type: application/json' \
     -d '{"path": "docs"}'
```

Full setup, environment variables and troubleshooting: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Documentation

| Document | What it covers |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Layers, request flows, what is reused and why |
| [DATA_MODEL.md](docs/DATA_MODEL.md) | SQLite schema, the entity↔document join, cache keys |
| [AGENTS.md](docs/AGENTS.md) | Crew roles, Critic contract, cost model |
| [API.md](docs/API.md) | Every HTTP route and MCP tool |
| [DEVELOPMENT.md](docs/DEVELOPMENT.md) | Setup, env vars, testing, troubleshooting |
| [adr/](docs/adr/) | Decision records |

## Tests

```bash
cd backend && pytest -q                  # offline, no API key needed
```

## License

MIT
