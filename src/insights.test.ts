import { describe, expect, it } from "vitest";
import { buildProblemChains } from "./chains";
import { computeMetricsInsights, parseCpu, parseMem } from "./insights";
import { DemoProvider, DEMO_DEFAULT_NAMESPACE } from "./providers/demo";

describe("quantity parsing", () => {
  it("parses cpu quantities to millicores", () => {
    expect(parseCpu("250m")).toBe(250);
    expect(parseCpu("1")).toBe(1000);
    expect(parseCpu("1.5")).toBe(1500);
    expect(parseCpu("abc")).toBeNull();
  });
  it("parses memory quantities to bytes", () => {
    expect(parseMem("128Mi")).toBe(128 * 2 ** 20);
    expect(parseMem("1Gi")).toBe(2 ** 30);
    expect(parseMem("500M")).toBe(5e8);
    expect(parseMem("junk")).toBeNull();
  });
});

describe("computeMetricsInsights (against the demo cluster)", () => {
  async function demoInsights() {
    const demo = new DemoProvider();
    await demo.connect();
    const snapshot = await demo.getSnapshot(DEMO_DEFAULT_NAMESPACE);
    const metrics = await demo.getMetrics(DEMO_DEFAULT_NAMESPACE);
    const overview = await demo.getOverview();
    const nodeCapacity = new Map(
      overview.nodes.map((n) => {
        const ki = /^(\d+)Ki$/.exec(n.memory)?.[1];
        return [n.name, { cpuMillis: Number(n.cpu) * 1000, memBytes: ki ? Number(ki) * 1024 : 0 }] as const;
      }),
    );
    const chains = buildProblemChains(snapshot.resources);
    return computeMetricsInsights({
      namespace: DEMO_DEFAULT_NAMESPACE,
      resources: snapshot.resources,
      metrics,
      nodeCapacity,
      chains,
    });
  }

  it("explains Pending pods instead of showing zeros, linking PVC root cause", async () => {
    const insights = await demoInsights();
    const pending = insights.filter((i) => i.title.includes("Pending"));
    expect(pending.length).toBeGreaterThanOrEqual(2); // analytics + reports pods
    const pvcOne = pending.find((i) => i.detail.includes("PersistentVolumeClaim"));
    expect(pvcOne).toBeDefined();
    expect(pvcOne!.detail).toContain("reports-data");
  });

  it("flags workloads whose containers set no resource requests", async () => {
    const insights = await demoInsights();
    const noReq = insights.find((i) => i.title.includes("no resource requests"));
    expect(noReq).toBeDefined();
    expect(noReq!.detail).toMatch(/HPA|scheduler/);
  });

  it("flags heavily over-requested CPU (postgres asks 1 core)", async () => {
    const insights = await demoInsights();
    const over = insights.find((i) => i.title.includes("postgres-0") && i.title.includes("CPU request"));
    expect(over).toBeDefined();
  });

  it("orders critical before warning before info", async () => {
    const insights = await demoInsights();
    const ranks = insights.map((i) => ({ critical: 0, warning: 1, info: 2 })[i.severity]);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
  });
});
