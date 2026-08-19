# API

HTTP endpoints and MCP tools.

## Base URL

```
http://localhost:8000
```

Interactive docs: `/docs` (Swagger) and `/redoc`, both served by FastAPI.

---

## Configuration

### LLM provider

Extraction, answering and the crew all go through `graphrag_agent.llm.LLM`, selected by one
variable:

```bash
GRAPHRAG_LLM=auto     # default: first available — api, codex, claude, gemini, else off
GRAPHRAG_LLM=claude   # Claude Code subscription (OAuth, no API key)
GRAPHRAG_LLM=codex    # Codex CLI subscription
GRAPHRAG_LLM=gemini   # Gemini CLI
GRAPHRAG_LLM=api      # OpenAI-compatible; needs OPENAI_API_KEY
GRAPHRAG_LLM=off      # heuristic extractor, no network — used by the tests
```

Under `off`, ingest, labels, search and the UI all work; only `/api/enrich` is skipped.

### Storage

```bash
LIBRARIAN_DB=./librarian.db          # SQLite; documents, links, cache
GRAPHRAG_STUDIO_GRAPH=./kg.json      # knowledge graph; rebuildable from the cache
CORPUS_ROOT=/path/to/corpus          # paths in the API are relative to this
```

### Observability (optional)

```bash
LANGFUSE_PUBLIC_KEY=pk-...
LANGFUSE_SECRET_KEY=sk-...
LANGFUSE_HOST=https://cloud.langfuse.com
```

Unset → tracing is a no-op. Nothing else changes.

---

## Endpoints

### Graph — existing

#### `GET /api/health`

Graph statistics and the resolved provider.

```json
{ "nodes": 52, "edges": 49, "documents": 12, "provider": "llm" }
```

#### `GET /api/graph`

```json
{
  "nodes": [{ "id": "zero_t_pruning", "label": "Zero-T Pruning", "type": "method", "mentions": 7 }],
  "edges": [{ "source": "zero_t_pruning", "target": "weighted_pagerank", "label": "uses", "description": "..." }],
  "stats": { "nodes": 52, "edges": 49, "documents": 12, "provider": "llm" }
}
```

#### `POST /api/build`

Body `{ "text": "...", "source": "notes.md", "reset": false }` → updated graph.

#### `POST /api/upload`

Multipart `file`, optional `?reset=true` → updated graph. Single ad-hoc file; for a corpus
use `/api/ingest`.

#### `POST /api/ask`

Body `{ "question": "How is Zero-T Pruning related to Weighted PageRank?" }`

```json
{
  "answer": "Zero-T Pruning uses Weighted PageRank as its core algorithm...",
  "citations": [{ "kind": "relation", "ref": "Zero-T Pruning --uses--> Weighted PageRank" }],
  "triples": ["Zero-T Pruning --uses--> Weighted PageRank"],
  "subgraph_node_ids": ["zero_t_pruning", "weighted_pagerank"]
}
```

#### `POST /api/reset`

Clears the **graph only**. Documents, links and the extraction cache survive; the graph is
rebuilt from the cache without LLM calls. See [DATA_MODEL.md](DATA_MODEL.md).

---

### Documents — new

#### `POST /api/ingest`

Walk a directory, chunk, extract, index. Resumable and cache-first: unchanged files are
skipped by hash, unchanged chunks reuse cached extractions.

Body:

```json
{ "path": "Adaptive_prune/docs", "extensions": [".md", ".tex"], "force": false }
```

| Field | Default | Meaning |
|---|---|---|
| `path` | required | Relative to `CORPUS_ROOT`; file or directory |
| `extensions` | `[".md", ".tex"]` | Filter |
| `force` | `false` | Re-extract even on cache hits |

Response:

```json
{
  "scanned": 118, "ingested": 12, "skipped_unchanged": 106,
  "chunks_total": 1430, "chunks_extracted": 88, "chunks_cached": 1342,
  "duration_seconds": 41.2,
  "errors": [{ "path": "docs/weird#name.md", "error": "path contains '#'" }]
}
```

`.gitignore` is honoured, plus `.venv/`, `__pycache__/`, `node_modules/`, `.git/`.

`errors` is per-file and never aborts the run — one unreadable file does not lose the batch.

#### `GET /api/docs`

Query: `?status=`, `?doc_type=`, `?label=`, `?limit=` (default 100), `?offset=`,
`?sort=` (`path` | `mtime` | `chunks`).

```json
{
  "total": 440,
  "documents": [
    {
      "id": 17,
      "path": "Adaptive_prune/docs/ABLATION_RESULTS.md",
      "bytes": 18342,
      "mtime": "2026-07-31T09:12:04Z",
      "chunk_count": 24,
      "title": "Zero-T pruning ablation results",
      "abstract": "Reports accuracy and FLOPs across pruning ratios...",
      "doc_type": "report",
      "status": "current",
      "labels": [
        { "entity_id": "zero_t_pruning", "name": "Zero-T Pruning", "mentions": 14 },
        { "entity_id": "weighted_pagerank", "name": "Weighted PageRank", "mentions": 6 }
      ]
    }
  ]
}
```

