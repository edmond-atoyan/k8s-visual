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

/** Bytes -> human readable ("1.4 Gi", "512 Mi"). */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} Gi`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} Mi`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} Ki`;
  return `${bytes} B`;
}

/** Millicores -> "250m" or "1.5 cores". */
export function formatCpu(millis: number): string {
  if (millis >= 1000) return `${(millis / 1000).toFixed(1)} cores`;
  return `${millis}m`;
}

/** ISO timestamp -> compact age like kubectl ("2d", "5h", "3m", "12s"). */
export function formatAge(iso?: string): string {
  if (!iso) return "-";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "-";
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** ISO timestamp -> local "HH:MM:SS" for timelines. */
export function formatClock(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString();
}

// --- diff --------------------------------------------------------------------

export type DiffLine = { type: "same" | "add" | "del"; text: string };

/**
 * Minimal line diff (LCS) for YAML previews. Fine for config-sized inputs;
 * not meant for huge files.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  // LCS table (n and m are small for YAML documents).
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "same", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ type: "del", text: a[i] });
      i++;
    } else {
      out.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ type: "del", text: a[i++] });
  while (j < m) out.push({ type: "add", text: b[j++] });
  return out;
}

// --- cloud context detection ----------------------------------------------------

export interface CloudTag {
  provider: "EKS" | "AKS" | "GKE";
  label: string;
  /** Region / project hint parsed from the context, when available. */
  detail?: string;
}

/**
 * Identify which managed cloud a kubeconfig context/server belongs to, so the
 * UI can always show the active platform (title bar, status bar, and every
 * action confirmation). Pure string inspection - never calls the cloud.
 */
export function cloudTag(context: string, server = ""): CloudTag | null {
  const arn = /^arn:aws:eks:([a-z0-9-]+):\d+:cluster\/(.+)$/.exec(context);
  if (arn) return { provider: "EKS", label: "Amazon EKS", detail: arn[1] };
  const gke = /^gke_([^_]+)_([^_]+)_.+$/.exec(context);
  if (gke) return { provider: "GKE", label: "Google GKE", detail: `${gke[1]} · ${gke[2]}` };
  if (server.includes(".eks.amazonaws.com")) return { provider: "EKS", label: "Amazon EKS" };
  if (server.includes(".azmk8s.io")) return { provider: "AKS", label: "Azure AKS" };
  return null;
}

// --- theme ---------------------------------------------------------------------

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
