import { useEffect, useRef, useState } from "react";
import type { CloudApi } from "../providers/cloud";
import type { CloudCliStatus, CloudCluster, CloudKind, CloudScope } from "../types";
import { KubectlHint } from "./bits";
import { Icon } from "./icons";

export interface CloudProviderMeta {
  kind: CloudKind;
  name: string;
  cli: string;
  requires: string;
  scopeNoun: string;
}

export const CLOUD_PROVIDERS: CloudProviderMeta[] = [
  { kind: "aws", name: "Amazon EKS", cli: "AWS", requires: "AWS CLI required", scopeNoun: "profile" },
  { kind: "azure", name: "Azure AKS", cli: "Azure", requires: "Azure CLI required (az login)", scopeNoun: "subscription" },
  { kind: "gcp", name: "Google GKE", cli: "gcloud", requires: "gcloud CLI required", scopeNoun: "project" },
];

/** The provider-CLI command the import step will run - shown for transparency,
 *  like the kubectl hints elsewhere in the app. */
function importCommand(kind: CloudKind, scope: string, c: CloudCluster | null): string {
  const name = c?.name ?? "<cluster>";
  switch (kind) {
    case "aws":
      return `aws eks update-kubeconfig --name ${name} --region ${c?.location ?? "<region>"} --profile ${scope || "<profile>"}`;
    case "azure":
      return `az aks get-credentials --name ${name} --resource-group ${c?.group ?? "<group>"} --subscription ${scope || "<subscription>"}`;
    case "gcp":
      return `gcloud container clusters get-credentials ${name} --project ${scope || "<project>"} --location ${c?.location ?? "<location>"}`;
  }
}

type StepState = "pending" | "active" | "done" | "error";

function Step({
  state,
  index,
  label,
  sub,
  children,
}: {
  state: StepState;
  index: number;
  label: string;
  sub?: string;
  children?: React.ReactNode;
}) {
  return (
    <li className={`step ${state}`}>
      <span className="step-dot">{state === "done" ? "✓" : state === "error" ? "!" : index}</span>
      <div className="step-main">
        <div className="step-label">{label}</div>
        {sub && <div className="step-sub">{sub}</div>}
        {children}
      </div>
    </li>
  );
}

interface PanelProps {
  meta: CloudProviderMeta;
  api: CloudApi;
  /** True while the parent is connecting to the imported context. */
  connecting: boolean;
  onConnect(context: string): void;
  onCancel(): void;
}

/**
 * The step-by-step cloud connect flow: CLI check → sign-in/scope → cluster
 * discovery → kubeconfig import (done by the provider CLI itself) → normal
 * kubeconfig connect. No cloud secrets are asked for, stored, or sent
 * anywhere - the app only talks to the local CLI.
 */
