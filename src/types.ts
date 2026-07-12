// Wire types shared with the Rust backend (src-tauri/core/src/model.rs).
// The two files are duplicated by design and must stay in sync.

export interface ContextInfo {
  name: string;
  cluster: string;
  user: string;
  current: boolean;
}

export interface ClusterInfo {
  context: string;
  server: string;
  version: string;
}

// --- cloud connect (EKS / AKS / GKE) -----------------------------------------
// Used only while discovering/importing cluster credentials via the user's
// own cloud CLI; the connection itself uses the normal kubeconfig path.

export type CloudKind = "aws" | "azure" | "gcp";

export interface CloudCliStatus {
  installed: boolean;
  authenticated: boolean;
  /** Active identity hint (account e-mail, profile count) - never a secret. */
  account?: string;
  /** Human guidance when something is missing (install / login command). */
  detail?: string;
}

/** One selectable scope: an AWS profile, an Azure subscription, a GCP project. */
export interface CloudScope {
  id: string;
  label: string;
  detail?: string;
  default: boolean;
}

export interface CloudCluster {
  name: string;
  /** Region, region/zone, or Azure location. */
  location: string;
  /** Azure resource group (needed again at import time). */
  group?: string;
  detail?: string;
}

export interface CloudImportOutcome {
  /** The kubeconfig context the CLI created/updated - connect with this. */
  context: string;
}

export interface NodeInfo {
  name: string;
  roles: string[];
  ready: boolean;
  version: string;
  osImage: string;
  cpu: string;
  memory: string;
}

export interface ConditionInfo {
  type: string;
  status: string;
  reason?: string;
  message?: string;
}

/** One pod as seen from a node (placement view). */
export interface NodePodInfo {
  namespace: string;
  name: string;
  status: string;
  health: Health;
}

export interface NodeDetail extends NodeInfo {
  unschedulable?: boolean;
  internalIp?: string;
  runtime?: string;
  allocatableCpu?: string;
  allocatableMemory?: string;
  taints: string[];
  labels: Record<string, string>;
  conditions: ConditionInfo[];
  pods: NodePodInfo[];
}

export interface NamespaceInfo {
  name: string;
  status: string;
  podCount: number;
  createdAt?: string;
}

export interface ClusterOverview {
  version: string;
  nodes: NodeInfo[];
  namespaces: NamespaceInfo[];
  podCount: number;
  failingPods: number;
  warningEvents: number;
}

export interface OwnerRef {
  kind: string;
  name: string;
  uid: string;
}

/** Drives the status color; the status text is always shown next to it. */
export type Health = "good" | "warning" | "serious" | "critical" | "neutral";

export type Kind =
  | "Pod"
  | "Deployment"
  | "ReplicaSet"
  | "StatefulSet"
  | "DaemonSet"
  | "Job"
  | "CronJob"
  | "Service"
  | "Ingress"
  | "ConfigMap"
  | "Secret"
  | "PersistentVolumeClaim"
  | "PersistentVolume"
  | "StorageClass"
  | "HorizontalPodAutoscaler"
  | "NetworkPolicy"
  | "Node";

export interface ContainerInfo {
  name: string;
  image: string;
  ready: boolean;
  restarts: number;
  /** e.g. "Running", "Waiting: CrashLoopBackOff", "Terminated: Error (exit 1)" */
  state: string;
  /** Last termination summary, e.g. "Error (exit 1), 2m ago". */
  lastState?: string;
  ports: number[];
  init?: boolean;
  /** Resource requests/limits as written in the spec ("250m", "128Mi"). */
  cpuRequest?: string;
  memoryRequest?: string;
  cpuLimit?: string;
  memoryLimit?: string;
}

export interface ServicePortInfo {
  port: number;
  targetPort?: string;
  protocol?: string;
  nodePort?: number;
}

export interface ResourceSummary {
  uid: string;
  kind: Kind;
  name: string;
  namespace: string;
  owners: OwnerRef[];
  labels: Record<string, string>;
  annotations?: Record<string, string>;
  status: string;
  health: Health;
  /** ISO creation timestamp; used for age display. */
  createdAt?: string;
  details: Record<string, string>;
  selector?: Record<string, string>;
  /** "Kind/name" references (Ingress -> Service, Pod -> ConfigMap/Secret/PVC, PVC -> PV, ...). */
  refs?: string[];
  /** Pods only: per-container status. */
  containers?: ContainerInfo[];
  /** Services only: structured port spec, for endpoint/port diagnostics. */
  servicePorts?: ServicePortInfo[];
  conditions?: ConditionInfo[];
}

