import { useCallback, useEffect, useRef, useState } from "react";
import { DetailsPanel } from "./components/DetailsPanel";
import { GraphView } from "./components/GraphView";
import { OverviewPanel } from "./components/OverviewPanel";
import { Sidebar, type View } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { Welcome } from "./components/Welcome";
import { DEMO_DEFAULT_NAMESPACE, DemoProvider } from "./providers/demo";
import { inTauri, TauriProvider } from "./providers/tauri";
import type {
  ClusterInfo,
  ClusterOverview,
  ClusterProvider,
  ContextInfo,
  NamespaceSnapshot,
} from "./types";
import { applyTheme, initialTheme, type Theme } from "./utils";

const POLL_MS = 4000;

export default function App() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [provider, setProvider] = useState<ClusterProvider | null>(null);
  const [cluster, setCluster] = useState<ClusterInfo | null>(null);
  const [overview, setOverview] = useState<ClusterOverview | null>(null);
  const [snapshot, setSnapshot] = useState<NamespaceSnapshot | null>(null);
  const [view, setView] = useState<View>({ type: "overview" });
  const [selectedUid, setSelectedUid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Welcome-screen state
  const [contexts, setContexts] = useState<ContextInfo[] | null>(null);
  const [contextsError, setContextsError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);

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
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Read kubeconfig contexts for the welcome screen (desktop shell only).
  useEffect(() => {
    if (!inTauri()) {
      setContexts([]);
      return;
    }
    new TauriProvider()
      .listContexts()
      .then(setContexts)
      .catch((e) => {
        setContexts([]);
        setContextsError(String(e));
      });
  }, []);

  const connect = useCallback(async (prov: ClusterProvider, context?: string) => {
    setConnecting(context ?? "demo");
    setError(null);
    try {
      const info = await prov.connect(context);
      const first = await prov.getOverview();
      setProvider(prov);
      setCluster(info);
      setOverview(first);
      // Land newcomers straight on the richest demo graph; live users on overview.
      setView(prov.mode === "demo" ? { type: "namespace", name: DEMO_DEFAULT_NAMESPACE } : { type: "overview" });
      setSelectedUid(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setConnecting(null);
    }
  }, []);

  const disconnect = useCallback(() => {
    void provider?.disconnect();
    setProvider(null);
    setCluster(null);
    setOverview(null);
    setSnapshot(null);
    setSelectedUid(null);
    setError(null);
    setView({ type: "overview" });
  }, [provider]);

  // Poll the data the current view needs (overview is also kept fresh for the
  // sidebar's namespace list).
  const busy = useRef(false);
  const refresh = useCallback(async () => {
    if (!provider || busy.current) return;
    busy.current = true;
    try {
      setOverview(await provider.getOverview());
      if (view.type === "namespace") {
        setSnapshot(await provider.getSnapshot(view.name));
      }
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      busy.current = false;
    }
  }, [provider, view]);

  useEffect(() => {
    if (!provider) return;
    setSnapshot(null);
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [provider, refresh]);

  if (!provider) {
    return (
      <div className="app">
        <TopBar
          cluster={null}
          mode={null}
          connected={false}
          theme={theme}
          onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
          onRefresh={() => {}}
        />
        <div style={{ minHeight: 0, overflowY: "auto" }}>
          {error && <div className="error-banner">{error}</div>}
          <Welcome
            contexts={contexts}
            contextsError={contextsError}
            inTauriShell={inTauri()}
            connecting={connecting}
            onConnect={(ctx) => void connect(new TauriProvider(), ctx)}
            onDemo={() => void connect(new DemoProvider())}
          />
        </div>
      </div>
    );
  }

  const selected =
    (selectedUid && snapshot?.resources.find((r) => r.uid === selectedUid)) || null;

  return (
    <div className="app">
      <TopBar
        cluster={cluster}
        mode={provider.mode}
        connected={error === null}
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
        onRefresh={() => void refresh()}
      />
      <div className="app-body">
        <Sidebar
          overview={overview}
          view={view}
          mode={provider.mode}
          onNavigate={(v) => {
            setView(v);
            setSelectedUid(null);
          }}
          onSwitchCluster={disconnect}
        />
        <main className="main">
          {error && <div className="error-banner">{error}</div>}
          {view.type === "overview" && overview && (
            <OverviewPanel
              overview={overview}
              onOpenNamespace={(name) => setView({ type: "namespace", name })}
            />
          )}
          {view.type === "namespace" &&
            (snapshot ? (
              <GraphView snapshot={snapshot} selectedUid={selectedUid} onSelect={setSelectedUid} />
            ) : (
              !error && <div className="graph-empty">Loading {view.name}…</div>
            ))}
        </main>
        {selected && <DetailsPanel resource={selected} onClose={() => setSelectedUid(null)} />}
      </div>
    </div>
  );
}
