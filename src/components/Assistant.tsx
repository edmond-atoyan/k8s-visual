import { useMemo, useState } from "react";
import { AI_TOOL_LINKS, askAiCommand, DIRECT_TOOLS, type AiToolId, type AiToolStatus } from "../ai";
import { buildSharePayload, explainResource, summarizeNamespace, type AssistantAnswer } from "../assistant";
import type { ProblemChain } from "../chains";
import type { ClusterInfo, ResourceSummary } from "../types";
import { openExternal } from "../utils";
import { AiLogo, Icon } from "./icons";
import { ProblemChainList } from "./ProblemChains";

interface Props {
  cluster: ClusterInfo;
  mode: "live" | "demo";
  namespace: string;
  resources: ResourceSummary[];
  chains: ProblemChain[];
  selected: ResourceSummary | null;
  selectedIssues: string[];
  aiTools: AiToolStatus[] | null;
  onSelectResource(uid: string): void;
  /** Type a command into the integrated terminal (never executed automatically). */
  onHandOff(command: string): void;
  onInstallHint(tool: AiToolId): void;
  onClose(): void;
}

/**
 * The built-in troubleshooting assistant. The analysis itself is local,
 * instant, and free - composed from the problem-chain engine and live state,
 * with every claim traceable to cluster data. External AI CLIs are optional:
 * the exact sanitized payload is shown before anything is handed over, and
 * commands are typed into the terminal for review, never run.
 */
export function Assistant({
  cluster,
  mode,
  namespace,
  resources,
  chains,
  selected,
  selectedIssues,
  aiTools,
  onSelectResource,
  onHandOff,
  onInstallHint,
  onClose,
}: Props) {
  const selectedChains = useMemo(
    () =>
      selected
        ? chains.filter((c) => c.affected.uid === selected.uid || c.chain.some((l) => l.uid === selected.uid))
        : [],
    [chains, selected],
  );

  const [question, setQuestion] = useState<"resource" | "namespace">(selected ? "resource" : "namespace");
  const [showPayload, setShowPayload] = useState(false);

  const answer: AssistantAnswer = useMemo(
    () =>
      question === "resource" && selected
        ? explainResource(selected, selectedIssues, selectedChains)
        : summarizeNamespace(namespace, resources, chains),
    [question, selected, selectedIssues, selectedChains, namespace, resources, chains],
  );

  const payload = useMemo(
    () =>
      buildSharePayload({
        cluster,
        mode,
        namespace,
        answer,
        resource: question === "resource" ? selected : null,
        issues: selectedIssues,
      }),
    [cluster, mode, namespace, answer, question, selected, selectedIssues],
  );

  const tools = aiTools ?? [];
  const ollama = tools.find((t) => t.id === "ollama");

  const handOff = (tool: AiToolStatus) => {
    if (!tool.installed) {
      onInstallHint(tool.id);
      onClose();
      return;
    }
    onHandOff(askAiCommand(tool.id, payload));
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal assistant-modal" role="dialog" aria-modal onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <Icon name="sparkle" size={15} />
          <h2>Assistant</h2>
          <span className="term-tag">{mode === "demo" ? "demo" : cluster.context}</span>
          <span className="term-tag">ns: {namespace}</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" size={13} />
          </button>
        </div>

        <div className="assistant-actions">
          <button
            className={`chip${question === "namespace" ? " on" : ""}`}
            onClick={() => setQuestion("namespace")}
          >
            Summarize namespace health
          </button>
          <button
            className={`chip${question === "resource" ? " on" : ""}`}
            disabled={!selected}
            title={selected ? undefined : "Select a resource first (graph or explorer)"}
            onClick={() => setQuestion("resource")}
          >
            Explain {selected ? `${selected.kind}/${selected.name}` : "selected resource"}
          </button>
        </div>

        <h3>{answer.title}</h3>
        {answer.diagnosis.map((d, i) => (
          <p className="about" key={i}>
            {d}
          </p>
        ))}

        {answer.chains.length > 0 && (
          <ProblemChainList
            chains={answer.chains}
            onSelectResource={(uid) => {
              onSelectResource(uid);
              onClose();
            }}
          />
        )}

        {answer.checks.length > 0 && (
          <div className="chain-checks">
            <div className="chain-checks-head">
              <span className="kubectl-label">verify with</span>
              <button
                className="link-btn"
                onClick={() => void navigator.clipboard.writeText(answer.checks.join("\n"))}
              >
                copy all
              </button>
            </div>
            {answer.checks.map((c) => (
              <code key={c}>{c}</code>
            ))}
          </div>
        )}

        <h3>Continue with an AI tool (optional)</h3>
        <p className="about assistant-note">
          The analysis above ran locally - nothing left this machine. Hand-offs below type a command
          into the integrated terminal with the sanitized context; you review it and press Enter.
          Secret values, annotations, tokens and kubeconfig contents are never included.
        </p>
        <div className="assistant-tools">
          {tools
            .filter((t) => DIRECT_TOOLS.includes(t.id))
            .map((tool) => (
              <button
                key={tool.id}
                className="term-btn"
                title={
                  tool.installed
                    ? `Type the sanitized context into ${tool.name} for review`
                    : `${tool.name} is not installed - click for install instructions`
                }
                onClick={() => handOff(tool)}
              >
                <AiLogo tool={tool.id} size={13} />
                {tool.name}
                {!tool.installed && <span className="assistant-missing">not installed</span>}
              </button>
            ))}
          {ollama && (
            <button
              className="term-btn"
              title={
                ollama.installed
                  ? "Ollama runs models locally. Copies the context - run `ollama run <model>` in the terminal and paste it."
                  : "Ollama (free local models) is not installed - click for install instructions"
              }
              onClick={() => {
                if (!ollama.installed) {
                  void openExternal(AI_TOOL_LINKS.ollama);
                  return;
                }
                void navigator.clipboard.writeText(payload);
                onHandOff("ollama run ");
                onClose();
              }}
            >
              <AiLogo tool="ollama" size={13} />
              Ollama (local)
              {!ollama.installed && <span className="assistant-missing">not installed</span>}
            </button>
          )}
        </div>

        <p className="about assistant-note">
          <button className="link-btn" onClick={() => setShowPayload((v) => !v)}>
            {showPayload ? "hide" : "preview"} exactly what would be shared
          </button>
        </p>
        {showPayload && <pre className="assistant-payload">{payload}</pre>}
      </div>
    </div>
  );
}

export default Assistant;
