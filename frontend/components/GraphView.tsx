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
          width={size.w}
          height={size.h}
          graphData={data}
          backgroundColor="rgba(0,0,0,0)"
          linkColor={(l: any) => {
            if (!hasHighlight) return "rgba(255,255,255,0.14)";
            const on =
              highlight.has(idOf(l.source)) && highlight.has(idOf(l.target));
            return on ? "rgba(110,168,254,0.7)" : "rgba(255,255,255,0.05)";
          }}
          linkDirectionalArrowLength={3}
          linkDirectionalArrowRelPos={1}
          nodeRelSize={5}
          nodeCanvasObject={(node: any, ctx, scale) => {
            const dim = hasHighlight && !highlight.has(node.id);
            const r = 4 + Math.min(node.mentions || 0, 6);
            ctx.globalAlpha = dim ? 0.25 : 1;
            ctx.beginPath();
            ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
            ctx.fillStyle = colorFor(node.type);
            ctx.fill();
            if (hasHighlight && highlight.has(node.id)) {
              ctx.lineWidth = 1.5 / scale;
              ctx.strokeStyle = "#ffffff";
              ctx.stroke();
            }
            const label: string = node.label || node.id;
            if (scale > 1.3 || (hasHighlight && highlight.has(node.id))) {
              ctx.font = `${11 / scale}px ui-sans-serif, system-ui`;
              ctx.fillStyle = dim ? "rgba(232,236,244,0.4)" : "#e8ecf4";
              ctx.textAlign = "center";
              ctx.fillText(label, node.x, node.y + r + 9 / scale);
            }
            ctx.globalAlpha = 1;
          }}
          nodeLabel={(n: any) => `${n.label} (${n.type})`}
          cooldownTicks={120}
        />
      )}
    </div>
  );
}

// force-graph mutates link.source/target into node objects after layout.
function idOf(x: any): string {
  return typeof x === "object" && x !== null ? x.id : x;
}
