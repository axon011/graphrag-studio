# ADR 0002 — SQLite for the document layer

**Status:** accepted · 2026-08-15

## Context

Documents need to become durable. Today a document is `self._docs = 0` in `store.py` — an
integer, wiped on restart and on `/api/reset`.

The new state is four tables (see [DATA_MODEL.md](../DATA_MODEL.md)): documents, the
entity↔document index, crew-produced links, and an extraction cache. The corpus is ~440
documents, ~4,900 chunks, one user, one machine.

Options: SQLite, Postgres (via Docker Compose, already present in the repo for other
services), or files on disk (JSON/Parquet).

## Decision

SQLite, one file at `LIBRARIAN_DB` (default `./librarian.db`).

## Rationale

The workload is tiny and single-writer. 440 rows in `documents` and maybe 30,000 in
`doc_entities` is not a database problem; it is a file with indexes. SQLite handles it with
no server, no container, no connection string, and no startup ordering between the API and a
database.

It also keeps the project runnable by anyone who clones it. `pip install -r requirements.txt`
and `uvicorn` is the whole setup — no `docker compose up` before the app will start. For a
tool whose main user is one person on a laptop, and whose secondary purpose is being read by
someone evaluating the author's work, that matters more than headroom nobody will use.

The `doc_entities` join in [DATA_MODEL.md](../DATA_MODEL.md) — the one query the design leans
on — is a `GROUP BY` over an indexed table. SQLite executes it in milliseconds at this scale.

Postgres would buy concurrent writers, real types, and `pgvector`. None are needed:
`/api/ingest` and `/api/enrich` are single-flight by design, and there are no embeddings.
Files on disk would avoid a dependency but require hand-written indexing and a way to write
atomically — which is a worse SQLite.

## Consequences

- `documents.path` carries a `UNIQUE` constraint; identity is the relative path
  ([ADR 0003](0003-relative-path-as-source.md)).
- Migrations are plain SQL in `backend/app/db.py` guarded by `PRAGMA user_version`. No Alembic.
- Timestamps are ISO-8601 UTC strings; SQLite has no datetime type and strings sort correctly.
- `PRAGMA foreign_keys = ON` per connection — SQLite defaults it off, so `ON DELETE CASCADE`
  on `doc_entities` and `doc_links` is silently inert without it.
- WAL mode, so a long ingest does not block reads from the UI.
- If this ever needs Postgres, the port is a `db.py` rewrite behind the same store functions.
  Nothing above `store.py` knows which database is underneath.

### Not chosen: pgvector

Worth naming because it appears in 26 of the 60 most recent job postings surveyed and is a
real temptation. It is the wrong reason to add a dependency here: retrieval in this system is
graph traversal, not vector similarity, and adding an embedding index to justify a line on a
CV would be building the wrong tool. If semantic search over chunk text is genuinely wanted
later, SQLite FTS5 is the cheaper first step.
