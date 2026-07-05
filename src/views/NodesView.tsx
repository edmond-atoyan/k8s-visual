import { useEffect, useState } from "react";
import type { ActionDescriptor } from "../actions";
import { EmptyMsg, HealthDot, Kv } from "../components/bits";
import type { ClusterProvider, NodeDetail, ResourceSummary } from "../types";
import { formatMemory } from "../utils";

interface Props {
  provider: ClusterProvider;
  namespace: string;
  management: boolean;
  onSelectPod(namespace: string, name: string): void;
  onAction(resource: ResourceSummary, descriptor: ActionDescriptor): void;
  nodeActions(resource: ResourceSummary): ActionDescriptor[];
}

/** Wrap a NodeDetail as a pseudo-resource so it can flow through the action modal. */
export function nodeAsResource(n: NodeDetail): ResourceSummary {
  return {
    uid: `Node::${n.name}`,
    kind: "Node",
    name: n.name,
    namespace: "",
    owners: [],
    labels: n.labels,
    status: n.ready ? (n.unschedulable ? "Ready, SchedulingDisabled" : "Ready") : "NotReady",
    health: n.ready ? (n.unschedulable ? "warning" : "good") : "critical",
    details: { Unschedulable: n.unschedulable ? "true" : "false" },
  };
}

export function NodesView({ provider, namespace, management, onSelectPod, onAction, nodeActions }: Props) {
  const [nodes, setNodes] = useState<NodeDetail[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      provider
        .getNodes()
        .then((n) => !cancelled && setNodes(n))
        .catch((e) => !cancelled && setError(String(e)));
    load();
    const t = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [provider]);

  if (error) return <div className="error-banner">{error}</div>;
  if (!nodes) return <EmptyMsg><p>Loading nodes…</p></EmptyMsg>;

  return (
    <div className="overview wide">
      <h2>
        Nodes <span className="h2-sub">- the machines, and which Pods run where</span>
      </h2>

      {nodes.map((n) => {
        const pseudo = nodeAsResource(n);
        const badConditions = n.conditions.filter(
          (c) => (c.type === "Ready" && c.status !== "True") || (c.type !== "Ready" && c.status === "True"),
        );
        return (
          <section key={n.name} className="node-detail">
            <div className="node-detail-head">
              <h3>
                {n.name}
                {n.roles.map((role) => (
                  <span key={role} className="role-tag">
                    {role}
                  </span>
                ))}
              </h3>
              <HealthDot health={pseudo.health} label={pseudo.status} />
              <div style={{ flex: 1 }} />
              {nodeActions(pseudo).map((d) => (
                <button
                  key={d.id}
                  className="chip"
                  disabled={!management}
                  title={management ? d.describe(pseudo, {}) : "Enable management mode first"}
                  onClick={() => onAction(pseudo, d)}
                >
                  {d.label}
                </button>
              ))}
            </div>

            <Kv
              entries={[
                ["Internal IP", n.internalIp ?? "-"],
                ["Kubelet", n.version],
                ["Runtime", n.runtime ?? "-"],
                ["OS", n.osImage],
                ["CPU (alloc/cap)", `${n.allocatableCpu ?? "?"} / ${n.cpu}`],
                ["Memory (alloc/cap)", `${n.allocatableMemory ? formatMemory(n.allocatableMemory) : "?"} / ${formatMemory(n.memory)}`],
                ["Taints", n.taints.length > 0 ? n.taints.join("\n") : "none"],
              ]}
            />

            {badConditions.length > 0 && (
              <div className="issue-box">
                {badConditions.map((c) => (
                  <p key={c.type}>
                    ⚠ {c.type}: {c.status} {c.reason ? `(${c.reason})` : ""}
                  </p>
                ))}
              </div>
            )}

            <div className="rel-heading">Pods on this node ({n.pods.length})</div>
            <div className="node-pods">
              {n.pods.map((p) => (
                <button
                  key={`${p.namespace}/${p.name}`}
                  className="rel-link"
                  title={p.namespace === namespace ? "Open details" : `In namespace ${p.namespace} - switch namespace to inspect`}
                  onClick={() => onSelectPod(p.namespace, p.name)}
                >
                  <span className="knode-badge">pod</span>
                  <span className="pf-ns">{p.namespace}/</span>
                  {p.name}
                  <HealthDot health={p.health} label={p.status} />
                </button>
              ))}
              {n.pods.length === 0 && <span className="meta">no pods</span>}
            </div>
          </section>
        );
      })}
    </div>
  );
}
