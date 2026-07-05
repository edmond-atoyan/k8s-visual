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

- **No telemetry, no network calls except to your cluster.** The only
  outbound connections are to the Kubernetes API server of the kubeconfig
  context you chose (via [kube-rs](https://kube.rs)) and the local tunnels
  you explicitly start with port-forward.
- **Read-only by default.** Every session starts read-only. The only
  cluster-mutating code paths are `core/src/actions.rs` and
  `core/src/yaml.rs`, both reachable only through the management-mode
  confirmation flow.
- **Secrets are never fetched implicitly.** Secret listings show names, key
  names and sizes only. Values are fetched by an explicit confirmed reveal,
  never stored, and masked in YAML views.
- **Cloud connect never touches credentials.** The EKS/AKS/GKE flows shell
  out to your own `aws`/`az`/`gcloud` CLI, which writes the kubeconfig entry
  itself. The app never reads, stores, or transmits cloud credentials, and
  shows each CLI command before running it (`core/src/cloud.rs`).
- **AI CLIs receive nothing automatically.** Hand-offs to Claude Code /
  Codex CLI are explicit user actions; payloads are sanitized summaries
  (never Secret values, annotations, tokens, certificates, or kubeconfig
  contents), commands are typed into the terminal for review rather than
  executed, and log excerpts pass through credential redaction (`src/ai.ts`).
- **The integrated terminal is your own shell.** The app adds context
  environment variables and a best-effort hold on dangerous kubectl commands;
  it does not (and cannot) sandbox the shell, and says so in the UI.

## Supported versions

Only the latest release receives security fixes.
