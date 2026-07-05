// The educational layer: what each Kubernetes kind is, where it sits in the
// hierarchy, what usually goes wrong with it, and where to read more. Kinds
// are grouped, and each group has a fixed categorical accent (identity is
// also always carried by the text badge, never by color alone).

import type { Kind } from "./types";

export type KindGroup = "Workloads" | "Networking" | "Config & Storage" | "Cluster";

export interface KindMeta {
  group: KindGroup;
  /** Short badge text shown on graph nodes, e.g. "deploy". */
  badge: string;
  /** One-sentence explanation for newcomers. */
  what: string;
  /** Where this kind sits in the hierarchy - the app's core lesson. */
  hierarchy: string;
  /** What typically goes wrong - for the debugging helpers. */
  problems: string;
  docs: string;
}

const K8S_DOCS = "https://kubernetes.io/docs/concepts";

export const KIND_INFO: Record<Kind, KindMeta> = {
  Pod: {
    group: "Workloads",
    badge: "pod",
    what: "The smallest deployable unit: one or more containers that share network and storage.",
    hierarchy:
      "Almost never created by hand - a controller (ReplicaSet, Job, DaemonSet, StatefulSet) creates and replaces Pods for you.",
    problems:
      "CrashLoopBackOff (app exits and restarts), ImagePullBackOff (image name/registry auth), Pending (no node fits its requests). Check the Status tab, events, and logs.",
    docs: `${K8S_DOCS}/workloads/pods/`,
  },
  Deployment: {
    group: "Workloads",
    badge: "deploy",
    what: "Declares the desired state for stateless apps: which image, how many replicas, how to roll out updates.",
    hierarchy:
      "Creates a ReplicaSet per revision; the ReplicaSet then creates the Pods. Old ReplicaSets are kept (scaled to 0) so you can roll back.",
    problems:
      "Fewer ready than desired usually means its Pods are failing - follow the owns-edges down to the Pods. A stuck rollout often means the new revision can't become ready.",
    docs: `${K8S_DOCS}/workloads/controllers/deployment/`,
  },
  ReplicaSet: {
    group: "Workloads",
    badge: "rs",
    what: "Keeps a fixed number of identical Pods running at all times.",
    hierarchy:
      "Usually owned by a Deployment - you rarely touch it directly. It owns the Pods below it.",
    problems:
      "A ReplicaSet at 0/0 is normally just an old revision kept for rollback, not an error.",
    docs: `${K8S_DOCS}/workloads/controllers/replicaset/`,
  },
  StatefulSet: {
    group: "Workloads",
    badge: "sts",
    what: "Runs stateful apps (databases, queues) with stable names, stable storage, and ordered startup.",
    hierarchy:
      "Creates Pods directly with sticky identities (name-0, name-1, ...), each usually bound to its own PersistentVolumeClaim.",
    problems:
      "Pods stuck Pending often mean their PVC can't bind. Scaling down does not delete PVCs - data is kept on purpose.",
    docs: `${K8S_DOCS}/workloads/controllers/statefulset/`,
  },
  DaemonSet: {
    group: "Workloads",
    badge: "ds",
    what: "Runs exactly one copy of a Pod on every node (log collectors, monitoring agents, CNI).",
    hierarchy: "Creates one Pod per cluster node directly; new nodes get the Pod automatically.",
    problems:
      "Fewer scheduled than nodes usually means taints or node selectors exclude some nodes.",
    docs: `${K8S_DOCS}/workloads/controllers/daemonset/`,
  },
  Job: {
    group: "Workloads",
    badge: "job",
    what: "Runs Pods until a task completes successfully, retrying on failure.",
    hierarchy: "Owns the Pods it starts; often owned by a CronJob when it runs on a schedule.",
    problems:
      "A Failed Job hit its retry limit (backoffLimit) - read the last Pod's logs to see why it kept failing.",
    docs: `${K8S_DOCS}/workloads/controllers/job/`,
  },
  CronJob: {
    group: "Workloads",
    badge: "cron",
    what: "Runs Jobs on a schedule, like crontab for the cluster.",
    hierarchy: "Creates a new Job for every scheduled run; each Job then creates its Pods.",
    problems:
      "If nothing runs, check whether it is suspended and whether the previous Job is still running (concurrencyPolicy).",
    docs: `${K8S_DOCS}/workloads/controllers/cron-jobs/`,
  },
  Service: {
    group: "Networking",
    badge: "svc",
    what: "A stable name and virtual IP in front of a changing set of Pods.",
    hierarchy:
      "Matches Pods by label selector (dashed line in the graph) - it load-balances across whatever Pods currently match.",
    problems:
      "“No endpoints” means the selector matches no ready Pods: labels don't match, Pods aren't ready, or the workload is scaled to 0. Also check targetPort vs containerPort.",
    docs: `${K8S_DOCS}/services-networking/service/`,
  },
  Ingress: {
    group: "Networking",
    badge: "ing",
    what: "HTTP(S) routing from outside the cluster: hostnames and paths mapped to Services.",
    hierarchy: "Sits in front of Services; an ingress controller turns these rules into a real proxy.",
    problems:
      "404/502s usually trace to a missing backend Service, a Service with no endpoints, or a missing TLS secret - follow the routes-edges to find the break.",
    docs: `${K8S_DOCS}/services-networking/ingress/`,
  },
  ConfigMap: {
    group: "Config & Storage",
    badge: "cm",
    what: "Non-secret configuration as key-value pairs, mounted as files or env vars.",
    hierarchy: "Referenced by Pods (dashed line) - change it and restart the Pods to pick it up.",
    problems:
      "Editing a ConfigMap does not restart Pods that mounted it - they keep the old values until recreated (env vars) or after a delay (mounted files).",
    docs: `${K8S_DOCS}/configuration/configmap/`,
  },
  Secret: {
    group: "Config & Storage",
    badge: "secret",
    what: "Like a ConfigMap but for sensitive values (passwords, tokens, TLS certs).",
    hierarchy:
      "Referenced by Pods (dashed line). K8s Visual shows names and key names by default - values only after an explicit, confirmed reveal.",
    problems:
      "A Pod referencing a missing Secret stays stuck in CreateContainerConfigError. Rotated credentials only reach Pods after they restart.",
    docs: `${K8S_DOCS}/configuration/secret/`,
  },
  PersistentVolumeClaim: {
    group: "Config & Storage",
    badge: "pvc",
    what: "A request for durable storage that survives Pod restarts.",
    hierarchy:
      "Mounted by Pods (dashed line); binds to a PersistentVolume, which a StorageClass provisions.",
    problems:
      "Pending forever usually means no StorageClass can satisfy it (or WaitForFirstConsumer is waiting for a Pod). Deleting a bound PVC can delete the data.",
    docs: `${K8S_DOCS}/storage/persistent-volumes/`,
  },
  PersistentVolume: {
    group: "Config & Storage",
    badge: "pv",
    what: "The actual piece of storage in the cluster (a disk, an NFS export, a local path).",
    hierarchy:
      "Cluster-scoped. A PVC binds to it 1:1; its StorageClass decides how it is provisioned and reclaimed.",
    problems:
      "“Released” means its claim was deleted but the volume (and data) still exists and can't be re-bound without manual cleanup.",
    docs: `${K8S_DOCS}/storage/persistent-volumes/`,
  },
  StorageClass: {
    group: "Config & Storage",
    badge: "sc",
    what: "A recipe for provisioning storage: which provisioner, what parameters, what reclaim policy.",
    hierarchy: "Cluster-scoped. PVCs name a StorageClass; the provisioner creates a PV to match.",
    problems:
      "Reclaim policy Delete removes the underlying data when the PVC goes away - check it before deleting claims.",
    docs: `${K8S_DOCS}/storage/storage-classes/`,
  },
  HorizontalPodAutoscaler: {
    group: "Workloads",
    badge: "hpa",
    what: "Automatically scales a workload's replica count based on metrics (usually CPU).",
    hierarchy: "Points at a Deployment/StatefulSet (scales-edge) and adjusts its replicas between min and max.",
    problems:
      "“Unknown” targets usually mean metrics-server is missing or the Pods have no resource requests to compare against.",
    docs: `${K8S_DOCS}/workloads/autoscaling/`,
  },
  NetworkPolicy: {
    group: "Networking",
    badge: "netpol",
    what: "A firewall rule for Pods: which traffic may reach (or leave) the Pods it selects.",
    hierarchy:
      "Selects Pods by label (protects-edge). Once any policy selects a Pod, everything not explicitly allowed is denied.",
    problems:
      "Only enforced if the CNI supports it. “Connection refused” after adding a policy usually means you forgot to allow an existing legitimate path.",
    docs: `${K8S_DOCS}/services-networking/network-policies/`,
  },
  Node: {
    group: "Cluster",
    badge: "node",
    what: "A machine (VM or physical) in the cluster that runs Pods via the kubelet.",
    hierarchy:
      "The scheduler places Pods onto Nodes based on resources, selectors, affinity and taints. Nodes are cluster-scoped.",
    problems:
      "NotReady usually means kubelet/network trouble. Cordoning stops new Pods from scheduling here; draining also evicts the current ones.",
    docs: `${K8S_DOCS}/architecture/nodes/`,
  },
};

/** Fixed categorical accent per group (validated palette, fixed slot order). */
export const GROUP_ACCENT_VAR: Record<KindGroup, string> = {
  Workloads: "var(--series-1)",
  Networking: "var(--series-2)",
  "Config & Storage": "var(--series-3)",
  Cluster: "var(--series-4)",
};

export const HEALTH_LABEL: Record<string, string> = {
  good: "Healthy",
  warning: "Degraded",
  serious: "Unknown",
  critical: "Failing",
  neutral: "-",
};

export const ALL_KINDS: Kind[] = Object.keys(KIND_INFO) as Kind[];
