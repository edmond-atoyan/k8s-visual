//! The only cluster-mutating code in the app. Every action is validated,
//! explicit, and returns a structured result. The UI reaches this solely
//! through the management-mode confirmation flow.

use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, ReplicaSet, StatefulSet};
use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::apimachinery::pkg::apis::meta::v1::OwnerReference;
use kube::api::{Api, DeleteParams, ListParams, Patch, PatchParams, PostParams};
use kube::{Client, ResourceExt};
use serde_json::json;

use crate::model::{Action, ActionResult, RolloutRevision};
use crate::{yaml, Error, Result};

const REVISION_ANNOTATION: &str = "deployment.kubernetes.io/revision";

fn ok(message: String) -> ActionResult {
    ActionResult { ok: true, message }
}

pub async fn perform(client: &Client, action: Action) -> Result<ActionResult> {
    match action {
        Action::ScaleWorkload {
            kind,
            namespace,
            name,
            replicas,
        } => {
            if replicas < 0 {
                return Err(Error::Invalid("replicas must be ≥ 0".into()));
            }
            let patch = Patch::Merge(json!({ "spec": { "replicas": replicas } }));
            let pp = PatchParams::default();
            match kind.as_str() {
                "Deployment" => {
                    Api::<Deployment>::namespaced(client.clone(), &namespace)
                        .patch(&name, &pp, &patch)
                        .await?;
                }
                "StatefulSet" => {
                    Api::<StatefulSet>::namespaced(client.clone(), &namespace)
                        .patch(&name, &pp, &patch)
                        .await?;
                }
                "ReplicaSet" => {
                    Api::<ReplicaSet>::namespaced(client.clone(), &namespace)
                        .patch(&name, &pp, &patch)
                        .await?;
                }
                other => {
                    return Err(Error::Invalid(format!("cannot scale a {other}")));
                }
            }
            Ok(ok(format!(
                "Scaled {kind} {namespace}/{name} to {replicas} replica(s)"
            )))
        }

        Action::RestartRollout {
            kind,
            namespace,
            name,
        } => {
            let now = k8s_openapi::jiff::Timestamp::now().to_string();
            let patch = Patch::Merge(json!({
                "spec": { "template": { "metadata": { "annotations": {
                    "kubectl.kubernetes.io/restartedAt": now
                }}}}
            }));
            let pp = PatchParams::default();
            match kind.as_str() {
                "Deployment" => {
                    Api::<Deployment>::namespaced(client.clone(), &namespace)
                        .patch(&name, &pp, &patch)
                        .await?;
                }
                "StatefulSet" => {
                    Api::<StatefulSet>::namespaced(client.clone(), &namespace)
                        .patch(&name, &pp, &patch)
                        .await?;
                }
                "DaemonSet" => {
                    Api::<DaemonSet>::namespaced(client.clone(), &namespace)
                        .patch(&name, &pp, &patch)
                        .await?;
                }
                other => {
                    return Err(Error::Invalid(format!("cannot rollout-restart a {other}")));
                }
            }
            Ok(ok(format!(
                "Rollout restart triggered for {kind} {namespace}/{name}"
            )))
        }

        Action::RollbackDeployment {
            namespace,
            name,
            to_revision,
        } => rollback_deployment(client, &namespace, &name, to_revision).await,

        Action::PauseRollout {
            namespace,
            name,
            pause,
        } => {
            let patch = Patch::Merge(json!({ "spec": { "paused": pause } }));
            Api::<Deployment>::namespaced(client.clone(), &namespace)
                .patch(&name, &PatchParams::default(), &patch)
                .await?;
            Ok(ok(format!(
                "Rollout {} for Deployment {namespace}/{name}",
                if pause { "paused" } else { "resumed" }
            )))
        }

        Action::SuspendCronJob {
            namespace,
            name,
            suspend,
        } => {
            let patch = Patch::Merge(json!({ "spec": { "suspend": suspend } }));
            Api::<CronJob>::namespaced(client.clone(), &namespace)
                .patch(&name, &PatchParams::default(), &patch)
                .await?;
            Ok(ok(format!(
                "CronJob {namespace}/{name} {}",
                if suspend { "suspended" } else { "resumed" }
            )))
        }

        Action::TriggerCronJob { namespace, name } => {
            trigger_cronjob(client, &namespace, &name).await
        }

        Action::DeleteResource {
            kind,
            namespace,
            name,
            uid,
        } => {
            let api = yaml::dynamic_api(client, &kind, &namespace)?;
            // Precondition: only delete the exact object that was confirmed.
            // A same-named object created since then fails with a conflict
            // instead of being silently deleted in its place.
            let params = DeleteParams {
                preconditions: Some(kube::api::Preconditions {
                    uid: Some(uid),
                    resource_version: None,
                }),
                ..DeleteParams::default()
            };
            api.delete(&name, &params).await?;
            Ok(ok(format!("Deleted {kind} {namespace}/{name}")))
        }

        Action::CordonNode { name, cordon } => {
            let patch = Patch::Merge(json!({ "spec": { "unschedulable": cordon } }));
            Api::<k8s_openapi::api::core::v1::Node>::all(client.clone())
                .patch(&name, &PatchParams::default(), &patch)
                .await?;
            Ok(ok(format!(
                "Node {name} {}",
                if cordon {
                    "cordoned - no new Pods will be scheduled on it"
                } else {
                    "uncordoned - schedulable again"
                }
            )))
        }
    }
}

