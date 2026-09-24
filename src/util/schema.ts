/**
 * A small JSON Schema subset used for tool inputs: validates model-produced
 * arguments and coerces the common near-misses (numbers or booleans sent as
 * strings, arrays sent as JSON strings) before a tool runs.
 */
export interface JSONSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  additionalProperties?: boolean | JSONSchema;
  items?: JSONSchema;
  enum?: unknown[];
  const?: unknown;
  anyOf?: JSONSchema[];
  oneOf?: JSONSchema[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  default?: unknown;
  [key: string]: unknown;
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function matchesType(v: unknown, type: string): boolean {
  const t = typeOf(v);
  if (type === "number") return t === "number" || t === "integer";
  return t === type;
}

function coerce(value: unknown, schema: JSONSchema): unknown {
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.length || types.some((t) => matchesType(value, t))) {
    if (typeOf(value) === "object" && schema.properties) {
      const obj = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        const sub = schema.properties[k];
        out[k] = sub ? coerce(v, sub) : v;
      }
      return out;
    }
    if (Array.isArray(value) && schema.items) return value.map((v) => coerce(v, schema.items!));
    return value;
  }
  if (typeof value === "string") {
    const s = value.trim();
    if ((types.includes("number") || types.includes("integer")) && /^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    if (types.includes("boolean") && (s === "true" || s === "false")) return s === "true";
    if ((types.includes("array") && s.startsWith("[")) || (types.includes("object") && s.startsWith("{"))) {
      try {
        return coerce(JSON.parse(s), schema);
      } catch {
        return value;
      }
    }
    if (types.includes("null") && s === "null") return null;
  }
  if (types.includes("string") && (typeof value === "number" || typeof value === "boolean")) return String(value);
  if (types.includes("array") && value !== undefined && value !== null && !Array.isArray(value) && schema.items) {
    const itemTypes = schema.items.type === undefined ? [] : Array.isArray(schema.items.type) ? schema.items.type : [schema.items.type];
    if (itemTypes.some((t) => matchesType(value, t))) return [value];
  }
  return value;
}

function validate(value: unknown, schema: JSONSchema, path: string, errors: string[]): void {
  if (schema.anyOf || schema.oneOf) {
    const options = (schema.anyOf ?? schema.oneOf)!;
    const ok = options.some((opt) => {
      const e: string[] = [];
      validate(value, opt, path, e);
      return e.length === 0;
    });
    if (!ok) errors.push(`${path || "input"}: does not match any allowed shape`);
    return;
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      errors.push(`${path || "input"}: expected ${types.join(" or ")}, got ${typeOf(value)}`);
      return;
    }
  }
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path || "input"}: must be ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.some((e) => e === value)) {
    errors.push(`${path || "input"}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: must be <= ${schema.maximum}`);
  }
  if (typeof value === "string" && schema.minLength !== undefined && value.length < schema.minLength) {
    errors.push(`${path}: must be at least ${schema.minLength} characters`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: needs at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: allows at most ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => validate(v, schema.items!, `${path}[${i}]`, errors));
  }
  if (typeOf(value) === "object") {
    const obj = value as Record<string, unknown>;
    for (const req of schema.required ?? []) {
      if (obj[req] === undefined) errors.push(`${path ? path + "." : ""}${req}: required`);
    }
    for (const [k, v] of Object.entries(obj)) {
      const sub = schema.properties?.[k];
      if (sub) validate(v, sub, path ? `${path}.${k}` : k, errors);
      else if (schema.additionalProperties === false && v !== undefined) {
        errors.push(`${path ? path + "." : ""}${k}: unknown property`);
      } else if (typeof schema.additionalProperties === "object") {
        validate(v, schema.additionalProperties, path ? `${path}.${k}` : k, errors);
      }
    }
  }
}

export function validateInput(
  input: unknown,
  schema: JSONSchema,
): { ok: true; value: unknown } | { ok: false; errors: string[] } {
  const value = coerce(input ?? {}, schema);
  const errors: string[] = [];
  validate(value, schema, "", errors);
  return errors.length ? { ok: false, errors } : { ok: true, value };
}
