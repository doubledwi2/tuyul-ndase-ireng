import type { LatencyProfile } from './config.js';
import type { PaperExecutionConfig } from '../config/paper.js';
import type { OpportunityQualityConfig } from '../config/opportunity.js';
import type { FeeConfig } from '../config/fees.js';
import type { ShadowExecutionOutcome, ShadowExecutionAttempt } from '../shadow-execution/shadow-execution-types.js';
import type { FundingStatus, FeeSource } from '../shadow/shadow-types.js';
export type Direction = 'BUY_BYBIT_SELL_OKX' | 'BUY_OKX_SELL_BYBIT';
export interface EvidenceManifest {
  schemaVersion: 1; runId: string; startedAt: number; appVersion: string;
  targetSize: number; profiles: LatencyProfile[]; paperExecutionConfig: PaperExecutionConfig;
  qualityThresholds: OpportunityQualityConfig; feeBaseline: FeeConfig;
  instrumentRuleMode: 'PUBLIC_CACHE' | 'SYNTHETIC_FROZEN' | 'DISABLED';
  context: 'LIVE_ACCOUNT_CONTEXT' | 'SYNTHETIC_ACCOUNT_CONTEXT';
  flags: { shadow: boolean; shadowExecution: boolean; privateRead: boolean; instrumentRules: boolean };
  configFingerprint: string;
}
export interface EvidenceRecord {
  schemaVersion: 1; runId: string; evidenceGroupId: string; scenarioId: string;
  triggeredAt: number; closedAt: number; direction: Direction;
  configuredTarget: number; ruleAdjustedTarget: number;
  ruleStatus: 'EXECUTABLE' | 'UNKNOWN' | 'NOT_EXECUTABLE'; ruleReasons: string[];
  ruleFingerprint: string; feeSources: { bybit: FeeSource; okx: FeeSource }; feeRates: { bybit: number; okx: number };
  fundingStatus: FundingStatus; cohort: 'ACCOUNT_CALIBRATED' | 'MARKET_ONLY';
  triggerNetPnl: number; finalNetPnl: number | null; outcome: ShadowExecutionOutcome;
  entryOutcome: ShadowExecutionAttempt['entryOutcome']; feasibility: ShadowExecutionAttempt['feasibility'];
  buyFillRatio: number; sellFillRatio: number; firstFillMs: number | null; timeToCompleteMs: number;
  unhedgedDurationMs: number; buyPriceDriftBps: number | null; sellPriceDriftBps: number | null; residualBtc: number;
}
