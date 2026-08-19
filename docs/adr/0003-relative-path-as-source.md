# ADR 0003 — `source` is the repo-relative path

**Status:** accepted · 2026-08-15
**Scope:** changes `graphrag-agent`, not only Studio

## Context

`graphrag-agent` labels every chunk with a `source`, and builds chunk ids from it:

```python
# chunk.py
def chunk_text(text: str, source: str, size: int = 900, overlap: int = 150) -> list[Chunk]:
    return [Chunk(id=f"{source}#{i}", text=w, source=source) for i, w in enumerate(...)]

def load_chunks(path, size=900, overlap=150) -> list[Chunk]:
    p = Path(path)
    return chunk_text(p.read_text(encoding="utf-8"), source=p.name, ...)   # ← basename
```

`source=p.name` is the **basename only**. For a handful of uploaded files that is harmless,
which is why it survived v0.

The document layer makes it harmful. Documents are identified by `source`, and labels are
derived by mapping `entity.mentions` → chunk id → source (see
[DATA_MODEL.md](../DATA_MODEL.md)). The target corpus contains many files named `README.md`:

```
Adaptive_prune/archive/old_docs/README.md
Adaptive_prune/archive/root_clutter/papers/README.md
Adaptive_prune/comparison_checkpoints/avit/README.md
Adaptive_prune/comparison_checkpoints/DynamicViT/README.md
```

Under basename identity all of them are one document called `README.md`, whose labels are the
union of four unrelated files. There is no error — just quietly wrong data, and every feature
built on top inherits it.

## Decision

`source` becomes the **repo-relative path with forward slashes**, e.g.
`Adaptive_prune/comparison_checkpoints/avit/README.md`.

Fixed in `graphrag-agent`, not worked around in Studio.

## Rationale

This is a correctness bug in the library. Any consumer that treats `source` as a document
identifier — which is the only reasonable reading of a field called `source` — is silently
wrong on any corpus with repeated filenames, and repeated filenames are the norm
(`README.md`, `index.md`, `main.tex`, `notes.md`).

Patching around it in Studio would mean not using `load_chunks`, duplicating the chunking
logic, and leaving the same trap for the next consumer.

Relative rather than absolute keeps the database portable: the same `librarian.db` works
whether the corpus sits at `C:\Users\...\AI` or `/home/aravind/AI`, with the root supplied by
`CORPUS_ROOT` at runtime. Absolute paths would also leak the author's directory layout into
any published graph.

## Consequences

- `load_chunks` gains an optional `root` parameter; `source` is `path.relative_to(root)` when
  given, and `path.name` otherwise so existing callers are unaffected.
- Chunk ids become `Adaptive_prune/docs/README.md#3`. `rsplit("#", 1)` still recovers the
  source because `#` does not appear in these paths.
- **Paths containing `#` are rejected at ingest** with a per-file error rather than being
  mis-parsed. Guessing at an ambiguous id would reintroduce silent wrongness.
- Windows paths are normalised to forward slashes at the boundary, so the database and any
  exported `kg.json` are platform-independent.
- Any `kg.json` built before this change has basename sources and cannot be trusted for
  document identity. Rebuild rather than migrate — the extraction cache makes it cheap, and
  the old graph cannot be disambiguated after the fact.
- Verification is explicit in the M1 checks: ingest a subtree containing at least two
  `README.md` files and assert two distinct documents.
