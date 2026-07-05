import { describe, expect, it } from "vitest";
import { analyzeCommand, askAiCommand, buildResourceSummary, redactSecrets, shellQuote } from "./ai";
import type { ResourceSummary } from "./types";

describe("analyzeCommand", () => {
  it("flags the dangerous kubectl operations", () => {
    expect(analyzeCommand("kubectl delete namespace prod")?.reason).toMatch(/namespace/);
    expect(analyzeCommand("kubectl delete pvc data-0")?.reason).toMatch(/storage/);
    expect(analyzeCommand("kubectl delete secret db-credentials")?.reason).toMatch(/Secret/);
    expect(analyzeCommand("kubectl delete pod x --force")?.reason).toMatch(/force/);
    expect(analyzeCommand("kubectl delete pods --all")?.reason).toMatch(/every resource/);
    expect(analyzeCommand("kubectl drain worker-1")?.reason).toMatch(/drain/i);
    expect(analyzeCommand("kubectl apply -f deploy.yaml")?.reason).toMatch(/applies/);
    expect(analyzeCommand("kubectl edit deploy api")?.reason).toMatch(/edits/);
    expect(analyzeCommand("helm uninstall shop")?.reason).toMatch(/Helm/);
  });

  it("does not flag read-only commands", () => {
    expect(analyzeCommand("kubectl get pods -A")).toBeNull();
    expect(analyzeCommand("kubectl describe deploy api")).toBeNull();
    expect(analyzeCommand("kubectl logs api-123 -f")).toBeNull();
    expect(analyzeCommand("ls -la")).toBeNull();
    expect(analyzeCommand("")).toBeNull();
    // "delete" in a different program is not kubectl's delete
    expect(analyzeCommand("git branch --delete feature")).toBeNull();
  });
});

describe("redactSecrets", () => {
  it("scrubs credential-shaped values", () => {
    expect(redactSecrets("password=hunter2")).toBe("password=[REDACTED]");
    expect(redactSecrets("API_KEY: abc123def")).toBe("API_KEY: [REDACTED]");
    expect(redactSecrets("Authorization: Bearer abcdef123456789")).toContain("[REDACTED]");
    expect(redactSecrets("key AKIAIOSFODNN7EXAMPLE used")).toContain("[REDACTED-AWS-KEY]");
    expect(
      redactSecrets("jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36P"),
    ).toContain("[REDACTED-JWT]");
  });

  it("leaves normal log lines alone", () => {
    const line = "GET /checkout 200 41ms user=u_18332";
    expect(redactSecrets(line)).toBe(line);
  });
});

describe("buildResourceSummary", () => {
  const pod: ResourceSummary = {
    uid: "u1",
    kind: "Pod",
    name: "api-1",
    namespace: "shop",
    owners: [{ kind: "ReplicaSet", name: "api-abc", uid: "u2" }],
    labels: { app: "api" },
    status: "CrashLoopBackOff",
    health: "critical",
    details: { Node: "worker-1" },
    containers: [
      { name: "api", image: "example/api:2.1.0", ready: false, restarts: 7, state: "CrashLoopBackOff", ports: [] },
    ],
    annotations: { "iam.example.com/role-token": "SHOULD-NEVER-APPEAR" },
  };

  it("carries identity, status, containers and diagnostics", () => {
    const s = buildResourceSummary(pod, ["container restarts repeatedly"]);
    expect(s).toContain("kind: Pod");
    expect(s).toContain("status: CrashLoopBackOff (health: critical)");
    expect(s).toContain("owned by: ReplicaSet/api-abc");
    expect(s).toContain("restarts=7");
    expect(s).toContain("diagnostic: container restarts repeatedly");
  });

  it("never includes annotations (may hold credentials)", () => {
    expect(buildResourceSummary(pod)).not.toContain("SHOULD-NEVER-APPEAR");
  });
});

describe("shell hand-off", () => {
  it("single-quotes safely, including embedded quotes", () => {
    expect(shellQuote("it's a test")).toBe(`'it'\\''s a test'`);
  });
  it("builds a review-first command for the chosen tool", () => {
    const cmd = askAiCommand("claude", "kind: Pod");
    expect(cmd.startsWith("claude '")).toBe(true);
    expect(cmd).toContain("do not run anything cluster-changing");
  });
});
