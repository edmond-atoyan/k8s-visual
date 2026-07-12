//! Kubernetes bridge for K8s Visual.
//!
//! Connects to a cluster through the user's kubeconfig and condenses live
//! resources into small, UI-friendly summaries ([`model`]).
//!
//! Safety model: every read path is strictly read-only, Secret values are
//! only decoded by the explicit [`Bridge::reveal_secret`] call, and every
//! mutating operation lives in [`actions`] / [`yaml`] behind a single
//! [`Bridge::perform_action`] / [`Bridge::apply_yaml`] entry point - nothing
//! else in this crate writes to the cluster.

pub mod actions;
pub mod cloud;
pub mod events;
pub mod exec;
pub mod helm;
pub mod logs;
pub mod metrics;
pub mod model;
pub mod portforward;
pub mod rbac;
pub mod summaries;
pub mod yaml;

use std::collections::BTreeMap;
use std::time::Duration;

use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, ReplicaSet, StatefulSet};
use k8s_openapi::api::autoscaling::v2::HorizontalPodAutoscaler;
use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::core::v1::{
    ConfigMap, Namespace, Node, PersistentVolume, PersistentVolumeClaim, Pod, Secret, Service,
};
use k8s_openapi::api::networking::v1::{Ingress, NetworkPolicy};
use k8s_openapi::api::storage::v1::StorageClass;
use kube::api::{Api, ListParams};
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::{Client, Config, ResourceExt};

use model::*;
use summaries::*;

