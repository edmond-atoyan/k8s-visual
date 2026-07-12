//! Helm integration: releases, charts, repos, and gated write actions - all
//! by shelling out to the user's own `helm` binary (same pattern and safety
//! rules as [`crate::cloud`]). Every command pins `--kube-context` to the
//! app's connection, so the terminal's current-context is never assumed or
//! switched. Mutating operations exist only behind the frontend's
//! management-mode confirmation flow.

use std::process::Stdio;
use std::time::Duration;

use serde::Deserialize;

use crate::cloud::augmented_path;
use crate::model::{
    HelmChartHit, HelmRelease, HelmReleaseDetail, HelmRepo, HelmRevision, HelmStatus,
};
use crate::{Error, Result};

const LIST_TIMEOUT: u64 = 60;
const ACTION_TIMEOUT: u64 = 300;

async fn run(args: &[&str], stdin: Option<&str>, timeout_secs: u64) -> Result<String> {
    let mut cmd = tokio::process::Command::new("helm");
    cmd.args(args)
        .env("PATH", augmented_path())
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let fut = async {
        let mut child = cmd.spawn()?;
        if let (Some(data), Some(mut pipe)) = (stdin, child.stdin.take()) {
            use tokio::io::AsyncWriteExt;
            pipe.write_all(data.as_bytes()).await?;
            drop(pipe);
        }
        child.wait_with_output().await
    };

    match tokio::time::timeout(Duration::from_secs(timeout_secs), fut).await {
        Err(_) => Err(Error::Invalid(
            "`helm` timed out - check cluster reachability and try again.".into(),
        )),
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => Err(Error::Invalid(
            "Helm is not installed. Get it from https://helm.sh/docs/intro/install/ and retry."
                .into(),
        )),
        Ok(Err(e)) => Err(Error::Invalid(format!("could not run `helm`: {e}"))),
        Ok(Ok(out)) => {
            if out.status.success() {
                Ok(String::from_utf8_lossy(&out.stdout).into_owned())
            } else {
                let mut msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
                if msg.is_empty() {
                    msg = String::from_utf8_lossy(&out.stdout).trim().to_string();
                }
                crate::truncate_utf8(&mut msg, 600);
                Err(Error::Invalid(format!("helm: {msg}")))
            }
        }
    }
}

/// Never fails: reports installation state for the UI.
pub async fn status() -> HelmStatus {
    match run(&["version", "--template", "{{.Version}}"], None, 20).await {
        Ok(v) => HelmStatus {
            installed: true,
            version: Some(v.trim().to_string()),
            detail: None,
        },
        Err(e) => HelmStatus {
            installed: false,
            version: None,
            detail: Some(e.to_string()),
        },
    }
}

#[derive(Deserialize)]
struct RawRelease {
    name: String,
    namespace: String,
    revision: String,
    updated: String,
    status: String,
    chart: String,
    app_version: String,
}

pub async fn releases(context: &str, namespace: Option<&str>) -> Result<Vec<HelmRelease>> {
    let mut args = vec!["list", "--kube-context", context, "-o", "json", "--all"];
    match namespace {
        Some(ns) => args.extend(["-n", ns]),
        None => args.push("-A"),
    }
    let out = run(&args, None, LIST_TIMEOUT).await?;
    let raw: Vec<RawRelease> = serde_json::from_str(&out)
        .map_err(|e| Error::Invalid(format!("unexpected `helm list` output: {e}")))?;
    Ok(raw
        .into_iter()
        .map(|r| HelmRelease {
            name: r.name,
            namespace: r.namespace,
            revision: r.revision.parse().unwrap_or(0),
            updated: r.updated,
            status: r.status,
            chart: r.chart,
            app_version: r.app_version,
        })
        .collect())
}

#[derive(Deserialize)]
struct RawRevision {
    revision: i64,
    updated: String,
    status: String,
    chart: String,
    app_version: String,
    description: String,
}

