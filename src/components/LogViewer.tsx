import { useCallback, useEffect, useRef, useState } from "react";
import { KUBECTL_INTENT } from "../actions";
import type { ClusterProvider } from "../types";
import { KubectlHint } from "./bits";

export interface LogSource {
  pod: string;
  containers: string[];
}

interface Props {
  provider: ClusterProvider;
  namespace: string;
  sources: LogSource[];
  /** Aggregate across all sources by default (workload logs). */
  aggregate?: boolean;
}

const MAX_LINES = 2000;
const ALL_PODS = "(all pods)";

function lineClass(line: string): string {
  if (/\b(error|fatal|panic|exception|fail(ed|ure)?)\b/i.test(line)) return "log-line err";
  if (/\bwarn(ing)?\b/i.test(line)) return "log-line warn";
  return "log-line";
}

/** Health-check noise: kubelet probes and the conventional health endpoints. */
const PROBE_RE = /kube-probe|\/(healthz|readyz|livez)\b/i;

/** Stable per-pod accent (identity, always paired with the pod name text). */
function podSlot(pod: string): number {
  let h = 0;
  for (let i = 0; i < pod.length; i++) h = (h * 31 + pod.charCodeAt(i)) | 0;
  return (Math.abs(h) % 4) + 1;
}

/**
 * The visual `kubectl logs`: one-shot fetch or follow-stream, previous
 * container logs, container selection, aggregation across a workload's pods,
 * search filter, and error highlighting. Logs never leave the machine.
 */
