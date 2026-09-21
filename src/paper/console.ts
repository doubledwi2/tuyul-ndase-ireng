import type {
  LatencyPaperTrade,
  PaperExecutionMetrics,
  PaperSessionSummary,
  PaperTrade,
} from './types.js';

function amount(value: number | null, digits = 4): string {
  return value === null ? 'N/A' : value.toFixed(digits);
}

export function printPaperTrade(trade: PaperTrade): void {
  console.log('\n[PAPER TRADE]');
  console.log(`ID: ${trade.id}`);
  console.log(`Opportunity: ${trade.opportunityEventId}`);
  console.log(
    `Direction: ${trade.buyExchange.toUpperCase()} -> ` +
      `${trade.sellExchange.toUpperCase()}`,
  );
  console.log(`State: ${trade.state}`);
  if (trade.rejectionReason !== null) {
    console.log(`Rejection: ${trade.rejectionReason}`);
  }
  console.log(`Size: ${trade.requestedBaseSize.toFixed(8)} BTC`);
  console.log(`Buy notional: ${amount(trade.buyNotional)} USDT`);
  console.log(`Sell notional: ${amount(trade.sellNotional)} USDT`);
  console.log(`Fees: ${amount(trade.totalFee)} USDT`);
  console.log(`Gross paper PnL: ${amount(trade.grossPnl)} USDT`);
  console.log(`Net trade PnL: ${amount(trade.netPnl)} USDT`);
}

export function printPaperSummary(summary: PaperSessionSummary): void {
  console.log('\n[PAPER]');
  console.log(`Trades attempted: ${summary.tradesAttempted}`);
  console.log(`Trades filled: ${summary.tradesFilled}`);
  console.log(`Trades rejected: ${summary.tradesRejected}`);
  console.log(`Gross paper PnL: ${summary.grossPaperPnl.toFixed(4)} USDT`);
  console.log(`Fees paid: ${summary.feesPaid.toFixed(4)} USDT`);
  console.log(`Net trade PnL: ${summary.netTradePnl.toFixed(4)} USDT`);
  console.log('');
  console.log('Portfolio:');
  console.log(`Reference BTC price: ${amount(summary.referenceBtcPrice, 2)} USDT`);
  console.log(
    `Initial value: ${amount(summary.initialPortfolioValueUsdt, 2)} USDT`,
  );
  console.log(
    `Current value: ${amount(summary.currentPortfolioValueUsdt, 2)} USDT`,
  );
  console.log(`MTM PnL: ${amount(summary.paperPortfolioPnlUsdt, 4)} USDT`);
  console.log(`Total BTC: ${summary.totalBTC.toFixed(8)}`);
  console.log(`Total USDT: ${summary.totalUSDT.toFixed(4)}`);
  console.log('');
  console.log('BYBIT');
  console.log(`BTC: ${summary.balances.bybit.btcAvailable.toFixed(8)}`);
  console.log(`BTC reserved: ${summary.balances.bybit.btcReserved.toFixed(8)}`);
  console.log(`USDT: ${summary.balances.bybit.usdtAvailable.toFixed(4)}`);
  console.log(
    `USDT reserved: ${summary.balances.bybit.usdtReserved.toFixed(4)}`,
  );
  console.log('');
  console.log('OKX');
  console.log(`BTC: ${summary.balances.okx.btcAvailable.toFixed(8)}`);
  console.log(`BTC reserved: ${summary.balances.okx.btcReserved.toFixed(8)}`);
  console.log(`USDT: ${summary.balances.okx.usdtAvailable.toFixed(4)}`);
  console.log(`USDT reserved: ${summary.balances.okx.usdtReserved.toFixed(4)}`);
}

export function printLatencyPaperTrade(trade: LatencyPaperTrade): void {
  console.log('\n[PAPER EXECUTION]');
  console.log(`Trade: ${trade.id}`);
  console.log(
    `Direction: ${trade.buyExchange.toUpperCase()} -> ${trade.sellExchange.toUpperCase()}`,
  );
  console.log(`State: ${trade.state}`);
  console.log(`Outcome: ${trade.outcome ?? 'PENDING'}`);
  console.log(
    `Entry fills: BUY ${trade.buyFilledSize.toFixed(8)} / SELL ${trade.sellFilledSize.toFixed(8)} BTC`,
  );
  console.log(`Residual: ${trade.residualBaseExposure.toFixed(8)} BTC`);
  console.log(`Paper realized PnL: ${trade.realizedPaperPnl.toFixed(4)} USDT`);
  if (trade.rejectionReason !== null) {
    console.log(`Rejection: ${trade.rejectionReason}`);
  }
}

function distribution(
  averageValue: number | null,
  p50: number | null,
  p95: number | null,
  p99: number | null,
): string {
  return `${amount(averageValue, 2)} / ${amount(p50, 2)} / ${amount(p95, 2)} / ${amount(p99, 2)} ms`;
}

export function printPaperExecutionMetrics(
  metrics: PaperExecutionMetrics,
): void {
  console.log('\n[PAPER EXECUTION METRICS]');
  console.log(`Trades triggered: ${metrics.tradesTriggered}`);
  console.log(`Pre-trade rejections: ${metrics.pretradeRejections}`);
  console.log(`Execution failures: ${metrics.executionFailures}`);
  console.log(`Clean fills: ${metrics.cleanFills}`);
  console.log(`Partial trades: ${metrics.partialTrades}`);
  console.log(`Buy only / sell only: ${metrics.buyOnlyCount} / ${metrics.sellOnlyCount}`);
  console.log(`Unhedged trades: ${metrics.unhedgedTrades}`);
  console.log(
    `Unwind attempts/success/failure: ${metrics.unwindAttempts} / ${metrics.unwindSuccess} / ${metrics.unwindFailures}`,
  );
  console.log(`Order timeouts: ${metrics.timeouts}`);
  console.log(
    `BUY fill latency avg/P50/P95/P99: ${distribution(metrics.averageBuyFillLatencyMs, metrics.p50BuyFillLatencyMs, metrics.p95BuyFillLatencyMs, metrics.p99BuyFillLatencyMs)}`,
  );
  console.log(
    `SELL fill latency avg/P50/P95/P99: ${distribution(metrics.averageSellFillLatencyMs, metrics.p50SellFillLatencyMs, metrics.p95SellFillLatencyMs, metrics.p99SellFillLatencyMs)}`,
  );
  console.log(
    `Unwind fill latency avg/P50/P95/P99: ${distribution(metrics.averageUnwindFillLatencyMs, metrics.p50UnwindFillLatencyMs, metrics.p95UnwindFillLatencyMs, metrics.p99UnwindFillLatencyMs)}`,
  );
  console.log(
    `Unhedged duration avg/P50/P95/P99: ${distribution(metrics.averageUnhedgedDurationMs, metrics.p50UnhedgedDurationMs, metrics.p95UnhedgedDurationMs, metrics.p99UnhedgedDurationMs)}`,
  );
  console.log(
    `Residual BTC avg/max: ${amount(metrics.averageAbsoluteResidualBtc, 8)} / ${amount(metrics.maxAbsoluteResidualBtc, 8)}`,
  );
  console.log(`Paper entry PnL: ${metrics.paperEntryPnl.toFixed(4)} USDT`);
  console.log(`Paper unwind cost: ${metrics.paperUnwindCost.toFixed(4)} USDT`);
  console.log(
    `Paper final trade PnL: ${metrics.paperFinalTradePnl.toFixed(4)} USDT`,
  );
}
