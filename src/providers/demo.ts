// The built-in demo cluster: a realistic small online-shop deployment that
// exercises every kind and every feature the app knows about - including a
// crash-looping pod, an image-pull failure, an unschedulable pod, a Service
// with no endpoints, and an old ReplicaSet revision. Management actions
// mutate this in-memory state so scale/restart/delete visibly behave like a
// real controller would.

import type {
  AccessCheck,
  AccessResult,
  Action,
  ActionResult,
  ApplyResult,
  ClusterOverview,
  ClusterProvider,
  ContainerInfo,
  ContextInfo,
  EventInfo,
  ExecRequest,
  ExecResult,
  Health,
  Kind,
  LogQuery,
  MetricsSnapshot,
  NamespaceSnapshot,
  NodeDetail,
  OwnerRef,
  PodMetrics,
  PortForwardInfo,
  PortForwardRequest,
  ResourceRef,
  ResourceSummary,
  RolloutRevision,
  SecretKey,
} from "../types";

const NS = "demo-shop";
const now = () => Date.now();
const agoIso = (ms: number) => new Date(now() - ms).toISOString();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function uid(kind: Kind, name: string, ns = NS): string {
  return `${kind}:${ns}:${name}`;
}

function owner(kind: Kind, name: string, ns = NS): OwnerRef {
  return { kind, name, uid: uid(kind, name, ns) };
}

interface Extra {
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  owners?: OwnerRef[];
  details?: Record<string, string>;
  selector?: Record<string, string>;
  refs?: string[];
  containers?: ContainerInfo[];
  servicePorts?: ResourceSummary["servicePorts"];
  conditions?: ResourceSummary["conditions"];
  createdAgoMs?: number;
}

function res(
  kind: Kind,
  name: string,
  status: string,
  health: Health,
  extra: Extra = {},
  ns = NS,
): ResourceSummary {
  return {
    uid: uid(kind, name, ns),
    kind,
    name,
    namespace: ns,
    owners: extra.owners ?? [],
    labels: extra.labels ?? {},
    annotations: extra.annotations,
    status,
    health,
    createdAt: agoIso(extra.createdAgoMs ?? 6 * DAY),
    details: extra.details ?? {},
    selector: extra.selector,
    refs: extra.refs,
    containers: extra.containers,
    servicePorts: extra.servicePorts,
    conditions: extra.conditions,
  };
}

interface PodOpts {
  status?: string;
  health?: Health;
  image?: string;
  refs?: string[];
  restarts?: number;
  containerState?: string;
  lastState?: string;
  ports?: number[];
  createdAgoMs?: number;
  message?: string;
}

function pod(
  name: string,
  app: string,
  ownerRef: OwnerRef,
  node: string,
  opts: PodOpts = {},
  ns = NS,
): ResourceSummary {
  const image = opts.image ?? `registry.example.com/${app}:1.4.2`;
  const failing = opts.health === "critical";
  const pending = opts.status === "Pending";
  const details: Record<string, string> = {
    Containers: failing || pending ? "0/1 ready" : "1/1 ready",
    Image: image,
  };
  if (!pending) {
    details.Node = node;
    details["Pod IP"] = `10.42.${Math.abs(hash(name)) % 8}.${(Math.abs(hash(name)) % 250) + 2}`;
  }
  if (opts.restarts) details.Restarts = String(opts.restarts);
  const containers: ContainerInfo[] = [
    {
      name: app,
      image,
      ready: !failing && !pending,
      restarts: opts.restarts ?? 0,
      state: opts.containerState ?? (pending ? "Waiting: PodScheduling" : "Running"),
      lastState: opts.lastState,
      ports: opts.ports ?? [],
    },
  ];
  return res(
    "Pod",
    name,
    opts.status ?? "Running",
    opts.health ?? "good",
    {
      labels: { app },
      owners: [ownerRef],
      details,
      refs: opts.refs,
      containers,
      createdAgoMs: opts.createdAgoMs ?? 26 * HOUR,
      conditions: pending
        ? [{ type: "PodScheduled", status: "False", reason: "Unschedulable", message: opts.message }]
        : [
            { type: "PodScheduled", status: "True" },
            { type: "Ready", status: failing ? "False" : "True" },
          ],
    },
    ns,
  );
}

function hash(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h;
}

// --- demo-shop: the main teaching namespace -------------------------------

