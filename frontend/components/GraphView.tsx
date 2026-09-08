"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { GraphEdge, GraphNode } from "@/lib/api";

// react-force-graph uses canvas/WebGL — must be client-only.
const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), { ssr: false });

// Stable-ish palette by entity type.
const TYPE_COLORS: Record<string, string> = {
  concept: "#6ea8fe",
  person: "#9b8cff",
  org: "#57d9a3",
  organization: "#57d9a3",
  product: "#ffcb6b",
  technology: "#f78c6c",
  method: "#f78c6c",
  algorithm: "#ff7eb6",
  dataset: "#80cbc4",
  model: "#ffcb6b",
  file: "#aeb6c6",
  place: "#80cbc4",
  event: "#ff7eb6",
};

function colorFor(type: string): string {
  return TYPE_COLORS[type?.toLowerCase()] || "#8aa0c8";
}

function typeKey(type: string | undefined): string {
  return (type || "unknown").toLowerCase();
}

// Shared dim style for anything not in the active focus set
// (query highlight, hover neighbourhood, or legend toggle).
const DIM_ALPHA = 0.22;
const LINK_DEFAULT = "rgba(255,255,255,0.16)";
const LINK_ON = "rgba(110,168,254,0.85)";
const LINK_DIM = "rgba(255,255,255,0.05)";
const TEXT = "#e8ecf4";
const TEXT_MUTED = "rgba(232,236,244,0.55)";

const LABEL_TOP_N = 25;
const DBLCLICK_MS = 350;

function linkKey(e: GraphEdge): string {
  return `${e.source}|${e.target}|${e.label}`;
}

function nodeRadius(node: any): number {
  return 4 + Math.min(node.mentions || 0, 6);
}

