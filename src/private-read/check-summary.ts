import type { PrivateAccountCollector } from './collector.js';
import type { BalanceReadOnlyClient } from './client.js';

export function accountCheckSummary(collector: PrivateAccountCollector, clients: readonly BalanceReadOnlyClient[]) {
  const safety = collector.getSafetySummary();
  const summaries = clients.map(client => {
    const exchange = client.exchange;
    const health = collector.getDiagnosticHealth(exchange);
    const permission = exchange === 'bybit' ? safety.bybitCredentialSafety : safety.okxCredentialSafety;
    const compatibility = exchange === 'bybit' ? safety.bybitAccountCompatibility : safety.okxAccountCompatibility;
    const ip = exchange === 'bybit' ? client.cache('BYBIT_API_KEY_INFO').snapshot?.ipBound : client.cache('OKX_ACCOUNT_CONFIG').snapshot?.safety.ipBound;
    return { exchange, balance: health.balance.healthy ? 'OK' : 'FAIL', permission: permission.status,
      permissionReasons: permission.reasons, accountConfig: compatibility.status, accountReasons: compatibility.reasons,
      fee: health.fee.healthy ? 'observed' : 'not available',
      ipRestriction: !health.permissions.healthy || ip == null ? 'unknown' : ip ? 'configured' : 'not configured',
      readOnlyObservationSafe: safety.readOnlyObservationSafe,
      requestsByKind: client.getMetrics().byKind };
  });
  return { summaries, exitCode: summaries.some(s => s.balance !== 'OK' || s.permission !== 'SAFE_READ_ONLY' ||
    s.accountConfig !== 'COMPATIBLE' || s.fee !== 'observed') ? 1 : 0 };
}
