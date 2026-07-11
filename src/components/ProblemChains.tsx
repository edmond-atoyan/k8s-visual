import { useState } from "react";
import type { ProblemChain } from "../chains";

/** One diagnosed problem: symptom, causal path, root cause, and the kubectl
 *  commands that verify it. Shared by the Events view, the details panel,
 *  and the assistant. */
export function ProblemChainCard({
  chain,
  compact = false,
  onSelectResource,
}: {
  chain: ProblemChain;
  compact?: boolean;
  onSelectResource?(uid: string): void;
}) {
  const [copied, setCopied] = useState(false);
  const copyChecks = () => {
    void navigator.clipboard.writeText(chain.checks.join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  return (
    <div className={`chain-card ${chain.severity}`}>
      <div className="chain-title">
        <span className={`dot health-${chain.severity}`} />
        <strong>{chain.title}</strong>
        {chain.pods.length > 1 && <span className="chain-count">{chain.pods.length} pods</span>}
      </div>

      <div className="chain-path">
        {chain.chain.map((link, i) => (
          <span className="chain-step" key={`${link.kind}/${link.name}`}>
            {i > 0 && <span className="chain-arrow">→</span>}
            <button
              className={`chain-node${link.uid ? "" : " ghost"}`}
              disabled={!link.uid || !onSelectResource}
              title={link.uid ? "Open details" : undefined}
              onClick={() => link.uid && onSelectResource?.(link.uid)}
            >
              <span className="chain-kind">{link.kind}</span>
              <span className="chain-name">{link.name}</span>
              <span className="chain-note">{link.note}</span>
            </button>
          </span>
        ))}
      </div>

      <p className="chain-cause">
        <strong>Likely root cause:</strong> {chain.rootCause}
      </p>
      {!compact && <p className="chain-why">{chain.whyItMatters}</p>}

      {!compact && chain.evidence.length > 0 && (
        <ul className="chain-evidence">
          {chain.evidence.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}

      <div className="chain-checks">
        <div className="chain-checks-head">
          <span className="kubectl-label">suggested checks</span>
          <button className="link-btn" onClick={copyChecks}>
            {copied ? "copied" : "copy all"}
          </button>
        </div>
        {chain.checks.map((c) => (
          <code key={c}>{c}</code>
        ))}
      </div>
    </div>
  );
}

export function ProblemChainList({
  chains,
  compact = false,
  onSelectResource,
}: {
  chains: ProblemChain[];
  compact?: boolean;
  onSelectResource?(uid: string): void;
}) {
  if (chains.length === 0) return null;
  return (
    <div className="chain-list">
      {chains.map((c) => (
        <ProblemChainCard key={c.id} chain={c} compact={compact} onSelectResource={onSelectResource} />
      ))}
    </div>
  );
}
