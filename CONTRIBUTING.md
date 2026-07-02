# Contributing to K8s Visual

Thanks for helping make Kubernetes easier to understand!

## Dev setup

1. Install [Rust](https://rustup.rs), Node.js ≥ 20, and the Tauri Linux
   libraries (see the *Build from source* section of the README).
2. `npm install`
3. `npm run tauri dev` — the full desktop app with hot reload.

No cluster handy? `npm run dev` and open `http://localhost:5173/?demo` — the
whole UI runs against the built-in demo cluster in a plain browser.

For a quick throwaway cluster: `kind create cluster` or `minikube start`.

## Code layout

| Path | What lives there |
|---|---|
| `src-tauri/core/` | Rust: kube-rs client, per-kind resource summaries. **No UI/Tauri deps** — checkable with `cargo check -p k8s-visual-core` |
| `src-tauri/src/` | Rust: thin Tauri IPC commands over the core crate |
| `src/providers/` | TS: `ClusterProvider` interface; live (Tauri IPC) + demo implementations |
| `src/graph/` | TS: edge derivation (`build.ts`) and layered layout (`layout.ts`) |
| `src/components/` | React components |
| `src/kindInfo.ts` | The educational blurbs and group accents per resource kind |

The wire format is defined twice and must stay in sync:
`src-tauri/core/src/model.rs` (serde, camelCase) ↔ `src/types.ts`.

## Adding a new resource kind

1. Add a mapper in `src-tauri/core/src/lib.rs` and list it in `snapshot()`.
2. Add the kind to `Kind` in `src/types.ts` and a column in `src/graph/layout.ts`.
3. Write its learning blurb in `src/kindInfo.ts` (what it is + where it sits
   in the hierarchy).
4. Add it to the demo cluster in `src/providers/demo.ts` so it's visible
   without a cluster.

## Principles

- **Read-only, always.** The app never mutates cluster state. Secret values
  are never read.
- **Stay light.** Think twice before adding a dependency; prefer plain CSS
  and hand-rolled logic over frameworks.
- **Explain, don't just display.** New UI should help someone understand
  Kubernetes, not only inspect it.
- **Status is never color alone** — pair every status color with text; the
  palette in `src/styles.css` is validated for colorblind safety, use its
  tokens rather than new hex values.

## Before opening a PR

```sh
npm run build                                   # type-check + bundle
cd src-tauri && cargo fmt && cargo check -p k8s-visual-core
```

CI runs the same checks plus a full Tauri build.
