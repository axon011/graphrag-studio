# GraphRAG Studio

A full-stack web app for **GraphRAG**: upload documents, watch a typed **knowledge
graph** build from them, then **chat over k-hop subgraph retrieval** — every answer
highlights the exact subgraph it used and cites the entities, relations and source
chunks behind it.

Plain vector RAG retrieves *passages*. GraphRAG retrieves *structure*, so it can answer
multi-hop questions ("how is X connected to Y?") that flat retrieval misses. This app puts
a visual, interactive face on that idea.

```
 ┌── Next.js + TypeScript frontend ──┐        ┌── FastAPI backend ──┐
 │  force-directed graph view        │  HTTP  │  /api/build  /ask   │
 │  chat panel + citations           │ ─────▶ │  /api/graph  /reset │
 │  document upload                  │        │                     │
 └───────────────────────────────────┘        └──────────┬──────────┘
                                                          │ imports
                                              ┌───────────▼───────────┐
                                              │  graphrag-agent (lib)  │
                                              │  extract → KG → k-hop  │
                                              └────────────────────────┘
```

The graph engine is the separate [`graphrag-agent`](https://github.com/axon011/graphrag-agent)
library — Studio is the application layer on top of it.

## Stack

- **Frontend:** Next.js 15 (App Router), TypeScript, React 19, `react-force-graph-2d`
- **Backend:** FastAPI, Pydantic, the `graphrag-agent` Python package
- **LLM:** provider-agnostic via `graphrag-agent` (`GRAPHRAG_LLM=api|codex|claude|gemini|off`).
  Runs end to end offline with the heuristic extractor when no provider is set.

## Run it

### 1. Backend

```bash
cd backend
pip install -r requirements.txt
pip install -e ../../graphrag-agent      # the graph engine (editable)
uvicorn app.main:app --reload --port 8000
```

Optional: seed the graph from an existing build with
`GRAPHRAG_STUDIO_GRAPH=/path/to/kg.json`.

### 2. Frontend

```bash
cd frontend
cp .env.local.example .env.local         # points at http://localhost:8000
npm install
npm run dev                              # http://localhost:3000
```

Paste text or upload a `.txt`/`.md` file, watch the graph appear, then ask questions.

## API

| Method | Path           | Body                          | Returns                          |
| ------ | -------------- | ----------------------------- | -------------------------------- |
| GET    | `/api/health`  | –                             | graph stats                      |
| GET    | `/api/graph`   | –                             | `{nodes, edges, stats}`          |
| POST   | `/api/build`   | `{text, source?, reset?}`     | updated graph                    |
| POST   | `/api/upload`  | multipart `file` (`?reset=`)  | updated graph                    |
| POST   | `/api/ask`     | `{question}`                  | `{answer, citations, triples, subgraph_node_ids}` |
| POST   | `/api/reset`   | –                             | empty graph                      |

## Tests

```bash
cd backend && pytest -q                  # offline, no API key needed
```

## License

MIT
