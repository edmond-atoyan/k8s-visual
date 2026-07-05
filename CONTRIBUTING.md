# Contributing to K8s Visual

Thanks for helping make Kubernetes easier to understand!

## Dev setup

1. Install [Rust](https://rustup.rs), Node.js ≥ 20, and the Tauri Linux
   libraries (see the *Build from source* section of the README).
2. `npm install`
3. `npm run tauri dev` - the full desktop app with hot reload.

No cluster handy? `npm run dev` and open `http://localhost:5173/?demo` - the
whole UI runs against the built-in demo cluster in a plain browser.

For a quick throwaway cluster: `kind create cluster` or `minikube start`.

## Code layout

| Path | What lives there |
|---|---|
| `src-tauri/core/` | Rust: kube-rs client, per-kind summaries, events/logs/metrics/RBAC/YAML/actions/exec/port-forward, cloud credential import (`cloud.rs`). **No UI/Tauri deps** - checkable with `cargo check -p k8s-visual-core` |
| `src-tauri/src/` | Rust: thin Tauri IPC commands over the core crate, plus the integrated-terminal PTY sessions (`terminal.rs`) |
| `src/providers/` | TS: `ClusterProvider` interface; live (Tauri IPC), demo, and cloud-connect wrappers |
| `src/graph/` | TS: edge derivation (`build.ts`) and layered layout (`layout.ts`) |
| `src/views/` | One file per sidebar area (graph, explorer, events, logs, metrics, …) |
| `src/components/` | Shared components (details panel, action modal, terminal drawer, connect screen, window chrome) |
| `src/actions.ts` | The action catalog: risk levels, RBAC verbs, kubectl intents |
| `src/ai.ts` | AI safety layer: sanitized summaries, redaction, dangerous-command analyzer |
| `src/kindInfo.ts` | The educational blurbs and group accents per resource kind |

The wire format is defined twice and must stay in sync:
`src-tauri/core/src/model.rs` (serde, camelCase) ↔ `src/types.ts`.

## Adding a new resource kind

1. Add a mapper in `src-tauri/core/src/summaries.rs` and list it in `snapshot()`.
2. Add the kind to `Kind` in `src/types.ts` and a column in `src/graph/layout.ts`.
3. Write its learning blurb in `src/kindInfo.ts` (what it is + where it sits
   in the hierarchy).
4. Add it to the demo cluster in `src/providers/demo.ts` so it's visible
   without a cluster.

## Principles

- **Read-only by default.** Every session starts read-only. Mutations exist
  only behind the explicit management-mode toggle, go through the single
  confirmation flow (`ActionModal` / the action catalog), and live only in
  `core/src/actions.rs` + `core/src/yaml.rs`. Secret values are never read
  implicitly.
- **Honest Kubernetes.** Never fake live data. If an API or permission is
  missing, show exactly what is missing.
- **Teach the CLI.** Every operation surfaces its kubectl (or cloud CLI)
  equivalent.
- **Stay light.** Think twice before adding a dependency; prefer plain CSS
  and hand-rolled logic over frameworks. Heavy optional features (like the
  terminal) are lazy-loaded.
- **Status is never color alone** - pair every status color with text; the
  palette in `src/styles.css` is validated for colorblind safety, use its
  tokens rather than new hex values.

## Before opening a PR

```sh
npm run build                                   # type-check + bundle
npm test                                        # vitest
cd src-tauri && cargo fmt && cargo test --workspace
```

CI runs the same checks plus a full Tauri build.
