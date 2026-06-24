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

  useEffect(() => {
    if (!wrap.current) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setSize({ w: r.width, h: r.height });
    });
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);

  // Spread the layout out a bit so labels don't pile up.
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    fg.d3Force("charge")?.strength(-180);
    fg.d3Force("link")?.distance(58);
  }, [nodes.length]);

  const data = useMemo(
    () => ({
      nodes: nodes.map((n) => ({ ...n })),
      links: edges.map((e) => ({ ...e })),
    }),
    [nodes, edges],
  );

  const hasHighlight = highlight.size > 0;

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
          onEngineStop={() => fgRef.current?.zoomToFit(400, 60)}
          linkColor={(l: any) => {
            if (!hasHighlight) return "rgba(255,255,255,0.16)";
            const on = highlight.has(idOf(l.source)) && highlight.has(idOf(l.target));
            return on ? "rgba(110,168,254,0.85)" : "rgba(255,255,255,0.05)";
          }}
          linkWidth={(l: any) =>
            hasHighlight && highlight.has(idOf(l.source)) && highlight.has(idOf(l.target))
              ? 1.6
              : 0.6
          }
          linkDirectionalArrowLength={3}
          linkDirectionalArrowRelPos={1}
          nodeRelSize={5}
          nodeCanvasObject={(node: any, ctx, scale) => {
            const dim = hasHighlight && !highlight.has(node.id);
            const on = hasHighlight && highlight.has(node.id);
            const r = 4 + Math.min(node.mentions || 0, 6);
            ctx.globalAlpha = dim ? 0.22 : 1;

            // glow on highlighted nodes
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

            // labels: always drawn, sized to stay readable at any zoom
            const label: string = node.label || node.id;
            const fontSize = Math.max(9 / scale, Math.min(4, 9 / scale) + 1.5);
            ctx.font = `${fontSize}px ui-sans-serif, system-ui`;
            ctx.textAlign = "center";
            ctx.textBaseline = "top";
            ctx.fillStyle = dim ? "rgba(232,236,244,0.35)" : "#e8ecf4";
            ctx.fillText(label, node.x, node.y + r + 2);
            ctx.globalAlpha = 1;
          }}
          nodeLabel={(n: any) => `${n.label} — ${n.type}`}
        />
      )}
    </div>
  );
}

// force-graph mutates link.source/target into node objects after layout.
function idOf(x: any): string {
  return typeof x === "object" && x !== null ? x.id : x;
}
