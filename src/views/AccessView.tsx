import { useEffect, useState } from "react";
import { KubectlHint } from "../components/bits";
import type { AccessCheck, AccessResult, ClusterProvider } from "../types";

interface Props {
  provider: ClusterProvider;
  namespace: string;
}

/** The permission matrix the rest of the UI is gated on. */
function standardChecks(ns: string): { label: string; check: AccessCheck }[] {
  return [
    { label: "List pods", check: { verb: "list", resource: "pods", namespace: ns } },
    { label: "Read pod logs", check: { verb: "get", resource: "pods/log", namespace: ns } },
    { label: "Exec into pods", check: { verb: "create", resource: "pods/exec", namespace: ns } },
    { label: "Delete pods", check: { verb: "delete", resource: "pods", namespace: ns } },
    { label: "List events", check: { verb: "list", resource: "events", namespace: ns } },
    { label: "List secrets", check: { verb: "list", resource: "secrets", namespace: ns } },
    { label: "Read secret values", check: { verb: "get", resource: "secrets", namespace: ns } },
    { label: "Update deployments (scale/restart/rollback)", check: { verb: "patch", resource: "deployments", group: "apps", namespace: ns } },
    { label: "Delete deployments", check: { verb: "delete", resource: "deployments", group: "apps", namespace: ns } },
    { label: "Apply arbitrary resources", check: { verb: "patch", resource: "configmaps", namespace: ns } },
    { label: "Trigger CronJobs (create jobs)", check: { verb: "create", resource: "jobs", group: "batch", namespace: ns } },
    { label: "Port-forward", check: { verb: "create", resource: "pods/portforward", namespace: ns } },
    { label: "List nodes (cluster-wide)", check: { verb: "list", resource: "nodes" } },
    { label: "Cordon nodes (cluster-wide)", check: { verb: "patch", resource: "nodes" } },
    { label: "Read metrics API", check: { verb: "list", resource: "pods", group: "metrics.k8s.io", namespace: ns } },
    { label: "Delete namespaces (cluster-wide)", check: { verb: "delete", resource: "namespaces" } },
  ];
}

export function AccessView({ provider, namespace }: Props) {
  const [results, setResults] = useState<(AccessResult & { label: string })[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setResults(null);
    const items = standardChecks(namespace);
    provider
      .checkAccess(items.map((i) => i.check))
      .then((res) => {
        if (cancelled) return;
        setResults(res.map((r, i) => ({ ...r, label: items[i]?.label ?? `${r.check.verb} ${r.check.resource}` })));
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [provider, namespace]);

  return (
    <div className="overview wide">
      <h2>
        Access <span className="h2-sub">- what your credentials may do in {namespace}</span>
      </h2>
      <p className="about">
        Answered by the cluster itself via <code>SelfSubjectAccessReview</code> - the same mechanism that decides
        whether an action button works. When something is denied, the app tells you the missing verb and resource
        instead of failing silently.
      </p>

      {error && <div className="error-banner">{error}</div>}
      {!results && !error && <p className="about">Checking permissions…</p>}

      {results && (
        <table className="ns-table">
          <thead>
            <tr>
              <th>Capability</th>
              <th>Verb / resource</th>
              <th>Allowed</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) => (
              <tr key={r.label}>
                <td className="cell-name">{r.label}</td>
                <td>
                  <code>
                    {r.check.verb} {r.check.group ? `${r.check.group}/` : ""}
                    {r.check.resource}
                  </code>
                </td>
                <td>
                  <span className={`perm-badge ${r.allowed ? "allowed" : "denied"}`}>
                    <span className={`dot health-${r.allowed ? "good" : "critical"}`} />
                    {r.allowed ? "Allowed" : "Denied"}
                  </span>
                  {r.reason && <div className="cell-sub">{r.reason}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <KubectlHint command={`kubectl auth can-i --list -n ${namespace}`} />
    </div>
  );
}