export interface NamespaceSnapshot {
  namespace: string;
  resources: ResourceSummary[];
  /** Per-kind list failures (e.g. RBAC denials) behind a partial snapshot. */
  warnings?: string[];
}

// --- events ----------------------------------------------------------------

export interface EventInfo {
  type: "Normal" | "Warning";
  reason: string;
  message: string;
  involvedKind: string;
  involvedName: string;
  count: number;
  firstSeen?: string;
  lastSeen?: string;
}

// --- logs ------------------------------------------------------------------

export interface LogQuery {
  namespace: string;
  pod: string;
  container?: string;
  previous?: boolean;
  tailLines?: number;
  sinceSeconds?: number;
  timestamps?: boolean;
}

// --- metrics ---------------------------------------------------------------

export interface ContainerMetrics {
  name: string;
  cpuMillis: number;
  memoryBytes: number;
}

export interface PodMetrics {
  namespace: string;
  name: string;
  cpuMillis: number;
  memoryBytes: number;
  containers: ContainerMetrics[];
}

export interface NodeMetrics {
  name: string;
  cpuMillis: number;
  memoryBytes: number;
}

export interface MetricsSnapshot {
  available: boolean;
  /** Why metrics are unavailable (e.g. metrics-server not installed). */
  reason?: string;
  nodes: NodeMetrics[];
  pods: PodMetrics[];
}

// --- secrets & config ------------------------------------------------------

export interface SecretKey {
  name: string;
  /** Decoded value; absent when the value is binary (not valid UTF-8). */
  value?: string;
  binary: boolean;
  bytes: number;
}

// --- RBAC ------------------------------------------------------------------

export interface AccessCheck {
  verb: string;
  /** Plural resource, e.g. "deployments". */
  resource: string;
  group?: string;
  namespace?: string;
}

export interface AccessResult {
  check: AccessCheck;
  allowed: boolean;
  reason?: string;
}

// --- actions ---------------------------------------------------------------

export type Action =
  | { type: "scaleWorkload"; kind: Kind; namespace: string; name: string; replicas: number }
  | { type: "restartRollout"; kind: Kind; namespace: string; name: string }
  | { type: "rollbackDeployment"; namespace: string; name: string; toRevision?: number }
  | { type: "pauseRollout"; namespace: string; name: string; pause: boolean }
  | { type: "suspendCronJob"; namespace: string; name: string; suspend: boolean }
  | { type: "triggerCronJob"; namespace: string; name: string }
  | { type: "deleteResource"; kind: Kind; namespace: string; name: string; uid: string }
  | { type: "cordonNode"; name: string; cordon: boolean };

export interface ActionResult {
  ok: boolean;
  message: string;
}

export interface ApplyResult {
  ok: boolean;
  dryRun: boolean;
  /** One line per document, e.g. "deployment.apps/api configured". */
  results: string[];
  error?: string;
}

export interface ExecRequest {
  namespace: string;
  pod: string;
  container?: string;
  command: string[];
}

export interface ExecResult {
  stdout: string;
  stderr: string;
}

// --- port-forward ----------------------------------------------------------

export interface PortForwardRequest {
  namespace: string;
  /** "Pod" or "Service" */
  kind: string;
  name: string;
  localPort: number;
  remotePort: number;
}

export interface PortForwardInfo {
  id: string;
  namespace: string;
  kind: string;
  name: string;
  /** Pod actually forwarded to (resolved from the Service when kind is Service). */
  targetPod: string;
  localPort: number;
  remotePort: number;
}

// --- rollout history ---------------------------------------------------------

export interface RolloutRevision {
  revision: number;
  replicaSet: string;
  images: string[];
  ready: number;
  desired: number;
  current: boolean;
}

// --- Helm --------------------------------------------------------------------

export interface HelmStatus {
  installed: boolean;
  version?: string;
  detail?: string;
}

