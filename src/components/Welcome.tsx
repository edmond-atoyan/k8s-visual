import { useState } from "react";
import { clusterPrefs } from "../prefs";
import { cloudApi } from "../providers/cloud";
import type { CloudKind, ContextInfo } from "../types";
import { providerBadge } from "../utils";
import { CLOUD_PROVIDERS, CloudConnectPanel } from "./CloudConnect";
import { CloudLogo, Icon } from "./icons";
import { Logo } from "./TopBar";

interface Props {
  /** Contexts found in the kubeconfig; null while loading, [] if none/unavailable. */
  contexts: ContextInfo[] | null;
  contextsError: string | null;
  inTauriShell: boolean;
  connecting: string | null;
  /** Context of the app's live connection ("demo" for the demo cluster), if any. */
  activeContext?: string;
  /** Set while a cluster is still connected (switching): back returns to it. */
  onBack?: { label: string; go(): void };
  /** Startup mismatch between the app's last context and kubeconfig current-context. */
  reconcile?: {
    previous: string;
    current: string;
    onPrevious(): void;
    onCurrent(): void;
    onDismiss(): void;
  };
  onConnect(context: string): void;
  onDemo(): void;
}

/**
 * The connect screen and multi-cluster switcher: every kubeconfig context
 * (cloud and local) in one list with provider badges, remembered namespaces
 * and app-side hiding - plus cloud import and the demo cluster.
 */
