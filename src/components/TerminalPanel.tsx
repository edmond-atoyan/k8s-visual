import { useCallback, useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";

import { AI_TOOL_LINKS, analyzeCommand, kubectlPrefix, type AiToolStatus } from "../ai";
import { inTauri } from "../providers/tauri";
import type { ClusterInfo } from "../types";
import { cloudTag, openExternal, type Theme } from "../utils";
import { AiLogo, Icon } from "./icons";

export interface TerminalPanelProps {
  visible: boolean;
  cluster: ClusterInfo;
  mode: "live" | "demo";
  namespace: string;
  management: boolean;
  theme: Theme;
  aiTools: AiToolStatus[] | null;
  /** Text to type into the shell (NOT executed - the user reviews and hits Enter). */
  pendingInput: string | null;
  /** Show install instructions for a missing tool (set by quick actions elsewhere). */
  pendingHint: "codex" | "claude" | null;
  onConsumedInput(): void;
  onConsumedHint(): void;
  onClose(): void;
}

/** Full 16-color ANSI palette per theme, harmonized with the app tokens, so
 *  prompts, ls, git and TUI apps render with real color hierarchy. */
function xtermTheme(theme: Theme) {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim() || undefined;
  const dark = theme === "dark";
  return {
    background: v("--inset"),
    foreground: dark ? "#d6d5cd" : "#33322f",
    cursor: v("--ink"),
    cursorAccent: v("--inset"),
    selectionBackground: dark ? "#3d4c63" : "#bcd5f2",
    black: dark ? "#3a3937" : "#4a4945",
    red: dark ? "#e5716a" : "#c73e36",
    green: dark ? "#4cb85f" : "#1a7f37",
    yellow: dark ? "#d9a521" : "#9a6700",
    blue: dark ? "#539bf5" : "#2a78d6",
    magenta: dark ? "#c885de" : "#8f4bab",
    cyan: dark ? "#39b3a7" : "#127e74",
    white: dark ? "#c3c2b7" : "#83817b",
    brightBlack: dark ? "#6e6c66" : "#6e6c66",
    brightRed: dark ? "#f0938d" : "#a4231c",
    brightGreen: dark ? "#6fd082" : "#0f5d28",
    brightYellow: dark ? "#eebf4d" : "#7a5200",
    brightBlue: dark ? "#7cb4f8" : "#1c5cab",
    brightMagenta: dark ? "#dcabee" : "#6f3388",
    brightCyan: dark ? "#61d0c4" : "#0b6159",
    brightWhite: dark ? "#f2f1ee" : "#131312",
  };
}

interface SessionProps {
  show: boolean;
  cluster: ClusterInfo;
  namespace: string;
  management: boolean;
  theme: Theme;
  pendingInput: string | null;
  onConsumedInput(): void;
}

/**
 * One PTY-backed shell session. The renderer is WebGL (same approach as
 * VS Code) with a DOM fallback, line-height 1.0 and custom glyphs so
 * full-screen TUI apps (top, htop) and box-drawing characters render like a
 * native terminal; the alternate screen buffer, cursor addressing and
 * SIGWINCH resizing all come from xterm.js + the real PTY underneath.
 */
function TermSession({ show, cluster, namespace, management, theme, pendingInput, onConsumedInput }: SessionProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<number | null>(null);
  const [ready, setReady] = useState(false);
  const lineBuf = useRef("");
  const trackable = useRef(true);
  const [guard, setGuard] = useState<null | { blocked: boolean; command: string; reason: string }>(null);
  const guardRef = useRef(guard);
  guardRef.current = guard;
  const managementRef = useRef(management);
  managementRef.current = management;

  const send = useCallback((data: string) => {
    const id = sessionRef.current;
    if (id !== null) void invoke("term_write", { id, data });
  }, []);

  useEffect(() => {
    if (!inTauri() || !hostRef.current || termRef.current) return;
    const term = new Terminal({
      fontFamily: '"Cascadia Mono", "JetBrains Mono", "Fira Code", "Ubuntu Mono", ui-monospace, monospace',
      fontSize: 13,
      lineHeight: 1.0, // exact cell grid - box drawing and TUI layouts stay seamless
      letterSpacing: 0,
      fontWeightBold: "600",
      cursorBlink: true,
      cursorStyle: "block",
      scrollback: 8000,
      customGlyphs: true, // pixel-perfect box-drawing/block characters
      theme: xtermTheme(theme),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    // GPU renderer: no per-row DOM repaints (the DOM renderer visibly
    // flickers under fast TUI redraws). Falls back to DOM if WebGL is gone.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      /* DOM renderer fallback */
    }
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    const updateBuf = (data: string) => {
      for (const ch of data) {
        if (ch === "\r" || ch === "\n") {
          lineBuf.current = "";
          trackable.current = true;
        } else if (ch === "\x7f") {
          lineBuf.current = lineBuf.current.slice(0, -1);
        } else if (ch >= " ") {
          lineBuf.current += ch;
        } else {
          // control chars / escape sequences: the line can no longer be
          // reconstructed - fail open until the next Enter.
          lineBuf.current = "";
          trackable.current = false;
        }
      }
    };

    const channel = new Channel<string>();
    channel.onmessage = (chunk) => term.write(chunk);
    void invoke<number>("term_open", {
      cols: term.cols,
      rows: term.rows,
      env: [
        ["K8S_VISUAL_CONTEXT", cluster.context],
        ["K8S_VISUAL_NAMESPACE", namespace],
      ],
      onData: channel,
    })
      .then((id) => {
        sessionRef.current = id;
        setReady(true);
      })
      .catch((e) => term.writeln(`could not start a shell: ${e}`));

    term.onData((data) => {
      if (guardRef.current) return; // input held while the guard bar is up
      if (data === "\r" && trackable.current) {
        const risk = analyzeCommand(lineBuf.current);
        if (risk) {
          setGuard({ blocked: !managementRef.current, command: lineBuf.current, reason: risk.reason });
          return;
        }
      }
      updateBuf(data);
      send(data);
    });

    const ro = new ResizeObserver(() => {
      fit.fit();
      const id = sessionRef.current;
      if (id !== null) void invoke("term_resize", { id, cols: term.cols, rows: term.rows });
    });
    ro.observe(hostRef.current);

    return () => {
      ro.disconnect();
      const id = sessionRef.current;
      if (id !== null) void invoke("term_close", { id });
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = xtermTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (show && termRef.current && fitRef.current) {
      fitRef.current.fit();
      termRef.current.focus();
    }
  }, [show]);

  // Quick actions type text into the shell without executing it.
  useEffect(() => {
    if (!show || pendingInput === null || !ready) return;
    send(pendingInput);
    lineBuf.current = "";
    trackable.current = false; // multi-line paste - don't guess the line
    termRef.current?.focus();
    onConsumedInput();
  }, [show, pendingInput, ready, send, onConsumedInput]);

  return (
    <div className="terminal-session" style={{ display: show ? undefined : "none" }}>
      {guard && (
        <div className={`terminal-guard ${guard.blocked ? "blocked" : ""}`}>
          <span className="term-guard-msg">
            {guard.blocked ? (
              <>
                Held: <code>{guard.command}</code> {guard.reason}. The app is in read-only mode - enable
                management in the title bar to run cluster-changing commands from here.
              </>
            ) : (
              <>
                This command {guard.reason}: <code>{guard.command}</code>
              </>
            )}
          </span>
          {!guard.blocked && (
            <button
              className="btn primary risk-danger"
              onClick={() => {
                setGuard(null);
                lineBuf.current = "";
                send("\r");
              }}
            >
              Run anyway
            </button>
          )}
          <button
            className="btn"
            onClick={() => {
              setGuard(null);
              lineBuf.current = "";
              send("\x03"); // ctrl-c: abandon the held line, fresh prompt
            }}
          >
            Cancel
          </button>
        </div>
      )}
      <div className="terminal-body" ref={hostRef} />
    </div>
  );
}

/**
 * The terminal drawer: tabbed shell sessions with the app's connection
 * context in the header. Metadata is rendered as quiet tags; actions are
 * real buttons. Sessions stay alive while hidden.
 */
export function TerminalPanel({
  visible,
  cluster,
  mode,
  namespace,
  management,
  theme,
  aiTools,
  pendingInput,
  pendingHint,
  onConsumedInput,
  onConsumedHint,
  onClose,
}: TerminalPanelProps) {
  const [height, setHeight] = useState(300);
  const [sessions, setSessions] = useState<number[]>([1]);
  const [active, setActive] = useState(1);
  const nextKey = useRef(2);
  const [copied, setCopied] = useState(false);

  const addSession = () => {
    const key = nextKey.current++;
    setSessions((s) => [...s, key]);
    setActive(key);
  };
  const closeSession = (key: number) => {
    setSessions((s) => {
      const rest = s.filter((k) => k !== key);
      if (rest.length === 0) {
        onClose();
        return [nextKey.current++]; // fresh session next time the drawer opens
      }
      if (key === active) setActive(rest[rest.length - 1]);
      return rest;
    });
  };

  const onDragStart = (e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    const move = (ev: PointerEvent) => setHeight(Math.min(620, Math.max(150, startH + (startY - ev.clientY))));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const tag = cloudTag(cluster.context, cluster.server);
  const provider = mode === "demo" ? "demo" : (tag?.provider ?? "local");
  const copyPrefix = () => {
    void navigator.clipboard.writeText(kubectlPrefix(cluster.context, namespace));
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  const [installHint, setInstallHint] = useState<AiToolStatus | null>(null);
  useEffect(() => {
    if (pendingHint === null) return;
    const tool = (aiTools ?? []).find((t) => t.id === pendingHint);
    if (tool) setInstallHint(tool);
    onConsumedHint();
  }, [pendingHint, aiTools, onConsumedHint]);
  const openTool = (tool: AiToolStatus) => {
    if (!tool.installed) {
      setInstallHint(tool); // friendly pointer instead of a shell error
      return;
    }
    setInstallHint(null);
    onConsumedInput(); // drop any stale pending input
    // Typed with Enter: launching the tool is the explicit user action here.
    void invokeActive(`${tool.id}\r`);
  };
  // Route ad-hoc writes to the active session through the pending-input path.
  const [toolInput, setToolInput] = useState<string | null>(null);
  const invokeActive = async (data: string) => setToolInput(data);
  const combinedInput = toolInput ?? pendingInput;
  const consumeCombined = () => {
    if (toolInput !== null) setToolInput(null);
    else onConsumedInput();
  };

  return (
    <section
      className="terminal-drawer"
      style={{ height, display: visible ? undefined : "none" }}
      aria-label="Integrated terminal"
    >
      <div className="terminal-resize" onPointerDown={onDragStart} />
      <div className="terminal-head">
        <Icon name="terminal-panel" size={13} />
        <span className="term-title">Terminal</span>

        <div className="term-tabs" role="tablist">
          {sessions.map((key, i) => (
            <span key={key} className={`term-tab${key === active ? " active" : ""}`}>
              <button role="tab" aria-selected={key === active} onClick={() => setActive(key)}>
                shell {i + 1}
              </button>
              <button
                className="term-tab-close"
                title="Close session"
                aria-label={`Close shell ${i + 1}`}
                onClick={() => closeSession(key)}
              >
                <Icon name="close" size={9} />
              </button>
            </span>
          ))}
          <button className="term-btn term-add" title="Add terminal" aria-label="Add terminal" onClick={addSession}>
            <Icon name="plus" size={12} />
          </button>
        </div>

        <span className={`term-tag ${provider === "demo" ? "term-demo" : "term-provider"}`}>{provider}</span>
        <span className="term-tag" title={cluster.server}>
          {cluster.context}
        </span>
        <span className="term-tag">ns: {namespace}</span>
        <span
          className={`term-tag ${management ? "term-mgmt" : ""}`}
          title="The app's mode. The shell itself is your own and is never restricted - dangerous kubectl commands are held for confirmation as a best-effort guard."
        >
          {management ? "management" : "read-only"}
        </span>

        <span className="term-spacer" />

        <button
          className="term-btn"
          disabled={mode === "demo"}
          title={
            mode === "demo"
              ? "The demo cluster is not reachable via kubectl"
              : "Copy a kubectl prefix pinned to this context and namespace"
          }
          onClick={copyPrefix}
        >
          {copied ? "copied" : "copy kubectl prefix"}
        </button>
        {(aiTools ?? []).map((tool) => (
          <button
            key={tool.id}
            className={`term-btn term-ai${tool.installed ? "" : " missing"}`}
            aria-label={tool.name}
            title={
              tool.installed
                ? `Open ${tool.name} in the active session${tool.version ? ` (${tool.version})` : ""}. Nothing is sent automatically.`
                : `${tool.name} is not installed - click for install instructions`
            }
            onClick={() => openTool(tool)}
          >
            <AiLogo tool={tool.id} size={15} />
          </button>
        ))}
        <button className="icon-btn" title="Hide terminal (Ctrl+`)" aria-label="Hide terminal" onClick={onClose}>
          <Icon name="close" size={13} />
        </button>
      </div>

      {mode === "demo" && (
        <div className="term-note-row">
          shell runs on this machine - the demo cluster only exists inside the app
        </div>
      )}

      {installHint && (
        <div className="term-install-hint">
          <AiLogo tool={installHint.id} size={14} />
          <span className="term-guard-msg">
            <strong>{installHint.name}</strong> is not installed on this machine. Install it, then reopen
            the terminal - the button lights up automatically once it is on your PATH.
          </span>
          <button
            className="btn primary"
            onClick={() => void openExternal(AI_TOOL_LINKS[installHint.id])}
          >
            Get {installHint.name} ↗
          </button>
          <button className="btn" onClick={() => setInstallHint(null)}>
            Dismiss
          </button>
        </div>
      )}

      {inTauri() ? (
        sessions.map((key) => (
          <TermSession
            key={key}
            show={visible && key === active}
            cluster={cluster}
            namespace={namespace}
            management={management}
            theme={theme}
            pendingInput={key === active ? combinedInput : null}
            onConsumedInput={consumeCombined}
          />
        ))
      ) : new URLSearchParams(window.location.search).has("termmock") ? (
        // Docs/screenshot stand-in for the real PTY (browser demo only): shows
        // what a session looks like without pretending a browser can host one.
        <pre className="terminal-body term-mock" aria-hidden>
          <span className="tm-p">user@demo</span>:<span className="tm-d">~</span>$ kubectl --context demo-cluster
          -n demo-shop get pods{"\n"}
          NAME                          READY   STATUS             RESTARTS   AGE{"\n"}
          api-6b5c974d8f-fj2sm          1/1     <span className="tm-ok">Running</span>            0          26h{"\n"}
          api-6b5c974d8f-qw8rt          0/1     <span className="tm-err">CrashLoopBackOff</span>   17         26h{"\n"}
          storefront-7d9fc6b48-8kd4n    1/1     <span className="tm-ok">Running</span>            0          40d{"\n"}
          <span className="tm-p">user@demo</span>:<span className="tm-d">~</span>$ <span className="tm-cursor">▊</span>
        </pre>
      ) : (
        <div className="terminal-placeholder">
          The integrated terminal needs the desktop app - a browser tab cannot host a shell.
        </div>
      )}
    </section>
  );
}

export default TerminalPanel;
