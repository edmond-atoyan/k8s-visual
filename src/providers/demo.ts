// The built-in demo cluster: a realistic small online-shop deployment that
// exercises every kind the app knows about, including a crash-looping pod and
// an old ReplicaSet revision — the exact things newcomers need to see once.

import type {
  ClusterOverview,
  ClusterProvider,
  ContextInfo,
  Health,
  Kind,
  NamespaceSnapshot,
  OwnerRef,
  ResourceSummary,
} from "../types";

const NS = "demo-shop";

function uid(kind: Kind, name: string, ns = NS): string {
  return `${kind}:${ns}:${name}`;
}

function owner(kind: Kind, name: string, ns = NS): OwnerRef {
  return { kind, name, uid: uid(kind, name, ns) };
}

interface Partial8 {
  labels?: Record<string, string>;
  owners?: OwnerRef[];
  details?: Record<string, string>;
  selector?: Record<string, string>;
  refs?: string[];
}

function res(
  kind: Kind,
  name: string,
  status: string,
  health: Health,
  extra: Partial8 = {},
  ns = NS,
): ResourceSummary {
  return {
    uid: uid(kind, name, ns),
    kind,
    name,
    namespace: ns,
    owners: extra.owners ?? [],
    labels: extra.labels ?? {},
    status,
    health,
    details: extra.details ?? {},
    selector: extra.selector,
    refs: extra.refs,
  };
}

function pod(
  name: string,
  app: string,
  ownerRef: OwnerRef,
  node: string,
  opts: { status?: string; health?: Health; image?: string; refs?: string[]; restarts?: number } = {},
  ns = NS,
): ResourceSummary {
  const details: Record<string, string> = {
    Containers: opts.health === "critical" ? "0/1 ready" : "1/1 ready",
    Node: node,
    Image: opts.image ?? `registry.example.com/${app}:1.4.2`,
    "Pod IP": `10.42.${Math.abs(hash(name)) % 8}.${(Math.abs(hash(name)) % 250) + 2}`,
  };
  if (opts.restarts) details.Restarts = String(opts.restarts);
  return res(
    "Pod",
    name,
    opts.status ?? "Running",
    opts.health ?? "good",
    { labels: { app }, owners: [ownerRef], details, refs: opts.refs },
    ns,
  );
}

function hash(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h;
}

// --- demo-shop: the main teaching namespace -------------------------------

