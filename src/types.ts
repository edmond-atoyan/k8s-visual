// Wire types shared with the Rust backend (src-tauri/core/src/model.rs).

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

export interface NodeInfo {
  name: string;
  roles: string[];
  ready: boolean;
  version: string;
  osImage: string;
  cpu: string;
  memory: string;
}

export interface NamespaceInfo {
  name: string;
  status: string;
  podCount: number;
}

export interface ClusterOverview {
  version: string;
  nodes: NodeInfo[];
  namespaces: NamespaceInfo[];
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
  | "PersistentVolumeClaim";

export interface ResourceSummary {
  uid: string;
  kind: Kind;
  name: string;
  namespace: string;
  owners: OwnerRef[];
  labels: Record<string, string>;
  status: string;
  health: Health;
  details: Record<string, string>;
  selector?: Record<string, string>;
  /** "Kind/name" references (Ingress -> Service, Pod -> ConfigMap/Secret/PVC). */
  refs?: string[];
}

export interface NamespaceSnapshot {
  namespace: string;
  resources: ResourceSummary[];
}

/**
 * A data source for the app: either the live Tauri backend or the built-in
 * demo cluster. One interface so every view works against both.
 */
export interface ClusterProvider {
  readonly mode: "live" | "demo";
  listContexts(): Promise<ContextInfo[]>;
  connect(context?: string): Promise<ClusterInfo>;
  disconnect(): Promise<void>;
  getOverview(): Promise<ClusterOverview>;
  getSnapshot(namespace: string): Promise<NamespaceSnapshot>;
}