`title`, `abstract`, `doc_type` and `status` are `null` until the document is enriched.

#### `GET /api/docs/{id}`

One document, plus what `/api/docs` omits:

```json
{
  "document": { "...": "as above" },
  "labels": [{ "entity_id": "...", "name": "...", "mentions": 14 }],
  "related": [{ "id": 22, "path": "...", "shared_entities": 9, "weight": 31 }],
  "links": [
    {
      "type": "supersedes",
      "direction": "outgoing",
      "other": { "id": 41, "path": "Adaptive_prune/archive/old_docs/ABLATION_RESULTS.md" },
      "confidence": 0.86,
      "rationale": "Both report the same ablation grid; this one adds the 0.7 ratio row and is 4 months newer."
    }
  ],
  "subgraph_node_ids": ["zero_t_pruning", "weighted_pagerank"]
}
```

`related` is graph-derived and always present. `links` is crew-derived, Critic-confirmed, and
empty until enrichment runs. `rationale` is always returned — a link without its reasoning is
not shown in the UI.

#### `GET /api/search`

Query: `?q=` (required), `?limit=` (default 20), `?hops=` (default from config).

Concept-aware: the query resolves to entities, expands k-hop, and maps back to documents. A
search for `pruning` returns Zero-T and DynamicViT documents even where the literal word is
absent.

```json
{
  "query": "zero-t pruning ablation",
  "seed_entities": [{ "entity_id": "zero_t_pruning", "name": "Zero-T Pruning" }],
  "expanded_entities": 11,
  "results": [
    {
      "id": 17,
      "path": "Adaptive_prune/docs/ABLATION_RESULTS.md",
      "score": 0.91,
      "matched_entities": ["zero_t_pruning", "ablation"],
      "title": "Zero-T pruning ablation results",
      "status": "current"
    }
  ]
}
```

Empty `seed_entities` means the query matched no concept — the response is a valid empty
result, not an error.

#### `POST /api/enrich`

Run the librarian crew over un-enriched documents. See [AGENTS.md](AGENTS.md).

Body:

```json
{ "doc_ids": null, "limit": 50, "force": false, "enable_critic": true }
```

`doc_ids: null` means "all un-enriched". `force: true` re-enriches already-processed
documents. `enable_critic: false` is for debugging only — it disables the check that keeps
unsupported links out of the database, and should never be used on a real run.

Response:

```json
{
  "enriched": 48, "skipped": 2, "failed": 0,
  "links_proposed": 61, "links_confirmed": 44, "links_dropped": 17,
  "critic_score": 0.79,
  "duration_seconds": 512.8,
  "trace_url": "https://cloud.langfuse.com/trace/abc123"
}
```

`links_dropped` is the Critic doing its job: proposed minus confirmed. A run where
`links_dropped` is always zero means the Critic is rubber-stamping and should be
investigated, not celebrated.

`trace_url` is `null` when Langfuse is not configured.

With `GRAPHRAG_LLM=off`:

```json
{ "enriched": 0, "skipped": 440, "reason": "no LLM provider; crew skipped" }
```

---

## Errors

Standard FastAPI shape:

```json
{ "detail": "uploaded file is empty" }
```

| Status | When |
|---|---|
| 400 | Empty upload, blank question, blank search query, path containing `#` |
| 404 | Unknown document id |
| 409 | Ingest or enrich already running (both are single-flight) |
| 500 | Provider failure after retries; the partial run is still committed |

Long operations are single-flight rather than queued. Concurrent `/api/ingest` calls get 409
with the in-progress run's stats; this is a single-user tool and a queue would be
unnecessary machinery.

---

## MCP tools

`backend/mcp_server.py` — stdio, a thin adapter over the same service functions the HTTP
routes call. No second implementation.

| Tool | Arguments | Returns |
|---|---|---|
| `search_docs` | `query`, `limit?` | Ranked documents with paths, titles, matched entities |
| `get_document` | `path` | Metadata, labels, abstract, status |
| `get_labels` | `path` | Ranked entity labels |
| `find_related` | `path`, `limit?` | Related documents plus confirmed links with rationale |
| `ingest_path` | `path`, `force?` | Ingest summary |

Every tool returns **repo-relative paths**, so a coding agent can open the file it was told
about. No tool moves, renames or deletes anything —
[ADR 0004](adr/0004-propose-never-move.md) applies to MCP as much as to the UI.

Register it for Claude Code:

```json
{
  "mcpServers": {
    "thesis-librarian": {
      "command": "python",
      "args": ["-m", "app.mcp_server"],
      "cwd": "/path/to/graphrag-studio/backend",
      "env": {
        "LIBRARIAN_DB": "/path/to/librarian.db",
        "CORPUS_ROOT": "/path/to/corpus",
        "GRAPHRAG_LLM": "claude"
      }
    }
  }
}
```
