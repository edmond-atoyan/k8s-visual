//! Per-kind mappers: condense raw Kubernetes objects into UI summaries.
//! Read-only by construction - these only look at objects already fetched.

use std::collections::BTreeMap;

use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, ReplicaSet, StatefulSet};
use k8s_openapi::api::autoscaling::v2::HorizontalPodAutoscaler;
use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::core::v1::{
    ConfigMap, Container, ContainerState, ContainerStatus, Node, PersistentVolume,
    PersistentVolumeClaim, Pod, Secret, Service,
};
use k8s_openapi::api::networking::v1::{Ingress, NetworkPolicy};
use k8s_openapi::api::storage::v1::StorageClass;
use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;
use kube::ResourceExt;

use crate::model::*;

pub(crate) fn base(kind: &str, obj: &impl ResourceExt) -> ResourceSummary {
    let annotations = obj.annotations();
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
        annotations: if annotations.is_empty() {
            None
        } else {
            Some(annotations.clone())
        },
        status: String::new(),
        health: Health::Neutral,
        created_at: obj
            .meta()
            .creation_timestamp
            .as_ref()
            .map(|t| t.0.to_string()),
        details: BTreeMap::new(),
        selector: None,
        refs: Vec::new(),
        containers: None,
        service_ports: None,
        conditions: None,
    }
}

