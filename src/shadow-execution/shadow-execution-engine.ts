import { randomUUID } from 'node:crypto';
import { RuleCalibrationMetrics } from '../instrument-rules/metrics.js';
import { MAX_PAPER_TRIGGER_AGE_MS, PAPER_BALANCE_EPSILON as EPS, PAPER_EXECUTION_CONFIG,
  validatePaperExecutionConfig, type PaperExecutionConfig } from '../config/paper.js';
import type { OpportunityEvent } from '../scanner/opportunity.js';
import { simulateExecution } from '../scanner/execution-simulator.js';
import { eligibleOrderBook } from '../scanner/order-timing.js';
import { prepareShadowTrigger, type PreparedShadowTrigger } from './prepared-trigger.js';
import type { ShadowInput } from '../shadow/shadow-types.js';
import { isValidNormalizedOrderBook, type NormalizedOrderBook } from '../types/orderbook.js';
import { ShadowExecutionMetrics } from './shadow-execution-metrics.js';
import type { ShadowExecutionAttempt, ShadowExecutionOutcome, ShadowExecutionState, ShadowLeg } from './shadow-execution-types.js';

export const MAX_ACTIVE_SHADOW_ATTEMPTS = 100;
export const MAX_RECENT_SHADOW_ATTEMPTS = 10_000;
export const MAX_ATTEMPT_DETAIL = 64;
interface Options {
  enabled?: boolean; config?: PaperExecutionConfig; idGenerator?: () => string;
  maxActive?: number; maxRecent?: number;
  onTerminal?: (attempt: ShadowExecutionAttempt) => void;
}
export class ShadowExecutionEngine {
  readonly enabled: boolean;
  private readonly config: Readonly<PaperExecutionConfig>;
  private readonly maxActive: number;
  private readonly maxRecent: number;
  private readonly id: () => string;
  private readonly onTerminal: Options['onTerminal'];
  private readonly active = new Map<string, ShadowExecutionAttempt>();
  private readonly recent: ShadowExecutionAttempt[] = [];
  private readonly seen = new Set<string>();
  private readonly processedBooks = new WeakSet<NormalizedOrderBook>();
  private readonly metrics = new ShadowExecutionMetrics();
  private readonly ruleMetrics = new RuleCalibrationMetrics();
  private sequence = 0;
  private lastTime = 0;
  private retiredBefore = -1;
  private stopped = false;
  private lastTriggeredAt: number | null = null;
  private lastTerminalAt: number | null = null;
  constructor(options: Options = {}) {
    this.enabled = options.enabled ?? false;
    this.config = Object.freeze({ ...(options.config ?? PAPER_EXECUTION_CONFIG) });
    validatePaperExecutionConfig(this.config);
    for (const n of Object.values(this.config)) if (typeof n === 'number' && (!Number.isSafeInteger(n) || n > 60_000)) throw new RangeError('Invalid shadow timing model.');
    this.maxActive = options.maxActive ?? MAX_ACTIVE_SHADOW_ATTEMPTS;
    this.maxRecent = options.maxRecent ?? MAX_RECENT_SHADOW_ATTEMPTS;
    for (const [n, limit] of [[this.maxActive, MAX_ACTIVE_SHADOW_ATTEMPTS], [this.maxRecent, MAX_RECENT_SHADOW_ATTEMPTS]] as const) {
      if (!Number.isSafeInteger(n) || n < 1 || n > limit) throw new RangeError('Invalid shadow retention bound.');
    }
    this.id = options.idGenerator ?? randomUUID;
    this.onTerminal = options.onTerminal;
  }
  private time(at: number) {
    if (!Number.isSafeInteger(at) || at < this.lastTime) throw new RangeError('Shadow logical time must be monotonic.');
    this.lastTime = at;
  }
  private leg(exchange: ShadowLeg['exchange'], side: ShadowLeg['side'], size: number, at: number, latency: number): ShadowLeg {
    return { exchange, side, requestedBtc: size, arrivalAt: at + latency, deadlineAt: at + this.config.orderTimeoutMs,
      filledBtc: 0, notional: 0, fee: 0, firstFillAt: null, firstEligibleBookDelayMs: null, done: false };
  }
  trigger(event: OpportunityEvent, input: ShadowInput): { accepted: boolean; reason: string | null; attempt: ShadowExecutionAttempt | null } {
    return this.triggerRejection(event, input.evaluatedAt, input.sync.status) ?? this.activate(event, prepareShadowTrigger(event, input));
  }
  triggerPrepared(event: OpportunityEvent, prepared: PreparedShadowTrigger): { accepted: boolean; reason: string | null; attempt: ShadowExecutionAttempt | null } {
    return this.triggerRejection(event, prepared.at, prepared.syncStatus) ?? this.activate(event, prepared);
  }
  private triggerRejection(event: OpportunityEvent, at: number, syncStatus: PreparedShadowTrigger['syncStatus']) {
    const reject = (reason: string) => ({ accepted: false, reason, attempt: null });
    if (!this.enabled || this.stopped) return reject('SHADOW_DISABLED');
    this.time(at);
    if (event.state !== 'QUALIFIED' || syncStatus !== 'SYNC_HEALTHY' || event.currentEstimatedNetPnlAbsolute <= 0 ||
      !Number.isFinite(event.currentEstimatedNetPnlAbsolute) || !Number.isFinite(event.updatedAt) ||
      at < event.updatedAt || at - event.updatedAt > MAX_PAPER_TRIGGER_AGE_MS ||
      event.buyExchange === event.sellExchange || event.symbol !== 'BTC/USDT') return reject('NOT_FRESH_QUALIFIED');
    if (this.seen.has(event.id) || event.detectedAt <= this.retiredBefore) {
      this.metrics.duplicateRejected++; return reject('DUPLICATE_OR_RETIRED_OPPORTUNITY');
    }
    if (this.active.size >= this.maxActive) { this.metrics.capacityRejected++; return reject('SHADOW_CAPACITY_LIMIT'); }
    return null;
  }
  private activate(event: OpportunityEvent, prepared: PreparedShadowTrigger) {
    const reject = (reason: string) => ({ accepted: false, reason, attempt: null });
    const at = prepared.at;
    const { rules, target, assessment, d, buyPrice, sellPrice, rates } = prepared;
    this.ruleMetrics.record(rules, prepared.originalNetPnl, prepared.postRuleNetPnl);
    if (rules.status === 'NOT_EXECUTABLE') return reject('NOT_EXECUTABLE_RULES');
    if (d.economicsStatus === 'SHADOW_UNCERTAIN' || d.shadowNetPnl === null) return reject('INVALID_TRIGGER_BOOKS');
    const a: ShadowExecutionAttempt = {
      configuredTargetBtc: event.targetBaseSize, ruleAdjustedTargetBtc: target,
      ruleFreshAtTrigger: rules.status === 'EXECUTABLE', ruleAssessment: structuredClone(rules),
      id: this.id(), opportunityEventId: event.id, triggeredAt: at, closedAt: null,
      buyExchange: event.buyExchange, sellExchange: event.sellExchange, targetBtcSize: target,
      buy: this.leg(event.buyExchange, 'BUY', target, at, this.config.buyOrderLatencyMs),
      sell: this.leg(event.sellExchange, 'SELL', target, at, this.config.sellOrderLatencyMs), unwind: null,
      state: 'WAITING_ARRIVAL', outcome: null, entryOutcome: null, residualBtc: 0, unhedgedStartedAt: null, unhedgedDurationMs: 0,
      feeSources: Object.freeze({ ...assessment.feeSourceByExchange }), feeRates: Object.freeze({ ...rates }),
      fundingAssessment: { status: d.fundingStatus, reasons: [...d.fundingReasons] },
      degraded: assessment.degraded || rules.status !== 'EXECUTABLE',
      reasons: [...assessment.reasons, ...(rules.status === 'UNKNOWN' ? ['RULE_SOURCE_UNAVAILABLE'] : [])], triggerBuyPrice: buyPrice, triggerSellPrice: sellPrice,
      triggerShadowNetPnl: d.shadowNetPnl, buyPriceDriftBps: null, sellPriceDriftBps: null,
      grossPnl: null, buyFee: 0, sellFee: 0, unwindFee: 0, unwindNotional: 0, unwindRealizedPnl: 0,
      netPnlAfterFees: null, unallocatedEntryFees: 0, feasibility: 'UNCERTAIN', fills: [], fillCount: 0,
      transitions: [{ at, state: 'WAITING_ARRIVAL' }],
    };
    this.active.set(event.id, a); this.seen.add(event.id); this.lastTriggeredAt = at; this.metrics.triggered(a);
    return { accepted: true, reason: null, attempt: structuredClone(a) };
  }
  processOrderBook(book: NormalizedOrderBook, at: number): void {
    if (!this.enabled || this.stopped || !isValidNormalizedOrderBook(book) || this.processedBooks.has(book)) return;
    this.time(at);
    if (book.receivedTimestamp > at) return; // Explicit future-input guard; no cached fill path exists.
    this.processedBooks.add(book); this.sequence++;
    for (const a of [...this.active.values()]) {
      // Snapshot orders BEFORE refreshing timers: a newly created unwind cannot
      // consume the same input that caused it, even with a zero latency model.
      if (a.unwind) this.fill(a, a.unwind, 'unwind', book, at);
      else { this.fill(a, a.buy, 'buy', book, at); this.fill(a, a.sell, 'sell', book, at); }
      this.refresh(a, at);
    }
  }
  tick(at: number): void {
    if (!this.enabled || this.stopped) return;
    this.time(at);
    for (const a of [...this.active.values()]) this.refresh(a, at);
  }
  private fill(a: ShadowExecutionAttempt, leg: ShadowLeg, name: 'buy' | 'sell' | 'unwind', book: NormalizedOrderBook, at: number) {
    // Diagnostic latency at/above TTL leaves no execution window.
    if (leg.arrivalAt >= leg.deadlineAt) return;
    if (a.closedAt !== null || leg.done || !eligibleOrderBook(leg, book.exchange, at)) return;
    leg.firstEligibleBookDelayMs ??= at - leg.arrivalAt;
    const simulation = simulateExecution(book, leg.side, leg.requestedBtc - leg.filledBtc);
    if (simulation.filledSize <= EPS || (!this.config.allowPartialFill && !simulation.fullyFilled)) return;
    if (a.fills.length >= MAX_ATTEMPT_DETAIL) {
      a.degraded = true; a.reasons.push('SHADOW_DETAIL_CAPACITY_LIMIT');
      this.close(a, 'ABORTED_DETAIL_LIMIT', at); return;
    }
    const fee = simulation.notional * a.feeRates[leg.exchange];
    if (!Number.isFinite(simulation.notional) || !Number.isFinite(fee) || !Number.isFinite(leg.notional + simulation.notional)) {
      a.degraded = true; a.reasons.push('NON_FINITE_FILL'); this.close(a, 'TIMED_OUT', at); return;
    }
    leg.filledBtc += simulation.filledSize; leg.notional += simulation.notional; leg.fee += fee;
    leg.firstFillAt ??= at; leg.done = leg.requestedBtc - leg.filledBtc <= EPS;
    a.fillCount++; a.fills.push({ sequence: this.sequence, at, leg: name, size: simulation.filledSize, notional: simulation.notional, fee });
  }
  private state(a: ShadowExecutionAttempt, state: ShadowExecutionState, at: number) {
    if (state === a.state) return;
    a.state = state; a.transitions.push({ at, state });
    // Each state change needs a fill or one of the finite arrival/deadline
    // transitions. With the fill-detail cap this array is bounded as well.
  }
  private economics(a: ShadowExecutionAttempt) {
    const b = a.buy, s = a.sell, u = a.unwind;
    const matched = Math.min(b.filledBtc, s.filledBtc);
    const bp = b.filledBtc > EPS ? b.notional / b.filledBtc : 0;
    const sp = s.filledBtc > EPS ? s.notional / s.filledBtc : 0;
    const entryBuyFee = b.filledBtc > EPS ? b.fee * matched / b.filledBtc : 0;
    const entrySellFee = s.filledBtc > EPS ? s.fee * matched / s.filledBtc : 0;
    let gross = matched * (sp - bp), allocatedFees = entryBuyFee + entrySellFee;
    a.unwindRealizedPnl = 0;
    if (u && u.filledBtc > EPS) {
      const entry = u.side === 'SELL' ? b : s;
      const extraGross = u.side === 'SELL' ? u.notional - u.filledBtc * bp : u.filledBtc * sp - u.notional;
      const entryFee = entry.fee * u.filledBtc / entry.filledBtc;
      gross += extraGross; allocatedFees += entryFee + u.fee;
      a.unwindRealizedPnl = extraGross - entryFee - u.fee;
    }
    a.buyFee = b.fee; a.sellFee = s.fee; a.unwindFee = u?.fee ?? 0; a.unwindNotional = u?.notional ?? 0;
    a.unallocatedEntryFees = b.fee + s.fee + a.unwindFee - allocatedFees;
    const meaningful = matched > EPS || (u?.filledBtc ?? 0) > EPS;
    a.grossPnl = meaningful ? gross : null; a.netPnlAfterFees = meaningful ? gross - allocatedFees : null;
    a.buyPriceDriftBps = b.filledBtc > EPS ? (bp / a.triggerBuyPrice - 1) * 10_000 : null;
    a.sellPriceDriftBps = s.filledBtc > EPS ? (sp / a.triggerSellPrice - 1) * 10_000 : null;
  }
  private refresh(a: ShadowExecutionAttempt, at: number) {
    if (a.closedAt !== null) return;
    for (const leg of [a.buy, a.sell, a.unwind]) if (leg && at >= leg.deadlineAt) leg.done = true;
    const previousUnhedged = a.unhedgedStartedAt;
    a.residualBtc = a.buy.filledBtc - a.sell.filledBtc + (a.unwind ? a.unwind.filledBtc * (a.unwind.side === 'BUY' ? 1 : -1) : 0);
    if (Math.abs(a.residualBtc) <= EPS) a.residualBtc = 0;
    if (a.residualBtc !== 0) a.unhedgedStartedAt ??= at;
    else if (previousUnhedged !== null) { a.unhedgedDurationMs += at - previousUnhedged; a.unhedgedStartedAt = null; }
    this.economics(a);
    a.entryOutcome = a.buy.filledBtc <= EPS && a.sell.filledBtc <= EPS ? 'NO_FILL' : a.sell.filledBtc <= EPS ? 'BUY_ONLY' :
      a.buy.filledBtc <= EPS ? 'SELL_ONLY' : a.buy.filledBtc >= a.targetBtcSize - EPS && a.sell.filledBtc >= a.targetBtcSize - EPS ? 'CLEAN_FILL' : 'PARTIAL_BOTH';
    if (a.unwind) {
      if (a.residualBtc === 0) this.close(a, 'UNWOUND', at);
      else if (a.unwind.done) this.close(a, 'UNWIND_FAILED', at);
      return;
    }
    if (a.entryOutcome === 'CLEAN_FILL') { this.close(a, 'CLEAN_FILL', at); return; }
    if (a.buy.done && a.sell.done && a.residualBtc === 0) {
      this.close(a, a.entryOutcome === 'NO_FILL' ? 'TIMED_OUT' : 'PARTIAL_BOTH', at); return;
    }
    if (a.unhedgedStartedAt !== null && at - a.unhedgedStartedAt >= this.config.maxUnhedgedDurationMs) {
      a.buy.done = true; a.sell.done = true;
      a.unwind = this.leg(a.residualBtc > 0 ? a.buyExchange : a.sellExchange, a.residualBtc > 0 ? 'SELL' : 'BUY',
        Math.abs(a.residualBtc), at, this.config.unwindOrderLatencyMs);
      this.state(a, 'UNWINDING', at); return;
    }
    this.state(a, a.residualBtc !== 0 ? 'UNHEDGED' : a.buy.filledBtc > 0 || a.sell.filledBtc > 0 ? 'PARTIALLY_FILLED' :
      at >= Math.min(a.buy.arrivalAt, a.sell.arrivalAt) ? 'FILLING' : 'WAITING_ARRIVAL', at);
  }
  private close(a: ShadowExecutionAttempt, outcome: ShadowExecutionOutcome, at: number) {
    if (a.closedAt !== null) return;
    if (a.unhedgedStartedAt !== null) { a.unhedgedDurationMs += at - a.unhedgedStartedAt; a.unhedgedStartedAt = null; }
    a.closedAt = at; a.outcome = outcome;
    a.buy.done = true; a.sell.done = true; if (a.unwind) a.unwind.done = true;
    this.state(a, ['CLEAN_FILL', 'PARTIAL_BOTH', 'UNWOUND'].includes(outcome) ? 'COMPLETED' : outcome === 'TIMED_OUT' ? 'EXPIRED' : 'FAILED', at);
    a.feasibility = outcome === 'CLEAN_FILL' ? 'FEASIBLE_CLEAN' : ['PARTIAL_BOTH', 'UNWOUND'].includes(outcome)
      ? 'FEASIBLE_WITH_PARTIAL_OR_UNWIND' : outcome.startsWith('ABORTED_') ? 'UNCERTAIN' : 'NOT_FEASIBLE';
    this.metrics.terminal(a); this.lastTerminalAt = at; this.active.delete(a.opportunityEventId); this.recent.push(a);
    while (this.recent.length > this.maxRecent) {
      const expired = this.recent.shift()!; this.seen.delete(expired.opportunityEventId);
      // Conservative watermark rejects old events after their explicit ID is pruned.
      this.retiredBefore = Math.max(this.retiredBefore, expired.triggeredAt);
    }
    this.onTerminal?.(structuredClone(a));
  }
  shutdown(at: number): void {
    if (!this.enabled || this.stopped) return;
    // Shutdown is diagnostic, never a fill; a wall-clock step backwards must
    // not leave active observations immortal or disrupt paper cleanup.
    const finalAt = Math.max(at, this.lastTime);
    this.time(finalAt);
    for (const a of [...this.active.values()]) this.close(a, 'ABORTED_SHUTDOWN', finalAt);
    this.stopped = true;
  }
  getAttempts() { return structuredClone([...this.recent, ...this.active.values()]); }
  getMetrics() { return { ...this.metrics.summary(), ruleCalibration: this.ruleMetrics.summary() }; }
  getHealth() { return { enabled: this.enabled, activeAttempts: this.active.size, lastTriggeredAt: this.lastTriggeredAt,
    lastTerminalAt: this.lastTerminalAt, capacityHealthy: this.active.size < this.maxActive }; }
}