const demoShop: ResourceSummary[] = [
  // Ingress -> Services
  res("Ingress", "shop", "Routing", "neutral", {
    details: { Hosts: "shop.example.com", Class: "nginx" },
    refs: ["Service/storefront", "Service/api"],
  }),
  res("Service", "storefront", "ClusterIP", "neutral", {
    selector: { app: "storefront" },
    details: { Type: "ClusterIP", "Cluster IP": "10.96.114.23", Ports: "80 → 8080" },
  }),
  res("Service", "api", "ClusterIP", "neutral", {
    selector: { app: "api" },
    details: { Type: "ClusterIP", "Cluster IP": "10.96.87.140", Ports: "80 → 3000" },
  }),
  res("Service", "postgres", "ClusterIP", "neutral", {
    selector: { app: "postgres" },
    details: { Type: "ClusterIP", "Cluster IP": "None (headless)", Ports: "5432" },
  }),

  // storefront: healthy Deployment -> ReplicaSet -> 3 Pods
  res("Deployment", "storefront", "3/3 ready", "good", {
    labels: { app: "storefront" },
    selector: { app: "storefront" },
    details: { Replicas: "3 ready / 3 desired", Strategy: "RollingUpdate" },
  }),
  res("ReplicaSet", "storefront-7d9fc6b48", "3/3 ready", "good", {
    labels: { app: "storefront" },
    owners: [owner("Deployment", "storefront")],
    details: { Replicas: "3 ready / 3 desired" },
  }),
  pod("storefront-7d9fc6b48-x2lqp", "storefront", owner("ReplicaSet", "storefront-7d9fc6b48"), "worker-1"),
  pod("storefront-7d9fc6b48-8kd4n", "storefront", owner("ReplicaSet", "storefront-7d9fc6b48"), "worker-2"),
  pod("storefront-7d9fc6b48-tr9wz", "storefront", owner("ReplicaSet", "storefront-7d9fc6b48"), "worker-1"),

  // api: degraded Deployment with a crash-looping pod and an old revision
  res("Deployment", "api", "1/2 ready", "warning", {
    labels: { app: "api" },
    selector: { app: "api" },
    details: { Replicas: "1 ready / 2 desired", Strategy: "RollingUpdate" },
  }),
  res("ReplicaSet", "api-6b5c974d8f", "1/2 ready", "warning", {
    labels: { app: "api" },
    owners: [owner("Deployment", "api")],
    details: { Replicas: "1 ready / 2 desired" },
  }),
  res("ReplicaSet", "api-59d8b5f7c4", "scaled to 0", "neutral", {
    labels: { app: "api" },
    owners: [owner("Deployment", "api")],
    details: { Replicas: "0 ready / 0 desired", Note: "Old revision kept for rollback" },
  }),
  pod("api-6b5c974d8f-fj2sm", "api", owner("ReplicaSet", "api-6b5c974d8f"), "worker-2", {
    image: "registry.example.com/api:2.1.0",
    refs: ["ConfigMap/app-config", "Secret/db-credentials"],
  }),
  pod("api-6b5c974d8f-qw8rt", "api", owner("ReplicaSet", "api-6b5c974d8f"), "worker-1", {
    status: "CrashLoopBackOff",
    health: "critical",
    image: "registry.example.com/api:2.1.0",
    restarts: 17,
    refs: ["ConfigMap/app-config", "Secret/db-credentials"],
  }),

  // postgres: StatefulSet with storage
  res("StatefulSet", "postgres", "1/1 ready", "good", {
    labels: { app: "postgres" },
    selector: { app: "postgres" },
    details: { Replicas: "1 ready / 1 desired", "Headless Service": "postgres" },
  }),
  pod("postgres-0", "postgres", owner("StatefulSet", "postgres"), "worker-1", {
    image: "postgres:16-alpine",
    refs: ["Secret/db-credentials", "PersistentVolumeClaim/data-postgres-0"],
  }),

  // log agent on every node
  res("DaemonSet", "log-agent", "2/2 ready", "good", {
    labels: { app: "log-agent" },
    selector: { app: "log-agent" },
    details: { "Scheduled on": "2 node(s)" },
  }),
  pod("log-agent-b6xdr", "log-agent", owner("DaemonSet", "log-agent"), "worker-1", {
    image: "fluent-bit:3.1",
  }),
  pod("log-agent-m3kfp", "log-agent", owner("DaemonSet", "log-agent"), "worker-2", {
    image: "fluent-bit:3.1",
  }),

  // nightly backup: CronJob -> Job -> Pod
  res("CronJob", "db-backup", "Scheduled", "good", {
    details: { Schedule: "0 3 * * *", "Last run": "2026-07-02T03:00:00Z" },
  }),
  res("Job", "db-backup-29192840", "Complete", "good", {
    owners: [owner("CronJob", "db-backup")],
    details: { Pods: "0 active, 1 succeeded, 0 failed" },
  }),
  pod("db-backup-29192840-7hspb", "db-backup", owner("Job", "db-backup-29192840"), "worker-2", {
    status: "Succeeded",
    image: "registry.example.com/pg-backup:1.0",
    refs: ["Secret/db-credentials"],
  }),

  // config & storage
  res("ConfigMap", "app-config", "4 key(s)", "neutral"),
  res("Secret", "db-credentials", "2 key(s)", "neutral", {
    details: { Type: "Opaque" },
  }),
  res("PersistentVolumeClaim", "data-postgres-0", "Bound", "good", {
    details: { Capacity: "10Gi", StorageClass: "local-path" },
  }),
];

// --- kube-system: a taste of what the cluster itself runs ------------------

