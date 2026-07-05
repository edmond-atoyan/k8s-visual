//! RBAC self-checks: what is the current user allowed to do?
//! Uses SelfSubjectAccessReview so the answer comes from the cluster itself.

use k8s_openapi::api::authorization::v1::{
    ResourceAttributes, SelfSubjectAccessReview, SelfSubjectAccessReviewSpec,
};
use kube::api::{Api, PostParams};
use kube::Client;

use crate::model::{AccessCheck, AccessResult};
use crate::Result;

pub async fn check_access(client: &Client, checks: Vec<AccessCheck>) -> Result<Vec<AccessResult>> {
    let api = Api::<SelfSubjectAccessReview>::all(client.clone());
    let futures = checks.into_iter().map(|check| {
        let api = api.clone();
        async move {
            let review = SelfSubjectAccessReview {
                spec: SelfSubjectAccessReviewSpec {
                    resource_attributes: Some(ResourceAttributes {
                        verb: Some(check.verb.clone()),
                        resource: Some(check.resource.clone()),
                        group: check.group.clone(),
                        namespace: check.namespace.clone(),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
                ..Default::default()
            };
            match api.create(&PostParams::default(), &review).await {
                Ok(res) => {
                    let status = res.status.unwrap_or_default();
                    AccessResult {
                        check,
                        allowed: status.allowed,
                        reason: status.reason,
                    }
                }
                Err(e) => AccessResult {
                    check,
                    allowed: false,
                    reason: Some(format!("access review failed: {e}")),
                },
            }
        }
    });
    Ok(futures::future::join_all(futures).await)
}
