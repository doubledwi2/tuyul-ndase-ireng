import type { ExecutionAdapter } from './adapter.js';
import { requirePrivateCapability, type Exchange } from './capabilities.js';
import type { OrderRequest } from './orders.js';
import { LIVE_APPROVAL } from './safety.js';

export class DisabledLiveExecutionAdapter implements ExecutionAdapter {
  readonly mode = 'disabled-live' as const;
  readonly approval = LIVE_APPROVAL;
  constructor(private readonly exchange: Exchange) {}
  submitOrder(_input: OrderRequest): never { return requirePrivateCapability(this.exchange, 'privateTrade'); }
  cancelOrder(_orderId: string, _timestamp: number): never { return requirePrivateCapability(this.exchange, 'privateTrade'); }
  getOrderStatus(_orderId: string): never { return requirePrivateCapability(this.exchange, 'privateRead'); }
}
