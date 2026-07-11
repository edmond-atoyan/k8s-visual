# K8s Visual

Lightweight Linux desktop app (Tauri 2 + React) — a "visual kubectl": it
visualizes Kubernetes architecture as a live explainable graph and turns
common kubectl workflows (get/describe/logs/events/top/scale/rollout/delete/
apply/exec/port-forward) into visual, safe operations. Includes a built-in
educational demo cluster.

Safety model: **read-only by default**, enforced in BOTH layers: the React
UI gates buttons, and the Rust backend mirrors the toggle (`set_management`
IPC) and refuses mutating commands (actions, non-dry-run apply, exec, helm
writes) while it is off. Every mutating action goes through one confirmation
flow (target context → current state → intended change → kubectl intent →
risk level → confirm). Secret values are never fetched implicitly, never
stored, and are masked in YAML (including the kubectl last-applied
annotation, which embeds them); reveal is a separate confirmed call. Every
kubectl string the app shows carries `--context` for the connected cluster
(`actions.ts setKubectlContext`), and the integrated terminal gets a
KUBECONFIG copy pinned to that context (`core write_pinned_kubeconfig`) so
shell tools can never silently target the kubeconfig current-context.

## Commands

- `npm run build` — type-check + bundle the frontend (fast, no system deps)
- `npm test` — vitest (graph building, action catalog, diff, demo provider)
- `cd src-tauri && cargo check -p k8s-visual-core` — check the kube logic
- `cd src-tauri && cargo test -p k8s-visual-core --lib` — core unit tests
- `cargo check -p k8s-visual` — full app crate (needs Tauri Linux libs)
- `npm run tauri dev` / `npm run tauri build` — full app
- Browser-only demo mode: `npm run dev`, open `http://localhost:5173/?demo`
  (`&theme=light|dark`, `&view=<ViewId>`, `&select=<uid>` for screenshots;
  demo uids look like `Deployment:demo-shop:api`)

## Architecture

- `src-tauri/core/` — Rust lib crate, kube-rs client. One module per concern:
  `summaries` (per-kind mappers), `events`, `logs` (fetch + follow stream),
  `metrics` (metrics.k8s.io; honest "unavailable" fallback), `rbac`
  (SelfSubjectAccessReview), `yaml` (get with Secret masking + server-side
  apply, no force-conflicts), `actions` (with `yaml::apply` and `helm` write
  ops, the only cluster-mutating code), `exec` (one-shot, non-interactive;
  stdout/stderr drained concurrently - sequential drains deadlock),
  `portforward` (local tunnels; per-connection tasks tracked so Stop and
  disconnect kill established connections too). Kept free of Tauri deps on
  purpose. `Bridge::snapshot` returns PARTIAL data with per-kind `warnings`
  on RBAC denials instead of failing whole.
- `src-tauri/src/lib.rs` — thin Tauri IPC commands; log streaming uses
  `tauri::ipc::Channel`. Holds the backend management flag (see safety
  model); `with_bridge!` clones the Bridge out of the mutex so no network
  await blocks other commands; `disconnect` aborts log streams and tunnels.
- `src-tauri/core/src/cloud.rs` — managed-cloud connect (EKS/AKS/GKE). Its
  ONLY job is credential discovery/import by shelling out to the user's own
  `aws`/`az`/`gcloud` CLI (which writes the kubeconfig entry itself); the app
  never sees or stores cloud credentials, and after import the normal
  kubeconfig `Bridge::connect` path takes over. Frontend counterpart:
  `src/providers/cloud.ts` (invoke wrappers + a `?cloudmock` browser
  simulation for screenshots) and `components/CloudConnect.tsx` (provider
  cards + 5-step wizard on the Welcome screen). `utils.ts cloudTag()` detects
  EKS/AKS/GKE from context/server strings so the platform is always visible
  (title bar chip, status bar, ActionModal "Platform" row).
- `src/providers/` — `ClusterProvider` interface: `tauri.ts` (live IPC) and
  `demo.ts` (in-memory sample cluster whose management actions actually
  mutate state — deleting an owned pod spawns a replacement, like a real
  controller). All UI works against both.
- `src/graph/build.ts` — typed edges with human-readable `reason` strings:
  `owns`, `selects`, `routes`, `mounts`, `scales`, `protects`, `binds`,
  `backs`, `refs`. Missing reference targets become ghost nodes with broken
  edges; per-resource `issues` carry diagnostics (e.g. Service without ready
  endpoints).
- `src/graph/layout.ts` — hand-rolled layered layout (no layout lib);
  columns fixed per kind, hierarchy flows left→right.
- `src/actions.ts` — action catalog: risk levels (low/medium/high/danger),
  RBAC verb+resource per action, kubectl intent builders, what-will-change
  text. The UI never mutates the cluster outside this catalog + the
  `ActionModal` confirmation flow (`components/ActionModal.tsx`).
