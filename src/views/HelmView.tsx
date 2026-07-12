import { useCallback, useEffect, useMemo, useState } from "react";
import { buildProblemChains } from "../chains";
import { KubectlHint } from "../components/bits";
import { Icon } from "../components/icons";
import { ProblemChainList } from "../components/ProblemChains";
import type {
  ClusterProvider,
  HelmChartHit,
  HelmRelease,
  HelmReleaseDetail,
  HelmRepo,
  HelmStatus,
  NamespaceSnapshot,
} from "../types";
import { formatAge, openExternal } from "../utils";

interface Props {
  provider: ClusterProvider;
  namespace: string;
  management: boolean;
  snapshot: NamespaceSnapshot | null;
  onSelectResource(uid: string): void;
}

function statusClass(status: string): string {
  if (status === "deployed") return "ok";
  if (status === "failed") return "bad";
  if (status.startsWith("pending")) return "attn";
  return "";
}

/** A pending Helm write action, shown in the confirmation dialog. */
interface PendingAction {
  title: string;
  command: string;
  danger: boolean;
  /** Uninstall requires typing the release name. */
  confirmName?: string;
  /** Editable values (install/upgrade). */
  values?: string;
  run(values?: string): Promise<string>;
}

export function HelmView({ provider, namespace, management, snapshot, onSelectResource }: Props) {
  const [status, setStatus] = useState<HelmStatus | null>(null);
  const [tab, setTab] = useState<"releases" | "charts">("releases");
  const [allNs, setAllNs] = useState(false);
  const [releases, setReleases] = useState<HelmRelease[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<HelmRelease | null>(null);
  const [detail, setDetail] = useState<HelmReleaseDetail | null>(null);
  const [detailTab, setDetailTab] = useState<"overview" | "values" | "manifest" | "notes" | "history" | "resources">("overview");
  const [repos, setRepos] = useState<HelmRepo[] | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<HelmChartHit[] | null>(null);
  const [doc, setDoc] = useState<{ title: string; text: string } | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [repoForm, setRepoForm] = useState({ name: "", url: "" });
  // Release values regularly contain credentials - they are FETCHED (not
  // just rendered) only on an explicit click, via a separate IPC call.
  const [values, setValues] = useState<string | null>(null);
  const [valuesLoading, setValuesLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    provider
      .helmStatus()
      .then((s) => !cancelled && setStatus(s))
      .catch((e) => !cancelled && setStatus({ installed: false, detail: String(e) }));
    return () => {
      cancelled = true;
    };
  }, [provider]);

  const loadReleases = useCallback(() => {
    setError(null);
    provider
      .helmReleases(allNs ? undefined : namespace)
      .then(setReleases)
      .catch((e) => {
        setReleases([]);
        setError(String(e));
      });
  }, [provider, namespace, allNs]);

  useEffect(() => {
    if (status?.installed) loadReleases();
  }, [status, loadReleases]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setDetail(null);
    setDetailTab("overview");
    setValues(null);
    provider
      .helmReleaseDetail(selected.namespace, selected.name)
      .then((d) => !cancelled && setDetail(d))
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [provider, selected]);

  const loadValues = () => {
    if (!selected) return;
    setValuesLoading(true);
    provider
      .helmReleaseValues(selected.namespace, selected.name)
      .then(setValues)
      .catch((e) => setValues(`# ${String(e)}`))
      .finally(() => setValuesLoading(false));
  };

  useEffect(() => {
    if (tab !== "charts" || repos !== null) return;
    provider.helmRepos().then(setRepos).catch((e) => {
      setRepos([]);
      setError(String(e));
    });
  }, [tab, repos, provider]);

  // Resources managed by the selected release (Helm's own annotations).
  const related = useMemo(() => {
    if (!selected || !snapshot) return [];
    return snapshot.resources.filter(
      (r) =>
        r.annotations?.["meta.helm.sh/release-name"] === selected.name ||
        (r.labels["app.kubernetes.io/managed-by"] === "Helm" &&
          r.labels["app.kubernetes.io/instance"] === selected.name),
    );
  }, [selected, snapshot]);

  // Troubleshooting: chains touching the release's resources (transitively -
  // pods owned by a managed Deployment count via the chain path itself).
  const relatedChains = useMemo(() => {
    if (!snapshot || related.length === 0) return [];
    const uids = new Set(related.map((r) => r.uid));
    const names = new Set(related.map((r) => `${r.kind}/${r.name}`));
    return buildProblemChains(snapshot.resources).filter((c) =>
      c.chain.some((l) => (l.uid && uids.has(l.uid)) || names.has(`${l.kind}/${l.name}`)),
    );
  }, [snapshot, related]);

  const search = () => {
    setHits(null);
    provider
      .helmSearch(query)
      .then(setHits)
      .catch((e) => {
        setHits([]);
        setError(String(e));
      });
  };

  const showDoc = (title: string, kind: "values" | "readme" | "chart", chart: string) => {
    setDoc({ title, text: "loading…" });
    provider
      .helmShow(kind, chart)
      .then((text) => setDoc({ title, text }))
      .catch((e) => setDoc({ title, text: String(e) }));
  };

  const gate = management ? undefined : "Read-only mode - enable management in the title bar";

  if (status && !status.installed) {
    return (
      <div className="overview wide">
        <h2>Helm</h2>
        <div className="issue-box">
          <p>
            <strong>Helm is not installed on this machine.</strong> The Helm view reads releases and
            charts through your own <code>helm</code> binary - nothing else is required.
          </p>
          <p>
            <button className="link-btn" onClick={() => void openExternal("https://helm.sh/docs/intro/install/")}>
              Install Helm ↗
            </button>{" "}
            then reopen this view.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="overview wide">
      <h2>
        Helm{" "}
        <span className="h2-sub">
          - releases and charts via your own helm binary{status?.version ? ` (${status.version})` : ""} ·{" "}
          {allNs ? "all namespaces" : namespace}
        </span>
      </h2>

      <div className="tab-row">
        <button className={`tab${tab === "releases" ? " active" : ""}`} onClick={() => { setTab("releases"); setSelected(null); }}>
          Releases
        </button>
        <button className={`tab${tab === "charts" ? " active" : ""}`} onClick={() => setTab("charts")}>
          Charts
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {tab === "releases" && !selected && (
        <>
          <div className="graph-toolbar wrap">
            <button className={`chip${allNs ? " on" : ""}`} onClick={() => setAllNs((v) => !v)}>
              all namespaces
            </button>
            <button className="chip" onClick={loadReleases}>
              refresh
            </button>
          </div>
          {releases === null && <p className="about">Reading releases…</p>}
          {releases !== null && (
            <table className="ns-table">
              <thead>
                <tr>
                  <th>Release</th>
                  <th>Namespace</th>
                  <th>Chart</th>
                  <th>App version</th>
                  <th>Status</th>
                  <th>Rev</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {releases.map((r) => (
                  <tr key={`${r.namespace}/${r.name}`} onClick={() => setSelected(r)}>
                    <td className="cell-name">{r.name}</td>
                    <td>{r.namespace}</td>
                    <td>{r.chart}</td>
                    <td>{r.appVersion}</td>
                    <td>
                      <span className={`perm-badge ${statusClass(r.status)}`}>{r.status}</span>
                    </td>
                    <td>{r.revision}</td>
                    <td>{formatAge(r.updated)}</td>
                  </tr>
                ))}
                {releases.length === 0 && (
                  <tr>
                    <td colSpan={7} style={{ color: "var(--muted)" }}>
                      No Helm releases {allNs ? "in this cluster" : `in ${namespace}`}.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
          <KubectlHint label="helm equivalent" command={`helm list ${allNs ? "-A" : `-n ${namespace}`}`} />
        </>
      )}

      {tab === "releases" && selected && (
        <>
          <p>
            <button className="link-btn" onClick={() => setSelected(null)}>
              <Icon name="back" size={11} /> all releases
            </button>
          </p>
          <h3 style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {selected.name}
            <span className={`perm-badge ${statusClass(selected.status)}`}>{selected.status}</span>
            <span className="h2-sub">
              {selected.chart} · rev {selected.revision}
            </span>
          </h3>

          <div className="tab-row">
            {(["overview", "values", "manifest", "notes", "history", "resources"] as const).map((t) => (
              <button key={t} className={`tab${detailTab === t ? " active" : ""}`} onClick={() => setDetailTab(t)}>
                {t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>

          {detailTab === "overview" && (
            <>
              <dl className="kv" style={{ margin: "10px 0" }}>
                <dt>Chart</dt>
                <dd>{selected.chart}</dd>
                <dt>App version</dt>
                <dd>{selected.appVersion}</dd>
                <dt>Revision</dt>
                <dd>{selected.revision}</dd>
                <dt>Updated</dt>
                <dd>{formatAge(selected.updated)} ago</dd>
                <dt>Namespace</dt>
                <dd>{selected.namespace}</dd>
              </dl>
              {relatedChains.length > 0 && (
                <div className="issue-box">
                  <p>
                    ⚠ This release has {relatedChains.length} related problem{" "}
                    {relatedChains.length === 1 ? "chain" : "chains"} - see the Resources tab.
                  </p>
                </div>
              )}
              <div className="log-toolbar">
                <button
                  className="chip"
                  disabled={!management}
                  title={gate}
                  onClick={() =>
                    // Editing an upgrade starts from the release's current
                    // values - fetched here, on the explicit action, never
                    // as part of routine detail loading.
                    void provider
                      .helmReleaseValues(selected.namespace, selected.name)
                      .catch(() => "")
                      .then((current) =>
                        setPending({
                          title: `Upgrade ${selected.name}`,
                          command: `helm upgrade ${selected.name} <chart> -n ${selected.namespace} -f values.yaml`,
                          danger: true,
                          values: current,
                          run: (values) =>
                            provider.helmAction({
                              op: "upgrade",
                              namespace: selected.namespace,
                              release: selected.name,
                              chart: selected.chart.replace(/-\d[\w.+-]*$/, ""),
                              values,
                            }),
                        }),
                      )
                  }
                >
                  upgrade…
                </button>
                <button
                  className="chip"
                  disabled={!management || (detail?.history.length ?? 0) < 2}
                  title={gate ?? "Roll back to the previous revision"}
                  onClick={() => {
                    const prev = detail?.history.filter((h) => h.revision < selected.revision).pop();
                    if (!prev) return;
                    setPending({
                      title: `Rollback ${selected.name} to revision ${prev.revision}`,
                      command: `helm rollback ${selected.name} ${prev.revision} -n ${selected.namespace}`,
                      danger: true,
                      run: () =>
                        provider.helmAction({
                          op: "rollback",
                          namespace: selected.namespace,
                          release: selected.name,
                          revision: prev.revision,
                        }),
                    });
                  }}
                >
                  rollback…
                </button>
                <button
                  className="chip danger"
                  disabled={!management}
                  title={gate}
                  onClick={() =>
                    setPending({
                      title: `Uninstall ${selected.name}`,
                      command: `helm uninstall ${selected.name} -n ${selected.namespace}`,
                      danger: true,
                      confirmName: selected.name,
                      run: () =>
                        provider.helmAction({
                          op: "uninstall",
                          namespace: selected.namespace,
                          release: selected.name,
                        }),
                    })
                  }
                >
                  uninstall…
                </button>
              </div>
              <KubectlHint label="helm equivalent" command={`helm status ${selected.name} -n ${selected.namespace}`} />
            </>
          )}

          {detailTab === "values" && (
            <>
              {values !== null ? (
                <pre className="yaml-pane">{values.trim() === "null" || values.trim() === "" ? "# no user-supplied values" : values}</pre>
              ) : (
                <div className="issue-box">
                  <p>
                    Release values often contain passwords, tokens, and other credentials, so they are not even
                    fetched automatically. Only load them if you are authorized to see this release's configuration.
                  </p>
                  <div className="modal-actions">
                    <button className="btn primary risk-high" disabled={valuesLoading} onClick={loadValues}>
                      {valuesLoading ? "Loading…" : "Show values"}
                    </button>
                  </div>
                </div>
              )}
              <KubectlHint label="helm equivalent" command={`helm get values ${selected.name} -n ${selected.namespace}`} />
            </>
          )}
          {detailTab === "manifest" && (
            <>
              <p className="about">Secret values inside the manifest are masked - key names stay visible.</p>
              <pre className="yaml-pane">{detail ? detail.manifest : "loading…"}</pre>
              <KubectlHint label="helm equivalent" command={`helm get manifest ${selected.name} -n ${selected.namespace}`} />
            </>
          )}
          {detailTab === "notes" && (
            <>
              <pre className="yaml-pane">{detail ? detail.notes || "(no notes)" : "loading…"}</pre>
              <KubectlHint label="helm equivalent" command={`helm get notes ${selected.name} -n ${selected.namespace}`} />
            </>
          )}

          {detailTab === "history" && (
            <>
              <table className="mini-table">
                <thead>
                  <tr>
                    <th>Rev</th>
                    <th>Status</th>
                    <th>Chart</th>
                    <th>Updated</th>
                    <th>Description</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {(detail?.history ?? []).map((h) => (
                    <tr key={h.revision} className={h.revision === selected.revision ? "current-rev" : ""}>
                      <td>{h.revision}</td>
                      <td>
                        <span className={`perm-badge ${statusClass(h.status)}`}>{h.status}</span>
                      </td>
                      <td>{h.chart}</td>
                      <td>{formatAge(h.updated)}</td>
                      <td>{h.description}</td>
                      <td className="cell-action">
                        {h.revision !== selected.revision && (
                          <button
                            className="link-btn"
                            disabled={!management}
                            title={gate}
                            onClick={() =>
                              setPending({
                                title: `Rollback ${selected.name} to revision ${h.revision}`,
                                command: `helm rollback ${selected.name} ${h.revision} -n ${selected.namespace}`,
                                danger: true,
                                run: () =>
                                  provider.helmAction({
                                    op: "rollback",
                                    namespace: selected.namespace,
                                    release: selected.name,
                                    revision: h.revision,
                                  }),
                              })
                            }
                          >
                            rollback →
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <KubectlHint label="helm equivalent" command={`helm history ${selected.name} -n ${selected.namespace}`} />
            </>
          )}

          {detailTab === "resources" && (
            <>
              {related.length === 0 && (
                <p className="about">
                  No resources in the current snapshot carry this release's Helm annotations
                  {snapshot ? "" : " (snapshot still loading)"}.
                </p>
              )}
              {related.map((r) => (
                <button key={r.uid} className="rel-link" onClick={() => onSelectResource(r.uid)}>
                  <span className="knode-badge">{r.kind}</span> {r.name}
                  <span className="status">
                    <span className={`dot health-${r.health}`} />
                    {r.status}
                  </span>
                </button>
              ))}
              {relatedChains.length > 0 && (
                <>
                  <h3>Problems in this release</h3>
                  <ProblemChainList chains={relatedChains} onSelectResource={onSelectResource} />
                </>
              )}
            </>
          )}
        </>
      )}

      {tab === "charts" && (
        <>
          <h3>Repositories</h3>
          {repos === null && <p className="about">Reading repositories…</p>}
          {repos !== null && repos.length === 0 && (
            <p className="about">No Helm repositories configured yet - add one below to browse charts.</p>
          )}
          {(repos ?? []).map((r) => (
            <div key={r.name} className="pf-row">
              <strong>{r.name}</strong>
              <span className="pf-ns">{r.url}</span>
              <span style={{ flex: 1 }} />
              <button
                className="link-btn danger"
                disabled={!management}
                title={gate}
                onClick={() =>
                  setPending({
                    title: `Remove repository ${r.name}`,
                    command: `helm repo remove ${r.name}`,
                    danger: false,
                    run: async () => {
                      const out = await provider.helmRepoModify("remove", r.name);
                      setRepos(null);
                      return out;
                    },
                  })
                }
              >
                remove
              </button>
            </div>
          ))}
          <div className="log-toolbar">
            <input
              className="search-box"
              type="text"
              placeholder="repo name"
              value={repoForm.name}
              onChange={(e) => setRepoForm((f) => ({ ...f, name: e.target.value }))}
            />
            <input
              className="search-box grow"
              type="text"
              placeholder="https://charts.example.com"
              value={repoForm.url}
              onChange={(e) => setRepoForm((f) => ({ ...f, url: e.target.value }))}
            />
            <button
              className="chip"
              disabled={!management || !repoForm.name || !repoForm.url}
              title={gate ?? "Add this repository"}
              onClick={() =>
                setPending({
                  title: `Add repository ${repoForm.name}`,
                  command: `helm repo add ${repoForm.name} ${repoForm.url}`,
                  danger: false,
                  run: async () => {
                    const out = await provider.helmRepoModify("add", repoForm.name, repoForm.url);
                    setRepos(null);
                    setRepoForm({ name: "", url: "" });
                    return out;
                  },
                })
              }
            >
              add repo
            </button>
            <button
              className="chip"
              disabled={!management}
              title={gate ?? "Refresh chart indexes from all repositories"}
              onClick={() =>
                setPending({
                  title: "Update all repositories",
                  command: "helm repo update",
                  danger: false,
                  run: () => provider.helmRepoModify("update"),
                })
              }
            >
              update repos
            </button>
          </div>

          <h3>Charts</h3>
          <div className="log-toolbar">
            <input
              className="search-box grow"
              type="search"
              placeholder="search charts (e.g. nginx, postgresql)…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && search()}
            />
            <button className="chip on" onClick={search}>
              search
            </button>
          </div>
          {hits !== null && (
            <table className="ns-table">
              <thead>
                <tr>
                  <th>Chart</th>
                  <th>Version</th>
                  <th>App version</th>
                  <th>Description</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {hits.map((h) => (
                  <tr key={h.name} style={{ cursor: "default" }}>
                    <td className="cell-name">{h.name}</td>
                    <td>{h.version}</td>
                    <td>{h.appVersion}</td>
                    <td>{h.description}</td>
                    <td className="cell-action">
                      <button className="link-btn" onClick={() => showDoc(`${h.name} - default values`, "values", h.name)}>
                        values
                      </button>{" "}
                      <button className="link-btn" onClick={() => showDoc(`${h.name} - README`, "readme", h.name)}>
                        readme
                      </button>{" "}
                      <button
                        className="link-btn"
                        title="Copy the install command"
                        onClick={() =>
                          void navigator.clipboard.writeText(
                            `helm install my-${h.name.split("/").pop()} ${h.name} -n ${namespace}`,
                          )
                        }
                      >
                        copy install
                      </button>{" "}
                      <button
                        className="link-btn"
                        disabled={!management}
                        title={gate}
                        onClick={() =>
                          setPending({
                            title: `Install ${h.name}`,
                            command: `helm install my-${h.name.split("/").pop()} ${h.name} -n ${namespace} -f values.yaml`,
                            danger: true,
                            values: "",
                            run: (values) =>
                              provider.helmAction({
                                op: "install",
                                namespace,
                                release: `my-${h.name.split("/").pop()}`,
                                chart: h.name,
                                values: values || undefined,
                              }),
                          })
                        }
                      >
                        install…
                      </button>
                    </td>
                  </tr>
                ))}
                {hits.length === 0 && (
                  <tr>
                    <td colSpan={5} style={{ color: "var(--muted)" }}>
                      No charts matched{repos?.length === 0 ? " - add a repository first" : ""}.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
          {doc && (
            <>
              <h3 style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {doc.title}
                <button className="link-btn" onClick={() => setDoc(null)}>
                  close
                </button>
              </h3>
              <pre className="yaml-pane">{doc.text}</pre>
            </>
          )}
          <KubectlHint label="helm equivalent" command={`helm search repo ${query || "<chart>"}`} />
        </>
      )}

      {pending && (
        <HelmActionDialog pending={pending} management={management} onClose={() => setPending(null)} onDone={loadReleases} />
      )}
    </div>
  );
}

/** Confirmation dialog for every mutating Helm operation: full command shown,
 *  optional values editor, name-typing for uninstall, management-gated. */
function HelmActionDialog({
  pending,
  management,
  onClose,
  onDone,
}: {
  pending: PendingAction;
  management: boolean;
  onClose(): void;
  onDone(): void;
}) {
  const [values, setValues] = useState(pending.values ?? "");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const canRun =
    management && !busy && !result?.ok && (!pending.confirmName || typed === pending.confirmName);

  const run = async () => {
    setBusy(true);
    try {
      const out = await pending.run(pending.values !== undefined ? values : undefined);
      setResult({ ok: true, message: out.trim() || "Done." });
      onDone();
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
          <h2>{pending.title}</h2>
          {pending.danger && <span className="risk-badge risk-high">high</span>}
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" size={13} />
          </button>
        </div>

        {pending.values !== undefined && (
          <>
            <h3>Values (YAML)</h3>
            <textarea
              className="yaml-edit"
              spellCheck={false}
              value={values}
              placeholder="# optional values.yaml overrides"
              onChange={(e) => setValues(e.target.value)}
            />
          </>
        )}

        <KubectlHint label="helm equivalent" command={pending.command} />

        {pending.confirmName && !result?.ok && (
          <label className="modal-input confirm-name">
            <span>
              This removes the release and its resources. Type <strong>{pending.confirmName}</strong> to
              confirm:
            </span>
            <input type="text" value={typed} placeholder={pending.confirmName} onChange={(e) => setTyped(e.target.value)} />
          </label>
        )}

        {result && <div className={result.ok ? "result-banner ok" : "error-banner"}>{result.message}</div>}

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            {result?.ok ? "Close" : "Cancel"}
          </button>
          {!result?.ok && (
            <button className={`btn primary${pending.danger ? " risk-high" : ""}`} disabled={!canRun} onClick={() => void run()}>
              {busy ? "Working…" : "Run"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
