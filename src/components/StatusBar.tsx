import type { ClusterInfo, ClusterOverview } from "../types";
import { cloudTag } from "../utils";
import { Icon } from "./icons";

interface Props {
  mode: "live" | "demo";
  management: boolean;
  connected: boolean;
  cluster: ClusterInfo;
  namespace: string;
  resourceCount: number | null;
  overview: ClusterOverview | null;
  onToggleManagement(): void;
}

/**
 * IDE-style status strip: persistent, glanceable operating state. The mode
 * segment is the loudest thing here on purpose - whether the app can change
 * the cluster should never be ambiguous.
 */
export function StatusBar({
  mode,
  management,
  connected,
  cluster,
  namespace,
  resourceCount,
  overview,
  onToggleManagement,
}: Props) {
  return (
    <footer className="statusbar">
      <button
        className={`sb-seg ${management ? "sb-mgmt" : "sb-ro"}`}
        onClick={onToggleManagement}
        title={
          management
            ? "Management mode: cluster-changing actions are enabled (each still asks for confirmation). Click for read-only."
            : "Read-only mode: the app cannot change the cluster. Click to enable management actions."
        }
      >
        <Icon name={management ? "unlock" : "lock"} size={11} />
        {management ? "Management" : "Read-only"}
      </button>

      {mode === "demo" && (
        <span className="sb-seg sb-demo" title="Sample data built into the app - nothing here touches a real cluster">
          Demo data
        </span>
      )}

      <span className="sb-item" title={cluster.server}>
        <span className={`dot health-${connected ? "good" : "critical"}`} />
        {(() => {
          const tag = cloudTag(cluster.context, cluster.server);
          return tag ? (
            <span className="cloud-tag" title={`${tag.label}${tag.detail ? ` · ${tag.detail}` : ""}`}>
              {tag.provider}
            </span>
          ) : null;
        })()}
        {cluster.context}
      </span>

      <span className="sb-spacer" />

      <span className="sb-item" title="Selected namespace">
        ns: {namespace}
      </span>
      {resourceCount !== null && (
        <span className="sb-item">
          {resourceCount} resource{resourceCount === 1 ? "" : "s"}
        </span>
      )}
      {overview && overview.failingPods > 0 && (
        <span className="sb-item sb-alert" title="Pods not running or not ready, cluster-wide">
          <span className="dot health-critical" />
          {overview.failingPods} failing
        </span>
      )}
      {overview && overview.warningEvents > 0 && (
        <span className="sb-item sb-warn" title="Warning events, cluster-wide">
          <span className="dot health-warning" />
          {overview.warningEvents} warnings
        </span>
      )}
      <span className="sb-item" title="Kubernetes version">
        {cluster.version}
      </span>
    </footer>
  );
}
