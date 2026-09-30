import { createPrivateReadClients } from './private-read/startup.js';
import { safeFailure } from './private-read/types.js';
import { safeJson } from './security/secrets.js';

async function main() {
  const { enabled, clients } = await createPrivateReadClients();
  if (!enabled) throw new Error('PRIVATE_READ_ENABLED must be true.');
  await Promise.all(clients.map(async client => {
    try {
      const snapshot = await client.readBalance();
      console.log(safeJson({ exchange: client.exchange, btc: 'read OK', usdt: 'read OK',
        snapshotAgeMs: Math.max(0, Date.now() - snapshot.receivedAt), permissionsVerified: false }));
    } catch (error) {
      const failure = safeFailure(error);
      console.error(safeJson({ exchange: client.exchange, category: failure.category, status: failure.status }));
      process.exitCode = 1;
    } finally { client.stop(); }
  }));
}
main().catch(() => {
  console.error('Account check configuration invalid: require PRIVATE_READ_ENABLED=true and complete credentials for both exchanges. No values displayed.');
  process.exitCode = 1;
});
