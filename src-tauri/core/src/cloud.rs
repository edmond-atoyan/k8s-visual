//! Cloud managed-cluster connect (Amazon EKS / Azure AKS / Google GKE).
//!
//! This module's ONLY job is credential discovery and kubeconfig import, done
//! by shelling out to the user's already-authenticated cloud CLI (`aws`,
//! `az`, `gcloud`). The CLIs write the kubeconfig entry themselves; the app
//! never reads, stores, or transmits cloud credentials, and never asks for
//! secret keys. Once a context exists, connecting goes through the exact same
//! kubeconfig path as any local cluster ([`crate::Bridge::connect`]).

use std::time::Duration;

use kube::config::Kubeconfig;

use crate::model::{CloudCliStatus, CloudCluster, CloudImportOutcome, CloudKind, CloudScope};
use crate::{Error, Result};

const LIST_TIMEOUT: u64 = 45;
const IMPORT_TIMEOUT: u64 = 120;

/// AWS regions offered for EKS discovery (a profile's own default region is
/// listed first). Kept static so listing needs no extra IAM permissions.
const AWS_REGIONS: &[&str] = &[
    "us-east-1",
    "us-east-2",
    "us-west-1",
    "us-west-2",
    "af-south-1",
    "ap-northeast-1",
    "ap-northeast-2",
    "ap-northeast-3",
    "ap-south-1",
    "ap-southeast-1",
    "ap-southeast-2",
    "ap-southeast-3",
    "ca-central-1",
    "eu-central-1",
    "eu-central-2",
    "eu-north-1",
    "eu-south-1",
    "eu-west-1",
    "eu-west-2",
    "eu-west-3",
    "il-central-1",
    "me-central-1",
    "me-south-1",
    "sa-east-1",
];

// --- process runner ----------------------------------------------------------

enum CmdError {
    /// The binary itself is not on PATH.
    NotFound,
    /// Ran but exited non-zero; carries trimmed stderr.
    Failed(String),
    TimedOut,
    Io(String),
}

/// PATH as the desktop session sees it, plus the usual CLI install locations
/// (GUI launchers often start with a minimal PATH). Also used by the app's
/// integrated terminal so `kubectl`/cloud/AI CLIs resolve the same way.
pub fn augmented_path() -> String {
    let mut path = std::env::var("PATH").unwrap_or_default();
    let mut extras: Vec<String> = vec![
        "/usr/local/bin".into(),
        "/snap/bin".into(),
        "/opt/homebrew/bin".into(),
    ];
    if let Ok(home) = std::env::var("HOME") {
        extras.push(format!("{home}/.local/bin"));
        extras.push(format!("{home}/google-cloud-sdk/bin"));
    }
    for extra in extras {
        if !path.split(':').any(|p| p == extra) {
            path.push(':');
            path.push_str(&extra);
        }
    }
    path
}

async fn run(bin: &str, args: &[&str], timeout_secs: u64) -> std::result::Result<String, CmdError> {
    let fut = tokio::process::Command::new(bin)
        .args(args)
        .env("PATH", augmented_path())
        .kill_on_drop(true)
        .output();
    match tokio::time::timeout(Duration::from_secs(timeout_secs), fut).await {
        Err(_) => Err(CmdError::TimedOut),
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => Err(CmdError::NotFound),
        Ok(Err(e)) => Err(CmdError::Io(e.to_string())),
        Ok(Ok(out)) => {
            if out.status.success() {
                Ok(String::from_utf8_lossy(&out.stdout).into_owned())
            } else {
                let mut msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
                if msg.is_empty() {
                    msg = String::from_utf8_lossy(&out.stdout).trim().to_string();
                }
                crate::truncate_utf8(&mut msg, 500);
                Err(CmdError::Failed(msg))
            }
        }
    }
}

fn cli_name(kind: CloudKind) -> &'static str {
    match kind {
        CloudKind::Aws => "aws",
        CloudKind::Azure => "az",
        CloudKind::Gcp => "gcloud",
    }
}

fn install_hint(kind: CloudKind) -> &'static str {
    match kind {
        CloudKind::Aws => "AWS CLI not found. Install it (https://aws.amazon.com/cli/), run `aws configure` (or `aws configure sso`), then retry.",
        CloudKind::Azure => "Azure CLI not found. Install it (https://aka.ms/azure-cli), run `az login`, then retry.",
        CloudKind::Gcp => "gcloud CLI not found. Install the Google Cloud SDK (https://cloud.google.com/sdk), run `gcloud auth login`, then retry.",
    }
}

