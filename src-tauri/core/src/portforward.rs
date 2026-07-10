//! Local port-forward tunnels (`kubectl port-forward`). Listens on
//! 127.0.0.1 only; nothing in the cluster is mutated.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

use k8s_openapi::api::core::v1::{Pod, Service};
use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;
use kube::api::{Api, ListParams};
use kube::{Client, ResourceExt};
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use crate::model::{PortForwardInfo, PortForwardRequest};
use crate::{Error, Result};

struct ActiveForward {
    info: PortForwardInfo,
    accept_task: JoinHandle<()>,
}

#[derive(Default)]
pub struct PortForwardManager {
    forwards: Mutex<HashMap<String, ActiveForward>>,
    next_id: AtomicU64,
}

impl PortForwardManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn list(&self) -> Vec<PortForwardInfo> {
        let mut infos: Vec<PortForwardInfo> = self
            .forwards
            .lock()
            .await
            .values()
            .map(|f| f.info.clone())
            .collect();
        infos.sort_by(|a, b| a.id.cmp(&b.id));
        infos
    }

    pub async fn stop(&self, id: &str) -> Result<()> {
        match self.forwards.lock().await.remove(id) {
            Some(forward) => {
                forward.accept_task.abort();
                Ok(())
            }
            None => Err(Error::Invalid(format!("no port-forward with id {id}"))),
        }
    }

    pub async fn stop_all(&self) {
        for (_, forward) in self.forwards.lock().await.drain() {
            forward.accept_task.abort();
        }
    }

    pub async fn start(
        &self,
        client: &Client,
        req: &PortForwardRequest,
    ) -> Result<PortForwardInfo> {
        let (target_pod, pod_port) = resolve_target(client, req).await?;

        let listener = TcpListener::bind(("127.0.0.1", req.local_port))
            .await
            .map_err(|e| {
                Error::Invalid(format!(
                    "cannot listen on 127.0.0.1:{} - {}",
                    req.local_port,
                    if e.kind() == std::io::ErrorKind::AddrInUse {
                        "the port is already in use".to_string()
                    } else {
                        e.to_string()
                    }
                ))
            })?;

        let id = format!("pf-{}", self.next_id.fetch_add(1, Ordering::Relaxed) + 1);
        let info = PortForwardInfo {
            id: id.clone(),
            namespace: req.namespace.clone(),
            kind: req.kind.clone(),
            name: req.name.clone(),
            target_pod: target_pod.clone(),
            local_port: req.local_port,
            remote_port: req.remote_port,
        };

        let pods = Api::<Pod>::namespaced(client.clone(), &req.namespace);
        let accept_task = tokio::spawn(async move {
            loop {
                let Ok((mut local_conn, _)) = listener.accept().await else {
                    break;
                };
                let pods = pods.clone();
                let pod = target_pod.clone();
                // One API-server tunnel per TCP connection, like kubectl.
                tokio::spawn(async move {
                    let Ok(mut forwarder) = pods.portforward(&pod, &[pod_port]).await else {
                        return;
                    };
                    let Some(mut upstream) = forwarder.take_stream(pod_port) else {
                        return;
                    };
                    let _ = tokio::io::copy_bidirectional(&mut local_conn, &mut upstream).await;
                    let _ = forwarder.join().await;
                });
            }
        });

        self.forwards.lock().await.insert(
            id,
            ActiveForward {
                info: info.clone(),
                accept_task,
            },
        );
        Ok(info)
    }
}

/// Resolve what pod and pod-port a forward should target. For Services this
/// mirrors kubectl: pick a running pod matching the selector and map the
/// service port to its targetPort.
async fn resolve_target(client: &Client, req: &PortForwardRequest) -> Result<(String, u16)> {
    match req.kind.as_str() {
        "Pod" => Ok((req.name.clone(), req.remote_port)),
        "Service" => {
            let svc = Api::<Service>::namespaced(client.clone(), &req.namespace)
                .get(&req.name)
                .await?;
            let spec = svc
                .spec
                .ok_or_else(|| Error::Invalid("Service has no spec".into()))?;
            let selector = spec.selector.unwrap_or_default();
            if selector.is_empty() {
                return Err(Error::Invalid(format!(
                    "Service {} has no selector - cannot resolve a target Pod",
                    req.name
                )));
            }
            let label_selector = selector
                .iter()
                .map(|(k, v)| format!("{k}={v}"))
                .collect::<Vec<_>>()
                .join(",");
            let pods = Api::<Pod>::namespaced(client.clone(), &req.namespace)
                .list(&ListParams::default().labels(&label_selector))
                .await?;
            let pod = pods
                .items
                .iter()
                .find(|p| {
                    p.metadata.deletion_timestamp.is_none()
                        && p.status
                            .as_ref()
                            .and_then(|st| st.phase.as_deref())
                            .is_some_and(|phase| phase == "Running")
                })
                .ok_or_else(|| {
                    Error::Invalid(format!(
                        "Service {} selects no running Pods to forward to",
                        req.name
                    ))
                })?;

            // Map service port -> targetPort on the chosen pod.
            let port_spec = spec
                .ports
                .unwrap_or_default()
                .into_iter()
                .find(|p| p.port == i32::from(req.remote_port));
            let pod_port = match port_spec.and_then(|p| p.target_port) {
                Some(IntOrString::Int(n)) => u16::try_from(n)
                    .map_err(|_| Error::Invalid(format!("invalid targetPort {n}")))?,
                Some(IntOrString::String(port_name)) => pod
                    .spec
                    .as_ref()
                    .map(|sp| sp.containers.as_slice())
                    .unwrap_or_default()
                    .iter()
                    .flat_map(|c| c.ports.clone().unwrap_or_default())
                    .find(|p| p.name.as_deref() == Some(port_name.as_str()))
                    .map(|p| p.container_port as u16)
                    .ok_or_else(|| {
                        Error::Invalid(format!(
                            "named targetPort \"{port_name}\" not found on Pod {}",
                            pod.name_any()
                        ))
                    })?,
                None => req.remote_port,
            };
            Ok((pod.name_any(), pod_port))
        }
        other => Err(Error::Invalid(format!(
            "port-forward supports Pod or Service, not {other}"
        ))),
    }
}
