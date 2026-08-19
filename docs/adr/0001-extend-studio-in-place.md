# ADR 0001 — Extend GraphRAG Studio in place

**Status:** accepted · 2026-08-15

## Context

Studio v0 is a GraphRAG demo: upload documents, watch a knowledge graph build, chat over
k-hop retrieval. It works, it has screenshots, and it has already been run against the target
thesis corpus (52 entities, 49 relations).

The new goal is a document librarian for that corpus — a durable document layer, auto-labels,
concept search, an agent crew, an MCP server. That is a different product with a large
overlap in machinery.

Two options:

1. **Extend Studio in place**, adding the document layer beneath the existing concept layer.
2. **New repo** (`thesis-librarian`) importing `graphrag-agent` directly and borrowing
   Studio's frontend code.

## Decision

Extend Studio in place.

## Rationale

The overlap is most of the app. Studio already has the upload path, the FastAPI scaffold, the
typed frontend client, and the force-directed graph view with subgraph highlighting — and the
whole thing is 571 lines. A new repo would begin by copying nearly all of it, and would then
carry two copies of the same Next.js and FastAPI scaffolding through every future change.

The narrative also improves rather than degrades. A repository whose history shows a GraphRAG
demo growing into a tool its author uses daily is a stronger artefact than two smaller repos,
one of which is a demo that stopped. The existing thesis screenshots stay valid because the
graph view does not change.

The counter-argument — that mixing a clean GraphRAG demo with document management muddies the
story — is real but weaker. It is answered by structure rather than by separation: the graph
view remains its own route, and `graphrag-agent` remains a standalone library that is useful
without Studio. The demo is still there; it is now the second thing the app does.

## Consequences

- `README.md` is repositioned from "GraphRAG demo" to "document librarian", keeping the
  existing demo section.
- The dependency direction is fixed: frontend → API → (crew, store) → `graphrag-agent`. The
  library never learns about Studio.
- Work happens on `feat/thesis-librarian` and merges once the document layer is usable, so
  `main` keeps working throughout.
- Fixes needed by the librarian that belong in the library — notably the relative-path
  change in [ADR 0003](0003-relative-path-as-source.md) — are made in `graphrag-agent`, not
  worked around in Studio.
