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

/// A live connection to one cluster.
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
    pub async fn snapshot(&self, namespace: &str) -> Result<NamespaceSnapshot> {
        let lp = ListParams::default();
        let c = &self.client;
        macro_rules! list {
            ($ty:ty) => {
                async { Api::<$ty>::namespaced(c.clone(), namespace).list(&lp).await }
            };
        }
        // Fetch all resource kinds concurrently.
        let (pods, deployments, replicasets, statefulsets, daemonsets, jobs) = tokio::try_join!(
            list!(Pod),
            list!(Deployment),
            list!(ReplicaSet),
            list!(StatefulSet),
            list!(DaemonSet),
            list!(Job),
        )?;
        let (cronjobs, services, ingresses, configmaps, secrets, pvcs) = tokio::try_join!(
            list!(CronJob),
            list!(Service),
            list!(Ingress),
            list!(ConfigMap),
            list!(Secret),
            list!(PersistentVolumeClaim),
        )?;
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
        resources.extend(pods.items.iter().map(pod_summary));
        resources.extend(deployments.items.iter().map(deployment_summary));
        resources.extend(replicasets.items.iter().map(replicaset_summary));
        resources.extend(statefulsets.items.iter().map(statefulset_summary));
        resources.extend(daemonsets.items.iter().map(daemonset_summary));
        resources.extend(jobs.items.iter().map(job_summary));
        resources.extend(cronjobs.items.iter().map(cronjob_summary));
        resources.extend(services.items.iter().map(service_summary));
        resources.extend(ingresses.items.iter().map(ingress_summary));
        resources.extend(configmaps.items.iter().map(configmap_summary));
        resources.extend(secrets.items.iter().map(secret_summary));
        resources.extend(pvcs.items.iter().map(pvc_summary));
        resources.extend(hpas.iter().map(hpa_summary));
        resources.extend(netpols.iter().map(networkpolicy_summary));

        // PVs and StorageClasses are cluster-scoped; include the ones this
        // namespace's claims actually bind to, so the storage chain is visible.
        let bound_pvs: Vec<String> = pvcs
            .items
            .iter()
            .filter_map(|p| p.spec.as_ref().and_then(|s| s.volume_name.clone()))
            .collect();
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
