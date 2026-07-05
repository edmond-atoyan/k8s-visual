// Deterministic layered layout, tuned for the Kubernetes hierarchy.
//
// Columns follow the flow of traffic and ownership, left to right:
//   Ingress | Service | workload controllers | ReplicaSet/Job | Pod | config & storage
//
// Rows: pods (and other leaves) get sequential rows per ownership tree;
// parents center over their children; Services/Ingresses/config align with
// what they point at, then overlaps are pushed apart. No layout library
// needed - the hierarchy is shallow and this stays fully predictable.

import type { Kind, ResourceSummary } from "../types";
import type { ResourceGraph } from "./build";

export const NODE_W = 224;
export const NODE_H = 62;
const COL_GAP = 96;
const ROW_GAP = 22;
const X_STEP = NODE_W + COL_GAP;
const Y_STEP = NODE_H + ROW_GAP;

const COLUMN: Record<Kind, number> = {
  Ingress: 0,
  NetworkPolicy: 0,
  Service: 1,
  HorizontalPodAutoscaler: 1,
  Deployment: 2,
  StatefulSet: 2,
  DaemonSet: 2,
  CronJob: 2,
  ReplicaSet: 3,
  Job: 3,
  Pod: 4,
  ConfigMap: 5,
  Secret: 5,
  PersistentVolumeClaim: 5,
  PersistentVolume: 6,
  StorageClass: 7,
  Node: 6,
};

// Stable ordering of trees within the workload columns.
const KIND_ORDER: Record<string, number> = {
  Deployment: 0,
  StatefulSet: 1,
  DaemonSet: 2,
  CronJob: 3,
  ReplicaSet: 4,
  Job: 5,
  Pod: 6,
};

export interface Positioned {
  resource: ResourceSummary;
  x: number;
  y: number;
}

/** Place items near a desired row, then push overlapping ones apart. */
function resolveRows(items: { uid: string; desired: number }[]): Map<string, number> {
  const out = new Map<string, number>();
  const sorted = [...items].sort((a, b) => a.desired - b.desired);
  let prev = -Infinity;
  for (const item of sorted) {
    const row = Math.max(item.desired, prev + 1);
    out.set(item.uid, row);
    prev = row;
  }
  return out;
}

export function layoutGraph(graph: ResourceGraph): Positioned[] {
  const { resources, edges, children } = graph;
  const byUid = new Map(resources.map((r) => [r.uid, r]));
  const rows = new Map<string, number>();

  // 1. Ownership trees: leaves take sequential rows, parents center on kids.
  const inGraphOwned = new Set([...children.values()].flat());
  const treeKinds = new Set(["Deployment", "StatefulSet", "DaemonSet", "CronJob", "ReplicaSet", "Job", "Pod"]);
  const roots = resources
    .filter((r) => treeKinds.has(r.kind) && !inGraphOwned.has(r.uid))
    .sort(
      (a, b) =>
        (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) || a.name.localeCompare(b.name),
    );

  let cursor = 0;
  const place = (uid: string): number => {
    const kids = (children.get(uid) ?? [])
      .map((k) => byUid.get(k))
      .filter((k): k is ResourceSummary => !!k)
      .sort((a, b) => a.name.localeCompare(b.name));
    if (kids.length === 0) {
      rows.set(uid, cursor);
      return cursor++;
    }
    const kidRows = kids.map((k) => place(k.uid));
    const center = (Math.min(...kidRows) + Math.max(...kidRows)) / 2;
    rows.set(uid, center);
    return center;
  };
  for (const root of roots) {
    place(root.uid);
    cursor += 0.35; // breathing room between trees
  }

  // 2. Services center on the pods they select; Ingresses on their Services.
  const desiredFromEdges = (r: ResourceSummary, kinds: Set<string>): number => {
    const targets = edges
      .filter((e) => e.source === r.uid && kinds.has(e.kind))
      .map((e) => rows.get(e.target))
      .filter((y): y is number => y !== undefined);
    if (targets.length === 0) return 0;
    return targets.reduce((a, b) => a + b, 0) / targets.length;
  };

  const services = resources.filter((r) => r.kind === "Service");
  resolveRows(
    services.map((r) => ({ uid: r.uid, desired: desiredFromEdges(r, new Set(["selects"])) })),
  ).forEach((row, uid) => rows.set(uid, row));

  // HPAs sit next to Services and point at their scaled workload.
  const hpas = resources.filter((r) => r.kind === "HorizontalPodAutoscaler");
  resolveRows(
    hpas.map((r) => ({ uid: r.uid, desired: desiredFromEdges(r, new Set(["scales", "refs"])) })),
  ).forEach((row, uid) => rows.set(uid, row));

  const ingresses = resources.filter((r) => r.kind === "Ingress");
  resolveRows(
    ingresses.map((r) => ({ uid: r.uid, desired: desiredFromEdges(r, new Set(["routes", "refs"])) })),
  ).forEach((row, uid) => rows.set(uid, row));

  const netpols = resources.filter((r) => r.kind === "NetworkPolicy");
  resolveRows(
    netpols.map((r) => ({ uid: r.uid, desired: desiredFromEdges(r, new Set(["protects"])) })),
  ).forEach((row, uid) => rows.set(uid, row));

  // 3. Config & storage columns center on whatever points at them.
  const incomingKinds = new Set(["mounts", "refs", "binds", "backs"]);
  const desiredFor = (uid: string): number => {
    const sources = edges
      .filter((e) => incomingKinds.has(e.kind) && e.target === uid)
      .map((e) => rows.get(e.source))
      .filter((y): y is number => y !== undefined);
    if (sources.length === 0) return cursor;
    return sources.reduce((a, b) => a + b, 0) / sources.length;
  };
  for (const kinds of [
    ["ConfigMap", "Secret", "PersistentVolumeClaim"],
    ["PersistentVolume"],
    ["StorageClass"],
  ]) {
    const set = new Set(kinds);
    const column = resources.filter((r) => set.has(r.kind));
    resolveRows(column.map((r) => ({ uid: r.uid, desired: desiredFor(r.uid) }))).forEach(
      (row, uid) => rows.set(uid, row),
    );
  }

  return resources.map((resource) => ({
    resource,
    x: COLUMN[resource.kind] * X_STEP,
    y: (rows.get(resource.uid) ?? 0) * Y_STEP,
  }));
}
