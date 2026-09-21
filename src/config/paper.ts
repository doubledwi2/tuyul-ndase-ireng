import type { PaperBalance } from '../paper/balances.js';

// Engineering-only virtual balances. These are not capital recommendations.
export const INITIAL_PAPER_BALANCES: Readonly<
  Record<PaperBalance['exchange'], Readonly<PaperBalance>>
> = {
  bybit: {
    exchange: 'bybit',
    btcAvailable: 0.1,
    btcReserved: 0,
    usdtAvailable: 10_000,
    usdtReserved: 0,
  },
  okx: {
    exchange: 'okx',
    btcAvailable: 0.1,
    btcReserved: 0,
    usdtAvailable: 10_000,
    usdtReserved: 0,
  },
};

export const MAX_PAPER_TRIGGER_AGE_MS = 100;
export const PAPER_BALANCE_EPSILON = 1e-12;

// Deterministic simulation baselines, not measured exchange latency.
export const PAPER_BUY_ORDER_LATENCY_MS = 50;
export const PAPER_SELL_ORDER_LATENCY_MS = 50;
export const PAPER_ORDER_TIMEOUT_MS = 250;
export const PAPER_MAX_UNHEDGED_DURATION_MS = 200;
export const PAPER_ALLOW_PARTIAL_FILL = true;

export interface PaperExecutionConfig {
  buyOrderLatencyMs: number;
  sellOrderLatencyMs: number;
  orderTimeoutMs: number;
  maxUnhedgedDurationMs: number;
  allowPartialFill: boolean;
}

export const PAPER_EXECUTION_CONFIG: Readonly<PaperExecutionConfig> = {
  buyOrderLatencyMs: PAPER_BUY_ORDER_LATENCY_MS,
  sellOrderLatencyMs: PAPER_SELL_ORDER_LATENCY_MS,
  orderTimeoutMs: PAPER_ORDER_TIMEOUT_MS,
  maxUnhedgedDurationMs: PAPER_MAX_UNHEDGED_DURATION_MS,
  allowPartialFill: PAPER_ALLOW_PARTIAL_FILL,
};

export function validatePaperExecutionConfig(
  config: PaperExecutionConfig,
): void {
  if (typeof config.allowPartialFill !== 'boolean') {
    throw new TypeError('allowPartialFill must be boolean.');
  }
  for (const [name, value] of Object.entries(config)) {
    if (name === 'allowPartialFill') {
      continue;
    }
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`${name} must be finite and non-negative.`);
    }
  }
}