/// "ready/desired" fraction with the standard health mapping:
/// all ready = good, some = warning, none (but wanted) = critical.
pub fn replica_status(ready: i32, desired: i32) -> (String, Health) {
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

fn state_text(state: Option<&ContainerState>) -> String {
    let Some(state) = state else {
        return "Unknown".into();
    };
    if state.running.is_some() {
        return "Running".into();
    }
    if let Some(w) = &state.waiting {
        return format!("Waiting: {}", w.reason.clone().unwrap_or_default());
    }
    if let Some(t) = &state.terminated {
        let reason = t.reason.clone().unwrap_or_else(|| "Terminated".into());
        return format!("Terminated: {reason} (exit {})", t.exit_code);
    }
    "Unknown".into()
}

fn container_info(spec: Option<&Container>, cs: &ContainerStatus, init: bool) -> ContainerInfo {
    ContainerInfo {
        name: cs.name.clone(),
        image: cs.image.clone(),
        ready: cs.ready,
        restarts: cs.restart_count,
        state: state_text(cs.state.as_ref()),
        last_state: cs.last_state.as_ref().and_then(|ls| {
            ls.terminated.as_ref().map(|t| {
                format!(
                    "{} (exit {})",
                    t.reason.clone().unwrap_or_else(|| "Terminated".into()),
                    t.exit_code
                )
            })
        }),
        ports: spec
            .and_then(|c| c.ports.clone())
            .unwrap_or_default()
            .iter()
            .map(|p| p.container_port)
            .collect(),
        init: if init { Some(true) } else { None },
    }
}

pub fn pod_summary(pod: &Pod) -> ResourceSummary {
    let mut s = base("Pod", pod);
    let status = pod.status.as_ref();
    let spec = pod.spec.as_ref();

    let phase = status
        .and_then(|st| st.phase.clone())
        .unwrap_or_else(|| "Unknown".into());
    let container_statuses = status
        .and_then(|st| st.container_statuses.clone())
        .unwrap_or_default();
    let init_statuses = status
        .and_then(|st| st.init_container_statuses.clone())
        .unwrap_or_default();

    let total = spec.map(|sp| sp.containers.len()).unwrap_or(0);
    let ready = container_statuses.iter().filter(|cs| cs.ready).count();
    let restarts: i32 = container_statuses.iter().map(|cs| cs.restart_count).sum();

    // A waiting reason like CrashLoopBackOff is more informative than the phase.
    let waiting_reason = container_statuses
        .iter()
        .chain(init_statuses.iter())
        .find_map(|cs| {
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
        if let Some(sa) = &sp.service_account_name {
            s.details.insert("Service account".into(), sa.clone());
        }
        // Mounted config/storage become reference edges in the graph.
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

        // Per-container status for the details panel and debugging helpers.
        let mut containers: Vec<ContainerInfo> = Vec::new();
        for cs in &init_statuses {
            let cspec = sp
                .init_containers
                .as_ref()
                .and_then(|list| list.iter().find(|c| c.name == cs.name));
            containers.push(container_info(cspec, cs, true));
        }
        for cs in &container_statuses {
            let cspec = sp.containers.iter().find(|c| c.name == cs.name);
            containers.push(container_info(cspec, cs, false));
        }
        if !containers.is_empty() {
            s.containers = Some(containers);
        }
    }
    if let Some(ip) = status.and_then(|st| st.pod_ip.clone()) {
        s.details.insert("Pod IP".into(), ip);
    }
    s.conditions = status.and_then(|st| st.conditions.as_ref()).map(|conds| {
        conds
            .iter()
            .map(|c| ConditionInfo {
                r#type: c.type_.clone(),
                status: c.status.clone(),
                reason: c.reason.clone(),
                message: c.message.clone(),
            })
            .collect()
    });
    s.refs.sort();
    s.refs.dedup();
    s
}

pub fn deployment_summary(d: &Deployment) -> ResourceSummary {
    let mut s = base("Deployment", d);
    let desired = d.spec.as_ref().and_then(|sp| sp.replicas).unwrap_or(0);
    let ready = d
        .status
        .as_ref()
        .and_then(|st| st.ready_replicas)
        .unwrap_or(0);
    (s.status, s.health) = replica_status(ready, desired);
    if d.spec.as_ref().and_then(|sp| sp.paused).unwrap_or(false) {
        s.status = format!("{} (paused)", s.status);
        s.details.insert("Rollout".into(), "Paused".into());
    }
    s.selector = d
        .spec
        .as_ref()
        .and_then(|sp| sp.selector.match_labels.clone());
    let updated = d
        .status
        .as_ref()
        .and_then(|st| st.updated_replicas)
        .unwrap_or(0);
    let available = d
        .status
        .as_ref()
        .and_then(|st| st.available_replicas)
        .unwrap_or(0);
    s.details.insert(
        "Replicas".into(),
        format!("{ready} ready / {desired} desired ({updated} updated, {available} available)"),
    );
    if let Some(strategy) = d
        .spec
        .as_ref()
        .and_then(|sp| sp.strategy.as_ref())
        .and_then(|st| st.type_.clone())
    {
        s.details.insert("Strategy".into(), strategy);
    }
    s.conditions = d
        .status
        .as_ref()
        .and_then(|st| st.conditions.as_ref())
        .map(|conds| {
            conds
                .iter()
                .map(|c| ConditionInfo {
                    r#type: c.type_.clone(),
                    status: c.status.clone(),
                    reason: c.reason.clone(),
                    message: c.message.clone(),
                })
                .collect()
        });
    s
}

pub fn replicaset_summary(rs: &ReplicaSet) -> ResourceSummary {
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
    if let Some(rev) = rs
        .metadata
        .annotations
        .as_ref()
        .and_then(|a| a.get("deployment.kubernetes.io/revision"))
    {
        s.details.insert("Revision".into(), rev.clone());
    }
    s
}

pub fn statefulset_summary(sts: &StatefulSet) -> ResourceSummary {
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
    if let Some(Some(svc)) = sts.spec.as_ref().map(|sp| sp.service_name.clone()) {
        s.details.insert("Headless Service".into(), svc);
    }
    s.details.insert(
        "Replicas".into(),
        format!("{ready} ready / {desired} desired"),
    );
    s
}

pub fn daemonset_summary(ds: &DaemonSet) -> ResourceSummary {
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

pub fn job_summary(job: &Job) -> ResourceSummary {
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

pub fn cronjob_summary(cj: &CronJob) -> ResourceSummary {
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

pub fn service_summary(svc: &Service) -> ResourceSummary {
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
    let port_specs = spec.and_then(|sp| sp.ports.clone()).unwrap_or_default();
    let mut ports_text = Vec::new();
    let mut structured = Vec::new();
    for p in &port_specs {
        let target = match &p.target_port {
            Some(IntOrString::Int(n)) => Some(n.to_string()),
            Some(IntOrString::String(name)) => Some(name.clone()),
            None => None,
        };
        ports_text.push(match &target {
            Some(t) => format!("{} → {t}", p.port),
            None => p.port.to_string(),
        });
        structured.push(ServicePortInfo {
            port: p.port,
            target_port: target,
            protocol: p.protocol.clone(),
            node_port: p.node_port,
        });
    }
    if !ports_text.is_empty() {
        s.details.insert("Ports".into(), ports_text.join(", "));
    }
    if !structured.is_empty() {
        s.service_ports = Some(structured);
    }
    if let Some(lb) = svc
        .status
        .as_ref()
        .and_then(|st| st.load_balancer.as_ref())
        .and_then(|lb| lb.ingress.as_ref())
    {
        let addrs: Vec<String> = lb
            .iter()
            .filter_map(|i| i.ip.clone().or_else(|| i.hostname.clone()))
            .collect();
        if !addrs.is_empty() {
            s.details.insert("External".into(), addrs.join(", "));
        }
    }
    s
}

pub fn ingress_summary(ing: &Ingress) -> ResourceSummary {
    let mut s = base("Ingress", ing);
    s.status = "Routing".into();
    s.health = Health::Neutral;
    let spec = ing.spec.as_ref();
    let mut hosts = Vec::new();
    let mut routes = Vec::new();
    for rule in spec.and_then(|sp| sp.rules.clone()).unwrap_or_default() {
        let host = rule.host.clone().unwrap_or_else(|| "*".into());
        if rule.host.is_some() {
            hosts.push(host.clone());
        }
        for path in rule
            .http
            .as_ref()
            .map(|h| h.paths.clone())
            .unwrap_or_default()
        {
            if let Some(svc) = path.backend.service {
                let port = svc
                    .port
                    .as_ref()
                    .and_then(|p| p.number.map(|n| n.to_string()).or_else(|| p.name.clone()))
                    .unwrap_or_default();
                routes.push(format!(
                    "{host}{} → {}:{port}",
                    path.path.clone().unwrap_or_else(|| "/".into()),
                    svc.name
                ));
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
    for tls in spec.and_then(|sp| sp.tls.clone()).unwrap_or_default() {
        if let Some(secret) = tls.secret_name {
            s.details.insert("TLS".into(), secret.clone());
            s.refs.push(format!("Secret/{secret}"));
        }
    }
    if !hosts.is_empty() {
        s.details.insert("Hosts".into(), hosts.join(", "));
    }
    if !routes.is_empty() {
        s.details.insert("Routes".into(), routes.join("\n"));
    }
    if let Some(class) = spec.and_then(|sp| sp.ingress_class_name.clone()) {
        s.details.insert("Class".into(), class);
    }
    s.refs.sort();
    s.refs.dedup();
    s
}

pub fn configmap_summary(cm: &ConfigMap) -> ResourceSummary {
    let mut s = base("ConfigMap", cm);
    let data_keys: Vec<String> = cm
        .data
        .as_ref()
        .map(|d| d.keys().cloned().collect())
        .unwrap_or_default();
    let binary = cm.binary_data.as_ref().map(|d| d.len()).unwrap_or(0);
    s.status = format!("{} key(s)", data_keys.len() + binary);
    s.health = Health::Neutral;
    if !data_keys.is_empty() {
        s.details.insert("Keys".into(), data_keys.join(", "));
    }
    s
}

pub fn secret_summary(secret: &Secret) -> ResourceSummary {
    // Values are intentionally never read here - only key names, sizes, type.
    let mut s = base("Secret", secret);
    let keys: Vec<String> = secret
        .data
        .as_ref()
        .map(|d| d.keys().cloned().collect())
        .unwrap_or_default();
    s.status = format!("{} key(s)", keys.len());
    s.health = Health::Neutral;
    if !keys.is_empty() {
        s.details.insert("Keys".into(), keys.join(", "));
    }
    if let Some(type_) = &secret.type_ {
        s.details.insert("Type".into(), type_.clone());
    }
    s
}

pub fn pvc_summary(pvc: &PersistentVolumeClaim) -> ResourceSummary {
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
    if let Some(modes) = pvc.spec.as_ref().and_then(|sp| sp.access_modes.clone()) {
        s.details.insert("Access modes".into(), modes.join(", "));
    }
    if let Some(class) = pvc
        .spec
        .as_ref()
        .and_then(|sp| sp.storage_class_name.clone())
    {
        s.details.insert("StorageClass".into(), class);
    }
    if let Some(volume) = pvc.spec.as_ref().and_then(|sp| sp.volume_name.clone()) {
        s.details.insert("Volume".into(), volume.clone());
        s.refs.push(format!("PersistentVolume/{volume}"));
    }
    s
}

pub fn pv_summary(pv: &PersistentVolume) -> ResourceSummary {
    let mut s = base("PersistentVolume", pv);
    // Cluster-scoped: keep namespace empty; the UI treats it as cluster-level.
    let phase = pv
        .status
        .as_ref()
        .and_then(|st| st.phase.clone())
        .unwrap_or_else(|| "Unknown".into());
    s.health = match phase.as_str() {
        "Bound" | "Available" => Health::Good,
        "Released" => Health::Warning,
        "Failed" => Health::Critical,
        _ => Health::Neutral,
    };
    s.status = phase;
    if let Some(sp) = pv.spec.as_ref() {
        if let Some(capacity) = sp.capacity.as_ref().and_then(|c| c.get("storage")) {
            s.details.insert("Capacity".into(), capacity.0.clone());
        }
        if let Some(modes) = sp.access_modes.clone() {
            s.details.insert("Access modes".into(), modes.join(", "));
        }
        if let Some(policy) = sp.persistent_volume_reclaim_policy.clone() {
            s.details.insert("Reclaim policy".into(), policy);
        }
        if let Some(class) = sp.storage_class_name.clone() {
            s.details.insert("StorageClass".into(), class.clone());
            s.refs.push(format!("StorageClass/{class}"));
        }
        if let Some(claim) = sp.claim_ref.as_ref().and_then(|c| c.name.clone()) {
            s.details.insert("Claimed by".into(), claim);
        }
    }
    s
}

pub fn storageclass_summary(sc: &StorageClass) -> ResourceSummary {
    let mut s = base("StorageClass", sc);
    s.status = sc.provisioner.clone();
    s.health = Health::Neutral;
    s.details
        .insert("Provisioner".into(), sc.provisioner.clone());
    if let Some(policy) = sc.reclaim_policy.clone() {
        s.details.insert("Reclaim policy".into(), policy);
    }
    if let Some(mode) = sc.volume_binding_mode.clone() {
        s.details.insert("Binding mode".into(), mode);
    }
    s
}

pub fn hpa_summary(hpa: &HorizontalPodAutoscaler) -> ResourceSummary {
    let mut s = base("HorizontalPodAutoscaler", hpa);
    let spec = &hpa.spec;
    let min = spec.min_replicas.unwrap_or(1);
    let max = spec.max_replicas;
    let current = hpa
        .status
        .as_ref()
        .and_then(|st| st.current_replicas)
        .unwrap_or(0);
    s.status = format!("{current} replicas ({min}-{max})");
    s.health = Health::Neutral;
    s.details
        .insert("Range".into(), format!("{min} min / {max} max"));
    let target = &spec.scale_target_ref;
    s.details
        .insert("Target".into(), format!("{} {}", target.kind, target.name));
    s.refs.push(format!("{}/{}", target.kind, target.name));
    s
}

pub fn networkpolicy_summary(np: &NetworkPolicy) -> ResourceSummary {
    let mut s = base("NetworkPolicy", np);
    s.status = "Active".into();
    s.health = Health::Neutral;
    if let Some(spec) = np.spec.as_ref() {
        s.selector = spec
            .pod_selector
            .as_ref()
            .and_then(|ps| ps.match_labels.clone());
        if let Some(types) = spec.policy_types.clone() {
            s.details.insert("Policy types".into(), types.join(", "));
        }
    }
    s
}

// --- nodes ---------------------------------------------------------------

pub fn node_info(node: &Node) -> NodeInfo {
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
            .and_then(|st| st.node_info.clone())
            .map(|ni| ni.kubelet_version)
            .unwrap_or_default(),
        os_image: status
            .and_then(|st| st.node_info.clone())
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

pub fn node_detail(node: &Node, all_pods: &[Pod]) -> NodeDetail {
    let info = node_info(node);
    let status = node.status.as_ref();
    let allocatable = status.and_then(|st| st.allocatable.as_ref());
    let name = node.name_any();
    let pods: Vec<NodePodInfo> = all_pods
        .iter()
        .filter(|p| {
            p.spec
                .as_ref()
                .and_then(|sp| sp.node_name.as_ref())
                .is_some_and(|n| *n == name)
        })
        .map(|p| {
            let s = pod_summary(p);
            NodePodInfo {
                namespace: s.namespace,
                name: s.name,
                status: s.status,
                health: s.health,
            }
        })
        .collect();
    NodeDetail {
        unschedulable: node.spec.as_ref().and_then(|sp| sp.unschedulable),
        internal_ip: status
            .and_then(|st| st.addresses.as_ref())
            .and_then(|addrs| {
                addrs
                    .iter()
                    .find(|a| a.type_ == "InternalIP")
                    .map(|a| a.address.clone())
            }),
        runtime: status
            .and_then(|st| st.node_info.clone())
            .map(|ni| ni.container_runtime_version),
        allocatable_cpu: allocatable.and_then(|a| a.get("cpu")).map(|q| q.0.clone()),
        allocatable_memory: allocatable
            .and_then(|a| a.get("memory"))
            .map(|q| q.0.clone()),
        taints: node
            .spec
            .as_ref()
            .and_then(|sp| sp.taints.clone())
            .unwrap_or_default()
            .iter()
            .map(|t| {
                let value = t
                    .value
                    .as_ref()
                    .map(|v| format!("={v}"))
                    .unwrap_or_default();
                format!("{}{value}:{}", t.key, t.effect)
            })
            .collect(),
        labels: node.labels().clone(),
        conditions: status
            .and_then(|st| st.conditions.as_ref())
            .map(|conds| {
                conds
                    .iter()
                    .map(|c| ConditionInfo {
                        r#type: c.type_.clone(),
                        status: c.status.clone(),
                        reason: c.reason.clone(),
                        message: c.message.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        pods,
        info,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::api::core::v1::{PodSpec, PodStatus};
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
    use k8s_openapi::ByteString;

    fn pod_with(status: PodStatus, spec: PodSpec) -> Pod {
        Pod {
            metadata: ObjectMeta {
                name: Some("p".into()),
                namespace: Some("ns".into()),
                uid: Some("u1".into()),
                ..Default::default()
            },
            spec: Some(spec),
            status: Some(status),
        }
    }

    #[test]
    fn replica_status_mapping() {
        assert_eq!(replica_status(3, 3).1, Health::Good);
        assert_eq!(replica_status(1, 2).1, Health::Warning);
        assert_eq!(replica_status(0, 2).1, Health::Critical);
        assert_eq!(replica_status(0, 0).1, Health::Neutral);
    }

    #[test]
    fn crashloop_beats_phase() {
        use k8s_openapi::api::core::v1::{
            Container, ContainerState, ContainerStateWaiting, ContainerStatus,
        };
        let status = PodStatus {
            phase: Some("Running".into()),
            container_statuses: Some(vec![ContainerStatus {
                name: "app".into(),
                ready: false,
                restart_count: 5,
                image: "img".into(),
                image_id: String::new(),
                state: Some(ContainerState {
                    waiting: Some(ContainerStateWaiting {
                        reason: Some("CrashLoopBackOff".into()),
                        message: None,
                    }),
                    ..Default::default()
                }),
                ..Default::default()
            }]),
            ..Default::default()
        };
        let spec = PodSpec {
            containers: vec![Container {
                name: "app".into(),
                ..Default::default()
            }],
            ..Default::default()
        };
        let s = pod_summary(&pod_with(status, spec));
        assert_eq!(s.status, "CrashLoopBackOff");
        assert_eq!(s.health, Health::Critical);
    }

    #[test]
    fn secret_summary_never_contains_values() {
        let mut data = std::collections::BTreeMap::new();
        data.insert("password".to_string(), ByteString(b"hunter2".to_vec()));
        let secret = Secret {
            metadata: ObjectMeta {
                name: Some("db".into()),
                namespace: Some("ns".into()),
                uid: Some("u2".into()),
                ..Default::default()
            },
            data: Some(data),
            type_: Some("Opaque".into()),
            ..Default::default()
        };
        let s = secret_summary(&secret);
        let serialized = serde_json::to_string(&s).unwrap();
        assert!(!serialized.contains("hunter2"));
        assert!(serialized.contains("password")); // key names are fine
        assert_eq!(s.status, "1 key(s)");
    }
}
