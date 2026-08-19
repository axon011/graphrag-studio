"""Content-addressed cache for chunk extractions.

Extraction is the expensive step: one LLM call per chunk, and the target corpus is
~4,900 chunks. Without a cache every re-ingest pays the full cost, which makes the
difference between a tool used once and a tool used daily.

Two things make this cache correct rather than merely fast:

**Chunk ids are stripped before storing.** An `Extraction` embeds the chunk id in
`Entity.mentions` and `Relation.evidence`. Chunk ids encode the source document, so
replaying a cached extraction verbatim under a different chunk id would attribute an
entity to the wrong document — silently. We store the id-free payload (names, types,
relations) and rebind ids on read.

**Offline extractions are quarantined.** With `GRAPHRAG_LLM=off` the heuristic
extractor produces much weaker output. Reusing it once a real provider is configured
would leave a corpus permanently degraded with no signal that it happened, so the
cache key includes the extractor class and the two never mix.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

from graphrag_agent.models import Chunk, Entity, Extraction, Relation

SCHEMA_VERSION = 1

_SCHEMA = """
CREATE TABLE IF NOT EXISTS chunk_cache (
    key             TEXT PRIMARY KEY,   -- sha256(text) + extractor class
    sha256          TEXT NOT NULL,      -- of the chunk TEXT
    extractor       TEXT NOT NULL,      -- 'llm' | 'offline'
    model           TEXT NOT NULL,      -- provider that produced it, for forensics
    extraction_json TEXT NOT NULL,      -- chunk-id-free payload
    created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunk_cache_extractor ON chunk_cache(extractor);
"""


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def text_sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def extractor_class(provider: str | None) -> str:
    """'llm' or 'offline'. The cache never mixes the two."""
    return "offline" if provider in (None, "", "off") else "llm"


def _key(sha: str, extractor: str) -> str:
    return f"{extractor}:{sha}"


def dumps(ext: Extraction) -> str:
    """Serialise an Extraction WITHOUT chunk ids.

    `mentions` and `evidence` are dropped: they name the chunk this extraction came
    from, and the whole point of the cache is to reuse it for a different chunk that
    happens to have identical text.
    """
    return json.dumps(
        {
            "entities": [{"name": e.name, "type": e.type} for e in ext.entities],
            "relations": [
                {
                    "source": r.source,
                    "target": r.target,
                    "type": r.type,
                    "description": r.description,
                }
                for r in ext.relations
            ],
        },
        separators=(",", ":"),
    )


def loads(payload: str, chunk_id: str) -> Extraction:
    """Rehydrate, binding every mention and evidence ref to `chunk_id`."""
    data = json.loads(payload)
    return Extraction(
        entities=[
            Entity(name=e["name"], type=e.get("type", "concept"), mentions=[chunk_id])
            for e in data.get("entities", [])
        ],
        relations=[
            Relation(
                source=r["source"],
                target=r["target"],
                type=r.get("type", "related_to"),
                description=r.get("description", ""),
                evidence=chunk_id,
            )
            for r in data.get("relations", [])
        ],
    )


class ExtractionCache:
    """SQLite-backed store keyed on chunk text.

    Usable as a context manager. Safe to share across threads: each call opens its
    own connection, because sqlite3 connections are not thread-safe by default and
    extraction runs on a worker pool.
    """

    def __init__(self, path: str | Path, extractor: str = "llm") -> None:
        self.path = str(path)
        self.extractor = extractor
        self.hits = 0
        self.misses = 0
        self._init_schema()

    # ---- connection ----
    def _connect(self) -> sqlite3.Connection:
        con = sqlite3.connect(self.path, timeout=30.0)
        con.execute("PRAGMA journal_mode = WAL")
        con.execute("PRAGMA synchronous = NORMAL")
        con.execute("PRAGMA foreign_keys = ON")
        return con

    def _init_schema(self) -> None:
        parent = Path(self.path).parent
        if str(parent) not in ("", "."):
            parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as con:
            con.executescript(_SCHEMA)
            (current,) = con.execute("PRAGMA user_version").fetchone()
            if current < SCHEMA_VERSION:
                con.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")

    # ---- single ----
    def get(self, chunk: Chunk) -> Extraction | None:
        key = _key(text_sha256(chunk.text), self.extractor)
        with self._connect() as con:
            row = con.execute(
                "SELECT extraction_json FROM chunk_cache WHERE key = ?", (key,)
            ).fetchone()
        if row is None:
            self.misses += 1
            return None
        self.hits += 1
        return loads(row[0], chunk.id)

    def put(self, chunk: Chunk, ext: Extraction, model: str = "") -> None:
        sha = text_sha256(chunk.text)
        with self._connect() as con:
            con.execute(
                "INSERT OR REPLACE INTO chunk_cache "
                "(key, sha256, extractor, model, extraction_json, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (
                    _key(sha, self.extractor),
                    sha,
                    self.extractor,
                    model,
                    dumps(ext),
                    _utcnow(),
                ),
            )

    # ---- bulk ----
    def get_many(self, chunks: Iterable[Chunk]) -> dict[str, Extraction]:
        """Cached extractions by chunk id. One query for the whole batch.

        Per-chunk `get()` inside an ingest loop is thousands of round trips; this
        keeps the fast path fast, which is the entire point of the cache.
        """
        chunks = list(chunks)
        if not chunks:
            return {}

        by_key: dict[str, list[Chunk]] = {}
        for ch in chunks:
            by_key.setdefault(_key(text_sha256(ch.text), self.extractor), []).append(ch)

        found: dict[str, Extraction] = {}
        keys = list(by_key)
        with self._connect() as con:
            # Chunked IN clause — SQLite caps host parameters (default 999).
            for i in range(0, len(keys), 900):
                window = keys[i : i + 900]
                placeholders = ",".join("?" * len(window))
                rows = con.execute(
                    f"SELECT key, extraction_json FROM chunk_cache WHERE key IN ({placeholders})",
                    window,
                ).fetchall()
                for key, payload in rows:
                    for ch in by_key[key]:
                        found[ch.id] = loads(payload, ch.id)

        self.hits += len(found)
        self.misses += len(chunks) - len(found)
        return found

    def put_many(self, items: Iterable[tuple[Chunk, Extraction]], model: str = "") -> None:
        rows = []
        for chunk, ext in items:
            sha = text_sha256(chunk.text)
            rows.append(
                (_key(sha, self.extractor), sha, self.extractor, model, dumps(ext), _utcnow())
            )
        if not rows:
            return
        with self._connect() as con:
            con.executemany(
                "INSERT OR REPLACE INTO chunk_cache "
                "(key, sha256, extractor, model, extraction_json, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                rows,
            )

    # ---- introspection ----
    def count(self) -> int:
        with self._connect() as con:
            (n,) = con.execute(
                "SELECT COUNT(*) FROM chunk_cache WHERE extractor = ?", (self.extractor,)
            ).fetchone()
        return n

    def stats(self) -> dict[str, int]:
        return {"hits": self.hits, "misses": self.misses, "stored": self.count()}

    def __enter__(self) -> "ExtractionCache":
        return self

    def __exit__(self, *exc) -> None:
        return None
