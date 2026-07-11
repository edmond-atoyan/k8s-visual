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

    // Drain a pipe to the end, keeping at most MAX_OUTPUT_BYTES. Reading must
    // never stop early: a full stdout or stderr pipe would block the remote
    // process (and the other stream) indefinitely.
    async fn drain(
        reader: Option<&mut (impl tokio::io::AsyncRead + Unpin)>,
        keep: &mut Vec<u8>,
    ) -> bool {
        let Some(r) = reader else { return false };
        let mut truncated = false;
        let mut chunk = [0u8; 8192];
        loop {
            match r.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if keep.len() < MAX_OUTPUT_BYTES {
                        let take = n.min(MAX_OUTPUT_BYTES - keep.len());
                        keep.extend_from_slice(&chunk[..take]);
                        truncated |= take < n;
                    } else {
                        truncated = true;
                    }
                }
            }
        }
        truncated
    }

    let work = async move {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        // Both pipes concurrently - draining them sequentially can deadlock
        // when the command fills the not-yet-read one.
        let (out_truncated, err_truncated) = tokio::join!(
            drain(stdout_reader.as_mut(), &mut stdout),
            drain(stderr_reader.as_mut(), &mut stderr),
        );
        let _ = attached.join().await;
        (stdout, out_truncated, stderr, err_truncated)
    };

    let (stdout, out_truncated, stderr, err_truncated) =
        tokio::time::timeout(std::time::Duration::from_secs(EXEC_TIMEOUT_SECS), work)
            .await
            .map_err(|_| {
                Error::Invalid(format!(
                    "command did not finish within {EXEC_TIMEOUT_SECS}s (interactive commands are not supported)"
                ))
            })?;

    let marker = "\n…[output truncated]";
    let mut stdout = String::from_utf8_lossy(&stdout).into_owned();
    if out_truncated {
        stdout.push_str(marker);
    }
    let mut stderr = String::from_utf8_lossy(&stderr).into_owned();
    if err_truncated {
        stderr.push_str(marker);
    }
    Ok(ExecResult { stdout, stderr })
}
