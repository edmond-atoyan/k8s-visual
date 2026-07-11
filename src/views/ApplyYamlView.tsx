import { useRef, useState } from "react";
import { KUBECTL_INTENT } from "../actions";
import { KubectlHint, RiskBadge } from "../components/bits";
import type { ApplyResult, ClusterProvider } from "../types";

interface Props {
  provider: ClusterProvider;
  namespace: string;
  management: boolean;
}

const PLACEHOLDER = `# Paste one or more YAML documents (separated by ---),
# or open a file. Documents without metadata.namespace go to the
# namespace selected in the title bar.
apiVersion: apps/v1
kind: Deployment
metadata:
  name: example
spec:
  ...`;

/**
 * kubectl apply, visually: paste → server dry-run → review → apply.
 * The Apply button never enables before a dry-run of the same text.
 */
export function ApplyYamlView({ provider, namespace, management }: Props) {
  const [text, setText] = useState("");
  const [dryRun, setDryRun] = useState<ApplyResult | null>(null);
  // The approval is bound to text AND namespace: documents without an
  // explicit metadata.namespace land in the selected one, so switching
  // namespaces after a dry-run must invalidate it.
  const [dryRunFor, setDryRunFor] = useState<{ text: string; namespace: string } | null>(null);
  const [applied, setApplied] = useState<ApplyResult | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const runDry = async () => {
    setBusy(true);
    setApplied(null);
    try {
      setDryRun(await provider.applyYaml(text, true, namespace));
    } catch (e) {
      setDryRun({ ok: false, dryRun: true, results: [], error: String(e) });
    } finally {
      setDryRunFor({ text, namespace });
      setBusy(false);
    }
  };

  const apply = async () => {
    setBusy(true);
    try {
      setApplied(await provider.applyYaml(text, false, namespace));
    } catch (e) {
      setApplied({ ok: false, dryRun: false, results: [], error: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const openFile = (file: File) => {
    void file.text().then((content) => {
      setText(content);
      setDryRun(null);
      setApplied(null);
    });
  };

  if (!management) {
    return (
      <div className="overview wide">
        <h2>Apply YAML</h2>
        <div className="issue-box">
          <p>
            Applying YAML changes cluster state, and the app is currently <strong>read-only</strong>. Enable
            management mode in the title bar to use this view.
          </p>
        </div>
      </div>
    );
  }

  const upToDate = dryRunFor !== null && dryRunFor.text === text && dryRunFor.namespace === namespace;
  const canApply = dryRun?.ok === true && upToDate && text.trim() !== "";

  return (
    <div className="overview wide">
      <h2>
        Apply YAML <span className="h2-sub">- server-side apply with a dry-run first</span>{" "}
        <RiskBadge risk="high" />
      </h2>
      <p className="about">
        Target: namespace <strong>{namespace}</strong> (used for documents without an explicit{" "}
        <code>metadata.namespace</code>). Every apply runs through the API server as{" "}
        <code>kubectl apply --server-side</code> would; a server dry-run is required before the real apply.
        {provider.mode === "demo" && " In demo mode the apply is simulated and clearly labelled."}
      </p>

      <div className="editor-frame">
        <div className="editor-head">
          <span className="editor-lang">yaml</span>
          <span className="editor-meta">→ namespace {namespace}</span>
          <span className="spacer" />
          <button className="btn" onClick={() => fileRef.current?.click()}>
            Open file…
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".yaml,.yml,.json"
            style={{ display: "none" }}
            onChange={(e) => e.target.files?.[0] && openFile(e.target.files[0])}
          />
          <button
            className="btn"
            disabled={busy || text.trim() === ""}
            title={text.trim() === "" ? "Paste or open a YAML document first" : "Validate against the API server without changing anything"}
            onClick={() => void runDry()}
          >
            {busy ? "Working…" : "Server dry-run"}
          </button>
          <button
            className="btn primary risk-danger"
            disabled={!canApply || busy}
            title={canApply ? "Apply to the cluster" : "Run a successful dry-run of exactly this text first"}
            onClick={() => void apply()}
          >
            Apply to cluster
          </button>
        </div>
        <textarea
          className="yaml-edit tall"
          spellCheck={false}
          placeholder={PLACEHOLDER}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setApplied(null);
          }}
        />
      </div>

      {dryRun && (
        <div className={dryRun.ok ? "result-banner ok" : "error-banner"}>
          <strong>Dry-run:</strong>{" "}
          {dryRun.ok ? dryRun.results.join("; ") : (dryRun.error ?? "failed")}
          {dryRun.ok && !upToDate && " (text or namespace changed since - run again)"}
        </div>
      )}
      {applied && (
        <div className={applied.ok ? "result-banner ok" : "error-banner"}>
          <strong>Apply:</strong> {applied.ok ? applied.results.join("; ") : (applied.error ?? "failed")}
        </div>
      )}

      <KubectlHint command={KUBECTL_INTENT.apply(false)} />
    </div>
  );
}
