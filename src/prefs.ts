// Per-cluster app memory: the last cluster the app itself was connected to,
// the last namespace per context, and contexts the user hid from the
// switcher. Lives in localStorage (in-memory fallback for tests); never
// touches kubeconfig - hiding a context here has no effect outside the app.

export interface ClusterMemory {
  lastContext?: string;
  namespaces: Record<string, string>;
  hidden: string[];
}

const KEY = "k8sv-cluster-prefs";

const fallback = new Map<string, string>();

function storage(): Pick<Storage, "getItem" | "setItem"> {
  try {
    if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  } catch {
    /* storage disabled */
  }
  return {
    getItem: (k) => fallback.get(k) ?? null,
    setItem: (k, v) => void fallback.set(k, v),
  };
}

let cache: ClusterMemory | null = null;

function load(): ClusterMemory {
  if (cache) return cache;
  try {
    const raw = storage().getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ClusterMemory>;
      cache = {
        lastContext: typeof parsed.lastContext === "string" ? parsed.lastContext : undefined,
        namespaces: parsed.namespaces && typeof parsed.namespaces === "object" ? parsed.namespaces : {},
        hidden: Array.isArray(parsed.hidden) ? parsed.hidden.filter((h) => typeof h === "string") : [],
      };
      return cache;
    }
  } catch {
    /* corrupted - start fresh */
  }
  cache = { namespaces: {}, hidden: [] };
  return cache;
}

function save() {
  try {
    storage().setItem(KEY, JSON.stringify(load()));
  } catch {
    /* quota/disabled - memory-only */
  }
}

export const clusterPrefs = {
  /** The context the app itself last connected to ("demo" for the demo cluster). */
  lastContext(): string | undefined {
    return load().lastContext;
  },
  setLastContext(context: string): void {
    load().lastContext = context;
    save();
  },
  /** Last selected namespace for a context, if remembered. */
  namespaceFor(context: string): string | undefined {
    return load().namespaces[context];
  },
  setNamespace(context: string, namespace: string): void {
    load().namespaces[context] = namespace;
    save();
  },
  /** Contexts hidden from the switcher (app-side only). */
  hidden(): string[] {
    return [...load().hidden];
  },
  hide(context: string): void {
    const m = load();
    if (!m.hidden.includes(context)) m.hidden.push(context);
    save();
  },
  unhide(context: string): void {
    const m = load();
    m.hidden = m.hidden.filter((c) => c !== context);
    save();
  },
  /** Test hook. */
  _reset(): void {
    cache = { namespaces: {}, hidden: [] };
    save();
  },
};
