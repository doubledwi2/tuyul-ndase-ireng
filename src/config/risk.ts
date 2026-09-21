// Engineering-only paper risk baselines. These are not capital or trading advice.
export const MAX_TOTAL_BTC_EXPOSURE = 0.25;
export const MAX_VENUE_BTC_IMBALANCE = 0.05;
export const MIN_VENUE_BTC_RESERVE = 0.02;
export const MIN_VENUE_USDT_RESERVE = 1_000;
export const MAX_OPEN_PAPER_TRADES = 3;
export const MAX_UNHEDGED_BTC = 0.01;
export const MAX_SESSION_PAPER_LOSS_USDT = 50;
export const MAX_CONSECUTIVE_EXECUTION_FAILURES = 3;
export const REBALANCE_ALLOCATION_TOLERANCE_PERCENT = 10;

export interface PaperRiskConfig {
  maxTotalBtcExposure: number;
  maxVenueBtcImbalance: number;
  minVenueBtcReserve: number;
  minVenueUsdtReserve: number;
  maxOpenPaperTrades: number;
  maxUnhedgedBtc: number;
  maxSessionPaperLossUsdt: number;
  maxConsecutiveExecutionFailures: number;
  rebalanceAllocationTolerancePercent: number;
}

export const PAPER_RISK_CONFIG: Readonly<PaperRiskConfig> = {
  maxTotalBtcExposure: MAX_TOTAL_BTC_EXPOSURE,
  maxVenueBtcImbalance: MAX_VENUE_BTC_IMBALANCE,
  minVenueBtcReserve: MIN_VENUE_BTC_RESERVE,
  minVenueUsdtReserve: MIN_VENUE_USDT_RESERVE,
  maxOpenPaperTrades: MAX_OPEN_PAPER_TRADES,
  maxUnhedgedBtc: MAX_UNHEDGED_BTC,
  maxSessionPaperLossUsdt: MAX_SESSION_PAPER_LOSS_USDT,
  maxConsecutiveExecutionFailures: MAX_CONSECUTIVE_EXECUTION_FAILURES,
  rebalanceAllocationTolerancePercent:
    REBALANCE_ALLOCATION_TOLERANCE_PERCENT,
};

export function validatePaperRiskConfig(config: PaperRiskConfig): void {
  for (const [name, value] of Object.entries(config)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`${name} must be finite and non-negative.`);
    }
  }
  if (!Number.isInteger(config.maxOpenPaperTrades)) {
    throw new RangeError('maxOpenPaperTrades must be an integer.');
  }
  if (!Number.isInteger(config.maxConsecutiveExecutionFailures)) {
    throw new RangeError(
      'maxConsecutiveExecutionFailures must be an integer.',
    );
  }
  if (config.rebalanceAllocationTolerancePercent > 50) {
    throw new RangeError(
      'rebalanceAllocationTolerancePercent must not exceed 50.',
    );
  }
}
