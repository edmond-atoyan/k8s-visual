// The problem-chain engine: turns raw cluster state (resource summaries +
// events) into causal explanations - what is broken, the ownership/reference
// path it sits on, the likely root cause, and the kubectl commands that
// verify it. Pure and deterministic: every statement is derived from data
// the app actually has; nothing is invented. This is also the evidence base
// for the built-in assistant.

import { selectorMatches } from "./graph/build";
import type { EventInfo, Kind, ResourceSummary } from "./types";

export interface ChainLink {
  kind: string;
  name: string;
  /** Short state note shown under the node ("Pending", "wants 2 replicas"). */
  note: string;
  /** Present when the node exists in the snapshot (clickable). */
  uid?: string;
}

export interface ProblemChain {
  id: string;
  severity: "critical" | "warning";
  title: string;
  affected: { kind: Kind; name: string; uid: string };
  /** Cause path, root first: Deployment → ReplicaSet → Pod → PVC → StorageClass. */
  chain: ChainLink[];
  rootCause: string;
  whyItMatters: string;
  /** kubectl commands that verify the diagnosis. */
  checks: string[];
  /** Quoted evidence from live state / events. */
  evidence: string[];
  /** Pods showing the same symptom (merged replicas). */
  pods: string[];
}

const q = (s: string) => s.trim();

