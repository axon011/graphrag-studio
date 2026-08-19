"""Extraction cache — correctness first, speed second."""
from graphrag_agent.models import Chunk, Entity, Extraction, Relation

from app.cache import ExtractionCache, dumps, extractor_class, loads, text_sha256


def _chunk(cid: str, text: str = "Perinet uses MQTT and Docker.") -> Chunk:
    return Chunk(id=cid, text=text, source=cid.rsplit("#", 1)[0])


def _extraction(chunk_id: str) -> Extraction:
    return Extraction(
        entities=[
            Entity(name="Perinet", type="org", mentions=[chunk_id]),
            Entity(name="MQTT", type="protocol", mentions=[chunk_id]),
        ],
        relations=[
            Relation(source="Perinet", target="MQTT", type="uses",
                     description="platform speaks MQTT", evidence=chunk_id),
        ],
    )


# ---- serialisation ----

def test_dumps_strips_chunk_ids():
    """Stored payloads must not carry the id of the chunk they came from."""
    payload = dumps(_extraction("alpha/notes.md#0"))
    assert "alpha/notes.md#0" not in payload
    assert "mentions" not in payload
    assert "evidence" not in payload


def test_loads_rebinds_to_the_requested_chunk():
    payload = dumps(_extraction("alpha/notes.md#0"))
    ext = loads(payload, "beta/other.md#7")

    assert [e.name for e in ext.entities] == ["Perinet", "MQTT"]
    assert all(e.mentions == ["beta/other.md#7"] for e in ext.entities)
    assert all(r.evidence == "beta/other.md#7" for r in ext.relations)


def test_roundtrip_preserves_types_and_descriptions():
    ext = loads(dumps(_extraction("a#0")), "a#0")
    assert {e.name: e.type for e in ext.entities} == {"Perinet": "org", "MQTT": "protocol"}
    assert ext.relations[0].type == "uses"
    assert ext.relations[0].description == "platform speaks MQTT"


# ---- the property that makes the cache safe ----

def test_identical_text_different_documents_does_not_cross_attribute(tmp_path):
    """The bug this design avoids: reusing an extraction must not move a mention
    to the document it was cached from."""
    cache = ExtractionCache(tmp_path / "c.db")
    a = _chunk("alpha/README.md#0")
    b = _chunk("beta/README.md#0")           # identical text, different document

    cache.put(a, _extraction(a.id))
    hit = cache.get(b)

    assert hit is not None                    # same text -> cache hit
    assert all(e.mentions == [b.id] for e in hit.entities)
    assert all(r.evidence == [b.id][0] for r in hit.relations)
    assert not any("alpha" in m for e in hit.entities for m in e.mentions)


# ---- basic behaviour ----

def test_miss_then_hit(tmp_path):
    cache = ExtractionCache(tmp_path / "c.db")
    ch = _chunk("a#0")

    assert cache.get(ch) is None
    cache.put(ch, _extraction(ch.id))
    assert cache.get(ch) is not None
    assert cache.stats() == {"hits": 1, "misses": 1, "stored": 1}


def test_different_text_is_a_miss(tmp_path):
    cache = ExtractionCache(tmp_path / "c.db")
    cache.put(_chunk("a#0", "one text"), _extraction("a#0"))
    assert cache.get(_chunk("a#0", "different text")) is None


def test_persists_across_instances(tmp_path):
    path = tmp_path / "c.db"
    ch = _chunk("a#0")
    ExtractionCache(path).put(ch, _extraction(ch.id))
    assert ExtractionCache(path).get(ch) is not None


def test_put_is_idempotent(tmp_path):
    cache = ExtractionCache(tmp_path / "c.db")
    ch = _chunk("a#0")
    cache.put(ch, _extraction(ch.id))
    cache.put(ch, _extraction(ch.id))
    assert cache.count() == 1


# ---- offline quarantine ----

def test_offline_and_llm_caches_do_not_mix(tmp_path):
    path = tmp_path / "c.db"
    ch = _chunk("a#0")

    ExtractionCache(path, extractor="offline").put(ch, _extraction(ch.id))

    assert ExtractionCache(path, extractor="llm").get(ch) is None
    assert ExtractionCache(path, extractor="offline").get(ch) is not None


def test_extractor_class_mapping():
    assert extractor_class(None) == "offline"
    assert extractor_class("off") == "offline"
    assert extractor_class("") == "offline"
    assert extractor_class("claude") == "llm"
    assert extractor_class("api") == "llm"


# ---- bulk ----

def test_get_many_returns_only_cached(tmp_path):
    cache = ExtractionCache(tmp_path / "c.db")
    cached = _chunk("a#0", "text one")
    missing = _chunk("b#0", "text two")
    cache.put(cached, _extraction(cached.id))

    found = cache.get_many([cached, missing])

    assert set(found) == {cached.id}
    assert found[cached.id].entities[0].mentions == [cached.id]


def test_get_many_rebinds_per_chunk(tmp_path):
    """One cached payload serving several chunks must bind each to its own id."""
    cache = ExtractionCache(tmp_path / "c.db")
    a = _chunk("alpha/README.md#0")
    b = _chunk("beta/README.md#0")           # identical text
    cache.put(a, _extraction(a.id))

    found = cache.get_many([a, b])

    assert set(found) == {a.id, b.id}
    assert found[a.id].entities[0].mentions == [a.id]
    assert found[b.id].entities[0].mentions == [b.id]


def test_put_many_then_get_many(tmp_path):
    cache = ExtractionCache(tmp_path / "c.db")
    chunks = [_chunk(f"doc.md#{i}", f"text {i}") for i in range(5)]
    cache.put_many([(c, _extraction(c.id)) for c in chunks])

    found = cache.get_many(chunks)

    assert set(found) == {c.id for c in chunks}
    assert cache.count() == 5


def test_get_many_handles_empty(tmp_path):
    assert ExtractionCache(tmp_path / "c.db").get_many([]) == {}


def test_get_many_beyond_sqlite_parameter_limit(tmp_path):
    """SQLite caps host parameters; the IN clause is chunked."""
    cache = ExtractionCache(tmp_path / "c.db")
    chunks = [_chunk(f"doc.md#{i}", f"unique text {i}") for i in range(1200)]
    cache.put_many([(c, _extraction(c.id)) for c in chunks])

    found = cache.get_many(chunks)

    assert len(found) == 1200


def test_text_sha256_is_stable():
    assert text_sha256("abc") == text_sha256("abc")
    assert text_sha256("abc") != text_sha256("abd")
