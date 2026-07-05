// Turns a namespace snapshot into graph nodes and edges.
//
// Edge kinds mirror how Kubernetes actually relates resources:
//  - "owns":     ownerReferences (Deployment -> ReplicaSet -> Pod)      solid
//  - "selects":  label selectors (Service -> matching Pods)             dashed
//  - "routes":   Ingress -> backend Service                             dashed
//  - "mounts":   Pod -> ConfigMap/Secret/PVC it mounts                  dashed
//  - "scales":   HorizontalPodAutoscaler -> workload it scales          dashed
//  - "protects": NetworkPolicy -> Pods its podSelector matches          dashed
//  - "binds":    PersistentVolumeClaim -> PersistentVolume              dashed
//  - "backs":    PersistentVolume -> StorageClass                       dashed
//  - "refs":     any other explicit reference                          dashed
//
// Every edge carries a human-readable `reason` (the selector/ownerReference/
// field that created it) so the UI can explain why the edge exists.
// References to resources that do not exist become "ghost" nodes with a
// broken edge - the graph shows what is broken, not just what is there.

import type { Health, Kind, ResourceSummary } from "../types";

export type EdgeKind =
  | "owns"
  | "selects"
  | "routes"
  | "mounts"
  | "scales"
  | "protects"
  | "binds"
  | "backs"
  | "refs";

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  /** Why this relationship exists, e.g. the selector or field behind it. */
  reason: string;
  /** True when the relationship is broken (e.g. target missing). */
  broken?: boolean;
}

export interface ResourceGraph {
  resources: ResourceSummary[];
  edges: GraphEdge[];
  /** ownership adjacency (uid -> child uids), used by the layout */
  children: Map<string, string[]>;
  /** per-resource diagnostics, e.g. "Service selects no ready Pods" */
  issues: Map<string, string[]>;
}

export function selectorMatches(
  selector: Record<string, string>,
  labels: Record<string, string>,
): boolean {
  const entries = Object.entries(selector);
  if (entries.length === 0) return false;
  return entries.every(([k, v]) => labels[k] === v);
}

function fmtSelector(selector: Record<string, string>): string {
  return Object.entries(selector)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}

/** Edge kind for a "Kind/name" reference, based on both endpoint kinds. */
function refKind(source: Kind, target: string): EdgeKind {
  if (source === "Ingress" && target === "Service") return "routes";
  if (source === "Pod") return "mounts";
  if (source === "HorizontalPodAutoscaler") return "scales";
  if (source === "PersistentVolumeClaim" && target === "PersistentVolume") return "binds";
  if (source === "PersistentVolume" && target === "StorageClass") return "backs";
  return "refs";
}

function refReason(source: ResourceSummary, targetKind: string, targetName: string): string {
  switch (refKind(source.kind, targetKind)) {
    case "routes":
      return `ingress rule routes to Service "${targetName}" (spec.rules[].http.paths[].backend)`;
    case "mounts":
      return targetKind === "PersistentVolumeClaim"
        ? `pod mounts PVC "${targetName}" (spec.volumes[].persistentVolumeClaim)`
        : `pod mounts ${targetKind} "${targetName}" (spec.volumes[] or envFrom)`;
    case "scales":
      return `HPA targets ${targetKind} "${targetName}" (spec.scaleTargetRef)`;
    case "binds":
      return `claim is bound to PersistentVolume "${targetName}" (spec.volumeName)`;
    case "backs":
      return `volume is provisioned by StorageClass "${targetName}" (spec.storageClassName)`;
    default:
      return `references ${targetKind} "${targetName}"`;
  }
}

/** A placeholder node for a reference whose target does not exist. */
export function ghostResource(kind: Kind, name: string, namespace: string): ResourceSummary {
  return {
    uid: `missing:${kind}/${name}`,
    kind,
    name,
    namespace,
    owners: [],
    labels: {},
    status: "Not found",
    health: "critical" as Health,
    details: {},
  };
}

const KNOWN_KINDS = new Set<string>([
  "Pod", "Deployment", "ReplicaSet", "StatefulSet", "DaemonSet", "Job", "CronJob",
  "Service", "Ingress", "ConfigMap", "Secret", "PersistentVolumeClaim",
  "PersistentVolume", "StorageClass", "HorizontalPodAutoscaler", "NetworkPolicy",
]);

