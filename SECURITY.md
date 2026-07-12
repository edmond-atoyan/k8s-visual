# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately via
**GitHub Security Advisories** ("Report a vulnerability" on the Security tab
of this repository). Do not open public issues for security reports.

You can expect an acknowledgement within a few days. Please include steps to
reproduce and the app version (`Help → About`).

## What the app does and does not do

K8s Visual is a local desktop application. Its security model is simple and
worth stating explicitly so it can be audited against the code:

- **No telemetry, no data upload.** The app itself only talks to the
  Kubernetes API server of the kubeconfig context you chose (via
  [kube-rs](https://kube.rs)) and the local tunnels you explicitly start
  with port-forward. Tools the app runs *on your behalf and at your request*
  can reach other endpoints: your own `aws`/`az`/`gcloud` CLI during cloud
  connect, `helm` when you update chart repositories, AI CLIs you invoke,
  and links opened in your browser. None of these receive data
  automatically.
- **Read-only by default, enforced twice.** Every session starts read-only.
  The UI gates every mutating control, and the Rust backend independently
  refuses mutating commands (actions, non-dry-run apply, exec, Helm writes)
  while management mode is off. The only cluster-mutating code paths are
  `core/src/actions.rs`, `core/src/yaml.rs`, and the management-gated Helm
  operations in `core/src/helm.rs`, all reachable only through the
  confirmation flow.
- **The right cluster, always.** Every kubectl/helm command the app displays
  carries an explicit context for the connected cluster, and the integrated
  terminal receives a minimal per-session `KUBECONFIG` containing only the
  selected context's identity and namespace - created atomically with mode
  0600 under an unpredictable name, and deleted when the shell exits. Shell
  tools cannot silently target the kubeconfig current-context; with no
  cluster connected (demo mode) the shell gets an empty kubeconfig.
  Terminals are closed on disconnect or cluster switch - a shell pinned to
  one cluster never survives the UI moving to another.
- **Secrets are never fetched implicitly.** Secret listings show names, key
  names and sizes only. Values are fetched by an explicit confirmed reveal,
  never stored, and masked in YAML views - and the
  `kubectl.kubernetes.io/last-applied-configuration` annotation (which can
  embed applied credentials) is stripped from every resource summary. Helm
  manifests have Secret values masked fail-closed (an unparseable manifest
  is withheld, not shown unmasked), and release values are not even fetched
  until an explicit "Show values" action. Copying a revealed value places it
  in the system clipboard, which is outside the app's control.
- **Cloud connect never touches credentials.** The EKS/AKS/GKE flows shell
  out to your own `aws`/`az`/`gcloud` CLI, which writes the kubeconfig entry
  itself. The app never reads, stores, or transmits cloud credentials, and
  shows each CLI command before running it (`core/src/cloud.rs`).
- **AI CLIs receive nothing automatically.** Hand-offs to Claude Code /
  Codex / Gemini CLI / Ollama are explicit user actions; payloads are
  sanitized summaries (never Secret values, annotations, tokens,
  certificates, or kubeconfig contents) that pass through credential
  redaction, and commands are typed into the terminal for review rather
  than executed (`src/ai.ts`).
- **The integrated terminal is your own shell.** The app pins the session's
  `KUBECONFIG` to the connected cluster and adds a best-effort hold on
  dangerous kubectl commands; it does not (and cannot) sandbox the shell,
  and says so in the UI.

## Supported versions

Only the latest release receives security fixes.