function buildDemoShop(): ResourceSummary[] {
  return [
    // Ingress -> Services (including a route to a Service with no endpoints)
    res("Ingress", "shop", "Routing", "neutral", {
      details: {
        Hosts: "shop.example.com",
        Class: "nginx",
        TLS: "tls-shop",
        Routes: [
          "shop.example.com/ → storefront:80",
          "shop.example.com/api → api:80",
          "shop.example.com/search → search:80",
        ].join("\n"),
      },
      refs: ["Service/storefront", "Service/api", "Service/search", "Secret/tls-shop"],
      createdAgoMs: 40 * DAY,
    }),
    res("Service", "storefront", "ClusterIP", "neutral", {
      selector: { app: "storefront" },
      details: { Type: "ClusterIP", "Cluster IP": "10.96.114.23", Ports: "80 → 8080" },
      servicePorts: [{ port: 80, targetPort: "8080", protocol: "TCP" }],
      createdAgoMs: 40 * DAY,
    }),
    res("Service", "api", "ClusterIP", "neutral", {
      selector: { app: "api" },
      details: { Type: "ClusterIP", "Cluster IP": "10.96.87.140", Ports: "80 → 3000" },
      servicePorts: [{ port: 80, targetPort: "3000", protocol: "TCP" }],
      createdAgoMs: 40 * DAY,
    }),
    // Teaching example: selector matches no ready pods -> no endpoints.
    res("Service", "search", "ClusterIP", "neutral", {
      selector: { app: "search" },
      details: { Type: "ClusterIP", "Cluster IP": "10.96.201.77", Ports: "80 → 9200" },
      servicePorts: [{ port: 80, targetPort: "9200", protocol: "TCP" }],
      createdAgoMs: 12 * DAY,
    }),
    res("Service", "postgres", "ClusterIP", "neutral", {
      selector: { app: "postgres" },
      details: { Type: "ClusterIP", "Cluster IP": "None (headless)", Ports: "5432" },
      servicePorts: [{ port: 5432, targetPort: "5432", protocol: "TCP" }],
      createdAgoMs: 40 * DAY,
    }),

    // storefront: healthy Deployment -> ReplicaSet -> 3 Pods
    res("Deployment", "storefront", "3/3 ready", "good", {
      labels: { app: "storefront" },
      selector: { app: "storefront" },
      details: { Replicas: "3 ready / 3 desired (3 updated, 3 available)", Strategy: "RollingUpdate" },
      conditions: [
        { type: "Available", status: "True", reason: "MinimumReplicasAvailable" },
        { type: "Progressing", status: "True", reason: "NewReplicaSetAvailable" },
      ],
      createdAgoMs: 40 * DAY,
    }),
    res("ReplicaSet", "storefront-7d9fc6b48", "3/3 ready", "good", {
      labels: { app: "storefront" },
      owners: [owner("Deployment", "storefront")],
      details: { Replicas: "3 ready / 3 desired", Revision: "4" },
      annotations: { "deployment.kubernetes.io/revision": "4" },
      createdAgoMs: 9 * DAY,
    }),
    pod("storefront-7d9fc6b48-x2lqp", "storefront", owner("ReplicaSet", "storefront-7d9fc6b48"), "worker-1", { ports: [8080], refs: ["ConfigMap/app-config"] }),
    pod("storefront-7d9fc6b48-8kd4n", "storefront", owner("ReplicaSet", "storefront-7d9fc6b48"), "worker-2", { ports: [8080], refs: ["ConfigMap/app-config"] }),
    pod("storefront-7d9fc6b48-tr9wz", "storefront", owner("ReplicaSet", "storefront-7d9fc6b48"), "worker-1", { ports: [8080], refs: ["ConfigMap/app-config"] }),

    // api: degraded Deployment with a crash-looping pod and an old revision
    res("Deployment", "api", "1/2 ready", "warning", {
      labels: { app: "api" },
      selector: { app: "api" },
      annotations: { "deployment.kubernetes.io/revision": "12" },
      details: { Replicas: "1 ready / 2 desired (2 updated, 1 available)", Strategy: "RollingUpdate" },
      conditions: [
        { type: "Available", status: "False", reason: "MinimumReplicasUnavailable" },
        { type: "Progressing", status: "True", reason: "ReplicaSetUpdated" },
      ],
      createdAgoMs: 40 * DAY,
    }),
    res("ReplicaSet", "api-6b5c974d8f", "1/2 ready", "warning", {
      labels: { app: "api" },
      owners: [owner("Deployment", "api")],
      annotations: { "deployment.kubernetes.io/revision": "12" },
      details: { Replicas: "1 ready / 2 desired", Revision: "12" },
      createdAgoMs: 26 * HOUR,
    }),
    res("ReplicaSet", "api-59d8b5f7c4", "scaled to 0", "neutral", {
      labels: { app: "api" },
      owners: [owner("Deployment", "api")],
      annotations: { "deployment.kubernetes.io/revision": "11" },
      details: { Replicas: "0 ready / 0 desired", Revision: "11", Note: "Old revision kept for rollback" },
      createdAgoMs: 8 * DAY,
    }),
    pod("api-6b5c974d8f-fj2sm", "api", owner("ReplicaSet", "api-6b5c974d8f"), "worker-2", {
      image: "registry.example.com/api:2.1.0",
      ports: [3000],
      refs: ["ConfigMap/app-config", "Secret/db-credentials"],
    }),
    pod("api-6b5c974d8f-qw8rt", "api", owner("ReplicaSet", "api-6b5c974d8f"), "worker-1", {
      status: "CrashLoopBackOff",
      health: "critical",
      image: "registry.example.com/api:2.1.0",
      restarts: 17,
      ports: [3000],
      containerState: "Waiting: CrashLoopBackOff",
      lastState: "Error (exit 1)",
      refs: ["ConfigMap/app-config", "Secret/db-credentials"],
    }),

    // recommendations: image pull failure
    res("Deployment", "recommendations", "0/1 ready", "critical", {
      labels: { app: "recommendations" },
      selector: { app: "recommendations" },
      details: { Replicas: "0 ready / 1 desired (1 updated, 0 available)", Strategy: "RollingUpdate" },
      conditions: [{ type: "Available", status: "False", reason: "MinimumReplicasUnavailable" }],
      createdAgoMs: 3 * HOUR,
    }),
    res("ReplicaSet", "recommendations-58fd7c44b9", "0/1 ready", "critical", {
      labels: { app: "recommendations" },
      owners: [owner("Deployment", "recommendations")],
      details: { Replicas: "0 ready / 1 desired", Revision: "1" },
      annotations: { "deployment.kubernetes.io/revision": "1" },
      createdAgoMs: 3 * HOUR,
    }),
    pod("recommendations-58fd7c44b9-zt6mm", "recommendations", owner("ReplicaSet", "recommendations-58fd7c44b9"), "worker-2", {
      status: "ImagePullBackOff",
      health: "critical",
      image: "registry.example.com/recomendations:0.3.0", // note the typo - that's the bug
      containerState: "Waiting: ImagePullBackOff",
      createdAgoMs: 3 * HOUR,
    }),

    // analytics: unschedulable pod (requests more memory than any node has)
    res("Deployment", "analytics", "0/1 ready", "warning", {
      labels: { app: "analytics" },
      selector: { app: "analytics" },
      details: { Replicas: "0 ready / 1 desired", Strategy: "RollingUpdate" },
      createdAgoMs: 2 * HOUR,
    }),
    res("ReplicaSet", "analytics-7b664c55c8", "0/1 ready", "warning", {
      labels: { app: "analytics" },
      owners: [owner("Deployment", "analytics")],
      details: { Replicas: "0 ready / 1 desired", Revision: "1" },
      annotations: { "deployment.kubernetes.io/revision": "1" },
      createdAgoMs: 2 * HOUR,
    }),
    pod("analytics-7b664c55c8-pv4ks", "analytics", owner("ReplicaSet", "analytics-7b664c55c8"), "", {
      status: "Pending",
      health: "warning",
      image: "registry.example.com/analytics:1.0.0",
      containerState: "Waiting: PodScheduling",
      message: "0/3 nodes are available: 3 Insufficient memory. Requested: 32Gi.",
      createdAgoMs: 2 * HOUR,
    }),

    // search: deployment scaled to zero -> its Service has no endpoints
    res("Deployment", "search", "scaled to 0", "neutral", {
      labels: { app: "search" },
      selector: { app: "search" },
      details: { Replicas: "0 ready / 0 desired", Strategy: "RollingUpdate", Note: "Scaled to 0 - the search Service has no endpoints" },
      createdAgoMs: 12 * DAY,
    }),

    // postgres: StatefulSet with storage
    res("StatefulSet", "postgres", "1/1 ready", "good", {
      labels: { app: "postgres" },
      selector: { app: "postgres" },
      details: { Replicas: "1 ready / 1 desired", "Headless Service": "postgres" },
      createdAgoMs: 40 * DAY,
    }),
    pod("postgres-0", "postgres", owner("StatefulSet", "postgres"), "worker-1", {
      image: "postgres:16-alpine",
      ports: [5432],
      refs: ["Secret/db-credentials", "PersistentVolumeClaim/data-postgres-0"],
      createdAgoMs: 15 * DAY,
    }),

    // log agent on every node
    res("DaemonSet", "log-agent", "2/2 ready", "good", {
      labels: { app: "log-agent" },
      selector: { app: "log-agent" },
      details: { "Scheduled on": "2 node(s)" },
      createdAgoMs: 40 * DAY,
    }),
    pod("log-agent-b6xdr", "log-agent", owner("DaemonSet", "log-agent"), "worker-1", { image: "fluent-bit:3.1", createdAgoMs: 20 * DAY }),
    pod("log-agent-m3kfp", "log-agent", owner("DaemonSet", "log-agent"), "worker-2", { image: "fluent-bit:3.1", createdAgoMs: 20 * DAY }),

    // nightly backup: CronJob -> Job -> Pod
    res("CronJob", "db-backup", "Scheduled", "good", {
      details: { Schedule: "0 3 * * *", "Last run": agoIso(11 * HOUR) },
      createdAgoMs: 40 * DAY,
    }),
    res("Job", "db-backup-29192840", "Complete", "good", {
      owners: [owner("CronJob", "db-backup")],
      details: { Pods: "0 active, 1 succeeded, 0 failed" },
      createdAgoMs: 11 * HOUR,
    }),
    pod("db-backup-29192840-7hspb", "db-backup", owner("Job", "db-backup-29192840"), "worker-2", {
      status: "Succeeded",
      image: "registry.example.com/pg-backup:1.0",
      refs: ["Secret/db-credentials"],
      containerState: "Terminated: Completed (exit 0)",
      createdAgoMs: 11 * HOUR,
    }),

    // autoscaling & network policy
    res("HorizontalPodAutoscaler", "api", "2 replicas (2-6)", "neutral", {
      details: { Range: "2 min / 6 max", Target: "Deployment api", "Target CPU": "80%" },
      refs: ["Deployment/api"],
      createdAgoMs: 30 * DAY,
    }),
    res("NetworkPolicy", "db-allow-api-only", "Active", "neutral", {
      selector: { app: "postgres" },
      details: { "Policy types": "Ingress", Allows: "from pods labelled app=api on port 5432" },
      createdAgoMs: 30 * DAY,
    }),

    // config & storage
    res("ConfigMap", "app-config", "4 key(s)", "neutral", {
      details: { Keys: "server.yaml, log-level, feature-flags, cache.conf" },
      createdAgoMs: 40 * DAY,
    }),
    res("Secret", "db-credentials", "2 key(s)", "neutral", {
      details: { Type: "Opaque", Keys: "username, password" },
      createdAgoMs: 40 * DAY,
    }),
    res("Secret", "tls-shop", "2 key(s)", "neutral", {
      details: { Type: "kubernetes.io/tls", Keys: "tls.crt, tls.key" },
      createdAgoMs: 40 * DAY,
    }),
    res("PersistentVolumeClaim", "data-postgres-0", "Bound", "good", {
      details: { Capacity: "10Gi", StorageClass: "local-path", "Access modes": "ReadWriteOnce", Volume: "pv-postgres-0001" },
      refs: ["PersistentVolume/pv-postgres-0001"],
      createdAgoMs: 40 * DAY,
    }),
    res("PersistentVolume", "pv-postgres-0001", "Bound", "good", {
      details: { Capacity: "10Gi", "Access modes": "ReadWriteOnce", "Reclaim policy": "Delete", StorageClass: "local-path", "Claimed by": "data-postgres-0" },
      refs: ["StorageClass/local-path"],
      createdAgoMs: 40 * DAY,
    }),
    res("StorageClass", "local-path", "rancher.io/local-path", "neutral", {
      details: { Provisioner: "rancher.io/local-path", "Reclaim policy": "Delete", "Binding mode": "WaitForFirstConsumer" },
      createdAgoMs: 60 * DAY,
    }),
  ];
}

