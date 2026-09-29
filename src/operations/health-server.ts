import { createServer, type Server } from 'node:http';
import { safeJson } from '../security/secrets.js';

import type { ServiceHealth } from './operational-state.js';

export interface HealthServerOptions {
  host: string;
  port: number;
  getHealth: () => ServiceHealth;
  getMetrics?: () => Record<string, unknown>;
}

export interface HealthServer {
  address: () => { host: string; port: number };
  close: () => Promise<void>;
}

function ready(health: ServiceHealth): boolean {
  return (
    health.paper.operationalState === 'RUNNING' &&
    health.market.bybitConnected &&
    health.market.okxConnected &&
    health.timing.syncStatus === 'SYNC_HEALTHY' &&
    health.timing.clockHealth === 'HEALTHY' &&
    health.persistence.checkpointHealthy &&
    health.persistence.journalHealthy
    && (health.readinessReasons?.length ?? 0) === 0
  );
}

export interface HealthHttpResponse {
  statusCode: number;
  body: Record<string, unknown> | ServiceHealth;
}

export function getHealthHttpResponse(
  method: string | undefined,
  path: string | undefined,
  health: ServiceHealth,
  metrics: Record<string, unknown> = {},
): HealthHttpResponse {
  if (method !== 'GET') {
    return { statusCode: 405, body: { status: 'method_not_allowed' } };
  }
  if (path === '/live') {
    return { statusCode: 200, body: { status: 'live' } };
  }
  if (path === '/health') {
    return { statusCode: 200, body: health };
  }
  if (path === '/metrics') return { statusCode: 200, body: metrics };
  if (path === '/ready') {
    const isReady = ready(health);
    return {
      statusCode: isReady ? 200 : 503,
      body: { status: isReady ? 'ready' : 'not_ready', reasons: health.readinessReasons ?? [] },
    };
  }
  return { statusCode: 404, body: { status: 'not_found' } };
}

export async function startHealthServer(
  options: HealthServerOptions,
): Promise<HealthServer> {
  let boundPort = options.port;
  const server: Server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json; charset=utf-8');
    if (request.method === 'GET' && request.url === '/live') {
      response.statusCode = 200;
      response.end(safeJson({ status: 'live' }));
      return;
    }
    const health = options.getHealth();
    const result = getHealthHttpResponse(request.method, request.url, health,
      request.url === '/metrics' ? options.getMetrics?.() : undefined);
    response.statusCode = result.statusCode;
    response.end(safeJson(result.body));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      const address = server.address();
      if (address !== null && typeof address !== 'string') {
        boundPort = address.port;
      }
      resolve();
    });
  });

  return {
    address: () => ({ host: options.host, port: boundPort }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}