fn map_err(kind: CloudKind, what: &str, e: CmdError) -> Error {
    let bin = cli_name(kind);
    Error::Invalid(match e {
        CmdError::NotFound => install_hint(kind).to_string(),
        CmdError::Failed(msg) => format!("`{bin}` failed while {what}: {msg}"),
        CmdError::TimedOut => {
            format!("`{bin}` timed out while {what} - check your network/VPN and retry.")
        }
        CmdError::Io(msg) => format!("could not run `{bin}`: {msg}"),
    })
}

// --- CLI + auth status --------------------------------------------------------

/// Never fails: problems are reported in the returned struct so the UI can
/// show instructions instead of a raw error.
pub async fn cli_status(kind: CloudKind) -> CloudCliStatus {
    match kind {
        CloudKind::Aws => match run("aws", &["configure", "list-profiles"], LIST_TIMEOUT).await {
            Ok(out) => {
                let profiles = parse_lines(&out);
                if profiles.is_empty() {
                    CloudCliStatus {
                        installed: true,
                        authenticated: false,
                        account: None,
                        detail: Some("No AWS profiles found - run `aws configure` (or `aws configure sso`) first.".into()),
                    }
                } else {
                    CloudCliStatus {
                        installed: true,
                        authenticated: true,
                        account: Some(format!("{} profile(s) found", profiles.len())),
                        detail: None,
                    }
                }
            }
            Err(CmdError::NotFound) => CloudCliStatus {
                installed: false,
                authenticated: false,
                account: None,
                detail: Some(install_hint(kind).into()),
            },
            Err(e) => status_error(kind, e),
        },
        CloudKind::Azure => match run(
            "az",
            &["account", "show", "-o", "json", "--only-show-errors"],
            LIST_TIMEOUT,
        )
        .await
        {
            Ok(out) => match parse_az_account(&out) {
                Some((user, sub)) => CloudCliStatus {
                    installed: true,
                    authenticated: true,
                    account: Some(user),
                    detail: Some(format!("default subscription: {sub}")),
                },
                None => status_error(
                    kind,
                    CmdError::Failed("unexpected `az account show` output".into()),
                ),
            },
            Err(CmdError::NotFound) => CloudCliStatus {
                installed: false,
                authenticated: false,
                account: None,
                detail: Some(install_hint(kind).into()),
            },
            Err(CmdError::Failed(_)) => CloudCliStatus {
                installed: true,
                authenticated: false,
                account: None,
                detail: Some("Not signed in to Azure - run `az login`, then retry.".into()),
            },
            Err(e) => status_error(kind, e),
        },
        CloudKind::Gcp => match run("gcloud", &["auth", "list", "--format=json"], LIST_TIMEOUT)
            .await
        {
            Ok(out) => match parse_gcloud_active_account(&out) {
                Some(account) => CloudCliStatus {
                    installed: true,
                    authenticated: true,
                    account: Some(account),
                    detail: None,
                },
                None => CloudCliStatus {
                    installed: true,
                    authenticated: false,
                    account: None,
                    detail: Some(
                        "No active gcloud account - run `gcloud auth login`, then retry.".into(),
                    ),
                },
            },
            Err(CmdError::NotFound) => CloudCliStatus {
                installed: false,
                authenticated: false,
                account: None,
                detail: Some(install_hint(kind).into()),
            },
            Err(e) => status_error(kind, e),
        },
    }
}

fn status_error(kind: CloudKind, e: CmdError) -> CloudCliStatus {
    CloudCliStatus {
        installed: true,
        authenticated: false,
        account: None,
        detail: Some(map_err(kind, "checking the CLI", e).to_string()),
    }
}

// --- scopes: profiles / subscriptions / projects -------------------------------

