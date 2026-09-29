import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readFile } from 'node:fs/promises';
import { scanSecretText } from './security/secret-scanner.js';

const { stdout } = await promisify(execFile)('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { maxBuffer: 16 * 1024 * 1024 });
let findings = 0;
let scanned = 0;
for (const path of new Set(stdout.split('\0').filter(Boolean))) {
  if (/^(?:node_modules|dist|data|backups|\.git)\//.test(path)) continue;
  const stat = await lstat(path);
  if (!stat.isFile()) continue;
  const content = await readFile(path, 'utf8');
  if (content.includes('\0')) continue;
  scanned++;
  for (const finding of scanSecretText(content, path)) {
    console.error(`${path}:${finding.line}: ${finding.reason}`);
    findings++;
  }
}
console.log(`Secret scan: ${scanned} project files; ${findings} finding(s). Heuristic only; not a guarantee against leaks.`);
if (findings > 0) process.exitCode = 1;
