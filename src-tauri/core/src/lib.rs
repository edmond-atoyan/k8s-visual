//! Kubernetes bridge for K8s Visual.
//!
//! Connects to a cluster through the user's kubeconfig and condenses live
//! resources into small, UI-friendly summaries ([`model`]). Deliberately
//! read-only: nothing in this crate mutates cluster state, and Secret
//! values are never read — only names and key counts.

pub mod model;

use std::collections::BTreeMap;
use std::time::Duration;

use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, ReplicaSet, StatefulSet};
use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::core::v1::{
    ConfigMap, Namespace, Node, PersistentVolumeClaim, Pod, Secret, Service,
};
use k8s_openapi::api::networking::v1::Ingress;
use kube::api::{Api, ListParams};
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::{Client, Config, ResourceExt};

use model::*;

#[derive(thiserror::Error, Debug)]
pub enum Error {
    #[error("could not read kubeconfig: {0}")]
    Kubeconfig(String),
    #[error("could not connect to cluster: {0}")]
    Connect(String),
    #[error("cluster request failed: {0}")]
    Request(#[from] kube::Error),
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
    client: Client,
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

    /// Nodes and namespaces — the top of the hierarchy.
    pub async fn overview(&self) -> Result<ClusterOverview> {
        let lp = ListParams::default();
        let nodes = Api::<Node>::all(self.client.clone()).list(&lp).await?;
        let namespaces = Api::<Namespace>::all(self.client.clone()).list(&lp).await?;
        let pods = Api::<Pod>::all(self.client.clone()).list(&lp).await?;

        let mut pods_per_ns: BTreeMap<String, u32> = BTreeMap::new();
        for pod in &pods.items {
            *pods_per_ns
                .entry(pod.namespace().unwrap_or_default())
                .or_default() += 1;
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
                        name,
                    }
                })
                .collect(),
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

        Ok(NamespaceSnapshot {
            namespace: namespace.to_string(),
            resources,
        })
    }
}

// ---------------------------------------------------------------------------
// Per-kind mappers
// ---------------------------------------------------------------------------

fn base(kind: &str, obj: &impl ResourceExt) -> ResourceSummary {
    ResourceSummary {
        uid: obj.uid().unwrap_or_default(),
        kind: kind.to_string(),
        name: obj.name_any(),
        namespace: obj.namespace().unwrap_or_default(),
        owners: obj
            .owner_references()
            .iter()
            .map(|o| OwnerRef {
                kind: o.kind.clone(),
                name: o.name.clone(),
                uid: o.uid.clone(),
            })
            .collect(),
        labels: obj.labels().clone(),
        status: String::new(),
        health: Health::Neutral,
        details: BTreeMap::new(),
        selector: None,
        refs: Vec::new(),
    }
}

/// "ready/desired" fraction with the standard health mapping:
/// all ready = good, some = warning, none (but wanted) = critical.
fn replica_status(ready: i32, desired: i32) -> (String, Health) {
    let health = if desired == 0 {
        Health::Neutral
    } else if ready >= desired {
        Health::Good
    } else if ready > 0 {
        Health::Warning
    } else {
        Health::Critical
    };
    (format!("{ready}/{desired} ready"), health)
}

