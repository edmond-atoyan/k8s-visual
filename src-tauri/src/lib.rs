//! Tauri shell for K8s Visual: thin IPC commands over `k8s-visual-core`.
//!
//! Every command validates that a cluster is connected and maps errors to
//! user-readable strings. Mutating commands exist only behind the frontend's
//! management-mode confirmation flow; the backend performs exactly what the
//! confirmed action describes and nothing else.

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use futures::StreamExt;
use k8s_visual_core::model::{
    AccessCheck, AccessResult, Action, ActionResult, ApplyResult, CloudCliStatus, CloudCluster,
    CloudImportOutcome, CloudKind, CloudScope, ClusterInfo, ClusterOverview, ContextInfo,
    EventInfo, ExecRequest, ExecResult, HelmChartHit, HelmRelease, HelmReleaseDetail, HelmRepo,
    HelmStatus, LogQuery, MetricsSnapshot, NamespaceSnapshot, NodeDetail, PortForwardInfo,
    PortForwardRequest, RolloutRevision, SecretKey,
};
use k8s_visual_core::portforward::PortForwardManager;
use k8s_visual_core::Bridge;
use tauri::async_runtime::Mutex;
use tauri::ipc::Channel;
use tauri::State;

mod terminal;
use terminal::{AiToolStatus, TerminalManager};

/// The active cluster connection, if any, plus the backend's own copy of the
/// management-mode switch. Read-only is enforced here, not only in React:
/// every mutating command refuses to run while management mode is off.
struct AppState {
    bridge: Mutex<Option<Bridge>>,
    management: AtomicBool,
}

/// Running log-follow tasks, so the UI can stop them.
struct LogStreams(
    Mutex<HashMap<u64, tauri::async_runtime::JoinHandle<()>>>,
    AtomicU64,
);

struct Forwards(PortForwardManager);

/// Run a Bridge method, mapping errors to user-readable strings. The bridge
/// is cloned out of the lock (cheap - the client is reference-counted) so no
/// slow request can block connect/disconnect or other reads.
macro_rules! with_bridge {
    ($state:expr, $bridge:ident => $body:expr) => {{
        let $bridge = {
            let guard = $state.bridge.lock().await;
            guard.as_ref().ok_or("Not connected to a cluster")?.clone()
        };
        let $bridge = &$bridge;
        $body.map_err(|e| e.to_string())
    }};
}

/// Backend read-only guard for cluster-mutating commands.
fn require_management(state: &State<'_, AppState>) -> Result<(), String> {
    if state.management.load(Ordering::SeqCst) {
        Ok(())
    } else {
        Err("The app is in read-only mode - enable management mode in the title bar first.".into())
    }
}

#[tauri::command]
fn list_contexts() -> Result<Vec<ContextInfo>, String> {
    k8s_visual_core::list_contexts().map_err(|e| e.to_string())
}

// --- cloud connect: credential discovery/import only (see core::cloud) -------

#[tauri::command]
async fn cloud_cli_status(kind: CloudKind) -> Result<CloudCliStatus, String> {
    Ok(k8s_visual_core::cloud::cli_status(kind).await)
}