#[derive(thiserror::Error, Debug)]
pub enum Error {
    #[error("could not read kubeconfig: {0}")]
    Kubeconfig(String),
    #[error("could not connect to cluster: {0}")]
    Connect(String),
    #[error("cluster request failed: {0}")]
    Request(#[from] kube::Error),
    #[error("{0}")]
    Invalid(String),
}

pub type Result<T> = std::result::Result<T, Error>;

/// Truncate on a char boundary - `String::truncate` at a byte index panics
/// mid-UTF-8, and CLI error output is not guaranteed to be ASCII.
pub(crate) fn truncate_utf8(msg: &mut String, max: usize) {
    if msg.len() > max {
        let mut end = max;
        while !msg.is_char_boundary(end) {
            end -= 1;
        }
        msg.truncate(end);
    }
}

/// Short, honest reason for a failed per-kind list: an RBAC denial reads as
/// "forbidden", not as a wall of API error text.
fn short_list_error(e: &kube::Error) -> String {
    match e {
        kube::Error::Api(ae) if ae.code == 403 => {
            "forbidden - your role cannot list this kind here".to_string()
        }
        kube::Error::Api(ae) => format!("{} ({})", ae.reason, ae.code),
        other => other.to_string(),
    }
}

/// List the contexts available in the user's kubeconfig without connecting.
pub fn list_contexts() -> Result<Vec<ContextInfo>> {
    let kubeconfig = Kubeconfig::read().map_err(|e| Error::Kubeconfig(e.to_string()))?;
    let current = kubeconfig.current_context.clone().unwrap_or_default();
    Ok(kubeconfig
        .contexts
        .iter()
        .map(|named| {
            let ctx = named.context.as_ref();
            ContextInfo {
                name: named.name.clone(),
                cluster: ctx.map(|c| c.cluster.clone()).unwrap_or_default(),
                user: ctx.and_then(|c| c.user.clone()).unwrap_or_default(),
                current: named.name == current,
            }
        })
        .collect())
}

/// Reduce a kubeconfig to ONLY the given context, its cluster, and its user,
/// with the context's default namespace set. The pinned file must carry no
/// other identities: it is written to disk for the integrated terminal, and
/// a copy of the full merged kubeconfig would widen the blast radius of any
/// file exposure for no benefit.
fn pin_kubeconfig(full: Kubeconfig, context: &str, namespace: Option<&str>) -> Result<Kubeconfig> {
    let named = full
        .contexts
        .iter()
        .find(|c| c.name == context)
        .cloned()
        .ok_or_else(|| Error::Invalid(format!("context \"{context}\" not found in kubeconfig")))?;
    let mut ctx = named
        .context
        .ok_or_else(|| Error::Invalid(format!("context \"{context}\" has no body")))?;
    if let Some(ns) = namespace {
        ctx.namespace = Some(ns.to_string());
    }
    let cluster = full
        .clusters
        .iter()
        .find(|c| c.name == ctx.cluster)
        .cloned()
        .ok_or_else(|| {
            Error::Invalid(format!(
                "cluster \"{}\" referenced by context \"{context}\" not found",
                ctx.cluster
            ))
        })?;
    let auth = ctx
        .user
        .as_ref()
        .and_then(|user| full.auth_infos.iter().find(|a| &a.name == user).cloned());
    Ok(Kubeconfig {
        current_context: Some(context.to_string()),
        contexts: vec![kube::config::NamedContext {
            name: context.to_string(),
            context: Some(ctx),
            ..Default::default()
        }],
        clusters: vec![cluster],
        auth_infos: auth.into_iter().collect(),
        ..Default::default()
    })
}

/// Write a kubeconfig for one integrated-terminal session: minimal identity
/// (see [`pin_kubeconfig`]), random unpredictable filename, created
/// atomically with `O_EXCL` and mode 0600 (so a pre-created file or symlink
/// at the path fails the open instead of being followed). kubectl and helm
/// have no environment variable for the context itself, so a pinned file is
/// the only way to make shell tools agree with the app's connection. The
/// caller owns the file's lifetime and must delete it when the session ends.
pub fn write_pinned_kubeconfig(
    context: &str,
    namespace: Option<&str>,
) -> Result<std::path::PathBuf> {
    let full = Kubeconfig::read().map_err(|e| Error::Kubeconfig(e.to_string()))?;
    let pinned = pin_kubeconfig(full, context, namespace)?;
    write_session_kubeconfig(&pinned)
}

/// An empty kubeconfig (no contexts, no credentials) for shells opened while
/// no real cluster is connected (demo mode). Without it the shell would
/// inherit the user's real kubeconfig - a "demo" terminal must never be able
/// to silently target a real cluster.
pub fn write_empty_kubeconfig() -> Result<std::path::PathBuf> {
    write_session_kubeconfig(&Kubeconfig::default())
}

fn write_session_kubeconfig(cfg: &Kubeconfig) -> Result<std::path::PathBuf> {
    use std::io::Write;

    let dir = std::env::var_os("XDG_RUNTIME_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("k8s-visual");
    std::fs::create_dir_all(&dir)
        .map_err(|e| Error::Invalid(format!("cannot create {}: {e}", dir.display())))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| Error::Invalid(format!("cannot secure {}: {e}", dir.display())))?;
    }
    // Best-effort prune of files a crashed session left behind (a live
    // session's file is younger than this by definition).
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let stale = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age.as_secs() > 24 * 3600);
            if stale {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }

    // Unpredictable name from the OS CSPRNG - the path must not be guessable.
    let mut random = [0u8; 16];
    std::io::Read::read_exact(
        &mut std::fs::File::open("/dev/urandom")
            .map_err(|e| Error::Invalid(format!("cannot open /dev/urandom: {e}")))?,
        &mut random,
    )
    .map_err(|e| Error::Invalid(format!("cannot read /dev/urandom: {e}")))?;
    let hex: String = random.iter().map(|b| format!("{b:02x}")).collect();
    let path = dir.join(format!("kubeconfig-{hex}.yaml"));

    let yaml = serde_yaml::to_string(cfg)
        .map_err(|e| Error::Invalid(format!("could not encode kubeconfig: {e}")))?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&path)
        .map_err(|e| Error::Invalid(format!("cannot create {}: {e}", path.display())))?;
    file.write_all(yaml.as_bytes())
        .map_err(|e| Error::Invalid(format!("cannot write {}: {e}", path.display())))?;
    Ok(path)
}

/// A live connection to one cluster. Cloning is cheap (the kube client is
/// reference-counted) - callers clone it out of shared state instead of
/// holding a lock across network awaits.
#[derive(Clone)]
pub struct Bridge {
    pub(crate) client: Client,
    pub info: ClusterInfo,
}

impl Bridge {
    /// Connect using the given kubeconfig context (or the current one).
    pub async fn connect(context: Option<String>) -> Result<Self> {
        let options = KubeConfigOptions {
            context: context.clone(),
            ..Default::default()
        };
        let mut config = Config::from_kubeconfig(&options)
            .await
            .map_err(|e| Error::Kubeconfig(e.to_string()))?;
        config.connect_timeout = Some(Duration::from_secs(5));
        config.read_timeout = Some(Duration::from_secs(15));
        let server = config.cluster_url.to_string();
        let client = Client::try_from(config).map_err(|e| Error::Connect(e.to_string()))?;
        let version = client
            .apiserver_version()
            .await
            .map_err(|e| Error::Connect(e.to_string()))?;
        let context_name = match context {
            Some(name) => name,
            None => Kubeconfig::read()
                .ok()
                .and_then(|k| k.current_context)
                .unwrap_or_default(),
        };
        Ok(Self {
            client,
            info: ClusterInfo {
                context: context_name,
                server,
                version: version.git_version,
            },
        })
    }