fn pod_summary(pod: &Pod) -> ResourceSummary {
    let mut s = base("Pod", pod);
    let status = pod.status.as_ref();
    let spec = pod.spec.as_ref();

    let phase = status
        .and_then(|st| st.phase.clone())
        .unwrap_or_else(|| "Unknown".into());
    let container_statuses = status
        .and_then(|st| st.container_statuses.clone())
        .unwrap_or_default();

    let total = spec.map(|sp| sp.containers.len()).unwrap_or(0);
    let ready = container_statuses.iter().filter(|cs| cs.ready).count();
    let restarts: i32 = container_statuses.iter().map(|cs| cs.restart_count).sum();

    // A waiting reason like CrashLoopBackOff is more informative than the phase.
    let waiting_reason = container_statuses.iter().find_map(|cs| {
        cs.state
            .as_ref()
            .and_then(|st| st.waiting.as_ref())
            .and_then(|w| w.reason.clone())
            .filter(|r| r != "ContainerCreating" && r != "PodInitializing")
    });

    let (status_text, health) = if pod.metadata.deletion_timestamp.is_some() {
        ("Terminating".into(), Health::Warning)
    } else if let Some(reason) = waiting_reason {
        (reason, Health::Critical)
    } else {
        match phase.as_str() {
            "Running" if ready == total => ("Running".into(), Health::Good),
            "Running" => (format!("Running ({ready}/{total} ready)"), Health::Warning),
            "Succeeded" => ("Succeeded".into(), Health::Good),
            "Pending" => ("Pending".into(), Health::Warning),
            "Failed" => ("Failed".into(), Health::Critical),
            other => (other.to_string(), Health::Serious),
        }
    };
    s.status = status_text;
    s.health = health;

    s.details
        .insert("Containers".into(), format!("{ready}/{total} ready"));
    if restarts > 0 {
        s.details.insert("Restarts".into(), restarts.to_string());
    }
    if let Some(sp) = spec {
        if let Some(node) = &sp.node_name {
            s.details.insert("Node".into(), node.clone());
        }
        let images: Vec<String> = sp
            .containers
            .iter()
            .filter_map(|c| c.image.clone())
            .collect();
        if !images.is_empty() {
            s.details.insert("Image".into(), images.join(", "));
        }
        // Mounted config/storage become dashed reference edges in the graph.
        for volume in sp.volumes.clone().unwrap_or_default() {
            if let Some(cm) = &volume.config_map {
                s.refs.push(format!("ConfigMap/{}", cm.name));
            }
            if let Some(sec) = &volume.secret {
                if let Some(name) = &sec.secret_name {
                    s.refs.push(format!("Secret/{name}"));
                }
            }
            if let Some(pvc) = &volume.persistent_volume_claim {
                s.refs
                    .push(format!("PersistentVolumeClaim/{}", pvc.claim_name));
            }
        }
        for container in &sp.containers {
            for env_from in container.env_from.clone().unwrap_or_default() {
                if let Some(cm) = env_from.config_map_ref.and_then(|r| r.name.into()) {
                    s.refs.push(format!("ConfigMap/{cm}"));
                }
                if let Some(sec) = env_from.secret_ref.and_then(|r| r.name.into()) {
                    s.refs.push(format!("Secret/{sec}"));
                }
            }
        }
    }
    if let Some(ip) = status.and_then(|st| st.pod_ip.clone()) {
        s.details.insert("Pod IP".into(), ip);
    }
    s.refs.sort();
    s.refs.dedup();
    s
}

fn deployment_summary(d: &Deployment) -> ResourceSummary {
    let mut s = base("Deployment", d);
    let desired = d.spec.as_ref().and_then(|sp| sp.replicas).unwrap_or(0);
    let ready = d
        .status
        .as_ref()
        .and_then(|st| st.ready_replicas)
        .unwrap_or(0);
    (s.status, s.health) = replica_status(ready, desired);
    s.selector = d
        .spec
        .as_ref()
        .and_then(|sp| sp.selector.match_labels.clone());
    s.details.insert(
        "Replicas".into(),
        format!("{ready} ready / {desired} desired"),
    );
    if let Some(strategy) = d
        .spec
        .as_ref()
        .and_then(|sp| sp.strategy.as_ref())
        .and_then(|st| st.type_.clone())
    {
        s.details.insert("Strategy".into(), strategy);
    }
    s
}

fn replicaset_summary(rs: &ReplicaSet) -> ResourceSummary {
    let mut s = base("ReplicaSet", rs);
    let desired = rs.spec.as_ref().and_then(|sp| sp.replicas).unwrap_or(0);
    let ready = rs
        .status
        .as_ref()
        .and_then(|st| st.ready_replicas)
        .unwrap_or(0);
    if desired == 0 {
        s.status = "scaled to 0".into();
        s.health = Health::Neutral;
        s.details
            .insert("Note".into(), "Old revision kept for rollback".into());
    } else {
        (s.status, s.health) = replica_status(ready, desired);
    }
    s.details.insert(
        "Replicas".into(),
        format!("{ready} ready / {desired} desired"),
    );
    s
}