// --- kube-system: a taste of what the cluster itself runs ------------------

function buildKubeSystem(): ResourceSummary[] {
  const ks = "kube-system";
  return [
    res("Deployment", "coredns", "2/2 ready", "good", {
      labels: { "k8s-app": "kube-dns" }, selector: { "k8s-app": "kube-dns" },
      details: { Replicas: "2 ready / 2 desired" },
      createdAgoMs: 60 * DAY,
    }, ks),
    res("ReplicaSet", "coredns-76f75df574", "2/2 ready", "good", {
      labels: { "k8s-app": "kube-dns" },
      owners: [owner("Deployment", "coredns", ks)],
      createdAgoMs: 60 * DAY,
    }, ks),
    pod("coredns-76f75df574-9xk2v", "kube-dns", owner("ReplicaSet", "coredns-76f75df574", ks), "control-plane", { image: "coredns/coredns:1.11.1", refs: ["ConfigMap/coredns"], createdAgoMs: 30 * DAY }, ks),
    pod("coredns-76f75df574-lm5wq", "kube-dns", owner("ReplicaSet", "coredns-76f75df574", ks), "control-plane", { image: "coredns/coredns:1.11.1", refs: ["ConfigMap/coredns"], createdAgoMs: 30 * DAY }, ks),
    res("Service", "kube-dns", "ClusterIP", "neutral", {
      selector: { "k8s-app": "kube-dns" },
      details: { Type: "ClusterIP", "Cluster IP": "10.96.0.10", Ports: "53, 9153" },
      servicePorts: [{ port: 53, targetPort: "53", protocol: "UDP" }, { port: 9153, targetPort: "9153", protocol: "TCP" }],
      createdAgoMs: 60 * DAY,
    }, ks),
    res("DaemonSet", "kube-proxy", "3/3 ready", "good", {
      labels: { "k8s-app": "kube-proxy" }, selector: { "k8s-app": "kube-proxy" },
      details: { "Scheduled on": "3 node(s)" },
      createdAgoMs: 60 * DAY,
    }, ks),
    pod("kube-proxy-4fkzq", "kube-proxy", owner("DaemonSet", "kube-proxy", ks), "control-plane", { image: "registry.k8s.io/kube-proxy:v1.33.2", createdAgoMs: 30 * DAY }, ks),
    pod("kube-proxy-8shwn", "kube-proxy", owner("DaemonSet", "kube-proxy", ks), "worker-1", { image: "registry.k8s.io/kube-proxy:v1.33.2", createdAgoMs: 30 * DAY }, ks),
    pod("kube-proxy-tt6vb", "kube-proxy", owner("DaemonSet", "kube-proxy", ks), "worker-2", { image: "registry.k8s.io/kube-proxy:v1.33.2", createdAgoMs: 30 * DAY }, ks),
    res("ConfigMap", "coredns", "1 key(s)", "neutral", { details: { Keys: "Corefile" }, createdAgoMs: 60 * DAY }, ks),
  ];
}

// --- events ----------------------------------------------------------------

function buildEvents(): Record<string, EventInfo[]> {
  const ev = (
    type: "Normal" | "Warning",
    reason: string,
    message: string,
    involvedKind: string,
    involvedName: string,
    count: number,
    lastAgoMs: number,
    firstAgoMs = lastAgoMs,
  ): EventInfo => ({
    type, reason, message, involvedKind, involvedName, count,
    firstSeen: agoIso(firstAgoMs),
    lastSeen: agoIso(lastAgoMs),
  });
  return {
    [NS]: [
      ev("Warning", "BackOff", "Back-off restarting failed container api in pod api-6b5c974d8f-qw8rt", "Pod", "api-6b5c974d8f-qw8rt", 243, 2 * 60_000, 26 * HOUR),
      ev("Warning", "Unhealthy", "Readiness probe failed: connect: connection refused", "Pod", "api-6b5c974d8f-qw8rt", 87, 4 * 60_000, 26 * HOUR),
      ev("Warning", "Failed", 'Failed to pull image "registry.example.com/recomendations:0.3.0": manifest unknown: repository not found', "Pod", "recommendations-58fd7c44b9-zt6mm", 12, 90_000, 3 * HOUR),
      ev("Warning", "Failed", "Error: ImagePullBackOff", "Pod", "recommendations-58fd7c44b9-zt6mm", 12, 90_000, 3 * HOUR),
      ev("Warning", "FailedScheduling", "0/3 nodes are available: 3 Insufficient memory. preemption: 0/3 nodes are available: 3 No preemption victims found.", "Pod", "analytics-7b664c55c8-pv4ks", 25, 60_000, 2 * HOUR),
      ev("Normal", "Pulled", 'Container image "registry.example.com/api:2.1.0" already present on machine', "Pod", "api-6b5c974d8f-qw8rt", 244, 2 * 60_000, 26 * HOUR),
      ev("Normal", "Started", "Started container api", "Pod", "api-6b5c974d8f-fj2sm", 1, 26 * HOUR),
      ev("Normal", "ScalingReplicaSet", "Scaled up replica set api-6b5c974d8f from 0 to 2", "Deployment", "api", 1, 26 * HOUR),
      ev("Normal", "SuccessfulCreate", "Created pod: db-backup-29192840-7hspb", "Job", "db-backup-29192840", 1, 11 * HOUR),
      ev("Normal", "Completed", "Job completed", "Job", "db-backup-29192840", 1, 11 * HOUR - 42_000),
      ev("Normal", "SuccessfulCreate", "Created pod: recommendations-58fd7c44b9-zt6mm", "ReplicaSet", "recommendations-58fd7c44b9", 1, 3 * HOUR),
    ],
    "kube-system": [
      ev("Normal", "Started", "Started container coredns", "Pod", "coredns-76f75df574-9xk2v", 1, 30 * DAY),
    ],
    default: [],
  };
}