- `src/views/` — one file per sidebar area (Graph, Explorer, Networking,
  Storage, ConfigSecrets, Nodes, Events, Logs, Metrics, Access, ApplyYaml,
  Overview). `components/DetailsPanel.tsx` is the tabbed right panel
  (Overview/Status/Events/Logs/YAML/Actions); `components/LogViewer.tsx` is
  shared between the Logs view and the panel.
- Custom window chrome: the window is undecorated (`decorations: false` in
  `tauri.conf.json`); `components/TopBar.tsx` IS the title bar
  (`data-tauri-drag-region` on non-interactive elements — Tauri only drags
  when the pressed element itself has the attribute) and
  `components/WindowControls.tsx` draws minimize/maximize/close (permissions
  in `capabilities/default.json`; F11 = fullscreen). `components/StatusBar.tsx`
  is the bottom strip (mode segment, cluster, counts). Both render nothing /
  degrade cleanly in plain-browser demo mode.
- Icons are hand-drawn 16px strokes in `components/icons.tsx` — add there,
  no icon library (`CloudLogo` is the one exception: official provider marks
  rendered monochrome via currentColor).
- Integrated terminal: `src-tauri/src/terminal.rs` (portable-pty sessions +
  AI CLI detection; app crate, NOT core — the shell is the user's own, not
  k8s logic) ↔ `components/TerminalPanel.tsx` (xterm.js, lazy-loaded so the
  main bundle stays light; session survives hiding the drawer). `src/ai.ts`
  holds the safety layer: sanitized resource summaries (never Secret values /
  annotations / credentials), log redaction, and the dangerous-command
  analyzer that holds risky kubectl lines at Enter (confirm in management
  mode, block in read-only). AI hand-offs are typed into the shell but never
  auto-executed. Ctrl+` toggles the drawer.
- Troubleshooting engine: `src/chains.ts` (problem chains: causal paths from
  symptom to root cause with kubectl checks; pure + unit-tested against the
  demo provider) feeds the Events "Problems" section, the details panel, the
  Helm release troubleshooting, and `src/assistant.ts` (the built-in local
  assistant behind the title-bar sparkle; free by construction - external AI
  CLIs only receive user-previewed sanitized payloads). `src/insights.ts` is
  the metrics analogue (requests/limits vs usage findings; Pending explained,
  never zeroed). `src/prefs.ts` = localStorage cluster memory (last context,
  per-context namespace, hidden switcher entries).
- Helm: `core/src/helm.rs` shells out to the user's helm binary with
  `--kube-context` always pinned to the app's connection (never the
  kubeconfig current-context); `views/HelmView.tsx` has Releases/Charts tabs,
  release detail (values/manifest/notes/history/resources via meta.helm.sh
  annotations), repo management, and write actions - all management-gated
  behind a confirmation dialog that shows the full helm command (and the
  backend management flag). Secret documents in `helm get manifest` output
  are masked in Rust; release values render only after an explicit "Show
  values" click (they commonly contain credentials).
- Wire types are duplicated by design and must stay in sync:
  `src-tauri/core/src/model.rs` (serde camelCase) ↔ `src/types.ts`.

## Conventions

- Design tokens live in `src/styles.css` (validated colorblind-safe palette;
  light + dark via `[data-theme]`). Status colors are reserved for health and
  always paired with text. Group accents: Workloads=series-1,
  Networking=series-2, Config&Storage=series-3, Cluster=series-4.
  Surfaces are layered IDE-style: `--chrome` (title/side/status bars) →
  `--page` (content) → `--surface` (cards) → `--inset` (code/log wells);
  motion uses the `--dur-*`/`--ease*` tokens (fast, subtle, with a
  `prefers-reduced-motion` kill switch). No raw browser controls: selects are
  restyled + `color-scheme` per theme, scrollbars are themed.
- Vite must not watch `src-tauri/` (`server.watch.ignored` in
  `vite.config.ts`) — cargo's target churn exhausts inotify watches and kills
  the dev server mid-`tauri dev`.
- Educational content (kind explanations incl. common problems) lives in
  `src/kindInfo.ts`; every visible kind must have an entry there and demo
  data in `demo.ts`.
- Honest Kubernetes: never fake live data. If an API or permission is
  missing, show what is missing (metrics reason strings, RBAC denials with
  verb/resource). Demo mode is always labelled as demo.
- Every operation surfaces its kubectl equivalent (`KUBECTL_INTENT`,
  descriptor `kubectl()`), so the app teaches the CLI.
- Keep dependencies minimal — this app's selling point is being light.
  (vitest is dev-only; charts are hand-rolled SVG.)
- Headless screenshots: React Flow nodes get explicit width/height so they
  paint without DOM measurement; drive Chrome over CDP with real time rather
  than `--virtual-time-budget` (ResizeObserver never fires under virtual
  time).
