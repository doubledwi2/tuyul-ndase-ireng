import type { ShadowExecutionAttempt } from './shadow-execution-types.js';

export const SHADOW_EXECUTION_SAMPLE_LIMIT = 4096;
const empty = () => ({ attemptsTriggered: 0, terminalAttempts: 0, cleanFills: 0, partialBoth: 0, buyOnly: 0, sellOnly: 0,
  noFill: 0, unwound: 0, unwindFailed: 0, timeouts: 0, abortedShutdown: 0, abortedDetailLimit: 0,
  triggerPositiveFinalPositive: 0, triggerPositiveFinalNegative: 0, triggerPositiveNoFill: 0 });
type Counters = ReturnType<typeof empty>;
const sampleNames = ['buyFillRatio', 'sellFillRatio', 'matchedFillRatio', 'timeToFirstBuyFillMs', 'timeToFirstSellFillMs',
  'timeToCompleteMs', 'unhedgedDurationMs', 'firstEligibleBookDelayMs', 'netPnlAfterFees', 'triggerShadowNetPnl',
  'realizedShadowExecutionPnl', 'buyPriceDriftBps', 'sellPriceDriftBps'] as const;
type SampleName = typeof sampleNames[number];
class Bucket {
  readonly counts = empty();
  private readonly samples = new Map<SampleName, number[]>();
  triggered() { this.counts.attemptsTriggered++; }
  terminal(a: ShadowExecutionAttempt) {
    const c = this.counts; c.terminalAttempts++;
    const increment = (key: keyof Counters, condition: boolean) => { if (condition) c[key]++; };
    increment('cleanFills', a.outcome === 'CLEAN_FILL');
    increment('partialBoth', a.entryOutcome === 'PARTIAL_BOTH');
    increment('buyOnly', a.entryOutcome === 'BUY_ONLY'); increment('sellOnly', a.entryOutcome === 'SELL_ONLY');
    increment('noFill', a.buy.filledBtc === 0 && a.sell.filledBtc === 0);
    increment('unwound', a.outcome === 'UNWOUND'); increment('unwindFailed', a.outcome === 'UNWIND_FAILED');
    const aborted = a.outcome?.startsWith('ABORTED_') ?? false;
    increment('timeouts', !aborted && (a.outcome === 'TIMED_OUT' || a.outcome === 'UNWIND_FAILED' ||
      (a.closedAt! >= a.buy.deadlineAt && (a.buy.filledBtc < a.targetBtcSize || a.sell.filledBtc < a.targetBtcSize))));
    increment('abortedShutdown', a.outcome === 'ABORTED_SHUTDOWN');
    increment('abortedDetailLimit', a.outcome === 'ABORTED_DETAIL_LIMIT');
    const economicallyClosed = a.residualBtc === 0 && a.netPnlAfterFees !== null && !aborted;
    increment('triggerPositiveFinalPositive', a.triggerShadowNetPnl > 0 && economicallyClosed && a.netPnlAfterFees! > 0);
    increment('triggerPositiveFinalNegative', a.triggerShadowNetPnl > 0 && economicallyClosed && a.netPnlAfterFees! < 0);
    increment('triggerPositiveNoFill', a.triggerShadowNetPnl > 0 && !aborted && a.buy.filledBtc === 0 && a.sell.filledBtc === 0);
    const add = (name: SampleName, value: number | null) => {
      if (value === null || !Number.isFinite(value)) return;
      const values = this.samples.get(name) ?? []; values.push(value);
      if (values.length > SHADOW_EXECUTION_SAMPLE_LIMIT) values.shift();
      this.samples.set(name, values);
    };
    add('buyFillRatio', a.buy.filledBtc / a.targetBtcSize); add('sellFillRatio', a.sell.filledBtc / a.targetBtcSize);
    add('matchedFillRatio', Math.min(a.buy.filledBtc, a.sell.filledBtc) / a.targetBtcSize);
    add('timeToFirstBuyFillMs', a.buy.firstFillAt === null ? null : a.buy.firstFillAt - a.triggeredAt);
    add('timeToFirstSellFillMs', a.sell.firstFillAt === null ? null : a.sell.firstFillAt - a.triggeredAt);
    add('timeToCompleteMs', a.closedAt! - a.triggeredAt); add('unhedgedDurationMs', a.unhedgedDurationMs);
    add('firstEligibleBookDelayMs', a.buy.firstEligibleBookDelayMs); add('firstEligibleBookDelayMs', a.sell.firstEligibleBookDelayMs);
    add('netPnlAfterFees', a.netPnlAfterFees); add('realizedShadowExecutionPnl', a.netPnlAfterFees);
    add('triggerShadowNetPnl', a.triggerShadowNetPnl);
    add('buyPriceDriftBps', a.buyPriceDriftBps); add('sellPriceDriftBps', a.sellPriceDriftBps);
  }
  summary() {
    const distributions = Object.fromEntries(sampleNames.map(name => {
      const values = [...(this.samples.get(name) ?? [])].sort((a, b) => a - b);
      const p = (n: number) => values[Math.max(0, Math.ceil(values.length * n) - 1)] ?? null;
      return [name, { count: values.length, avg: values.length ? values.reduce((s, n) => s + n / values.length, 0) : null,
        P50: p(.5), P95: p(.95), P99: p(.99), min: values[0] ?? null, max: values.at(-1) ?? null }];
    }));
    return { ...this.counts, cleanFillRate: this.counts.terminalAttempts ? this.counts.cleanFills / this.counts.terminalAttempts : null, distributions };
  }
}
export class ShadowExecutionMetrics {
  private readonly all = new Bucket();
  private readonly directions = { bybit: new Bucket(), okx: new Bucket() };
  capacityRejected = 0;
  duplicateRejected = 0;
  triggered(a: ShadowExecutionAttempt) { this.all.triggered(); this.directions[a.buyExchange].triggered(); }
  terminal(a: ShadowExecutionAttempt) { this.all.terminal(a); this.directions[a.buyExchange].terminal(a); }
  summary() { return { ...this.all.summary(), capacityRejected: this.capacityRejected, duplicateRejected: this.duplicateRejected,
    byDirection: { BUY_BYBIT_SELL_OKX: this.directions.bybit.summary(), BUY_OKX_SELL_BYBIT: this.directions.okx.summary() },
    sampleLimit: SHADOW_EXECUTION_SAMPLE_LIMIT }; }
}
