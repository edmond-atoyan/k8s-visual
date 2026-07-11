import { useEffect, useMemo, useState } from "react";
import type { ActionDescriptor } from "../actions";
import type { ActionResult, ClusterInfo, ClusterProvider, ResourceSummary } from "../types";
import { cloudTag } from "../utils";
import { HealthDot, KubectlHint, RiskBadge } from "./bits";
import { Icon } from "./icons";

interface Props {
  provider: ClusterProvider;
  cluster: ClusterInfo;
  resource: ResourceSummary;
  descriptor: ActionDescriptor;
  onClose(): void;
  /** Called after a successful action so the app can refresh. */
  onDone(): void;
}

/**
 * The single confirmation flow every cluster-changing action goes through:
 * target context → current state → intended change → kubectl intent → risk
 * → RBAC check → explicit confirm → result.
 */
export function ActionModal({ provider, cluster, resource: r, descriptor: d, onClose, onDone }: Props) {
  const inputSpecs = useMemo(() => d.inputs?.(r) ?? [], [d, r]);
  const [inputs, setInputs] = useState<Record<string, number>>(() =>
    Object.fromEntries(inputSpecs.map((i) => [i.name, i.initial])),
  );
  const [typedName, setTypedName] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [access, setAccess] = useState<{ allowed: boolean; reason?: string } | null>(null);

  // Ask the cluster whether the current user may even do this.
  useEffect(() => {
    let cancelled = false;
    provider
      .checkAccess([{ verb: d.verb, resource: d.resource, group: d.group, namespace: r.namespace }])
      .then((res) => {
        if (!cancelled && res[0]) setAccess({ allowed: res[0].allowed, reason: res[0].reason });
      })
      .catch(() => {
        // Could not verify: allow (the API server enforces RBAC regardless)
        // but say so - never silently pretend the check passed.
        if (!cancelled) setAccess({ allowed: true, reason: "permission check unavailable - the API server will still enforce RBAC" });
      });
    return () => {
      cancelled = true;
    };
  }, [provider, d, r.namespace]);

  // Declared min/max are enforced, not just hinted to the browser.
  const inputsValid = inputSpecs.every((spec) => {
    const v = inputs[spec.name];
    return (
      Number.isFinite(v) &&
      (spec.min === undefined || v >= spec.min) &&
      (spec.max === undefined || v <= spec.max)
    );
  });
  const nameConfirmed = !d.confirmName || typedName === r.name;
  // Execute stays disabled until the RBAC check resolves (access !== null).
  const canExecute = !busy && !result?.ok && nameConfirmed && inputsValid && access !== null && access.allowed;

  const execute = async () => {
    setBusy(true);
    try {
      const res = await provider.performAction(d.build(r, inputs));
      setResult(res);
      if (res.ok) onDone();
    } catch (e) {
      setResult({ ok: false, message: String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{d.label.replace(/…$/, "")}</h2>
          <RiskBadge risk={d.risk} />
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" size={13} />
          </button>
        </div>

        <dl className="kv target-context">
          <dt>Cluster / context</dt>
          <dd>
            {cluster.context}
            {provider.mode === "demo" ? " (demo - changes stay in the sample data)" : ""}
          </dd>
          {(() => {
            const tag = cloudTag(cluster.context, cluster.server);
            return tag ? (
              <>
                <dt>Platform</dt>
                <dd>
                  {tag.label}
                  {tag.detail ? ` (${tag.detail})` : ""}
                </dd>
              </>
            ) : null;
          })()}
          <dt>Namespace</dt>
          <dd>{r.namespace || "(cluster-scoped)"}</dd>
          <dt>Resource</dt>
          <dd>
            {r.kind}/{r.name}
          </dd>
          <dt>Current state</dt>
          <dd>
            <HealthDot health={r.health} label={r.status} />
          </dd>
        </dl>

        {inputSpecs.map((spec) => {
          const v = inputs[spec.name];
          const outOfRange =
            Number.isFinite(v) &&
            ((spec.min !== undefined && v < spec.min) || (spec.max !== undefined && v > spec.max));
          return (
            <label key={spec.name} className="modal-input">
              <span>{spec.label}</span>
              <input
                type="number"
                min={spec.min}
                max={spec.max}
                value={Number.isFinite(v) ? v : ""}
                onChange={(e) => {
                  const n = e.target.value === "" ? NaN : Number(e.target.value);
                  setInputs((prev) => ({ ...prev, [spec.name]: n }));
                }}
              />
              {outOfRange && (
                <span className="age">
                  must be {spec.min !== undefined && spec.max !== undefined
                    ? `between ${spec.min} and ${spec.max}`
                    : spec.min !== undefined
                      ? `at least ${spec.min}`
                      : `at most ${spec.max}`}
                </span>
              )}
            </label>
          );
        })}

        <h3>What will change</h3>
        <p className="about">{d.describe(r, inputs)}</p>

        <KubectlHint command={d.kubectl(r, inputs)} />

        {access && !access.allowed && (
          <div className="error-banner">
            You do not have permission to {d.verb} {d.resource}
            {r.namespace ? ` in namespace ${r.namespace}` : ""}.
            {access.reason ? ` (${access.reason})` : ""}
          </div>
        )}
        {access?.allowed && access.reason && <p className="about">{access.reason}</p>}

        {d.confirmName && !result?.ok && (
          <label className="modal-input confirm-name">
            <span>
              This is a destructive action. Type <strong>{r.name}</strong> to confirm:
            </span>
            <input
              type="text"
              value={typedName}
              placeholder={r.name}
              onChange={(e) => setTypedName(e.target.value)}
            />
          </label>
        )}

        {result && (
          <div className={result.ok ? "result-banner ok" : "error-banner"}>{result.message}</div>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            {result?.ok ? "Close" : "Cancel"}
          </button>
          {!result?.ok && (
            <button
              className={`btn primary risk-${d.risk}`}
              disabled={!canExecute}
              onClick={() => void execute()}
            >
              {busy ? "Working…" : access === null ? "Checking permissions…" : d.label.replace(/…$/, "")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
