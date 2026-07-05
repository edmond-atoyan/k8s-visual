import { useCallback, useEffect, useState } from "react";
import { EmptyMsg, HealthDot } from "../components/bits";
import { selectorMatches } from "../graph/build";
import type { ClusterProvider, NamespaceSnapshot, PortForwardInfo, ResourceSummary } from "../types";

interface Props {
  provider: ClusterProvider;
  snapshot: NamespaceSnapshot;
  onSelect(uid: string): void;
}

interface Route {
  text: string;
  serviceName: string;
}

function parseRoutes(ing: ResourceSummary): Route[] {
  const lines = (ing.details.Routes ?? "").split("\n").filter(Boolean);
  const routes = lines.map((line) => {
    const m = /→\s*([^:\s]+)/.exec(line);
    return { text: line, serviceName: m?.[1] ?? "" };
  });
  if (routes.length > 0) return routes;
  // Fall back to plain Service refs when no structured routes exist.
  return (ing.refs ?? [])
    .filter((r) => r.startsWith("Service/"))
    .map((r) => ({ text: `→ ${r.slice("Service/".length)}`, serviceName: r.slice("Service/".length) }));
}

/** Diagnose one Service: endpoints, readiness, port mismatches. */
function diagnoseService(svc: ResourceSummary | undefined, pods: ResourceSummary[]): string[] {
  const problems: string[] = [];
  if (!svc) return ["Backend Service does not exist in this namespace."];
  if (!svc.selector || Object.keys(svc.selector).length === 0) {
    return ["Service has no selector (external/headless service) - endpoints are managed manually."];
  }
  const matched = pods.filter((p) => selectorMatches(svc.selector!, p.labels));
  if (matched.length === 0) {
    problems.push(`Selector matches no Pods - no endpoints, traffic will fail.`);
    return problems;
  }
  const ready = matched.filter((p) => p.health === "good");
  if (ready.length === 0) {
    problems.push(`${matched.length} Pod(s) match the selector but none are ready - no ready endpoints.`);
  }
  // targetPort vs containerPort (numeric ports only - named ports resolve at runtime).
  for (const sp of svc.servicePorts ?? []) {
    const target = Number(sp.targetPort);
    if (!Number.isFinite(target) || matched.length === 0) continue;
    const someoneListens = matched.some((p) =>
      (p.containers ?? []).some((c) => c.ports.length === 0 || c.ports.includes(target)),
    );
    if (!someoneListens) {
      problems.push(
        `targetPort ${target} does not match any declared containerPort on the selected Pods - check the port mapping.`,
      );
    }
  }
  return problems;
}

/** The traffic path: Ingress → Service → Pods, with breakage made visible. */
export function NetworkingView({ provider, snapshot, onSelect }: Props) {
  const pods = snapshot.resources.filter((r) => r.kind === "Pod");
  const services = snapshot.resources.filter((r) => r.kind === "Service");
  const ingresses = snapshot.resources.filter((r) => r.kind === "Ingress");
  const netpols = snapshot.resources.filter((r) => r.kind === "NetworkPolicy");
  const byName = new Map(services.map((s) => [s.name, s]));

  const referencedServices = new Set(ingresses.flatMap((ing) => parseRoutes(ing).map((r) => r.serviceName)));

  const serviceBlock = (svc: ResourceSummary | undefined, name: string) => {
    const problems = diagnoseService(svc, pods);
    const matched = svc?.selector ? pods.filter((p) => selectorMatches(svc.selector!, p.labels)) : [];
    return (
      <div className={`net-service${problems.length > 0 ? " broken" : ""}`}>
        {svc ? (
          <button className="rel-link" onClick={() => onSelect(svc.uid)}>
            <span className="knode-badge">svc</span> {svc.name}
            <span className="age">{svc.details.Ports ?? ""}</span>
          </button>
        ) : (
          <div className="rel-link broken">
            <span className="knode-badge">svc</span> {name} <span className="missing-tag">not found</span>
          </div>
        )}
        {problems.map((p, i) => (
          <div key={i} className="net-problem">⚠ {p}</div>
        ))}
        <div className="net-pods">
          {matched.map((p) => (
            <button key={p.uid} className="rel-link" onClick={() => onSelect(p.uid)}>
              <span className="knode-badge">pod</span> {p.name}
              <HealthDot health={p.health} label={p.status} />
            </button>
          ))}
          {svc && matched.length === 0 && <span className="net-problem">no matching Pods</span>}
        </div>
      </div>
    );
  };

  return (
    <div className="overview wide">
      <h2>
        Networking <span className="h2-sub">- how traffic reaches your Pods · {snapshot.namespace}</span>
      </h2>

      {ingresses.length === 0 && services.length === 0 && (
        <EmptyMsg>
          <p>No Services or Ingresses in this namespace.</p>
        </EmptyMsg>
      )}

      {ingresses.map((ing) => (
        <section key={ing.uid} className="net-ingress">
          <h3>
            <button className="rel-link big" onClick={() => onSelect(ing.uid)}>
              <span className="knode-badge">ing</span> {ing.name}
            </button>
            <span className="h2-sub">{ing.details.Hosts}</span>
            {ing.details.TLS && (
              <span className="label-chip" title={`TLS secret: ${ing.details.TLS}`}>
                TLS: {ing.details.TLS}
              </span>
            )}
          </h3>
          {parseRoutes(ing).map((route, i) => (
            <div key={i} className="net-route">
              <code className="net-path">{route.text.split("→")[0].trim()}</code>
              <span className="net-arrow">→</span>
              {serviceBlock(byName.get(route.serviceName), route.serviceName)}
            </div>
          ))}
        </section>
      ))}

      {services.filter((s) => !referencedServices.has(s.name)).length > 0 && (
        <>
          <h3>Services not behind an Ingress</h3>
          {services
            .filter((s) => !referencedServices.has(s.name))
            .map((s) => (
              <div key={s.uid} className="net-route">
                <code className="net-path">{s.details["Cluster IP"] ?? s.status}</code>
                <span className="net-arrow">→</span>
                {serviceBlock(s, s.name)}
              </div>
            ))}
        </>
      )}

      {netpols.length > 0 && (
        <>
          <h3>Network policies</h3>
          {netpols.map((np) => (
            <button key={np.uid} className="rel-link" onClick={() => onSelect(np.uid)}>
              <span className="knode-badge">netpol</span> {np.name}
              <span className="age">{np.details.Allows ?? np.details["Policy types"] ?? ""}</span>
            </button>
          ))}
        </>
      )}

      <PortForwards provider={provider} />
    </div>
  );
}

function PortForwards({ provider }: { provider: ClusterProvider }) {
  const [forwards, setForwards] = useState<PortForwardInfo[]>([]);
  const refresh = useCallback(() => {
    provider.listPortForwards().then(setForwards).catch(() => {});
  }, [provider]);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <>
      <h3>Active port-forwards</h3>
      {forwards.length === 0 && (
        <p className="about">
          None. Start one from a Pod or Service details panel (Actions tab)
          {provider.mode === "demo" ? " - in demo mode tunnels are simulated." : "."}
        </p>
      )}
      {forwards.map((f) => (
        <div key={f.id} className="pf-row">
          <code>localhost:{f.localPort}</code> → {f.kind.toLowerCase()}/{f.name} ({f.targetPod}:{f.remotePort}) in{" "}
          {f.namespace}
          <button className="link-btn" onClick={() => provider.stopPortForward(f.id).then(refresh)}>
            stop
          </button>
        </div>
      ))}
    </>
  );
}
