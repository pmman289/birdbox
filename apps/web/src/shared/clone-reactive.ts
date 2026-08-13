import { toRaw } from "vue";

function unwrapReactive(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (value === null || typeof value !== "object") return value;
  const raw = toRaw(value as object);
  const existing = seen.get(raw);
  if (existing !== undefined) return existing;
  if (Array.isArray(raw)) {
    const result: unknown[] = [];
    seen.set(raw, result);
    for (const item of raw) result.push(unwrapReactive(item, seen));
    return result;
  }
  const result: Record<string, unknown> = {};
  seen.set(raw, result);
  for (const [key, item] of Object.entries(raw)) result[key] = unwrapReactive(item, seen);
  return result;
}

export function cloneReactive<T>(value: T): T {
  return unwrapReactive(value, new WeakMap()) as T;
}
