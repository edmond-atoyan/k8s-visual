// The action catalog: which operations exist for each kind, how risky they
// are, what they will change, and the equivalent kubectl command. The UI
// never mutates the cluster outside of this catalog + the confirmation modal.

import type { Action, ResourceSummary } from "./types";

export type Risk = "low" | "medium" | "high" | "danger";

// --- kubectl context pinning -------------------------------------------------
// Every kubectl string the app shows carries an explicit `--context` for the
// cluster the app is connected to. Without it, a copied command runs against
// the kubeconfig current-context - which may be a different cluster than the
// one the UI confirmed.

let kubectlContext: string | null = null;

/** Set by the app on connect/disconnect. Demo mode passes null (no context). */
export function setKubectlContext(context: string | null): void {
  kubectlContext = context;
}

/** Quote a shell argument only when it needs it, to keep hints readable. */
function shellArg(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function ctx(): string {
  return kubectlContext ? ` --context ${shellArg(kubectlContext)}` : "";
}

export const RISK_LABEL: Record<Risk, string> = {
  low: "Low risk",
  medium: "Medium risk",
  high: "High risk",
  danger: "Danger",
};

export interface ActionInput {
  name: string;
  label: string;
  type: "number";
  initial: number;
  min?: number;
  max?: number;
}

export interface ActionDescriptor {
  id: string;
  label: string;
  risk: Risk;
  /** RBAC check that must pass for this action (live mode). */
  verb: string;
  resource: string;
  group?: string;
  /** What will change, shown in the confirmation. */
  describe(r: ResourceSummary, input: Record<string, number>): string;
  kubectl(r: ResourceSummary, input: Record<string, number>): string;
  build(r: ResourceSummary, input: Record<string, number>): Action;
  inputs?: (r: ResourceSummary) => ActionInput[];
  /** Danger actions additionally require typing the resource name. */
  confirmName?: boolean;
}

function currentReplicas(r: ResourceSummary): number {
  const m = /(\d+)\s*desired/.exec(r.details.Replicas ?? "");
  return m ? Number(m[1]) : 1;
}

const PLURAL: Record<string, { resource: string; group?: string; short: string }> = {
  Pod: { resource: "pods", short: "pod" },
  Deployment: { resource: "deployments", group: "apps", short: "deployment" },
  ReplicaSet: { resource: "replicasets", group: "apps", short: "rs" },
  StatefulSet: { resource: "statefulsets", group: "apps", short: "statefulset" },
  DaemonSet: { resource: "daemonsets", group: "apps", short: "daemonset" },
  Job: { resource: "jobs", group: "batch", short: "job" },
  CronJob: { resource: "cronjobs", group: "batch", short: "cronjob" },
  Service: { resource: "services", short: "svc" },
  Ingress: { resource: "ingresses", group: "networking.k8s.io", short: "ingress" },
  ConfigMap: { resource: "configmaps", short: "configmap" },
  Secret: { resource: "secrets", short: "secret" },
  PersistentVolumeClaim: { resource: "persistentvolumeclaims", short: "pvc" },
  PersistentVolume: { resource: "persistentvolumes", short: "pv" },
  StorageClass: { resource: "storageclasses", group: "storage.k8s.io", short: "storageclass" },
  HorizontalPodAutoscaler: { resource: "horizontalpodautoscalers", group: "autoscaling", short: "hpa" },
  NetworkPolicy: { resource: "networkpolicies", group: "networking.k8s.io", short: "netpol" },
  Node: { resource: "nodes", short: "node" },
};

/** Risk of deleting a given kind: some deletions are much worse than others. */
function deleteRisk(kind: string): Risk {
  if (kind === "Pod") return "medium"; // a controller usually replaces it
  if (kind === "Secret" || kind === "PersistentVolumeClaim" || kind === "PersistentVolume")
    return "danger"; // credentials / data loss
  return "high";
}

function deleteDescription(r: ResourceSummary): string {
  if (r.kind === "Pod" && r.owners.length > 0) {
    return `Pod "${r.name}" will be terminated. It is owned by ${r.owners[0].kind} "${r.owners[0].name}", which will immediately create a replacement Pod.`;
  }
  if (r.kind === "Pod") {
    return `Pod "${r.name}" will be terminated. It has no owner, so nothing will recreate it.`;
  }
  if (r.kind === "Deployment" || r.kind === "StatefulSet" || r.kind === "DaemonSet") {
    return `${r.kind} "${r.name}" and every ReplicaSet/Pod it owns will be deleted. The workload stops serving.`;
  }
  if (r.kind === "Secret") {
    return `Secret "${r.name}" will be permanently deleted. Pods that mount it will fail to start next time they are created.`;
  }
  if (r.kind === "PersistentVolumeClaim") {
    return `PVC "${r.name}" will be deleted. Depending on the reclaim policy, the underlying data may be permanently lost. Check for Pods currently mounting it.`;
  }
  if (r.kind === "Service") {
    return `Service "${r.name}" will be deleted - its stable virtual IP disappears and traffic through it stops immediately.`;
  }
  return `${r.kind} "${r.name}" will be permanently deleted.`;
}

export function actionsFor(r: ResourceSummary): ActionDescriptor[] {
  const p = PLURAL[r.kind] ?? { resource: r.kind.toLowerCase() + "s", short: r.kind.toLowerCase() };
  const ns = ` -n ${r.namespace}`;
  const out: ActionDescriptor[] = [];

  if (r.kind === "Deployment" || r.kind === "StatefulSet" || r.kind === "ReplicaSet") {
    out.push({
      id: "scale",
      label: "Scale…",
      risk: "medium",
      verb: "patch",
      resource: p.resource,
      group: p.group,
      inputs: (res) => [
        { name: "replicas", label: "Replicas", type: "number", initial: currentReplicas(res), min: 0, max: 50 },
      ],
      describe: (res, input) =>
        `${res.kind} "${res.name}" changes from ${currentReplicas(res)} to ${input.replicas} desired replica(s). Kubernetes will start or stop Pods to match.`,
      kubectl: (res, input) => `kubectl scale ${p.short}/${res.name} --replicas=${input.replicas}${ns}${ctx()}`,
      build: (res, input) => ({
        type: "scaleWorkload",
        kind: res.kind,
        namespace: res.namespace,
        name: res.name,
        replicas: input.replicas,
      }),
    });
  }

  if (r.kind === "Deployment" || r.kind === "StatefulSet" || r.kind === "DaemonSet") {
    out.push({
      id: "restart",
      label: "Rollout restart",
      risk: "medium",
      verb: "patch",
      resource: p.resource,
      group: p.group,
      describe: (res) =>
        `Every Pod of ${res.kind} "${res.name}" is replaced with a fresh one, one batch at a time (rolling). Brief capacity reduction is possible.`,
      kubectl: (res) => `kubectl rollout restart ${p.short}/${res.name}${ns}${ctx()}`,
      build: (res) => ({ type: "restartRollout", kind: res.kind, namespace: res.namespace, name: res.name }),
    });
  }

  if (r.kind === "Deployment") {
    out.push({
      id: "rollback",
      label: "Rollback to previous revision",
      risk: "high",
      verb: "patch",
      resource: p.resource,
      group: p.group,
      describe: (res) =>
        `Deployment "${res.name}" gets the Pod template of its previous revision back (previous image, env, config). A new rollout starts immediately.`,
      kubectl: (res) => `kubectl rollout undo deployment/${res.name}${ns}${ctx()}`,
      build: (res) => ({ type: "rollbackDeployment", namespace: res.namespace, name: res.name }),
    });
    const paused = r.details.Rollout === "Paused" || r.status.includes("paused");
    out.push({
      id: "pause",
      label: paused ? "Resume rollout" : "Pause rollout",
      risk: "medium",
      verb: "patch",
      resource: p.resource,
      group: p.group,
      describe: (res) =>
        paused
          ? `Deployment "${res.name}" resumes rolling out template changes.`
          : `Deployment "${res.name}" stops rolling out template changes until resumed. Running Pods keep running.`,
      kubectl: (res) => `kubectl rollout ${paused ? "resume" : "pause"} deployment/${res.name}${ns}${ctx()}`,
      build: (res) => ({ type: "pauseRollout", namespace: res.namespace, name: res.name, pause: !paused }),
    });
  }

  if (r.kind === "CronJob") {
    const suspended = r.status === "Suspended";
    out.push({
      id: "suspend",
      label: suspended ? "Resume schedule" : "Suspend schedule",
      risk: "medium",
      verb: "patch",
      resource: p.resource,
      group: p.group,
      describe: (res) =>
        suspended
          ? `CronJob "${res.name}" starts creating Jobs on its schedule (${res.details.Schedule ?? "?"}) again.`
          : `CronJob "${res.name}" stops creating new Jobs until resumed. Running Jobs are not affected.`,
      kubectl: (res) =>
        `kubectl patch cronjob/${res.name} -p '{"spec":{"suspend":${!suspended}}}'${ns}${ctx()}`,
      build: (res) => ({ type: "suspendCronJob", namespace: res.namespace, name: res.name, suspend: !suspended }),
    });
    out.push({
      id: "trigger",
      label: "Run now (create Job)",
      risk: "medium",
      verb: "create",
      resource: "jobs",
      group: "batch",
      describe: (res) => `A new Job is created immediately from the template of CronJob "${res.name}", outside its normal schedule.`,
      kubectl: (res) => `kubectl create job --from=cronjob/${res.name} ${res.name}-manual${ns}${ctx()}`,
      build: (res) => ({ type: "triggerCronJob", namespace: res.namespace, name: res.name }),
    });
  }

  if (r.kind === "Node") {
    const cordoned = r.details.Unschedulable === "true";
    out.push({
      id: "cordon",
      label: cordoned ? "Uncordon node" : "Cordon node",
      risk: "high",
      verb: "patch",
      resource: "nodes",
      describe: (res) =>
        cordoned
          ? `Node "${res.name}" becomes schedulable again - new Pods may be placed on it.`
          : `Node "${res.name}" is marked unschedulable. Running Pods keep running, but no new Pods will be scheduled here until you uncordon. (Draining/evicting is not offered yet.)`,
      kubectl: (res) => `kubectl ${cordoned ? "uncordon" : "cordon"} ${res.name}${ctx()}`,
      build: (res) => ({ type: "cordonNode", name: res.name, cordon: !cordoned }),
    });
  }

  // Deletion exists for everything namespaced except cluster-scoped kinds.
  if (r.kind !== "PersistentVolume" && r.kind !== "StorageClass" && r.kind !== "Node" && !r.uid.startsWith("missing:")) {
    const risk = deleteRisk(r.kind);
    out.push({
      id: "delete",
      label: `Delete ${r.kind}`,
      risk,
      verb: "delete",
      resource: p.resource,
      group: p.group,
      confirmName: risk === "danger",
      describe: deleteDescription,
      kubectl: (res) => `kubectl delete ${p.short}/${res.name}${ns}${ctx()}`,
      build: (res) => ({ type: "deleteResource", kind: res.kind, namespace: res.namespace, name: res.name }),
    });
  }

  return out;
}

/** kubectl intent strings for the non-catalog operations. */
export const KUBECTL_INTENT = {
  logs: (ns: string, pod: string, container?: string, opts?: { follow?: boolean; previous?: boolean }) =>
    `kubectl logs ${pod}${container ? ` -c ${container}` : ""}${opts?.follow ? " -f" : ""}${opts?.previous ? " --previous" : ""} -n ${ns}${ctx()}`,
  exec: (ns: string, pod: string, container: string | undefined, cmd: string) =>
    `kubectl exec ${pod}${container ? ` -c ${container}` : ""} -n ${ns}${ctx()} -- ${cmd}`,
  portForward: (ns: string, kind: string, name: string, local: number, remote: number) =>
    `kubectl port-forward ${kind === "Service" ? "svc/" : "pod/"}${name} ${local}:${remote} -n ${ns}${ctx()}`,
  apply: (dryRun: boolean) => `kubectl apply -f - --server-side${dryRun ? " --dry-run=server" : ""}${ctx()}`,
  top: (ns: string) => `kubectl top pods -n ${ns}${ctx()}`,
  events: (ns: string) => `kubectl get events -n ${ns}${ctx()} --sort-by=.lastTimestamp`,
  describe: (ns: string, kind: string, name: string) => `kubectl describe ${kind.toLowerCase()}/${name} -n ${ns}${ctx()}`,
  getYaml: (ns: string, kind: string, name: string) => `kubectl get ${kind.toLowerCase()}/${name} -n ${ns}${ctx()} -o yaml`,
};
