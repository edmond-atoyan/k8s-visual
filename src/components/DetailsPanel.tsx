import { useCallback, useEffect, useMemo, useState } from "react";
import { actionsFor, KUBECTL_INTENT, type ActionDescriptor } from "../actions";
import { selectorMatches } from "../graph/build";
import { GROUP_ACCENT_VAR, HEALTH_LABEL, KIND_INFO } from "../kindInfo";
import type {
  ClusterInfo,
  ClusterProvider,
  EventInfo,
  ExecResult,
  NamespaceSnapshot,
  PortForwardInfo,
  ResourceSummary,
  RolloutRevision,
} from "../types";
import { diffLines, formatAge, formatClock, openExternal } from "../utils";
import { HealthDot, KubectlHint, Kv, RiskBadge } from "./bits";
import { AiLogo, Icon } from "./icons";
import { LogViewer, type LogSource } from "./LogViewer";

type Tab = "overview" | "status" | "events" | "logs" | "yaml" | "actions";

const WORKLOAD_KINDS = new Set(["Deployment", "ReplicaSet", "StatefulSet", "DaemonSet", "Job", "CronJob"]);

interface Props {
  provider: ClusterProvider;
  cluster: ClusterInfo;
  snapshot: NamespaceSnapshot;
  resource: ResourceSummary;
  management: boolean;
  issues: string[];
  /** Integrated terminal / AI CLI quick actions (absent in contexts without a terminal). */
  terminal?: {
    tools: { id: "codex" | "claude"; name: string; installed: boolean }[] | null;
    open(): void;
    ask(tool: "codex" | "claude", resource: ResourceSummary, issues: string[]): void;
    copySummary(resource: ResourceSummary, issues: string[]): void;
  };
  onSelectResource(uid: string): void;
  onAction(resource: ResourceSummary, descriptor: ActionDescriptor): void;
  onClose(): void;
}

/** Transitively collect the Pods a workload owns (for logs aggregation). */
function ownedPods(snapshot: NamespaceSnapshot, root: ResourceSummary): ResourceSummary[] {
  const byUid = new Map(snapshot.resources.map((r) => [r.uid, r]));
  const isDescendant = (r: ResourceSummary): boolean =>
    r.owners.some((o) => o.uid === root.uid || (byUid.get(o.uid) ? isDescendant(byUid.get(o.uid)!) : false));
  return snapshot.resources.filter((r) => r.kind === "Pod" && isDescendant(r));
}

