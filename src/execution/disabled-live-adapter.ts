import type { ExecutionAdapter } from './adapter.js';
import type { Exchange } from './capabilities.js';
import type { OrderRequest } from './orders.js';
import { ExecutionSafetyError, LIVE_APPROVAL } from './safety.js';

export class DisabledLiveExecutionAdapter implements ExecutionAdapter {
  readonly mode = 'disabled-live' as const;
  readonly approval = LIVE_APPROVAL;
  constructor(private readonly exchange: Exchange) {}
  submitOrder(_input: OrderRequest): never { throw new ExecutionSafetyError(); }
  cancelOrder(_orderId: string, _timestamp: number): never { throw new ExecutionSafetyError(); }
  getOrderStatus(_orderId: string): never { throw new ExecutionSafetyError(); }
}