pub async fn release_detail(
    context: &str,
    namespace: &str,
    name: &str,
) -> Result<HelmReleaseDetail> {
    let base = |sub: &'static str| {
        let ctx = context.to_string();
        let ns = namespace.to_string();
        let n = name.to_string();
        async move {
            run(
                &["get", sub, &n, "--kube-context", &ctx, "-n", &ns],
                None,
                LIST_TIMEOUT,
            )
            .await
        }
    };
    let manifest = base("manifest")
        .await
        .map(|m| mask_secret_documents(&m))
        .unwrap_or_else(|e| format!("# {e}"));
    let notes = base("notes").await.unwrap_or_default();
    let history_raw = run(
        &[
            "history",
            name,
            "--kube-context",
            context,
            "-n",
            namespace,
            "-o",
            "json",
        ],
        None,
        LIST_TIMEOUT,
    )
    .await?;
    let history: Vec<RawRevision> = serde_json::from_str(&history_raw)
        .map_err(|e| Error::Invalid(format!("unexpected `helm history` output: {e}")))?;
    Ok(HelmReleaseDetail {
        manifest,
        notes,
        history: history
            .into_iter()
            .map(|h| HelmRevision {
                revision: h.revision,
                updated: h.updated,
                status: h.status,
                chart: h.chart,
                app_version: h.app_version,
                description: h.description,
            })
            .collect(),
    })
}

/// Values as the user supplied them (`helm get values`). A separate call by
/// design: values commonly contain credentials, so the UI fetches them only
/// on an explicit "Show values" action, never as part of routine detail.
pub async fn release_values(context: &str, namespace: &str, name: &str) -> Result<String> {
    run(
        &[
            "get",
            "values",
            name,
            "--kube-context",
            context,
            "-n",
            namespace,
            "-o",
            "yaml",
        ],
        None,
        LIST_TIMEOUT,
    )
    .await
}

/// Mask `data`/`stringData` values in every `kind: Secret` document of a
/// rendered manifest - key names stay visible, values never do (same rule as
/// the YAML view). Fails CLOSED: if the manifest cannot be parsed, it is not
/// shown at all - an unparseable manifest must never mean an unmasked one.
fn mask_secret_documents(manifest: &str) -> String {
    use serde_yaml::Value;
    let mut docs: Vec<Value> = Vec::new();
    for de in serde_yaml::Deserializer::from_str(manifest) {
        match Value::deserialize(de) {
            Ok(Value::Null) => {}
            Ok(v) => docs.push(v),
            Err(_) => {
                return "# The manifest could not be parsed for Secret masking, so it is not \
                        shown here.\n# Inspect it with: helm get manifest <release>"
                    .to_string()
            }
        }
    }
    let mut masked = false;
    for doc in &mut docs {
        if doc.get("kind").and_then(Value::as_str) != Some("Secret") {
            continue;
        }
        for field in ["data", "stringData"] {
            if let Some(map) = doc.get_mut(field).and_then(Value::as_mapping_mut) {
                for value in map.values_mut() {
                    *value = Value::String("«hidden - secret value»".into());
                    masked = true;
                }
            }
        }
    }
    if !masked {
        return manifest.to_string();
    }
    let mut out = String::new();
    for doc in &docs {
        if let Ok(text) = serde_yaml::to_string(doc) {
            out.push_str("---\n");
            out.push_str(&text);
        }
    }
    out
}

pub async fn repos() -> Result<Vec<HelmRepo>> {
    #[derive(Deserialize)]
    struct RawRepo {
        name: String,
        url: String,
    }
    match run(&["repo", "list", "-o", "json"], None, LIST_TIMEOUT).await {
        Ok(out) => {
            let raw: Vec<RawRepo> = serde_json::from_str(&out)
                .map_err(|e| Error::Invalid(format!("unexpected `helm repo list` output: {e}")))?;
            Ok(raw
                .into_iter()
                .map(|r| HelmRepo {
                    name: r.name,
                    url: r.url,
                })
                .collect())
        }
        // "no repositories to show" exits non-zero - that is an empty list, not an error.
        Err(Error::Invalid(msg)) if msg.contains("no repositories") => Ok(Vec::new()),
        Err(e) => Err(e),
    }
}

pub async fn search(query: &str) -> Result<Vec<HelmChartHit>> {
    #[derive(Deserialize)]
    struct RawHit {
        name: String,
        version: String,
        app_version: String,
        description: String,
    }
    match run(&["search", "repo", query, "-o", "json"], None, LIST_TIMEOUT).await {
        Ok(out) => {
            let raw: Vec<RawHit> = serde_json::from_str(&out)
                .map_err(|e| Error::Invalid(format!("unexpected `helm search` output: {e}")))?;
            Ok(raw
                .into_iter()
                .map(|h| HelmChartHit {
                    name: h.name,
                    version: h.version,
                    app_version: h.app_version,
                    description: h.description,
                })
                .collect())
        }
        Err(Error::Invalid(msg)) if msg.contains("no results") => Ok(Vec::new()),
        Err(e) => Err(e),
    }
}

