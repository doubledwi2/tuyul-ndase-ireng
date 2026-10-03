import { FEES } from '../config/fees.js';
import { evaluateShadow } from '../shadow/shadow-evaluator.js';
import type { ShadowInput } from '../shadow/shadow-types.js';
import type { OpportunityEvent } from '../scanner/opportunity.js';
import { simulateExecution } from '../scanner/execution-simulator.js';

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
// Only derived diagnostics escape; no account snapshot is retained.
export function prepareShadowTrigger(event: OpportunityEvent, input: ShadowInput) {
  const originalAssessment = evaluateShadow(input, event.targetBaseSize);
  const original = originalAssessment.directions.find(d => d.buyExchange === event.buyExchange)!;
  const rules = original.ruleAssessment;
  const target = rules.status === 'EXECUTABLE' ? rules.commonQuantity! : event.targetBaseSize;
  const assessment = target === event.targetBaseSize ? originalAssessment : evaluateShadow(input, target);
  const d = assessment.directions.find(d => d.buyExchange === event.buyExchange)!;
  const rate = (ex: 'bybit' | 'okx') => assessment.feeSourceByExchange[ex] === 'ACCOUNT_OBSERVED'
    ? input.accounts[ex].fee!.takerFeeRate.normalizedCostRate : FEES[ex].takerRate;
  return freeze({ at: input.evaluatedAt, syncStatus: input.sync.status, target, assessment, d, rules,
    originalNetPnl: original.shadowNetPnl, postRuleNetPnl: original.ruleCalibratedNetPnl,
    buyPrice: simulateExecution(input.books[event.buyExchange], 'BUY', target).averageExecutionPrice!,
    sellPrice: simulateExecution(input.books[event.sellExchange], 'SELL', target).averageExecutionPrice!,
    rates: { bybit: rate('bybit'), okx: rate('okx') } });
}
export type PreparedShadowTrigger = ReturnType<typeof prepareShadowTrigger>;
