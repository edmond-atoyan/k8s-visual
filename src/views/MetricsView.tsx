import { useEffect, useMemo, useState } from "react";
import { KUBECTL_INTENT } from "../actions";
import { EmptyMsg, KubectlHint } from "../components/bits";
import type { ClusterOverview, ClusterProvider, MetricsSnapshot, NamespaceSnapshot } from "../types";
import { formatBytes, formatCpu } from "../utils";

/** Short-term local history, collected only while the app runs (never faked). */
export interface MetricsHistory {
  /** per pod/node key -> series of samples */
  cpu: Map<string, number[]>;
  mem: Map<string, number[]>;
}

export function newMetricsHistory(): MetricsHistory {
  return { cpu: new Map(), mem: new Map() };
}

const MAX_SAMPLES = 120;

function pushSample(map: Map<string, number[]>, key: string, value: number) {
  const series = map.get(key) ?? [];
  series.push(value);
  if (series.length > MAX_SAMPLES) series.shift();
  map.set(key, series);
}

interface Props {
  provider: ClusterProvider;
  namespace: string;
  snapshot: NamespaceSnapshot | null;
  overview: ClusterOverview;
  history: MetricsHistory;
}

/** Compact trend line: de-emphasis hue, current sample marked in the accent
 *  with a surface ring so it stays legible where it crosses the line. */
