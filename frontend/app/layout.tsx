import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "GraphRAG Studio",
  description:
    "Build a knowledge graph from your documents and chat over k-hop subgraph retrieval with citations.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
