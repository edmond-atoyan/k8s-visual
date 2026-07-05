import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  AccessCheck,
  AccessResult,
  Action,
  ActionResult,
  ApplyResult,
  ClusterInfo,
  ClusterOverview,
  ClusterProvider,
  ContextInfo,
  EventInfo,
  ExecRequest,
  ExecResult,
  LogQuery,
  MetricsSnapshot,
  NamespaceSnapshot,
  NodeDetail,
  PortForwardInfo,
  PortForwardRequest,
  ResourceRef,
  RolloutRevision,
  SecretKey,
} from "../types";

/** True when running inside the Tauri shell (vs. plain browser dev mode). */
export function inTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

/** Live cluster access through the Rust backend. */
export class TauriProvider implements ClusterProvider {
  readonly mode = "live" as const;

  listContexts(): Promise<ContextInfo[]> {
    return invoke("list_contexts");
  }

  connect(context?: string): Promise<ClusterInfo> {
    return invoke("connect", { context: context ?? null });
  }

  disconnect(): Promise<void> {
    return invoke("disconnect");
  }

  getOverview(): Promise<ClusterOverview> {
    return invoke("get_overview");
  }

  getSnapshot(namespace: string): Promise<NamespaceSnapshot> {
    return invoke("get_snapshot", { namespace });
  }

  getNodes(): Promise<NodeDetail[]> {
    return invoke("get_nodes");
  }

  getEvents(namespace: string): Promise<EventInfo[]> {
    return invoke("get_events", { namespace });
  }

  getMetrics(namespace: string): Promise<MetricsSnapshot> {
    return invoke("get_metrics", { namespace });
  }

  getYaml(ref: ResourceRef): Promise<string> {
    return invoke("get_yaml", { kind: ref.kind, namespace: ref.namespace, name: ref.name });
  }

  getLogs(query: LogQuery): Promise<string> {
    return invoke("get_logs", { query });
  }

  async streamLogs(query: LogQuery, onLine: (line: string) => void): Promise<() => void> {
    const channel = new Channel<string>();
    channel.onmessage = onLine;
    const id = await invoke<number>("start_log_stream", { query, onLine: channel });
    return () => void invoke("stop_log_stream", { id });
  }

  getConfigMapData(namespace: string, name: string): Promise<Record<string, string>> {
    return invoke("get_config_map_data", { namespace, name });
  }

  revealSecret(namespace: string, name: string): Promise<SecretKey[]> {
    return invoke("reveal_secret", { namespace, name });
  }

  getRolloutHistory(namespace: string, name: string): Promise<RolloutRevision[]> {
    return invoke("get_rollout_history", { namespace, name });
  }

  checkAccess(checks: AccessCheck[]): Promise<AccessResult[]> {
    return invoke("check_access", { checks });
  }

  performAction(action: Action): Promise<ActionResult> {
    return invoke("perform_action", { action });
  }

  applyYaml(yaml: string, dryRun: boolean, defaultNamespace = "default"): Promise<ApplyResult> {
    return invoke("apply_yaml", { yaml, defaultNamespace, dryRun });
  }

  execCommand(req: ExecRequest): Promise<ExecResult> {
    return invoke("exec_command", { request: req });
  }

  listPortForwards(): Promise<PortForwardInfo[]> {
    return invoke("list_port_forwards");
  }

  startPortForward(req: PortForwardRequest): Promise<PortForwardInfo> {
    return invoke("start_port_forward", { request: req });
  }

  stopPortForward(id: string): Promise<void> {
    return invoke("stop_port_forward", { id });
  }
}
