import type { LatencyPaperTradingEngine, LatencyPaperExecutionInput } from '../paper/latency-engine.js';
import type { LatencyPaperTrade, PaperOrder } from '../paper/types.js';
import type { ExecutionAdapter } from './adapter.js';
import type { ExecutionApproval } from './safety.js';

// Existing engine submits a qualified two-leg opportunity, not arbitrary single
// orders. Keep that invariant; generic OrderRequest is a future DTO only.
export class PaperExecutionAdapter implements ExecutionAdapter<LatencyPaperExecutionInput, LatencyPaperTrade | null> {
  readonly mode = 'paper' as const;
  constructor(private readonly engine: LatencyPaperTradingEngine, private readonly ready: () => boolean = () => true) {}

  getApproval(): ExecutionApproval {
    const reasons: string[] = [];
    if (!this.ready()) reasons.push('NOT_READY');
    if (this.engine.getRiskSummary().state === 'RISK_HALTED') reasons.push('RISK_HALTED');
    return Object.freeze({ approved: reasons.length === 0, reasons: Object.freeze(reasons) });
  }

  submitOrder(input: LatencyPaperExecutionInput): LatencyPaperTrade | null {
    if (!this.ready()) return null;
    // Engine remains authoritative for timing, balances, risk and duplicates.
    // A risk halt produces its existing REJECTED trade, without an order/fill.
    return this.engine.triggerOpportunity(input);
  }
  cancelOrder(orderId: string, timestamp: number): PaperOrder {
    return this.engine.cancelPaperOrder(orderId, timestamp);
  }
  getOrderStatus(orderId: string): PaperOrder | null {
    return this.engine.getOrders().find(order => order.id === orderId) ?? null;
  }
}