// --- logs --------------------------------------------------------------------

const CRASH_LOG = `2026-07-03T09:12:44.101Z INFO  api starting api server v2.1.0
2026-07-03T09:12:44.180Z INFO  api loading config from /etc/config/server.yaml
2026-07-03T09:12:44.suffix181Z INFO  api connecting to postgres://postgres.demo-shop:5432/shop
2026-07-03T09:12:49.310Z ERROR api database connection failed: password authentication failed for user "shop_api"
2026-07-03T09:12:49.311Z ERROR api check the db-credentials Secret - did the password rotate?
2026-07-03T09:12:49.312Z FATAL api cannot start without database, exiting
`.replace(".suffix181Z", ".181Z");

const LOG_LINES: Record<string, string[]> = {
  storefront: [
    'GET / 200 12ms ip=203.0.113.7 ua="Mozilla/5.0"',
    "GET /assets/main.css 200 2ms",
    "GET /products?page=2 200 48ms",
    "GET /cart 200 9ms user=u_58231",
    "POST /cart/items 201 33ms user=u_58231",
    "GET /checkout 200 41ms user=u_18332",
    "GET /healthz 200 1ms",
  ],
  api: [
    "INFO  api GET /v1/products 200 18ms",
    "INFO  api GET /v1/products/42 200 7ms",
    "INFO  api POST /v1/orders 201 64ms",
    "WARN  api slow query: SELECT * FROM orders WHERE ... (312ms)",
    "INFO  api GET /v1/inventory 200 12ms",
    "INFO  api cache hit ratio 0.94",
  ],
  postgres: [
    "LOG:  checkpoint starting: time",
    "LOG:  checkpoint complete: wrote 118 buffers (0.7%)",
    "LOG:  automatic vacuum of table \"shop.public.orders\"",
    "LOG:  connection received: host=10.42.3.17 port=44210",
    "LOG:  connection authorized: user=shop_api database=shop",
  ],
  "log-agent": [
    "[info] [input:tail] inotify watch added for /var/log/containers/*.log",
    "[info] [output:forward] flushed 128 records",
    "[info] [filter:kubernetes] enriched 128 records",
  ],
  "kube-dns": [
    "[INFO] 10.42.1.5:38122 - 8371 \"A IN api.demo-shop.svc.cluster.local. udp 49 false 512\" NOERROR",
    "[INFO] 10.42.2.9:51001 - 1224 \"A IN postgres.demo-shop.svc.cluster.local. udp 54 false 512\" NOERROR",
  ],
  "kube-proxy": ["I0703 syncing iptables rules", "I0703 sync complete (2.1ms)"],
  "db-backup": [
    "starting backup of database shop",
    "pg_dump: dumping contents of table public.orders",
    "backup complete: 412MB written to s3://backups/shop/2026-07-03.sql.gz",
    "done in 42s",
  ],
};

function appOf(podName: string): string {
  for (const key of Object.keys(LOG_LINES)) {
    if (podName.startsWith(key) || podName.includes(key)) return key;
  }
  if (podName.startsWith("coredns")) return "kube-dns";
  return "api";
}

function logLine(app: string): string {
  const lines = LOG_LINES[app] ?? LOG_LINES.api;
  const line = lines[Math.floor(Math.random() * lines.length)];
  return `${new Date().toISOString().replace("T", " ").slice(0, 23)} ${line}`;
}

// --- nodes -------------------------------------------------------------------

function buildNodes(snapshots: Record<string, ResourceSummary[]>, cordoned: Set<string> = new Set()): NodeDetail[] {
  const podsOn = (node: string) =>
    Object.values(snapshots)
      .flat()
      .filter((r) => r.kind === "Pod" && r.details.Node === node)
      .map((p) => ({ namespace: p.namespace, name: p.name, status: p.status, health: p.health }));
  const conditions = (ready = true) => [
    { type: "Ready", status: ready ? "True" : "False", reason: ready ? "KubeletReady" : "KubeletNotReady" },
    { type: "MemoryPressure", status: "False" },
    { type: "DiskPressure", status: "False" },
    { type: "PIDPressure", status: "False" },
  ];
  const nodes: NodeDetail[] = [
    {
      name: "control-plane", roles: ["control-plane"], ready: true, version: "v1.33.2",
      osImage: "Ubuntu 24.04.2 LTS", cpu: "4", memory: "8129404Ki",
      internalIp: "192.168.1.10", runtime: "containerd://1.7.27",
      allocatableCpu: "3800m", allocatableMemory: "7629404Ki",
      taints: ["node-role.kubernetes.io/control-plane:NoSchedule"],
      labels: { "node-role.kubernetes.io/control-plane": "", "kubernetes.io/os": "linux" },
      conditions: conditions(),
      pods: podsOn("control-plane"),
    },
    {
      name: "worker-1", roles: ["worker"], ready: true, version: "v1.33.2",
      osImage: "Ubuntu 24.04.2 LTS", cpu: "8", memory: "16258808Ki",
      internalIp: "192.168.1.11", runtime: "containerd://1.7.27",
      allocatableCpu: "7800m", allocatableMemory: "15758808Ki",
      taints: [],
      labels: { "kubernetes.io/os": "linux", zone: "rack-a" },
      conditions: conditions(),
      pods: podsOn("worker-1"),
    },
    {
      name: "worker-2", roles: ["worker"], ready: true, version: "v1.33.2",
      osImage: "Ubuntu 24.04.2 LTS", cpu: "8", memory: "16258808Ki",
      internalIp: "192.168.1.12", runtime: "containerd://1.7.27",
      allocatableCpu: "7800m", allocatableMemory: "15758808Ki",
      taints: [],
      labels: { "kubernetes.io/os": "linux", zone: "rack-b" },
      conditions: conditions(),
      pods: podsOn("worker-2"),
    },
  ];
  for (const n of nodes) {
    if (cordoned.has(n.name)) {
      n.unschedulable = true;
      n.taints = [...n.taints, "node.kubernetes.io/unschedulable:NoSchedule"];
    }
  }
  return nodes;
}

