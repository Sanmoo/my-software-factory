// Redaction of known credentials before anything is persisted or printed (observability,
// decision 12). It does not promise universal sanitization: only registered secret values and
// the well-known token shapes below are hidden. Project content and human replies are not
// touched; they stay local and out of Git instead.

export const REDACTED = "[redacted]";

// Registered values shorter than this are not treated as secrets: replacing a three-letter
// "secret" everywhere would corrupt unrelated text.
const MIN_SECRET_LENGTH = 6;

const TOKEN_SHAPES: readonly RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9_]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/g,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{16,}/g,
];

export interface Redactor {
  // Registers a credential value; undefined or too short values are ignored.
  add(secret: string | undefined): void;
  apply(text: string): string;
}

export function createRedactor(initial: ReadonlyArray<string | undefined> = []): Redactor {
  const secrets = new Set<string>();
  const redactor: Redactor = {
    add(secret) {
      if (secret !== undefined && secret.length >= MIN_SECRET_LENGTH) secrets.add(secret);
    },
    apply(text) {
      let result = text;
      // Longest first, so a secret that contains another one is replaced whole.
      for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
        result = result.split(secret).join(REDACTED);
      }
      for (const shape of TOKEN_SHAPES) {
        result = result.replace(shape, (match, scheme: unknown) =>
          typeof scheme === "string" ? `${scheme} ${REDACTED}` : REDACTED);
      }
      return result;
    },
  };
  for (const secret of initial) redactor.add(secret);
  return redactor;
}
