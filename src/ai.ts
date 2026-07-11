// AI CLI integration: tool detection, sanitized context building, and
// command risk analysis. Deliberately separate from the Kubernetes provider
// logic. Safety model:
//   - nothing is ever sent to an AI tool automatically; every hand-off is an
//     explicit user action, and commands are typed into the terminal WITHOUT
//     being executed so the user reviews them first
//   - summaries never include Secret values, annotations, tokens,
//     certificates, kubeconfig contents, or environment variables
//   - log excerpts pass through redactSecrets() before leaving the app

import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "./providers/tauri";
import type { EventInfo, ResourceSummary } from "./types";

export type AiToolId = "codex" | "claude" | "gemini" | "ollama";

/** Tools that can be launched directly in the terminal with a typed prompt
 *  (Ollama needs a model choice first, so it is handled separately). */
export const DIRECT_TOOLS: AiToolId[] = ["codex", "claude", "gemini"];

export interface AiToolStatus {
  id: AiToolId;
  name: string;
  installed: boolean;
  version?: string;
}

const NOT_AVAILABLE: AiToolStatus[] = [
  { id: "codex", name: "Codex CLI", installed: false },
  { id: "claude", name: "Claude Code", installed: false },
  { id: "gemini", name: "Gemini CLI", installed: false },
  { id: "ollama", name: "Ollama", installed: false },
];

/** Where to get each tool - shown when the user clicks one that is missing. */
export const AI_TOOL_LINKS: Record<AiToolId, string> = {
  claude: "https://claude.com/claude-code",
  codex: "https://github.com/openai/codex",
  gemini: "https://github.com/google-gemini/gemini-cli",
  ollama: "https://ollama.com",
};

/** Detect installed AI CLIs (desktop app only; detection never sends data). */
export async function detectAiTools(): Promise<AiToolStatus[]> {
  if (!inTauri()) return NOT_AVAILABLE;
  try {
    return await invoke<AiToolStatus[]>("detect_ai_tools");
  } catch {
    return NOT_AVAILABLE;
  }
}

// --- sanitized context ---------------------------------------------------------

/** Values that must never leave the app in logs shared with an AI tool. */
const SECRET_PATTERNS: [RegExp, string][] = [
  // key=value / key: value credential assignments
  [/\b(password|passwd|pwd|token|secret|api[-_]?key|access[-_]?key|auth)\b(\s*[=:]\s*)\S+/gi, "$1$2[REDACTED]"],
  // bearer / basic auth headers
  [/\b(bearer|basic)\s+[A-Za-z0-9+/._=-]{8,}/gi, "$1 [REDACTED]"],
  // AWS access key ids
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED-AWS-KEY]"],
  // JWTs
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED-JWT]"],
  // PEM blocks
  [/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, "[REDACTED-PEM]"],
];

/** Best-effort credential scrubbing for log lines shared with AI tools. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * A safe, human-readable summary of one resource: identity, status,
 * conditions, containers, relationships, diagnostics, recent events.
 * Never includes Secret values (Secret details only carry key names/sizes by
 * construction), annotations, or anything credential-shaped.
 */
export function buildResourceSummary(
  r: ResourceSummary,
  issues: string[] = [],
  events: EventInfo[] = [],
): string {
  const lines: string[] = [
    "Kubernetes resource summary (sanitized - no secret values):",
    `kind: ${r.kind}`,
    `name: ${r.name}`,
    `namespace: ${r.namespace || "(cluster-scoped)"}`,
    `status: ${r.status} (health: ${r.health})`,
  ];
  if (r.createdAt) lines.push(`created: ${r.createdAt}`);
  if (r.owners.length > 0) {
    lines.push(`owned by: ${r.owners.map((o) => `${o.kind}/${o.name}`).join(", ")}`);
  }
  const details = Object.entries(r.details);
  if (details.length > 0) {
    lines.push("details:");
    for (const [k, v] of details) lines.push(`  ${k}: ${v}`);
  }
  for (const c of r.containers ?? []) {
    lines.push(
      `container ${c.name}: image=${c.image} ready=${c.ready} restarts=${c.restarts} state=${c.state}${c.lastState ? ` last=${c.lastState}` : ""}`,
    );
  }
  for (const c of r.conditions ?? []) {
    lines.push(`condition ${c.type}=${c.status}${c.reason ? ` reason=${c.reason}` : ""}${c.message ? ` (${c.message})` : ""}`);
  }
  for (const issue of issues) lines.push(`diagnostic: ${issue}`);
  for (const e of events.slice(0, 5)) {
    lines.push(`event [${e.type}] ${e.reason} x${e.count}: ${redactSecrets(e.message)}`);
  }
  return lines.join("\n");
}

/** Single-quote a string for POSIX shells. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command typed (NOT executed) into the terminal for "ask AI about this
 * resource". The user reviews and presses Enter themselves.
 */
export function askAiCommand(tool: AiToolId, summary: string): string {
  const prompt =
    `${summary}\n\n` +
    "Explain the likely problem and how to investigate with kubectl. " +
    "Suggest commands but do not run anything cluster-changing without asking.";
  return `${tool} ${shellQuote(prompt)}`;
}

/** The kubectl prefix matching the app's active connection - for copy/paste. */
export function kubectlPrefix(context: string, namespace: string): string {
  return `kubectl --context ${context} --namespace ${namespace} `;
}

// --- command risk analysis --------------------------------------------------------

export interface CommandRisk {
  reason: string;
}

const DANGEROUS: [RegExp, string][] = [
  [/\bkubectl\b[^|;&]*\bdelete\b[^|;&]*\b(namespace|ns)\b/, "deletes a namespace and everything in it"],
  [/\bkubectl\b[^|;&]*\bdelete\b[^|;&]*\b(pvc|persistentvolumeclaims?|pv|persistentvolumes?)\b/, "deletes persistent storage - data may be lost"],
  [/\bkubectl\b[^|;&]*\bdelete\b[^|;&]*\bsecrets?\b/, "deletes a Secret"],
  [/\bkubectl\b[^|;&]*\bdelete\b[^|;&]*(--force|--grace-period[= ]?0)/, "force-deletes without graceful shutdown"],
  [/\bkubectl\b[^|;&]*\bdelete\b[^|;&]*--all\b/, "deletes every resource of that kind"],
  [/\bkubectl\b[^|;&]*\bdelete\b/, "deletes a live resource"],
  [/\bkubectl\b[^|;&]*\bdrain\b/, "drains a node - evicts every pod on it"],
  [/\bkubectl\b[^|;&]*\bapply\b/, "applies YAML to the live cluster"],
  [/\bkubectl\b[^|;&]*\breplace\b/, "replaces a live resource"],
  [/\bkubectl\b[^|;&]*\bedit\b/, "edits a live resource"],
  [/\bhelm\b[^|;&]*\b(uninstall|delete|rollback)\b/, "changes a Helm release"],
];

/**
 * Best-effort detection of cluster-changing commands typed into the
 * integrated terminal. Used to warn (management mode) or hold (read-only
 * mode) before the Enter key is forwarded. This is a guard rail, not a
 * sandbox - the shell itself is never restricted.
 */
export function analyzeCommand(command: string): CommandRisk | null {
  const cmd = command.trim();
  if (cmd === "") return null;
  for (const [pattern, reason] of DANGEROUS) {
    if (pattern.test(cmd)) return { reason };
  }
  return null;
}
