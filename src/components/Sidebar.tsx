import type { ClusterInfo } from "../types";
import { cloudTag } from "../utils";
import { Icon, type IconName } from "./icons";

export type ViewId =
  | "overview"
  | "graph"
  | "explorer"
  | "networking"
  | "storage"
  | "config"
  | "nodes"
  | "events"
  | "logs"
  | "metrics"
  | "access"
  | "apply";

const SECTIONS: { heading: string; items: { id: ViewId; label: string; icon: IconName }[] }[] = [
  {
    heading: "Understand",
    items: [
      { id: "overview", label: "Cluster overview", icon: "dashboard" },
      { id: "graph", label: "Topology graph", icon: "graph" },
      { id: "explorer", label: "Resource explorer", icon: "list" },
    ],
  },
  {
    heading: "Observe",
    items: [
      { id: "events", label: "Events", icon: "bell" },
      { id: "logs", label: "Logs", icon: "terminal" },
      { id: "metrics", label: "Metrics", icon: "pulse" },
    ],
  },
  {
    heading: "Inspect",
    items: [
      { id: "networking", label: "Networking", icon: "globe" },
      { id: "storage", label: "Storage", icon: "database" },
      { id: "config", label: "Config & Secrets", icon: "sliders" },
      { id: "nodes", label: "Nodes", icon: "server" },
      { id: "access", label: "Access (RBAC)", icon: "shield" },
    ],
  },
  {
    heading: "Manage",
    items: [{ id: "apply", label: "Apply YAML", icon: "upload" }],
  },
];

interface Props {
  view: ViewId;
  cluster: ClusterInfo | null;
  management: boolean;
  onNavigate(view: ViewId): void;
  onSwitchCluster(): void;
}

export function Sidebar({ view, cluster, management, onNavigate, onSwitchCluster }: Props) {
  return (
    <nav className="sidebar">
      {SECTIONS.map((section) => (
        <div className="side-section" key={section.heading}>
          <div className="side-heading">{section.heading}</div>
          {section.items.map((item) => {
            const gated = item.id === "apply" && !management;
            return (
              <button
                key={item.id}
                className={`side-item${view === item.id ? " active" : ""}${gated ? " gated" : ""}`}
                onClick={() => onNavigate(item.id)}
                title={
                  gated
                    ? "Read-only mode - the view opens, but applying needs management mode (title bar)"
                    : undefined
                }
              >
                <Icon name={item.icon} />
                {item.label}
                {gated && (
                  <span className="side-gate" aria-label="Requires management mode">
                    <Icon name="lock" size={11} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ))}

      <div style={{ flex: 1 }} />
      <div className="side-footer">
        {cluster &&
          (() => {
            const tag = cloudTag(cluster.context, cluster.server);
            return (
              <div className="side-cluster" title={cluster.server}>
                {tag && <span className="cloud-tag">{tag.provider}</span>}
                <span className="side-cluster-name">{cluster.context}</span>
                <span className="side-cluster-version">{cluster.version}</span>
              </div>
            );
          })()}
        <button className="side-item" onClick={onSwitchCluster}>
          <Icon name="switch" />
          Switch cluster
        </button>
      </div>
    </nav>
  );
}