export function buildGraph(resources: ResourceSummary[]): ResourceGraph {
  const all = [...resources];
  const byUid = new Map(all.map((r) => [r.uid, r]));
  const byKindName = new Map(all.map((r) => [`${r.kind}/${r.name}`, r]));
  const edges: GraphEdge[] = [];
  const children = new Map<string, string[]>();
  const issues = new Map<string, string[]>();
  const ghosts = new Map<string, ResourceSummary>();

  const addIssue = (uid: string, issue: string) => {
    const list = issues.get(uid) ?? [];
    list.push(issue);
    issues.set(uid, list);
  };

  for (const r of resources) {
    // Ownership: edge from each in-graph owner down to this resource.
    for (const o of r.owners) {
      if (!byUid.has(o.uid)) continue;
      edges.push({
        id: `own:${o.uid}:${r.uid}`,
        source: o.uid,
        target: r.uid,
        kind: "owns",
        reason: `${r.kind} "${r.name}" has an ownerReference to ${o.kind} "${o.name}" - the ${o.kind} created it and manages its lifecycle`,
      });
      const kids = children.get(o.uid) ?? [];
      kids.push(r.uid);
      children.set(o.uid, kids);
    }

    // Label selectors: Services select Pods (workload selectors are already
    // expressed through ownership); NetworkPolicies protect Pods.
    if ((r.kind === "Service" || r.kind === "NetworkPolicy") && r.selector) {
      let matched = 0;
      let ready = 0;
      for (const target of resources) {
        if (target.kind !== "Pod" || !selectorMatches(r.selector, target.labels)) continue;
        matched++;
        if (target.health === "good") ready++;
        edges.push({
          id: `sel:${r.uid}:${target.uid}`,
          source: r.uid,
          target: target.uid,
          kind: r.kind === "Service" ? "selects" : "protects",
          reason:
            r.kind === "Service"
              ? `service.spec.selector { ${fmtSelector(r.selector)} } matches pod labels { ${fmtSelector(target.labels)} }`
              : `networkPolicy.spec.podSelector { ${fmtSelector(r.selector)} } matches pod labels { ${fmtSelector(target.labels)} }`,
          broken: r.kind === "Service" && target.health !== "good" ? true : undefined,
        });
      }
      if (r.kind === "Service") {
        if (matched === 0) {
          addIssue(
            r.uid,
            `Selector { ${fmtSelector(r.selector)} } matches no Pods - this Service has no endpoints and traffic to it will fail.`,
          );
        } else if (ready === 0) {
          addIssue(
            r.uid,
            `Selector matches ${matched} Pod(s) but none are ready - this Service currently has no ready endpoints.`,
          );
        }
      }
    }

    // Explicit references ("Kind/name").
    for (const ref of r.refs ?? []) {
      const [targetKind, targetName] = ref.split("/", 2);
      let target = byKindName.get(ref);
      if (!target && KNOWN_KINDS.has(targetKind)) {
        // Referenced resource does not exist: show it as a broken ghost node.
        let ghost = ghosts.get(ref);
        if (!ghost) {
          ghost = ghostResource(targetKind as Kind, targetName, r.namespace);
          ghosts.set(ref, ghost);
          byKindName.set(ref, ghost);
          byUid.set(ghost.uid, ghost);
        }
        target = ghost;
        addIssue(
          r.uid,
          `${r.kind} "${r.name}" references ${targetKind} "${targetName}", which does not exist in this namespace.`,
        );
      }
      if (!target) continue;
      const kind = refKind(r.kind, targetKind);
      edges.push({
        id: `ref:${r.uid}:${target.uid}`,
        source: r.uid,
        target: target.uid,
        kind,
        reason: refReason(r, targetKind, targetName),
        broken: target.uid.startsWith("missing:") ? true : undefined,
      });
    }
  }

  return { resources: [...all, ...ghosts.values()], edges, children, issues };
}

/** Uids of everything connected to `uid` (any edge kind, either direction). */
export function connectedUids(graph: ResourceGraph, uid: string): Set<string> {
  const out = new Set<string>([uid]);
  for (const e of graph.edges) {
    if (e.source === uid) out.add(e.target);
    if (e.target === uid) out.add(e.source);
  }
  return out;
}
