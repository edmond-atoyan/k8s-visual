//! Metrics API access (`kubectl top`). Requires metrics-server; when it is
//! missing we report that honestly instead of faking numbers.

use kube::api::{Api, DynamicObject, ListParams};
use kube::core::{ApiResource, GroupVersionKind};
use kube::Client;

use crate::model::{ContainerMetrics, MetricsSnapshot, NodeMetrics, PodMetrics};

/// Parse a Kubernetes quantity into base units (cores for CPU, bytes for
/// memory). Returns `None` for malformed values.
pub fn parse_quantity(raw: &str) -> Option<f64> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let split = raw.find(|c: char| !c.is_ascii_digit() && c != '.' && c != '-' && c != '+');
    let (num, suffix) = match split {
        Some(i) => raw.split_at(i),
        None => (raw, ""),
    };
    let value: f64 = num.parse().ok()?;
    let factor: f64 = match suffix {
        "" => 1.0,
        "n" => 1e-9,
        "u" => 1e-6,
        "m" => 1e-3,
        "k" => 1e3,
        "M" => 1e6,
        "G" => 1e9,
        "T" => 1e12,
        "P" => 1e15,
        "Ki" => 1024.0,
        "Mi" => 1024.0 * 1024.0,
        "Gi" => 1024.0 * 1024.0 * 1024.0,
        "Ti" => 1024.0_f64.powi(4),
        "Pi" => 1024.0_f64.powi(5),
        _ => return None,
    };
    Some(value * factor)
}

fn cpu_millis(raw: &str) -> u64 {
    (parse_quantity(raw).unwrap_or(0.0) * 1000.0).round() as u64
}

fn mem_bytes(raw: &str) -> u64 {
    parse_quantity(raw).unwrap_or(0.0).round() as u64
}

fn usage_of(value: &serde_json::Value) -> (u64, u64) {
    let cpu = value
        .get("cpu")
        .and_then(|v| v.as_str())
        .map(cpu_millis)
        .unwrap_or(0);
    let mem = value
        .get("memory")
        .and_then(|v| v.as_str())
        .map(mem_bytes)
        .unwrap_or(0);
    (cpu, mem)
}

pub async fn snapshot(client: &Client, namespace: &str) -> MetricsSnapshot {
    let node_gvk = GroupVersionKind::gvk("metrics.k8s.io", "v1beta1", "NodeMetrics");
    let pod_gvk = GroupVersionKind::gvk("metrics.k8s.io", "v1beta1", "PodMetrics");
    let node_ar = ApiResource::from_gvk_with_plural(&node_gvk, "nodes");
    let pod_ar = ApiResource::from_gvk_with_plural(&pod_gvk, "pods");

    let nodes_api = Api::<DynamicObject>::all_with(client.clone(), &node_ar);
    let pods_api = Api::<DynamicObject>::namespaced_with(client.clone(), namespace, &pod_ar);

    let lp = ListParams::default();
    // Hard deadline: when metrics-server is registered but failing (e.g. its
    // Pod is crash-looping), the aggregated API can hold requests open
    // indefinitely - found on a live k3s cluster. Fail fast and say why.
    let both = tokio::time::timeout(
        std::time::Duration::from_secs(6),
        futures::future::join(nodes_api.list(&lp), pods_api.list(&lp)),
    );
    let (nodes_res, pods_res) = match both.await {
        Ok(results) => results,
        Err(_) => {
            return MetricsSnapshot {
                available: false,
                reason: Some(
                    "The Metrics API did not respond. metrics-server may be installed but failing - check its Pod in kube-system."
                        .to_string(),
                ),
                nodes: vec![],
                pods: vec![],
            };
        }
    };

    let (nodes_list, pods_list) = match (nodes_res, pods_res) {
        (Ok(n), Ok(p)) => (n, p),
        (Err(e), _) | (_, Err(e)) => {
            let reason = match &e {
                kube::Error::Api(er) if er.code == 404 || er.code == 503 => {
                    "Metrics API is not available in this cluster. Install metrics-server to view CPU and memory usage.".to_string()
                }
                kube::Error::Api(er) if er.code == 403 => {
                    "You do not have permission to read the Metrics API in this cluster.".to_string()
                }
                other => format!("Metrics API request failed: {other}"),
            };
            return MetricsSnapshot {
                available: false,
                reason: Some(reason),
                nodes: vec![],
                pods: vec![],
            };
        }
    };

    let nodes = nodes_list
        .items
        .iter()
        .map(|item| {
            let (cpu, mem) = item.data.get("usage").map(usage_of).unwrap_or((0, 0));
            NodeMetrics {
                name: item.metadata.name.clone().unwrap_or_default(),
                cpu_millis: cpu,
                memory_bytes: mem,
            }
        })
        .collect();

    let pods = pods_list
        .items
        .iter()
        .map(|item| {
            let containers: Vec<ContainerMetrics> = item
                .data
                .get("containers")
                .and_then(|c| c.as_array())
                .map(|arr| {
                    arr.iter()
                        .map(|c| {
                            let (cpu, mem) = c.get("usage").map(usage_of).unwrap_or((0, 0));
                            ContainerMetrics {
                                name: c
                                    .get("name")
                                    .and_then(|n| n.as_str())
                                    .unwrap_or_default()
                                    .to_string(),
                                cpu_millis: cpu,
                                memory_bytes: mem,
                            }
                        })
                        .collect()
                })
                .unwrap_or_default();
            PodMetrics {
                namespace: item.metadata.namespace.clone().unwrap_or_default(),
                name: item.metadata.name.clone().unwrap_or_default(),
                cpu_millis: containers.iter().map(|c| c.cpu_millis).sum(),
                memory_bytes: containers.iter().map(|c| c.memory_bytes).sum(),
                containers,
            }
        })
        .collect();

    MetricsSnapshot {
        available: true,
        reason: None,
        nodes,
        pods,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quantities() {
        assert_eq!(parse_quantity("250m"), Some(0.25));
        assert_eq!(parse_quantity("2"), Some(2.0));
        assert_eq!(parse_quantity("128974848"), Some(128974848.0));
        assert_eq!(parse_quantity("129Mi"), Some(129.0 * 1024.0 * 1024.0));
        assert_eq!(parse_quantity("1Gi"), Some(1073741824.0));
        assert!((parse_quantity("500n").unwrap() - 5e-7).abs() < 1e-12);
        assert_eq!(parse_quantity(""), None);
        assert_eq!(parse_quantity("abc"), None);
        assert_eq!(cpu_millis("250m"), 250);
        assert_eq!(cpu_millis("1500000n"), 2); // 1.5m rounds to 2
    }
}
