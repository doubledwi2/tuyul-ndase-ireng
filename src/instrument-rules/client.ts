import { RULE_REQUEST_TIMEOUT_MS } from './config.js';
import { parseInstrumentRules, RuleError } from './parsers.js';
import type { Exchange } from './types.js';
export type RequestKind = 'BYBIT_SPOT_INSTRUMENT' | 'OKX_SPOT_INSTRUMENT';
export const PUBLIC_ENDPOINTS = Object.freeze({
  BYBIT_SPOT_INSTRUMENT: 'https://api.bybit.com/v5/market/instruments-info?category=spot&symbol=BTCUSDT',
  OKX_SPOT_INSTRUMENT: 'https://openapi.okx.com/api/v5/public/instruments?instType=SPOT&instId=BTC-USDT',
});
export type PublicTransport = (kind: RequestKind) => Promise<unknown>;
export const publicTransport: PublicTransport = async kind => {
  if (!Object.hasOwn(PUBLIC_ENDPOINTS, kind)) throw new RuleError('SCHEMA');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), RULE_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(PUBLIC_ENDPOINTS[kind], { method: 'GET', redirect: 'error', signal: controller.signal });
    if (!response.ok) { await response.body?.cancel(); throw new RuleError('HTTP', response.status, response.status === 429 || response.status >= 500); }
    const reader = response.body?.getReader();
    if (!reader) throw new RuleError('SCHEMA');
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 1_048_576) throw new RuleError('BODY_LIMIT');
        chunks.push(next.value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
    catch { throw new RuleError('SCHEMA'); }
  } catch (error) {
    if (error instanceof RuleError) throw error;
    throw new RuleError(controller.signal.aborted ? 'TIMEOUT' : 'NETWORK', null, true);
  } finally { clearTimeout(timer); }
};
export async function fetchInstrumentRules(exchange: Exchange, transport: PublicTransport = publicTransport, now = Date.now) {
  const payload = await transport(exchange === 'bybit' ? 'BYBIT_SPOT_INSTRUMENT' : 'OKX_SPOT_INSTRUMENT');
  const receivedAt = now();
  return parseInstrumentRules(exchange, payload, receivedAt);
}
