//! Wire types shared with the frontend (serialized as camelCase JSON).
//! Mirrors `src/types.ts` - the two files must stay in sync.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ContextInfo {
    pub name: String,
    pub cluster: String,
    pub user: String,
    pub current: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ClusterInfo {
    pub context: String,
    pub server: String,
    pub version: String,
}

// --- cloud connect (EKS / AKS / GKE) ----------------------------------------
// Only used while discovering/importing cluster credentials via the user's
// own cloud CLI; everything after import goes through the normal kubeconfig
// path above.

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CloudKind {
    Aws,
    Azure,
    Gcp,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct CloudCliStatus {
    pub installed: bool,
    pub authenticated: bool,
    /// Active identity hint (account e-mail, subscription user) - never a secret.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    /// Human guidance when something is missing (install / login command).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// One selectable scope: an AWS profile, an Azure subscription, a GCP project.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CloudScope {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub default: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CloudCluster {
    pub name: String,
    /// Region, region/zone, or Azure location.
    pub location: String,
    /// Azure resource group (needed again at import time).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CloudImportOutcome {
    /// The kubeconfig context the CLI created/updated - connect with this.
    pub context: String,
}

// --- Helm (releases/charts via the user's own helm binary) -------------------

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct HelmStatus {
    pub installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HelmRelease {
    pub name: String,
    pub namespace: String,
    pub revision: i64,
    pub updated: String,
    /// deployed | failed | pending-install | pending-upgrade | pending-rollback | superseded | uninstalled
    pub status: String,
    /// "chartname-1.2.3"
    pub chart: String,
    pub app_version: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HelmRevision {
    pub revision: i64,
    pub updated: String,
    pub status: String,
    pub chart: String,
    pub app_version: String,
    pub description: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
/// Release detail WITHOUT values: values commonly contain credentials, so
/// they are served only by the explicit `helm_release_values` command.
pub struct HelmReleaseDetail {
    pub manifest: String,
    pub notes: String,
    pub history: Vec<HelmRevision>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HelmRepo {
    pub name: String,
    pub url: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HelmChartHit {
    pub name: String,
    pub version: String,
    pub app_version: String,
    pub description: String,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct NodeInfo {
    pub name: String,
    pub roles: Vec<String>,
    pub ready: bool,
    pub version: String,
    pub os_image: String,
    pub cpu: String,
    pub memory: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConditionInfo {
    pub r#type: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NodePodInfo {
    pub namespace: String,
    pub name: String,
    pub status: String,
    pub health: Health,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NodeDetail {
    #[serde(flatten)]
    pub info: NodeInfo,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unschedulable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub internal_ip: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allocatable_cpu: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allocatable_memory: Option<String>,
    pub taints: Vec<String>,
    pub labels: BTreeMap<String, String>,
    pub conditions: Vec<ConditionInfo>,
    pub pods: Vec<NodePodInfo>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NamespaceInfo {
    pub name: String,
    pub status: String,
    pub pod_count: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ClusterOverview {
    pub version: String,
    pub nodes: Vec<NodeInfo>,
    pub namespaces: Vec<NamespaceInfo>,
    pub pod_count: u32,
    pub failing_pods: u32,
    pub warning_events: u32,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OwnerRef {
    pub kind: String,
    pub name: String,
    pub uid: String,
}

/// Health drives the status color in the UI; it never carries meaning alone
/// (the `status` text is always shown next to it).
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Health {
    Good,
    Warning,
    Serious,
    Critical,
    Neutral,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ContainerInfo {
    pub name: String,
    pub image: String,
    pub ready: bool,
    pub restarts: i32,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_state: Option<String>,
    pub ports: Vec<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub init: Option<bool>,
    /// Resource requests/limits as written in the spec ("250m", "128Mi").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_request: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_request: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_limit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_limit: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ServicePortInfo {
    pub port: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_port: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_port: Option<i32>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ResourceSummary {
    pub uid: String,
    pub kind: String,
    pub name: String,
    pub namespace: String,
    pub owners: Vec<OwnerRef>,
    pub labels: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub annotations: Option<BTreeMap<String, String>>,
    /// Human-readable status, e.g. "Running", "2/3 ready", "Bound".
    pub status: String,
    pub health: Health,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    /// Key facts shown in the details panel (image, node, IPs, ports, ...).
    pub details: BTreeMap<String, String>,
    /// Label selector (Services and workload controllers) used to draw
    /// selector edges in the graph.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selector: Option<BTreeMap<String, String>>,
    /// References to other resources, as "Kind/name" strings
    /// (Ingress -> Service, Pod -> ConfigMap/Secret/PVC, PVC -> PV, ...).
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub refs: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub containers: Option<Vec<ContainerInfo>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service_ports: Option<Vec<ServicePortInfo>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conditions: Option<Vec<ConditionInfo>>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NamespaceSnapshot {
    pub namespace: String,
    pub resources: Vec<ResourceSummary>,
    /// Per-kind list failures (e.g. RBAC denials). A partial snapshot with an
    /// honest warning beats an all-or-nothing error for least-privilege users.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

// --- events ------------------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EventInfo {
    /// "Normal" or "Warning".
    pub r#type: String,
    pub reason: String,
    pub message: String,
    pub involved_kind: String,
    pub involved_name: String,
    pub count: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_seen: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen: Option<String>,
}

// --- logs --------------------------------------------------------------------

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LogQuery {
    pub namespace: String,
    pub pod: String,
    #[serde(default)]
    pub container: Option<String>,
    #[serde(default)]
    pub previous: Option<bool>,
    #[serde(default)]
    pub tail_lines: Option<i64>,
    #[serde(default)]
    pub since_seconds: Option<i64>,
    #[serde(default)]
    pub timestamps: Option<bool>,
}

// --- metrics -------------------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ContainerMetrics {
    pub name: String,
    pub cpu_millis: u64,
    pub memory_bytes: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PodMetrics {
    pub namespace: String,
    pub name: String,
    pub cpu_millis: u64,
    pub memory_bytes: u64,
    pub containers: Vec<ContainerMetrics>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NodeMetrics {
    pub name: String,
    pub cpu_millis: u64,
    pub memory_bytes: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MetricsSnapshot {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub nodes: Vec<NodeMetrics>,
    pub pods: Vec<PodMetrics>,
}

// --- secrets -------------------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SecretKey {
    pub name: String,
    /// Decoded value; absent when the value is binary (not valid UTF-8).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    pub binary: bool,
    pub bytes: usize,
}

// --- RBAC ------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AccessCheck {
    pub verb: String,
    pub resource: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AccessResult {
    pub check: AccessCheck,
    pub allowed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

// --- actions -----------------------------------------------------------------

#[derive(Deserialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Action {
    #[serde(rename_all = "camelCase")]
    ScaleWorkload {
        kind: String,
        namespace: String,
        name: String,
        replicas: i32,
    },
    #[serde(rename_all = "camelCase")]
    RestartRollout {
        kind: String,
        namespace: String,
        name: String,
    },
    #[serde(rename_all = "camelCase")]
    RollbackDeployment {
        namespace: String,
        name: String,
        #[serde(default)]
        to_revision: Option<i64>,
    },
    #[serde(rename_all = "camelCase")]
    PauseRollout {
        namespace: String,
        name: String,
        pause: bool,
    },
    #[serde(rename_all = "camelCase")]
    SuspendCronJob {
        namespace: String,
        name: String,
        suspend: bool,
    },
    #[serde(rename_all = "camelCase")]
    TriggerCronJob { namespace: String, name: String },
    #[serde(rename_all = "camelCase")]
    DeleteResource {
        kind: String,
        namespace: String,
        name: String,
        /// UID of the object the user confirmed. Sent as a Kubernetes delete
        /// precondition: if the object was deleted and recreated under the
        /// same name in the meantime, the delete fails instead of hitting
        /// the impostor.
        uid: String,
    },
    #[serde(rename_all = "camelCase")]
    CordonNode { name: String, cordon: bool },
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    pub ok: bool,
    pub message: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub ok: bool,
    pub dry_run: bool,
    /// One line per document, e.g. "deployment.apps/api configured".
    pub results: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExecRequest {
    pub namespace: String,
    pub pod: String,
    #[serde(default)]
    pub container: Option<String>,
    pub command: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    pub stdout: String,
    pub stderr: String,
}

// --- port-forward ---------------------------------------------------------------

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardRequest {
    pub namespace: String,
    /// "Pod" or "Service"
    pub kind: String,
    pub name: String,
    pub local_port: u16,
    pub remote_port: u16,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardInfo {
    pub id: String,
    pub namespace: String,
    pub kind: String,
    pub name: String,
    pub target_pod: String,
    pub local_port: u16,
    pub remote_port: u16,
}

// --- rollout history --------------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RolloutRevision {
    pub revision: i64,
    pub replica_set: String,
    pub images: Vec<String>,
    pub ready: i32,
    pub desired: i32,
    pub current: bool,
}
