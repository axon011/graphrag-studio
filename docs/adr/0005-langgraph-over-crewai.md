# ADR 0005 — LangGraph for orchestration, `graphrag_agent.llm.LLM` for calls

**Status:** accepted · 2026-08-15

## Context

The librarian crew ([AGENTS.md](../AGENTS.md)) needs an orchestrator: Cataloguer → Linker →
Critic, with a conditional, capped repair loop.

`multi-agent-pipeline` — a sibling project — implements the same shape twice, once with
LangGraph (`app/graph/pipeline.py`) and once with CrewAI (`app/crew/pipeline.py`), so both
are available as working references. It also supplies its LLM through LangChain's
`ChatClaudeCode`.

Two separate decisions: what orchestrates, and what makes the calls.

## Decision

**Orchestration: LangGraph.**
**LLM access: `graphrag_agent.llm.LLM`, not LangChain chat models.**

## Rationale — LangGraph over CrewAI

The topology is a small directed graph with one conditional edge and a loop cap. That is
precisely LangGraph's model: nodes are `state → state` functions, and `add_conditional_edges`
with a `needs_repair` predicate makes the cap explicit and testable. Each agent stays a plain
function that can be unit-tested with a stub LLM and no framework in the way.

CrewAI models a crew of role-playing agents that negotiate toward a goal. That is the wrong
abstraction here: the sequence is fixed, the handoffs are typed, and role-play prose is
something to suppress rather than lean on. The sibling project's own CrewAI adapter carries a
comment about splitting verbose role-playing output back into usable lines — friction that
exists because the framework wants autonomy the task does not want.

The reference implementation is also LangGraph-shaped, so the repair loop, the verdict model
and the tracing decorators port directly.

## Rationale — the repo's own `LLM`, not `ChatClaudeCode`

`multi-agent-pipeline` uses `ChatClaudeCode` because it is LangChain-native and that project
is LangChain throughout. This repo is not.

`graphrag-agent` already ships `llm.py` with a provider switch —
`GRAPHRAG_LLM=api|codex|claude|gemini|off` — exposing `complete()` and `complete_json()`,
including running on a Claude Code subscription with no API key. Every LLM call in extraction
and answering already goes through it.

Adding LangChain chat models beside it would mean two provider configurations, two retry
policies, two timeout behaviours and two ways to fail, so that "which provider am I using?"
would depend on which half of the app you are in. The offline mode (`GRAPHRAG_LLM=off`) that
lets the whole test suite run without a network would cover only half the code.

LangGraph does not require LangChain chat models. Nodes are ordinary functions; what they
call inside is theirs to choose.

## Consequences

- Dependencies added: `langgraph`, `langchain-core` (LangGraph's own requirement), `langfuse`.
  **Not** `langchain-openai`, `langchain-claude-code`, or `crewai`.
- Agents call `self.llm.complete_json(system, user)` and parse into Pydantic models, matching
  how `extract.py` already works.
- `GRAPHRAG_LLM=off` skips the crew entirely rather than running it against the heuristic
  extractor — fake abstracts would poison the cache. Ingest, labels, search and the UI still
  work.
- Prompts live in `backend/app/agents/prompts.py` as plain strings, not
  `ChatPromptTemplate`s, since there is no LangChain runnable in the path.
- Tracing comes from `observability.py` copied from the sibling project, which is
  framework-agnostic — it decorates functions, not chains.
- If a future agent genuinely needs LangChain tooling, the boundary to revisit is this one,
  and it should be revisited deliberately rather than by adding a second client quietly.
