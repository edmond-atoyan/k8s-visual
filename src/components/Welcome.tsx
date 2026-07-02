import type { ContextInfo } from "../types";
import { Logo } from "./TopBar";

interface Props {
  /** Contexts found in the kubeconfig; null while loading, [] if none/unavailable. */
  contexts: ContextInfo[] | null;
  contextsError: string | null;
  inTauriShell: boolean;
  connecting: string | null;
  onConnect(context: string): void;
  onDemo(): void;
}

export function Welcome({ contexts, contextsError, inTauriShell, connecting, onConnect, onDemo }: Props) {
  return (
    <div className="welcome">
      <div className="inner">
        <Logo size={44} />
        <h1>K8s Visual</h1>
        <p className="tagline">
          See your cluster as a living diagram — how Deployments create ReplicaSets, ReplicaSets
          run Pods, and Services tie it all together.
        </p>

        <div className="welcome-card">
          <h2>Connect to your cluster</h2>
          {!inTauriShell && (
            <p className="hint">
              Running in a plain browser — live cluster access needs the desktop app. Try the demo
              below.
            </p>
          )}
          {inTauriShell && contexts === null && !contextsError && <p className="hint">Reading kubeconfig…</p>}
          {inTauriShell && contextsError && (
            <p className="hint">
              {contextsError} — is there a kubeconfig at <code>~/.kube/config</code> (or{" "}
              <code>$KUBECONFIG</code>)?
            </p>
          )}
          {inTauriShell && contexts && contexts.length === 0 && !contextsError && (
            <p className="hint">No contexts found in your kubeconfig.</p>
          )}
          {inTauriShell &&
            (contexts ?? []).map((ctx) => (
              <button
                key={ctx.name}
                className="context-btn"
                disabled={connecting !== null}
                onClick={() => onConnect(ctx.name)}
              >
                <strong>{connecting === ctx.name ? "Connecting…" : ctx.name}</strong>
                {ctx.current && <span className="role-tag">current</span>}
                <span className="who">{ctx.cluster}</span>
              </button>
            ))}
        </div>

        <div className="welcome-card">
          <h2>New to Kubernetes?</h2>
          <p className="hint">
            Explore a realistic sample cluster — no setup, no cluster needed. It includes a healthy
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
