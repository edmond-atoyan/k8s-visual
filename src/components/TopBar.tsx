import type { ClusterInfo } from "../types";
import type { Theme } from "../utils";

export function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect x="2" y="2" width="28" height="28" rx="7" fill="var(--series-1)" />
      <circle cx="10" cy="16" r="3" fill="#fff" />
      <circle cx="22" cy="9" r="3" fill="#fff" />
      <circle cx="22" cy="23" r="3" fill="#fff" />
      <path d="M12.5 14.5 19.5 10.5 M12.5 17.5 19.5 21.5" stroke="#fff" strokeWidth="2" />
    </svg>
  );
}

interface Props {
  cluster: ClusterInfo | null;
  mode: "live" | "demo" | null;
  connected: boolean;
  theme: Theme;
  onToggleTheme(): void;
  onRefresh(): void;
}

export function TopBar({ cluster, mode, connected, theme, onToggleTheme, onRefresh }: Props) {
  return (
    <header className="topbar">
      <div className="brand">
        <Logo />
        K8s Visual
      </div>
      <div className="topbar-spacer" />
      {cluster && (
        <div className="cluster-chip" title={cluster.server}>
          <span className={`dot health-${connected ? "good" : "critical"}`} />
          <span>{cluster.context}</span>
          <span style={{ color: "var(--muted)" }}>{cluster.version}</span>
          {mode === "demo" && <span className="mode-tag">demo</span>}
        </div>
      )}
      {cluster && (
        <button className="icon-btn" onClick={onRefresh} title="Refresh now" aria-label="Refresh">
          ⟳
        </button>
      )}
      <button
        className="icon-btn"
        onClick={onToggleTheme}
        title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        aria-label="Toggle theme"
      >
        {theme === "dark" ? "☀" : "☾"}
      </button>
    </header>
  );
}