pub async fn scopes(kind: CloudKind) -> Result<Vec<CloudScope>> {
    match kind {
        CloudKind::Aws => {
            let out = run("aws", &["configure", "list-profiles"], LIST_TIMEOUT)
                .await
                .map_err(|e| map_err(kind, "listing profiles", e))?;
            let profiles = parse_lines(&out);
            if profiles.is_empty() {
                return Err(Error::Invalid(
                    "No AWS profiles found - run `aws configure` (or `aws configure sso`) first."
                        .into(),
                ));
            }
            Ok(profiles
                .into_iter()
                .map(|p| CloudScope {
                    default: p == "default",
                    label: p.clone(),
                    id: p,
                    detail: None,
                })
                .collect())
        }
        CloudKind::Azure => {
            let out = run(
                "az",
                &["account", "list", "-o", "json", "--only-show-errors"],
                LIST_TIMEOUT,
            )
            .await
            .map_err(|e| map_err(kind, "listing subscriptions", e))?;
            let subs = parse_az_subscriptions(&out)?;
            if subs.is_empty() {
                return Err(Error::Invalid(
                    "No Azure subscriptions visible - run `az login`.".into(),
                ));
            }
            Ok(subs)
        }
        CloudKind::Gcp => {
            // The configured default project always works; the full project
            // list needs resourcemanager permissions and may be unavailable.
            let default = run("gcloud", &["config", "get-value", "project"], LIST_TIMEOUT)
                .await
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty() && s != "(unset)");
            let listed = run(
                "gcloud",
                &["projects", "list", "--format=json"],
                LIST_TIMEOUT,
            )
            .await
            .ok()
            .and_then(|out| parse_gcp_projects(&out).ok())
            .unwrap_or_default();
            let mut scopes = listed;
            if let Some(def) = &default {
                if let Some(s) = scopes.iter_mut().find(|s| &s.id == def) {
                    s.default = true;
                } else {
                    scopes.insert(
                        0,
                        CloudScope {
                            id: def.clone(),
                            label: def.clone(),
                            detail: Some("current gcloud project".into()),
                            default: true,
                        },
                    );
                }
            }
            if scopes.is_empty() {
                return Err(Error::Invalid(
                    "No GCP project available - run `gcloud config set project <id>` or grant project list access.".into(),
                ));
            }
            Ok(scopes)
        }
    }
}

/// AWS only: regions to search for EKS clusters (the profile's configured
/// default region first). Azure/GCP cluster listings already span locations.
pub async fn regions(kind: CloudKind, scope: &str) -> Result<Vec<CloudScope>> {
    if kind != CloudKind::Aws {
        return Ok(Vec::new());
    }
    let default = run(
        "aws",
        &["configure", "get", "region", "--profile", scope],
        LIST_TIMEOUT,
    )
    .await
    .ok()
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty());
    let mut out: Vec<CloudScope> = Vec::new();
    if let Some(def) = &default {
        out.push(CloudScope {
            id: def.clone(),
            label: def.clone(),
            detail: Some("profile default".into()),
            default: true,
        });
    }
    for r in AWS_REGIONS {
        if Some(*r) != default.as_deref() {
            out.push(CloudScope {
                id: (*r).into(),
                label: (*r).into(),
                detail: None,
                default: false,
            });
        }
    }
    Ok(out)
}

// --- cluster discovery ----------------------------------------------------------

pub async fn clusters(
    kind: CloudKind,
    scope: &str,
    region: Option<&str>,
) -> Result<Vec<CloudCluster>> {
    match kind {
        CloudKind::Aws => {
            let region = region.ok_or_else(|| Error::Invalid("pick an AWS region first".into()))?;
            let out = run(
                "aws",
                &[
                    "eks",
                    "list-clusters",
                    "--profile",
                    scope,
                    "--region",
                    region,
                    "--output",
                    "json",
                ],
                LIST_TIMEOUT,
            )
            .await
            .map_err(|e| map_err(kind, "listing EKS clusters", e))?;
            parse_eks_clusters(&out, region)
        }
        CloudKind::Azure => {
            let out = run(
                "az",
                &[
                    "aks",
                    "list",
                    "--subscription",
                    scope,
                    "-o",
                    "json",
                    "--only-show-errors",
                ],
                LIST_TIMEOUT,
            )
            .await
            .map_err(|e| map_err(kind, "listing AKS clusters", e))?;
            parse_aks_clusters(&out)
        }
        CloudKind::Gcp => {
            let out = run(
                "gcloud",
                &[
                    "container",
                    "clusters",
                    "list",
                    "--project",
                    scope,
                    "--format=json",
                ],
                LIST_TIMEOUT,
            )
            .await
            .map_err(|e| map_err(kind, "listing GKE clusters", e))?;
            parse_gke_clusters(&out)
        }
    }
}

