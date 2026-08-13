const AS_SET_COMPONENT = "AS-[A-Z0-9][A-Z0-9_-]{0,62}";
const AS_NUMBER_COMPONENT = "AS[0-9]{1,10}";
const AS_SET_NAME_RE = new RegExp(`^(?:${AS_NUMBER_COMPONENT}:)*${AS_SET_COMPONENT}(?::${AS_SET_COMPONENT})*$`);

export function normalizeIrrAsSetName(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

export function isIrrAsSetName(value: unknown): boolean {
  const normalized = normalizeIrrAsSetName(value);
  return normalized.length <= 127 && AS_SET_NAME_RE.test(normalized);
}
