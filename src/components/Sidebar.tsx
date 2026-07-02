import type { ClusterOverview } from "../types";

export type View = { type: "overview" } | { type: "namespace"; name: string };

interface Props {
  overview: ClusterOverview | null;
  view: View;
  mode: "live" | "demo";
  onNavigate(view: View): void;
  onSwitchCluster(): void;
}

export function Sidebar({ overview, view, mode, onNavigate, onSwitchCluster }: Props) {
  return (
    <nav className="sidebar">
      <div className="side-section">
        <button
          className={`side-item${view.type === "overview" ? " active" : ""}`}
          onClick={() => onNavigate({ type: "overview" })}
        >
          Overview
        </button>
      </div>

      <div className="side-section" style={{ flex: "0 1 auto", overflowY: "auto" }}>
        <div className="side-heading">Namespaces</div>
        {(overview?.namespaces ?? []).map((ns) => (
          <button
            key={ns.name}
            className={`side-item${view.type === "namespace" && view.name === ns.name ? " active" : ""}`}
            onClick={() => onNavigate({ type: "namespace", name: ns.name })}
            title={ns.name}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {ns.name}
            </span>
            <span className="count">{ns.podCount}</span>
          </button>
        ))}
      </div>

      <div className="side-footer">
        <span>{mode === "demo" ? "Demo cluster" : "Live cluster"}</span>
        <button className="link-btn" onClick={onSwitchCluster}>
          switch
        </button>
      </div>
    </nav>
  );
}
