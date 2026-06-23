"""GraphRAG Studio API.

Endpoints
  GET  /api/health              liveness + graph stats
  GET  /api/graph               full graph (nodes + edges) for visualization
  POST /api/build               ingest raw text into the graph
  POST /api/upload              ingest an uploaded text file
  POST /api/ask                 query the graph -> grounded answer + subgraph
  POST /api/reset               clear the graph
"""
from __future__ import annotations

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from .schemas import (
    AskRequest,
    AskResponse,
    BuildRequest,
    Citation,
    GraphResponse,
    GraphStats,
)
from .store import store

app = FastAPI(title="GraphRAG Studio", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # studio is single-user / local; tighten for a real deploy
    allow_methods=["*"],
    allow_headers=["*"],
)


def _graph_response() -> GraphResponse:
    nodes, edges = store.graph()
    return GraphResponse(nodes=nodes, edges=edges, stats=store.stats())


@app.get("/api/health", response_model=GraphStats)
def health() -> GraphStats:
    return store.stats()


@app.get("/api/graph", response_model=GraphResponse)
def get_graph() -> GraphResponse:
    return _graph_response()


@app.post("/api/build", response_model=GraphResponse)
def build(req: BuildRequest) -> GraphResponse:
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="text is empty")
    store.ingest(req.text, source=req.source, reset=req.reset)
    return _graph_response()


@app.post("/api/upload", response_model=GraphResponse)
async def upload(file: UploadFile = File(...), reset: bool = False) -> GraphResponse:
    raw = await file.read()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("latin-1", errors="replace")
    if not text.strip():
        raise HTTPException(status_code=400, detail="uploaded file is empty")
    store.ingest(text, source=file.filename or "upload", reset=reset)
    return _graph_response()


@app.post("/api/ask", response_model=AskResponse)
def ask(req: AskRequest) -> AskResponse:
    if not req.question.strip():
        raise HTTPException(status_code=400, detail="question is empty")
    answer, subgraph_ids = store.ask(req.question)
    return AskResponse(
        answer=answer.text,
        citations=[Citation(kind=c.kind, ref=c.ref) for c in answer.citations],
        triples=answer.subgraph_triples,
        subgraph_node_ids=subgraph_ids,
    )


@app.post("/api/reset", response_model=GraphResponse)
def reset() -> GraphResponse:
    store.reset()
    return _graph_response()
