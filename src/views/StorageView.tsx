import { EmptyMsg, HealthDot } from "../components/bits";
import type { NamespaceSnapshot, ResourceSummary } from "../types";

interface Props {
  snapshot: NamespaceSnapshot;
  onSelect(uid: string): void;
}

/** The storage chain, made visible: Pod → PVC → PV → StorageClass. */
export function StorageView({ snapshot, onSelect }: Props) {
  const pvcs = snapshot.resources.filter((r) => r.kind === "PersistentVolumeClaim");
  const pvs = snapshot.resources.filter((r) => r.kind === "PersistentVolume");
  const scs = snapshot.resources.filter((r) => r.kind === "StorageClass");
  const pods = snapshot.resources.filter((r) => r.kind === "Pod");

  const link = (r: ResourceSummary, badge: string) => (
    <button key={r.uid} className="rel-link" onClick={() => onSelect(r.uid)}>
      <span className="knode-badge">{badge}</span> {r.name}
      <HealthDot health={r.health} label={r.status} />
    </button>
  );

  if (pvcs.length === 0) {
    return (
      <div className="overview wide">
        <h2>
          Storage <span className="h2-sub">· {snapshot.namespace}</span>
        </h2>
        <EmptyMsg>
          <p>No PersistentVolumeClaims in this namespace.</p>
          <p>Pods that need durable data claim storage through a PVC; the cluster binds it to a PersistentVolume.</p>
        </EmptyMsg>
      </div>
    );
  }

  return (
    <div className="overview wide">
      <h2>
        Storage <span className="h2-sub">- Pod → PVC → PV → StorageClass · {snapshot.namespace}</span>
      </h2>

      {pvcs.map((pvc) => {
        const mounters = pods.filter((p) => (p.refs ?? []).includes(`PersistentVolumeClaim/${pvc.name}`));
        const pvName = (pvc.refs ?? []).find((r) => r.startsWith("PersistentVolume/"))?.split("/")[1];
        const pv = pvs.find((v) => v.name === pvName);
        const scName = pv ? (pv.refs ?? []).find((r) => r.startsWith("StorageClass/"))?.split("/")[1] : pvc.details.StorageClass;
        const sc = scs.find((c) => c.name === scName);
        const reclaimDelete = (pv?.details["Reclaim policy"] ?? sc?.details["Reclaim policy"]) === "Delete";
        return (
          <section key={pvc.uid} className="storage-chain">
            <div className="chain-col">
              <div className="rel-heading">Mounted by</div>
              {mounters.length === 0 && <span className="net-problem">no Pods mount this claim</span>}
              {mounters.map((p) => link(p, "pod"))}
            </div>
            <span className="net-arrow">→</span>
            <div className="chain-col">
              <div className="rel-heading">Claim</div>
              {link(pvc, "pvc")}
              <div className="meta">
                {pvc.details.Capacity ?? "?"} · {pvc.details["Access modes"] ?? ""}
              </div>
            </div>
            <span className="net-arrow">→</span>
            <div className="chain-col">
              <div className="rel-heading">Volume</div>
              {pv ? link(pv, "pv") : <span className="net-problem">{pvc.status === "Pending" ? "not bound yet" : "PV not visible"}</span>}
            </div>
            <span className="net-arrow">→</span>
            <div className="chain-col">
              <div className="rel-heading">Class</div>
              {sc ? link(sc, "sc") : <span className="meta">{scName ?? "-"}</span>}
              {reclaimDelete && (
                <div className="net-problem" title="Deleting the PVC will delete the underlying data">
                  ⚠ reclaim: Delete - deleting the claim deletes the data
                </div>
              )}
            </div>
          </section>
        );
      })}

      {mountWarnings(pvcs, pods)}
    </div>
  );
}

function mountWarnings(pvcs: ResourceSummary[], pods: ResourceSummary[]) {
  const mounted = pvcs.filter((pvc) =>
    pods.some((p) => p.status === "Running" && (p.refs ?? []).includes(`PersistentVolumeClaim/${pvc.name}`)),
  );
  if (mounted.length === 0) return null;
  return (
    <div className="issue-box">
      <p>
        <strong>Before deleting storage:</strong> {mounted.map((p) => p.name).join(", ")}{" "}
        {mounted.length === 1 ? "is" : "are"} currently mounted by running Pods. Deleting a mounted PVC hangs until
        the Pods stop, and depending on the reclaim policy the data may be gone afterwards.
      </p>
    </div>
  );
}