// --- secrets (fake values, clearly fake) -------------------------------------

const SECRET_VALUES: Record<string, SecretKey[]> = {
  [`${NS}/db-credentials`]: [
    { name: "username", value: "shop_api", binary: false, bytes: 8 },
    { name: "password", value: "demo-not-a-real-password-42", binary: false, bytes: 27 },
  ],
  [`${NS}/tls-shop`]: [
    { name: "tls.crt", value: "-----BEGIN CERTIFICATE-----\nMIIDemoCertNotRealAAAA...\n-----END CERTIFICATE-----", binary: false, bytes: 1180 },
    { name: "tls.key", value: undefined, binary: true, bytes: 1704 },
  ],
};

const CONFIGMAP_VALUES: Record<string, Record<string, string>> = {
  [`${NS}/app-config`]: {
    "server.yaml": "port: 3000\ntimeout: 30s\ncors:\n  enabled: true\n  origins:\n    - https://shop.example.com",
    "log-level": "info",
    "feature-flags": "new-checkout=true\nrecommendations=false",
    "cache.conf": "ttl 300\nmax-entries 10000",
  },
  ["kube-system/coredns"]: {
    Corefile: ".:53 {\n    errors\n    health\n    kubernetes cluster.local\n    forward . /etc/resolv.conf\n    cache 30\n}",
  },
};

// --- provider -----------------------------------------------------------------

export class DemoProvider implements ClusterProvider {
  readonly mode = "demo" as const;

  private snapshots: Record<string, ResourceSummary[]> = {
    [NS]: buildDemoShop(),
    "kube-system": buildKubeSystem(),
    default: [],
  };
  private events = buildEvents();
  private forwards: PortForwardInfo[] = [];
  private forwardSeq = 0;
  private podSeq = 0;
  private cordoned = new Set<string>();

  async listContexts(): Promise<ContextInfo[]> {
    return [{ name: "demo-cluster", cluster: "demo-cluster", user: "demo", current: true }];
  }

  async connect(): Promise<{ context: string; server: string; version: string }> {
    return { context: "demo-cluster", server: "built-in sample data", version: "v1.33.2" };
  }

  async disconnect(): Promise<void> {}

  async getOverview(): Promise<ClusterOverview> {
    const all = Object.values(this.snapshots).flat();
    const pods = all.filter((r) => r.kind === "Pod");
    return {
      version: "v1.33.2",
      nodes: buildNodes(this.snapshots, this.cordoned).map(({ name, roles, ready, version, osImage, cpu, memory }) => ({
        name, roles, ready, version, osImage, cpu, memory,
      })),
      namespaces: Object.keys(this.snapshots).sort().map((name) => ({
        name,
        status: "Active",
        podCount: this.snapshots[name].filter((r) => r.kind === "Pod").length,
        createdAt: agoIso(60 * DAY),
      })),
      podCount: pods.length,
      failingPods: pods.filter((p) => p.health === "critical").length,
      warningEvents: Object.values(this.events).flat().filter((e) => e.type === "Warning").length,
    };
  }

  async getSnapshot(namespace: string): Promise<NamespaceSnapshot> {
    return { namespace, resources: this.snapshots[namespace] ?? [] };
  }

  async getNodes(): Promise<NodeDetail[]> {
    return buildNodes(this.snapshots, this.cordoned);
  }

  async getEvents(namespace: string): Promise<EventInfo[]> {
    return [...(this.events[namespace] ?? [])];
  }

  async getMetrics(namespace: string): Promise<MetricsSnapshot> {
    // Deterministic-ish base with a little jitter so charts visibly move.
    const jitter = (base: number, spread: number) =>
      Math.max(1, Math.round(base + (Math.random() - 0.5) * spread));
    const pods: PodMetrics[] = (this.snapshots[namespace] ?? [])
      .filter((r) => r.kind === "Pod" && r.status !== "Succeeded" && r.status !== "Pending")
      .map((p) => {
        const seed = Math.abs(hash(p.name));
        const failing = p.health === "critical";
        const cpu = failing ? jitter(4, 4) : jitter(20 + (seed % 120), 24);
        const mem = (failing ? 24 : 64 + (seed % 320)) * 1024 * 1024;
        return {
          namespace,
          name: p.name,
          cpuMillis: cpu,
          memoryBytes: jitter(mem, mem / 10),
          containers: [{ name: p.containers?.[0]?.name ?? "app", cpuMillis: cpu, memoryBytes: mem }],
        };
      });
    return {
      available: true,
      nodes: [
        { name: "control-plane", cpuMillis: jitter(410, 60), memoryBytes: jitter(2.7 * 1024 ** 3, 2 ** 27) },
        { name: "worker-1", cpuMillis: jitter(1480, 240), memoryBytes: jitter(6.1 * 1024 ** 3, 2 ** 28) },
        { name: "worker-2", cpuMillis: jitter(1130, 200), memoryBytes: jitter(5.4 * 1024 ** 3, 2 ** 28) },
      ],
      pods,
    };
  }

  async getYaml(ref: ResourceRef): Promise<string> {
    const list = this.snapshots[ref.namespace] ?? [];
    const r = list.find((x) => x.kind === ref.kind && x.name === ref.name);
    if (!r) throw new Error(`${ref.kind} ${ref.namespace}/${ref.name} not found`);
    return demoYaml(r);
  }

  async getLogs(query: LogQuery): Promise<string> {
    const app = appOf(query.pod);
    if (query.pod.includes("qw8rt")) {
      // The crash-looping pod: current == previous == the failing run.
      return CRASH_LOG;
    }
    if (query.previous) {
      return `(no previous container instance for ${query.pod})\n`;
    }
    const n = Math.min(query.tailLines ?? 200, 200);
    return Array.from({ length: n }, () => logLine(app)).join("\n") + "\n";
  }

  async streamLogs(query: LogQuery, onLine: (line: string) => void): Promise<() => void> {
    const app = appOf(query.pod);
    if (query.pod.includes("qw8rt")) {
      // Crash loop: replay the failing startup every few seconds.
      const lines = CRASH_LOG.trimEnd().split("\n");
      let i = 0;
      const timer = setInterval(() => {
        onLine(lines[i % lines.length]);
        i++;
      }, 700);
      return () => clearInterval(timer);
    }
    const timer = setInterval(() => {
      if (Math.random() < 0.75) onLine(logLine(app));
    }, 500);
    return () => clearInterval(timer);
  }

  async getConfigMapData(namespace: string, name: string): Promise<Record<string, string>> {
    return CONFIGMAP_VALUES[`${namespace}/${name}`] ?? {};
  }

  async revealSecret(namespace: string, name: string): Promise<SecretKey[]> {
    const values = SECRET_VALUES[`${namespace}/${name}`];
    if (!values) throw new Error(`Secret ${namespace}/${name} not found`);
    return values;
  }

