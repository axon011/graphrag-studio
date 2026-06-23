"""In-memory graph session wrapping a single GraphRAGAgent.

v0 holds one graph for the whole server (single-user studio). It is guarded by a
lock so concurrent build/ask requests don't corrupt the networkx graph. If
GRAPHRAG_STUDIO_GRAPH points at an existing kg.json, it is loaded at startup.
"""
from __future__ import annotations

import os
import threading

from graphrag_agent import GraphRAGAgent
from graphrag_agent.graph import KnowledgeGraph

from .schemas import GraphEdge, GraphNode, GraphStats


class GraphStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._docs = 0
        self.agent = GraphRAGAgent()
        seed = os.getenv("GRAPHRAG_STUDIO_GRAPH")
        if seed and os.path.exists(seed):
            self.agent = GraphRAGAgent.from_graph(seed)
            self._docs = 1

    # ---- mutation ----
    def reset(self) -> None:
        with self._lock:
            self.agent = GraphRAGAgent(config=self.agent.cfg)
            self._docs = 0

    def ingest(self, text: str, source: str, reset: bool = False) -> None:
        with self._lock:
            if reset:
                self.agent = GraphRAGAgent(config=self.agent.cfg)
                self._docs = 0
            self.agent.build_texts([text], source=source)
            self._docs += 1

    # ---- query ----
    def ask(self, question: str):
        with self._lock:
            answer = self.agent.query(question)
            seeds = self.agent.kg.find(question)
            subgraph_ids = sorted(self.agent.kg.k_hop(seeds, self.agent.cfg.hops))
        return answer, subgraph_ids

    # ---- serialization ----
    @property
    def provider(self) -> str:
        return "llm" if self.agent.llm.available else "offline-heuristic"

    def stats(self) -> GraphStats:
        kg: KnowledgeGraph = self.agent.kg
        return GraphStats(
            nodes=kg.num_nodes(),
            edges=kg.num_edges(),
            documents=self._docs,
            provider=self.provider,
        )

    def graph(self) -> tuple[list[GraphNode], list[GraphEdge]]:
        kg = self.agent.kg
        nodes = [
            GraphNode(
                id=nid,
                label=data.get("name", nid),
                type=data.get("type", "concept"),
                mentions=len(data.get("mentions", [])),
            )
            for nid, data in kg.g.nodes(data=True)
        ]
        edges = [
            GraphEdge(
                source=s,
                target=t,
                label=data.get("type", "related_to"),
                description=data.get("description", "") or "",
            )
            for s, t, data in kg.g.edges(data=True)
        ]
        return nodes, edges


store = GraphStore()