/// `helm show values|chart|readme <repo/chart>`.
pub async fn show(kind: &str, chart: &str) -> Result<String> {
    if !matches!(kind, "values" | "chart" | "readme") {
        return Err(Error::Invalid(format!(
            "unsupported helm show kind: {kind}"
        )));
    }
    run(&["show", kind, chart], None, LIST_TIMEOUT).await
}

/// Repo management (local helm config; still management-gated in the UI).
pub async fn repo_modify(op: &str, name: Option<&str>, url: Option<&str>) -> Result<String> {
    match op {
        "add" => {
            let (n, u) = (
                name.ok_or_else(|| Error::Invalid("repo name required".into()))?,
                url.ok_or_else(|| Error::Invalid("repo url required".into()))?,
            );
            run(&["repo", "add", n, u], None, ACTION_TIMEOUT).await
        }
        "remove" => {
            let n = name.ok_or_else(|| Error::Invalid("repo name required".into()))?;
            run(&["repo", "remove", n], None, ACTION_TIMEOUT).await
        }
        "update" => run(&["repo", "update"], None, ACTION_TIMEOUT).await,
        _ => Err(Error::Invalid(format!("unsupported repo operation: {op}"))),
    }
}

/// Cluster-mutating Helm operations. Reached only through the frontend's
/// management-mode confirmation flow; `values` (if any) is passed via stdin.
pub async fn action(
    context: &str,
    op: &str,
    namespace: &str,
    release: &str,
    chart: Option<&str>,
    revision: Option<i64>,
    values: Option<&str>,
) -> Result<String> {
    let rev_string;
    let mut args: Vec<&str> = match op {
        "install" => {
            let c = chart.ok_or_else(|| Error::Invalid("chart required for install".into()))?;
            vec!["install", release, c]
        }
        "upgrade" => {
            let c = chart.ok_or_else(|| Error::Invalid("chart required for upgrade".into()))?;
            vec!["upgrade", release, c]
        }
        "rollback" => {
            let r =
                revision.ok_or_else(|| Error::Invalid("revision required for rollback".into()))?;
            rev_string = r.to_string();
            vec!["rollback", release, &rev_string]
        }
        "uninstall" => vec!["uninstall", release],
        _ => return Err(Error::Invalid(format!("unsupported helm operation: {op}"))),
    };
    args.extend(["--kube-context", context, "-n", namespace]);
    let has_values = values.is_some() && matches!(op, "install" | "upgrade");
    if has_values {
        args.extend(["-f", "-"]);
    }
    run(
        &args,
        if has_values { values } else { None },
        ACTION_TIMEOUT,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_json_parses() {
        let json = r#"[{"name":"shop","namespace":"demo","revision":"4","updated":"2026-07-01 10:00:00.0 +0000 UTC","status":"deployed","chart":"shop-1.4.2","app_version":"2.1.0"}]"#;
        let raw: Vec<RawRelease> = serde_json::from_str(json).unwrap();
        assert_eq!(raw[0].revision, "4");
        assert_eq!(raw[0].chart, "shop-1.4.2");
    }

    #[test]
    fn history_json_parses() {
        let json = r#"[{"revision":3,"updated":"2026-06-01T10:00:00Z","status":"superseded","chart":"shop-1.4.1","app_version":"2.0.0","description":"Upgrade complete"}]"#;
        let raw: Vec<RawRevision> = serde_json::from_str(json).unwrap();
        assert_eq!(raw[0].revision, 3);
    }

    #[test]
    fn manifest_secret_values_are_masked() {
        let manifest = "---\napiVersion: v1\nkind: Secret\nmetadata:\n  name: db\ndata:\n  password: aHVudGVyMg==\n---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cfg\ndata:\n  mode: fast\n";
        let masked = mask_secret_documents(manifest);
        assert!(
            !masked.contains("aHVudGVyMg=="),
            "secret value must be hidden"
        );
        assert!(masked.contains("password"), "key names stay visible");
        assert!(
            masked.contains("mode: fast"),
            "non-secret documents untouched"
        );
    }

    #[test]
    fn unparseable_manifest_fails_closed() {
        let manifest = "not: [valid: yaml\ndata:\n  password: aHVudGVyMg==";
        let masked = mask_secret_documents(manifest);
        assert!(
            !masked.contains("aHVudGVyMg=="),
            "an unparseable manifest must never be shown unmasked"
        );
        assert!(masked.contains("could not be parsed"));
    }
}
