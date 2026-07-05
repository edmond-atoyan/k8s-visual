import { describe, expect, it } from "vitest";
import { KIND_INFO } from "../kindInfo";
import { DEMO_DEFAULT_NAMESPACE, DemoProvider } from "./demo";

describe("DemoProvider", () => {
  it("every resource kind in the demo has learning content", async () => {
    const p = new DemoProvider();
    const snap = await p.getSnapshot(DEMO_DEFAULT_NAMESPACE);
    for (const r of snap.resources) {
      expect(KIND_INFO[r.kind], `KIND_INFO missing for ${r.kind}`).toBeDefined();
    }
  });

  it("ships the teaching failure modes", async () => {
    const p = new DemoProvider();
    const snap = await p.getSnapshot(DEMO_DEFAULT_NAMESPACE);
    const statuses = snap.resources.map((r) => r.status);
    expect(statuses).toContain("CrashLoopBackOff");
    expect(statuses).toContain("ImagePullBackOff");
    expect(statuses).toContain("Pending"); // unschedulable pod
    // A Service whose selector matches nothing (no endpoints).
    const search = snap.resources.find((r) => r.kind === "Service" && r.name === "search");
    expect(search?.selector).toEqual({ app: "search" });
    expect(
      snap.resources.some((r) => r.kind === "Pod" && r.labels.app === "search"),
    ).toBe(false);
  });

  it("scaling a deployment changes the pod count", async () => {
    const p = new DemoProvider();
    const before = (await p.getSnapshot(DEMO_DEFAULT_NAMESPACE)).resources.filter(
      (r) => r.kind === "Pod" && r.labels.app === "storefront",
    );
    const result = await p.performAction({
      type: "scaleWorkload",
      kind: "Deployment",
      namespace: DEMO_DEFAULT_NAMESPACE,
      name: "storefront",
      replicas: 5,
    });
    expect(result.ok).toBe(true);
    const after = (await p.getSnapshot(DEMO_DEFAULT_NAMESPACE)).resources.filter(
      (r) => r.kind === "Pod" && r.labels.app === "storefront",
    );
    expect(after.length).toBe(before.length + 2);
  });

  it("deleting an owned pod triggers a controller replacement", async () => {
    const p = new DemoProvider();
    const result = await p.performAction({
      type: "deleteResource",
      kind: "Pod",
      namespace: DEMO_DEFAULT_NAMESPACE,
      name: "storefront-7d9fc6b48-x2lqp",
    });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("replacement");
    const pods = (await p.getSnapshot(DEMO_DEFAULT_NAMESPACE)).resources.filter(
      (r) => r.kind === "Pod" && r.labels.app === "storefront",
    );
    expect(pods.length).toBe(3); // one gone, one new
    expect(pods.some((x) => x.name === "storefront-7d9fc6b48-x2lqp")).toBe(false);
  });

  it("secret summaries never include values; reveal is explicit", async () => {
    const p = new DemoProvider();
    const snap = await p.getSnapshot(DEMO_DEFAULT_NAMESPACE);
    const secret = snap.resources.find((r) => r.kind === "Secret" && r.name === "db-credentials")!;
    expect(JSON.stringify(secret)).not.toContain("demo-not-a-real-password");
    const yaml = await p.getYaml({ kind: "Secret", namespace: DEMO_DEFAULT_NAMESPACE, name: "db-credentials" });
    expect(yaml).not.toContain("demo-not-a-real-password");
    expect(yaml).toContain("hidden");
    const revealed = await p.revealSecret(DEMO_DEFAULT_NAMESPACE, "db-credentials");
    expect(revealed.find((k) => k.name === "password")?.value).toContain("demo-not-a-real-password");
  });

  it("rollout history knows the current revision", async () => {
    const p = new DemoProvider();
    const history = await p.getRolloutHistory(DEMO_DEFAULT_NAMESPACE, "api");
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(history[0].current).toBe(true);
    expect(history[0].revision).toBeGreaterThan(history[1].revision);
  });

  it("port-forward detects local port conflicts", async () => {
    const p = new DemoProvider();
    await p.startPortForward({ namespace: DEMO_DEFAULT_NAMESPACE, kind: "Service", name: "api", localPort: 8080, remotePort: 80 });
    await expect(
      p.startPortForward({ namespace: DEMO_DEFAULT_NAMESPACE, kind: "Service", name: "storefront", localPort: 8080, remotePort: 80 }),
    ).rejects.toThrow(/already in use/);
  });

  it("forwarding to a service with no ready pods fails honestly", async () => {
    const p = new DemoProvider();
    await expect(
      p.startPortForward({ namespace: DEMO_DEFAULT_NAMESPACE, kind: "Service", name: "search", localPort: 9999, remotePort: 80 }),
    ).rejects.toThrow(/no running Pods/);
  });
});