// --- kubeconfig import ------------------------------------------------------------

/// Let the provider CLI write/refresh the kubeconfig entry for one cluster,
/// then report the resulting context (all three CLIs also make it current).
/// No credentials pass through this process.
pub async fn import(
    kind: CloudKind,
    scope: &str,
    cluster: &CloudCluster,
) -> Result<CloudImportOutcome> {
    match kind {
        CloudKind::Aws => {
            run(
                "aws",
                &[
                    "eks",
                    "update-kubeconfig",
                    "--profile",
                    scope,
                    "--region",
                    &cluster.location,
                    "--name",
                    &cluster.name,
                ],
                IMPORT_TIMEOUT,
            )
            .await
            .map_err(|e| map_err(kind, "updating kubeconfig", e))?;
        }
        CloudKind::Azure => {
            let group = cluster.group.as_deref().ok_or_else(|| {
                Error::Invalid("missing resource group for the AKS cluster".into())
            })?;
            run(
                "az",
                &[
                    "aks",
                    "get-credentials",
                    "--subscription",
                    scope,
                    "--resource-group",
                    group,
                    "--name",
                    &cluster.name,
                    "--overwrite-existing",
                    "--only-show-errors",
                ],
                IMPORT_TIMEOUT,
            )
            .await
            .map_err(|e| map_err(kind, "importing AKS credentials", e))?;
        }
        CloudKind::Gcp => {
            run(
                "gcloud",
                &[
                    "container",
                    "clusters",
                    "get-credentials",
                    &cluster.name,
                    "--project",
                    scope,
                    "--location",
                    &cluster.location,
                ],
                IMPORT_TIMEOUT,
            )
            .await
            .map_err(|e| map_err(kind, "importing GKE credentials", e))?;
        }
    }
    // Every provider CLI sets current-context to the imported cluster.
    let context = Kubeconfig::read()
        .map_err(|e| Error::Kubeconfig(e.to_string()))?
        .current_context
        .ok_or_else(|| Error::Invalid("kubeconfig has no current context after import".into()))?;
    Ok(CloudImportOutcome { context })
}

// --- parsing (pure, unit-tested) -----------------------------------------------

fn parse_lines(out: &str) -> Vec<String> {
    out.lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

fn parse_az_account(json: &str) -> Option<(String, String)> {
    #[derive(serde::Deserialize)]
    struct User {
        name: Option<String>,
    }
    #[derive(serde::Deserialize)]
    struct Account {
        name: Option<String>,
        user: Option<User>,
    }
    let acc: Account = serde_json::from_str(json).ok()?;
    Some((
        acc.user
            .and_then(|u| u.name)
            .unwrap_or_else(|| "signed in".into()),
        acc.name.unwrap_or_default(),
    ))
}

fn parse_az_subscriptions(json: &str) -> Result<Vec<CloudScope>> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Sub {
        id: String,
        name: String,
        #[serde(default)]
        is_default: bool,
        #[serde(default)]
        state: Option<String>,
    }
    let subs: Vec<Sub> = serde_json::from_str(json)
        .map_err(|e| Error::Invalid(format!("unexpected `az account list` output: {e}")))?;
    Ok(subs
        .into_iter()
        .map(|s| CloudScope {
            id: s.id,
            label: s.name,
            detail: s.state.filter(|st| st != "Enabled"),
            default: s.is_default,
        })
        .collect())
}

fn parse_gcloud_active_account(json: &str) -> Option<String> {
    #[derive(serde::Deserialize)]
    struct Entry {
        account: String,
        status: Option<String>,
    }
    let entries: Vec<Entry> = serde_json::from_str(json).ok()?;
    entries
        .into_iter()
        .find(|e| e.status.as_deref() == Some("ACTIVE"))
        .map(|e| e.account)
}

fn parse_gcp_projects(json: &str) -> Result<Vec<CloudScope>> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Project {
        project_id: String,
        name: Option<String>,
    }
    let projects: Vec<Project> = serde_json::from_str(json)
        .map_err(|e| Error::Invalid(format!("unexpected `gcloud projects list` output: {e}")))?;
    Ok(projects
        .into_iter()
        .map(|p| CloudScope {
            detail: p.name.filter(|n| n != &p.project_id),
            label: p.project_id.clone(),
            id: p.project_id,
            default: false,
        })
        .collect())
}

