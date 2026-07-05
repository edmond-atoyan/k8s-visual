import { describe, expect, it } from "vitest";
import type { ResourceSummary } from "../types";
import { buildGraph, connectedUids, selectorMatches } from "./build";

function r(partial: Partial<ResourceSummary> & Pick<ResourceSummary, "uid" | "kind" | "name">): ResourceSummary {
  return {
    namespace: "ns",
    owners: [],
    labels: {},
    status: "Running",
    health: "good",
    details: {},
    ...partial,
  };
}

describe("selectorMatches", () => {
  it("matches when every selector pair is present", () => {
    expect(selectorMatches({ app: "api" }, { app: "api", extra: "x" })).toBe(true);
  });
  it("fails on value mismatch or missing key", () => {
    expect(selectorMatches({ app: "api" }, { app: "web" })).toBe(false);
    expect(selectorMatches({ app: "api" }, {})).toBe(false);
  });
  it("an empty selector matches nothing (defensive)", () => {
    expect(selectorMatches({}, { app: "api" })).toBe(false);
  });
});

describe("buildGraph", () => {
  const deployment = r({ uid: "d1", kind: "Deployment", name: "api" });
  const rs = r({ uid: "rs1", kind: "ReplicaSet", name: "api-1", owners: [{ kind: "Deployment", name: "api", uid: "d1" }] });
  const pod = r({
    uid: "p1",
    kind: "Pod",
    name: "api-1-x",
    labels: { app: "api" },
    owners: [{ kind: "ReplicaSet", name: "api-1", uid: "rs1" }],
    refs: ["ConfigMap/cfg", "Secret/missing-secret"],
  });
  const cfg = r({ uid: "c1", kind: "ConfigMap", name: "cfg" });
  const svc = r({ uid: "s1", kind: "Service", name: "api", selector: { app: "api" } });

  it("builds ownerReference edges (owns) with reasons", () => {
    const g = buildGraph([deployment, rs, pod, cfg, svc]);
    const owns = g.edges.filter((e) => e.kind === "owns");
    expect(owns.map((e) => `${e.source}->${e.target}`).sort()).toEqual(["d1->rs1", "rs1->p1"]);
    expect(owns[0].reason).toContain("ownerReference");
  });

  it("builds selector edges from Services to matching Pods", () => {
    const g = buildGraph([deployment, rs, pod, cfg, svc]);
    const sel = g.edges.filter((e) => e.kind === "selects");
    expect(sel).toHaveLength(1);
    expect(sel[0].source).toBe("s1");
    expect(sel[0].target).toBe("p1");
    expect(sel[0].reason).toContain("app=api");
  });

  it("types reference edges by endpoint kinds (mounts)", () => {
    const g = buildGraph([pod, cfg]);
    const mounts = g.edges.filter((e) => e.kind === "mounts" && e.target === "c1");
    expect(mounts).toHaveLength(1);
  });

  it("creates a broken ghost node for references to missing resources", () => {
    const g = buildGraph([pod, cfg]);
    const ghost = g.resources.find((x) => x.uid === "missing:Secret/missing-secret");
    expect(ghost).toBeDefined();
    expect(ghost!.health).toBe("critical");
    const broken = g.edges.find((e) => e.target === ghost!.uid);
    expect(broken?.broken).toBe(true);
    expect(g.issues.get("p1")?.[0]).toContain("does not exist");
  });

  it("flags Services whose selector matches no Pods", () => {
    const lonely = r({ uid: "s2", kind: "Service", name: "search", selector: { app: "search" } });
    const g = buildGraph([lonely, pod]);
    expect(g.issues.get("s2")?.[0]).toContain("no endpoints");
  });

  it("flags Services whose matched Pods are all unready", () => {
    const sick = r({ uid: "p2", kind: "Pod", name: "sick", labels: { app: "api" }, health: "critical", status: "CrashLoopBackOff" });
    const g = buildGraph([svc, sick]);
    expect(g.issues.get("s1")?.[0]).toContain("none are ready");
  });

  it("routes edges from Ingress to Services", () => {
    const ing = r({ uid: "i1", kind: "Ingress", name: "shop", refs: ["Service/api"] });
    const g = buildGraph([ing, svc, pod]);
    expect(g.edges.find((e) => e.source === "i1" && e.target === "s1")?.kind).toBe("routes");
  });

  it("binds/backs edges along the storage chain", () => {
    const pvc = r({ uid: "v1", kind: "PersistentVolumeClaim", name: "data", refs: ["PersistentVolume/pv1"] });
    const pv = r({ uid: "v2", kind: "PersistentVolume", name: "pv1", refs: ["StorageClass/fast"] });
    const sc = r({ uid: "v3", kind: "StorageClass", name: "fast" });
    const g = buildGraph([pvc, pv, sc]);
    expect(g.edges.find((e) => e.source === "v1")?.kind).toBe("binds");
    expect(g.edges.find((e) => e.source === "v2")?.kind).toBe("backs");
  });

  it("connectedUids walks both edge directions", () => {
    const g = buildGraph([deployment, rs, pod, cfg, svc]);
    const around = connectedUids(g, "p1");
    expect(around).toContain("rs1"); // owner
    expect(around).toContain("s1"); // selecting service
    expect(around).toContain("c1"); // mounted configmap
    expect(around).not.toContain("d1"); // two hops away
  });
});