export function Welcome({
  contexts,
  contextsError,
  inTauriShell,
  connecting,
  activeContext,
  onBack,
  reconcile,
  onConnect,
  onDemo,
}: Props) {
  const [cloudKind, setCloudKind] = useState<CloudKind | null>(null);
  const [hiddenList, setHiddenList] = useState<string[]>(clusterPrefs.hidden());
  const [showHidden, setShowHidden] = useState(false);
  const cloud = cloudApi();
  const lastContext = clusterPrefs.lastContext();

  const hide = (name: string) => {
    clusterPrefs.hide(name);
    setHiddenList(clusterPrefs.hidden());
  };
  const unhide = (name: string) => {
    clusterPrefs.unhide(name);
    setHiddenList(clusterPrefs.hidden());
  };

  const all = contexts ?? [];
  const visible = all.filter((c) => !hiddenList.includes(c.name));
  const hiddenCtxs = all.filter((c) => hiddenList.includes(c.name));

  const contextRow = (ctx: ContextInfo, isHidden: boolean) => {
    const badge = providerBadge(ctx.name, "");
    const remembered = clusterPrefs.namespaceFor(ctx.name);
    const isActive = activeContext === ctx.name;
    return (
      <div className="context-row" key={ctx.name}>
        <button
          className="context-btn"
          disabled={connecting !== null}
          onClick={() => onConnect(ctx.name)}
        >
          <span className="cloud-tag">{badge.text}</span>
          <strong>{connecting === ctx.name ? "Connecting…" : ctx.name}</strong>
          {badge.detail && <span className="ctx-detail">{badge.detail}</span>}
          {isActive && <span className="perm-badge allowed">connected</span>}
          {!isActive && ctx.current && <span className="role-tag">kubeconfig current</span>}
          {!isActive && !ctx.current && lastContext === ctx.name && (
            <span className="role-tag">last session</span>
          )}
          <span className="who">{remembered ? `ns: ${remembered}` : ctx.cluster}</span>
        </button>
        <button
          className="ctx-hide"
          title={
            isHidden
              ? "Show this context in the list again"
              : "Hide from this list only - your kubeconfig and the cluster itself are not touched"
          }
          aria-label={`${isHidden ? "Restore" : "Hide"} ${ctx.name}`}
          onClick={() => (isHidden ? unhide(ctx.name) : hide(ctx.name))}
        >
          <Icon name={isHidden ? "plus" : "close"} size={11} />
        </button>
      </div>
    );
  };

  return (
    <div className="welcome">
      {onBack && (
        <button className="welcome-back" onClick={onBack.go} title={`Back to ${onBack.label}`}>
          <Icon name="back" size={14} />
          Back to {onBack.label}
        </button>
      )}
      <div className="inner">
        <Logo size={44} />
        <h1>K8s Visual</h1>
        <p className="tagline">
          See your cluster as a living diagram - explore the topology, read logs and events, debug
          failing Pods, and manage workloads through safe, confirmed actions. The app always starts
          read-only.
        </p>

        {reconcile && (
          <div className="welcome-card recon-card">
            <h2>Context changed since last session</h2>
            <p className="hint">
              Your terminal's current kubeconfig context is different from the cluster this app was
              last connected to. Nothing has been switched.
            </p>
            <dl className="kv recon-kv">
              <dt>Previous app context</dt>
              <dd>{reconcile.previous}</dd>
              <dt>Current kubeconfig context</dt>
              <dd>{reconcile.current}</dd>
            </dl>
            <div className="recon-actions">
              <button className="btn primary" disabled={connecting !== null} onClick={reconcile.onPrevious}>
                Continue with previous
              </button>
              <button className="btn" disabled={connecting !== null} onClick={reconcile.onCurrent}>
                Use kubeconfig current
              </button>
              <button className="btn" onClick={reconcile.onDismiss}>
                Pick manually
              </button>
            </div>
          </div>
        )}

        <div className="welcome-card">
          <h2>Your clusters</h2>
          {!inTauriShell && all.length === 0 && (
            <p className="hint">
              Running in a plain browser - live cluster access needs the desktop app. Try the demo
              below.
            </p>
          )}
          {inTauriShell && contexts === null && !contextsError && <p className="hint">Reading kubeconfig…</p>}
          {inTauriShell && contextsError && (
            <p className="hint">
              {contextsError} - is there a kubeconfig at <code>~/.kube/config</code> (or{" "}
              <code>$KUBECONFIG</code>)?
            </p>
          )}
          {inTauriShell && contexts && contexts.length === 0 && !contextsError && (
            <p className="hint">
              No contexts found in your kubeconfig. Local clusters (minikube, k3s, kind) and manually
              configured clusters appear here; managed clusters can be imported below.
            </p>
          )}
          {visible.map((ctx) => contextRow(ctx, false))}
          {hiddenCtxs.length > 0 && (
            <p className="hint">
              <button className="link-btn" onClick={() => setShowHidden((v) => !v)}>
                {showHidden ? "collapse hidden" : `show ${hiddenCtxs.length} hidden`}
              </button>{" "}
              - hiding only affects this list, never the kubeconfig or the cluster.
            </p>
          )}
          {showHidden && hiddenCtxs.map((ctx) => contextRow(ctx, true))}
        </div>

        <div className="welcome-card">
          <h2>Managed cloud cluster</h2>
          <p className="hint">
            Import credentials for an existing EKS, AKS, or GKE cluster using your already
            authenticated cloud CLI. The app never asks for or stores cloud secrets.
          </p>
          <div className="cloud-cards">
            {CLOUD_PROVIDERS.map((p) => (
              <button
                key={p.kind}
                className={`cloud-card${cloudKind === p.kind ? " active" : ""}`}
                disabled={cloud === null || connecting !== null}
                title={cloud === null ? "Cloud connect needs the desktop app" : undefined}
                onClick={() => setCloudKind((k) => (k === p.kind ? null : p.kind))}
              >
                <span className="cloud-logo" aria-hidden>
                  <CloudLogo kind={p.kind} size={18} />
                </span>
                <span className="name">{p.name}</span>
                <span className="req">{p.requires}</span>
              </button>
            ))}
          </div>
          {cloud === null && (
            <p className="hint">Cloud connect shells out to aws / az / gcloud, so it needs the desktop app.</p>
          )}
          {cloudKind && cloud && (
            <CloudConnectPanel
              key={cloudKind}
              meta={CLOUD_PROVIDERS.find((p) => p.kind === cloudKind)!}
              api={cloud}
              connecting={connecting !== null}
              onConnect={onConnect}
              onCancel={() => setCloudKind(null)}
            />
          )}
        </div>

        <div className="welcome-card">
          <h2>New to Kubernetes?</h2>
          <p className="hint">
            Explore a realistic sample cluster - no setup, no cluster needed. It includes a healthy
            app, a crash-looping Pod, and a rollback-ready old revision to poke at.
          </p>
          <p style={{ marginTop: 10, marginBottom: 2 }}>
            <button className="primary-btn" onClick={onDemo}>
              Explore the demo cluster
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}