export default function GraphView({
  nodes,
  edges,
  highlight,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  highlight: Set<string>;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const fgRef = useRef<any>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });

  const [hoverNode, setHoverNode] = useState<any>(null);
  const [hoverLink, setHoverLink] = useState<any>(null);
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (!wrap.current) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setSize({ w: r.width, h: r.height });
    });
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);

  // ---- 1. Reuse node/link objects by id so positions survive live updates ----
  // force-graph stores x/y/vx/vy on the node objects it is handed. Handing it
  // fresh objects every poll re-seeds the layout and every node jumps. Keep one
  // object per id, mutate its fields in place, and only hand force-graph a new
  // graphData identity when an id was actually added or removed.
  const nodeObjs = useRef<Map<string, any>>(new Map());
  const linkObjs = useRef<Map<string, any>>(new Map());
  const prevData = useRef<{ nodes: any[]; links: any[] } | null>(null);

  const data = useMemo(() => {
    const nm = nodeObjs.current;
    const lm = linkObjs.current;
    let changed = false;

    const seenNodes = new Set<string>();
    const outNodes = nodes.map((n) => {
      seenNodes.add(n.id);
      let o = nm.get(n.id);
      if (!o) {
        o = { ...n };
        nm.set(n.id, o);
        changed = true;
      } else {
        o.label = n.label;
        o.type = n.type;
        o.mentions = n.mentions;
      }
      return o;
    });
    for (const id of Array.from(nm.keys())) {
      if (!seenNodes.has(id)) {
        nm.delete(id);
        changed = true;
      }
    }

    const seenLinks = new Set<string>();
    const outLinks = edges.map((e) => {
      const k = linkKey(e);
      seenLinks.add(k);
      let o = lm.get(k);
      if (!o) {
        o = { ...e, key: k };
        lm.set(k, o);
        changed = true;
      } else {
        o.description = e.description;
        // force-graph rewrites source/target into node objects. If an endpoint
        // was dropped and re-added, point the link at the current object.
        const s = nm.get(e.source);
        const t = nm.get(e.target);
        if (s && o.source !== s) o.source = s;
        if (t && o.target !== t) o.target = t;
      }
      return o;
    });
    for (const k of Array.from(lm.keys())) {
      if (!seenLinks.has(k)) {
        lm.delete(k);
        changed = true;
      }
    }

    if (!changed && prevData.current) return prevData.current;
    const next = { nodes: outNodes, links: outLinks };
    prevData.current = next;
    return next;
  }, [nodes, edges]);

  // Spread the layout out a bit so labels don't pile up, and re-heat only
  // when the node count actually changed (unchanged polls keep the same
  // graphData identity above, so force-graph never sees them).
  const nodeCount = data.nodes.length;
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    fg.d3Force("charge")?.strength(-180);
    fg.d3Force("link")?.distance(58);
    fg.d3ReheatSimulation?.();
  }, [nodeCount]);

  // Fit the view when the engine settles, but only if the graph grew or
  // shrank since the last fit — otherwise a poll would undo a click-to-zoom.
  const lastFitCount = useRef(-1);

  // ---- 2. Hover neighbourhood ----
  const adjacency = useMemo(() => {
    const adj = new Map<string, Set<string>>();
    const add = (a: string, b: string) => {
      let s = adj.get(a);
      if (!s) adj.set(a, (s = new Set()));
      s.add(b);
    };
    for (const e of edges) {
      add(e.source, e.target);
      add(e.target, e.source);
    }
    return adj;
  }, [edges]);

  const hoverId: string | null = hoverNode ? hoverNode.id : null;
  const hoverSet = useMemo(() => {
    const s = new Set<string>();
    if (hoverId === null) return s;
    s.add(hoverId);
    adjacency.get(hoverId)?.forEach((n) => s.add(n));
    return s;
  }, [hoverId, adjacency]);

  // ---- 3. Label declutter: top-N by mentions, computed once per nodes change ----
  const topByMentions = useMemo(() => {
    const sorted = [...nodes].sort((a, b) => (b.mentions || 0) - (a.mentions || 0));
    return new Set(sorted.slice(0, LABEL_TOP_N).map((n) => n.id));
  }, [nodes]);

  // ---- 5. Type legend ----
  const typeById = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of nodes) m.set(n.id, typeKey(n.type));
    return m;
  }, [nodes]);

  const typeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of nodes) {
      const k = typeKey(n.type);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [nodes]);

  const toggleType = (t: string) =>
    setHiddenTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });

  const hasHighlight = highlight.size > 0;
  // Hover never overrides an active query highlight.
  const hoverActive = !hasHighlight && hoverId !== null;
  const legendActive = hiddenTypes.size > 0;

  const typeHidden = (id: string) => legendActive && hiddenTypes.has(typeById.get(id) || "unknown");

  // Focus state for a node: `on` gets the glow ring, `dim` gets the faded style.
  const nodeState = (id: string): { on: boolean; dim: boolean } => {
    let on = false;
    let dim = false;
    if (hasHighlight) {
      on = highlight.has(id);
      dim = !on;
    } else if (hoverActive) {
      on = id === hoverId;
      dim = !hoverSet.has(id);
    }
    if (typeHidden(id)) dim = true;
    return { on, dim };
  };

  // A link is "on" when both endpoints are in the active focus set.
  const linkOn = (l: any): boolean => {
    const s = idOf(l.source);
    const t = idOf(l.target);
    if (typeHidden(s) || typeHidden(t)) return false;
    if (hasHighlight) return highlight.has(s) && highlight.has(t);
    if (hoverActive) return hoverSet.has(s) && hoverSet.has(t);
    return false;
  };
  const linkDimmed = (l: any): boolean => {
    const s = idOf(l.source);
    const t = idOf(l.target);
    if (typeHidden(s) || typeHidden(t)) return true;
    if (hasHighlight || hoverActive) return !linkOn(l);
    return false;
  };

  // ---- 4. Click behaviour ----
  const lastBgClick = useRef(0);

  return (
    <div ref={wrap} style={{ position: "absolute", inset: 0 }}>
      {size.w > 0 && (
        <ForceGraph2D
          ref={fgRef}
          width={size.w}
          height={size.h}
          graphData={data}
          backgroundColor="rgba(0,0,0,0)"
          cooldownTicks={120}
          d3AlphaDecay={0.03}
          d3VelocityDecay={0.35}
          onEngineStop={() => {
            if (lastFitCount.current === nodeCount) return;
            lastFitCount.current = nodeCount;
            fgRef.current?.zoomToFit(400, 60);
          }}
          onNodeHover={(n: any) => {
            setHoverNode(n || null);
            if (n) setHoverLink(null);
          }}
          onLinkHover={(l: any) => setHoverLink(l || null)}
          onNodeClick={(n: any) => {
            const fg = fgRef.current;
            if (!fg) return;
            fg.centerAt(n.x, n.y, 500);
            fg.zoom(3, 500);
          }}
          onBackgroundClick={() => {
            setHoverNode(null);
            setHoverLink(null);
            const now = Date.now();
            if (now - lastBgClick.current < DBLCLICK_MS) {
              lastBgClick.current = 0;
              fgRef.current?.zoomToFit(400, 60);
            } else {
              lastBgClick.current = now;
            }
          }}
          linkColor={(l: any) => {
            if (linkOn(l)) return LINK_ON;
            if (linkDimmed(l)) return LINK_DIM;
            return LINK_DEFAULT;
          }}
          linkWidth={(l: any) => (linkOn(l) ? 1.6 : 0.6)}
          linkDirectionalArrowLength={3}
          linkDirectionalArrowRelPos={1}
          // Relation text at the midpoint of the hovered link only.
          linkCanvasObjectMode={(l: any) => (l === hoverLink ? "after" : undefined)}
          linkCanvasObject={(l: any, ctx, scale) => {
            const s = l.source;
            const t = l.target;
            if (typeof s !== "object" || typeof t !== "object") return;
            const text: string = l.label || l.relation || "";
            if (!text) return;
            const fontSize = 10 / scale;
            ctx.font = `${fontSize}px ui-sans-serif, system-ui`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillStyle = TEXT;
            ctx.fillText(text, (s.x + t.x) / 2, (s.y + t.y) / 2 - fontSize * 0.7);
          }}
          nodeRelSize={5}
          nodePointerAreaPaint={(node: any, color, ctx) => {
            ctx.beginPath();
            ctx.arc(node.x, node.y, nodeRadius(node) + 2, 0, 2 * Math.PI);
            ctx.fillStyle = color;
            ctx.fill();
          }}
          nodeCanvasObject={(node: any, ctx, scale) => {
            const { on, dim } = nodeState(node.id);
            const r = nodeRadius(node);
            ctx.globalAlpha = dim ? DIM_ALPHA : 1;

            // glow on highlighted / hovered nodes
            if (on) {
              ctx.beginPath();
              ctx.arc(node.x, node.y, r + 4, 0, 2 * Math.PI);
              ctx.fillStyle = "rgba(110,168,254,0.18)";
              ctx.fill();
            }
            ctx.beginPath();
            ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
            ctx.fillStyle = colorFor(node.type);
            ctx.fill();
            if (on) {
              ctx.lineWidth = 1.6 / scale;
              ctx.strokeStyle = "#ffffff";
              ctx.stroke();
            }

            // labels: always for highlighted / hovered neighbourhood; otherwise
            // only when zoomed in or in the top-N by mentions; none when far out.
            const forced = (hasHighlight && highlight.has(node.id)) || hoverSet.has(node.id);
            const showLabel =
              forced || (scale >= 0.6 && (scale >= 1.4 || topByMentions.has(node.id)));
            if (showLabel) {
              const label: string = node.label || node.id;
              const fontSize = Math.max(9 / scale, Math.min(4, 9 / scale) + 1.5);
              ctx.font = `${fontSize}px ui-sans-serif, system-ui`;
              ctx.textAlign = "center";
              ctx.textBaseline = "top";
              ctx.fillStyle = dim ? "rgba(232,236,244,0.35)" : TEXT;
              ctx.fillText(label, node.x, node.y + r + 2);
            }
            ctx.globalAlpha = 1;
          }}
          nodeLabel={(n: any) => `${n.label} — ${n.type}`}
        />
      )}
      {typeCounts.length > 0 && (
        <TypeLegend types={typeCounts} hidden={hiddenTypes} onToggle={toggleType} />
      )}
    </div>
  );
}

