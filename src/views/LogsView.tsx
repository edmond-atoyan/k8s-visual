import { useMemo, useState } from "react";
import { EmptyMsg } from "../components/bits";
import { LogViewer, type LogSource } from "../components/LogViewer";
import type { ClusterProvider, NamespaceSnapshot, ResourceSummary } from "../types";

interface Props {
  provider: ClusterProvider;
  snapshot: NamespaceSnapshot;
}

const WORKLOAD_KINDS = ["Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob"] as const;

/** Workload/pod picker + the shared log viewer. */
export function LogsView({ provider, snapshot }: Props) {
  const workloads = snapshot.resources.filter((r) =>
    (WORKLOAD_KINDS as readonly string[]).includes(r.kind),
  );
  const pods = snapshot.resources.filter((r) => r.kind === "Pod");
  const [selection, setSelection] = useState("");

  // Default to the first workload (or first pod).
  const effective = selection || (workloads[0] ? `w:${workloads[0].uid}` : pods[0] ? `p:${pods[0].uid}` : "");

  const sources: LogSource[] = useMemo(() => {
    const byUid = new Map(snapshot.resources.map((r) => [r.uid, r]));
    const toSource = (p: ResourceSummary): LogSource => ({
      pod: p.name,
      containers: (p.containers ?? []).map((c) => c.name),
    });
    if (effective.startsWith("p:")) {
      const p = byUid.get(effective.slice(2));
      return p ? [toSource(p)] : [];
    }
    if (effective.startsWith("w:")) {
      const root = byUid.get(effective.slice(2));
      if (!root) return [];
      const isDescendant = (r: ResourceSummary): boolean =>
        r.owners.some((o) => o.uid === root.uid || (byUid.get(o.uid) ? isDescendant(byUid.get(o.uid)!) : false));
      return pods.filter((p) => isDescendant(p) && p.status !== "Pending").map(toSource);
    }
    return [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effective, snapshot]);

  if (pods.length === 0) {
    return (
      <div className="overview wide">
        <h2>Logs</h2>
        <EmptyMsg>
          <p>No pods in {snapshot.namespace} - nothing to read logs from.</p>
        </EmptyMsg>
      </div>
    );
  }

  return (
    <div className="overview wide logs-view">
      <h2>
        Logs <span className="h2-sub">- kubectl logs, visually · {snapshot.namespace}</span>
      </h2>

      <div className="graph-toolbar wrap">
        <select value={effective} onChange={(e) => setSelection(e.target.value)}>
          <optgroup label="Workloads (aggregated)">
            {workloads.map((w) => (
              <option key={w.uid} value={`w:${w.uid}`}>
                {w.kind}/{w.name}
              </option>
            ))}
          </optgroup>
          <optgroup label="Pods">
            {pods.map((p) => (
              <option key={p.uid} value={`p:${p.uid}`}>
                {p.name}
              </option>
            ))}
          </optgroup>
        </select>
      </div>

      <LogViewer
        key={effective}
        provider={provider}
        namespace={snapshot.namespace}
        sources={sources}
        aggregate={effective.startsWith("w:")}
      />
    </div>
  );
}
