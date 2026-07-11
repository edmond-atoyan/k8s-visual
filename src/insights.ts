// Metrics insights: deterministic findings derived from live usage,
// requests/limits, and pod state. Same philosophy as the chain engine -
// every insight is traceable to data the app actually has, and states that
// are unknowable (Pending pods, missing Metrics API) are explained rather
// than shown as zeros.

import type { ProblemChain } from "./chains";
import type { MetricsSnapshot, ResourceSummary } from "./types";

export interface MetricInsight {
  severity: "critical" | "warning" | "info";
  title: string;
  detail: string;
  checks?: string[];
}

/** "250m" -> 250, "1" -> 1000, "1.5" -> 1500 millicores. */
export function parseCpu(q: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(m?)$/.exec(q.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === "m" ? n : n * 1000;
}

/** "128Mi", "1Gi", "500M", "1024Ki" -> bytes. */
export function parseMem(q: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|K|M|G|T)?$/.exec(q.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] ?? "";
  const bin: Record<string, number> = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40 };
  const dec: Record<string, number> = { K: 1e3, M: 1e6, G: 1e9, T: 1e12 };
  return n * (bin[unit] ?? dec[unit] ?? 1);
}

const ord = { critical: 0, warning: 1, info: 2 } as const;

export function computeMetricsInsights(opts: {
  namespace: string;
  resources: ResourceSummary[];
  metrics: MetricsSnapshot | null;
  nodeCapacity: Map<string, { cpuMillis: number; memBytes: number }>;
  chains: ProblemChain[];
}): MetricInsight[] {
  const { namespace: ns, resources, metrics, nodeCapacity, chains } = opts;
  const out: MetricInsight[] = [];
  const pods = resources.filter((r) => r.kind === "Pod");
  const byUid = new Map(resources.map((r) => [r.uid, r]));
  const rootOf = (r: ResourceSummary): ResourceSummary => {
    let cur = r;
    const seen = new Set([r.uid]);
    while (cur.owners.length > 0) {
      const o = byUid.get(cur.owners[0].uid);
      if (!o || seen.has(o.uid)) break;
      seen.add(o.uid);
      cur = o;
    }
    return cur;
  };
  const podMetrics = new Map((metrics?.pods ?? []).map((p) => [p.name, p]));

  // Pending pods: explain, never show 0.
  for (const pod of pods.filter((p) => p.status === "Pending")) {
    const pvcChain = chains.find(
      (c) => c.id.startsWith("pvc:") && c.chain.some((l) => l.uid === pod.uid),
    );
    out.push({
      severity: "warning",
      title: `${pod.name} is Pending - metrics are unavailable`,
      detail: pvcChain
        ? `Metrics are unavailable because the Pod is not running. Root cause may be the unbound PersistentVolumeClaim (${pvcChain.chain.find((l) => l.kind === "PersistentVolumeClaim")?.name ?? "see Events"}) - see Events → Problems.`
        : "Metrics are unavailable because the Pod is not running. Check Events for the scheduling reason.",
      checks: [`kubectl describe pod ${pod.name} -n ${ns}`, `kubectl get events -n ${ns}`],
    });
  }

  if (metrics?.available) {
    // Missing requests/limits, grouped per workload.
    const noRequests = new Map<string, ResourceSummary>();
    for (const pod of pods) {
      if (pod.status !== "Running") continue;
      const cs = pod.containers ?? [];
      if (cs.length > 0 && cs.every((c) => !c.cpuRequest && !c.memoryRequest)) {
        const root = rootOf(pod);
        noRequests.set(root.uid, root);
      }
    }
    for (const root of noRequests.values()) {
      out.push({
        severity: "warning",
        title: `${root.kind}/${root.name}: containers set no resource requests`,
        detail:
          "Without requests the scheduler places these Pods blind, HPAs cannot compute utilization, and the Pods are first in line for eviction under node pressure.",
        checks: [`kubectl get ${root.kind.toLowerCase()} ${root.name} -n ${ns} -o yaml | grep -A4 resources:`],
      });
    }

    for (const pod of pods) {
      const usage = podMetrics.get(pod.name);
      if (!usage) continue;
      // The Metrics API usage here is per Pod, so it must be compared against
      // the Pod's summed limits/requests - comparing the Pod total against
      // each individual container would fabricate findings for multi-container
      // Pods. Sums are only meaningful when every container declares a value.
      const cs = pod.containers ?? [];
      const memLimits = cs.map((c) => (c.memoryLimit ? parseMem(c.memoryLimit) : null));
      const memLimit =
        memLimits.length > 0 && memLimits.every((l) => l !== null)
          ? memLimits.reduce((a, b) => a! + b!, 0)
          : null;
      // Memory close to the limit -> OOMKill risk.
      if (memLimit && usage.memoryBytes / memLimit > 0.85) {
        const label = cs.length === 1 ? `its ${cs[0].memoryLimit} limit` : `the combined limit of its ${cs.length} containers`;
        out.push({
          severity: "critical",
          title: `${pod.name}: memory at ${Math.round((usage.memoryBytes / memLimit) * 100)}% of its limit`,
          detail: `The Pod is close to ${label} - the next spike gets a container OOM-killed.`,
          checks: [`kubectl top pod ${pod.name} -n ${ns}`, `kubectl describe pod ${pod.name} -n ${ns} | grep -A3 Limits`],
        });
      }
      // CPU request far above real usage -> wasted reservations.
      const cpuRequests = cs.map((c) => (c.cpuRequest ? parseCpu(c.cpuRequest) : null));
      const cpuRequest =
        cpuRequests.length > 0 && cpuRequests.every((r) => r !== null)
          ? cpuRequests.reduce((a, b) => a! + b!, 0)
          : null;
      if (cpuRequest && cpuRequest >= 250 && usage.cpuMillis > 0 && cpuRequest >= usage.cpuMillis * 4) {
        const requested = cs.length === 1 ? cs[0].cpuRequest : `${cpuRequest}m total`;
        out.push({
          severity: "info",
          title: `${pod.name}: CPU request ${requested} vs ~${usage.cpuMillis}m actually used`,
          detail: `The reservation is ${Math.round(cpuRequest / usage.cpuMillis)}x real usage - it blocks scheduling capacity other Pods could use.`,
          checks: [`kubectl top pod ${pod.name} -n ${ns}`],
        });
      }
    }

    // One replica much hungrier than its siblings.
    const groups = new Map<string, { root: ResourceSummary; mems: { name: string; mem: number }[] }>();
    for (const pod of pods) {
      const usage = podMetrics.get(pod.name);
      if (!usage || pod.owners.length === 0) continue;
      const root = rootOf(pod);
      const g = groups.get(root.uid) ?? { root, mems: [] };
      g.mems.push({ name: pod.name, mem: usage.memoryBytes });
      groups.set(root.uid, g);
    }
    for (const { root, mems } of groups.values()) {
      if (mems.length < 3) continue;
      const sorted = [...mems].sort((a, b) => a.mem - b.mem);
      const median = sorted[Math.floor(sorted.length / 2)].mem;
      const top = sorted[sorted.length - 1];
      if (median > 0 && top.mem > median * 2.5) {
        out.push({
          severity: "warning",
          title: `${root.kind}/${root.name}: replica ${top.name} uses ${(top.mem / median).toFixed(1)}x the median memory`,
          detail: "One replica diverging from its siblings usually means a leak, a hot shard, or skewed traffic.",
          checks: [`kubectl top pods -n ${ns} --sort-by=memory`],
        });
      }
    }

    // Node memory pressure risk.
    for (const node of metrics.nodes) {
      const cap = nodeCapacity.get(node.name);
      if (cap && cap.memBytes > 0 && node.memoryBytes / cap.memBytes > 0.85) {
        out.push({
          severity: "warning",
          title: `Node ${node.name}: memory at ${Math.round((node.memoryBytes / cap.memBytes) * 100)}% of capacity`,
          detail: "Above ~85% the kubelet starts evicting Pods (MemoryPressure). Consider rescheduling or adding capacity.",
          checks: [`kubectl top nodes`, `kubectl describe node ${node.name} | grep -A6 Conditions`],
        });
      }
    }

    // Many replicas doing nearly nothing.
    for (const { root, mems } of groups.values()) {
      if (mems.length < 3) continue;
      const totalCpu = mems.reduce((n, m) => n + (podMetrics.get(m.name)?.cpuMillis ?? 0), 0);
      if (totalCpu < 30) {
        out.push({
          severity: "info",
          title: `${root.kind}/${root.name}: ${mems.length} replicas using ~${totalCpu}m CPU combined`,
          detail: "That is close to idle - fewer replicas would serve the same load unless you are holding capacity for spikes.",
          checks: [`kubectl top pods -n ${ns}`],
        });
      }
    }
  }

  return out.sort((a, b) => ord[a.severity] - ord[b.severity]);
}
