import { MAX_RESPONSE_BYTES, PRIVATE_READ_TIMEOUT_MS, validateBalanceUrl } from './config.js';
import type { BalanceAuthHeaders } from './signing.js';
import { PrivateReadError, safeFailure, type Exchange } from './types.js';

export interface BalanceRequest { exchange: Exchange; url: string; headers: BalanceAuthHeaders }
export interface BalanceResponse { payload: unknown; receivedAt: number }
export interface ReadOnlyHttpTransport { get(request: BalanceRequest): Promise<BalanceResponse> }

export class FetchReadOnlyHttpTransport implements ReadOnlyHttpTransport {
  constructor(private readonly fetcher: typeof fetch = fetch, private readonly timeoutMs = PRIVATE_READ_TIMEOUT_MS) {}
  async get(request: BalanceRequest): Promise<BalanceResponse> {
    validateBalanceUrl(request.exchange, request.url);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new PrivateReadError('TIMEOUT')); }, this.timeoutMs);
    });
    const receive = async (): Promise<BalanceResponse> => {
      const response = await request.headers.use(headers => this.fetcher(request.url, {
        method: 'GET', headers: { ...headers, Accept: 'application/json' },
        redirect: 'error', signal: controller.signal,
      }));
      if (response.redirected || (response.status >= 300 && response.status < 400)) throw new PrivateReadError('HTTP', response.status);
      if (response.status !== 200) throw new PrivateReadError(response.status === 429 ? 'RATE_LIMIT' : 'HTTP', response.status);
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) throw new PrivateReadError('CONTENT_TYPE', response.status);
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) throw new PrivateReadError('BODY_SIZE', response.status);
      if (!response.body) throw new PrivateReadError('JSON', response.status);
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) throw new PrivateReadError('BODY_SIZE', response.status);
          chunks.push(value);
        }
        const receivedAt = Date.now();
        try {
          return { payload: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown, receivedAt };
        } catch { throw new PrivateReadError('JSON', response.status); }
      } finally {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    };
    try { return await Promise.race([receive(), deadline]); }
    catch (error) { throw controller.signal.aborted ? new PrivateReadError('TIMEOUT') : safeFailure(error); }
    finally { clearTimeout(timer); controller.abort(); }
  }
}
