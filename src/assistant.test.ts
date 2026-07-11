import { describe, expect, it } from "vitest";
import { buildSharePayload, explainResource, summarizeNamespace } from "./assistant";
import { buildProblemChains } from "./chains";
import { DemoProvider, DEMO_DEFAULT_NAMESPACE } from "./providers/demo";

async function demoState() {
  const demo = new DemoProvider();
  await demo.connect();
  const snapshot = await demo.getSnapshot(DEMO_DEFAULT_NAMESPACE);
  const events = await demo.getEvents(DEMO_DEFAULT_NAMESPACE);
  const chains = buildProblemChains(snapshot.resources, events);
  return { snapshot, events, chains };
}

describe("built-in assistant (local, deterministic)", () => {
  it("summarizes namespace health with failing resources and chains", async () => {
    const { snapshot, chains } = await demoState();
    const answer = summarizeNamespace(DEMO_DEFAULT_NAMESPACE, snapshot.resources, chains);
    expect(answer.diagnosis.join(" ")).toMatch(/Failing:/);
    expect(answer.diagnosis.join(" ")).toMatch(/problem chains identified/);
    expect(answer.chains.length).toBeGreaterThan(0);
    expect(answer.checks[0]).toContain("kubectl get all -n");
  });

  it("explains a pending pod via its chain rather than the pod itself", async () => {
    const { snapshot, chains } = await demoState();
    const pod = snapshot.resources.find((r) => r.name === "reports-6f9d7c5b44-x8j2p")!;
    const podChains = chains.filter(
      (c) => c.affected.uid === pod.uid || c.chain.some((l) => l.uid === pod.uid),
    );
    const answer = explainResource(pod, [], podChains);
    expect(answer.diagnosis.join(" ")).toContain('"Pending"');
    expect(answer.diagnosis.join(" ")).toMatch(/root cause is likely elsewhere/);
    expect(answer.chains[0].rootCause).toContain("fast-ssd");
  });

  it("reports healthy resources without inventing problems", async () => {
    const { snapshot, chains } = await demoState();
    const healthy = snapshot.resources.find((r) => r.name === "storefront" && r.kind === "Deployment")!;
    const own = chains.filter((c) => c.affected.uid === healthy.uid || c.chain.some((l) => l.uid === healthy.uid));
    const answer = explainResource(healthy, [], own);
    expect(answer.diagnosis.join(" ")).toMatch(/No problems detected/);
  });

  it("builds a sanitized share payload with evidence and safety framing", async () => {
    const { snapshot, chains } = await demoState();
    const pod = snapshot.resources.find((r) => r.name === "reports-6f9d7c5b44-x8j2p")!;
    const podChains = chains.filter((c) => c.chain.some((l) => l.uid === pod.uid));
    const payload = buildSharePayload({
      cluster: { context: "demo-cluster", server: "demo", version: "v1.33.2" },
      mode: "demo",
      namespace: DEMO_DEFAULT_NAMESPACE,
      answer: explainResource(pod, [], podChains),
      resource: pod,
    });
    expect(payload).toContain("sanitized - no secret values");
    expect(payload).toContain("likely root cause");
    expect(payload).toContain("Do not run anything cluster-changing without asking");
    // annotations must never leak into payloads
    expect(payload).not.toContain("SHOULD-NEVER-APPEAR");
  });
});
