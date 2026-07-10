//! YAML views of live objects, and `kubectl apply`-style server-side apply.

use kube::api::{Api, DynamicObject, Patch, PatchParams};
use kube::core::{ApiResource, GroupVersionKind};
use kube::discovery::Scope;
use kube::Client;
use serde::Deserialize;

use crate::model::ApplyResult;
use crate::{Error, Result};

/// GVK + plural + scope for every kind the UI can show. Static so the common
/// path needs no discovery round-trip.
pub fn known_kind(kind: &str) -> Option<(GroupVersionKind, &'static str, bool)> {
    let (group, version, plural, namespaced) = match kind {
        "Pod" => ("", "v1", "pods", true),
        "Service" => ("", "v1", "services", true),
        "ConfigMap" => ("", "v1", "configmaps", true),
        "Secret" => ("", "v1", "secrets", true),
        "PersistentVolumeClaim" => ("", "v1", "persistentvolumeclaims", true),
        "PersistentVolume" => ("", "v1", "persistentvolumes", false),
        "Namespace" => ("", "v1", "namespaces", false),
        "Node" => ("", "v1", "nodes", false),
        "Deployment" => ("apps", "v1", "deployments", true),
        "ReplicaSet" => ("apps", "v1", "replicasets", true),
        "StatefulSet" => ("apps", "v1", "statefulsets", true),
        "DaemonSet" => ("apps", "v1", "daemonsets", true),
        "Job" => ("batch", "v1", "jobs", true),
        "CronJob" => ("batch", "v1", "cronjobs", true),
        "Ingress" => ("networking.k8s.io", "v1", "ingresses", true),
        "NetworkPolicy" => ("networking.k8s.io", "v1", "networkpolicies", true),
        "HorizontalPodAutoscaler" => ("autoscaling", "v2", "horizontalpodautoscalers", true),
        "StorageClass" => ("storage.k8s.io", "v1", "storageclasses", false),
        _ => return None,
    };
    Some((
        GroupVersionKind::gvk(group, version, kind),
        plural,
        namespaced,
    ))
}

pub fn dynamic_api(client: &Client, kind: &str, namespace: &str) -> Result<Api<DynamicObject>> {
    let (gvk, plural, namespaced) = known_kind(kind)
        .ok_or_else(|| Error::Invalid(format!("unsupported resource kind: {kind}")))?;
    let ar = ApiResource::from_gvk_with_plural(&gvk, plural);
    Ok(if namespaced {
        Api::namespaced_with(client.clone(), namespace, &ar)
    } else {
        Api::all_with(client.clone(), &ar)
    })
}

/// Fetch the full object as YAML. Secret data values are masked - revealing
/// them goes through the explicit reveal flow, never through the YAML view.
pub async fn get(client: &Client, kind: &str, namespace: &str, name: &str) -> Result<String> {
    let api = dynamic_api(client, kind, namespace)?;
    let mut obj = api.get(name).await?;
    obj.metadata.managed_fields = None;
    if kind == "Secret" {
        if let Some(data) = obj.data.get_mut("data").and_then(|d| d.as_object_mut()) {
            for value in data.values_mut() {
                *value = serde_json::Value::String(
                    "«hidden - use the explicit reveal flow to view secret values»".into(),
                );
            }
        }
    }
    serde_yaml::to_string(&obj).map_err(|e| Error::Invalid(format!("YAML encode failed: {e}")))
}

/// Server-side apply for one or more YAML documents
/// (`kubectl apply -f --server-side`). Supports `--dry-run=server`.
pub async fn apply(
    client: &Client,
    yaml_text: &str,
    default_namespace: &str,
    dry_run: bool,
) -> Result<ApplyResult> {
    let mut results = Vec::new();
    // Parse every document up front (the YAML parser is not Send, so it must
    // not be held across any await point).
    let mut documents: Vec<serde_json::Value> = Vec::new();
    for document in serde_yaml::Deserializer::from_str(yaml_text) {
        match serde_json::Value::deserialize(document) {
            Ok(serde_json::Value::Null) => continue,
            Ok(v) => documents.push(v),
            Err(e) => {
                return Ok(ApplyResult {
                    ok: false,
                    dry_run,
                    results,
                    error: Some(format!("invalid YAML: {e}")),
                })
            }
        };
    }
    for value in documents {
        let api_version = value
            .get("apiVersion")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let kind = value
            .get("kind")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let name = value
            .pointer("/metadata/name")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        if api_version.is_empty() || kind.is_empty() || name.is_empty() {
            return Ok(ApplyResult {
                ok: false,
                dry_run,
                results,
                error: Some("every document needs apiVersion, kind and metadata.name".into()),
            });
        }
        let (group, version) = match api_version.split_once('/') {
            Some((g, v)) => (g.to_string(), v.to_string()),
            None => (String::new(), api_version.clone()),
        };
        let gvk = GroupVersionKind::gvk(&group, &version, &kind);
        // Discovery handles CRDs and unusual plurals.
        let (ar, caps) = kube::discovery::oneshot::pinned_kind(client, &gvk)
            .await
            .map_err(|e| Error::Invalid(format!("unknown kind {api_version}/{kind}: {e}")))?;
        let namespace = value
            .pointer("/metadata/namespace")
            .and_then(|v| v.as_str())
            .unwrap_or(default_namespace)
            .to_string();
        let api: Api<DynamicObject> = if caps.scope == Scope::Namespaced {
            Api::namespaced_with(client.clone(), &namespace, &ar)
        } else {
            Api::all_with(client.clone(), &ar)
        };
        let mut params = PatchParams::apply("k8s-visual").force();
        if dry_run {
            params = params.dry_run();
        }
        match api.patch(&name, &params, &Patch::Apply(&value)).await {
            Ok(_) => {
                let scope_txt = if caps.scope == Scope::Namespaced {
                    format!(" (namespace {namespace})")
                } else {
                    String::new()
                };
                let verb = if dry_run {
                    "would be applied"
                } else {
                    "applied"
                };
                results.push(format!("{kind}/{name}{scope_txt} {verb}"));
            }
            Err(e) => {
                return Ok(ApplyResult {
                    ok: false,
                    dry_run,
                    results,
                    error: Some(format!("{kind}/{name}: {e}")),
                })
            }
        }
    }
    Ok(ApplyResult {
        ok: true,
        dry_run,
        results,
        error: None,
    })
}
