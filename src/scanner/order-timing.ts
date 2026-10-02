// Shared simulation timing: deadline is submission + timeout, not arrival + timeout.
// At the deadline the current input may fill before remaining quantity expires.
export function eligibleOrderBook(order: { exchange: string; arrivalAt: number; deadlineAt: number }, exchange: string, at: number): boolean {
  return order.exchange === exchange && at >= order.arrivalAt && at <= order.deadlineAt;
}
