import rawConfig from "../config.json";

export type Category = keyof typeof rawConfig.categories;
export const CATEGORIES = Object.keys(rawConfig.categories) as Category[];

export interface CategoryConfig {
  icon: string;
  initialState: Record<string, unknown>;
  routes: Record<string, RouteDescriptor>;
  controls: ControlDescriptor[];
}

// Route descriptors — interpreted at request time
type RouteDescriptor =
  | { merge: Record<string, unknown> }
  | { nav: { field: string; cursorField: string; selectField: string } };

// Control descriptors — forwarded to the dashboard as-is
export type ControlDescriptor = Record<string, unknown>;

export const config = rawConfig.categories as Record<Category, CategoryConfig>;

export function initialState(category: Category): Record<string, unknown> {
  return structuredClone(config[category].initialState);
}

function resolve(expr: unknown, state: Record<string, unknown>, body: Record<string, unknown>): unknown {
  if (typeof expr === "string") {
    if (expr.startsWith("$body.")) return body[expr.slice(6)];
    if (expr.startsWith("$state.")) return state[expr.slice(7)];
    return expr;
  }
  if (Array.isArray(expr) || typeof expr !== "object" || expr === null) return expr;

  const obj = expr as Record<string, unknown>;

  if ("clamp" in obj) {
    const [val, lo, hi] = obj.clamp as unknown[];
    const v = Number(resolve(val, state, body));
    return Math.min(Number(hi), Math.max(Number(lo), v));
  }
  if ("wrap" in obj) {
    const [val, lo, hi] = obj.wrap as unknown[];
    const range = Number(hi) - Number(lo);
    const v = Number(resolve(val, state, body)) % range;
    return v < 0 ? v + range : v;
  }
  if ("stepFrom" in obj) {
    // ["$state.field", "$body.direction", "upToken", "downToken", stepSize=1]
    const [base, dir, upTok, downTok, step = 1] = obj.stepFrom as unknown[];
    const current = Number(resolve(base, state, body));
    const direction = resolve(dir, state, body);
    const delta = direction === upTok ? Number(step) : direction === downTok ? -Number(step) : 0;
    return current + delta;
  }
  if ("step" in obj) {
    // ["$state.field", "$body.direction", "nextToken", "prevToken", stepFwd, stepBack]
    const [base, dir, nextTok, prevTok, fwd = 1, back = 1] = obj.step as unknown[];
    const current = Number(resolve(base, state, body));
    const direction = resolve(dir, state, body);
    const delta = direction === nextTok ? Number(fwd) : direction === prevTok ? -Number(back) : 0;
    return Math.max(1, current + delta);
  }
  if ("if" in obj) {
    const [cond, ifTrue, ifFalse] = obj.if as unknown[];
    return resolve(cond, state, body) ? ifTrue : ifFalse;
  }
  return expr;
}

export function applyRoute(
  descriptor: RouteDescriptor,
  state: Record<string, unknown>,
  body: Record<string, unknown>,
): Record<string, unknown> {
  if ("merge" in descriptor) {
    const patch: Record<string, unknown> = {};
    for (const [k, expr] of Object.entries(descriptor.merge)) {
      patch[k] = resolve(expr, state, body);
    }
    return { ...state, ...patch };
  }

  if ("nav" in descriptor) {
    const { cursorField, selectField } = descriptor.nav;
    const action = String(body.action ?? "");
    const cursor = { ...(state[cursorField] as { x: number; y: number } ?? { x: 0, y: 0 }) };
    switch (action) {
      case "up":    cursor.y -= 1; break;
      case "down":  cursor.y += 1; break;
      case "left":  cursor.x -= 1; break;
      case "right": cursor.x += 1; break;
      case "select": return { ...state, [cursorField]: cursor, [selectField]: body.app ?? state[selectField] };
      case "back":   return { ...state, [cursorField]: cursor };
    }
    return { ...state, [cursorField]: cursor };
  }

  return state;
}

export function routesForCategory(category: Category): Array<{ method: string; path: string; descriptor: RouteDescriptor }> {
  return Object.entries(config[category].routes).map(([key, descriptor]) => {
    const [method, path] = key.split(" ");
    return { method, path, descriptor };
  });
}