fn parse_eks_clusters(json: &str, region: &str) -> Result<Vec<CloudCluster>> {
    #[derive(serde::Deserialize)]
    struct Out {
        clusters: Vec<String>,
    }
    let out: Out = serde_json::from_str(json)
        .map_err(|e| Error::Invalid(format!("unexpected `aws eks list-clusters` output: {e}")))?;
    Ok(out
        .clusters
        .into_iter()
        .map(|name| CloudCluster {
            name,
            location: region.into(),
            group: None,
            detail: None,
        })
        .collect())
}

fn parse_aks_clusters(json: &str) -> Result<Vec<CloudCluster>> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Aks {
        name: String,
        location: String,
        resource_group: String,
        kubernetes_version: Option<String>,
    }
    let list: Vec<Aks> = serde_json::from_str(json)
        .map_err(|e| Error::Invalid(format!("unexpected `az aks list` output: {e}")))?;
    Ok(list
        .into_iter()
        .map(|c| CloudCluster {
            detail: Some(match &c.kubernetes_version {
                Some(v) => format!("{} · v{v}", c.resource_group),
                None => c.resource_group.clone(),
            }),
            group: Some(c.resource_group),
            name: c.name,
            location: c.location,
        })
        .collect())
}

fn parse_gke_clusters(json: &str) -> Result<Vec<CloudCluster>> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Gke {
        name: String,
        location: String,
        status: Option<String>,
        current_master_version: Option<String>,
    }
    let list: Vec<Gke> = serde_json::from_str(json).map_err(|e| {
        Error::Invalid(format!(
            "unexpected `gcloud container clusters list` output: {e}"
        ))
    })?;
    Ok(list
        .into_iter()
        .map(|c| CloudCluster {
            name: c.name,
            location: c.location,
            group: None,
            detail: match (c.status.as_deref(), c.current_master_version) {
                (Some("RUNNING") | None, Some(v)) => Some(format!("v{v}")),
                (Some(s), Some(v)) => Some(format!("{s} · v{v}")),
                (Some(s), None) => Some(s.to_string()),
                _ => None,
            },
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aws_profiles_parse_as_lines() {
        assert_eq!(
            parse_lines("default\nstaging\n\n"),
            vec!["default", "staging"]
        );
    }

    #[test]
    fn eks_cluster_list_parses() {
        let got = parse_eks_clusters(r#"{"clusters":["prod","staging"]}"#, "eu-west-1").unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].name, "prod");
        assert_eq!(got[0].location, "eu-west-1");
    }

    #[test]
    fn az_subscriptions_parse_with_default_flag() {
        let json = r#"[
            {"id":"sub-1","name":"Dev","isDefault":false,"state":"Enabled"},
            {"id":"sub-2","name":"Prod","isDefault":true,"state":"Enabled"}
        ]"#;
        let got = parse_az_subscriptions(json).unwrap();
        assert_eq!(got[1].label, "Prod");
        assert!(got[1].default);
        assert!(got[0].detail.is_none()); // "Enabled" is not worth showing
    }

    #[test]
    fn aks_clusters_carry_resource_group_for_import() {
        let json = r#"[{"name":"shop","location":"westeurope","resourceGroup":"rg-shop","kubernetesVersion":"1.29.2"}]"#;
        let got = parse_aks_clusters(json).unwrap();
        assert_eq!(got[0].group.as_deref(), Some("rg-shop"));
        assert_eq!(got[0].detail.as_deref(), Some("rg-shop · v1.29.2"));
    }

    #[test]
    fn gcloud_active_account_found() {
        let json = r#"[{"account":"a@example.com","status":""},{"account":"b@example.com","status":"ACTIVE"}]"#;
        assert_eq!(
            parse_gcloud_active_account(json).as_deref(),
            Some("b@example.com")
        );
    }

    #[test]
    fn gke_clusters_parse_location_and_version() {
        let json = r#"[{"name":"prod","location":"europe-west1","status":"RUNNING","currentMasterVersion":"1.30.1-gke.100"}]"#;
        let got = parse_gke_clusters(json).unwrap();
        assert_eq!(got[0].location, "europe-west1");
        assert_eq!(got[0].detail.as_deref(), Some("v1.30.1-gke.100"));
    }
}