    pub fn client(&self) -> Client {
        self.client.clone()
    }

    /// Nodes, namespaces and health counters - the top of the hierarchy.
    pub async fn overview(&self) -> Result<ClusterOverview> {
        let lp = ListParams::default();
        let nodes = Api::<Node>::all(self.client.clone()).list(&lp).await?;
        let namespaces = Api::<Namespace>::all(self.client.clone()).list(&lp).await?;
        let pods = Api::<Pod>::all(self.client.clone()).list(&lp).await?;
        // Cheap cluster-wide warning signal; capped so huge clusters stay fast.
        let warning_events = Api::<k8s_openapi::api::core::v1::Event>::all(self.client.clone())
            .list(&ListParams::default().fields("type=Warning").limit(500))
            .await
            .map(|l| l.items.len() as u32)
            .unwrap_or(0);

        let mut pods_per_ns: BTreeMap<String, u32> = BTreeMap::new();
        let mut failing = 0u32;
        for pod in &pods.items {
            *pods_per_ns
                .entry(pod.namespace().unwrap_or_default())
                .or_default() += 1;
            let summary = pod_summary(pod);
            if summary.health == Health::Critical {
                failing += 1;
            }
        }

        Ok(ClusterOverview {
            version: self.info.version.clone(),
            nodes: nodes.items.iter().map(node_info).collect(),
            namespaces: namespaces
                .items
                .iter()
                .map(|ns| {
                    let name = ns.name_any();
                    NamespaceInfo {
                        pod_count: pods_per_ns.get(&name).copied().unwrap_or(0),
                        status: ns
                            .status
                            .as_ref()
                            .and_then(|s| s.phase.clone())
                            .unwrap_or_else(|| "Active".into()),
                        created_at: ns
                            .metadata
                            .creation_timestamp
                            .as_ref()
                            .map(|t| t.0.to_string()),
                        name,
                    }
                })
                .collect(),
            pod_count: pods.items.len() as u32,
            failing_pods: failing,
            warning_events,
        })
    }

