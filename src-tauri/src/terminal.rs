//! Integrated terminal (PTY sessions) and AI CLI detection.
//!
//! Deliberately separate from the Kubernetes core: the shell is the user's
//! own environment - the app only opens a window into it and passes context
//! through environment variables. Nothing here reads kubeconfig contents,
//! tokens, or Secret values, and nothing is sent anywhere.

use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::Channel;

pub struct TerminalManager {
    sessions: Mutex<HashMap<u64, Session>>,
    next_id: AtomicU64,
}

struct Session {
    writer: Box<dyn std::io::Write + Send>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

impl TerminalManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(0),
        }
    }

    /// Spawn the user's shell in a new PTY. `env` carries non-secret context
    /// (K8S_VISUAL_CONTEXT / K8S_VISUAL_NAMESPACE); the child otherwise
    /// inherits the session environment.
    pub fn open(
        &self,
        cols: u16,
        rows: u16,
        env: Vec<(String, String)>,
        on_data: Channel<String>,
    ) -> Result<u64, String> {
        let pty = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("could not open a pty: {e}"))?;

        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
        let mut cmd = CommandBuilder::new(&shell);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        // GUI launchers often start with a minimal PATH - resolve kubectl and
        // the cloud/AI CLIs the same way the cloud-connect flow does.
        cmd.env("PATH", k8s_visual_core::cloud::augmented_path());
        if let Ok(home) = std::env::var("HOME") {
            cmd.cwd(&home);
            // Make the kubeconfig explicit (default path) if not already set,
            // so tools in the shell agree with what the app is connected to.
            if std::env::var_os("KUBECONFIG").is_none() {
                let default = format!("{home}/.kube/config");
                if std::path::Path::new(&default).exists() {
                    cmd.env("KUBECONFIG", default);
                }
            }
        }
        for (k, v) in env {
            cmd.env(k, v);
        }

        let child = pty
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("could not start {shell}: {e}"))?;
        let killer = child.clone_killer();

        let mut reader = pty
            .master
            .try_clone_reader()
            .map_err(|e| format!("could not read from the pty: {e}"))?;
        let writer = pty
            .master
            .take_writer()
            .map_err(|e| format!("could not write to the pty: {e}"))?;

        // Blocking reader thread; forwards output (UTF-8, with carry-over for
        // multi-byte sequences split across chunks) until the shell exits.
        std::thread::spawn(move || {
            let mut carry: Vec<u8> = Vec::new();
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        carry.extend_from_slice(&buf[..n]);
                        let valid_up_to = match std::str::from_utf8(&carry) {
                            Ok(_) => carry.len(),
                            Err(e) => e.valid_up_to(),
                        };
                        if valid_up_to > 0 {
                            let text = String::from_utf8_lossy(&carry[..valid_up_to]).into_owned();
                            carry.drain(..valid_up_to);
                            if on_data.send(text).is_err() {
                                break;
                            }
                        }
                        // Safety valve: never let an invalid prefix grow.
                        if carry.len() > 8 {
                            let text = String::from_utf8_lossy(&carry).into_owned();
                            carry.clear();
                            if on_data.send(text).is_err() {
                                break;
                            }
                        }
                    }
                }
            }
            let _ = on_data.send("\r\n[session ended]\r\n".into());
        });

        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        self.sessions.lock().unwrap().insert(
            id,
            Session {
                writer,
                master: pty.master,
                killer,
            },
        );
        Ok(id)
    }

    pub fn write(&self, id: u64, data: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();
        let s = sessions.get_mut(&id).ok_or("no such terminal session")?;
        s.writer
            .write_all(data.as_bytes())
            .map_err(|e| format!("terminal write failed: {e}"))
    }

    pub fn resize(&self, id: u64, cols: u16, rows: u16) -> Result<(), String> {
        let sessions = self.sessions.lock().unwrap();
        let s = sessions.get(&id).ok_or("no such terminal session")?;
        s.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("terminal resize failed: {e}"))
    }

    pub fn close(&self, id: u64) {
        if let Some(mut s) = self.sessions.lock().unwrap().remove(&id) {
            let _ = s.killer.kill();
        }
    }
}

// --- AI CLI detection -----------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AiToolStatus {
    pub id: String,
    pub name: String,
    pub installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

/// Check whether an AI CLI is on PATH by asking for its version. Detection
/// only - nothing is sent to the tools here.
pub async fn detect_ai_tools() -> Vec<AiToolStatus> {
    let probes = [
        ("codex", "Codex CLI"),
        ("claude", "Claude Code"),
        ("gemini", "Gemini CLI"),
    ];
    let mut out = Vec::new();
    for (bin, name) in probes {
        let status = probe(bin).await;
        out.push(AiToolStatus {
            id: bin.into(),
            name: name.into(),
            installed: status.is_some(),
            version: status,
        });
    }
    out
}

async fn probe(bin: &str) -> Option<String> {
    let fut = tokio::process::Command::new(bin)
        .arg("--version")
        .env("PATH", k8s_visual_core::cloud::augmented_path())
        .kill_on_drop(true)
        .output();
    match tokio::time::timeout(Duration::from_secs(8), fut).await {
        Ok(Ok(out)) if out.status.success() => {
            let v = String::from_utf8_lossy(&out.stdout);
            Some(v.lines().next().unwrap_or("").trim().to_string())
        }
        _ => None,
    }
}