  async getRolloutHistory(namespace: string, name: string): Promise<RolloutRevision[]> {
    const list = this.snapshots[namespace] ?? [];
    const rss = list.filter(
      (r) => r.kind === "ReplicaSet" && r.owners.some((o) => o.kind === "Deployment" && o.name === name),
    );
    const deployment = list.find((r) => r.kind === "Deployment" && r.name === name);
    const currentRev = Number(deployment?.annotations?.["deployment.kubernetes.io/revision"] ?? 0);
    return rss
      .map((rs) => {
        const revision = Number(rs.annotations?.["deployment.kubernetes.io/revision"] ?? rs.details.Revision ?? 0);
        const podOfRs = list.find((p) => p.kind === "Pod" && p.owners.some((o) => o.uid === rs.uid));
        const [ready = "0", desired = "0"] = (rs.details.Replicas ?? "").match(/\d+/g) ?? [];
        return {
          revision,
          replicaSet: rs.name,
          images: [podOfRs?.details.Image ?? "registry.example.com/api:2.0.3"],
          ready: Number(ready),
          desired: Number(desired),
          current: revision === currentRev,
        };
      })
      .sort((a, b) => b.revision - a.revision);
  }

  async checkAccess(checks: AccessCheck[]): Promise<AccessResult[]> {
    return checks.map((check) => {
      if (check.resource === "namespaces" && check.verb === "delete") {
        return { check, allowed: false, reason: "demo cluster: namespace deletion is disabled for the demo user" };
      }
      return { check, allowed: true, reason: "demo cluster: the demo user has admin access" };
    });
  }

  // --- management actions: mutate the in-memory cluster --------------------

  async performAction(action: Action): Promise<ActionResult> {
    switch (action.type) {
      case "scaleWorkload":
        return this.scale(action.namespace, action.kind, action.name, action.replicas);
      case "restartRollout":
        return this.restart(action.namespace, action.kind, action.name);
      case "rollbackDeployment":
        return this.rollback(action.namespace, action.name);
      case "pauseRollout":
        return this.patchStatus(action.namespace, "Deployment", action.name, (r) => {
          if (action.pause) r.details.Rollout = "Paused";
          else delete r.details.Rollout;
        }, `Rollout ${action.pause ? "paused" : "resumed"} for Deployment ${action.namespace}/${action.name}`);
      case "suspendCronJob":
        return this.patchStatus(action.namespace, "CronJob", action.name, (r) => {
          r.status = action.suspend ? "Suspended" : "Scheduled";
          r.health = action.suspend ? "warning" : "good";
        }, `CronJob ${action.namespace}/${action.name} ${action.suspend ? "suspended" : "resumed"}`);
      case "triggerCronJob":
        return this.triggerJob(action.namespace, action.name);
      case "deleteResource":
        return this.deleteResource(action.namespace, action.kind, action.name);
      case "cordonNode": {
        if (action.cordon) this.cordoned.add(action.name);
        else this.cordoned.delete(action.name);
        return {
          ok: true,
          message: `Node ${action.name} ${action.cordon ? "cordoned - no new Pods will be scheduled on it" : "uncordoned - schedulable again"}`,
        };
      }
    }
  }

  private list(ns: string): ResourceSummary[] {
    return (this.snapshots[ns] ??= []);
  }

  private find(ns: string, kind: Kind, name: string): ResourceSummary | undefined {
    return this.list(ns).find((r) => r.kind === kind && r.name === name);
  }

  private pushEvent(ns: string, e: Omit<EventInfo, "firstSeen" | "lastSeen" | "count"> & { count?: number }) {
    (this.events[ns] ??= []).unshift({
      count: 1,
      ...e,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    });
  }

  private patchStatus(
    ns: string,
    kind: Kind,
    name: string,
    patch: (r: ResourceSummary) => void,
    message: string,
  ): ActionResult {
    const r = this.find(ns, kind, name);
    if (!r) return { ok: false, message: `${kind} ${ns}/${name} not found` };
    patch(r);
    return { ok: true, message };
  }

  private newPodName(prefix: string): string {
    const chars = "bcdfghjklmnpqrstvwxz23456789";
    let suffix = "";
    for (let i = 0; i < 5; i++) suffix += chars[Math.floor(Math.random() * chars.length)];
    this.podSeq++;
    return `${prefix}-${suffix}`;
  }

  /** Add a pod that starts as ContainerCreating and flips to Running. */
  private spawnPod(ns: string, template: ResourceSummary, ownerRef: OwnerRef, node: string) {
    const prefix = ownerRef.name;
    const created = pod(this.newPodName(prefix), template.labels.app ?? prefix, ownerRef, node, {
      image: template.details.Image,
      refs: template.refs,
      status: "ContainerCreating",
      health: "warning",
      createdAgoMs: 0,
    }, ns);
    this.list(ns).push(created);
    this.pushEvent(ns, { type: "Normal", reason: "SuccessfulCreate", message: `Created pod: ${created.name}`, involvedKind: ownerRef.kind, involvedName: ownerRef.name });
    setTimeout(() => {
      created.status = "Running";
      created.health = "good";
      created.details.Containers = "1/1 ready";
      if (created.containers) {
        created.containers[0].ready = true;
        created.containers[0].state = "Running";
      }
      this.recount(ns);
    }, 4000);
  }

  /** Recompute ready/desired numbers for controllers from their pods. */
  private recount(ns: string) {
    for (const ctrl of this.list(ns)) {
      if (ctrl.kind !== "Deployment" && ctrl.kind !== "ReplicaSet" && ctrl.kind !== "StatefulSet") continue;
      const isOwned = (p: ResourceSummary, root: ResourceSummary): boolean => {
        if (p.owners.some((o) => o.uid === root.uid)) return true;
        return p.owners.some((o) => {
          const mid = this.list(ns).find((x) => x.uid === o.uid);
          return mid ? isOwned(mid, root) : false;
        });
      };
      const pods = this.list(ns).filter((p) => p.kind === "Pod" && isOwned(p, ctrl));
      const desiredMatch = /(\d+)\s*desired/.exec(ctrl.details.Replicas ?? "");
      const desired = desiredMatch ? Number(desiredMatch[1]) : pods.length;
      const ready = pods.filter((p) => p.health === "good" && p.status === "Running").length;
      if (ctrl.status.includes("ready") || ctrl.status.includes("scaled")) {
        ctrl.status = desired === 0 ? "scaled to 0" : `${ready}/${desired} ready`;
        ctrl.health = desired === 0 ? "neutral" : ready >= desired ? "good" : ready > 0 ? "warning" : "critical";
        ctrl.details.Replicas = `${ready} ready / ${desired} desired`;
      }
    }
  }

