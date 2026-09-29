export interface SecretFinding { line: number; reason: string }

export function scanSecretText(text: string, path = ''): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    let reason: string | null = null;
    if (/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/.test(line)) reason = 'private-key-header';
    if (/\bFAKE_[A-Z0-9_]*(?:KEY|SECRET|PASSPHRASE)_[A-Z0-9_]{6,}\b/.test(line)) reason = 'obvious-secret-marker';
    const quoted = /\b(?:BYBIT_API_(?:KEY|SECRET)|OKX_API_(?:KEY|SECRET|PASSPHRASE))\b["']?\s*[:=]\s*["']([^"'\r\n]+)["']/.exec(line);
    const env = /(?:^|\s)(?:export\s+)?(?:BYBIT_API_(?:KEY|SECRET)|OKX_API_(?:KEY|SECRET|PASSPHRASE))=([^\s#]+)/.exec(line);
    const shellAssignment = /^\s*(?:export\s+)?(?:BYBIT_API_(?:KEY|SECRET)|OKX_API_(?:KEY|SECRET|PASSPHRASE))=/.test(line);
    const value = quoted?.[1] ?? (/\.env(?:\.|$)|\.secret$/.test(path) || shellAssignment ? env?.[1] : undefined);
    if (value && !/^(?:<[^>]+>|REPLACE_ME|CHANGEME|\$\{?[A-Z_][A-Z_0-9]*\}?)$/.test(value)) reason = 'credential-assignment';
    if (reason !== null) findings.push({ line: index + 1, reason });
  }
  return findings;
}
