// Small shared UI pieces used across views.

import { useState } from "react";
import { RISK_LABEL, type Risk } from "../actions";
import type { Health } from "../types";

export function HealthDot({ health, label }: { health: Health; label: string }) {
  return (
    <span className="status">
      <span className={`dot health-${health}`} />
      <span>{label}</span>
    </span>
  );
}

/** Key-value grid used in details panels. */
export function Kv({ entries }: { entries: [string, string][] }) {
  if (entries.length === 0) return null;
  return (
    <dl className="kv">
      {entries.map(([k, v]) => (
        <span key={k} style={{ display: "contents" }}>
          <dt>{k}</dt>
          <dd style={{ whiteSpace: "pre-wrap" }}>{v}</dd>
        </span>
      ))}
    </dl>
  );
}

export function RiskBadge({ risk }: { risk: Risk }) {
  return <span className={`risk-badge risk-${risk}`}>{RISK_LABEL[risk]}</span>;
}

/** The equivalent CLI command, shown so users learn the CLI too. */
export function KubectlHint({ command, label = "kubectl equivalent" }: { command: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="kubectl-hint">
      <span className="kubectl-label">{label}</span>
      <code title={command}>{command}</code>
      <button
        className="link-btn"
        onClick={() => {
          void navigator.clipboard.writeText(command);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
      >
        {copied ? "copied" : "copy"}
      </button>
    </div>
  );
}

export function EmptyMsg({ children }: { children: React.ReactNode }) {
  return (
    <div className="graph-empty">
      <div className="inner">{children}</div>
    </div>
  );
}

/** Search input used by tables and lists. */
export function SearchBox({
  value,
  onChange,
  placeholder = "Search…",
}: {
  value: string;
  onChange(v: string): void;
  placeholder?: string;
}) {
  return (
    <input
      className="search-box"
      type="search"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
