import type { PaperSessionSummary, PaperTrade } from './types.js';

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
  console.log(`USDT: ${summary.balances.bybit.usdtAvailable.toFixed(4)}`);
  console.log('');
  console.log('OKX');
  console.log(`BTC: ${summary.balances.okx.btcAvailable.toFixed(8)}`);
  console.log(`USDT: ${summary.balances.okx.usdtAvailable.toFixed(4)}`);
}
