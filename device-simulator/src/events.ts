// Simple in-process event bus shared between device servers and the dashboard.

type Listener = (data: string) => void;

const listeners = new Set<Listener>();

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit(event: string, payload: unknown): void {
  const data = JSON.stringify({ event, payload, ts: new Date().toISOString() });
  for (const fn of listeners) {
    try { fn(data); } catch { /* disconnected client */ }
  }
}
