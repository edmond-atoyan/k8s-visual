import { invoke } from "@tauri-apps/api/core";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActionDescriptor } from "./actions";
import { actionsFor, setKubectlContext } from "./actions";
import { askAiCommand, buildResourceSummary, detectAiTools, type AiToolId, type AiToolStatus } from "./ai";
import { ActionModal } from "./components/ActionModal";
import { DetailsPanel } from "./components/DetailsPanel";
import { Sidebar, type ViewId } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { TopBar } from "./components/TopBar";

// Heavy (xterm) and optional - only loaded when the user opens the terminal.
const TerminalPanel = lazy(() => import("./components/TerminalPanel"));
const Assistant = lazy(() => import("./components/Assistant"));
import { Welcome } from "./components/Welcome";
import { buildProblemChains } from "./chains";
import { buildGraph } from "./graph/build";
import { clusterPrefs } from "./prefs";
import { DEMO_DEFAULT_NAMESPACE, DemoProvider } from "./providers/demo";
import { inTauri, TauriProvider } from "./providers/tauri";
import type {
  ClusterInfo,
  ClusterOverview,
  ClusterProvider,
  ContextInfo,
  NamespaceSnapshot,
  ResourceSummary,
} from "./types";
import { applyTheme, initialTheme, type Theme } from "./utils";
import { AccessView } from "./views/AccessView";
import { ApplyYamlView } from "./views/ApplyYamlView";
import { ConfigSecretsView } from "./views/ConfigSecretsView";
import { EventsView } from "./views/EventsView";
import { ExplorerView } from "./views/ExplorerView";
import { GraphView } from "./views/GraphView";
import { HelmView } from "./views/HelmView";
import { LogsView } from "./views/LogsView";
import { MetricsView, newMetricsHistory } from "./views/MetricsView";
import { NetworkingView } from "./views/NetworkingView";
import { NodesView } from "./views/NodesView";
import { OverviewView } from "./views/OverviewView";
import { StorageView } from "./views/StorageView";

const POLL_MS = 4000;

/** Views that render the currently selected namespace's snapshot. */
const NAMESPACED_VIEWS: ViewId[] = [
  "graph",
  "explorer",
  "networking",
  "storage",
  "config",
  "events",
  "logs",
  "metrics",
  "helm",
];

