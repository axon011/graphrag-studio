# ADR 0004 — Propose, never move

**Status:** accepted · 2026-08-15

## Context

The corpus is a live Master's thesis: ~1,500 files, actively edited, with the submission
ahead. A stated goal is restructuring it — collapsing
`archive/root_clutter/archive_outdated_docs/` and friends into something navigable.

The tempting version writes the new tree directly. The system knows which documents cluster
together and which look superseded, so it could just do it.

Two failure modes make that unacceptable, and they compound:

- **The classifier is probabilistic.** A `supersedes` link is an LLM judgement. It will
  sometimes be backwards — marking the current draft superseded by an archived one.
- **The action is not.** Moving 1,500 files is immediate and, without a manifest, effectively
  irreversible. Git helps only where the corpus is committed, and much of it is not.

A wrong label is a bad suggestion. A wrong label plus an automatic move is a lost thesis.

## Decision

Nothing in this system relocates, renames or deletes a file as a side effect of any other
operation.

Restructuring produces a **reviewable diff**. Applying it is a separate, explicit action that
writes a reversible manifest before touching the filesystem.

## Rationale

The value is in the analysis, not the file operations. Knowing *which* files are dead drafts
is the hard part; moving them afterwards is trivial and is exactly the step a human should
authorise. Automating the easy half while the hard half is probabilistic gets the trade
backwards.

Review is also cheap here. The proposal is a table of `current path → proposed path` with a
reason per row, read once. That is minutes of attention against an unrecoverable downside.

Keeping the boundary absolute — rather than "auto-apply high-confidence moves" — is what
makes it dependable. A confidence threshold invites tuning, and a threshold that has been
tuned once will be tuned again under time pressure.

## Consequences

- No HTTP route and no MCP tool performs a filesystem mutation, except the single explicit
  apply endpoint. Ingest and enrich are read-only against the corpus.
- The restructure proposal is data: `{ current_path, proposed_path, confidence, reason }`,
  rendered as a review screen, persisted so it can be revisited.
- Applying writes a manifest first — every planned move, plus a timestamp — then executes.
  An `undo` reads the manifest and reverses it. The manifest is written and flushed before
  the first move, not after the last.
- Links the Critic will not confirm are **dropped, not downgraded**
  ([AGENTS.md](../AGENTS.md)). An unconfirmed `supersedes` never reaches the database, so it
  can never reach a proposal.
- Development runs against a **copy** of the corpus. The live tree is read-only until the
  undo path has been exercised on the copy.
- `status: "superseded"` in the UI is advisory. It changes how a row is rendered; it never
  changes where a file lives.

## Alternatives rejected

**Auto-apply above a confidence threshold.** Concentrates the risk in whichever documents the
model is most confidently wrong about, which is the worst place for it.

**Move to a quarantine folder instead of deleting.** Still a move: it breaks LaTeX `\input`
paths, image references and build scripts. The corpus is 308 `.tex` files; relocation is not
a safe default even when reversible.

**Git-only safety.** Would require the whole corpus committed and clean before every apply.
Much of it is not tracked, and enforcing that as a precondition is a worse experience than
writing a manifest.
