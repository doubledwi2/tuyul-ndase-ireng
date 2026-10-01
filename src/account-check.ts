import { createPrivateReadClients } from './private-read/startup.js';
import { PrivateAccountCollector } from './private-read/collector.js';
import { accountCheckSummary } from './private-read/check-summary.js';
import { safeJson } from './security/secrets.js';

async function main() {
  const { enabled, clients } = await createPrivateReadClients();
  if (!enabled) throw new Error('PRIVATE_READ_ENABLED must be true.');
  const collector = new PrivateAccountCollector(enabled, clients);
  try {
    await collector.pollOnce();
    const result = accountCheckSummary(collector, clients);
    for (const summary of result.summaries) console.log(safeJson(summary));
    process.exitCode = result.exitCode;
  } finally { await collector.stop(); }
}
main().catch(() => {
  console.error('Account check configuration invalid: require PRIVATE_READ_ENABLED=true and complete credentials for both exchanges. No values displayed.');
  process.exitCode = 1;
});
