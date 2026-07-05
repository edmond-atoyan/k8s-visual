import { useState } from "react";
import { EmptyMsg } from "../components/bits";
import type { ClusterProvider, NamespaceSnapshot, ResourceSummary, SecretKey } from "../types";

interface Props {
  provider: ClusterProvider;
  snapshot: NamespaceSnapshot;
  onSelect(uid: string): void;
}

/**
 * ConfigMaps are shown openly; Secrets show metadata and key names only.
 * Values appear solely through the explicit reveal flow below, are kept in
 * component state only, and are dropped again on hide/unmount.
 */
export function ConfigSecretsView({ provider, snapshot, onSelect }: Props) {
  const configmaps = snapshot.resources.filter((r) => r.kind === "ConfigMap");
  const secrets = snapshot.resources.filter((r) => r.kind === "Secret");
  const pods = snapshot.resources.filter((r) => r.kind === "Pod");

  if (configmaps.length === 0 && secrets.length === 0) {
    return (
      <div className="overview wide">
        <h2>
          Config &amp; Secrets <span className="h2-sub">· {snapshot.namespace}</span>
        </h2>
        <EmptyMsg>
          <p>No ConfigMaps or Secrets in this namespace.</p>
        </EmptyMsg>
      </div>
    );
  }

  const mountersOf = (r: ResourceSummary) =>
    pods.filter((p) => (p.refs ?? []).includes(`${r.kind}/${r.name}`));

  return (
    <div className="overview wide">
      <h2>
        Config &amp; Secrets <span className="h2-sub">· {snapshot.namespace}</span>
      </h2>

      <h3>ConfigMaps</h3>
      {configmaps.map((cm) => (
        <ConfigMapCard key={cm.uid} provider={provider} cm={cm} mounters={mountersOf(cm)} onSelect={onSelect} />
      ))}
      {configmaps.length === 0 && <p className="about">None in this namespace.</p>}

      <h3>Secrets</h3>
      <p className="about">
        Secret values are never fetched or shown automatically. Key names and metadata are safe to display; values
        require the explicit reveal flow and are never stored or logged by the app.
      </p>
      {secrets.map((s) => (
        <SecretCard key={s.uid} provider={provider} secret={s} mounters={mountersOf(s)} onSelect={onSelect} />
      ))}
      {secrets.length === 0 && <p className="about">None in this namespace.</p>}
    </div>
  );
}

function MounterRow({ mounters, onSelect }: { mounters: ResourceSummary[]; onSelect(uid: string): void }) {
  if (mounters.length === 0) return <div className="meta">not mounted by any Pod</div>;
  return (
    <div className="meta">
      mounted by{" "}
      {mounters.map((p, i) => (
        <span key={p.uid}>
          {i > 0 && ", "}
          <button className="link-btn" onClick={() => onSelect(p.uid)}>
            {p.name}
          </button>
        </span>
      ))}
    </div>
  );
}

function ConfigMapCard({
  provider,
  cm,
  mounters,
  onSelect,
}: {
  provider: ClusterProvider;
  cm: ResourceSummary;
  mounters: ResourceSummary[];
  onSelect(uid: string): void;
}) {
  const [data, setData] = useState<Record<string, string> | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = () => {
    setOpen((v) => !v);
    if (!data) {
      provider
        .getConfigMapData(cm.namespace, cm.name)
        .then(setData)
        .catch((e) => setError(String(e)));
    }
  };

  return (
    <div className="config-card">
      <div className="config-head">
        <button className="rel-link big" onClick={() => onSelect(cm.uid)}>
          <span className="knode-badge">cm</span> {cm.name}
        </button>
        <span className="age">{cm.status}</span>
        <button className="link-btn" onClick={toggle}>
          {open ? "hide values" : "view values"}
        </button>
      </div>
      <MounterRow mounters={mounters} onSelect={onSelect} />
      {error && <div className="error-banner">{error}</div>}
      {open && data && (
        <div className="config-values">
          {Object.entries(data).map(([k, v]) => (
            <div key={k} className="config-value">
              <div className="config-key">
                {k}
                <button className="link-btn" onClick={() => void navigator.clipboard.writeText(v)}>
                  copy
                </button>
              </div>
              <pre>{v}</pre>
            </div>
          ))}
          {Object.keys(data).length === 0 && <p className="about">(empty)</p>}
        </div>
      )}
    </div>
  );
}

function SecretCard({
  provider,
  secret,
  mounters,
  onSelect,
}: {
  provider: ClusterProvider;
  secret: ResourceSummary;
  mounters: ResourceSummary[];
  onSelect(uid: string): void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [revealed, setRevealed] = useState<SecretKey[] | null>(null);
  const [shown, setShown] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const keyNames = (secret.details.Keys ?? "").split(", ").filter(Boolean);

  const hideAll = () => {
    // Drop values from state entirely - nothing is cached or persisted.
    setRevealed(null);
    setShown(new Set());
    setConfirming(false);
  };

  const reveal = async () => {
    setError(null);
    try {
      setRevealed(await provider.revealSecret(secret.namespace, secret.name));
      setConfirming(false);
    } catch (e) {
      setError(String(e));
      setConfirming(false);
    }
  };

  return (
    <div className="config-card secret-card">
      <div className="config-head">
        <button className="rel-link big" onClick={() => onSelect(secret.uid)}>
          <span className="knode-badge">secret</span> {secret.name}
        </button>
        <span className="age">
          {secret.details.Type ?? "Opaque"} · {secret.status}
        </span>
        {!revealed && !confirming && (
          <button className="link-btn danger" onClick={() => setConfirming(true)}>
            reveal values…
          </button>
        )}
        {revealed && (
          <button className="link-btn" onClick={hideAll}>
            hide values
          </button>
        )}
      </div>
      <MounterRow mounters={mounters} onSelect={onSelect} />
      {keyNames.length > 0 && !revealed && (
        <div className="label-chips">
          {keyNames.map((k) => (
            <span key={k} className="label-chip">
              {k}
            </span>
          ))}
        </div>
      )}

      {confirming && (
        <div className="issue-box">
          <p>
            Secret values may contain passwords, tokens, keys, and credentials. Only reveal them if you are
            authorized to view this data. Values are decoded locally, never stored, and never logged.
          </p>
          <div className="modal-actions">
            <button className="btn" onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button className="btn primary risk-high" onClick={() => void reveal()}>
              Reveal values
            </button>
          </div>
        </div>
      )}
      {error && <div className="error-banner">{error}</div>}

      {revealed && (
        <div className="config-values">
          {revealed.map((k) => (
            <div key={k.name} className="config-value">
              <div className="config-key">
                {k.name}
                <span className="age">{k.bytes} bytes</span>
                {!k.binary && (
                  <>
                    <button
                      className="link-btn"
                      onClick={() =>
                        setShown((prev) => {
                          const next = new Set(prev);
                          if (next.has(k.name)) next.delete(k.name);
                          else next.add(k.name);
                          return next;
                        })
                      }
                    >
                      {shown.has(k.name) ? "hide" : "show"}
                    </button>
                    <button className="link-btn" onClick={() => void navigator.clipboard.writeText(k.value ?? "")}>
                      copy
                    </button>
                  </>
                )}
              </div>
              {k.binary ? (
                <pre className="masked">(binary value - not rendered)</pre>
              ) : (
                <pre className={shown.has(k.name) ? "" : "masked"}>
                  {shown.has(k.name) ? k.value : "•".repeat(Math.min(k.bytes, 24))}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
