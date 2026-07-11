// The built-in troubleshooting assistant. Free and local by construction:
// answers are composed deterministically from the problem-chain engine and
// live cluster state - evidence-based, instant, offline, never paywalled.
// External AI CLIs (Claude/Codex/Gemini/Ollama) are optional extensions that
// receive a sanitized, user-previewed payload and never anything automatic.

import { buildResourceSummary, redactSecrets } from "./ai";
import type { ProblemChain } from "./chains";
import { KIND_INFO } from "./kindInfo";
import type { ClusterInfo, ResourceSummary } from "./types";

export interface AssistantAnswer {
  title: string;
  /** Short diagnosis, evidence-based; each entry is one paragraph. */
  diagnosis: string[];
  /** Chains backing the diagnosis (rendered as cards with checks). */
  chains: ProblemChain[];
  /** Extra verification commands beyond the chains' own checks. */
  checks: string[];
}

/** Namespace health at a glance: counts, symptoms, and the problem chains. */
export function summarizeNamespace(
  namespace: string,
  resources: ResourceSummary[],
  chains: ProblemChain[],
): AssistantAnswer {
  const pods = resources.filter((r) => r.kind === "Pod");
  const failing = resources.filter((r) => r.health === "critical");
  const degraded = resources.filter((r) => r.health === "warning");
  const pending = pods.filter((p) => p.status === "Pending");
  const restarts = pods.reduce(
    (n, p) => n + (p.containers ?? []).reduce((m, c) => m + c.restarts, 0),
    0,
  );

  const diagnosis: string[] = [];
  diagnosis.push(
    `Namespace "${namespace}" has ${resources.length} resources, ${pods.length} of them Pods` +
      (pending.length > 0 ? ` (${pending.length} Pending)` : "") +
      (restarts > 0 ? `, ${restarts} container restarts recorded` : "") +
      ".",
  );
  if (failing.length === 0 && degraded.length === 0) {
    diagnosis.push("Everything reports healthy. No failing or degraded resources right now.");
  } else {
    if (failing.length > 0) {
      diagnosis.push(
        `Failing: ${failing.map((r) => `${r.kind}/${r.name} (${r.status})`).join(", ")}.`,
      );
    }
    if (degraded.length > 0) {
      diagnosis.push(
        `Degraded: ${degraded.map((r) => `${r.kind}/${r.name} (${r.status})`).join(", ")}.`,
      );
    }
    if (chains.length > 0) {
      diagnosis.push(
        `${chains.length} problem ${chains.length === 1 ? "chain" : "chains"} identified below - each with its likely root cause and the kubectl commands to verify it.`,
      );
    }
  }

  return {
    title: `Namespace health: ${namespace}`,
    diagnosis,
    chains,
    checks: [`kubectl get all -n ${namespace}`, `kubectl get events -n ${namespace} --sort-by=.lastTimestamp`],
  };
}

/** Explain one resource: what it is, its state, and any chain it sits on. */
export function explainResource(
  resource: ResourceSummary,
  issues: string[],
  chains: ProblemChain[],
): AssistantAnswer {
  const meta = KIND_INFO[resource.kind];
  const ns = resource.namespace || "default";
  const diagnosis: string[] = [];

  diagnosis.push(
    `${resource.kind}/${resource.name} is currently "${resource.status}" (${resource.health}). ${meta.what}`,
  );
  if (issues.length > 0) {
    diagnosis.push(`Diagnostics: ${issues.join(" ")}`);
  }
  if (chains.length > 0) {
    diagnosis.push(
      "It participates in the problem " +
        (chains.length === 1 ? "chain" : "chains") +
        " below - the root cause is likely elsewhere on the path, not on this resource itself.",
    );
  } else if (resource.health === "good" || resource.health === "neutral") {
    diagnosis.push("No problems detected for this resource right now.");
  } else {
    diagnosis.push(`Typical causes for this state: ${meta.problems}`);
  }

  return {
    title: `${resource.kind}/${resource.name}`,
    diagnosis,
    chains,
    checks: [
      `kubectl describe ${resource.kind.toLowerCase()} ${resource.name} -n ${ns}`,
      `kubectl get events -n ${ns} --field-selector involvedObject.name=${resource.name}`,
    ],
  };
}

/**
 * The exact sanitized text handed to an external AI tool - always shown to
 * the user before anything is typed into the terminal. Contains no Secret
 * values, annotations, tokens, or kubeconfig material; log excerpts (if the
 * caller includes any) must already be redacted.
 */
export function buildSharePayload(opts: {
  cluster: ClusterInfo;
  mode: "live" | "demo";
  namespace: string;
  answer: AssistantAnswer;
  resource?: ResourceSummary | null;
  issues?: string[];
}): string {
  const lines: string[] = [
    "Kubernetes troubleshooting context (sanitized - no secret values):",
    `cluster context: ${opts.cluster.context}${opts.mode === "demo" ? " (demo cluster)" : ""}`,
    `namespace: ${opts.namespace}`,
    "",
  ];
  if (opts.resource) {
    lines.push(buildResourceSummary(opts.resource, opts.issues ?? []), "");
  }
  for (const chain of opts.answer.chains) {
    lines.push(`problem: ${chain.title}`);
    lines.push(`  path: ${chain.chain.map((l) => `${l.kind}/${l.name} (${l.note})`).join(" -> ")}`);
    lines.push(`  likely root cause: ${chain.rootCause}`);
    for (const e of chain.evidence) lines.push(`  evidence: ${redactSecrets(e)}`);
    lines.push("");
  }
  lines.push(
    "Question: explain the root cause and how to fix it. Suggest kubectl commands to verify. " +
      "Do not run anything cluster-changing without asking.",
  );
  return lines.join("\n");
}
