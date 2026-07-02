import { GROUP_ACCENT_VAR, HEALTH_LABEL, KIND_INFO } from "../kindInfo";
import type { ResourceSummary } from "../types";
import { openExternal } from "../utils";

interface Props {
  resource: ResourceSummary;
  onClose(): void;
}

/** Right-hand panel: what this resource is, its state, and its key facts. */
export function DetailsPanel({ resource: r, onClose }: Props) {
  const meta = KIND_INFO[r.kind];
  const details = Object.entries(r.details);
  const labels = Object.entries(r.labels);

  return (
    <aside className="details" style={{ "--accent": GROUP_ACCENT_VAR[meta.group] } as React.CSSProperties}>
      <div className="details-head">
        <span className="knode-badge">{meta.badge}</span>
        <h2>{r.name}</h2>
        <button className="icon-btn" onClick={onClose} title="Close" aria-label="Close details">
          ✕
        </button>
      </div>

      <h3>Status</h3>
      <div className="status">
        <span className={`dot health-${r.health}`} />
        <span>
          {r.status}
          {r.health !== "neutral" ? ` · ${HEALTH_LABEL[r.health]}` : ""}
        </span>
      </div>

      <h3>What is a {r.kind}?</h3>
      <p className="about">{meta.what}</p>
      <p className="about">{meta.hierarchy}</p>
      <button className="link-btn" onClick={() => void openExternal(meta.docs)}>
        Kubernetes docs ↗
      </button>

      {details.length > 0 && (
        <>
          <h3>Details</h3>
          <dl className="kv">
            {details.map(([k, v]) => (
              <span key={k} style={{ display: "contents" }}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </span>
            ))}
          </dl>
        </>
      )}

      {r.owners.length > 0 && (
        <>
          <h3>Owned by</h3>
          <dl className="kv">
            {r.owners.map((o) => (
              <span key={o.uid} style={{ display: "contents" }}>
                <dt>{o.kind}</dt>
                <dd>{o.name}</dd>
              </span>
            ))}
          </dl>
        </>
      )}

      {labels.length > 0 && (
        <>
          <h3>Labels</h3>
          <div className="label-chips">
            {labels.map(([k, v]) => (
              <span key={k} className="label-chip">
                {k}={v}
              </span>
            ))}
          </div>
        </>
      )}
    </aside>
  );
}
