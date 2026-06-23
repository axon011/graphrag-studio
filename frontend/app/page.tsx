"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import GraphView from "@/components/GraphView";
import {
  ask,
  buildText,
  getGraph,
  resetGraph,
  uploadFile,
  type AskResponse,
  type GraphResponse,
} from "@/lib/api";

interface ChatMsg {
  who: "user" | "agent";
  text: string;
  res?: AskResponse;
}

export default function Home() {
  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [highlight, setHighlight] = useState<Set<string>>(new Set());
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [question, setQuestion] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const msgEnd = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      setGraph(await getGraph());
    } catch (e: any) {
      setError(`Backend unreachable: ${e.message}. Is the API running on :8000?`);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    msgEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function withBusy<T>(fn: () => Promise<T>) {
    setBusy(true);
    setError("");
    try {
      return await fn();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const onBuild = () =>
    withBusy(async () => {
      if (!pasteText.trim()) return;
      setGraph(await buildText(pasteText, "pasted", false));
      setPasteText("");
    });

  const onUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    withBusy(async () => setGraph(await uploadFile(f, false)));
    if (fileRef.current) fileRef.current.value = "";
  };

  const onReset = () =>
    withBusy(async () => {
      setGraph(await resetGraph());
      setMessages([]);
      setHighlight(new Set());
    });

  const onAsk = () =>
    withBusy(async () => {
      const q = question.trim();
      if (!q) return;
      setMessages((m) => [...m, { who: "user", text: q }]);
      setQuestion("");
      const res = await ask(q);
      setMessages((m) => [...m, { who: "agent", text: res.answer, res }]);
      setHighlight(new Set(res.subgraph_node_ids));
    });

  const stats = graph?.stats;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="grad">GraphRAG Studio</span>
          <small>upload → build a knowledge graph → chat over the subgraph</small>
        </div>
        <div className="stats">
          {stats && (
            <>
              <span>
                <b>{stats.nodes}</b> entities
              </span>
              <span>
                <b>{stats.edges}</b> relations
              </span>
              <span>
                <b>{stats.documents}</b> docs
              </span>
              <span className={`pill ${stats.provider === "llm" ? "llm" : ""}`}>
                {stats.provider}
              </span>
            </>
          )}
        </div>
      </header>

      <div className="graph-pane">
        {graph && graph.nodes.length > 0 ? (
          <GraphView nodes={graph.nodes} edges={graph.edges} highlight={highlight} />
        ) : (
          <div className="empty">
            <div>
              <h2>No graph yet</h2>
              <p>Paste text or upload a document on the right to build one.</p>
            </div>
          </div>
        )}
      </div>

      <aside className="sidebar">
        <div className="panel">
          <h3>Add documents</h3>
          <textarea
            rows={4}
            placeholder="Paste text to ingest…"
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
          />
          <div className="row">
            <button onClick={onBuild} disabled={busy || !pasteText.trim()}>
              Build graph
            </button>
            <button className="ghost" onClick={() => fileRef.current?.click()} disabled={busy}>
              Upload file
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".txt,.md,.markdown,.text"
              hidden
              onChange={onUpload}
            />
            <button className="ghost" onClick={onReset} disabled={busy}>
              Reset
            </button>
          </div>
          {error && <div className="err">{error}</div>}
        </div>

        <div className="panel chat">
          <h3>Chat over the graph</h3>
          <div className="messages">
            {messages.length === 0 && (
              <div className="hint">
                Ask a question once a graph exists. The answer highlights the subgraph it
                used.
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`msg ${m.who}`}>
                <div className="who">{m.who}</div>
                <div className="bubble">{m.text}</div>
                {m.res && m.res.citations.length > 0 && (
                  <div className="cites">
                    {m.res.citations.slice(0, 10).map((c, j) => (
                      <span key={j} className={`cite ${c.kind}`}>
                        {c.ref}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
            <div ref={msgEnd} />
          </div>
          <div className="row">
            <input
              type="text"
              placeholder="How is X connected to Y?"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !busy && onAsk()}
            />
            <button onClick={onAsk} disabled={busy || !question.trim()}>
              Ask
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}
