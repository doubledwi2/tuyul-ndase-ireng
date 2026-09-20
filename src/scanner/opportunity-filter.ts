import {
  validateOpportunityQualityConfig,
  type OpportunityQualityConfig,
} from '../config/opportunity.js';
import type { DepthComparison } from './depth-comparator.js';
import type { SyncAssessment } from '../timing/sync-model.js';

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
  syncAssessment?: SyncAssessment,
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
    syncAssessment === undefined
      ? comparison.status !== 'STALE' &&
        comparison.receiveTimeDifferenceMs <= config.maxSyncDiffMsForQualified
      : syncAssessment.status === 'SYNC_HEALTHY';
  const reasons: QualificationReason[] = [];

  if (syncAssessment !== undefined) {
    // Keep economic and timing failures independent so lifecycle logic can
    // distinguish disappearance from a transient synchronization problem.
    if (!depthOk || comparison.status === 'INSUFFICIENT_DEPTH') {
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
    }
    if (!syncOk) {
      reasons.push('STALE');
    }
  } else if (comparison.status === 'STALE') {
    // Preserve the Phase 2.2 quote/replay behavior for the compatibility path.
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
