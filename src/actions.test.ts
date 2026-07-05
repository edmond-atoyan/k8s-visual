import { describe, expect, it } from "vitest";
import { actionsFor } from "./actions";
import type { ResourceSummary } from "./types";

function r(partial: Partial<ResourceSummary> & Pick<ResourceSummary, "kind" | "name">): ResourceSummary {
  return {
    uid: `${partial.kind}:ns:${partial.name}`,
    namespace: "prod",
    owners: [],
    labels: {},
    status: "Running",
    health: "good",
    details: {},
    ...partial,
  };
}

describe("actionsFor", () => {
  it("deployments get scale/restart/rollback/pause/delete", () => {
    const d = r({ kind: "Deployment", name: "api", details: { Replicas: "2 ready / 3 desired" } });
    const ids = actionsFor(d).map((a) => a.id);
    expect(ids).toEqual(["scale", "restart", "rollback", "pause", "delete"]);
  });

  it("scale builds the right action and kubectl intent from inputs", () => {
    const d = r({ kind: "Deployment", name: "api", details: { Replicas: "2 ready / 3 desired" } });
    const scale = actionsFor(d).find((a) => a.id === "scale")!;
    expect(scale.inputs!(d)[0].initial).toBe(3); // parsed from "3 desired"
    expect(scale.kubectl(d, { replicas: 5 })).toBe("kubectl scale deployment/api --replicas=5 -n prod");
    expect(scale.build(d, { replicas: 5 })).toEqual({
      type: "scaleWorkload",
      kind: "Deployment",
      namespace: "prod",
      name: "api",
      replicas: 5,
    });
  });

  it("pod deletion is medium risk (controller replaces it), secret deletion is danger", () => {
    const pod = r({ kind: "Pod", name: "api-x", owners: [{ kind: "ReplicaSet", name: "api-1", uid: "u" }] });
    const secret = r({ kind: "Secret", name: "creds" });
    expect(actionsFor(pod).find((a) => a.id === "delete")!.risk).toBe("medium");
    const deleteSecret = actionsFor(secret).find((a) => a.id === "delete")!;
    expect(deleteSecret.risk).toBe("danger");
    expect(deleteSecret.confirmName).toBe(true); // danger requires typing the name
  });

  it("explains that an owned pod will be recreated", () => {
    const pod = r({ kind: "Pod", name: "api-x", owners: [{ kind: "ReplicaSet", name: "api-1", uid: "u" }] });
    const del = actionsFor(pod).find((a) => a.id === "delete")!;
    expect(del.describe(pod, {})).toContain("replacement");
  });

  it("cronjobs can be suspended and triggered, and suspend flips by state", () => {
    const cj = r({ kind: "CronJob", name: "backup", status: "Scheduled", details: { Schedule: "0 3 * * *" } });
    const ids = actionsFor(cj).map((a) => a.id);
    expect(ids).toContain("suspend");
    expect(ids).toContain("trigger");
    const suspended = r({ kind: "CronJob", name: "backup", status: "Suspended" });
    expect(actionsFor(suspended).find((a) => a.id === "suspend")!.label).toContain("Resume");
  });

  it("nodes get cordon but never delete", () => {
    const node = r({ kind: "Node", name: "worker-1", namespace: "", details: { Unschedulable: "false" } });
    const ids = actionsFor(node).map((a) => a.id);
    expect(ids).toContain("cordon");
    expect(ids).not.toContain("delete");
  });

  it("ghost (missing) resources get no actions besides nothing destructive", () => {
    const ghost = r({ kind: "Service", name: "gone", uid: "missing:Service/gone" });
    expect(actionsFor(ghost).find((a) => a.id === "delete")).toBeUndefined();
  });

  it("every descriptor declares an RBAC verb+resource", () => {
    const kinds: ResourceSummary[] = [
      r({ kind: "Deployment", name: "a" }),
      r({ kind: "StatefulSet", name: "b" }),
      r({ kind: "DaemonSet", name: "c" }),
      r({ kind: "CronJob", name: "d" }),
      r({ kind: "Pod", name: "e" }),
      r({ kind: "Node", name: "f" }),
    ];
    for (const res of kinds) {
      for (const a of actionsFor(res)) {
        expect(a.verb).toBeTruthy();
        expect(a.resource).toBeTruthy();
        expect(a.kubectl(res, { replicas: 1 })).toContain("kubectl");
      }
    }
  });
});
