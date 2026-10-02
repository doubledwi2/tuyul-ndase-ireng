import type { OpportunityEvent } from '../scanner/opportunity.js';
import type { ShadowInput } from '../shadow/shadow-types.js';
import type { NormalizedOrderBook } from '../types/orderbook.js';
import { ShadowExecutionEngine } from './shadow-execution-engine.js';

// Isolation boundary: observational failure cannot stop public/paper processing.
export class ShadowExecutionRuntime {
  private readonly engine: ShadowExecutionEngine;
  private diagnosticFailures = 0;
  constructor(readonly enabled: boolean) { this.engine = new ShadowExecutionEngine({ enabled }); }
  onOpportunity(event: OpportunityEvent, input: () => ShadowInput): void {
    if (!this.enabled || event.state !== 'QUALIFIED') return;
    try { this.engine.trigger(event, input()); } catch { this.diagnosticFailures++; }
  }
  onBook(book: NormalizedOrderBook, at: number): void {
    if (!this.enabled) return;
    try { this.engine.processOrderBook(book, at); } catch { this.diagnosticFailures++; }
  }
  tick(at: number): void {
    if (!this.enabled) return;
    try { this.engine.tick(at); } catch { this.diagnosticFailures++; }
  }
  shutdown(at: number): void { this.engine.shutdown(at); }
  getHealth() { return { ...this.engine.getHealth(), diagnosticFailures: this.diagnosticFailures }; }
  getMetrics() { return this.engine.getMetrics(); }
}
