import { invoke } from "@tauri-apps/api/core";
import type {
  ClusterInfo,
  ClusterOverview,
  ClusterProvider,
  ContextInfo,
  NamespaceSnapshot,
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
}
