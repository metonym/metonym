import type { DocumentationSet, Relation } from "../ir/types.ts";

export interface GraphNode {
  id: string;
  type: "document" | "example" | "symbol" | "module";
  label: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: Relation["kind"];
}

/**
 * Build a normalized node/edge model from the DocumentationSet.
 * Deterministic: nodes sorted by id, edges by (kind, from, to).
 */
export function buildGraph(docs: DocumentationSet): {
  nodes: GraphNode[];
  edges: GraphEdge[];
} {
  const nodeMap = new Map<string, GraphNode>();
  const edgeSet = new Set<string>();
  const edges: GraphEdge[] = [];

  for (const doc of docs.documents) {
    nodeMap.set(doc.id, {
      id: doc.id,
      type: "document",
      label: doc.file,
    });
  }

  for (const example of docs.examples) {
    nodeMap.set(example.id, {
      id: example.id,
      type: "example",
      label: example.title,
    });
  }

  for (const symbol of docs.symbols) {
    nodeMap.set(symbol.id, {
      id: symbol.id,
      type: "symbol",
      label: `${symbol.file}:${symbol.name}`,
    });
  }

  for (const relation of docs.relations) {
    if (relation.kind === "imports") {
      // imports relations may reference module specifiers
      let targetId = relation.to;
      if (!nodeMap.has(relation.to)) {
        targetId = `mod:${relation.to}`;
        if (!nodeMap.has(targetId)) {
          nodeMap.set(targetId, {
            id: targetId,
            type: "module",
            label: relation.to,
          });
        }
      }
      const edgeKey = `${relation.kind}|${relation.from}|${targetId}`;
      if (!edgeSet.has(edgeKey)) {
        edgeSet.add(edgeKey);
        edges.push({
          from: relation.from,
          to: targetId,
          kind: relation.kind,
        });
      }
    } else if (relation.kind === "generates") {
      // generates relations may reference test paths
      let targetId = relation.to;
      if (!nodeMap.has(relation.to)) {
        targetId = `mod:${relation.to}`;
        if (!nodeMap.has(targetId)) {
          nodeMap.set(targetId, {
            id: targetId,
            type: "module",
            label: relation.to,
          });
        }
      }
      const edgeKey = `${relation.kind}|${relation.from}|${targetId}`;
      if (!edgeSet.has(edgeKey)) {
        edgeSet.add(edgeKey);
        edges.push({
          from: relation.from,
          to: targetId,
          kind: relation.kind,
        });
      }
    } else {
      const edgeKey = `${relation.kind}|${relation.from}|${relation.to}`;
      if (!edgeSet.has(edgeKey)) {
        edgeSet.add(edgeKey);
        edges.push({
          from: relation.from,
          to: relation.to,
          kind: relation.kind,
        });
      }
    }
  }

  const nodes = Array.from(nodeMap.values()).sort((a, b) =>
    a.id.localeCompare(b.id),
  );

  edges.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    if (a.from !== b.from) return a.from.localeCompare(b.from);
    return a.to.localeCompare(b.to);
  });

  return { nodes, edges };
}

/**
 * Serialize graph to JSON format (version 1).
 */
export function toGraphJSON(docs: DocumentationSet): string {
  return serializeGraphJSON(buildGraph(docs));
}

function serializeGraphJSON({
  nodes,
  edges,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
}): string {
  const output = { version: 1, nodes, edges };
  return `${JSON.stringify(output, null, 2)}\n`;
}

/**
 * Serialize graph to Mermaid flowchart format.
 * Sanitizes node ids for Mermaid compatibility.
 */
export function toMermaid(docs: DocumentationSet): string {
  return serializeMermaid(buildGraph(docs));
}

export function serializeMermaid({
  nodes,
  edges,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
}): string {
  const sanitizeIdMap = new Map<string, string>();
  const usedSanitized = new Set<string>();

  const sanitizeId = (id: string): string => {
    if (sanitizeIdMap.has(id)) {
      const existing = sanitizeIdMap.get(id);
      if (existing !== undefined) return existing;
    }

    const sanitized = `n_${id.replace(/[^a-zA-Z0-9]/g, "_")}`;

    let counter = 1;
    let finalId = sanitized;
    while (usedSanitized.has(finalId)) {
      finalId = `${sanitized}_${counter}`;
      counter++;
    }

    usedSanitized.add(finalId);
    sanitizeIdMap.set(id, finalId);
    return finalId;
  };

  const escapeLabel = (label: string): string => {
    return label.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  };

  const nodeLines: string[] = [];
  for (const node of nodes) {
    const sanitizedId = sanitizeId(node.id);
    const escapedLabel = escapeLabel(node.label);

    let shape = "";
    switch (node.type) {
      case "document":
        shape = `[[${escapedLabel}]]`;
        break;
      case "example":
        shape = `(${escapedLabel})`;
        break;
      case "symbol":
        shape = `[${escapedLabel}]`;
        break;
      case "module":
        shape = `[/${escapedLabel}\\]`;
        break;
    }

    nodeLines.push(`${sanitizedId}${shape}`);
  }

  const edgeLines: string[] = [];
  for (const edge of edges) {
    const fromId = sanitizeId(edge.from);
    const toId = sanitizeId(edge.to);
    edgeLines.push(`${fromId} -->|${edge.kind}| ${toId}`);
  }

  const lines: string[] = ["flowchart LR", ...nodeLines, ...edgeLines];
  return `${lines.join("\n")}\n`;
}

/**
 * Serialize graph to GraphViz DOT format.
 */
export function toDot(docs: DocumentationSet): string {
  return serializeDot(buildGraph(docs));
}

export function serializeDot({
  nodes,
  edges,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
}): string {
  const escapeLabel = (label: string): string => {
    return label.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  };

  const getShape = (type: GraphNode["type"]): string => {
    switch (type) {
      case "document":
        return "box3d";
      case "example":
        return "ellipse";
      case "symbol":
        return "box";
      case "module":
        return "folder";
    }
  };

  const nodeLines: string[] = [];
  for (const node of nodes) {
    const escapedId = escapeLabel(node.id);
    const escapedLabel = escapeLabel(node.label);
    const shape = getShape(node.type);
    nodeLines.push(`"${escapedId}" [label="${escapedLabel}", shape=${shape}];`);
  }

  const edgeLines: string[] = [];
  for (const edge of edges) {
    const escapedFrom = escapeLabel(edge.from);
    const escapedTo = escapeLabel(edge.to);
    edgeLines.push(
      `"${escapedFrom}" -> "${escapedTo}" [label="${edge.kind}"];`,
    );
  }

  const lines: string[] = [
    "digraph metonym {",
    "rankdir=LR;",
    ...nodeLines,
    ...edgeLines,
    "}",
  ];
  return `${lines.join("\n")}\n`;
}