export function DetailsPanel(props: Props) {
  const { resource: r, onClose } = props;
  const meta = KIND_INFO[r.kind];
  const [tab, setTab] = useState<Tab>("overview");

  // Reset to overview when a different resource is selected.
  useEffect(() => setTab("overview"), [r.uid]);

  const isGhost = r.uid.startsWith("missing:");
  const logSources: LogSource[] = useMemo(() => {
    const pods = r.kind === "Pod" ? [r] : WORKLOAD_KINDS.has(r.kind) ? ownedPods(props.snapshot, r) : [];
    return pods
      .filter((p) => p.status !== "Pending")
      .map((p) => ({ pod: p.name, containers: (p.containers ?? []).map((c) => c.name) }));
  }, [r, props.snapshot]);

  const tabs: [Tab, string][] = [["overview", "Overview"]];
  if (!isGhost) {
    tabs.push(["status", "Status"], ["events", "Events"]);
    if (logSources.length > 0) tabs.push(["logs", "Logs"]);
    tabs.push(["yaml", "YAML"], ["actions", "Actions"]);
  }

  return (
    <aside
      className="details details-wide"
      style={{ "--accent": GROUP_ACCENT_VAR[meta.group] } as React.CSSProperties}
    >
      <div className="details-head">
        <span className="knode-badge">{meta.badge}</span>
        <h2 title={r.name}>{r.name}</h2>
        <button className="icon-btn" onClick={onClose} title="Close" aria-label="Close details">
          <Icon name="close" size={13} />
        </button>
      </div>

      <div className="tab-row">
        {tabs.map(([id, label]) => (
          <button key={id} className={`tab${tab === id ? " active" : ""}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>

      {tab === "overview" && <OverviewTab {...props} />}
      {tab === "status" && <StatusTab {...props} onGoToLogs={() => setTab("logs")} onGoToEvents={() => setTab("events")} />}
      {tab === "events" && <EventsTab {...props} />}
      {tab === "logs" && (
        <LogViewer provider={props.provider} namespace={r.namespace} sources={logSources} aggregate />
      )}
      {tab === "yaml" && <YamlTab {...props} />}
      {tab === "actions" && <ActionsTab {...props} />}
    </aside>
  );
}

// --- Overview ---------------------------------------------------------------

function OverviewTab({ resource: r, snapshot, issues, onSelectResource }: Props) {
  const meta = KIND_INFO[r.kind];
  const isGhost = r.uid.startsWith("missing:");
  const labels = Object.entries(r.labels);
  const annotations = Object.entries(r.annotations ?? {});
  const [showAnnotations, setShowAnnotations] = useState(false);

  // Relationships, resolved against the current snapshot.
  const rels = useMemo(() => {
    const owned = snapshot.resources.filter((x) => x.owners.some((o) => o.uid === r.uid));
    const refsOut = (r.refs ?? [])
      .map((ref) => snapshot.resources.find((x) => `${x.kind}/${x.name}` === ref) ?? ref)
      .filter(Boolean);
    const referencedBy = snapshot.resources.filter((x) => (x.refs ?? []).includes(`${r.kind}/${r.name}`));
    const selectedBy = snapshot.resources.filter(
      (x) => (x.kind === "Service" || x.kind === "NetworkPolicy") && x.selector && r.kind === "Pod" && selectorMatches(x.selector, r.labels),
    );
    const selects =
      (r.kind === "Service" || r.kind === "NetworkPolicy") && r.selector
        ? snapshot.resources.filter((x) => x.kind === "Pod" && selectorMatches(r.selector!, x.labels))
        : [];
    return { owned, refsOut, referencedBy, selectedBy, selects };
  }, [r, snapshot]);

  const linkRow = (x: ResourceSummary) => (
    <button key={x.uid} className="rel-link" onClick={() => onSelectResource(x.uid)}>
      <span className="knode-badge">{KIND_INFO[x.kind].badge}</span> {x.name}
      <HealthDot health={x.health} label={x.status} />
    </button>
  );

  return (
    <div className="tab-body">
      <h3>Status</h3>
      <div className="status">
        <HealthDot health={r.health} label={`${r.status}${r.health !== "neutral" ? ` · ${HEALTH_LABEL[r.health]}` : ""}`} />
        {r.createdAt && <span className="age">age {formatAge(r.createdAt)}</span>}
      </div>

      {issues.length > 0 && (
        <div className="issue-box">
          {issues.map((issue, i) => (
            <p key={i}>⚠ {issue}</p>
          ))}
        </div>
      )}

      {isGhost && (
        <p className="about">
          This node is shown because something references a {r.kind} named “{r.name}”, but no such {r.kind} exists in
          this namespace. Create it, or fix the reference.
        </p>
      )}

      <h3>What is a {r.kind}?</h3>
      <p className="about">{meta.what}</p>
      <p className="about">{meta.hierarchy}</p>
      <button className="link-btn" onClick={() => void openExternal(meta.docs)}>
        Kubernetes docs ↗
      </button>

      {Object.entries(r.details).length > 0 && (
        <>
          <h3>Details</h3>
          <Kv entries={Object.entries(r.details)} />
        </>
      )}

      {(rels.owned.length > 0 || r.owners.length > 0 || rels.refsOut.length > 0 || rels.referencedBy.length > 0 || rels.selectedBy.length > 0 || rels.selects.length > 0) && (
        <>
          <h3>Relationships</h3>
          {r.owners.length > 0 && (
            <div className="rel-group">
              <div className="rel-heading">Owned by (ownerReferences)</div>
              {r.owners.map((o) => {
                const target = snapshot.resources.find((x) => x.uid === o.uid);
                return target ? linkRow(target) : <div key={o.uid} className="rel-link">{o.kind} {o.name}</div>;
              })}
            </div>
          )}
          {rels.owned.length > 0 && (
            <div className="rel-group">
              <div className="rel-heading">Owns</div>
              {rels.owned.map(linkRow)}
            </div>
          )}
          {rels.selects.length > 0 && (
            <div className="rel-group">
              <div className="rel-heading">{r.kind === "Service" ? "Selects (label selector)" : "Applies to (podSelector)"}</div>
              {rels.selects.map(linkRow)}
            </div>
          )}
          {rels.selectedBy.length > 0 && (
            <div className="rel-group">
              <div className="rel-heading">Selected by</div>
              {rels.selectedBy.map(linkRow)}
            </div>
          )}
          {rels.refsOut.length > 0 && (
            <div className="rel-group">
              <div className="rel-heading">References / mounts</div>
              {rels.refsOut.map((x) =>
                typeof x === "string" ? (
                  <div key={x} className="rel-link broken">
                    {x} <span className="missing-tag">not found</span>
                  </div>
                ) : (
                  linkRow(x)
                ),
              )}
            </div>
          )}
          {rels.referencedBy.length > 0 && (
            <div className="rel-group">
              <div className="rel-heading">Referenced / mounted by</div>
              {rels.referencedBy.map(linkRow)}
            </div>
          )}
          {r.kind === "Pod" && r.details.Node && (
            <div className="rel-group">
              <div className="rel-heading">Scheduled on</div>
              <div className="rel-link">node {r.details.Node}</div>
            </div>
          )}
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

      {annotations.length > 0 && (
        <>
          <h3>
            Annotations{" "}
            <button className="link-btn" onClick={() => setShowAnnotations((v) => !v)}>
              {showAnnotations ? "hide" : `show ${annotations.length}`}
            </button>
          </h3>
          {showAnnotations && <Kv entries={annotations} />}
        </>
      )}
    </div>
  );
}

// --- Status -------------------------------------------------------------------

function StatusTab({
  resource: r,
  onGoToLogs,
  onGoToEvents,
}: Props & { onGoToLogs(): void; onGoToEvents(): void }) {
  const meta = KIND_INFO[r.kind];
  const containers = r.containers ?? [];
  const conditions = r.conditions ?? [];
  return (
    <div className="tab-body">
      <h3>Status</h3>
      <HealthDot health={r.health} label={r.status} />

      {containers.length > 0 && (
        <>
          <h3>Containers</h3>
          <div className="cond-list">
            {containers.map((c) => (
              <div key={c.name} className="cond-card">
                <div className="cond-head">
                  {c.init && <span className="missing-tag">init</span>}
                  <span className="cond-name">{c.name}</span>
                  <span className={`cond-status ${c.ready ? "ok" : "attn"}`}>
                    {c.ready ? "ready" : "not ready"}
                  </span>
                </div>
                <div className="cond-image">{c.image}</div>
                <div className="cond-meta">
                  <span>{c.state}</span>
                  <span>restarts: {c.restarts}</span>
                  {c.ports.length > 0 && <span>ports: {c.ports.join(", ")}</span>}
                </div>
                {c.lastState && <div className="cond-msg">last: {c.lastState}</div>}
              </div>
            ))}
          </div>
        </>
      )}

      {conditions.length > 0 && (
        <>
          <h3>Conditions</h3>
          <div className="cond-list">
            {conditions.map((c) => (
              <div key={c.type} className="cond-card">
                <div className="cond-head">
                  <span className="cond-name">{c.type}</span>
                  <span className="cond-status">{c.status}</span>
                </div>
                {(c.reason || c.message) && (
                  <div className="cond-msg">
                    {c.reason}
                    {c.reason && c.message ? " - " : ""}
                    {c.message}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {(r.health === "critical" || r.health === "warning") && (
        <div className="issue-box">
          <p>
            <strong>Debugging {r.status}</strong>
          </p>
          <p>{meta.problems}</p>
          <p>
            <button className="link-btn" onClick={onGoToEvents}>
              related events →
            </button>{" "}
            {r.kind === "Pod" && (
              <button className="link-btn" onClick={onGoToLogs}>
                logs (incl. previous) →
              </button>
            )}
          </p>
        </div>
      )}

      <KubectlHint command={KUBECTL_INTENT.describe(r.namespace, r.kind, r.name)} />
    </div>
  );
}

// --- Events ----------------------------------------------------------------------

function EventsTab({ provider, resource: r }: Props) {
  const [events, setEvents] = useState<EventInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    provider
      .getEvents(r.namespace)
      .then((all) => {
        if (!cancelled) setEvents(all.filter((e) => e.involvedName === r.name));
      })
      .catch((e) => setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [provider, r]);

  if (error) return <div className="error-banner">{error}</div>;
  if (!events) return <p className="about">Loading events…</p>;
  if (events.length === 0)
    return <p className="about">No events recorded for this resource (events expire after ~1 hour).</p>;
  return (
    <div className="tab-body">
      <div className="timeline">
        {events.map((e, i) => (
          <div key={i} className={`timeline-item ${e.type === "Warning" ? "warn" : ""}`}>
            <div className="timeline-meta">
              <span className={`event-type ${e.type === "Warning" ? "warn" : ""}`}>{e.type}</span>
              <strong>{e.reason}</strong>
              <span className="age">
                ×{e.count} · {formatAge(e.lastSeen)} ago {formatClock(e.lastSeen) && `(${formatClock(e.lastSeen)})`}
              </span>
            </div>
            <div className="timeline-msg">{e.message}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// --- YAML -------------------------------------------------------------------------

function YamlTab({ provider, resource: r, management }: Props) {
  const [yaml, setYaml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [edited, setEdited] = useState("");
  const [preview, setPreview] = useState<{ diff: ReturnType<typeof diffLines>; dryRun: string } | null>(null);
  const [applyMsg, setApplyMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setYaml(null);
    setEditing(false);
    setPreview(null);
    setApplyMsg(null);
    provider
      .getYaml({ kind: r.kind, namespace: r.namespace, name: r.name })
      .then((y) => {
        if (!cancelled) {
          setYaml(y);
          setEdited(y);
        }
      })
      .catch((e) => setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [provider, r]);

  if (error) return <div className="error-banner">{error}</div>;
  if (yaml === null) return <p className="about">Loading YAML…</p>;

  const runPreview = async () => {
    setBusy(true);
    setApplyMsg(null);
    try {
      const dry = await provider.applyYaml(edited, true, r.namespace);
      setPreview({
        diff: diffLines(yaml, edited),
        dryRun: dry.ok ? `Server dry-run OK: ${dry.results.join("; ")}` : `Server dry-run failed: ${dry.error}`,
      });
    } catch (e) {
      setPreview({ diff: diffLines(yaml, edited), dryRun: `Dry-run failed: ${String(e)}` });
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    setBusy(true);
    try {
      const res = await provider.applyYaml(edited, false, r.namespace);
      setApplyMsg(res.ok ? `Applied: ${res.results.join("; ")}` : `Apply failed: ${res.error}`);
      if (res.ok) {
        setYaml(edited);
        setEditing(false);
        setPreview(null);
      }
    } catch (e) {
      setApplyMsg(`Apply failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tab-body">
      <div className="log-toolbar">
        <button className="chip" onClick={() => void navigator.clipboard.writeText(yaml)}>
          copy
        </button>
        {!editing && (
          <button
            className="chip"
            disabled={!management}
            title={management ? undefined : "Enable management mode to edit"}
            onClick={() => setEditing(true)}
          >
            edit
          </button>
        )}
        {editing && (
          <>
            <button className="chip" onClick={() => { setEditing(false); setEdited(yaml); setPreview(null); }}>
              cancel
            </button>
            <button className="chip on" disabled={busy} onClick={() => void runPreview()}>
              preview diff + dry-run
            </button>
          </>
        )}
      </div>

      {r.kind === "Secret" && (
        <p className="about">Secret data values are masked here by design - use Config &amp; Secrets to reveal them explicitly.</p>
      )}

      {!editing && <pre className="yaml-pane">{yaml}</pre>}
      {editing && (
        <textarea
          className="yaml-edit"
          value={edited}
          spellCheck={false}
          onChange={(e) => setEdited(e.target.value)}
        />
      )}

      {preview && (
        <>
          <h3>Diff (live → edited)</h3>
          <pre className="yaml-pane diff-pane">
            {preview.diff.filter((d) => d.type !== "same").length === 0 && "(no changes)\n"}
            {preview.diff.map((d, i) =>
              d.type === "same" ? null : (
                <div key={i} className={d.type === "add" ? "diff-add" : "diff-del"}>
                  {d.type === "add" ? "+ " : "- "}
                  {d.text}
                </div>
              ),
            )}
          </pre>
          <p className="about">{preview.dryRun}</p>
          <div className="modal-actions">
            <button className="btn primary risk-high" disabled={busy} onClick={() => void apply()}>
              Apply to cluster (high risk)
            </button>
          </div>
        </>
      )}
      {applyMsg && <div className={applyMsg.startsWith("Applied") ? "result-banner ok" : "error-banner"}>{applyMsg}</div>}

      <KubectlHint command={KUBECTL_INTENT.getYaml(r.namespace, r.kind, r.name)} />
    </div>
  );
}

// --- Actions ----------------------------------------------------------------------

function ActionsTab(props: Props) {
  const { provider, resource: r, management, onAction } = props;
  const descriptors = actionsFor(r);
  const [history, setHistory] = useState<RolloutRevision[] | null>(null);

  useEffect(() => {
    if (r.kind !== "Deployment") return;
    provider
      .getRolloutHistory(r.namespace, r.name)
      .then(setHistory)
      .catch(() => setHistory(null));
  }, [provider, r]);

  return (
    <div className="tab-body">
      {!management && (
        <div className="issue-box">
          <p>
            The app is in <strong>read-only</strong> mode - every action below is disabled. Enable management mode in
            the title bar to perform actions (each one still asks for confirmation).
          </p>
        </div>
      )}

      <h3>Actions</h3>
      {descriptors.length === 0 && <p className="about">No actions available for this kind.</p>}
      <div className="action-list">
        {descriptors.map((d) => (
          <button
            key={d.id}
            className="action-btn"
            disabled={!management}
            title={management ? undefined : "Read-only mode - enable management in the title bar"}
            onClick={() => onAction(r, d)}
          >
            <span>{d.label}</span>
            <RiskBadge risk={d.risk} />
          </button>
        ))}
      </div>

      {r.kind === "Deployment" && history && history.length > 0 && (
        <>
          <h3>Rollout history</h3>
          <table className="mini-table">
            <thead>
              <tr>
                <th>Rev</th>
                <th>ReplicaSet</th>
                <th>Image</th>
                <th>Ready</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.revision} className={h.current ? "current-rev" : ""}>
                  <td>
                    {h.revision}
                    {h.current ? " (current)" : ""}
                  </td>
                  <td>{h.replicaSet}</td>
                  <td>{h.images.join(", ")}</td>
                  <td>
                    {h.ready}/{h.desired}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {r.kind === "Pod" && <ExecBox {...props} />}
      {(r.kind === "Pod" || r.kind === "Service") && <PortForwardBox {...props} />}

      {props.terminal && <TerminalAiBox {...props} />}
    </div>
  );
}

/** Terminal + AI CLI quick actions. Prompts are typed into the terminal for
 *  review, never executed automatically; summaries are sanitized (no secret
 *  values, no annotations, no credentials). */
function TerminalAiBox({ resource: r, issues, terminal }: Props) {
  const [copied, setCopied] = useState(false);
  if (!terminal) return null;
  return (
    <>
      <h3>Terminal &amp; AI</h3>
      <p className="about">
        Work on this resource in the integrated terminal. "Ask" types a sanitized summary (no secret
        values) into the AI CLI for review - nothing is sent until you press Enter.
      </p>
      <div className="log-toolbar">
        <button className="chip" onClick={() => terminal.open()}>
          Open terminal here
        </button>
        {(terminal.tools ?? []).map((tool) => (
          <button
            key={tool.id}
            className="chip"
            title={
              tool.installed
                ? `Type a sanitized ${r.kind} summary into ${tool.name} for review`
                : `${tool.name} is not installed - click for install instructions`
            }
            onClick={() => terminal.ask(tool.id, r, issues)}
          >
            <AiLogo tool={tool.id} size={12} />
            Ask {tool.name}
          </button>
        ))}
        <button
          className="chip"
          title="Copy the sanitized summary (kind, status, containers, conditions, diagnostics)"
          onClick={() => {
            terminal.copySummary(r, issues);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? "copied" : "copy summary"}
        </button>
      </div>
    </>
  );
}

function ExecBox({ provider, resource: r, management }: Props) {
  const [command, setCommand] = useState("ls /");
  const [container, setContainer] = useState("");
  const [result, setResult] = useState<ExecResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containers = (r.containers ?? []).filter((c) => !c.init);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(
        await provider.execCommand({
          namespace: r.namespace,
          pod: r.name,
          container: container || undefined,
          command: command.split(" ").filter(Boolean),
        }),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h3>Run command in container</h3>
      <p className="about">
        Runs a single non-interactive command inside the container (like <code>kubectl exec</code> without a TTY).
        Treat this as production access: output stays on this machine and is not recorded.
      </p>
      <div className="log-toolbar">
        {containers.length > 1 && (
          <select value={container} onChange={(e) => setContainer(e.target.value)}>
            {containers.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
        )}
        <input
          className="search-box grow"
          type="text"
          value={command}
          disabled={!management}
          placeholder={management ? "command…" : "enable management mode to exec"}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && management && void run()}
        />
        <button className="chip" disabled={!management || busy} onClick={() => void run()}>
          {busy ? "running…" : "run"}
        </button>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {result && (
        <pre className="log-pane exec-out">
          {result.stdout}
          {result.stderr && `\n[stderr]\n${result.stderr}`}
        </pre>
      )}
      <KubectlHint command={KUBECTL_INTENT.exec(r.namespace, r.name, container || undefined, command)} />
    </>
  );
}

function PortForwardBox({ provider, resource: r }: Props) {
  const [local, setLocal] = useState(8080);
  const [remote, setRemote] = useState(() => r.servicePorts?.[0]?.port ?? r.containers?.[0]?.ports?.[0] ?? 80);
  const [forwards, setForwards] = useState<PortForwardInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    provider.listPortForwards().then(setForwards).catch(() => {});
  }, [provider]);
  useEffect(refresh, [refresh]);

  const start = async () => {
    setError(null);
    try {
      await provider.startPortForward({
        namespace: r.namespace,
        kind: r.kind,
        name: r.name,
        localPort: local,
        remotePort: remote,
      });
      refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const mine = forwards.filter((f) => f.name === r.name && f.namespace === r.namespace && f.kind === r.kind);

  return (
    <>
      <h3>Port-forward</h3>
      <p className="about">
        Opens a local tunnel to this {r.kind === "Service" ? "Service's Pods" : "Pod"} on 127.0.0.1. Nothing in the
        cluster changes, but the workload becomes reachable from this machine.
        {provider.mode === "demo" && " (Demo: the tunnel is simulated.)"}
      </p>
      <div className="log-toolbar">
        <label className="chk tail">
          local
          <input type="number" min={1} max={65535} value={local} onChange={(e) => setLocal(Number(e.target.value))} />
        </label>
        <label className="chk tail">
          remote
          <input type="number" min={1} max={65535} value={remote} onChange={(e) => setRemote(Number(e.target.value))} />
        </label>
        <button className="chip on" onClick={() => void start()}>
          start
        </button>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {mine.map((f) => (
        <div key={f.id} className="pf-row">
          <code>localhost:{f.localPort}</code> → {f.targetPod}:{f.remotePort}
          <button className="link-btn" onClick={() => void navigator.clipboard.writeText(`http://localhost:${f.localPort}`)}>
            copy URL
          </button>
          <button className="link-btn" onClick={() => provider.stopPortForward(f.id).then(refresh)}>
            stop
          </button>
        </div>
      ))}
      <KubectlHint command={KUBECTL_INTENT.portForward(r.namespace, r.kind, r.name, local, remote)} />
    </>
  );
}