  private scale(ns: string, kind: Kind, name: string, replicas: number): ActionResult {
    const ctrl = this.find(ns, kind, name);
    if (!ctrl) return { ok: false, message: `${kind} ${ns}/${name} not found` };
    // Find the pods' direct owner (active RS for a Deployment, else itself).
    let podOwner = ctrl;
    if (kind === "Deployment") {
      const active = this.list(ns)
        .filter((r) => r.kind === "ReplicaSet" && r.owners.some((o) => o.uid === ctrl.uid))
        .sort((a, b) => Number(b.details.Revision ?? 0) - Number(a.details.Revision ?? 0))[0];
      if (active) podOwner = active;
    }
    const pods = this.list(ns).filter(
      (p) => p.kind === "Pod" && p.owners.some((o) => o.uid === podOwner.uid) && p.status !== "Succeeded",
    );
    const diff = replicas - pods.length;
    const nodes = ["worker-1", "worker-2"];
    if (diff > 0) {
      const template = pods[0] ?? podOwner;
      for (let i = 0; i < diff; i++) {
        this.spawnPod(ns, template, { kind: podOwner.kind, name: podOwner.name, uid: podOwner.uid }, nodes[i % 2]);
      }
    } else if (diff < 0) {
      const victims = pods.slice(diff); // remove from the end
      this.snapshots[ns] = this.list(ns).filter((r) => !victims.includes(r));
      for (const v of victims) {
        this.pushEvent(ns, { type: "Normal", reason: "Killing", message: `Stopping container ${v.labels.app ?? v.name}`, involvedKind: "Pod", involvedName: v.name });
      }
    }
    ctrl.details.Replicas = `${Math.min(pods.length, replicas)} ready / ${replicas} desired`;
    if (podOwner !== ctrl) podOwner.details.Replicas = ctrl.details.Replicas;
    this.pushEvent(ns, { type: "Normal", reason: "ScalingReplicaSet", message: `Scaled ${diff > 0 ? "up" : "down"} replica set ${podOwner.name} to ${replicas}`, involvedKind: "Deployment", involvedName: name });
    this.recount(ns);
    return { ok: true, message: `Scaled ${kind} ${ns}/${name} to ${replicas} replica(s)` };
  }

  private restart(ns: string, kind: Kind, name: string): ActionResult {
    const ctrl = this.find(ns, kind, name);
    if (!ctrl) return { ok: false, message: `${kind} ${ns}/${name} not found` };
    const owned = this.list(ns).filter(
      (p) =>
        p.kind === "Pod" &&
        p.owners.some((o) => {
          if (o.uid === ctrl.uid) return true;
          const mid = this.list(ns).find((x) => x.uid === o.uid);
          return mid?.owners.some((oo) => oo.uid === ctrl.uid) ?? false;
        }) &&
        p.status !== "Succeeded",
    );
    const directOwnerUid = owned[0]?.owners[0]?.uid;
    const directOwner = this.list(ns).find((r) => r.uid === directOwnerUid) ?? ctrl;
    this.snapshots[ns] = this.list(ns).filter((r) => !owned.includes(r));
    const nodes = ["worker-1", "worker-2"];
    owned.forEach((p, i) => {
      this.pushEvent(ns, { type: "Normal", reason: "Killing", message: `Stopping container ${p.labels.app ?? p.name}`, involvedKind: "Pod", involvedName: p.name });
      this.spawnPod(ns, p, { kind: directOwner.kind, name: directOwner.name, uid: directOwner.uid }, nodes[i % 2]);
    });
    this.recount(ns);
    return { ok: true, message: `Rollout restart triggered for ${kind} ${ns}/${name}` };
  }

  private rollback(ns: string, name: string): ActionResult {
    const deployment = this.find(ns, "Deployment", name);
    if (!deployment) return { ok: false, message: `Deployment ${ns}/${name} not found` };
    if (name !== "api") {
      return { ok: false, message: `no previous revision found for Deployment ${ns}/${name}` };
    }
    // Swap: old revision RS becomes active with the previous image.
    const oldRs = this.find(ns, "ReplicaSet", "api-59d8b5f7c4");
    const newRs = this.find(ns, "ReplicaSet", "api-6b5c974d8f");
    if (!oldRs || !newRs) return { ok: false, message: "revision ReplicaSets not found" };
    const pods = this.list(ns).filter((p) => p.kind === "Pod" && p.owners.some((o) => o.uid === newRs.uid));
    this.snapshots[ns] = this.list(ns).filter((r) => !pods.includes(r));
    oldRs.details = { Replicas: "0 ready / 2 desired", Revision: "13" };
    oldRs.annotations = { "deployment.kubernetes.io/revision": "13" };
    oldRs.status = "0/2 ready";
    oldRs.health = "warning";
    newRs.details = { Replicas: "0 ready / 0 desired", Revision: "12", Note: "Old revision kept for rollback" };
    newRs.status = "scaled to 0";
    newRs.health = "neutral";
    deployment.annotations = { ...deployment.annotations, "deployment.kubernetes.io/revision": "13" };
    for (let i = 0; i < 2; i++) {
      const template = { ...pods[0], details: { ...pods[0]?.details, Image: "registry.example.com/api:2.0.3" }, refs: pods[0]?.refs } as ResourceSummary;
      this.spawnPod(ns, template, { kind: "ReplicaSet", name: oldRs.name, uid: oldRs.uid }, i % 2 ? "worker-2" : "worker-1");
    }
    this.pushEvent(ns, { type: "Normal", reason: "DeploymentRollback", message: `Rolled back deployment "${name}" to revision 11`, involvedKind: "Deployment", involvedName: name });
    this.recount(ns);
    return { ok: true, message: `Rolled Deployment ${ns}/${name} back to revision 11 (image api:2.0.3)` };
  }

  private triggerJob(ns: string, name: string): ActionResult {
    const cj = this.find(ns, "CronJob", name);
    if (!cj) return { ok: false, message: `CronJob ${ns}/${name} not found` };
    const jobName = this.newPodName(`${name}-manual`);
    const job = res("Job", jobName, "Active", "good", {
      owners: [owner("CronJob", name, ns)],
      details: { Pods: "1 active, 0 succeeded, 0 failed" },
      createdAgoMs: 0,
    }, ns);
    this.list(ns).push(job);
    const jobPod = pod(this.newPodName(jobName), name, owner("Job", jobName, ns), "worker-1", {
      image: "registry.example.com/pg-backup:1.0",
      refs: ["Secret/db-credentials"],
      createdAgoMs: 0,
    }, ns);
    this.list(ns).push(jobPod);
    this.pushEvent(ns, { type: "Normal", reason: "SuccessfulCreate", message: `Created job ${jobName}`, involvedKind: "CronJob", involvedName: name });
    setTimeout(() => {
      job.status = "Complete";
      job.details.Pods = "0 active, 1 succeeded, 0 failed";
      jobPod.status = "Succeeded";
      jobPod.details.Containers = "0/1 ready";
    }, 8000);
    return { ok: true, message: `Created Job ${ns}/${jobName} from CronJob ${name}` };
  }

  private deleteResource(ns: string, kind: Kind, name: string): ActionResult {
    const r = this.find(ns, kind, name);
    if (!r) return { ok: false, message: `${kind} ${ns}/${name} not found` };
    // Delete the resource and everything it (transitively) owns.
    const doomed = new Set<string>([r.uid]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const x of this.list(ns)) {
        if (!doomed.has(x.uid) && x.owners.some((o) => doomed.has(o.uid))) {
          doomed.add(x.uid);
          grew = true;
        }
      }
    }
    this.snapshots[ns] = this.list(ns).filter((x) => !doomed.has(x.uid));
    this.pushEvent(ns, { type: "Normal", reason: "Killing", message: `Deleted ${kind} ${name}`, involvedKind: kind, involvedName: name });

