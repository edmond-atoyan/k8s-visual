import { useEffect, useState } from "react";
import { inTauri } from "../providers/tauri";

type TauriWindow = Awaited<ReturnType<typeof winModule>>["win"];

async function winModule() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return { win: getCurrentWindow() };
}

/**
 * App-drawn window controls for the undecorated desktop window (the title bar
 * itself is the drag region). Renders nothing in plain-browser demo mode,
 * where the OS still owns the window chrome.
 */
export function WindowControls() {
  const shell = inTauri();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!shell) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let win: TauriWindow | undefined;

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "F11" || !win) return;
      e.preventDefault();
      const w = win;
      void w.isFullscreen().then((full) => w.setFullscreen(!full));
    };

    void winModule().then(async ({ win: w }) => {
      win = w;
      const update = () => void w.isMaximized().then((m) => !disposed && setMaximized(m));
      update();
      const off = await w.onResized(update);
      if (disposed) off();
      else unlisten = off;
    });
    window.addEventListener("keydown", onKey);
    return () => {
      disposed = true;
      unlisten?.();
      window.removeEventListener("keydown", onKey);
    };
  }, [shell]);

  if (!shell) return null;

  const invoke = (method: "minimize" | "toggleMaximize" | "close") => () =>
    void winModule().then(({ win }) => win[method]());

  return (
    <div className="win-controls">
      <button className="win-btn" onClick={invoke("minimize")} title="Minimize" aria-label="Minimize window">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden>
          <path d="M3.5 8.5h9" />
        </svg>
      </button>
      <button
        className="win-btn"
        onClick={invoke("toggleMaximize")}
        title={maximized ? "Restore" : "Maximize"}
        aria-label={maximized ? "Restore window" : "Maximize window"}
      >
        {maximized ? (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden>
            <rect x="3.5" y="5.5" width="7" height="7" rx="0.5" />
            <path d="M5.5 5.5v-2h7v7h-2" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden>
            <rect x="3.5" y="3.5" width="9" height="9" rx="0.5" />
          </svg>
        )}
      </button>
      <button className="win-btn win-close" onClick={invoke("close")} title="Close" aria-label="Close window">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden>
          <path d="m4 4 8 8M12 4l-8 8" />
        </svg>
      </button>
    </div>
  );
}
