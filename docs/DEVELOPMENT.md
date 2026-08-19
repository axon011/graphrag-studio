# Development

## Setup

```bash
# backend
cd backend
python -m venv .venv && . .venv/Scripts/activate     # Windows; use bin/activate on Unix
pip install -r requirements.txt
pip install -e ../../graphrag-agent                  # the graph engine, editable

# frontend
cd ../frontend
cp .env.local.example .env.local                     # points at http://localhost:8000
npm install
```

`graphrag-agent` is installed editable because the librarian requires changes to it — most
importantly the relative-path fix in
[ADR 0003](adr/0003-relative-path-as-source.md). Expect to edit both repos in one session.

## Run

```bash
# terminal 1
cd backend && uvicorn app.main:app --reload --port 8000

# terminal 2
cd frontend && npm run dev            # http://localhost:3000
```

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `GRAPHRAG_LLM` | `auto` | `api` · `codex` · `claude` · `gemini` · `off` |
| `OPENAI_API_KEY` | – | Only for `GRAPHRAG_LLM=api` |
| `LIBRARIAN_DB` | `./librarian.db` | SQLite file |
| `GRAPHRAG_STUDIO_GRAPH` | `./kg.json` | Knowledge graph; rebuildable from cache |
| `CORPUS_ROOT` | – | Root that all API paths are relative to |
| `GRAPHRAG_CHUNK_SIZE` | `900` | Changing this invalidates the chunk cache |
| `GRAPHRAG_CHUNK_OVERLAP` | `150` | Same |
| `GRAPHRAG_HOPS` | `2` | k-hop expansion for search and answers |
| `LANGFUSE_PUBLIC_KEY` | – | Optional; unset → tracing no-ops |
| `LANGFUSE_SECRET_KEY` | – | Optional |
| `LANGFUSE_HOST` | `https://cloud.langfuse.com` | Optional |

`GRAPHRAG_LLM=claude` runs `claude -p` with MCP isolation
(`--strict-mcp-config --mcp-config '{"mcpServers":{}}'`) so it returns promptly and is not
slowed by interactive-session hooks.

Changing `GRAPHRAG_CHUNK_SIZE` or `GRAPHRAG_CHUNK_OVERLAP` changes chunk boundaries, so every
cached extraction misses and a full re-ingest follows. Settle on values before the first
large ingest.

## Working against the corpus

**Develop against a copy.** The thesis tree is live and belongs to another workspace; nothing
here should write to it. Ingest and enrich are read-only by design, but a copy removes the
question entirely and is required before any restructure work
([ADR 0004](adr/0004-propose-never-move.md)).

```bash
# Windows
robocopy "C:\Users\Aravind\Desktop\workspace\AI" "C:\dev\corpus-copy" /E /XD .git .venv __pycache__ node_modules

# Unix
rsync -a --exclude .git --exclude .venv --exclude __pycache__ --exclude node_modules \
      ~/workspace/AI/ ~/dev/corpus-copy/
```

Then `CORPUS_ROOT=C:/dev/corpus-copy`.

### Start with a subtree

The full corpus is 440 markdown and LaTeX files, ~3.7 MB, ~4,900 chunks. The first ingest is
the expensive one; every later run is cache-served. Measure on a subtree before committing to
the whole thing:

```bash
curl -X POST localhost:8000/api/ingest \
     -H 'content-type: application/json' \
     -d '{"path": "Adaptive_prune/docs"}'
```

Read `chunks_extracted` versus `chunks_cached` in the response and extrapolate. Re-run the
same command: the second run should report `skipped_unchanged` equal to the file count and
finish in about a second. If it does not, the cache is not working and a full ingest will
hurt.

## Tests

```bash
cd backend && pytest -q         # offline, no API key, no network
```

The suite runs with `GRAPHRAG_LLM=off` against the heuristic extractor. Keep it that way —
tests that need a provider are not tests that run in CI.

Crew tests use a stub `LLM` returning canned JSON. The one that matters is the Critic
rejection case: a fabricated `supersedes` claim against a document that does not support it
must produce an `unsupported` verdict and leave no row in `doc_links`. If that test ever
passes without the Critic running, the Critic is decorative.

## Conventions

- **Python**: type hints throughout, `from __future__ import annotations`, Pydantic models
  for anything crossing the HTTP boundary. Match the existing style in `app/` — it is small
  and consistent.
- **Frontend**: no UI library. Plain CSS in `app/globals.css`, typed fetch helpers in
  `lib/api.ts`. Follow what `GraphView.tsx` and `page.tsx` already do.
- **SQL**: plain SQL in `app/db.py`, no ORM. Migrations guarded by `PRAGMA user_version`.
- **Docs**: when a decision has a defensible alternative, write an ADR rather than a comment.

## Troubleshooting

**Ingest is slow and `chunks_cached` stays 0.** The cache key is the chunk text hash. Check
`GRAPHRAG_CHUNK_SIZE` / `GRAPHRAG_CHUNK_OVERLAP` have not changed, and that the run is not
passing `force: true`.

**Two files collapse into one document.** The relative-path fix is not applied — `source` is
still a basename. See [ADR 0003](adr/0003-relative-path-as-source.md); verify with a subtree
containing two `README.md` files.

**`/api/enrich` returns `skipped` for everything.** No LLM provider resolved. Check
`GRAPHRAG_LLM` and that the chosen CLI is on `PATH`. `GET /api/health` reports the resolved
provider.

**`ON DELETE CASCADE` not firing.** SQLite disables foreign keys by default;
`PRAGMA foreign_keys = ON` must be set per connection, not once per database.
