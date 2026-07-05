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

import { buildGraph, connectedUids, type EdgeKind, type GraphEdge } from "../graph/build";
import { layoutGraph, NODE_H, NODE_W } from "../graph/layout";
import { KIND_INFO } from "../kindInfo";
import type { NamespaceSnapshot } from "../types";
import { Icon } from "../components/icons";
import { ResourceNode, type ResourceFlowNode } from "../components/ResourceNode";

const nodeTypes = { resource: ResourceNode };

const EDGE_STYLE: Record<EdgeKind, { dash?: string }> = {
  owns: {},
  selects: { dash: "4 4" },
  routes: { dash: "4 4" },
  mounts: { dash: "4 4" },
  scales: { dash: "4 4" },
  protects: { dash: "4 4" },
  binds: { dash: "4 4" },
  backs: { dash: "4 4" },
  refs: { dash: "4 4" },
};

interface Props {
  snapshot: NamespaceSnapshot;
  selectedUid: string | null;
  onSelect(uid: string | null): void;
}

export function GraphView({ snapshot, selectedUid, onSelect }: Props) {
  const [showNetworking, setShowNetworking] = useState(true);
  const [showConfig, setShowConfig] = useState(true);
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [focusMode, setFocusMode] = useState(true);
  const [selectedEdge, setSelectedEdge] = useState<GraphEdge | null>(null);

  const { nodes, edges, graph, problemCount } = useMemo(() => {
    const visible = snapshot.resources.filter((r) => {
      const group = KIND_INFO[r.kind].group;
      if (group === "Networking" && !showNetworking) return false;
      if (group === "Config & Storage" && !showConfig) return false;
      return true;
    });
    const graph = buildGraph(visible);
    const problemCount =
      graph.resources.filter((r) => r.health === "critical" || r.health === "warning").length +
      graph.issues.size;

    let shown = graph.resources;
    if (problemsOnly) {
      // Problems plus everything directly connected to them, for context.
      const keep = new Set<string>();
      for (const r of graph.resources) {
        if (r.health === "critical" || r.health === "warning" || graph.issues.has(r.uid)) {
          for (const uid of connectedUids(graph, r.uid)) keep.add(uid);
        }
      }
      shown = graph.resources.filter((r) => keep.has(r.uid));
    }
    const shownUids = new Set(shown.map((r) => r.uid));

    const searchLower = search.trim().toLowerCase();
    const matches = (name: string) => searchLower !== "" && name.toLowerCase().includes(searchLower);
    const focus =
      focusMode && selectedUid && shownUids.has(selectedUid) ? connectedUids(graph, selectedUid) : null;

    const nodes: ResourceFlowNode[] = layoutGraph({ ...graph, resources: shown })
      .filter((p) => shownUids.has(p.resource.uid))
      .map((p) => ({
        id: p.resource.uid,
        type: "resource",
        position: { x: p.x, y: p.y },
        // Fixed card size, declared up front so the first paint (and fitView)
        // doesn't wait for DOM measurement.
        width: NODE_W,
        height: NODE_H,
        data: {
          resource: p.resource,
          issues: graph.issues.get(p.resource.uid),
          dimmed:
            (focus !== null && !focus.has(p.resource.uid)) ||
            (searchLower !== "" && !matches(p.resource.name)),
        },
        selected: p.resource.uid === selectedUid,
      }));

    const edges: Edge[] = graph.edges
      .filter((e) => shownUids.has(e.source) && shownUids.has(e.target))
      .map((e) => {
        const stroke = e.broken ? "var(--critical)" : "var(--baseline)";
        const inFocus = focus === null || (focus.has(e.source) && focus.has(e.target));
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          label: e.broken ? "broken" : e.kind === "owns" ? undefined : e.kind,
          style: {
            stroke,
            strokeDasharray: EDGE_STYLE[e.kind].dash,
            opacity: inFocus ? 1 : 0.15,
            strokeWidth: selectedEdge?.id === e.id ? 2.5 : 1.5,
          },
          labelStyle: { fill: "var(--muted)", fontSize: 10 },
          labelBgStyle: { fill: "var(--page)", fillOpacity: 0.9 },
          labelBgPadding: [4, 2] as [number, number],
          labelBgBorderRadius: 4,
          markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: stroke },
        };
      });

    return { nodes, edges, graph, problemCount };
  }, [snapshot, selectedUid, showNetworking, showConfig, problemsOnly, search, focusMode, selectedEdge]);

  if (snapshot.resources.length === 0) {
    return (
      <div className="graph-empty">
        <div className="inner">
          <p>
            Nothing running in <strong>{snapshot.namespace}</strong>.
          </p>
          <p>
            Namespaces are folders for resources - this one is empty. Deploy something with{" "}
            <code>kubectl apply</code> and it will appear here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="graph-wrap">
      <div className="graph-toolbar">
        <input
          className="search-box"
          type="search"
          placeholder="search resources…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button className={`chip${showNetworking ? " on" : ""}`} onClick={() => setShowNetworking((v) => !v)}>
          Networking
        </button>
        <button className={`chip${showConfig ? " on" : ""}`} onClick={() => setShowConfig((v) => !v)}>
          Config &amp; Storage
        </button>
        <button
          className={`chip${problemsOnly ? " on" : ""}`}
          onClick={() => setProblemsOnly((v) => !v)}
          title="Show only degraded/failing resources and their direct neighbours"
        >
          Problems ({problemCount})
        </button>
        <button
          className={`chip${focusMode ? " on" : ""}`}
          onClick={() => setFocusMode((v) => !v)}
          title="Dim everything not connected to the selected resource"
        >
          Focus selection
        </button>
      </div>

      <ReactFlow
        key={snapshot.namespace}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
        minZoom={0.15}
        nodesDraggable={false}
        nodesConnectable={false}
        onNodeClick={(_, node) => {
          setSelectedEdge(null);
          onSelect(node.id);
        }}
        onEdgeClick={(_, edge) => {
          const found = graph.edges.find((e) => e.id === edge.id) ?? null;
          setSelectedEdge(found);
        }}
        onPaneClick={() => {
          setSelectedEdge(null);
          onSelect(null);
        }}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="var(--grid)" />
        <Controls showInteractive={false} />
      </ReactFlow>

      {selectedEdge && (
        <div className="edge-card">
          <div className="edge-card-head">
            <strong>{selectedEdge.kind}</strong> relationship
            {selectedEdge.broken && <span className="missing-tag">broken</span>}
            <button className="icon-btn" onClick={() => setSelectedEdge(null)} aria-label="Close">
              <Icon name="close" size={13} />
            </button>
          </div>
          <p>{selectedEdge.reason}</p>
        </div>
      )}

      <div className="legend">
        <div className="legend-row">
          <span className="dot health-good" /> Healthy
          <span className="dot health-warning" style={{ marginLeft: 8 }} /> Degraded
          <span className="dot health-critical" style={{ marginLeft: 8 }} /> Failing
        </div>
        <div className="legend-row">
          <span className="legend-line" /> owns
          <span className="legend-line dashed" style={{ marginLeft: 8 }} /> selects / routes / mounts / scales
        </div>
        <div className="legend-row">
          <span className="legend-line dashed broken" /> broken relationship - click any edge for the reason
        </div>
      </div>
    </div>
  );
}
