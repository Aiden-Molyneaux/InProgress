interface Store {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The window's localStorage, read through globalThis so a unit test (no DOM types) can compile and stub it. */
const store = (): Store => (globalThis as unknown as { localStorage: Store }).localStorage;

export function load(key: string): string | null {
  try {
    return store().getItem(key);
  } catch {
    return null;
  }
}

export function save(key: string, value: string): void {
  try {
    store().setItem(key, value);
  } catch {
    // storage blocked: the UI still works without persistence
  }
}

export function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = store().getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