export interface HelmRelease {
  name: string;
  namespace: string;
  revision: number;
  updated: string;
  /** deployed | failed | pending-install | pending-upgrade | pending-rollback | superseded | uninstalled */
  status: string;
  /** "chartname-1.2.3" */
  chart: string;
  appVersion: string;
}

export interface HelmRevision {
  revision: number;
  updated: string;
  status: string;
  chart: string;
  appVersion: string;
  description: string;
}

/** Release detail WITHOUT values: values commonly contain credentials, so
 *  they are fetched only by the explicit `helmReleaseValues` call. */
export interface HelmReleaseDetail {
  manifest: string;
  notes: string;
  history: HelmRevision[];
}

export interface HelmRepo {
  name: string;
  url: string;
}

export interface HelmChartHit {
  name: string;
  version: string;
  appVersion: string;
  description: string;
}

export type HelmActionRequest =
  | { op: "install"; namespace: string; release: string; chart: string; values?: string }
  | { op: "upgrade"; namespace: string; release: string; chart: string; values?: string }
  | { op: "rollback"; namespace: string; release: string; revision: number }
  | { op: "uninstall"; namespace: string; release: string };

// --- provider ----------------------------------------------------------------

export interface ResourceRef {
  kind: string;
  namespace: string;
  name: string;
}

/**
 * A data source for the app: either the live Tauri backend or the built-in
 * demo cluster. One interface so every view works against both.
 *
 * Read paths never mutate the cluster. Mutating paths (`performAction`,
 * `applyYaml`, `execCommand`) are only reachable through the management-mode
 * confirmation flow in the UI.
 */
export interface ClusterProvider {
  readonly mode: "live" | "demo";
  listContexts(): Promise<ContextInfo[]>;
  connect(context?: string): Promise<ClusterInfo>;
  disconnect(): Promise<void>;

  getOverview(): Promise<ClusterOverview>;
  getSnapshot(namespace: string): Promise<NamespaceSnapshot>;
  getNodes(): Promise<NodeDetail[]>;
  getEvents(namespace: string): Promise<EventInfo[]>;
  getMetrics(namespace: string): Promise<MetricsSnapshot>;
  /** "ns/name" of a Prometheus Service if one exists (optional enhancement). */
  detectPrometheus(): Promise<string | null>;
  helmStatus(): Promise<HelmStatus>;
  helmReleases(namespace?: string): Promise<HelmRelease[]>;
  helmReleaseDetail(namespace: string, name: string): Promise<HelmReleaseDetail>;
  /** Explicit, separate fetch - release values commonly contain credentials. */
  helmReleaseValues(namespace: string, name: string): Promise<string>;
  helmRepos(): Promise<HelmRepo[]>;
  helmSearch(query: string): Promise<HelmChartHit[]>;
  helmShow(kind: "values" | "chart" | "readme", chart: string): Promise<string>;
  /** Repo management (local helm config) - management mode only in the UI. */
  helmRepoModify(op: "add" | "remove" | "update", name?: string, url?: string): Promise<string>;
  /** Cluster-mutating - management mode + confirmation only. */
  helmAction(request: HelmActionRequest): Promise<string>;
  getYaml(ref: ResourceRef): Promise<string>;
  getLogs(query: LogQuery): Promise<string>;
  /** Follow logs; resolves to a stop function. */
  streamLogs(query: LogQuery, onLine: (line: string) => void): Promise<() => void>;
  getConfigMapData(namespace: string, name: string): Promise<Record<string, string>>;
  /** Explicit, confirmed reveal only - values are never fetched implicitly. */
  revealSecret(namespace: string, name: string): Promise<SecretKey[]>;
  getRolloutHistory(namespace: string, name: string): Promise<RolloutRevision[]>;
  checkAccess(checks: AccessCheck[]): Promise<AccessResult[]>;

  performAction(action: Action): Promise<ActionResult>;
  applyYaml(yaml: string, dryRun: boolean, defaultNamespace: string): Promise<ApplyResult>;
  execCommand(req: ExecRequest): Promise<ExecResult>;

  listPortForwards(): Promise<PortForwardInfo[]>;
  startPortForward(req: PortForwardRequest): Promise<PortForwardInfo>;
  stopPortForward(id: string): Promise<void>;
}
