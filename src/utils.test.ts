import { describe, expect, it } from "vitest";
import { cloudTag, contextFlavor, diffLines, formatAge, formatBytes, formatCpu, providerBadge } from "./utils";

describe("diffLines", () => {
  it("reports identical text as all-same", () => {
    const d = diffLines("a\nb", "a\nb");
    expect(d.every((l) => l.type === "same")).toBe(true);
  });

  it("finds changed lines", () => {
    const d = diffLines("replicas: 2\nimage: v1", "replicas: 4\nimage: v1");
    expect(d).toContainEqual({ type: "del", text: "replicas: 2" });
    expect(d).toContainEqual({ type: "add", text: "replicas: 4" });
    expect(d).toContainEqual({ type: "same", text: "image: v1" });
  });

  it("handles pure insertions and deletions", () => {
    expect(diffLines("a", "a\nb").filter((l) => l.type === "add")).toHaveLength(1);
    expect(diffLines("a\nb", "b").filter((l) => l.type === "del")).toHaveLength(1);
  });
});

describe("cloudTag", () => {
  it("detects EKS from the context ARN with its region", () => {
    const tag = cloudTag("arn:aws:eks:eu-west-1:123456789012:cluster/shop-prod");
    expect(tag).toEqual({ provider: "EKS", label: "Amazon EKS", detail: "eu-west-1" });
  });
  it("detects GKE from the gke_ context with project and location", () => {
    const tag = cloudTag("gke_shop-project_europe-west1_shop-gke");
    expect(tag).toEqual({ provider: "GKE", label: "Google GKE", detail: "shop-project · europe-west1" });
  });
  it("detects EKS and AKS from the API server host", () => {
    expect(cloudTag("prod", "https://abc.gr7.eu-west-1.eks.amazonaws.com")?.provider).toBe("EKS");
    expect(cloudTag("shop-aks", "https://shop-dns-123.hcp.westeurope.azmk8s.io:443")?.provider).toBe("AKS");
  });
  it("returns null for local clusters", () => {
    expect(cloudTag("default", "https://127.0.0.1:6443")).toBeNull();
    expect(cloudTag("minikube", "")).toBeNull();
  });
});

describe("providerBadge", () => {
  it("recognizes local cluster flavors from context names", () => {
    expect(contextFlavor("minikube")).toBe("minikube");
    expect(contextFlavor("kind-dev")).toBe("kind");
    expect(contextFlavor("k3d-test")).toBe("k3d");
    expect(contextFlavor("docker-desktop")).toBe("docker");
    expect(contextFlavor("microk8s-cluster")).toBe("microk8s");
    expect(contextFlavor("default")).toBeNull();
  });

  it("prefers cloud detection, falls back to flavor, then local", () => {
    expect(providerBadge("arn:aws:eks:eu-west-1:1:cluster/x").text).toBe("EKS");
    expect(providerBadge("kind-dev").text).toBe("kind");
    expect(providerBadge("default").text).toBe("local");
  });
});

describe("formatting", () => {
  it("formats cpu millicores", () => {
    expect(formatCpu(250)).toBe("250m");
    expect(formatCpu(1500)).toBe("1.5 cores");
  });
  it("formats bytes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(300 * 1024 * 1024)).toBe("300 Mi");
    expect(formatBytes(1.5 * 1024 ** 3)).toBe("1.5 Gi");
  });
  it("formats ages like kubectl", () => {
    expect(formatAge(new Date(Date.now() - 30_000).toISOString())).toBe("30s");
    expect(formatAge(new Date(Date.now() - 3 * 3_600_000).toISOString())).toBe("3h");
    expect(formatAge(new Date(Date.now() - 5 * 86_400_000).toISOString())).toBe("5d");
    expect(formatAge(undefined)).toBe("-");
  });
});

describe("diffLines large-input fallback", () => {
  it("degrades to a plain replacement instead of freezing on huge diffs", () => {
    const before = Array.from({ length: 1500 }, (_, i) => `a${i}`).join("\n");
    const after = Array.from({ length: 1500 }, (_, i) => `b${i}`).join("\n");
    const d = diffLines(before, after);
    expect(d.filter((l) => l.type === "del")).toHaveLength(1500);
    expect(d.filter((l) => l.type === "add")).toHaveLength(1500);
  });

  it("still trims the common prefix and suffix before falling back", () => {
    const mid = (s: string) => Array.from({ length: 1200 }, (_, i) => `${s}${i}`).join("\n");
    const d = diffLines(`same-head\n${mid("x")}\nsame-tail`, `same-head\n${mid("y")}\nsame-tail`);
    expect(d[0]).toEqual({ type: "same", text: "same-head" });
    expect(d[d.length - 1]).toEqual({ type: "same", text: "same-tail" });
  });
});
