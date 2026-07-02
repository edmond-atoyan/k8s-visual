//! Tauri shell for K8s Visual: thin IPC commands over `k8s-visual-core`.

use k8s_visual_core::model::{ClusterInfo, ClusterOverview, ContextInfo, NamespaceSnapshot};
use k8s_visual_core::Bridge;
use tauri::async_runtime::Mutex;
use tauri::State;

/// The active cluster connection, if any.
struct AppState(Mutex<Option<Bridge>>);

#[tauri::command]
fn list_contexts() -> Result<Vec<ContextInfo>, String> {
    k8s_visual_core::list_contexts().map_err(|e| e.to_string())
}

#[tauri::command]
async fn connect(
    state: State<'_, AppState>,
    context: Option<String>,
) -> Result<ClusterInfo, String> {
    let bridge = Bridge::connect(context).await.map_err(|e| e.to_string())?;
    let info = bridge.info.clone();
    *state.0.lock().await = Some(bridge);
    Ok(info)
}

#[tauri::command]
async fn disconnect(state: State<'_, AppState>) -> Result<(), String> {
    *state.0.lock().await = None;
    Ok(())
}

#[tauri::command]
async fn get_overview(state: State<'_, AppState>) -> Result<ClusterOverview, String> {
    let guard = state.0.lock().await;
    let bridge = guard.as_ref().ok_or("Not connected to a cluster")?;
    bridge.overview().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_snapshot(
    state: State<'_, AppState>,
    namespace: String,
) -> Result<NamespaceSnapshot, String> {
    let guard = state.0.lock().await;
    let bridge = guard.as_ref().ok_or("Not connected to a cluster")?;
    bridge.snapshot(&namespace).await.map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            list_contexts,
            connect,
            disconnect,
            get_overview,
            get_snapshot,
        ])
        .run(tauri::generate_context!())
        .expect("error while running K8s Visual");
}
