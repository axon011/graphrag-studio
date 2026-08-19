# The librarian crew

The knowledge graph gives every document a set of topical labels for free (see
[DATA_MODEL.md](DATA_MODEL.md)). What it cannot give is judgement:

- Is `enhanced_training_report.md` the current report or a superseded draft?
- Are these two 60 KB meeting transcripts near-duplicates, or one a refinement of the other?
- What is this file actually *about*, in a sentence a human would write?

Entity counts cannot answer those. That is what the crew is for.

## Why multi-agent rather than one prompt

A single "summarise and classify this document" call would produce abstracts. It would also
produce confident `superseded` verdicts with nothing behind them, and there would be no
place to catch that.

The work splits into three genuinely different jobs with different inputs:

| Job | Input | Failure mode it risks |
|---|---|---|
| Describe one document | one document's text | bland or invented summary |
| Relate two documents | a *pair*, plus the corpus | hallucinated relationships |
| Decide whether to believe the above | a claim + its evidence | rubber-stamping |

Splitting them means the Linker never sees a whole corpus it would have to invent structure
for, and the Critic reviews claims it did not author. That last property is the point: a
model checking its own output in the same call has no independent view to check against.

## Topology

LangGraph `StateGraph`, mirroring `multi-agent-pipeline/app/graph/pipeline.py`:

```
        ┌─────────────┐
        │ Cataloguer  │  per document: title, abstract, doc_type, status
        └──────┬──────┘
               ▼
        ┌─────────────┐
        │   Linker    │  per shortlisted pair: typed link + rationale
        └──────┬──────┘
               ▼
        ┌─────────────┐
        │   Critic    │  per claim: supported | partial | unsupported | no_citation
        └──────┬──────┘
      needs_repair(state)
         ┌─────┴─────┐
    repair│           │end
         ▼           ▼
  ┌─────────────┐   END
  │   Repair    │  one bounded pass over flagged claims only
  └──────┬──────┘
         ▼
        END
```

`needs_repair` enforces the iteration cap, exactly as in the reference implementation, so the
graph cannot loop.

## State

```python
class LibrarianState(TypedDict, total=False):
    doc_ids: list[int]              # documents in this run
    documents: list[dict]           # id, path, text, labels
    candidates: list[tuple[int, int]]   # shortlisted pairs, from SQL
    catalogue: list[dict]           # Cataloguer output, one per document
    links: list[dict]               # Linker output, typed + rationale
    critique: dict                  # CritiqueReport, model_dump()
    critique_iterations: int
    enable_critic: bool             # default True
```

Same shape as `PipelineState` — a flat `TypedDict` with `total=False`, nodes mutating and
returning it. Nothing clever; it keeps nodes independently testable.

## Agents

### Cataloguer

**In:** one document's text (truncated to a head+tail window for very large files) plus its
top graph labels.
**Out:** `title`, `abstract` (one paragraph), `doc_type`, `status`.

```
doc_type : paper | notes | meeting | report | config | unknown
status   : current | draft | superseded | unknown
```

The labels are passed in as context, not asked for — the graph already produced them, and
asking the model to re-derive concepts it cannot see the corpus for invites invention.

`unknown` is a first-class answer for both enums. A Cataloguer that must always pick a status
will guess, and a wrong `superseded` badge is worse than an absent one.

### Linker

**In:** a candidate pair `(A, B)` and both abstracts, plus the entities they share.
**Out:** zero or one link — `supersedes`, `derived_from`, `duplicates`, `cites` — with
`confidence` and a `rationale` quoting what in the documents supports it.

Returning *no link* is the expected outcome for most pairs, and the prompt says so. Pairs
arrive because they share vocabulary; sharing vocabulary is not a relationship.

Direction matters and is easy to invert. `supersedes` means "A replaces B", and the prompt
states it with the mtimes of both documents in context, since a newer file superseding an
older one is the common case and the reverse needs strong justification.

### Critic

**In:** every Cataloguer and Linker claim with the evidence behind it.
**Out:** a `CritiqueReport` — per-claim verdicts plus an aggregate score.

Reuse the verdict enum from `multi-agent-pipeline/app/models/schemas.py` unchanged:

