// Turns a namespace snapshot into graph nodes and edges.
//
// Three edge kinds, mirroring how Kubernetes actually relates resources:
//  - "owns":    ownerReferences (Deployment -> ReplicaSet -> Pod)   solid
//  - "selects": label selectors (Service -> matching Pods)          dashed
//  - "refs":    explicit references (Ingress -> Service,
//               Pod -> ConfigMap/Secret/PVC)                        dashed

import type { ResourceSummary } from "../types";

export type EdgeKind = "owns" | "selects" | "refs";

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
}

export interface ResourceGraph {
  resources: ResourceSummary[];
  edges: GraphEdge[];
  /** ownership adjacency (uid -> child uids), used by the layout */
  children: Map<string, string[]>;
}

function selectorMatches(selector: Record<string, string>, labels: Record<string, string>): boolean {
  const entries = Object.entries(selector);
  if (entries.length === 0) return false;
  return entries.every(([k, v]) => labels[k] === v);
}

export function buildGraph(resources: ResourceSummary[]): ResourceGraph {
  const byUid = new Map(resources.map((r) => [r.uid, r]));
  const byKindName = new Map(resources.map((r) => [`${r.kind}/${r.name}`, r]));
  const edges: GraphEdge[] = [];
  const children = new Map<string, string[]>();

  for (const r of resources) {
    // Ownership: edge from each in-graph owner down to this resource.
    for (const o of r.owners) {
      if (!byUid.has(o.uid)) continue;
      edges.push({ id: `own:${o.uid}:${r.uid}`, source: o.uid, target: r.uid, kind: "owns" });
      const kids = children.get(o.uid) ?? [];
      kids.push(r.uid);
      children.set(o.uid, kids);
    }

    // Label selectors: only Services select in the graph (workload selectors
    // are already expressed through ownership).
    if (r.kind === "Service" && r.selector) {
      for (const target of resources) {
        if (target.kind === "Pod" && selectorMatches(r.selector, target.labels)) {
          edges.push({
            id: `sel:${r.uid}:${target.uid}`,
            source: r.uid,
            target: target.uid,
            kind: "selects",
          });
        }
      }
    }

    // Explicit references ("Kind/name").
    for (const ref of r.refs ?? []) {
      const target = byKindName.get(ref);
      if (!target) continue;
      edges.push({ id: `ref:${r.uid}:${target.uid}`, source: r.uid, target: target.uid, kind: "refs" });
    }
  }

  return { resources, edges, children };
}
