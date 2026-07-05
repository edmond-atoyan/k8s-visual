import { useMemo, useState } from "react";
import { HealthDot, SearchBox } from "../components/bits";
import { ALL_KINDS, GROUP_ACCENT_VAR, KIND_INFO } from "../kindInfo";
import type { Kind, NamespaceSnapshot, ResourceSummary } from "../types";
import { formatAge } from "../utils";

interface Props {
  snapshot: NamespaceSnapshot;
  onSelect(uid: string): void;
  onShowInGraph(uid: string): void;
}

type SortKey = "name" | "kind" | "status" | "age";

/** The visual `kubectl get`: filterable, sortable tables of everything. */
export function ExplorerView({ snapshot, onSelect, onShowInGraph }: Props) {
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<Kind | "all">("all");
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("kind");
  const [sortAsc, setSortAsc] = useState(true);

  const presentKinds = useMemo(() => {
    const set = new Set(snapshot.resources.map((r) => r.kind));
    return ALL_KINDS.filter((k) => set.has(k));
  }, [snapshot]);

  const rows = useMemo(() => {
    let list = snapshot.resources;
    if (kindFilter !== "all") list = list.filter((r) => r.kind === kindFilter);
    if (problemsOnly) list = list.filter((r) => r.health === "critical" || r.health === "warning");
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.kind.toLowerCase().includes(q) ||
          Object.entries(r.labels).some(([k, v]) => `${k}=${v}`.toLowerCase().includes(q)),
      );
    }
    const dir = sortAsc ? 1 : -1;
    const key = (r: ResourceSummary): string | number => {
      switch (sortKey) {
        case "name": return r.name;
        case "kind": return `${KIND_INFO[r.kind].group} ${r.kind} ${r.name}`;
        case "status": return `${r.health} ${r.status}`;
        case "age": return r.createdAt ? -new Date(r.createdAt).getTime() : 0;
      }
    };
    return [...list].sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      return (typeof ka === "number" && typeof kb === "number" ? ka - kb : String(ka).localeCompare(String(kb))) * dir;
    });
  }, [snapshot, search, kindFilter, problemsOnly, sortKey, sortAsc]);

  const header = (label: string, key: SortKey) => (
    <th
      className="sortable"
      onClick={() => {
        if (sortKey === key) setSortAsc((v) => !v);
        else {
          setSortKey(key);
          setSortAsc(true);
        }
      }}
    >
      {label}
      {sortKey === key ? (sortAsc ? " ↑" : " ↓") : ""}
    </th>
  );

  return (
    <div className="overview wide">
      <h2>
        Resource explorer <span className="h2-sub">- kubectl get, visually · {snapshot.namespace}</span>
      </h2>

      <div className="graph-toolbar wrap">
        <SearchBox value={search} onChange={setSearch} placeholder="search name / kind / label…" />
        <button className={`chip${kindFilter === "all" ? " on" : ""}`} onClick={() => setKindFilter("all")}>
          All ({snapshot.resources.length})
        </button>
        {presentKinds.map((k) => (
          <button
            key={k}
            className={`chip${kindFilter === k ? " on" : ""}`}
            style={{ "--accent": GROUP_ACCENT_VAR[KIND_INFO[k].group] } as React.CSSProperties}
            onClick={() => setKindFilter(kindFilter === k ? "all" : k)}
          >
            {KIND_INFO[k].badge} ({snapshot.resources.filter((r) => r.kind === k).length})
          </button>
        ))}
        <button className={`chip${problemsOnly ? " on" : ""}`} onClick={() => setProblemsOnly((v) => !v)}>
          Problems only
        </button>
      </div>

      <table className="ns-table explorer-table">
        <thead>
          <tr>
            {header("Name", "name")}
            {header("Kind", "kind")}
            {header("Status", "status")}
            {header("Age", "age")}
            <th>Labels</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.uid} onClick={() => onSelect(r.uid)}>
              <td className="cell-name">{r.name}</td>
              <td>
                <span className="knode-badge" style={{ "--accent": GROUP_ACCENT_VAR[KIND_INFO[r.kind].group] } as React.CSSProperties}>
                  {KIND_INFO[r.kind].badge}
                </span>
              </td>
              <td>
                <HealthDot health={r.health} label={r.status} />
              </td>
              <td>{formatAge(r.createdAt)}</td>
              <td className="cell-labels">
                {Object.entries(r.labels)
                  .slice(0, 2)
                  .map(([k, v]) => (
                    <span key={k} className="label-chip">
                      {k}={v}
                    </span>
                  ))}
              </td>
              <td className="cell-action">
                <button
                  className="link-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onShowInGraph(r.uid);
                  }}
                >
                  graph →
                </button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} style={{ color: "var(--muted)" }}>
                Nothing matches.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
