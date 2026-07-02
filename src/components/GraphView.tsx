import { useMemo, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  ReactFlow,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { buildGraph, type EdgeKind } from "../graph/build";
import { layoutGraph } from "../graph/layout";
import { KIND_INFO } from "../kindInfo";
import type { NamespaceSnapshot } from "../types";
import { ResourceNode, type ResourceFlowNode } from "./ResourceNode";

const nodeTypes = { resource: ResourceNode };

const EDGE_STYLE: Record<EdgeKind, { dash?: string; label: string }> = {
  owns: { label: "owns" },
  selects: { dash: "4 4", label: "selects" },
  refs: { dash: "4 4", label: "references" },
};

interface Props {
  snapshot: NamespaceSnapshot;
  selectedUid: string | null;
  onSelect(uid: string | null): void;
}

export function GraphView({ snapshot, selectedUid, onSelect }: Props) {
  const [showNetworking, setShowNetworking] = useState(true);
  const [showConfig, setShowConfig] = useState(true);

  const { nodes, edges } = useMemo(() => {
    const visible = snapshot.resources.filter((r) => {
      const group = KIND_INFO[r.kind].group;
      if (group === "Networking") return showNetworking;
      if (group === "Config & Storage") return showConfig;
      return true;
    });
    const graph = buildGraph(visible);
    const nodes: ResourceFlowNode[] = layoutGraph(graph).map((p) => ({
      id: p.resource.uid,
      type: "resource",
      position: { x: p.x, y: p.y },
      data: { resource: p.resource },
      selected: p.resource.uid === selectedUid,
    }));
    const edges: Edge[] = graph.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      style: {
        stroke: "var(--baseline)",
        strokeDasharray: EDGE_STYLE[e.kind].dash,
      },
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: "var(--baseline)" },
    }));
    return { nodes, edges };
  }, [snapshot, selectedUid, showNetworking, showConfig]);

  if (snapshot.resources.length === 0) {
    return (
      <div className="graph-empty">
        <div className="inner">
          <p>
            Nothing running in <strong>{snapshot.namespace}</strong>.
          </p>
          <p>
            Namespaces are folders for resources — this one is empty. Deploy something with{" "}
            <code>kubectl apply</code> and it will appear here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="graph-wrap">
      <div className="graph-toolbar">
        <button
          className={`chip${showNetworking ? " on" : ""}`}
          onClick={() => setShowNetworking((v) => !v)}
        >
          Networking
        </button>
        <button
          className={`chip${showConfig ? " on" : ""}`}
          onClick={() => setShowConfig((v) => !v)}
        >
          Config &amp; Storage
        </button>
      </div>

      <ReactFlow
        key={snapshot.namespace}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
        minZoom={0.2}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable={false}
        onNodeClick={(_, node) => onSelect(node.id)}
        onPaneClick={() => onSelect(null)}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="var(--grid)" />
        <Controls showInteractive={false} />
      </ReactFlow>

      <div className="legend">
        <div className="legend-row">
          <span className="dot health-good" /> Healthy
          <span className="dot health-warning" style={{ marginLeft: 8 }} /> Degraded
          <span className="dot health-critical" style={{ marginLeft: 8 }} /> Failing
        </div>
        <div className="legend-row">
          <span className="legend-line" /> owns
          <span className="legend-line dashed" style={{ marginLeft: 8 }} /> selects / references
        </div>
      </div>
    </div>
  );
}