function Sparkline({ series, width = 120, height = 26 }: { series: number[]; width?: number; height?: number }) {
  if (series.length < 2) return <span className="collecting">collecting…</span>;
  const max = Math.max(...series, 1);
  const min = Math.min(...series, 0);
  const span = max - min || 1;
  const pad = 4;
  const points = series
    .map((v, i) => {
      const x = pad + (i / (series.length - 1)) * (width - 2 * pad);
      const y = height - pad - ((v - min) / span) * (height - 2 * pad);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const [lastX, lastY] = points.split(" ").pop()!.split(",");
  return (
    <svg
      className="sparkline"
      width={width}
      height={height}
      role="img"
      aria-label={`trend, ${series.length} samples`}
    >
      <polyline
        points={points}
        fill="none"
        stroke="var(--baseline)"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={lastX} cy={lastY} r="3.5" fill="var(--series-1)" stroke="var(--surface)" strokeWidth="2" />
    </svg>
  );
}

/**
 * Session trend for the namespace totals: 2px line on a 10%-opacity wash,
 * hairline gridlines, crosshair + tooltip on hover. X stretches to the card
 * (viewBox 0-100, non-scaling strokes); dots and text are HTML overlays so
 * they never distort.
 */
function TrendChart({ series, format, height = 76 }: { series: number[]; format(v: number): string; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  if (series.length < 2) {
    return <p className="collecting">Collecting samples - the trend appears after a few refreshes.</p>;
  }
  const max = Math.max(...series, 1);
  const padTop = 8;
  const padBottom = 5;
  const plotH = height - padTop - padBottom;
  const xPct = (i: number) => (i / (series.length - 1)) * 100;
  const yPx = (v: number) => padTop + (1 - v / max) * plotH;
  const line = series.map((v, i) => `${xPct(i).toFixed(2)},${yPx(v).toFixed(2)}`).join(" ");
  const area = `0,${yPx(0).toFixed(2)} ${line} 100,${yPx(0).toFixed(2)}`;
  const last = series.length - 1;
  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    setHover(Math.round(frac * last));
  };
  const dot = (i: number, accent: boolean) => (
    <span
      key={accent ? "hover" : "end"}
      style={{
        position: "absolute",
        left: `${xPct(i)}%`,
        top: yPx(series[i]),
        width: 8,
        height: 8,
        marginLeft: -4,
        marginTop: -4,
        borderRadius: "50%",
        background: "var(--series-1)",
        boxShadow: "0 0 0 2px var(--surface)",
        opacity: accent ? 1 : 0.9,
        pointerEvents: "none",
      }}
    />
  );
  return (
    <div
      className="trend-chart"
      style={{ height }}
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
      role="img"
      aria-label={`trend over ${series.length} samples, now ${format(series[last])}, peak ${format(max)}`}
    >
      <svg height={height} viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" aria-hidden>
        {[max, max / 2, 0].map((v) => (
          <line
            key={v}
            x1="0"
            x2="100"
            y1={yPx(v)}
            y2={yPx(v)}
            stroke="var(--grid)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        <polygon points={area} fill="var(--series-1)" opacity="0.1" />
        <polyline
          points={line}
          fill="none"
          stroke="var(--series-1)"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        {hover !== null && (
          <line
            x1={xPct(hover)}
            x2={xPct(hover)}
            y1={padTop - 3}
            y2={height - padBottom}
            stroke="var(--baseline)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      {dot(last, false)}
      {hover !== null && hover !== last && dot(hover, true)}
      {hover !== null && (
        <div className="chart-tip" style={{ left: `${xPct(hover)}%`, top: yPx(series[hover]) }}>
          <strong>{format(series[hover])}</strong> · {hover === last ? "now" : `${(last - hover) * 5}s ago`}
        </div>
      )}
    </div>
  );
}

/** Usage against a limit: severity fill on a lighter same-hue track. */
function Meter({ used, capacity, label }: { used: number; capacity: number; label: string }) {
  const frac = capacity > 0 ? Math.min(used / capacity, 1) : 0;
  const fill = frac > 0.95 ? "var(--critical)" : frac > 0.8 ? "var(--warning)" : "var(--series-1)";
  return (
    <div className="meter-row">
      <span className="meter-label">{label}</span>
      <div className="meter-track" style={{ background: `color-mix(in srgb, ${fill} 18%, transparent)` }}>
        <div className="meter-fill" style={{ width: `${(frac * 100).toFixed(1)}%`, background: fill }} />
      </div>
      <span className="meter-value">{(frac * 100).toFixed(0)}%</span>
    </div>
  );
}

export function MetricsView({ provider, namespace, snapshot, overview, history }: Props) {
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      provider
        .getMetrics(namespace)
        .then((m) => {
          if (cancelled) return;
          setMetrics(m);
          if (m.available) {
            let cpuTotal = 0;
            let memTotal = 0;
            for (const p of m.pods) {
              pushSample(history.cpu, `pod:${p.name}`, p.cpuMillis);
              pushSample(history.mem, `pod:${p.name}`, p.memoryBytes);
              cpuTotal += p.cpuMillis;
              memTotal += p.memoryBytes;
            }
            pushSample(history.cpu, `total:${namespace}`, cpuTotal);
            pushSample(history.mem, `total:${namespace}`, memTotal);
            for (const n of m.nodes) {
              pushSample(history.cpu, `node:${n.name}`, n.cpuMillis);
              pushSample(history.mem, `node:${n.name}`, n.memoryBytes);
            }
            setTick((t) => t + 1);
          }
        })
        .catch((e) => !cancelled && setError(String(e)));
    load();
    const t = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [provider, namespace, history]);

  // Node capacity in base units, from the overview (cpu cores, memory Ki).
  const nodeCapacity = useMemo(() => {
    const map = new Map<string, { cpuMillis: number; memBytes: number }>();
    for (const n of overview.nodes) {
      const cores = Number(n.cpu) || 0;
      const ki = /^(\d+)Ki$/.exec(n.memory)?.[1];
      map.set(n.name, { cpuMillis: cores * 1000, memBytes: ki ? Number(ki) * 1024 : 0 });
    }
    return map;
  }, [overview]);

  // Aggregate pod metrics up to their root workload.
  const workloadRows = useMemo(() => {
    if (!metrics?.available || !snapshot) return [];
    const byUid = new Map(snapshot.resources.map((r) => [r.uid, r]));
    const rootOf = (podName: string): string | null => {
      let current = snapshot.resources.find((r) => r.kind === "Pod" && r.name === podName);
      if (!current) return null;
      while (current.owners.length > 0 && byUid.has(current.owners[0].uid)) {
        current = byUid.get(current.owners[0].uid)!;
      }
      return `${current.kind}/${current.name}`;
    };
    const agg = new Map<string, { cpu: number; mem: number; pods: number }>();
    for (const p of metrics.pods) {
      const root = rootOf(p.name) ?? `Pod/${p.name}`;
      const entry = agg.get(root) ?? { cpu: 0, mem: 0, pods: 0 };
      entry.cpu += p.cpuMillis;
      entry.mem += p.memoryBytes;
      entry.pods += 1;
      agg.set(root, entry);
    }
    return [...agg.entries()].sort((a, b) => b[1].cpu - a[1].cpu);
  }, [metrics, snapshot]);

  if (error) return <div className="error-banner">{error}</div>;
  if (!metrics) return <EmptyMsg><p>Loading metrics…</p></EmptyMsg>;

  if (!metrics.available) {
    return (
      <div className="overview wide">
        <h2>Metrics</h2>
        <EmptyMsg>
          <p>{metrics.reason ?? "Metrics API is not available in this cluster."}</p>
          <p>
            K8s Visual reads <code>metrics.k8s.io</code> (the same API as <code>kubectl top</code>) and never
            invents numbers - install{" "}
            <a href="https://github.com/kubernetes-sigs/metrics-server" target="_blank" rel="noreferrer">
              metrics-server
            </a>{" "}
            to see live usage here.
          </p>
        </EmptyMsg>
      </div>
    );
  }

  const pods = [...metrics.pods].sort((a, b) => b.cpuMillis - a.cpuMillis);
  const cpuSeries = history.cpu.get(`total:${namespace}`) ?? [];
  const memSeries = history.mem.get(`total:${namespace}`) ?? [];

  return (
    <div className="overview wide" data-tick={tick}>
      <h2>
        Metrics <span className="h2-sub">- kubectl top with short-term history · {namespace}</span>
      </h2>
      <p className="about">
        Live usage from the Metrics API, sampled every 5s while the app is open. Trends cover only this session -
        K8s Visual does not fake historical data it doesn't have.
      </p>

      <div className="trend-cards">
        <div className="trend-card">
          <div className="trend-head">
            <span className="trend-label">Namespace CPU - all pods</span>
            {cpuSeries.length > 1 && <span className="trend-peak">peak {formatCpu(Math.max(...cpuSeries))}</span>}
          </div>
          <div className="trend-value">{cpuSeries.length > 0 ? formatCpu(cpuSeries[cpuSeries.length - 1]) : "-"}</div>
          <TrendChart series={cpuSeries} format={formatCpu} />
        </div>
        <div className="trend-card">
          <div className="trend-head">
            <span className="trend-label">Namespace memory - all pods</span>
            {memSeries.length > 1 && <span className="trend-peak">peak {formatBytes(Math.max(...memSeries))}</span>}
          </div>
          <div className="trend-value">{memSeries.length > 0 ? formatBytes(memSeries[memSeries.length - 1]) : "-"}</div>
          <TrendChart series={memSeries} format={formatBytes} />
        </div>
      </div>

      <h3>Nodes</h3>
      <table className="ns-table metrics-table">
        <thead>
          <tr>
            <th>Node</th>
            <th>CPU</th>
            <th>Memory</th>
            <th>Trend (CPU)</th>
          </tr>
        </thead>
        <tbody>
          {metrics.nodes.map((n) => {
            const cap = nodeCapacity.get(n.name);
            return (
              <tr key={n.name}>
                <td className="cell-name">{n.name}</td>
                <td>
                  <div className="cell-metric">{formatCpu(n.cpuMillis)}{cap ? ` / ${formatCpu(cap.cpuMillis)}` : ""}</div>
                  {cap && <Meter used={n.cpuMillis} capacity={cap.cpuMillis} label="" />}
                </td>
                <td>
                  <div className="cell-metric">{formatBytes(n.memoryBytes)}{cap ? ` / ${formatBytes(cap.memBytes)}` : ""}</div>
                  {cap && <Meter used={n.memoryBytes} capacity={cap.memBytes} label="" />}
                </td>
                <td>
                  <Sparkline series={history.cpu.get(`node:${n.name}`) ?? []} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {workloadRows.length > 0 && (
        <>
          <h3>Workloads (aggregated over their pods)</h3>
          <table className="ns-table metrics-table">
            <thead>
              <tr>
                <th>Workload</th>
                <th>Pods</th>
                <th>CPU</th>
                <th>Memory</th>
              </tr>
            </thead>
            <tbody>
              {workloadRows.map(([name, w]) => (
                <tr key={name}>
                  <td className="cell-name">{name}</td>
                  <td>{w.pods}</td>
                  <td>{formatCpu(w.cpu)}</td>
                  <td>{formatBytes(w.mem)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h3>Pods</h3>
      <table className="ns-table metrics-table">
        <thead>
          <tr>
            <th>Pod</th>
            <th>CPU</th>
            <th>Trend</th>
            <th>Memory</th>
            <th>Trend</th>
          </tr>
        </thead>
        <tbody>
          {pods.map((p) => (
            <tr key={p.name}>
              <td className="cell-name">{p.name}</td>
              <td>{formatCpu(p.cpuMillis)}</td>
              <td>
                <Sparkline series={history.cpu.get(`pod:${p.name}`) ?? []} />
              </td>
              <td>{formatBytes(p.memoryBytes)}</td>
              <td>
                <Sparkline series={history.mem.get(`pod:${p.name}`) ?? []} />
              </td>
            </tr>
          ))}
          {pods.length === 0 && (
            <tr>
              <td colSpan={5} style={{ color: "var(--muted)" }}>
                No pod metrics in {namespace}.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <KubectlHint command={KUBECTL_INTENT.top(namespace)} />
    </div>
  );
}
