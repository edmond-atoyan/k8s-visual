// The educational layer: what each Kubernetes kind is, where it sits in the
// hierarchy, and where to read more. Kinds are grouped, and each group has a
// fixed categorical accent (identity is also always carried by the text badge,
// never by color alone).

import type { Kind } from "./types";

export type KindGroup = "Workloads" | "Networking" | "Config & Storage";

export interface KindMeta {
  group: KindGroup;
  /** Short badge text shown on graph nodes, e.g. "deploy". */
  badge: string;
  /** One-sentence explanation for newcomers. */
  what: string;
  /** Where this kind sits in the hierarchy — the app's core lesson. */
  hierarchy: string;
  docs: string;
}

const K8S_DOCS = "https://kubernetes.io/docs/concepts";

export const KIND_INFO: Record<Kind, KindMeta> = {
  Pod: {
    group: "Workloads",
    badge: "pod",
    what: "The smallest deployable unit: one or more containers that share network and storage.",
    hierarchy:
      "Almost never created by hand — a controller (ReplicaSet, Job, DaemonSet, StatefulSet) creates and replaces Pods for you.",
    docs: `${K8S_DOCS}/workloads/pods/`,
  },
  Deployment: {
    group: "Workloads",
    badge: "deploy",
    what: "Declares the desired state for stateless apps: which image, how many replicas, how to roll out updates.",
    hierarchy:
      "Creates a ReplicaSet per revision; the ReplicaSet then creates the Pods. Old ReplicaSets are kept (scaled to 0) so you can roll back.",
    docs: `${K8S_DOCS}/workloads/controllers/deployment/`,
  },
  ReplicaSet: {
    group: "Workloads",
    badge: "rs",
    what: "Keeps a fixed number of identical Pods running at all times.",
    hierarchy:
      "Usually owned by a Deployment — you rarely touch it directly. It owns the Pods below it.",
    docs: `${K8S_DOCS}/workloads/controllers/replicaset/`,
  },
  StatefulSet: {
    group: "Workloads",
    badge: "sts",
    what: "Runs stateful apps (databases, queues) with stable names, stable storage, and ordered startup.",
    hierarchy:
      "Creates Pods directly with sticky identities (name-0, name-1, ...), each usually bound to its own PersistentVolumeClaim.",
    docs: `${K8S_DOCS}/workloads/controllers/statefulset/`,
  },
  DaemonSet: {
    group: "Workloads",
    badge: "ds",
    what: "Runs exactly one copy of a Pod on every node (log collectors, monitoring agents, CNI).",
    hierarchy: "Creates one Pod per cluster node directly; new nodes get the Pod automatically.",
    docs: `${K8S_DOCS}/workloads/controllers/daemonset/`,
  },
  Job: {
    group: "Workloads",
    badge: "job",
    what: "Runs Pods until a task completes successfully, retrying on failure.",
    hierarchy: "Owns the Pods it starts; often owned by a CronJob when it runs on a schedule.",
    docs: `${K8S_DOCS}/workloads/controllers/job/`,
  },
  CronJob: {
    group: "Workloads",
    badge: "cron",
    what: "Runs Jobs on a schedule, like crontab for the cluster.",
    hierarchy: "Creates a new Job for every scheduled run; each Job then creates its Pods.",
    docs: `${K8S_DOCS}/workloads/controllers/cron-jobs/`,
  },
  Service: {
    group: "Networking",
    badge: "svc",
    what: "A stable name and virtual IP in front of a changing set of Pods.",
    hierarchy:
      "Matches Pods by label selector (dashed line in the graph) — it load-balances across whatever Pods currently match.",
    docs: `${K8S_DOCS}/services-networking/service/`,
  },
  Ingress: {
    group: "Networking",
    badge: "ing",
    what: "HTTP(S) routing from outside the cluster: hostnames and paths mapped to Services.",
    hierarchy: "Sits in front of Services; an ingress controller turns these rules into a real proxy.",
    docs: `${K8S_DOCS}/services-networking/ingress/`,
  },
  ConfigMap: {
    group: "Config & Storage",
    badge: "cm",
    what: "Non-secret configuration as key-value pairs, mounted as files or env vars.",
    hierarchy: "Referenced by Pods (dashed line) — change it and restart the Pods to pick it up.",
    docs: `${K8S_DOCS}/configuration/configmap/`,
  },
  Secret: {
    group: "Config & Storage",
    badge: "secret",
    what: "Like a ConfigMap but for sensitive values (passwords, tokens, TLS certs).",
    hierarchy: "Referenced by Pods (dashed line). K8s Visual only ever shows names — never values.",
    docs: `${K8S_DOCS}/configuration/secret/`,
  },
  PersistentVolumeClaim: {
    group: "Config & Storage",
    badge: "pvc",
    what: "A request for durable storage that survives Pod restarts.",
    hierarchy: "Mounted by Pods (dashed line); the cluster binds it to an actual volume behind the scenes.",
    docs: `${K8S_DOCS}/storage/persistent-volumes/`,
  },
};

/** Fixed categorical accent per group (validated palette, fixed slot order). */
export const GROUP_ACCENT_VAR: Record<KindGroup, string> = {
  Workloads: "var(--series-1)",
  Networking: "var(--series-2)",
  "Config & Storage": "var(--series-3)",
};

export const HEALTH_LABEL: Record<string, string> = {
  good: "Healthy",
  warning: "Degraded",
  serious: "Unknown",
  critical: "Failing",
  neutral: "—",
};
