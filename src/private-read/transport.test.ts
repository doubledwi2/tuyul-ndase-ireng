import assert from 'node:assert/strict';
import test from 'node:test';
import { balanceUrl, HOSTS, MAX_RESPONSE_BYTES, privateReadConfig } from './config.js';
import { BalanceAuthHeaders } from './signing.js';
import { FetchReadOnlyHttpTransport, type BalanceRequest } from './transport.js';

const request: BalanceRequest = { exchange: 'bybit', url: balanceUrl('bybit', 'https://api.bybit.com'), headers: new BalanceAuthHeaders({}) };
test('base URL exact official allowlist; reject HTTP, credentials, paths, ports and parser tricks', () => {
  assert.equal(privateReadConfig({}).enabled, false);
  assert.throws(() => privateReadConfig({ PRIVATE_READ_ENABLED: '1' }));
  for (const exchange of ['bybit', 'okx'] as const) {
    for (const host of HOSTS[exchange]) assert.ok(balanceUrl(exchange, `https://${host}`).startsWith(`https://${host}/`));
    for (const base of ['http://api.bybit.com', 'https://localhost', 'https://api.bybit.com:443',
      'https://a@api.bybit.com', 'https://api.bybit.com/..', 'https://api.bybit.com/?x=1',
      'https://api.bybit.com#x', 'https://api.bybit.com.evil.test', ' https://api.bybit.com', 'https://api.bybit.com\\']) {
      assert.throws(() => balanceUrl(exchange, base));
    }
  }
});
test('transport final URL guard runs before fetch; GET and redirect:error cannot be overridden', async () => {
  let calls = 0;
  const transport = new FetchReadOnlyHttpTransport(async (url, init) => {
    calls++; assert.equal(url, request.url); assert.equal(init?.method, 'GET'); assert.equal(init.redirect, 'error');
    return Response.json({ ok: true });
  });
  for (const url of [request.url + '&extra=1', 'https://localhost', request.url.replace('BTC,USDT', 'ETH')]) {
    await assert.rejects(transport.get({ ...request, url }));
  }
  assert.equal(calls, 0);
  const result = await transport.get(request); assert.deepEqual(result.payload, { ok: true }); assert.ok(result.receivedAt > 0);
});
for (const [name, response, category] of [
  ['redirect', () => new Response(null, { status: 302 }), 'HTTP'],
  ['HTTP429', () => new Response(null, { status: 429 }), 'RATE_LIMIT'],
  ['HTTP500', () => new Response(null, { status: 500 }), 'HTTP'],
  ['HTML', () => new Response('secret body', { headers: { 'content-type': 'text/html' } }), 'CONTENT_TYPE'],
  ['malformed JSON', () => new Response('sensitive broken payload', { headers: { 'content-type': 'application/json' } }), 'JSON'],
  ['declared oversized', () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': String(MAX_RESPONSE_BYTES + 1) } }), 'BODY_SIZE'],
  ['streamed oversized', () => new Response('x'.repeat(MAX_RESPONSE_BYTES + 1), { headers: { 'content-type': 'application/json' } }), 'BODY_SIZE'],
] as const) {
  test(`transport rejects ${name} with sanitized category`, async () => {
    await assert.rejects(new FetchReadOnlyHttpTransport(async () => response()).get(request), { category });
  });
}
test('timeout covers pending headers and stalled body; abort is signalled', async () => {
  for (const body of [false, true]) {
    let signal: AbortSignal | null | undefined;
    const transport = new FetchReadOnlyHttpTransport(async (_, init) => {
      signal = init?.signal;
      if (!body) return new Promise<Response>(() => {});
      return new Response(new ReadableStream<Uint8Array>({ start() {} }), { headers: { 'content-type': 'application/json' } });
    }, 15);
    await assert.rejects(transport.get(request), { category: 'TIMEOUT' });
    assert.equal((signal as AbortSignal | undefined)?.aborted, true);
  }
});
test('native errors never expose bodies, headers, credentials or signature', async () => {
  const transport = new FetchReadOnlyHttpTransport(async () => { throw new Error('sensitive metadata'); });
  await assert.rejects(transport.get(request), error => {
    assert.equal((error as Error).message, 'Private read failed: NETWORK'); return true;
  });
});
