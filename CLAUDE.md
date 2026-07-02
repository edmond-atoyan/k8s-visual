# K8s Visual

Lightweight Linux desktop app (Tauri 2 + React) that visualizes Kubernetes
architecture and hierarchy as a live graph, with a built-in educational demo
cluster. Read-only by principle: never mutate cluster state, never read
Secret values.

## Commands

- `npm run build` — type-check + bundle the frontend (fast, no system deps)
- `cd src-tauri && cargo check -p k8s-visual-core` — check the kube logic
  (works without WebKitGTK; checking the full app crate requires the Tauri
  Linux system libraries)
- `npm run tauri dev` / `npm run tauri build` — full app (needs system deps
  from README)
- Browser-only demo mode: `npm run dev`, open `http://localhost:5173/?demo`
  (`&theme=light|dark`, `&select=<uid>` for screenshots; demo uids look like
  `Deployment:demo-shop:api`)

## Architecture

- `src-tauri/core/` — Rust lib crate, kube-rs client + per-kind summary
  mappers. Kept free of Tauri deps on purpose.
- `src-tauri/src/lib.rs` — thin Tauri IPC commands (`list_contexts`,
  `connect`, `get_overview`, `get_snapshot`).
- `src/providers/` — `ClusterProvider` interface: `tauri.ts` (live IPC) and
  `demo.ts` (built-in sample cluster). All UI works against both.
- `src/graph/build.ts` — edges: `owns` (ownerReferences), `selects` (Service
  label selectors), `refs` (Ingress→Service, Pod→ConfigMap/Secret/PVC).
- `src/graph/layout.ts` — hand-rolled layered layout (no layout lib);
  columns fixed per kind, hierarchy flows left→right.
- Wire types are duplicated by design and must stay in sync:
  `src-tauri/core/src/model.rs` (serde camelCase) ↔ `src/types.ts`.

## Conventions

- Design tokens live in `src/styles.css` (validated colorblind-safe palette;
  light + dark via `[data-theme]`). Status colors are reserved for health and
  always paired with text. Group accents: Workloads=series-1,
  Networking=series-2, Config&Storage=series-3.
- Educational content (kind explanations) lives in `src/kindInfo.ts`; every
  visible kind must have an entry there and demo data in `demo.ts`.
- Keep dependencies minimal — this app's selling point is being light.