```python
verdict: Literal["supported", "partial", "unsupported", "no_citation"]
```

It maps cleanly: an abstract asserting something absent from the document is `unsupported`;
a `supersedes` link whose rationale quotes nothing is `no_citation`.

The Critic is prompted to **refute**, not to score. Asked "is this good?", a model agrees.
Asked "find what this claim is not supported by", it does the work. Default to `unsupported`
when uncertain.

### Repair

One bounded pass over flagged claims only, mirroring `repair_report`: rewrite the claim so
it is backed by the evidence, or remove it. It never invents new evidence and never touches
unflagged output.

After repair, anything still `unsupported` is **dropped, not downgraded**. A `supersedes`
link the Critic will not confirm does not become a low-confidence link — it never reaches the
database, the UI, or the restructure proposal. This is what makes "propose, never move"
mean something: the proposal is built only from links that survived review. See
[ADR 0004](adr/0004-propose-never-move.md).

## Cost model

This is the constraint the design is built around.

The corpus is 3.7 MB → ~4,900 chunks → 440 documents. Those numbers are an order of
magnitude apart, and the crew must operate on the smaller one.

| Stage | Unit | Calls | Note |
|---|---|---|---|
| Extraction (M1, not the crew) | chunk | ~4,900 first run, ~0 after | content-hash cached |
| Cataloguer | document | 440 | once per document, cached by `enriched_at` |
| Linker | shortlisted pair | ~440 × k, k ≈ 5–10 | **not** 440 × 439 |
| Critic | batch of claims | ~1 per document batch | claims batched, not one call each |
| Repair | flagged claims only | typically « Critic | usually near zero |

The Linker shortlist comes from the SQL entity-overlap query in
[DATA_MODEL.md](DATA_MODEL.md), not from the model. Pairwise LLM adjudication over 440
documents would be ~96,000 calls; shortlisting makes it a few thousand. Everything else about
the crew is negotiable; this is not.

Enrichment is resumable and incremental. `enriched_at` marks completed documents, so
`POST /api/enrich` after adding one file processes one document.

## LLM access

The crew uses `graphrag_agent.llm.LLM` — the provider abstraction this repo already ships —
via `complete()` and `complete_json()`.

It is **not** LangChain's `ChatClaudeCode`, despite the reference implementation using it.
`LLM` already resolves `GRAPHRAG_LLM=api|codex|claude|gemini|off`, already supports running
on a Claude subscription with no API key, and already backs every other LLM call in the
repo. A second stack would mean two config surfaces, two retry policies and two ways to fail.
LangGraph orchestrates; `LLM` calls. See [ADR 0005](adr/0005-langgraph-over-crewai.md).

With `GRAPHRAG_LLM=off` the crew is skipped entirely rather than run against the heuristic
extractor. Ingest, labels, search and the UI all still work; documents simply stay
un-enriched. Producing fake abstracts offline would poison the cache.

## Observability

`backend/app/observability.py` is copied nearly verbatim from
`multi-agent-pipeline/app/observability.py`.

```python
@observe(name="cataloguer", as_type="agent", capture_input=False, capture_output=False)
def run_cataloguer(state: LibrarianState) -> LibrarianState: ...
```

With `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` unset every helper is a no-op, so agent
code carries no conditional tracing and the test suite needs no Langfuse. With keys set, each
enrichment run is one trace with a span per agent, which is how you answer "why did this
document get marked superseded?" after the fact.

`capture_input=False` matters here: documents are the input, and full thesis text does not
belong in a hosted trace payload. Log identifiers and verdicts, not corpus content.

## Testing

- **Per node, no LLM.** Each agent is a pure `state → state` function; a stub `LLM` returning
  canned JSON covers the topology.
- **Critic must reject.** A fixture pairing a fabricated `supersedes` claim with a document
  that does not support it, asserting the verdict is `unsupported` and that the link is
  absent from the database afterwards. If this test passes trivially the Critic is
  rubber-stamping.
- **Repair cap.** Assert `needs_repair` returns `end` once the cap is reached, so a
  persistently-failing claim terminates.
- **Offline.** With `GRAPHRAG_LLM=off`, `/api/enrich` returns a skipped-count and writes
  nothing.