    /// Everything the graph needs for one namespace, in a single call.
    /// A kind whose list fails (usually RBAC) is skipped and reported in
    /// `warnings` - a partial snapshot beats an all-or-nothing error.
    pub async fn snapshot(&self, namespace: &str) -> Result<NamespaceSnapshot> {
        let lp = ListParams::default();
        let c = &self.client;
        macro_rules! list {
            ($ty:ty) => {
                async { Api::<$ty>::namespaced(c.clone(), namespace).list(&lp).await }
            };
        }
        // Fetch all resource kinds concurrently.
        let (pods, deployments, replicasets, statefulsets, daemonsets, jobs) = tokio::join!(
            list!(Pod),
            list!(Deployment),
            list!(ReplicaSet),
            list!(StatefulSet),
            list!(DaemonSet),
            list!(Job),
        );
        let (cronjobs, services, ingresses, configmaps, secrets, pvcs) = tokio::join!(
            list!(CronJob),
            list!(Service),
            list!(Ingress),
            list!(ConfigMap),
            list!(Secret),
            list!(PersistentVolumeClaim),
        );
        // HPA / NetworkPolicy may not exist on very old clusters; treat as empty.
        let hpas = Api::<HorizontalPodAutoscaler>::namespaced(c.clone(), namespace)
            .list(&lp)
            .await
            .map(|l| l.items)
            .unwrap_or_default();
        let netpols = Api::<NetworkPolicy>::namespaced(c.clone(), namespace)
            .list(&lp)
            .await
            .map(|l| l.items)
            .unwrap_or_default();

        let mut resources: Vec<ResourceSummary> = Vec::new();
        let mut warnings: Vec<String> = Vec::new();
        // Unwrap one kind's list result: extend resources or record why the
        // kind is missing, so "forbidden" never silently looks like "empty".
        macro_rules! take {
            ($res:expr, $kind:literal, $mapper:expr) => {
                match $res {
                    Ok(list) => {
                        resources.extend(list.items.iter().map($mapper));
                        Some(list)
                    }
                    Err(e) => {
                        warnings.push(format!("{}: {}", $kind, short_list_error(&e)));
                        None
                    }
                }
            };
        }
        take!(pods, "Pods", pod_summary);
        take!(deployments, "Deployments", deployment_summary);
        take!(replicasets, "ReplicaSets", replicaset_summary);
        take!(statefulsets, "StatefulSets", statefulset_summary);
        take!(daemonsets, "DaemonSets", daemonset_summary);
        take!(jobs, "Jobs", job_summary);
        take!(cronjobs, "CronJobs", cronjob_summary);
        take!(services, "Services", service_summary);
        take!(ingresses, "Ingresses", ingress_summary);
        take!(configmaps, "ConfigMaps", configmap_summary);
        take!(secrets, "Secrets", secret_summary);
        let pvcs = take!(pvcs, "PersistentVolumeClaims", pvc_summary);
        resources.extend(hpas.iter().map(hpa_summary));
        resources.extend(netpols.iter().map(networkpolicy_summary));

        // PVs and StorageClasses are cluster-scoped; include the ones this
        // namespace's claims actually bind to, so the storage chain is visible.
        let bound_pvs: Vec<String> = pvcs
            .as_ref()
            .map(|list| {
                list.items
                    .iter()
                    .filter_map(|p| p.spec.as_ref().and_then(|s| s.volume_name.clone()))
                    .collect()
            })
            .unwrap_or_default();
        if !bound_pvs.is_empty() {
            if let Ok(pvs) = Api::<PersistentVolume>::all(c.clone()).list(&lp).await {
                let used: Vec<&PersistentVolume> = pvs
                    .items
                    .iter()
                    .filter(|pv| bound_pvs.contains(&pv.name_any()))
                    .collect();
                let classes: Vec<String> = used
                    .iter()
                    .filter_map(|pv| pv.spec.as_ref().and_then(|s| s.storage_class_name.clone()))
                    .collect();
                resources.extend(used.iter().map(|pv| pv_summary(pv)));
                if let Ok(scs) = Api::<StorageClass>::all(c.clone()).list(&lp).await {
                    resources.extend(
                        scs.items
                            .iter()
                            .filter(|sc| classes.contains(&sc.name_any()))
                            .map(storageclass_summary),
                    );
                }
            }
        }

        Ok(NamespaceSnapshot {
            namespace: namespace.to_string(),
            resources,
            warnings,
        })
    }

    /// Full node details with pod placement.
    pub async fn nodes(&self) -> Result<Vec<NodeDetail>> {
        let lp = ListParams::default();
        let (nodes, pods) = tokio::try_join!(
            async { Api::<Node>::all(self.client.clone()).list(&lp).await },
            async { Api::<Pod>::all(self.client.clone()).list(&lp).await },
        )?;
        Ok(nodes
            .items
            .iter()
            .map(|n| node_detail(n, &pods.items))
            .collect())
    }

    pub async fn events(&self, namespace: &str) -> Result<Vec<EventInfo>> {
        events::list(&self.client, namespace).await
    }

    pub async fn logs(&self, query: &LogQuery) -> Result<String> {
        logs::fetch(&self.client, query).await
    }

    /// Best-effort Prometheus discovery: a Service named like prometheus
    /// serving port 9090, anywhere in the cluster. Returns "ns/name" or None
    /// (missing RBAC or no Prometheus both mean None - the Metrics API path
    /// never depends on this).
    pub async fn detect_prometheus(&self) -> Option<String> {
        let api: Api<Service> = Api::all(self.client.clone());
        let list = api.list(&ListParams::default()).await.ok()?;
        list.items.iter().find_map(|svc| {
            let name = svc.metadata.name.clone()?;
            let ns = svc.metadata.namespace.clone()?;
            let lower = name.to_lowercase();
            let looks_like = lower.contains("prometheus")
                && !lower.contains("exporter")
                && !lower.contains("alertmanager")
                && !lower.contains("operator")
                && !lower.contains("adapter");
            let serves_9090 = svc
                .spec
                .as_ref()
                .and_then(|sp| sp.ports.as_ref())
                .is_some_and(|ports| ports.iter().any(|p| p.port == 9090));
            (looks_like && serves_9090).then(|| format!("{ns}/{name}"))
        })
    }

    pub async fn metrics(&self, namespace: &str) -> Result<MetricsSnapshot> {
        Ok(metrics::snapshot(&self.client, namespace).await)
    }

    pub async fn yaml(&self, kind: &str, namespace: &str, name: &str) -> Result<String> {
        yaml::get(&self.client, kind, namespace, name).await
    }

