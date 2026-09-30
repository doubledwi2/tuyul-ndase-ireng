import { inspect } from 'node:util';

const configuredSecrets = new Set<string>();
export const REDACTED = '[REDACTED]';

// No environment or file access here: replay/soak can import redaction without
// loading credentials. Values enter this registry only through SecretString.
export class SecretString {
  #value: string;

  constructor(value: string) {
    if (!value) throw new Error('Secret value cannot be empty.');
    this.#value = value;
    configuredSecrets.add(value);
    Object.freeze(this);
  }

  get configured(): boolean { return this.#value.length > 0; }
  // Explicit, narrowly used by balance signing. Never pass a logger here.
  use<T>(consumer: (value: string) => T): T { return consumer(this.#value); }
  toJSON(): string { return REDACTED; }
  toString(): string { return REDACTED; }
  [inspect.custom](): string { return REDACTED; }
}

export function redactSecret(text: string): string {
  let result = text;
  for (const value of [...configuredSecrets].sort((a, b) => b.length - a.length)) {
    result = result.split(value).join(REDACTED);
  }
  return result;
}

export function sanitizeError(error: unknown): string {
  return redactSecret(error instanceof Error ? error.message : String(error));
}

export function sanitize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactSecret(value);
  if (typeof value === 'bigint') return redactSecret(value.toString());
  if (typeof value === 'function') return '[Function]';
  if (typeof value === 'symbol') return '[Symbol]';
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof SecretString) return REDACTED;
  if (value instanceof Error) return { name: redactSecret(value.name), message: sanitizeError(value) };
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map(item => sanitize(item, seen));
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor.enumerable) continue;
      // Do not execute custom getters/toJSON while logging untrusted context.
      result[redactSecret(key)] = 'value' in descriptor ? sanitize(descriptor.value, seen) : '[Accessor]';
    }
    return result;
  } finally { seen.delete(value); }
}

export function safeJson(value: unknown): string {
  return JSON.stringify(sanitize(value));
}

export function assertNoSecrets(serialized: string): void {
  for (const value of configuredSecrets) {
    if (serialized.includes(value) || serialized.includes(JSON.stringify(value).slice(1, -1))) {
      throw new Error('Persistence refused: payload contains a configured secret.');
    }
  }
}
