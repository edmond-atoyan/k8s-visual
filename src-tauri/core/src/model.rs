//! Wire types shared with the frontend (serialized as camelCase JSON).

use serde::Serialize;
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

#[derive(Serialize, Clone, Debug)]
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
pub struct NamespaceInfo {
    pub name: String,
    pub status: String,
    pub pod_count: u32,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ClusterOverview {
    pub version: String,
    pub nodes: Vec<NodeInfo>,
    pub namespaces: Vec<NamespaceInfo>,
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
pub struct ResourceSummary {
    pub uid: String,
    pub kind: String,
    pub name: String,
    pub namespace: String,
    pub owners: Vec<OwnerRef>,
    pub labels: BTreeMap<String, String>,
    /// Human-readable status, e.g. "Running", "2/3 ready", "Bound".
    pub status: String,
    pub health: Health,
    /// Key facts shown in the details panel (image, node, IPs, ports, ...).
    pub details: BTreeMap<String, String>,
    /// Label selector (Services and workload controllers) used to draw
    /// selector edges in the graph.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selector: Option<BTreeMap<String, String>>,
    /// References to other resources, as "Kind/name" strings
    /// (Ingress -> Service, Pod -> ConfigMap/Secret/PVC).
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub refs: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NamespaceSnapshot {
    pub namespace: String,
    pub resources: Vec<ResourceSummary>,
}
