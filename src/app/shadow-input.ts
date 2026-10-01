import type { DepthPipelineSnapshot } from './pipeline.js';
import type { PrivateAccountCollector } from '../private-read/collector.js';
import type { ShadowAccountState, ShadowInput, ShadowVenueInput } from '../shadow/shadow-types.js';
import type { Exchange } from '../private-read/types.js';

function freezeSnapshot<T extends object>(value: T): T {
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === 'object') freezeSnapshot(child);
  }
  return Object.freeze(value);
}

// Cache-only adapter: no private request is issued on the market decision path.
export function shadowAccounts(collector: PrivateAccountCollector): ShadowAccountState {
  const inventory = collector.getInventory(), summary = collector.getSafetySummary();
  function venue(exchange: Exchange): ShadowVenueInput {
    const h = collector.getDiagnosticHealth(exchange);
    const compatibility = exchange === 'bybit' ? summary.bybitAccountCompatibility : summary.okxAccountCompatibility;
    const permission = exchange === 'bybit' ? summary.bybitCredentialSafety : summary.okxCredentialSafety;
    const balance = inventory[exchange];
    return freezeSnapshot({
      // Project only the needed balances; never copy rawAccountType or metadata.
      balance: balance ? Object.freeze({ exchange, receivedAt: balance.receivedAt, sourceUpdatedAt: null,
        btc: Object.freeze({ total: balance.btc.total, available: balance.btc.available }),
        usdt: Object.freeze({ total: balance.usdt.total, available: balance.usdt.available }) }) : null,
      balanceHealthy: h.balance.healthy,
      fee: exchange === 'bybit' ? summary.bybitFeeSnapshot : summary.okxFeeSnapshot,
      feeHealthy: h.fee.healthy,
      compatibility: h.lastConfigSuccessAt === null ? null : { value: compatibility, receivedAt: h.lastConfigSuccessAt, healthy: h.config.healthy },
      permission: h.lastPermissionSuccessAt === null ? null : { value: permission, receivedAt: h.lastPermissionSuccessAt, healthy: h.permissions.healthy },
    });
  }
  return Object.freeze({ bybit: venue('bybit'), okx: venue('okx') });
}
export function shadowInput(snapshot: DepthPipelineSnapshot, collector: PrivateAccountCollector, evaluatedAt: number): ShadowInput {
  return { evaluatedAt, books: { bybit: snapshot.bybitBook, okx: snapshot.okxBook }, sync: snapshot.syncAssessment, accounts: shadowAccounts(collector) };
}
