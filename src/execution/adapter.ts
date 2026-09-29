import type { PaperOrder } from '../paper/types.js';
import type { OrderRequest } from './orders.js';

export interface ExecutionAdapter<Submission = OrderRequest, Result = PaperOrder> {
  readonly mode: 'paper' | 'disabled-live';
  submitOrder(input: Submission): Result;
  cancelOrder(orderId: string, timestamp: number): PaperOrder;
  getOrderStatus(orderId: string): PaperOrder | null;
}