fn statefulset_summary(sts: &StatefulSet) -> ResourceSummary {
    let mut s = base("StatefulSet", sts);
    let desired = sts.spec.as_ref().and_then(|sp| sp.replicas).unwrap_or(0);
    let ready = sts
        .status
        .as_ref()
        .and_then(|st| st.ready_replicas)
        .unwrap_or(0);
    (s.status, s.health) = replica_status(ready, desired);
    s.selector = sts
        .spec
        .as_ref()
        .and_then(|sp| sp.selector.match_labels.clone());
    if let Some(svc) = sts.spec.as_ref().map(|sp| sp.service_name.clone()) {
        if let Some(svc) = svc {
            s.details.insert("Headless Service".into(), svc);
        }
    }
    s.details.insert(
        "Replicas".into(),
        format!("{ready} ready / {desired} desired"),
    );
    s
}

fn daemonset_summary(ds: &DaemonSet) -> ResourceSummary {
    let mut s = base("DaemonSet", ds);
    let desired = ds
        .status
        .as_ref()
        .map(|st| st.desired_number_scheduled)
        .unwrap_or(0);
    let ready = ds.status.as_ref().map(|st| st.number_ready).unwrap_or(0);
    (s.status, s.health) = replica_status(ready, desired);
    s.selector = ds
        .spec
        .as_ref()
        .and_then(|sp| sp.selector.match_labels.clone());
    s.details
        .insert("Scheduled on".into(), format!("{desired} node(s)"));
    s
}

fn job_summary(job: &Job) -> ResourceSummary {
    let mut s = base("Job", job);
    let status = job.status.as_ref();
    let succeeded = status.and_then(|st| st.succeeded).unwrap_or(0);
    let failed = status.and_then(|st| st.failed).unwrap_or(0);
    let active = status.and_then(|st| st.active).unwrap_or(0);
    (s.status, s.health) = if failed > 0 {
        ("Failed".into(), Health::Critical)
    } else if active > 0 {
        ("Active".into(), Health::Good)
    } else if succeeded > 0 {
        ("Complete".into(), Health::Good)
    } else {
        ("Pending".into(), Health::Warning)
    };
    s.details.insert(
        "Pods".into(),
        format!("{active} active, {succeeded} succeeded, {failed} failed"),
    );
    s
}

fn cronjob_summary(cj: &CronJob) -> ResourceSummary {
    let mut s = base("CronJob", cj);
    if cj.spec.suspend.unwrap_or(false) {
        s.status = "Suspended".into();
        s.health = Health::Warning;
    } else {
        s.status = "Scheduled".into();
        s.health = Health::Good;
    }
    s.details
        .insert("Schedule".into(), cj.spec.schedule.clone());
    if let Some(last) = cj
        .status
        .as_ref()
        .and_then(|st| st.last_schedule_time.as_ref())
    {
        s.details.insert("Last run".into(), last.0.to_string());
    }
    s
}

fn service_summary(svc: &Service) -> ResourceSummary {
    let mut s = base("Service", svc);
    let spec = svc.spec.as_ref();
    let type_ = spec
        .and_then(|sp| sp.type_.clone())
        .unwrap_or_else(|| "ClusterIP".into());
    s.status = type_.clone();
    s.health = Health::Neutral;
    s.selector = spec.and_then(|sp| sp.selector.clone());
    s.details.insert("Type".into(), type_);
    if let Some(ip) = spec.and_then(|sp| sp.cluster_ip.clone()) {
        s.details.insert("Cluster IP".into(), ip);
    }
    let ports: Vec<String> = spec
        .and_then(|sp| sp.ports.clone())
        .unwrap_or_default()
        .iter()
        .map(|p| {
            use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;
            let target = match &p.target_port {
                Some(IntOrString::Int(n)) => format!(" → {n}"),
                Some(IntOrString::String(name)) => format!(" → {name}"),
                None => String::new(),
            };
            format!("{}{target}", p.port)
        })
        .collect();
    if !ports.is_empty() {
        s.details.insert("Ports".into(), ports.join(", "));
    }
    s
}