    // A controller replaces deleted pods - the core lesson about controllers.
    if (kind === "Pod" && r.owners.length > 0) {
      const ownerRes = this.list(ns).find((x) => x.uid === r.owners[0].uid);
      if (ownerRes && r.status !== "Succeeded") {
        this.spawnPod(ns, r, r.owners[0], r.details.Node === "worker-1" ? "worker-2" : "worker-1");
        this.recount(ns);
        return {
          ok: true,
          message: `Deleted Pod ${ns}/${name} - its ${r.owners[0].kind} immediately created a replacement (that's what controllers do)`,
        };
      }
    }
    this.recount(ns);
    return { ok: true, message: `Deleted ${kind} ${ns}/${name}` };
  }

  async applyYaml(yaml: string, dryRun: boolean): Promise<ApplyResult> {
    // Demo mode: validate shape and report what would happen, without
    // building a full apiserver. Clearly labelled as simulated.
    const docs = yaml
      .split(/^---$/m)
      .map((d) => d.trim())
      .filter(Boolean);
    if (docs.length === 0) {
      return { ok: false, dryRun, results: [], error: "no YAML documents found" };
    }
    const results: string[] = [];
    for (const doc of docs) {
      const kind = /^kind:\s*(\S+)/m.exec(doc)?.[1];
      const name = /^\s{2,}name:\s*(\S+)/m.exec(doc)?.[1];
      if (!kind || !name) {
        return { ok: false, dryRun, results, error: "every document needs kind and metadata.name" };
      }
      results.push(`${kind}/${name} ${dryRun ? "would be applied" : "applied (demo: simulated, cluster state unchanged)"}`);
    }
    return { ok: true, dryRun, results };
  }

  async execCommand(req: ExecRequest): Promise<ExecResult> {
    const cmd = req.command.join(" ");
    const canned: Record<string, string> = {
      ls: "app\nbin\netc\nlib\ntmp\nusr\nvar",
      "ls /": "app\nbin\netc\nlib\ntmp\nusr\nvar",
      env: "PATH=/usr/local/bin:/usr/bin\nHOSTNAME=" + req.pod + "\nKUBERNETES_SERVICE_HOST=10.96.0.1\nNODE_ENV=production",
      hostname: req.pod,
      whoami: "app",
      "cat /etc/os-release": 'NAME="Alpine Linux"\nID=alpine\nVERSION_ID=3.20.2',
      ps: "PID   USER     COMMAND\n1     app      node server.js\n27    app      ps",
    };
    return {
      stdout: (canned[cmd] ?? `demo shell: simulated output for \`${cmd}\``) + "\n",
      stderr: "",
    };
  }

  async listPortForwards(): Promise<PortForwardInfo[]> {
    return [...this.forwards];
  }

  async startPortForward(req: PortForwardRequest): Promise<PortForwardInfo> {
    if (this.forwards.some((f) => f.localPort === req.localPort)) {
      throw new Error(`cannot listen on 127.0.0.1:${req.localPort} - the port is already in use`);
    }
    let targetPod = req.name;
    if (req.kind === "Service") {
      const svc = this.find(req.namespace, "Service", req.name);
      const pods = (this.snapshots[req.namespace] ?? []).filter(
        (p) =>
          p.kind === "Pod" &&
          p.status === "Running" &&
          svc?.selector &&
          Object.entries(svc.selector).every(([k, v]) => p.labels[k] === v),
      );
      if (pods.length === 0) throw new Error(`Service ${req.name} selects no running Pods to forward to`);
      targetPod = pods[0].name;
    }
    const info: PortForwardInfo = {
      id: `pf-${++this.forwardSeq}`,
      namespace: req.namespace,
      kind: req.kind,
      name: req.name,
      targetPod,
      localPort: req.localPort,
      remotePort: req.remotePort,
    };
    this.forwards.push(info);
    return info;
  }

  async stopPortForward(id: string): Promise<void> {
    this.forwards = this.forwards.filter((f) => f.id !== id);
  }
}

// --- demo YAML rendering -------------------------------------------------------

function yamlEscape(v: string): string {
  return /[:#{}[\],&*?|<>=!%@`"']/.test(v) || v.includes(" ") ? JSON.stringify(v) : v;
}

function demoYaml(r: ResourceSummary): string {
  const lines: string[] = [];
  const apiVersion: Record<string, string> = {
    Deployment: "apps/v1", ReplicaSet: "apps/v1", StatefulSet: "apps/v1", DaemonSet: "apps/v1",
    Job: "batch/v1", CronJob: "batch/v1",
    Ingress: "networking.k8s.io/v1", NetworkPolicy: "networking.k8s.io/v1",
    HorizontalPodAutoscaler: "autoscaling/v2", StorageClass: "storage.k8s.io/v1",
  };
  lines.push(`apiVersion: ${apiVersion[r.kind] ?? "v1"}`);
  lines.push(`kind: ${r.kind}`);
  lines.push("metadata:");
  lines.push(`  name: ${r.name}`);
  if (r.namespace) lines.push(`  namespace: ${r.namespace}`);
  lines.push(`  uid: ${r.uid}`);
  if (r.createdAt) lines.push(`  creationTimestamp: "${r.createdAt}"`);
  if (Object.keys(r.labels).length) {
    lines.push("  labels:");
    for (const [k, v] of Object.entries(r.labels)) lines.push(`    ${k}: ${yamlEscape(v)}`);
  }
  if (r.annotations && Object.keys(r.annotations).length) {
    lines.push("  annotations:");
    for (const [k, v] of Object.entries(r.annotations)) lines.push(`    ${k}: ${yamlEscape(v)}`);
  }
  if (r.owners.length) {
    lines.push("  ownerReferences:");
    for (const o of r.owners) {
      lines.push(`    - kind: ${o.kind}`);
      lines.push(`      name: ${o.name}`);
      lines.push(`      uid: ${o.uid}`);
      lines.push("      controller: true");
    }
  }
  if (r.kind === "Secret") {
    lines.push(`type: ${r.details.Type ?? "Opaque"}`);
    lines.push("data:");
    for (const key of (r.details.Keys ?? "").split(", ").filter(Boolean)) {
      lines.push(`  ${key}: «hidden - use the explicit reveal flow to view secret values»`);
    }
  } else if (r.kind === "ConfigMap") {
    lines.push("data:");
    const values = CONFIGMAP_VALUES[`${r.namespace}/${r.name}`] ?? {};
    for (const [k, v] of Object.entries(values)) {
      lines.push(`  ${k}: |`);
      for (const l of v.split("\n")) lines.push(`    ${l}`);
    }
  } else {
    lines.push("spec:");
    if (r.selector) {
      if (r.kind === "Service" || r.kind === "NetworkPolicy") {
        lines.push("  selector:");
        for (const [k, v] of Object.entries(r.selector)) lines.push(`    ${k}: ${yamlEscape(v)}`);
      } else {
        lines.push("  selector:");
        lines.push("    matchLabels:");
        for (const [k, v] of Object.entries(r.selector)) lines.push(`      ${k}: ${yamlEscape(v)}`);
      }
    }
    for (const [k, v] of Object.entries(r.details)) {
      const key = k.toLowerCase().replace(/[^a-z0-9]+(.)/g, (_, c: string) => c.toUpperCase());
      if (v.includes("\n")) {
        lines.push(`  ${key}: |`);
        for (const l of v.split("\n")) lines.push(`    ${l}`);
      } else {
        lines.push(`  # ${k}`);
        lines.push(`  ${key}: ${yamlEscape(v)}`);
      }
    }
  }
  lines.push("status:");
  lines.push(`  # summarized: ${r.status}`);
  return lines.join("\n") + "\n";
}

export const DEMO_DEFAULT_NAMESPACE = NS;
