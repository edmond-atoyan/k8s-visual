import { beforeEach, describe, expect, it } from "vitest";
import { clusterPrefs } from "./prefs";

describe("clusterPrefs", () => {
  beforeEach(() => clusterPrefs._reset());

  it("remembers the last app context", () => {
    expect(clusterPrefs.lastContext()).toBeUndefined();
    clusterPrefs.setLastContext("arn:aws:eks:eu-west-1:1:cluster/prod");
    expect(clusterPrefs.lastContext()).toBe("arn:aws:eks:eu-west-1:1:cluster/prod");
  });

  it("remembers the namespace per context independently", () => {
    clusterPrefs.setNamespace("prod", "payments");
    clusterPrefs.setNamespace("minikube", "dev");
    expect(clusterPrefs.namespaceFor("prod")).toBe("payments");
    expect(clusterPrefs.namespaceFor("minikube")).toBe("dev");
    expect(clusterPrefs.namespaceFor("other")).toBeUndefined();
  });

  it("hides and restores contexts without duplicates", () => {
    clusterPrefs.hide("staging");
    clusterPrefs.hide("staging");
    expect(clusterPrefs.hidden()).toEqual(["staging"]);
    clusterPrefs.unhide("staging");
    expect(clusterPrefs.hidden()).toEqual([]);
  });
});
