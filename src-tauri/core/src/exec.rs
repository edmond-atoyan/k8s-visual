//! One-shot command execution in a container (`kubectl exec pod -- cmd`).
//! Non-interactive by design: runs a single command, captures output, done.
//! Output is returned to the UI only - never recorded or sent anywhere.

use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, AttachParams};
use kube::Client;
use tokio::io::AsyncReadExt;

use crate::model::{ExecRequest, ExecResult};
use crate::{Error, Result};

const EXEC_TIMEOUT_SECS: u64 = 30;
const MAX_OUTPUT_BYTES: usize = 512 * 1024;

pub async fn run(client: &Client, req: &ExecRequest) -> Result<ExecResult> {
    if req.command.is_empty() {
        return Err(Error::Invalid("no command given".into()));
    }
    let api = Api::<Pod>::namespaced(client.clone(), &req.namespace);
    let mut params = AttachParams::default()
        .stdin(false)
        .stdout(true)
        .stderr(true);
    if let Some(container) = &req.container {
        params = params.container(container.clone());
    }
    let mut attached = api.exec(&req.pod, req.command.clone(), &params).await?;
    let mut stdout_reader = attached.stdout();
    let mut stderr_reader = attached.stderr();

    let work = async move {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        if let Some(r) = stdout_reader.as_mut() {
            let _ = r
                .take(MAX_OUTPUT_BYTES as u64)
                .read_to_end(&mut stdout)
                .await;
        }
        if let Some(r) = stderr_reader.as_mut() {
            let _ = r
                .take(MAX_OUTPUT_BYTES as u64)
                .read_to_end(&mut stderr)
                .await;
        }
        let _ = attached.join().await;
        (stdout, stderr)
    };

    let (stdout, stderr) =
        tokio::time::timeout(std::time::Duration::from_secs(EXEC_TIMEOUT_SECS), work)
            .await
            .map_err(|_| {
                Error::Invalid(format!(
                    "command did not finish within {EXEC_TIMEOUT_SECS}s (interactive commands are not supported)"
                ))
            })?;

    Ok(ExecResult {
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
    })
}
