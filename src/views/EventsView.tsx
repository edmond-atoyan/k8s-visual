import { useEffect, useMemo, useState } from "react";
import { KUBECTL_INTENT } from "../actions";
import { EmptyMsg, KubectlHint, SearchBox } from "../components/bits";
import type { ClusterProvider, EventInfo, NamespaceSnapshot } from "../types";
import { formatAge, formatClock } from "../utils";

interface Props {
  provider: ClusterProvider;
  namespace: string;
  snapshot: NamespaceSnapshot | null;
  onSelectResource(uid: string): void;
}

/** Events as a timeline, not a table: what happened, to what, how often. */
export function EventsView({ provider, namespace, snapshot, onSelectResource }: Props) {
  const [events, setEvents] = useState<EventInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warningsOnly, setWarningsOnly] = useState(false);
  const [reason, setReason] = useState("all");
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;
    setEvents(null);
    const load = () =>
      provider
        .getEvents(namespace)
        .then((e) => !cancelled && (setEvents(e), setError(null)))
        .catch((e) => !cancelled && setError(String(e)));
    load();
    const t = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [provider, namespace]);

  const reasons = useMemo(
    () => Array.from(new Set((events ?? []).map((e) => e.reason))).sort(),
    [events],
  );

  const visible = (events ?? []).filter((e) => {
    if (warningsOnly && e.type !== "Warning") return false;
    if (reason !== "all" && e.reason !== reason) return false;
    const q = search.trim().toLowerCase();
    if (q && !`${e.reason} ${e.message} ${e.involvedName}`.toLowerCase().includes(q)) return false;
    return true;
  });

  const jumpTo = (e: EventInfo) => {
    const target = snapshot?.resources.find((r) => r.kind === e.involvedKind && r.name === e.involvedName);
    if (target) onSelectResource(target.uid);
  };

  return (
    <div className="overview wide">
      <h2>
        Events <span className="h2-sub">- what the cluster has been doing · {namespace}</span>
      </h2>

      <div className="graph-toolbar wrap">
        <SearchBox value={search} onChange={setSearch} placeholder="search events…" />
        <button className={`chip${warningsOnly ? " on" : ""}`} onClick={() => setWarningsOnly((v) => !v)}>
          Warnings only ({(events ?? []).filter((e) => e.type === "Warning").length})
        </button>
        <select value={reason} onChange={(e) => setReason(e.target.value)}>
          <option value="all">all reasons</option>
          {reasons.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {events && events.length === 0 && (
        <EmptyMsg>
          <p>No events in {namespace}. Kubernetes only keeps events for about an hour.</p>
        </EmptyMsg>
      )}

      <div className="timeline">
        {visible.map((e, i) => (
          <div key={i} className={`timeline-item ${e.type === "Warning" ? "warn" : ""}`}>
            <div className="timeline-meta">
              <span className={`event-type ${e.type === "Warning" ? "warn" : ""}`}>{e.type}</span>
              <strong>{e.reason}</strong>
              <button className="link-btn" onClick={() => jumpTo(e)} title="Open the involved resource">
                {e.involvedKind}/{e.involvedName}
              </button>
              <span className="age">
                ×{e.count} · {formatAge(e.lastSeen)} ago {formatClock(e.lastSeen) && `(${formatClock(e.lastSeen)})`}
              </span>
            </div>
            <div className="timeline-msg">{e.message}</div>
          </div>
        ))}
      </div>

      <KubectlHint command={KUBECTL_INTENT.events(namespace)} />
    </div>
  );
}
