export interface OpportunityQualityConfig {
  minNetSpreadPercent: number;
  minNetPnlUsdt: number;
  minActiveDurationMs: number;
  maxSyncDiffMsForQualified: number;
}

// Engineering baselines only. They are not trading recommendations.
export const MIN_NET_SPREAD_PERCENT = 0.03;
export const MIN_NET_PNL_USDT = 0.01;
export const MIN_ACTIVE_DURATION_MS = 100;
export const MAX_SYNC_DIFF_MS_FOR_QUALIFIED = 100;

export const OPPORTUNITY_QUALITY_CONFIG: Readonly<OpportunityQualityConfig> = {
  minNetSpreadPercent: MIN_NET_SPREAD_PERCENT,
  minNetPnlUsdt: MIN_NET_PNL_USDT,
  minActiveDurationMs: MIN_ACTIVE_DURATION_MS,
  maxSyncDiffMsForQualified: MAX_SYNC_DIFF_MS_FOR_QUALIFIED,
};

export function validateOpportunityQualityConfig(
  config: OpportunityQualityConfig,
): void {
  for (const [name, value] of Object.entries(config)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`${name} must be finite and non-negative.`);
    }
  }
}
