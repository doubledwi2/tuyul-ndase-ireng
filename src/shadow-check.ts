import assert from 'node:assert/strict';
import { runShadowFixture } from './shadow/fixture.js';
import { freshAt } from './shadow/shadow-evaluator.js';
import { MAX_BALANCE_AGE_MS, MAX_DIAGNOSTIC_AGE_MS } from './private-read/config.js';
import { parseExecutionSafety } from './execution/safety.js';

async function main() {
  parseExecutionSafety(process.env);
  const args = process.argv.slice(2);
  if (args.length === 0 || (args.length === 1 && args[0] === '--mock')) {
    const first = runShadowFixture();
    assert.deepEqual(first, runShadowFixture());
    console.log(JSON.stringify({ mode: 'SYNTHETIC_ONLY', deterministic: true, ...first }, null, 2));
    return;
  }
  if (args.length !== 1 || args[0] !== '--live') throw new Error('Use --mock or --live.');
  // Explicit opt-in only. Default/mock path never loads credentials or clients.
  const { createPrivateReadClients } = await import('./private-read/startup.js');
  const { PrivateAccountCollector } = await import('./private-read/collector.js');
  const { shadowAccounts } = await import('./app/shadow-input.js');
  const setup = await createPrivateReadClients();
  if (!setup.enabled) throw new Error('Private read required.');
  const collector = new PrivateAccountCollector(true, setup.clients);
  try {
    await collector.pollOnce();
    const accounts = shadowAccounts(collector), at = Date.now();
    for (const exchange of ['bybit', 'okx'] as const) {
      const a = accounts[exchange];
      const balanceFresh = a.balanceHealthy && freshAt(a.balance?.receivedAt, at, MAX_BALANCE_AGE_MS);
      const feeFresh = a.feeHealthy && freshAt(a.fee?.receivedAt, at, MAX_DIAGNOSTIC_AGE_MS);
      console.log(JSON.stringify({ exchange, feeFresh, balanceFresh,
        compatibility: a.compatibility?.value.status ?? 'UNKNOWN',
        credentialSafety: a.permission?.value.status ?? 'UNKNOWN',
        fundingEvaluable: balanceFresh && a.compatibility?.value.status === 'COMPATIBLE' &&
          a.balance?.btc.available != null && a.balance?.usdt.available != null,
        note: 'Diagnostic only; no market fill or execution approval.' }));
    }
  } finally { await collector.stop(); }
}
main().catch(() => { console.error('Shadow check failed; verify flags and local configuration. No private values displayed.'); process.exitCode = 1; });
