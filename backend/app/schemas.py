"""Request/response models for the Studio API."""
from __future__ import annotations

from pydantic import BaseModel, Field


class BuildRequest(BaseModel):
    text: str = Field(..., description="Raw document text to ingest")
    source: str = Field("inline", description="A label for where the text came from")
    reset: bool = Field(False, description="Clear the existing graph before ingesting")


class AskRequest(BaseModel):
    question: str


class GraphNode(BaseModel):
    id: str
    label: str
    type: str = "concept"
    mentions: int = 0


class GraphEdge(BaseModel):
    source: str
    target: str
    label: str = "related_to"
    description: str = ""


class GraphStats(BaseModel):
    nodes: int
    edges: int
    documents: int
    provider: str


class GraphResponse(BaseModel):
    nodes: list[GraphNode] = Field(default_factory=list)
    edges: list[GraphEdge] = Field(default_factory=list)
    stats: GraphStats


class Citation(BaseModel):
    kind: str
    ref: str


class AskResponse(BaseModel):
    answer: str
    citations: list[Citation] = Field(default_factory=list)
    triples: list[str] = Field(default_factory=list)
    # ids of the nodes in the retrieved subgraph, for highlighting in the UI
    subgraph_node_ids: list[str] = Field(default_factory=list)
