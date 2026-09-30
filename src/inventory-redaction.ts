import type { DashboardResponse } from "../packages/contracts/src/api.js";
import type { Inventory } from "../packages/contracts/src/inventory.js";

/** Value shown to clients when a secret exists but must not be disclosed. */
export const SECRET_PLACEHOLDER = "********";

const SECRET_KEY = /^(?:password|aokeys|birdprivatekey|privatekey|remotepublickey|sharedsecret|secret)$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Redact credentials in JSON-shaped API responses. */
export function redactPayload<T>(value: T): T {
  return redactValue(value) as T;
}

function redactConfig(value: string): string {
  // Preserve the useful config preview while hiding quoted credentials.
  return value
    .replace(/(\bpassword\s+)(["'])(.*?)\2/gi, `$1$2${SECRET_PLACEHOLDER}$2`)
    .replace(/(\bsecret\s+)(["'])(.*?)\2/gi, `$1$2${SECRET_PLACEHOLDER}$2`);
}

function redactValue(value: unknown, key = ""): unknown {
  if (typeof value === "string") {
    if (key === "config" || key === "sessionConfig" || key === "generatedConfig") return redactConfig(value);
    return SECRET_KEY.test(key) && value.length > 0 ? SECRET_PLACEHOLDER : value;
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
    childKey,
    redactValue(childValue, childKey),
  ]));
}

/** Restore redacted fields submitted back by a client from the authoritative record. */
export function restoreSecretPlaceholders<T>(incoming: T, previous: unknown): T {
  return restoreValue(incoming, previous, "") as T;
}

function restoreValue(incoming: unknown, previous: unknown, key: string): unknown {
  if (typeof incoming === "string") {
    return SECRET_KEY.test(key) && incoming === SECRET_PLACEHOLDER && typeof previous === "string"
      ? previous
      : incoming;
  }
  if (Array.isArray(incoming)) {
    const oldItems = Array.isArray(previous) ? previous : [];
    return incoming.map((item, index) => {
      const old = isRecord(item)
        ? oldItems.find((candidate) => isRecord(candidate)
          && ((item.id !== undefined && candidate.id === item.id)
            || (item.nodeId !== undefined && candidate.nodeId === item.nodeId)))
          ?? oldItems[index]
        : oldItems[index];
      return restoreValue(item, old, "");
    });
  }
  if (!isRecord(incoming)) return incoming;
  const oldRecord = isRecord(previous) ? previous : {};
  return Object.fromEntries(Object.entries(incoming).map(([childKey, childValue]) => [
    childKey,
    restoreValue(childValue, oldRecord[childKey], childKey),
  ]));
}

export function redactInventory(inventory: Inventory): Inventory {
  return redactPayload(inventory);
}

export function redactDashboardResponse(response: DashboardResponse): DashboardResponse {
  return redactPayload(response);
}