export default function App() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [provider, setProvider] = useState<ClusterProvider | null>(null);
  const [cluster, setCluster] = useState<ClusterInfo | null>(null);
  const [overview, setOverview] = useState<ClusterOverview | null>(null);
  const [namespace, setNamespace] = useState<string>("default");
  const [snapshot, setSnapshot] = useState<NamespaceSnapshot | null>(null);
  const [view, setView] = useState<ViewId>("overview");
  const [selectedUid, setSelectedUid] = useState<string | null>(null);
  const [management, setManagement] = useState(false);
  const [modal, setModal] = useState<{ resource: ResourceSummary; descriptor: ActionDescriptor } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pendingSelect = useRef<{ kind: string; name: string } | null>(null);
  const metricsHistory = useRef(newMetricsHistory());

  // Integrated terminal: mounted on first open so the shell session survives
  // hiding the drawer; commands from quick actions are typed, never executed.
  const [termMounted, setTermMounted] = useState(false);
  const [termVisible, setTermVisible] = useState(false);
  const [termInput, setTermInput] = useState<string | null>(null);
  const [termHint, setTermHint] = useState<AiToolId | null>(null);
  const [aiTools, setAiTools] = useState<AiToolStatus[] | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const toggleTerminal = useCallback(() => {
    setTermMounted(true);
    setTermVisible((v) => !v);
  }, []);
  const openTerminalWith = useCallback((input: string | null) => {
    setTermMounted(true);
    setTermVisible(true);
    if (input !== null) setTermInput(input);
  }, []);
  useEffect(() => {
    void detectAiTools().then(setAiTools);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "`") {
        e.preventDefault();
        toggleTerminal();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleTerminal]);

  // Welcome-screen state
  const [contexts, setContexts] = useState<ContextInfo[] | null>(null);
  const [contextsError, setContextsError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  /** True while the connect screen is shown over a still-live session. */
  const [switching, setSwitching] = useState(false);

  useEffect(() => applyTheme(theme), [theme]);

  // ?demo deep-links straight into the sample cluster (used by docs/screenshots).
  const autoDemo = useRef(false);
  useEffect(() => {
    if (autoDemo.current) return;
    autoDemo.current = true;
    const params = new URLSearchParams(window.location.search);
    if (params.has("demo")) {
      void connect(new DemoProvider()).then(() => {
        const select = params.get("select");
        if (select) setSelectedUid(select);
        const viewParam = params.get("view");
        if (viewParam) setView(viewParam as ViewId);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Read kubeconfig contexts for the welcome screen (desktop shell only).
  // Re-read whenever the connect screen opens: cloud imports and external
  // kubectl usage add contexts while the app runs.
  useEffect(() => {
    if (!inTauri()) {
      // Docs/screenshot stand-in for a populated kubeconfig (browser only).
      setContexts(
        new URLSearchParams(window.location.search).has("ctxmock")
          ? [
              { name: "arn:aws:eks:eu-central-1:123456789012:cluster/devopshub-eks", cluster: "devopshub-eks", user: "aws", current: false },
              { name: "staging-aks", cluster: "staging-aks", user: "clusterUser", current: false },
              { name: "gke_shop-project_europe-west1_prod-gke", cluster: "prod-gke", user: "gke", current: false },
              { name: "minikube", cluster: "minikube", user: "minikube", current: false },
              { name: "kind-dev", cluster: "kind-dev", user: "kind-dev", current: false },
              { name: "default", cluster: "default", user: "default", current: true },
            ]
          : [],
      );
      return;
    }
    if (provider && !switching) return;
    new TauriProvider()
      .listContexts()
      .then(setContexts)
      .catch((e) => {
        setContexts([]);
        setContextsError(String(e));
      });
  }, [provider, switching]);

  const connect = useCallback(async (prov: ClusterProvider, context?: string) => {
    setConnecting(context ?? "demo");
    setError(null);
    // Invalidate every in-flight poll: a response started against the old
    // cluster must never be written into the new cluster's state.
    pollGen.current++;
    let backendConnected = false;
    try {
      // Leaving a still-connected cluster (switch flow): close it first.
      if (providerRef.current && providerRef.current !== prov) {
        await providerRef.current.disconnect().catch(() => {});
      }
      const info = await prov.connect(context);
      backendConnected = true;
      const first = await prov.getOverview();
      setProvider(prov);
      setCluster(info);
      setOverview(first);
      setSwitching(false);
      setManagement(false); // every session starts read-only
      // Every kubectl hint from now on carries --context for this cluster.
      setKubectlContext(prov.mode === "demo" ? null : info.context);
      metricsHistory.current = newMetricsHistory();
      const prefKey = prov.mode === "demo" ? "demo" : info.context;
      clusterPrefs.setLastContext(prefKey);
      if (prov.mode === "demo") {
        setNamespace(clusterPrefs.namespaceFor(prefKey) ?? DEMO_DEFAULT_NAMESPACE);
        setView("graph"); // land newcomers on the richest demo graph
      } else {
        const names = first.namespaces.map((n) => n.name);
        const remembered = clusterPrefs.namespaceFor(prefKey);
        setNamespace(
          remembered && names.includes(remembered)
            ? remembered
            : names.includes("default")
              ? "default"
              : (names[0] ?? "default"),
        );
        setView("overview");
      }
      setSelectedUid(null);
    } catch (e) {
      setError(String(e));
      if (backendConnected) {
        // The backend is already on the NEW cluster but the UI never adopted
        // it. Leaving things as-is would show one cluster while every call
        // hits another - disconnect so both sides agree on "no session".
        await prov.disconnect().catch(() => {});
        setProvider(null);
        setCluster(null);
        setOverview(null);
        setSnapshot(null);
        setKubectlContext(null);
      }
    } finally {
      setConnecting(null);
    }
  }, []);

  // Keep a live handle on the provider for the switch flow (the connect
  // callback must not capture a stale provider).
  const providerRef = useRef<ClusterProvider | null>(null);
  providerRef.current = provider;

  // Mirror the management toggle into the backend: mutating IPC commands
  // check it there, so read-only mode never depends on React state alone.
  useEffect(() => {
    if (provider && provider.mode !== "demo" && inTauri()) {
      void invoke("set_management", { on: management }).catch(() => {});
    }
  }, [management, provider]);

  /** Change namespace and remember it for this cluster. */
  const changeNamespace = (ns: string) => {
    setNamespace(ns);
    const key = provider?.mode === "demo" ? "demo" : cluster?.context;
    if (key) clusterPrefs.setNamespace(key, ns);
  };

  // Startup reconciliation: the kubeconfig current-context moved under us
  // since the last session. Never auto-switch - ask.
  const [reconcileDismissed, setReconcileDismissed] = useState(false);
  const reconcile = useMemo(() => {
    if (provider || reconcileDismissed || !contexts) return undefined;
    const last = clusterPrefs.lastContext();
    if (!last || last === "demo" || !contexts.some((c) => c.name === last)) return undefined;
    const current = contexts.find((c) => c.current)?.name;
    if (!current || current === last) return undefined;
    return {
      previous: last,
      current,
      onPrevious: () => void connect(new TauriProvider(), last),
      onCurrent: () => void connect(new TauriProvider(), current),
      onDismiss: () => setReconcileDismissed(true),
    };
  }, [provider, reconcileDismissed, contexts, connect]);

  // Poll overview + the selected namespace's snapshot. Identical results are
  // dropped before setState so an idle cluster causes zero re-renders (and
  // therefore zero visible repaint) between polls. Every response is guarded
  // by a generation counter: a request that started against an old cluster
  // or namespace resolves late and must be discarded, never rendered.
  const busy = useRef(false);
  const pollGen = useRef(0);
  const lastOverview = useRef("");
  const lastSnapshot = useRef("");
  const refresh = useCallback(async (gen?: number) => {
    const myGen = gen ?? pollGen.current;
    if (!provider || busy.current) return;
    busy.current = true;
    try {
      const ov = await provider.getOverview();
      if (pollGen.current !== myGen) return;
      const ovJson = JSON.stringify(ov);
      if (ovJson !== lastOverview.current) {
        lastOverview.current = ovJson;
        setOverview(ov);
      }
      const snap = await provider.getSnapshot(namespace);
      if (pollGen.current !== myGen) return;
      const snapJson = JSON.stringify(snap);
      if (snapJson !== lastSnapshot.current) {
        lastSnapshot.current = snapJson;
        setSnapshot(snap);
      }
      if (pendingSelect.current) {
        const target = snap.resources.find(
          (r) => r.kind === pendingSelect.current!.kind && r.name === pendingSelect.current!.name,
        );
        if (target) setSelectedUid(target.uid);
        pendingSelect.current = null;
      }
      setError(null);
    } catch (e) {
      if (pollGen.current === myGen) setError(String(e));
    } finally {
      busy.current = false;
    }
  }, [provider, namespace]);

  useEffect(() => {
    if (!provider) return;
    setSnapshot(null);
    lastOverview.current = "";
    lastSnapshot.current = "";
    const gen = ++pollGen.current;
    void refresh(gen);
    const timer = setInterval(() => void refresh(gen), POLL_MS);
    return () => clearInterval(timer);
  }, [provider, refresh]);

  // Escape closes the action modal, then the details panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setModal((m) => {
        if (m) return null;
        setSelectedUid(null);
        return m;
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Diagnostics (e.g. "Service has no endpoints") for the details panel.
  const issuesByUid = useMemo(
    () => (snapshot ? buildGraph(snapshot.resources).issues : new Map<string, string[]>()),
    [snapshot],
  );

  // Problem chains from live state (event evidence is added on the Events
  // page, which fetches events itself).
  const allChains = useMemo(() => (snapshot ? buildProblemChains(snapshot.resources) : []), [snapshot]);
  const chainsFor = (uid: string) =>
    allChains.filter((c) => c.affected.uid === uid || c.chain.some((l) => l.uid === uid));

  if (!provider || switching) {
    return (
      <div className="app">
        <TopBar
          cluster={null}
          management={false}
          namespaces={[]}
          namespace=""
          showNamespace={false}
          theme={theme}
          onNamespace={() => {}}
          onToggleManagement={() => {}}
          onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
          onRefresh={() => {}}
        />
        <div className="main">
          {error && <div className="error-banner">{error}</div>}
          <Welcome
            contexts={contexts}
            contextsError={contextsError}
            inTauriShell={inTauri()}
            connecting={connecting}
            activeContext={provider ? (provider.mode === "demo" ? "demo" : cluster?.context) : undefined}
            reconcile={reconcile}
            onBack={
              provider && cluster
                ? { label: provider.mode === "demo" ? "demo cluster" : cluster.context, go: () => setSwitching(false) }
                : undefined
            }
            onConnect={(ctx) => void connect(new TauriProvider(), ctx)}
            onDemo={() => void connect(new DemoProvider())}
          />
        </div>
      </div>
    );
  }

  const selected =
    (selectedUid &&
      (snapshot?.resources.find((r) => r.uid === selectedUid) ??
        // Ghost nodes only exist in the built graph, not the snapshot.
        (snapshot && buildGraph(snapshot.resources).resources.find((r) => r.uid === selectedUid)))) ||
    null;

  const selectByUid = (uid: string) => setSelectedUid(uid);
  const openAction = (resource: ResourceSummary, descriptor: ActionDescriptor) =>
    setModal({ resource, descriptor });

  const namespacedLoading = NAMESPACED_VIEWS.includes(view) && !snapshot;

  return (
    <div className="app">
      <TopBar
        cluster={cluster}
        management={management}
        namespaces={(overview?.namespaces ?? []).map((n) => n.name)}
        namespace={namespace}
        showNamespace={view !== "overview" && view !== "nodes"}
        theme={theme}
        onNamespace={(ns) => {
          changeNamespace(ns);
          setSelectedUid(null);
        }}
        onToggleManagement={() => setManagement((v) => !v)}
        onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
        onToggleTerminal={toggleTerminal}
        onToggleAssistant={() => setAssistantOpen(true)}
        onRefresh={() => void refresh()}
      />
      <div className="app-body">
        <Sidebar
          view={view}
          cluster={cluster}
          management={management}
          onNavigate={(v) => {
            setView(v);
            setSelectedUid(null);
          }}
          onSwitchCluster={() => setSwitching(true)}
        />
        <div className="center-col">
        <main className="main">
          {error && <div className="error-banner">{error}</div>}
          {snapshot && (snapshot.warnings?.length ?? 0) > 0 && NAMESPACED_VIEWS.includes(view) && (
            <div className="error-banner">
              Partial view - some kinds could not be listed. {snapshot.warnings!.join(" · ")}
            </div>
          )}

          {view === "overview" && overview && (
            <OverviewView
              overview={overview}
              onOpenNamespace={(name) => {
                changeNamespace(name);
                setView("graph");
              }}
              onOpenNodes={() => setView("nodes")}
              onOpenEvents={() => setView("events")}
            />
          )}

          {namespacedLoading && !error && <div className="graph-empty">Loading {namespace}…</div>}

          {view === "graph" && snapshot && (
            <GraphView snapshot={snapshot} selectedUid={selectedUid} onSelect={setSelectedUid} />
          )}
          {view === "explorer" && snapshot && (
            <ExplorerView
              snapshot={snapshot}
              onSelect={selectByUid}
              onShowInGraph={(uid) => {
                setView("graph");
                setSelectedUid(uid);
              }}
            />
          )}
          {view === "networking" && snapshot && (
            <NetworkingView provider={provider} snapshot={snapshot} onSelect={selectByUid} />
          )}
          {view === "storage" && snapshot && <StorageView snapshot={snapshot} onSelect={selectByUid} />}
          {view === "config" && snapshot && (
            <ConfigSecretsView provider={provider} snapshot={snapshot} onSelect={selectByUid} />
          )}
          {view === "nodes" && (
            <NodesView
              provider={provider}
              namespace={namespace}
              management={management}
              nodeActions={actionsFor}
              onAction={openAction}
              onSelectPod={(ns, name) => {
                if (ns !== namespace) {
                  changeNamespace(ns);
                  pendingSelect.current = { kind: "Pod", name };
                } else {
                  pendingSelect.current = { kind: "Pod", name };
                  void refresh();
                }
                setView("graph");
              }}
            />
          )}
          {view === "events" && snapshot && (
            <EventsView
              provider={provider}
              namespace={namespace}
              snapshot={snapshot}
              onSelectResource={selectByUid}
            />
          )}
          {view === "logs" && snapshot && <LogsView provider={provider} snapshot={snapshot} />}
          {view === "metrics" && snapshot && overview && (
            <MetricsView
              provider={provider}
              namespace={namespace}
              snapshot={snapshot}
              overview={overview}
              history={metricsHistory.current}
            />
          )}
          {view === "access" && <AccessView provider={provider} namespace={namespace} />}
          {view === "helm" && (
            <HelmView
              provider={provider}
              namespace={namespace}
              management={management}
              snapshot={snapshot}
              onSelectResource={selectByUid}
            />
          )}
          {view === "apply" && (
            <ApplyYamlView provider={provider} namespace={namespace} management={management} />
          )}
        </main>

        {termMounted && cluster && (
          <Suspense fallback={null}>
            <TerminalPanel
              visible={termVisible}
              cluster={cluster}
              mode={provider.mode}
              namespace={namespace}
              management={management}
              theme={theme}
              aiTools={aiTools}
              pendingInput={termInput}
              pendingHint={termHint}
              onConsumedInput={() => setTermInput(null)}
              onConsumedHint={() => setTermHint(null)}
              onClose={() => setTermVisible(false)}
            />
          </Suspense>
        )}
        </div>

        {selected && snapshot && cluster && (
          <DetailsPanel
            provider={provider}
            cluster={cluster}
            snapshot={snapshot}
            resource={selected}
            management={management}
            issues={issuesByUid.get(selected.uid) ?? []}
            chains={chainsFor(selected.uid)}
            terminal={{
              tools: aiTools,
              assistant: () => setAssistantOpen(true),
              open: () => openTerminalWith(null),
              ask: (tool, r, issues) => {
                if (aiTools?.find((t) => t.id === tool)?.installed) {
                  openTerminalWith(askAiCommand(tool, buildResourceSummary(r, issues)));
                } else {
                  // point at install instructions instead of a shell error
                  openTerminalWith(null);
                  setTermHint(tool);
                }
              },
              copySummary: (r, issues) =>
                void navigator.clipboard.writeText(buildResourceSummary(r, issues)),
            }}
            onSelectResource={selectByUid}
            onAction={openAction}
            onClose={() => setSelectedUid(null)}
          />
        )}
      </div>

      {cluster && (
        <StatusBar
          mode={provider.mode}
          management={management}
          connected={error === null}
          cluster={cluster}
          namespace={namespace}
          resourceCount={snapshot?.resources.length ?? null}
          overview={overview}
          onToggleManagement={() => setManagement((v) => !v)}
        />
      )}

      {assistantOpen && cluster && provider && snapshot && (
        <Suspense fallback={null}>
          <Assistant
            cluster={cluster}
            mode={provider.mode}
            namespace={namespace}
            resources={snapshot.resources}
            chains={allChains}
            selected={selected}
            selectedIssues={selected ? (issuesByUid.get(selected.uid) ?? []) : []}
            aiTools={aiTools}
            onSelectResource={(uid) => setSelectedUid(uid)}
            onHandOff={(command) => openTerminalWith(command)}
            onInstallHint={(tool) => {
              openTerminalWith(null);
              setTermHint(tool);
            }}
            onClose={() => setAssistantOpen(false)}
          />
        </Suspense>
      )}

      {modal && cluster && (
        <ActionModal
          provider={provider}
          cluster={cluster}
          resource={modal.resource}
          descriptor={modal.descriptor}
          onClose={() => setModal(null)}
          onDone={() => void refresh()}
        />
      )}
    </div>
  );
}
