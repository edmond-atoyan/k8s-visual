import { describe, expect, it } from "vitest";
import { buildProblemChains } from "./chains";
import { DemoProvider, DEMO_DEFAULT_NAMESPACE } from "./providers/demo";

async function demoState() {
  const demo = new DemoProvider();
  await demo.connect();
  const snapshot = await demo.getSnapshot(DEMO_DEFAULT_NAMESPACE);
  const events = await demo.getEvents(DEMO_DEFAULT_NAMESPACE);
  return { resources: snapshot.resources, events };
}

describe("buildProblemChains (against the demo cluster)", () => {
  it("finds the storage chain: Pod Pending -> PVC Pending -> missing StorageClass", async () => {
    const { resources, events } = await demoState();
    const chains = buildProblemChains(resources, events);
    const storage = chains.find((c) => c.id.startsWith("pvc:"));
    expect(storage).toBeDefined();
    expect(storage!.title).toMatch(/unbound PersistentVolumeClaim/);
    // full causal path, root first
    expect(storage!.chain.map((l) => l.kind)).toEqual([
      "Deployment",
      "ReplicaSet",
      "Pod",
      "PersistentVolumeClaim",
      "StorageClass",
    ]);
    expect(storage!.rootCause).toContain('"fast-ssd" does not exist');
    expect(storage!.checks).toContain("kubectl get storageclass");
    expect(storage!.checks).toContain(`kubectl describe pvc reports-data -n ${DEMO_DEFAULT_NAMESPACE}`);
    expect(storage!.evidence.join(" ")).toContain("fast-ssd");
  });

  it("finds crash-loop, image-pull, and scheduling chains", async () => {
    const { resources, events } = await demoState();
    const chains = buildProblemChains(resources, events);
    const ids = chains.map((c) => c.id);
    expect(ids.some((i) => i.startsWith("crash:"))).toBe(true);
    expect(ids.some((i) => i.startsWith("image:"))).toBe(true);
    expect(ids.some((i) => i.startsWith("sched:"))).toBe(true);
  });

  it("finds the Service with no matching Pods", async () => {
    const { resources } = await demoState();
    const chains = buildProblemChains(resources); // no events needed
    const svc = chains.find((c) => c.id.startsWith("svc:"));
    expect(svc).toBeDefined();
    expect(svc!.checks.join(" ")).toContain("kubectl get endpoints");
  });

  it("orders critical chains before warnings and works without events", async () => {
    const { resources } = await demoState();
    const chains = buildProblemChains(resources);
    expect(chains.length).toBeGreaterThanOrEqual(3);
    const firstWarning = chains.findIndex((c) => c.severity === "warning");
    const lastCritical = chains.map((c) => c.severity).lastIndexOf("critical");
    if (firstWarning !== -1) expect(lastCritical).toBeLessThan(firstWarning);
  });

  it("merges replica pods with the same cause into one chain", async () => {
    const { resources, events } = await demoState();
    const chains = buildProblemChains(resources, events);
    for (const c of chains) {
      expect(c.pods.length === 0 || new Set(c.pods).size === c.pods.length).toBe(true);
    }
  });
});
