import { useState } from "react";
import type { ClusterInfo } from "../types";
import type { Theme } from "../utils";
import { AboutModal } from "./AboutModal";
import { Icon } from "./icons";
import { WindowControls } from "./WindowControls";

export function Logo({ size = 20 }: { size?: number }) {
  return <img src="/app-icon.svg" width={size} height={size} alt="" aria-hidden data-tauri-drag-region />;
}

/** Marks an element as a draggable part of the custom title bar (Tauri only;
 *  inert in the browser). Interactive children stay clickable because Tauri
 *  only starts a drag when the pressed element itself carries the attribute. */
const drag = { "data-tauri-drag-region": true } as const;

interface Props {
  cluster: ClusterInfo | null;
  management: boolean;
  namespaces: string[];
  namespace: string;
  showNamespace: boolean;
  theme: Theme;
  onNamespace(ns: string): void;
  onToggleManagement(): void;
  onToggleTheme(): void;
  onToggleTerminal?(): void;
  onToggleAssistant?(): void;
  onRefresh(): void;
}

/**
 * The custom title bar: window drag region, namespace + mode controls, and
 * the app-drawn window controls. The OS chrome is disabled
 * (`decorations: false`), so this bar IS the window's top edge. The active
 * cluster is shown in the sidebar footer and status bar.
 */
export function TopBar({
  cluster,
  management,
  namespaces,
  namespace,
  showNamespace,
  theme,
  onNamespace,
  onToggleManagement,
  onToggleTheme,
  onToggleTerminal,
  onToggleAssistant,
  onRefresh,
}: Props) {
  const [about, setAbout] = useState(false);
  return (
    <header className="topbar" {...drag}>
      <div className="brand" {...drag}>
        <Logo size={18} />
        <span {...drag}>K8s Visual</span>
      </div>

      {cluster && showNamespace && (
        <label className="ns-select">
          <span>namespace</span>
          <select value={namespace} onChange={(e) => onNamespace(e.target.value)}>
            {namespaces.map((ns) => (
              <option key={ns} value={ns}>
                {ns}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="topbar-spacer" {...drag} />

      {cluster && (
        <button
          className={`mode-toggle ${management ? "mode-mgmt" : "mode-ro"}`}
          onClick={onToggleManagement}
          title={
            management
              ? "Management mode is on: cluster-changing actions are available (each one still requires confirmation). Click to return to read-only."
              : "Read-only mode: nothing in the app can change the cluster. Click to enable management actions."
          }
        >
          <Icon name={management ? "unlock" : "lock"} size={12} />
          {management ? "Management on" : "Read-only"}
        </button>
      )}

      {cluster && onToggleAssistant && (
        <button
          className="icon-btn"
          onClick={onToggleAssistant}
          title="Assistant - explain problems, summarize health (runs locally)"
          aria-label="Open assistant"
        >
          <Icon name="sparkle" />
        </button>
      )}
      {cluster && onToggleTerminal && (
        <button
          className="icon-btn"
          onClick={onToggleTerminal}
          title="Toggle terminal (Ctrl+`)"
          aria-label="Toggle terminal"
        >
          <Icon name="terminal-panel" />
        </button>
      )}
      {cluster && (
        <button className="icon-btn" onClick={onRefresh} title="Refresh now" aria-label="Refresh">
          <Icon name="refresh" />
        </button>
      )}
      <button
        className="icon-btn"
        onClick={onToggleTheme}
        title="Toggle light/dark theme"
        aria-label="Toggle theme"
      >
        <Icon name={theme === "dark" ? "sun" : "moon"} />
      </button>
      <button className="icon-btn" onClick={() => setAbout(true)} title="About K8s Visual" aria-label="About">
        <Icon name="help" />
      </button>

      <WindowControls />

      {about && <AboutModal onClose={() => setAbout(false)} />}
    </header>
  );
}