export function LogViewer({ provider, namespace, sources, aggregate = false }: Props) {
  const multi = sources.length > 1;
  const [pod, setPod] = useState(aggregate && multi ? ALL_PODS : (sources[0]?.pod ?? ""));
  const [container, setContainer] = useState("");
  const [follow, setFollow] = useState(true);
  const [previous, setPrevious] = useState(false);
  const [timestamps, setTimestamps] = useState(false);
  const [tail, setTail] = useState(200);
  const [filter, setFilter] = useState("");
  const [hideProbes, setHideProbes] = useState(false);
  const [level, setLevel] = useState<"all" | "err" | "warn">("all");
  const [autoScroll, setAutoScroll] = useState(true);
  const [paused, setPaused] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const activeSources = pod === ALL_PODS ? sources : sources.filter((s) => s.pod === pod);
  const containerChoices = pod === ALL_PODS ? [] : (sources.find((s) => s.pod === pod)?.containers ?? []);

  const push = useCallback((line: string) => {
    if (pausedRef.current) return;
    setLines((prev) => {
      const next = prev.length >= MAX_LINES ? prev.slice(-MAX_LINES + 1) : prev.slice();
      next.push(line);
      return next;
    });
  }, []);

  // (Re)start fetching whenever the query shape changes.
  useEffect(() => {
    let cancelled = false;
    const stops: (() => void)[] = [];
    setLines([]);
    setError(null);
    const query = (p: string, c?: string) => ({
      namespace,
      pod: p,
      container: c || undefined,
      previous,
      tailLines: tail,
      timestamps,
    });
    (async () => {
      try {
        for (const src of activeSources) {
          const c = pod === ALL_PODS ? undefined : container || undefined;
          const prefix = pod === ALL_PODS ? `[${src.pod}] ` : "";
          if (previous || !follow) {
            const text = await provider.getLogs(query(src.pod, c));
            if (cancelled) return;
            for (const line of text.split("\n")) {
              if (line) push(prefix + line);
            }
          } else {
            const stop = await provider.streamLogs(query(src.pod, c), (line) => push(prefix + line));
            if (cancelled) {
              stop();
              return;
            }
            stops.push(stop);
          }
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
      for (const stop of stops) stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, namespace, pod, container, follow, previous, timestamps, tail, sources.map((s) => s.pod).join(",")]);

  // Terminal-style stickiness: while auto-scroll is on, pin to the newest
  // line; a manual scroll away from the bottom releases it, scrolling back
  // to the bottom re-engages it. Programmatic scrolls are flagged so they
  // don't count as "the user scrolled".
  const programmatic = useRef(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!autoScroll || !el) return;
    const target = el.scrollHeight - el.clientHeight;
    if (Math.abs(el.scrollTop - target) > 1) {
      programmatic.current = true;
      el.scrollTop = target;
    }
  }, [lines, autoScroll]);

  const onPaneScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    if (programmatic.current) {
      programmatic.current = false;
      return;
    }
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
    setAutoScroll(atBottom);
  };

  let visible = filter ? lines.filter((l) => l.toLowerCase().includes(filter.toLowerCase())) : lines;
  if (hideProbes) visible = visible.filter((l) => !PROBE_RE.test(l));
  if (level === "err") visible = visible.filter((l) => lineClass(l).includes("err"));
  if (level === "warn") visible = visible.filter((l) => lineClass(l).includes("warn"));

  // When probes dominate the stream, say so instead of letting them drown
  // the real logs.
  const probeNoise =
    !hideProbes &&
    level === "all" &&
    lines.length >= 20 &&
    lines.filter((l) => PROBE_RE.test(l)).length / lines.length > 0.5;
  const kubectlCmd = KUBECTL_INTENT.logs(
    namespace,
    pod === ALL_PODS ? `-l <workload selector>` : pod,
    container || undefined,
    { follow: follow && !previous, previous },
  );

  if (sources.length === 0) {
    return <p className="about">No pods to read logs from.</p>;
  }

  return (
    <div className="logviewer">
      <div className="log-toolbar">
        {(multi || aggregate) && (
          <select value={pod} onChange={(e) => { setPod(e.target.value); setContainer(""); }}>
            {aggregate && multi && <option value={ALL_PODS}>{ALL_PODS}</option>}
            {sources.map((s) => (
              <option key={s.pod} value={s.pod}>
                {s.pod}
              </option>
            ))}
          </select>
        )}
        {containerChoices.length > 1 && (
          <select value={container} onChange={(e) => setContainer(e.target.value)}>
            <option value="">all containers</option>
            {containerChoices.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        )}
        <label className="chk">
          <input type="checkbox" checked={follow && !previous} disabled={previous} onChange={(e) => setFollow(e.target.checked)} />
          follow
        </label>
        <label className="chk">
          <input type="checkbox" checked={previous} onChange={(e) => setPrevious(e.target.checked)} />
          previous
        </label>
        <label className="chk">
          <input type="checkbox" checked={timestamps} onChange={(e) => setTimestamps(e.target.checked)} />
          timestamps
        </label>
        <label className="chk tail">
          tail
          <input
            type="number"
            min={10}
            max={5000}
            value={tail}
            onChange={(e) => setTail(Number(e.target.value) || 200)}
          />
        </label>
        <button
          className={`chip${hideProbes ? " on" : ""}`}
          title="Hide kube-probe and /healthz /readyz /livez health-check lines"
          onClick={() => setHideProbes((v) => !v)}
        >
          hide probes
        </button>
        <button
          className={`chip${level === "err" ? " on" : ""}`}
          title="Show only lines that look like errors"
          onClick={() => setLevel((l) => (l === "err" ? "all" : "err"))}
        >
          errors only
        </button>
        <button
          className={`chip${level === "warn" ? " on" : ""}`}
          title="Show only lines that look like warnings"
          onClick={() => setLevel((l) => (l === "warn" ? "all" : "warn"))}
        >
          warnings only
        </button>
        <input
          className="search-box"
          type="search"
          placeholder="filter lines…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <div className="log-actions">
          <button className="chip" onClick={() => setPaused((p) => !p)} title={paused ? "Resume the stream" : "Stop appending new lines (the stream keeps running)"}>
            {paused ? "resume" : "pause"}
          </button>
          <button
            className={`chip${autoScroll ? " on" : ""}`}
            onClick={() => setAutoScroll((v) => !v)}
            title="Keep the newest line in view; scrolling up releases it"
          >
            auto-scroll
          </button>
          <button
            className="chip"
            title="Copy the visible lines"
            onClick={() => void navigator.clipboard.writeText(visible.join("\n"))}
          >
            copy
          </button>
          <button className="chip" title="Clear the console (new lines keep arriving)" onClick={() => setLines([])}>
            clear
          </button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {probeNoise && (
        <div className="issue-box log-noise">
          Most visible lines are kube-probe health checks.{" "}
          <button className="link-btn" onClick={() => setHideProbes(true)}>
            Hide kube-probe
          </button>{" "}
          to reduce noise.
        </div>
      )}

      <div className="log-pane" ref={scrollRef} onScroll={onPaneScroll}>
        {visible.length === 0 && (
          <div className="log-line">
            (no log lines{filter || hideProbes || level !== "all" ? " match the filters" : " yet"})
          </div>
        )}
        {visible.map((line, i) => {
          const m = /^\[([^\]]+)\] /.exec(line);
          return (
            <div key={i} className={lineClass(line)}>
              {m ? (
                <>
                  <span className={`log-pod pod-slot-${podSlot(m[1])}`}>[{m[1]}]</span> {line.slice(m[0].length)}
                </>
              ) : (
                line
              )}
            </div>
          );
        })}
      </div>

      <KubectlHint command={kubectlCmd} />
    </div>
  );
}