export function CloudConnectPanel({ meta, api, connecting, onConnect, onCancel }: PanelProps) {
  const { kind } = meta;
  const [cli, setCli] = useState<CloudCliStatus | null>(null);
  const [scopes, setScopes] = useState<CloudScope[] | null>(null);
  const [scope, setScope] = useState("");
  const [regions, setRegions] = useState<CloudScope[] | null>(null);
  const [region, setRegion] = useState("");
  const [clusters, setClusters] = useState<CloudCluster[] | null>(null);
  const [picked, setPicked] = useState<CloudCluster | null>(null);
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState(false);
  const [error, setError] = useState<{ at: "cli" | "auth" | "clusters" | "import"; message: string } | null>(null);
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);

  // Step 1+2: CLI present, signed in, scopes available.
  useEffect(() => {
    const gen = ++generation.current;
    setCli(null);
    setScopes(null);
    setScope("");
    setRegions(null);
    setRegion("");
    setClusters(null);
    setPicked(null);
    setImporting(false);
    setImported(false);
    setError(null);
    void (async () => {
      try {
        const status = await api.cliStatus(kind);
        if (gen !== generation.current) return;
        setCli(status);
        if (!status.installed) {
          setError({ at: "cli", message: status.detail ?? "CLI not found." });
          return;
        }
        if (!status.authenticated) {
          setError({ at: "auth", message: status.detail ?? "Not signed in." });
          return;
        }
        const list = await api.scopes(kind);
        if (gen !== generation.current) return;
        setScopes(list);
        setScope((list.find((s) => s.default) ?? list[0])?.id ?? "");
      } catch (e) {
        if (gen === generation.current) setError({ at: "auth", message: String(e) });
      }
    })();
  }, [api, kind, retry]);

  // Step 3: regions (AWS only), then clusters for the chosen scope.
  useEffect(() => {
    if (!scope) return;
    const gen = generation.current;
    setClusters(null);
    setPicked(null);
    setError((e) => (e?.at === "clusters" || e?.at === "import" ? null : e));
    void (async () => {
      try {
        let reg = region;
        if (kind === "aws" && regions === null) {
          const list = await api.regions(kind, scope);
          if (gen !== generation.current) return;
          setRegions(list);
          reg = (list.find((r) => r.default) ?? list[0])?.id ?? "";
          setRegion(reg);
          return; // region change re-triggers this effect
        }
        if (kind === "aws" && !reg) return;
        const list = await api.clusters(kind, scope, kind === "aws" ? reg : undefined);
        if (gen !== generation.current) return;
        setClusters(list);
        if (list.length === 1) setPicked(list[0]);
      } catch (e) {
        if (gen === generation.current) setError({ at: "clusters", message: String(e) });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, kind, scope, region, regions, retry]);

  const runImport = async () => {
    if (!picked) return;
    setImporting(true);
    setError(null);
    try {
      const outcome = await api.importCredentials(kind, scope, picked);
      setImported(true);
      onConnect(outcome.context);
    } catch (e) {
      setError({ at: "import", message: String(e) });
    } finally {
      setImporting(false);
    }
  };

  const cliState: StepState = error?.at === "cli" ? "error" : cli === null ? "active" : "done";
  const authState: StepState =
    error?.at === "auth" ? "error" : cli === null ? "pending" : scopes === null ? "active" : "done";
  const clustersState: StepState =
    error?.at === "clusters" ? "error" : scopes === null ? "pending" : picked === null ? "active" : "done";
  const importState: StepState =
    error?.at === "import" ? "error" : imported ? "done" : importing ? "active" : "pending";
  const connectState: StepState = imported ? (connecting ? "active" : "done") : "pending";

  const scopeNounUpper = meta.scopeNoun[0].toUpperCase() + meta.scopeNoun.slice(1);

  return (
    <div className="cloud-panel">
      <ol className="steps">
        <Step
          state={cliState}
          index={1}
          label={`Check ${meta.cli} CLI`}
          sub={cli === null ? "checking…" : cli.installed ? "CLI found" : undefined}
        />
        <Step
          state={authState}
          index={2}
          label="Verify sign-in"
          sub={cli?.account ?? (cli && !cli.authenticated ? undefined : cli ? cli.detail : undefined)}
        >
          {scopes && scopes.length > 0 && (
            <div className="step-body">
              <label className="step-row">
                {scopeNounUpper}
                <select
                  value={scope}
                  onChange={(e) => {
                    setScope(e.target.value);
                    if (kind === "aws") {
                      // the default region is per-profile - re-resolve it
                      setRegions(null);
                      setRegion("");
                    }
                  }}
                >
                  {scopes.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                      {s.detail ? ` (${s.detail})` : ""}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
        </Step>
        <Step
          state={clustersState}
          index={3}
          label="Discover clusters"
          sub={
            scopes === null
              ? undefined
              : clusters === null && error?.at !== "clusters"
                ? "listing clusters…"
                : clusters?.length === 0
                  ? "no clusters found in this scope"
                  : undefined
          }
        >
          {scopes !== null && (
            <div className="step-body">
              {kind === "aws" && regions && regions.length > 0 && (
                <label className="step-row">
                  Region
                  <select value={region} onChange={(e) => setRegion(e.target.value)}>
                    {regions.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.label}
                        {r.detail ? ` (${r.detail})` : ""}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {clusters && clusters.length > 0 && (
                <div className="cluster-pick">
                  {clusters.map((c) => (
                    <button
                      key={`${c.location}/${c.name}`}
                      className={`cluster-row${picked?.name === c.name && picked?.location === c.location ? " picked" : ""}`}
                      onClick={() => setPicked(c)}
                    >
                      <strong>{c.name}</strong>
                      {c.detail && <span className="cell-sub">{c.detail}</span>}
                      <span className="loc">{c.location}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </Step>
        <Step state={importState} index={4} label="Import kubeconfig entry" sub={importing ? "running the provider CLI…" : undefined}>
          {picked && !imported && (
            <div className="step-body">
              <KubectlHint label="CLI command" command={importCommand(kind, scope, picked)} />
            </div>
          )}
        </Step>
        <Step
          state={connectState}
          index={5}
          label="Connect to the Kubernetes API"
          sub={imported && connecting ? "connecting…" : undefined}
        />
      </ol>

      {error && (
        <div className="error-banner">
          <span style={{ flex: 1 }}>{error.message}</span>
          <button className="chip" onClick={() => setRetry((n) => n + 1)}>
            <Icon name="refresh" size={12} /> retry
          </button>
        </div>
      )}

      <p className="cloud-note">
        Uses your locally authenticated CLI. The app never asks for, stores, or uploads cloud credentials -
        the CLI writes the kubeconfig entry itself.
      </p>

      <div className="cloud-actions">
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={!picked || importing || imported}
          title={picked ? undefined : "Pick a cluster first"}
          onClick={() => void runImport()}
        >
          {importing ? "Importing…" : imported ? (connecting ? "Connecting…" : "Connected") : "Import & connect"}
        </button>
      </div>
    </div>
  );
}
