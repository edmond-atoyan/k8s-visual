import { useState } from "react";
import { cloudApi } from "../providers/cloud";
import type { CloudKind, ContextInfo } from "../types";
import { cloudTag } from "../utils";
import { CLOUD_PROVIDERS, CloudConnectPanel } from "./CloudConnect";
import { CloudLogo, Icon } from "./icons";
import { Logo } from "./TopBar";

interface Props {
  /** Contexts found in the kubeconfig; null while loading, [] if none/unavailable. */
  contexts: ContextInfo[] | null;
  contextsError: string | null;
  inTauriShell: boolean;
  connecting: string | null;
  /** Set while a cluster is still connected (switching): back returns to it. */
  onBack?: { label: string; go(): void };
  onConnect(context: string): void;
  onDemo(): void;
}

/**
 * The connect screen: three ways in - the built-in demo, an existing
 * kubeconfig context, or a managed cloud cluster (EKS / AKS / GKE) imported
 * through the user's own cloud CLI.
 */
export function Welcome({ contexts, contextsError, inTauriShell, connecting, onBack, onConnect, onDemo }: Props) {
  const [cloudKind, setCloudKind] = useState<CloudKind | null>(null);
  const cloud = cloudApi();

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

        <div className="welcome-card">
          <h2>Your kubeconfig</h2>
          {!inTauriShell && (
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
          {inTauriShell &&
            (contexts ?? []).map((ctx) => {
              const tag = cloudTag(ctx.name, "");
              return (
                <button
                  key={ctx.name}
                  className="context-btn"
                  disabled={connecting !== null}
                  onClick={() => onConnect(ctx.name)}
                >
                  <strong>{connecting === ctx.name ? "Connecting…" : ctx.name}</strong>
                  {tag && <span className="cloud-tag">{tag.provider}</span>}
                  {ctx.current && <span className="role-tag">current</span>}
                  <span className="who">{ctx.cluster}</span>
                </button>
              );
            })}
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