#[tauri::command]
async fn cloud_scopes(kind: CloudKind) -> Result<Vec<CloudScope>, String> {
    k8s_visual_core::cloud::scopes(kind)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn cloud_regions(kind: CloudKind, scope: String) -> Result<Vec<CloudScope>, String> {
    k8s_visual_core::cloud::regions(kind, &scope)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn cloud_clusters(
    kind: CloudKind,
    scope: String,
    region: Option<String>,
) -> Result<Vec<CloudCluster>, String> {
    k8s_visual_core::cloud::clusters(kind, &scope, region.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn cloud_import(
    kind: CloudKind,
    scope: String,
    cluster: CloudCluster,
) -> Result<CloudImportOutcome, String> {
    k8s_visual_core::cloud::import(kind, &scope, &cluster)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn connect(
    state: State<'_, AppState>,
    terminals: State<'_, TerminalManager>,
    context: Option<String>,
) -> Result<ClusterInfo, String> {
    let bridge = Bridge::connect(context).await.map_err(|e| e.to_string())?;
    let info = bridge.info.clone();
    // Every session starts read-only, in the backend too - and no terminal
    // pinned to a previous cluster may survive into the new session.
    state.management.store(false, Ordering::SeqCst);
    terminals.close_all();
    *state.bridge.lock().await = Some(bridge);
    Ok(info)
}

#[tauri::command]
async fn disconnect(
    state: State<'_, AppState>,
    forwards: State<'_, Forwards>,
    streams: State<'_, LogStreams>,
    terminals: State<'_, TerminalManager>,
) -> Result<(), String> {
    forwards.0.stop_all().await;
    // Log-follow streams and terminals belong to the old cluster - neither
    // may survive it.
    for (_, handle) in streams.0.lock().await.drain() {
        handle.abort();
    }
    terminals.close_all();
    state.management.store(false, Ordering::SeqCst);
    *state.bridge.lock().await = None;
    Ok(())
}

/// Mirror of the frontend's management-mode toggle. Mutating commands check
/// this flag in the backend so read-only mode does not depend on React state
/// alone.
#[tauri::command]
fn set_management(state: State<'_, AppState>, on: bool) -> Result<(), String> {
    state.management.store(on, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
async fn get_overview(state: State<'_, AppState>) -> Result<ClusterOverview, String> {
    with_bridge!(state, b => b.overview().await)
}

#[tauri::command]
async fn get_snapshot(
    state: State<'_, AppState>,
    namespace: String,
) -> Result<NamespaceSnapshot, String> {
    with_bridge!(state, b => b.snapshot(&namespace).await)
}

#[tauri::command]
async fn get_nodes(state: State<'_, AppState>) -> Result<Vec<NodeDetail>, String> {
    with_bridge!(state, b => b.nodes().await)
}

#[tauri::command]
async fn get_events(
    state: State<'_, AppState>,
    namespace: String,
) -> Result<Vec<EventInfo>, String> {
    with_bridge!(state, b => b.events(&namespace).await)
}

#[tauri::command]
async fn detect_prometheus(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let bridge = {
        let guard = state.bridge.lock().await;
        guard.as_ref().ok_or("Not connected to a cluster")?.clone()
    };
    Ok(bridge.detect_prometheus().await)
}

#[tauri::command]
async fn get_metrics(
    state: State<'_, AppState>,
    namespace: String,
) -> Result<MetricsSnapshot, String> {
    with_bridge!(state, b => b.metrics(&namespace).await)
}

#[tauri::command]
async fn get_yaml(
    state: State<'_, AppState>,
    kind: String,
    namespace: String,
    name: String,
) -> Result<String, String> {
    with_bridge!(state, b => b.yaml(&kind, &namespace, &name).await)
}

#[tauri::command]
async fn get_logs(state: State<'_, AppState>, query: LogQuery) -> Result<String, String> {
    with_bridge!(state, b => b.logs(&query).await)
}

#[tauri::command]
async fn start_log_stream(
    state: State<'_, AppState>,
    streams: State<'_, LogStreams>,
    query: LogQuery,
    on_line: Channel<String>,
) -> Result<u64, String> {
    let client = {
        let guard = state.bridge.lock().await;
        guard.as_ref().ok_or("Not connected to a cluster")?.client()
    };
    let stream = k8s_visual_core::logs::stream(&client, &query)
        .await
        .map_err(|e| e.to_string())?;
    let id = streams.1.fetch_add(1, Ordering::Relaxed) + 1;
    let handle = tauri::async_runtime::spawn(async move {
        let mut stream = stream;
        while let Some(line) = stream.next().await {
            if on_line.send(line).is_err() {
                break;
            }
        }
    });
    streams.0.lock().await.insert(id, handle);
    Ok(id)
}

#[tauri::command]
async fn stop_log_stream(streams: State<'_, LogStreams>, id: u64) -> Result<(), String> {
    if let Some(handle) = streams.0.lock().await.remove(&id) {
        handle.abort();
    }
    Ok(())
}

#[tauri::command]
async fn get_config_map_data(
    state: State<'_, AppState>,
    namespace: String,
    name: String,
) -> Result<BTreeMap<String, String>, String> {
    with_bridge!(state, b => b.config_map_data(&namespace, &name).await)
}

#[tauri::command]
async fn reveal_secret(
    state: State<'_, AppState>,
    namespace: String,
    name: String,
) -> Result<Vec<SecretKey>, String> {
    // Reached only through the explicit reveal confirmation in the UI.
    with_bridge!(state, b => b.reveal_secret(&namespace, &name).await)
}

#[tauri::command]
async fn get_rollout_history(
    state: State<'_, AppState>,
    namespace: String,
    name: String,
) -> Result<Vec<RolloutRevision>, String> {
    with_bridge!(state, b => b.rollout_history(&namespace, &name).await)
}

#[tauri::command]
async fn check_access(
    state: State<'_, AppState>,
    checks: Vec<AccessCheck>,
) -> Result<Vec<AccessResult>, String> {
    with_bridge!(state, b => b.check_access(checks).await)
}

#[tauri::command]
async fn perform_action(
    state: State<'_, AppState>,
    action: Action,
) -> Result<ActionResult, String> {
    require_management(&state)?;
    with_bridge!(state, b => b.perform_action(action).await)
}

#[tauri::command]
async fn apply_yaml(
    state: State<'_, AppState>,
    yaml: String,
    default_namespace: String,
    dry_run: bool,
) -> Result<ApplyResult, String> {
    if !dry_run {
        require_management(&state)?;
    }
    with_bridge!(state, b => b.apply_yaml(&yaml, &default_namespace, dry_run).await)
}

#[tauri::command]
async fn exec_command(
    state: State<'_, AppState>,
    request: ExecRequest,
) -> Result<ExecResult, String> {
    require_management(&state)?;
    with_bridge!(state, b => b.exec(&request).await)
}

#[tauri::command]
async fn list_port_forwards(forwards: State<'_, Forwards>) -> Result<Vec<PortForwardInfo>, String> {
    Ok(forwards.0.list().await)
}

#[tauri::command]
async fn start_port_forward(
    state: State<'_, AppState>,
    forwards: State<'_, Forwards>,
    request: PortForwardRequest,
) -> Result<PortForwardInfo, String> {
    let client = {
        let guard = state.bridge.lock().await;
        guard.as_ref().ok_or("Not connected to a cluster")?.client()
    };
    forwards
        .0
        .start(&client, &request)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn stop_port_forward(forwards: State<'_, Forwards>, id: String) -> Result<(), String> {
    forwards.0.stop(&id).await.map_err(|e| e.to_string())
}

// --- integrated terminal (see terminal.rs; separate from Kubernetes logic) ----

#[tauri::command]
async fn term_open(
    state: State<'_, AppState>,
    terminals: State<'_, TerminalManager>,
    cols: u16,
    rows: u16,
    namespace: Option<String>,
    env: Vec<(String, String)>,
    on_data: Channel<String>,
) -> Result<u64, String> {
    // Pin the shell to the cluster (and namespace) the app is connected to:
    // kubectl and helm ignore the K8S_VISUAL_* variables, so without a pinned
    // KUBECONFIG they would silently use the kubeconfig current-context -
    // possibly a different cluster than the one shown in the terminal header.
    // With no connection (demo mode), the shell gets an EMPTY kubeconfig: a
    // "demo" terminal must not be able to silently target a real cluster.
    let context = {
        let guard = state.bridge.lock().await;
        guard.as_ref().map(|b| b.info.context.clone())
    };
    let kubeconfig = match &context {
        Some(ctx) => k8s_visual_core::write_pinned_kubeconfig(ctx, namespace.as_deref())
            .map_err(|e| format!("could not pin the terminal to context \"{ctx}\": {e}"))?,
        None => k8s_visual_core::write_empty_kubeconfig()
            .map_err(|e| format!("could not prepare the terminal kubeconfig: {e}"))?,
    };
    terminals.open(cols, rows, env, kubeconfig, on_data)
}

#[tauri::command]
fn term_write(terminals: State<'_, TerminalManager>, id: u64, data: String) -> Result<(), String> {
    terminals.write(id, &data)
}

#[tauri::command]
fn term_resize(
    terminals: State<'_, TerminalManager>,
    id: u64,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    terminals.resize(id, cols, rows)
}

#[tauri::command]
fn term_close(terminals: State<'_, TerminalManager>, id: u64) -> Result<(), String> {
    terminals.close(id);
    Ok(())
}

#[tauri::command]
async fn detect_ai_tools() -> Result<Vec<AiToolStatus>, String> {
    Ok(terminal::detect_ai_tools().await)
}

// --- Helm (see core::helm; every command pins --kube-context) -----------------

/// The context the app is connected to - helm commands never rely on the
/// kubeconfig current-context.
async fn app_context(state: &State<'_, AppState>) -> Result<String, String> {
    let guard = state.bridge.lock().await;
    Ok(guard
        .as_ref()
        .ok_or("Not connected to a cluster")?
        .info
        .context
        .clone())
}

#[tauri::command]
async fn helm_status() -> Result<HelmStatus, String> {
    Ok(k8s_visual_core::helm::status().await)
}

#[tauri::command]
async fn helm_releases(
    state: State<'_, AppState>,
    namespace: Option<String>,
) -> Result<Vec<HelmRelease>, String> {
    let ctx = app_context(&state).await?;
    k8s_visual_core::helm::releases(&ctx, namespace.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn helm_release_detail(
    state: State<'_, AppState>,
    namespace: String,
    name: String,
) -> Result<HelmReleaseDetail, String> {
    let ctx = app_context(&state).await?;
    k8s_visual_core::helm::release_detail(&ctx, &namespace, &name)
        .await
        .map_err(|e| e.to_string())
}

/// Separate from `helm_release_detail` on purpose: release values commonly
/// contain credentials, so they are fetched only on an explicit user action.
#[tauri::command]
async fn helm_release_values(
    state: State<'_, AppState>,
    namespace: String,
    name: String,
) -> Result<String, String> {
    let ctx = app_context(&state).await?;
    k8s_visual_core::helm::release_values(&ctx, &namespace, &name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn helm_repos() -> Result<Vec<HelmRepo>, String> {
    k8s_visual_core::helm::repos()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn helm_search(query: String) -> Result<Vec<HelmChartHit>, String> {
    k8s_visual_core::helm::search(&query)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn helm_show(kind: String, chart: String) -> Result<String, String> {
    k8s_visual_core::helm::show(&kind, &chart)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn helm_repo_modify(
    state: State<'_, AppState>,
    op: String,
    name: Option<String>,
    url: Option<String>,
) -> Result<String, String> {
    require_management(&state)?;
    k8s_visual_core::helm::repo_modify(&op, name.as_deref(), url.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn helm_action(
    state: State<'_, AppState>,
    op: String,
    namespace: String,
    release: String,
    chart: Option<String>,
    revision: Option<i64>,
    values: Option<String>,
) -> Result<String, String> {
    require_management(&state)?;
    let ctx = app_context(&state).await?;
    k8s_visual_core::helm::action(
        &ctx,
        &op,
        &namespace,
        &release,
        chart.as_deref(),
        revision,
        values.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            bridge: Mutex::new(None),
            management: AtomicBool::new(false),
        })
        .manage(LogStreams(Mutex::new(HashMap::new()), AtomicU64::new(0)))
        .manage(Forwards(PortForwardManager::new()))
        .manage(TerminalManager::new())
        .invoke_handler(tauri::generate_handler![
            list_contexts,
            cloud_cli_status,
            cloud_scopes,
            cloud_regions,
            cloud_clusters,
            cloud_import,
            connect,
            disconnect,
            set_management,
            get_overview,
            get_snapshot,
            get_nodes,
            get_events,
            get_metrics,
            detect_prometheus,
            get_yaml,
            get_logs,
            start_log_stream,
            stop_log_stream,
            get_config_map_data,
            reveal_secret,
            get_rollout_history,
            check_access,
            perform_action,
            apply_yaml,
            exec_command,
            list_port_forwards,
            start_port_forward,
            stop_port_forward,
            term_open,
            term_write,
            term_resize,
            term_close,
            detect_ai_tools,
            helm_status,
            helm_releases,
            helm_release_detail,
            helm_release_values,
            helm_repos,
            helm_search,
            helm_show,
            helm_repo_modify,
            helm_action,
        ])
        .run(tauri::generate_context!())
        .expect("error while running K8s Visual");
}