/// `kubectl rollout undo deployment/<name> [--to-revision]`: copy the pod
/// template of the target ReplicaSet revision back onto the Deployment.
async fn rollback_deployment(
    client: &Client,
    namespace: &str,
    name: &str,
    to_revision: Option<i64>,
) -> Result<ActionResult> {
    let deployments = Api::<Deployment>::namespaced(client.clone(), namespace);
    let deployment = deployments.get(name).await?;
    let current_revision: i64 = deployment
        .metadata
        .annotations
        .as_ref()
        .and_then(|a| a.get(REVISION_ANNOTATION))
        .and_then(|r| r.parse().ok())
        .unwrap_or(0);

    let owned = owned_replicasets(client, namespace, name).await?;
    let target = match to_revision {
        Some(rev) => owned.into_iter().find(|(r, _)| *r == rev),
        None => owned
            .into_iter()
            .filter(|(r, _)| *r < current_revision)
            .max_by_key(|(r, _)| *r),
    };
    let Some((revision, rs)) = target else {
        return Err(Error::Invalid(format!(
            "no previous revision found for Deployment {namespace}/{name}"
        )));
    };

    let Some(template) = rs.spec.as_ref().and_then(|sp| sp.template.clone()) else {
        return Err(Error::Invalid("target revision has no pod template".into()));
    };
    let mut template = serde_json::to_value(template)
        .map_err(|e| Error::Invalid(format!("could not encode template: {e}")))?;
    // The hash label belongs to the ReplicaSet, not the Deployment template.
    if let Some(labels) = template
        .pointer_mut("/metadata/labels")
        .and_then(|l| l.as_object_mut())
    {
        labels.remove("pod-template-hash");
    }
    deployments
        .patch(
            name,
            &PatchParams::default(),
            &Patch::Strategic(json!({ "spec": { "template": template } })),
        )
        .await?;
    Ok(ok(format!(
        "Rolled Deployment {namespace}/{name} back to revision {revision}"
    )))
}

async fn owned_replicasets(
    client: &Client,
    namespace: &str,
    deployment: &str,
) -> Result<Vec<(i64, ReplicaSet)>> {
    let list = Api::<ReplicaSet>::namespaced(client.clone(), namespace)
        .list(&ListParams::default())
        .await?;
    Ok(list
        .items
        .into_iter()
        .filter(|rs| {
            rs.owner_references()
                .iter()
                .any(|o| o.kind == "Deployment" && o.name == deployment)
        })
        .filter_map(|rs| {
            let revision: i64 = rs
                .metadata
                .annotations
                .as_ref()
                .and_then(|a| a.get(REVISION_ANNOTATION))
                .and_then(|r| r.parse().ok())?;
            Some((revision, rs))
        })
        .collect())
}

/// `kubectl rollout history deployment/<name>` from ReplicaSet revisions.
pub async fn rollout_history(
    client: &Client,
    namespace: &str,
    name: &str,
) -> Result<Vec<RolloutRevision>> {
    let deployments = Api::<Deployment>::namespaced(client.clone(), namespace);
    let deployment = deployments.get(name).await?;
    let current_revision: i64 = deployment
        .metadata
        .annotations
        .as_ref()
        .and_then(|a| a.get(REVISION_ANNOTATION))
        .and_then(|r| r.parse().ok())
        .unwrap_or(0);

    let mut revisions: Vec<RolloutRevision> = owned_replicasets(client, namespace, name)
        .await?
        .into_iter()
        .map(|(revision, rs)| {
            let images: Vec<String> = rs
                .spec
                .as_ref()
                .and_then(|sp| sp.template.as_ref())
                .and_then(|t| t.spec.as_ref())
                .map(|ps| {
                    ps.containers
                        .iter()
                        .filter_map(|c| c.image.clone())
                        .collect()
                })
                .unwrap_or_default();
            RolloutRevision {
                revision,
                replica_set: rs.name_any(),
                images,
                ready: rs
                    .status
                    .as_ref()
                    .and_then(|st| st.ready_replicas)
                    .unwrap_or(0),
                desired: rs.spec.as_ref().and_then(|sp| sp.replicas).unwrap_or(0),
                current: revision == current_revision,
            }
        })
        .collect();
    revisions.sort_by_key(|r| std::cmp::Reverse(r.revision));
    Ok(revisions)
}

/// `kubectl create job --from=cronjob/<name>`: instantiate the job template.
async fn trigger_cronjob(client: &Client, namespace: &str, name: &str) -> Result<ActionResult> {
    let cronjobs = Api::<CronJob>::namespaced(client.clone(), namespace);
    let cronjob = cronjobs.get(name).await?;
    let Some(job_spec) = cronjob.spec.job_template.spec.clone() else {
        return Err(Error::Invalid("CronJob has no job template".into()));
    };
    let mut job = Job {
        spec: Some(job_spec),
        ..Default::default()
    };
    job.metadata.generate_name = Some(format!("{name}-manual-"));
    job.metadata.namespace = Some(namespace.to_string());
    job.metadata.annotations = Some(
        [(
            "cronjob.kubernetes.io/instantiate".to_string(),
            "manual".to_string(),
        )]
        .into(),
    );
    if let Some(uid) = cronjob.uid() {
        job.metadata.owner_references = Some(vec![OwnerReference {
            api_version: "batch/v1".into(),
            kind: "CronJob".into(),
            name: name.to_string(),
            uid,
            controller: Some(false),
            block_owner_deletion: None,
        }]);
    }
    let created = Api::<Job>::namespaced(client.clone(), namespace)
        .create(&PostParams::default(), &job)
        .await?;
    Ok(ok(format!(
        "Created Job {namespace}/{} from CronJob {name}",
        created.name_any()
    )))
}
