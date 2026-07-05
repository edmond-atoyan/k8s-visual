import { openExternal } from "../utils";
import { Icon } from "./icons";
import { Logo } from "./TopBar";

declare const __APP_VERSION__: string;

/** Help → About, in the spirit of Lens/VS Code: what this is, version, credits. */
export function AboutModal({ onClose }: { onClose(): void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal about-modal" role="dialog" aria-modal onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>About K8s Visual</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" size={13} />
          </button>
        </div>

        <div className="about-hero">
          <Logo size={40} />
          <div>
            <div className="about-name">K8s Visual</div>
            <div className="about-version">version {__APP_VERSION__}</div>
          </div>
        </div>

        <p className="about">
          A lightweight desktop app that makes Kubernetes architecture visible and understandable -
          and teaches the kubectl behind every operation. Read-only by default; every change asks first.
        </p>

        <h3>Details</h3>
        <dl className="kv">
          <dt>License</dt>
          <dd>MIT</dd>
          <dt>Built with</dt>
          <dd>Tauri 2 · React · kube-rs</dd>
          <dt>Graph rendering</dt>
          <dd>
            <button className="link-btn" onClick={() => void openExternal("https://reactflow.dev")}>
              React Flow ↗
            </button>
          </dd>
          <dt>Shortcuts</dt>
          <dd>F11 fullscreen · Ctrl+` terminal · Esc close panel</dd>
        </dl>

        <p className="about about-fineprint">
          Kubernetes is a registered trademark of The Linux Foundation. This app is an independent
          project and is not affiliated with any cloud provider.
        </p>
      </div>
    </div>
  );
}
