import { InstrumentRulesCollector } from './instrument-rules/collector.js';
import { instrumentRulesConfig } from './instrument-rules/config.js';
import { PUBLIC_ENDPOINTS } from './instrument-rules/client.js';
import { assessCrossVenueRules } from './instrument-rules/validator.js';
import { TARGET_BTC_SIZE } from './config/simulation.js';

const collector = new InstrumentRulesCollector({ ...instrumentRulesConfig(), enabled: true });
try {
  await collector.pollOnce();
  if (process.argv.includes('--refresh')) await collector.pollOnce();
  const snapshots = collector.getSnapshots();
  const assessment = assessCrossVenueRules(TARGET_BTC_SIZE, snapshots, Date.now(), () => ({ bybit: null, okx: null }));
  console.log(JSON.stringify({ endpoints: PUBLIC_ENDPOINTS, rules: snapshots,
    commonTarget: assessment, note: 'Quantity candidate only; no fresh books/notionals or USD conversion supplied. Not execution approval.',
    health: collector.getHealth(), metrics: collector.getMetrics() }, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value, 2));
  if (!snapshots.bybit || !snapshots.okx) process.exitCode = 1;
} finally { await collector.stop(); }
