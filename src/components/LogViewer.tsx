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

  const visible = filter ? lines.filter((l) => l.toLowerCase().includes(filter.toLowerCase())) : lines;
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

      <div className="log-pane" ref={scrollRef} onScroll={onPaneScroll}>
        {visible.length === 0 && <div className="log-line">(no log lines{filter ? " match the filter" : " yet"})</div>}
        {visible.map((line, i) => (
          <div key={i} className={lineClass(line)}>
            {line}
          </div>
        ))}
      </div>

      <KubectlHint command={kubectlCmd} />
    </div>
  );
}
