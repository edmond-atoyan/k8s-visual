// Cloud connect API: credential discovery/import through the user's own
// cloud CLI (aws / az / gcloud), executed by the Rust side. No cloud
// credentials ever pass through, are stored by, or leave the app - the CLI
// writes the kubeconfig entry itself and the normal kubeconfig connection
// path takes over.

import { invoke } from "@tauri-apps/api/core";
import type {
  CloudCliStatus,
  CloudCluster,
  CloudImportOutcome,
  CloudKind,
  CloudScope,
} from "../types";
import { inTauri } from "./tauri";

export interface CloudApi {
  cliStatus(kind: CloudKind): Promise<CloudCliStatus>;
  scopes(kind: CloudKind): Promise<CloudScope[]>;
  /** AWS only; Azure/GCP listings already span locations (returns []). */
  regions(kind: CloudKind, scope: string): Promise<CloudScope[]>;
  clusters(kind: CloudKind, scope: string, region?: string): Promise<CloudCluster[]>;
  importCredentials(kind: CloudKind, scope: string, cluster: CloudCluster): Promise<CloudImportOutcome>;
}

const tauriApi: CloudApi = {
  cliStatus: (kind) => invoke("cloud_cli_status", { kind }),
  scopes: (kind) => invoke("cloud_scopes", { kind }),
  regions: (kind, scope) => invoke("cloud_regions", { kind, scope }),
  clusters: (kind, scope, region) => invoke("cloud_clusters", { kind, scope, region: region ?? null }),
  importCredentials: (kind, scope, cluster) => invoke("cloud_import", { kind, scope, cluster }),
};

// Dev-only simulation (`?cloudmock` URL param) so the connect flow can be
// exercised and screenshotted in a plain browser. Never active in the app
// unless explicitly requested; real cloud access always goes through Tauri.
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MOCK: Record<CloudKind, { status: CloudCliStatus; scopes: CloudScope[]; clusters: CloudCluster[] }> = {
  aws: {
    status: { installed: true, authenticated: true, account: "2 profiles found" },
    scopes: [
      { id: "default", label: "default", default: true },
      { id: "staging", label: "staging", default: false },
    ],
    clusters: [
      { name: "shop-prod", location: "eu-west-1", detail: "v1.30" },
      { name: "shop-staging", location: "eu-west-1", detail: "v1.29" },
    ],
  },
  azure: {
    status: { installed: true, authenticated: true, account: "dev@example.com", detail: "default subscription: Production" },
    scopes: [
      { id: "sub-prod", label: "Production", default: true },
      { id: "sub-dev", label: "Development", default: false },
    ],
    clusters: [{ name: "shop-aks", location: "westeurope", group: "rg-shop", detail: "rg-shop · v1.29.2" }],
  },
  gcp: {
    status: { installed: true, authenticated: true, account: "dev@example.com" },
    scopes: [{ id: "shop-project", label: "shop-project", detail: "current gcloud project", default: true }],
    clusters: [{ name: "shop-gke", location: "europe-west1", detail: "v1.30.1-gke.100" }],
  },
};

const mockApi: CloudApi = {
  cliStatus: async (kind) => (await wait(500), MOCK[kind].status),
  scopes: async (kind) => (await wait(400), MOCK[kind].scopes),
  regions: async (kind) =>
    kind === "aws"
      ? (await wait(300),
        [
          { id: "eu-west-1", label: "eu-west-1", detail: "profile default", default: true },
          { id: "us-east-1", label: "us-east-1", default: false },
          { id: "us-west-2", label: "us-west-2", default: false },
        ])
      : [],
  clusters: async (kind) => (await wait(600), MOCK[kind].clusters),
  importCredentials: async (kind, _scope, cluster) => {
    await wait(900);
    const context =
      kind === "aws"
        ? `arn:aws:eks:${cluster.location}:123456789012:cluster/${cluster.name}`
        : kind === "gcp"
          ? `gke_shop-project_${cluster.location}_${cluster.name}`
          : cluster.name;
    return { context };
  },
};

/** The cloud connect backend, or null when unavailable (plain browser). */
export function cloudApi(): CloudApi | null {
  if (new URLSearchParams(window.location.search).has("cloudmock")) return mockApi;
  return inTauri() ? tauriApi : null;
}
