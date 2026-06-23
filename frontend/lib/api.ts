// Thin client for the GraphRAG Studio backend.
const BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

export interface GraphNode {
  id: string;
  label: string;
  type: string;
  mentions: number;
}
export interface GraphEdge {
  source: string;
  target: string;
  label: string;
  description: string;
}
export interface GraphStats {
  nodes: number;
  edges: number;
  documents: number;
  provider: string;
}
export interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: GraphStats;
}
export interface Citation {
  kind: string;
  ref: string;
}
export interface AskResponse {
  answer: string;
  citations: Citation[];
  triples: string[];
  subgraph_node_ids: string[];
}

async function jsonOrThrow(res: Response) {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `${res.status} ${res.statusText}`);
  }
  return res.json();
}

export async function getGraph(): Promise<GraphResponse> {
  return jsonOrThrow(await fetch(`${BASE}/api/graph`, { cache: "no-store" }));
}

export async function buildText(
  text: string,
  source = "inline",
  reset = false,
): Promise<GraphResponse> {
  return jsonOrThrow(
    await fetch(`${BASE}/api/build`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, source, reset }),
    }),
  );
}

export async function uploadFile(file: File, reset = false): Promise<GraphResponse> {
  const fd = new FormData();
  fd.append("file", file);
  return jsonOrThrow(
    await fetch(`${BASE}/api/upload?reset=${reset}`, { method: "POST", body: fd }),
  );
}

export async function ask(question: string): Promise<AskResponse> {
  return jsonOrThrow(
    await fetch(`${BASE}/api/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
    }),
  );
}

export async function resetGraph(): Promise<GraphResponse> {
  return jsonOrThrow(await fetch(`${BASE}/api/reset`, { method: "POST" }));
}