    pub async fn apply_yaml(
        &self,
        yaml_text: &str,
        default_namespace: &str,
        dry_run: bool,
    ) -> Result<ApplyResult> {
        yaml::apply(&self.client, yaml_text, default_namespace, dry_run).await
    }

    pub async fn config_map_data(
        &self,
        namespace: &str,
        name: &str,
    ) -> Result<BTreeMap<String, String>> {
        let cm = Api::<ConfigMap>::namespaced(self.client.clone(), namespace)
            .get(name)
            .await?;
        let mut out = cm.data.unwrap_or_default();
        for key in cm.binary_data.unwrap_or_default().keys() {
            out.insert(key.clone(), "«binary data»".into());
        }
        Ok(out)
    }

    /// Decode Secret values. Only called from the explicit, confirmed reveal
    /// flow in the UI - never as part of a routine read.
    pub async fn reveal_secret(&self, namespace: &str, name: &str) -> Result<Vec<SecretKey>> {
        let secret = Api::<Secret>::namespaced(self.client.clone(), namespace)
            .get(name)
            .await?;
        Ok(secret
            .data
            .unwrap_or_default()
            .into_iter()
            .map(|(key, bytes)| {
                let len = bytes.0.len();
                match String::from_utf8(bytes.0) {
                    Ok(text) => SecretKey {
                        name: key,
                        value: Some(text),
                        binary: false,
                        bytes: len,
                    },
                    Err(_) => SecretKey {
                        name: key,
                        value: None,
                        binary: true,
                        bytes: len,
                    },
                }
            })
            .collect())
    }

    pub async fn rollout_history(
        &self,
        namespace: &str,
        name: &str,
    ) -> Result<Vec<RolloutRevision>> {
        actions::rollout_history(&self.client, namespace, name).await
    }

    pub async fn check_access(&self, checks: Vec<AccessCheck>) -> Result<Vec<AccessResult>> {
        rbac::check_access(&self.client, checks).await
    }

    pub async fn perform_action(&self, action: Action) -> Result<ActionResult> {
        actions::perform(&self.client, action).await
    }

    pub async fn exec(&self, req: &ExecRequest) -> Result<ExecResult> {
        exec::run(&self.client, req).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kube::config::{NamedAuthInfo, NamedCluster, NamedContext};

    fn two_identity_kubeconfig() -> Kubeconfig {
        let ctx = |name: &str, cluster: &str, user: &str| NamedContext {
            name: name.into(),
            context: Some(kube::config::Context {
                cluster: cluster.into(),
                user: Some(user.into()),
                namespace: Some("original-ns".into()),
                ..Default::default()
            }),
            ..Default::default()
        };
        Kubeconfig {
            current_context: Some("prod".into()),
            contexts: vec![
                ctx("prod", "prod-cluster", "prod-user"),
                ctx("staging", "staging-cluster", "staging-user"),
            ],
            clusters: vec![
                NamedCluster {
                    name: "prod-cluster".into(),
                    ..Default::default()
                },
                NamedCluster {
                    name: "staging-cluster".into(),
                    ..Default::default()
                },
            ],
            auth_infos: vec![
                NamedAuthInfo {
                    name: "prod-user".into(),
                    ..Default::default()
                },
                NamedAuthInfo {
                    name: "staging-user".into(),
                    ..Default::default()
                },
            ],
            ..Default::default()
        }
    }

    #[test]
    fn pinned_kubeconfig_keeps_only_the_selected_identity() {
        let pinned = pin_kubeconfig(two_identity_kubeconfig(), "staging", Some("team-a")).unwrap();
        assert_eq!(pinned.current_context.as_deref(), Some("staging"));
        assert_eq!(pinned.contexts.len(), 1, "other contexts must be dropped");
        assert_eq!(pinned.clusters.len(), 1, "other clusters must be dropped");
        assert_eq!(
            pinned.auth_infos.len(),
            1,
            "other credentials must be dropped"
        );
        assert_eq!(pinned.clusters[0].name, "staging-cluster");
        assert_eq!(pinned.auth_infos[0].name, "staging-user");
        let ctx = pinned.contexts[0].context.as_ref().unwrap();
        assert_eq!(
            ctx.namespace.as_deref(),
            Some("team-a"),
            "UI namespace overrides the file's"
        );
    }

    #[test]
    fn pinning_an_unknown_context_fails() {
        assert!(pin_kubeconfig(two_identity_kubeconfig(), "nope", None).is_err());
    }
}