const kubeSystem: ResourceSummary[] = [
  res("Deployment", "coredns", "2/2 ready", "good", {
    labels: { "k8s-app": "kube-dns" }, selector: { "k8s-app": "kube-dns" },
    details: { Replicas: "2 ready / 2 desired" },
  }, "kube-system"),
  res("ReplicaSet", "coredns-76f75df574", "2/2 ready", "good", {
    labels: { "k8s-app": "kube-dns" },
    owners: [owner("Deployment", "coredns", "kube-system")],
  }, "kube-system"),
  pod("coredns-76f75df574-9xk2v", "kube-dns", owner("ReplicaSet", "coredns-76f75df574", "kube-system"), "control-plane", { image: "coredns/coredns:1.11.1", refs: ["ConfigMap/coredns"] }, "kube-system"),
  pod("coredns-76f75df574-lm5wq", "kube-dns", owner("ReplicaSet", "coredns-76f75df574", "kube-system"), "control-plane", { image: "coredns/coredns:1.11.1", refs: ["ConfigMap/coredns"] }, "kube-system"),
  res("Service", "kube-dns", "ClusterIP", "neutral", {
    selector: { "k8s-app": "kube-dns" },
    details: { Type: "ClusterIP", "Cluster IP": "10.96.0.10", Ports: "53, 9153" },
  }, "kube-system"),
  res("DaemonSet", "kube-proxy", "3/3 ready", "good", {
    labels: { "k8s-app": "kube-proxy" }, selector: { "k8s-app": "kube-proxy" },
    details: { "Scheduled on": "3 node(s)" },
  }, "kube-system"),
  pod("kube-proxy-4fkzq", "kube-proxy", owner("DaemonSet", "kube-proxy", "kube-system"), "control-plane", { image: "registry.k8s.io/kube-proxy:v1.33.2" }, "kube-system"),
  pod("kube-proxy-8shwn", "kube-proxy", owner("DaemonSet", "kube-proxy", "kube-system"), "worker-1", { image: "registry.k8s.io/kube-proxy:v1.33.2" }, "kube-system"),
  pod("kube-proxy-tt6vb", "kube-proxy", owner("DaemonSet", "kube-proxy", "kube-system"), "worker-2", { image: "registry.k8s.io/kube-proxy:v1.33.2" }, "kube-system"),
  res("ConfigMap", "coredns", "1 key(s)", "neutral", {}, "kube-system"),
];

const SNAPSHOTS: Record<string, ResourceSummary[]> = {
  [NS]: demoShop,
  "kube-system": kubeSystem,
  default: [],
};

const OVERVIEW: ClusterOverview = {
  version: "v1.33.2",
  nodes: [
    {
      name: "control-plane",
      roles: ["control-plane"],
      ready: true,
      version: "v1.33.2",
      osImage: "Ubuntu 24.04.2 LTS",
      cpu: "4",
      memory: "8129404Ki",
    },
    {
      name: "worker-1",
      roles: ["worker"],
      ready: true,
      version: "v1.33.2",
      osImage: "Ubuntu 24.04.2 LTS",
      cpu: "8",
      memory: "16258808Ki",
    },
    {
      name: "worker-2",
      roles: ["worker"],
      ready: true,
      version: "v1.33.2",
      osImage: "Ubuntu 24.04.2 LTS",
      cpu: "8",
      memory: "16258808Ki",
    },
  ],
  namespaces: [
    { name: "default", status: "Active", podCount: 0 },
    { name: NS, status: "Active", podCount: demoShop.filter((r) => r.kind === "Pod").length },
    { name: "kube-system", status: "Active", podCount: kubeSystem.filter((r) => r.kind === "Pod").length },
  ],
};

export class DemoProvider implements ClusterProvider {
  readonly mode = "demo" as const;

  async listContexts(): Promise<ContextInfo[]> {
    return [{ name: "demo-cluster", cluster: "demo-cluster", user: "demo", current: true }];
  }

  async connect(): Promise<{ context: string; server: string; version: string }> {
    return { context: "demo-cluster", server: "built-in sample data", version: OVERVIEW.version };
  }

  async disconnect(): Promise<void> {}

  async getOverview(): Promise<ClusterOverview> {
    return OVERVIEW;
  }

  async getSnapshot(namespace: string): Promise<NamespaceSnapshot> {
    return { namespace, resources: SNAPSHOTS[namespace] ?? [] };
  }
}

export const DEMO_DEFAULT_NAMESPACE = NS;
