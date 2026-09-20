import {
  validateOpportunityQualityConfig,
  type OpportunityQualityConfig,
} from '../config/opportunity.js';
import type { DepthComparison } from './depth-comparator.js';

export type QualificationReason =
  | 'NOT_NET_POSITIVE'
  | 'NET_SPREAD_TOO_SMALL'
  | 'NET_PNL_TOO_SMALL'
  | 'SYNC_TOO_WIDE'
  | 'INSUFFICIENT_DEPTH'
  | 'STALE';

export interface OpportunityQualification {
  qualified: boolean;
  reasons: QualificationReason[];
  netSpreadOk: boolean;
  netPnlOk: boolean;
  syncOk: boolean;
  depthOk: boolean;
  requiredActiveDurationMs: number;
}

export function qualifyOpportunity(
  comparison: DepthComparison,
  config: OpportunityQualityConfig,
): OpportunityQualification {
  validateOpportunityQualityConfig(config);

  const depthOk =
    comparison.buyExecution.fullyFilled && comparison.sellExecution.fullyFilled;
  const netSpreadOk =
    comparison.estimatedNetSpreadPercent !== null &&
    comparison.estimatedNetSpreadPercent >= config.minNetSpreadPercent;
  const netPnlOk =
    comparison.estimatedNetPnlAbsolute !== null &&
    comparison.estimatedNetPnlAbsolute >= config.minNetPnlUsdt;
  const syncOk =
    comparison.status !== 'STALE' &&
    comparison.receiveTimeDifferenceMs <= config.maxSyncDiffMsForQualified;
  const reasons: QualificationReason[] = [];

  // Structural failures are intentionally reported separately from quality
  // thresholds so STALE and insufficient depth remain unambiguous.
  if (comparison.status === 'STALE') {
    reasons.push('STALE');
  } else if (!depthOk || comparison.status === 'INSUFFICIENT_DEPTH') {
    reasons.push('INSUFFICIENT_DEPTH');
  } else if (comparison.status !== 'EXECUTABLE_NET_POSITIVE') {
    reasons.push('NOT_NET_POSITIVE');
  } else {
    if (!netSpreadOk) {
      reasons.push('NET_SPREAD_TOO_SMALL');
    }
    if (!netPnlOk) {
      reasons.push('NET_PNL_TOO_SMALL');
    }
    if (!syncOk) {
      reasons.push('SYNC_TOO_WIDE');
    }
  }

  return {
    qualified:
      comparison.status === 'EXECUTABLE_NET_POSITIVE' &&
      depthOk &&
      netSpreadOk &&
      netPnlOk &&
      syncOk,
    reasons,
    netSpreadOk,
    netPnlOk,
    syncOk,
    depthOk,
    requiredActiveDurationMs: config.minActiveDurationMs,
  };
}
