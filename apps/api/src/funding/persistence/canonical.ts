import crypto from "node:crypto";

interface CanonicalJsonObject {
  readonly [key: string]: CanonicalJson;
}

type CanonicalJson =
  | boolean
  | number
  | string
  | null
  | readonly CanonicalJson[]
  | CanonicalJsonObject;

function assertFiniteJsonNumber(value: number): number {
  if (!Number.isFinite(value)) {
    throw new TypeError("canonical JSON does not support non-finite numbers");
  }
  return value;
}

function normalizeCanonicalJson(value: unknown, path: string): CanonicalJson {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return assertFiniteJsonNumber(value);
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      normalizeCanonicalJson(entry, `${path}[${index}]`),
    );
  }
  if (typeof value !== "object") {
    throw new TypeError(`non-JSON value at ${path}`);
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`non-plain JSON object at ${path}`);
  }

  const normalized: Record<string, CanonicalJson> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const entry = (value as Record<string, unknown>)[key];
    if (entry === undefined) {
      throw new TypeError(`undefined JSON value at ${path}.${key}`);
    }
    normalized[key] = normalizeCanonicalJson(entry, `${path}.${key}`);
  }
  return normalized;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeCanonicalJson(value, "$"));
}

export function canonicalJsonHash(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function hashOpaqueToken(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 16) {
    throw new TypeError("opaque token must contain at least 16 characters");
  }
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

export function lookupHmac(value: string, key: string): string {
  if (key.length < 32) {
    throw new TypeError("lookup HMAC key must contain at least 32 characters");
  }
  return crypto.createHmac("sha256", key).update(value).digest("hex");
}

export function canonicalJsonEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