export function buildProblemChains(resources: ResourceSummary[], events: EventInfo[] = []): ProblemChain[] {
  const byUid = new Map(resources.map((r) => [r.uid, r]));
  const ns = resources.find((r) => r.namespace)?.namespace ?? "default";
  const merged = new Map<string, ProblemChain>();

  const ancestry = (r: ResourceSummary): ResourceSummary[] => {
    const path = [r];
    const seen = new Set([r.uid]);
    let cur = r;
    while (cur.owners.length > 0) {
      const o = byUid.get(cur.owners[0].uid);
      if (!o || seen.has(o.uid)) break;
      path.unshift(o);
      seen.add(o.uid);
      cur = o;
    }
    return path;
  };

  // Match kind AND name: a Pod and a PVC/Service sharing a name must not
  // contaminate one another's evidence.
  const eventsFor = (kind: string, name: string) =>
    events.filter((e) => e.involvedKind === kind && e.involvedName === name);

  const ancestryLinks = (pod: ResourceSummary, symptom: string): ChainLink[] =>
    ancestry(pod).map((r) => ({
      kind: r.kind,
      name: r.name,
      uid: r.uid,
      note: r.uid === pod.uid ? symptom : r.status,
    }));

  const add = (key: string, make: () => Omit<ProblemChain, "id" | "pods">, podName?: string) => {
    const existing = merged.get(key);
    if (existing) {
      if (podName && !existing.pods.includes(podName)) existing.pods.push(podName);
      return;
    }
    merged.set(key, { ...make(), id: key, pods: podName ? [podName] : [] });
  };

  for (const r of resources) {
    if (r.kind !== "Pod") continue;
    const root = ancestry(r)[0];
    const podEvents = eventsFor("Pod", r.name);
    const states = (r.containers ?? [])
      .map((c) => `${c.state}${c.lastState ? ` ${c.lastState}` : ""}`)
      .join(" ");
    const signal = `${r.status} ${states}`;

    if (/CrashLoopBackOff/i.test(signal)) {
      const restarts = (r.containers ?? []).reduce((n, c) => n + c.restarts, 0);
      add(
        `crash:${root.uid}`,
        () => ({
          severity: "critical",
          title: "Pod crash-looping (CrashLoopBackOff)",
          affected: { kind: r.kind, name: r.name, uid: r.uid },
          chain: ancestryLinks(r, "CrashLoopBackOff"),
          rootCause:
            "The container starts, exits with an error, and is restarted with growing back-off - usually a startup crash: bad config, missing dependency, or a failing connection.",
          whyItMatters: `The workload runs below its desired replicas while the container keeps dying (${restarts} restarts so far).`,
          checks: [
            `kubectl logs ${r.name} -n ${ns} --previous`,
            `kubectl describe pod ${r.name} -n ${ns}`,
            `kubectl get events -n ${ns} --field-selector involvedObject.name=${r.name}`,
          ],
          evidence: [
            ...(r.containers ?? []).filter((c) => c.lastState).map((c) => q(`container ${c.name}: last state ${c.lastState}`)),
            ...podEvents.filter((e) => e.type === "Warning").slice(0, 2).map((e) => q(e.message)),
          ],
        }),
        r.name,
      );
    }

    if (/ImagePullBackOff|ErrImagePull/i.test(signal)) {
      const image = r.containers?.[0]?.image ?? "";
      add(
        `image:${root.uid}:${image}`,
        () => ({
          severity: "critical",
          title: "Image cannot be pulled (ImagePullBackOff)",
          affected: { kind: r.kind, name: r.name, uid: r.uid },
          chain: ancestryLinks(r, "ImagePullBackOff"),
          rootCause: `The node cannot pull "${image}" - typically a typo in the image name or tag, or missing registry credentials (imagePullSecrets).`,
          whyItMatters: "The Pod can never start until the image resolves; the rollout is stuck.",
          checks: [
            `kubectl describe pod ${r.name} -n ${ns}`,
            `kubectl get events -n ${ns} --field-selector involvedObject.name=${r.name}`,
            `kubectl get secrets -n ${ns} --field-selector type=kubernetes.io/dockerconfigjson`,
          ],
          evidence: podEvents
            .filter((e) => e.type === "Warning" && /pull|manifest|image/i.test(e.message))
            .slice(0, 2)
            .map((e) => q(e.message)),
        }),
        r.name,
      );
    }

    if (r.status === "Pending") {
      const pvcName = (r.refs ?? [])
        .find((ref) => ref.startsWith("PersistentVolumeClaim/"))
        ?.split("/")[1];
      const pvc = pvcName
        ? resources.find((x) => x.kind === "PersistentVolumeClaim" && x.name === pvcName)
        : undefined;

      if (pvc && pvc.status === "Pending") {
        const scName = pvc.details["StorageClass"];
        const sc = scName ? resources.find((x) => x.kind === "StorageClass" && x.name === scName) : undefined;
        const pvcEvents = eventsFor("PersistentVolumeClaim", pvc.name);
        add(
          `pvc:${pvc.uid}`,
          () => ({
            severity: "critical",
            title: "Pod Pending - unbound PersistentVolumeClaim",
            affected: { kind: r.kind, name: r.name, uid: r.uid },
            chain: [
              ...ancestryLinks(r, "Pending - waiting for volume"),
              { kind: "PersistentVolumeClaim", name: pvc.name, uid: pvc.uid, note: "Pending - unbound" },
              scName
                ? {
                    kind: "StorageClass",
                    name: scName,
                    uid: sc?.uid,
                    note: sc ? "exists but has not provisioned a volume" : "does not exist",
                  }
                : { kind: "StorageClass", name: "(none set)", note: "no StorageClass and no matching PV" },
            ],
            rootCause: !scName
              ? "The PVC sets no StorageClass and no existing PersistentVolume matches it, so it can never bind."
              : sc
                ? `The provisioner behind StorageClass "${scName}" has not satisfied the claim - check the provisioner and the claim's requested size/access mode.`
                : `StorageClass "${scName}" does not exist in this cluster, so nothing can provision the volume.`,
            whyItMatters:
              "The scheduler will not place the Pod until its volume binds - the workload stays below desired replicas indefinitely.",
            checks: [
              `kubectl get pvc -n ${ns}`,
              `kubectl describe pvc ${pvc.name} -n ${ns}`,
              `kubectl get storageclass`,
            ],
            evidence: [
              ...pvcEvents.slice(0, 2).map((e) => q(e.message)),
              ...podEvents
                .filter((e) => /unbound|PersistentVolumeClaim/i.test(e.message))
                .slice(0, 1)
                .map((e) => q(e.message)),
            ],
          }),
          r.name,
        );
      } else {
        const sched = podEvents.find((e) => e.reason === "FailedScheduling");
        add(
          `sched:${root.uid}`,
          () => ({
            severity: "warning",
            title: "Pod Pending - cannot be scheduled",
            affected: { kind: r.kind, name: r.name, uid: r.uid },
            chain: [
              ...ancestryLinks(r, "Pending"),
              {
                kind: "Scheduler",
                name: "kube-scheduler",
                note: sched ? "no fitting node" : "not yet placed",
              },
            ],
            rootCause: sched
              ? /Insufficient (memory|cpu)/i.test(sched.message)
                ? "No node has enough free resources for the Pod's requests."
                : `The scheduler cannot place the Pod: ${q(sched.message)}`
              : "The Pod has not been scheduled yet - check Events for the scheduler's reason.",
            whyItMatters: "A Pending Pod runs nothing: no logs, no metrics, no traffic.",
            checks: [
              `kubectl describe pod ${r.name} -n ${ns}`,
              `kubectl top nodes`,
              `kubectl describe nodes | grep -A 6 "Allocated resources"`,
            ],
            evidence: sched ? [q(sched.message)] : [],
          }),
          r.name,
        );
      }
    }
  }

  // Services whose selector matches no Pods (traffic goes nowhere).
  for (const svc of resources) {
    if (svc.kind !== "Service" || !svc.selector) continue;
    const matching = resources.filter((p) => p.kind === "Pod" && selectorMatches(svc.selector!, p.labels));
    if (matching.length > 0) continue;
    const selector = Object.entries(svc.selector)
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
    add(`svc:${svc.uid}`, () => ({
      severity: "warning",
      title: "Service has no matching Pods",
      affected: { kind: svc.kind, name: svc.name, uid: svc.uid },
      chain: [
        { kind: "Service", name: svc.name, uid: svc.uid, note: "no endpoints" },
        { kind: "selector", name: selector, note: "matches 0 Pods" },
      ],
      rootCause:
        "The Service's label selector matches no Pods - either the workload is gone/scaled to zero, or the labels drifted apart.",
      whyItMatters: "Traffic to this Service (and any Ingress routing to it) has nowhere to go.",
      checks: [
        `kubectl get endpoints ${svc.name} -n ${ns}`,
        `kubectl get pods -n ${ns} -l ${selector}`,
        `kubectl describe service ${svc.name} -n ${ns}`,
      ],
      evidence: [],
    }));
  }

  // HPAs that cannot read metrics (from events).
  for (const e of events) {
    if (!/FailedGetResourceMetric|FailedComputeMetricsReplicas/i.test(e.reason)) continue;
    if (e.involvedKind !== "HorizontalPodAutoscaler") continue;
    const hpa = resources.find((x) => x.kind === "HorizontalPodAutoscaler" && x.name === e.involvedName);
    if (!hpa) continue;
    add(`hpa:${hpa.uid}`, () => ({
      severity: "warning",
      title: "HPA cannot read metrics",
      affected: { kind: hpa.kind, name: hpa.name, uid: hpa.uid },
      chain: [
        { kind: "HorizontalPodAutoscaler", name: hpa.name, uid: hpa.uid, note: "cannot compute replicas" },
        { kind: "Metrics API", name: "metrics.k8s.io", note: "unavailable or empty" },
      ],
      rootCause:
        "The autoscaler cannot fetch resource metrics - metrics-server is missing/unhealthy, or the Pods set no resource requests.",
      whyItMatters: "Autoscaling is effectively off: the workload stays at its current replica count.",
      checks: [
        `kubectl describe hpa ${hpa.name} -n ${ns}`,
        `kubectl top pods -n ${ns}`,
        `kubectl get apiservices | grep metrics`,
      ],
      evidence: [q(e.message)],
    }));
  }

  // Merge titles for replica groups, order by severity.
  const out = [...merged.values()].map((c) => ({
    ...c,
    title: c.pods.length > 1 ? c.title.replace(/^Pod/, `${c.pods.length} Pods`) : c.title,
  }));
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "critical" ? -1 : 1));
}
