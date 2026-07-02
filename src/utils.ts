import { inTauri } from "./providers/tauri";

/** Open a URL in the system browser (works in both Tauri and plain web). */
export async function openExternal(url: string): Promise<void> {
  if (inTauri()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener");
  }
}

/** "16258808Ki" -> "15.5 Gi" (falls back to the raw string). */
export function formatMemory(raw: string): string {
  const match = /^(\d+)Ki$/.exec(raw);
  if (!match) return raw;
  const gi = Number(match[1]) / 1024 / 1024;
  return `${gi >= 10 ? Math.round(gi) : gi.toFixed(1)} Gi`;
}

export type Theme = "light" | "dark";

export function initialTheme(): Theme {
  const param = new URLSearchParams(window.location.search).get("theme");
  if (param === "light" || param === "dark") return param;
  const stored = localStorage.getItem("theme");
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("theme", theme);
}
