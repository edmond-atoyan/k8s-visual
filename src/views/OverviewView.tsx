import type { ClusterOverview } from "../types";
import { formatAge, formatMemory } from "../utils";

interface Props {
  overview: ClusterOverview;
  onOpenNamespace(name: string): void;
  onOpenNodes(): void;
  onOpenEvents(): void;
}

/**
 * The top of the hierarchy: the cluster is machines (nodes) running the
 * control plane and your workloads, partitioned into namespaces.
 */
export function OverviewView({ overview, onOpenNamespace, onOpenNodes, onOpenEvents }: Props) {
  const readyNodes = overview.nodes.filter((n) => n.ready).length;

  return (
    <div className="overview wide">
      <h2>Cluster overview</h2>

      <div className="tiles">
        <div className="tile">
          <div className="value">
            {readyNodes}/{overview.nodes.length}
          </div>
          <div className="label">Nodes ready</div>
        </div>
        <div className="tile">
          <div className="value">{overview.namespaces.length}</div>
          <div className="label">Namespaces</div>
        </div>
        <div className="tile">
          <div className="value">{overview.podCount}</div>
          <div className="label">Pods</div>
        </div>
        <div className={`tile${overview.failingPods > 0 ? " bad" : ""}`}>
          <div className="value">{overview.failingPods}</div>
          <div className="label">Failing pods</div>
        </div>
        <button className={`tile clickable${overview.warningEvents > 0 ? " warn" : ""}`} onClick={onOpenEvents}>
          <div className="value">{overview.warningEvents}</div>
          <div className="label">Warning events</div>
        </button>
        <div className="tile">
          <div className={`value${overview.version.length > 8 ? " small" : ""}`}>{overview.version}</div>
          <div className="label">Kubernetes</div>
        </div>
      </div>

      <h3>
        Nodes - the machines your cluster runs on{" "}
        <button className="link-btn" onClick={onOpenNodes}>
          details →
        </button>
      </h3>
      <div className="node-grid">
        {overview.nodes.map((n) => (
          <button key={n.name} className="node-card clickable" onClick={onOpenNodes}>
            <div className="name">
              {n.name}
              {n.roles.map((role) => (
                <span key={role} className="role-tag">
                  {role}
                </span>
              ))}
            </div>
            <div className="status">
              <span className={`dot health-${n.ready ? "good" : "critical"}`} />
              <span>{n.ready ? "Ready" : "NotReady"}</span>
            </div>
            <div className="meta">
              {n.cpu} CPU · {formatMemory(n.memory)} · {n.version}
            </div>
            <div className="meta">{n.osImage}</div>
          </button>
        ))}
      </div>

      <h3>Namespaces - folders that group related resources</h3>
      <table className="ns-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Status</th>
            <th>Pods</th>
            <th>Age</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {overview.namespaces.map((ns) => (
            <tr key={ns.name} onClick={() => onOpenNamespace(ns.name)}>
              <td>{ns.name}</td>
              <td>
                <span className="status">
                  <span className={`dot health-${ns.status === "Active" ? "good" : "warning"}`} />
                  {ns.status}
                </span>
              </td>
              <td>{ns.podCount}</td>
              <td>{formatAge(ns.createdAt)}</td>
              <td className="cell-action">view graph →</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