function TypeLegend({
  types,
  hidden,
  onToggle,
}: {
  types: [string, number][];
  hidden: Set<string>;
  onToggle: (type: string) => void;
}) {
  return (
    <div
      style={{
        position: "absolute",
        left: 12,
        bottom: 12,
        padding: "8px 10px",
        borderRadius: 8,
        background: "rgba(10,14,22,0.7)",
        border: "1px solid rgba(255,255,255,0.08)",
        color: TEXT,
        fontSize: 12,
        lineHeight: "18px",
        userSelect: "none",
        maxHeight: "40%",
        overflowY: "auto",
      }}
    >
      {types.map(([type, count]) => {
        const off = hidden.has(type);
        return (
          <button
            key={type}
            type="button"
            onClick={() => onToggle(type)}
            title={off ? `Show ${type}` : `Dim ${type}`}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              padding: 0,
              margin: 0,
              border: "none",
              background: "transparent",
              color: "inherit",
              font: "inherit",
              cursor: "pointer",
              textAlign: "left",
              opacity: off ? 0.45 : 1,
            }}
          >
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: "50%",
                background: off ? "transparent" : colorFor(type),
                border: `2px solid ${colorFor(type)}`,
                boxSizing: "border-box",
                flex: "0 0 auto",
              }}
            />
            <span style={{ flex: "1 1 auto" }}>{type}</span>
            <span style={{ color: TEXT_MUTED, marginLeft: 8 }}>{count}</span>
          </button>
        );
      })}
    </div>
  );
}

// force-graph mutates link.source/target into node objects after layout.
function idOf(x: any): string {
  return typeof x === "object" && x !== null ? x.id : x;
}