fn ingress_summary(ing: &Ingress) -> ResourceSummary {
    let mut s = base("Ingress", ing);
    s.status = "Routing".into();
    s.health = Health::Neutral;
    let spec = ing.spec.as_ref();
    let mut hosts = Vec::new();
    for rule in spec.and_then(|sp| sp.rules.clone()).unwrap_or_default() {
        if let Some(host) = &rule.host {
            hosts.push(host.clone());
        }
        for path in rule
            .http
            .as_ref()
            .map(|h| h.paths.clone())
            .unwrap_or_default()
        {
            if let Some(svc) = path.backend.service {
                s.refs.push(format!("Service/{}", svc.name));
            }
        }
    }
    if let Some(default) = spec
        .and_then(|sp| sp.default_backend.as_ref())
        .and_then(|b| b.service.as_ref())
    {
        s.refs.push(format!("Service/{}", default.name));
    }
    if !hosts.is_empty() {
        s.details.insert("Hosts".into(), hosts.join(", "));
    }
    if let Some(class) = spec.and_then(|sp| sp.ingress_class_name.clone()) {
        s.details.insert("Class".into(), class);
    }
    s.refs.sort();
    s.refs.dedup();
    s
}

fn configmap_summary(cm: &ConfigMap) -> ResourceSummary {
    let mut s = base("ConfigMap", cm);
    let keys = cm.data.as_ref().map(|d| d.len()).unwrap_or(0)
        + cm.binary_data.as_ref().map(|d| d.len()).unwrap_or(0);
    s.status = format!("{keys} key(s)");
    s.health = Health::Neutral;
    s
}

fn secret_summary(secret: &Secret) -> ResourceSummary {
    // Values are intentionally never read — only the key count and type.
    let mut s = base("Secret", secret);
    let keys = secret.data.as_ref().map(|d| d.len()).unwrap_or(0);
    s.status = format!("{keys} key(s)");
    s.health = Health::Neutral;
    if let Some(type_) = &secret.type_ {
        s.details.insert("Type".into(), type_.clone());
    }
    s
}

fn pvc_summary(pvc: &PersistentVolumeClaim) -> ResourceSummary {
    let mut s = base("PersistentVolumeClaim", pvc);
    let phase = pvc
        .status
        .as_ref()
        .and_then(|st| st.phase.clone())
        .unwrap_or_else(|| "Unknown".into());
    s.health = match phase.as_str() {
        "Bound" => Health::Good,
        "Pending" => Health::Warning,
        "Lost" => Health::Critical,
        _ => Health::Neutral,
    };
    s.status = phase;
    if let Some(capacity) = pvc
        .status
        .as_ref()
        .and_then(|st| st.capacity.as_ref())
        .and_then(|c| c.get("storage"))
    {
        s.details.insert("Capacity".into(), capacity.0.clone());
    }
    if let Some(class) = pvc
        .spec
        .as_ref()
        .and_then(|sp| sp.storage_class_name.clone())
    {
        s.details.insert("StorageClass".into(), class);
    }
    s
}

fn node_info(node: &Node) -> NodeInfo {
    let labels = node.labels();
    let roles: Vec<String> = labels
        .keys()
        .filter_map(|k| k.strip_prefix("node-role.kubernetes.io/"))
        .map(String::from)
        .collect();
    let status = node.status.as_ref();
    let ready = status
        .and_then(|st| st.conditions.as_ref())
        .map(|conds| {
            conds
                .iter()
                .any(|c| c.type_ == "Ready" && c.status == "True")
        })
        .unwrap_or(false);
    let capacity = status.and_then(|st| st.capacity.as_ref());
    NodeInfo {
        name: node.name_any(),
        roles: if roles.is_empty() {
            vec!["worker".into()]
        } else {
            roles
        },
        ready,
        version: status
            .map(|st| st.node_info.clone())
            .flatten()
            .map(|ni| ni.kubelet_version)
            .unwrap_or_default(),
        os_image: status
            .map(|st| st.node_info.clone())
            .flatten()
            .map(|ni| ni.os_image)
            .unwrap_or_default(),
        cpu: capacity
            .and_then(|c| c.get("cpu"))
            .map(|q| q.0.clone())
            .unwrap_or_default(),
        memory: capacity
            .and_then(|c| c.get("memory"))
            .map(|q| q.0.clone())
            .unwrap_or_default(),
    }
}
