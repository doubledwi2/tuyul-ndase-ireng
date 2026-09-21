import { PAPER_BALANCE_EPSILON } from '../config/paper.js';

export interface PaperBalance {
  exchange: 'bybit' | 'okx';
  btcAvailable: number;
  usdtAvailable: number;
}

export type PaperBalances = Record<PaperBalance['exchange'], PaperBalance>;

export interface PaperSettlement {
  buyExchange: PaperBalance['exchange'];
  sellExchange: PaperBalance['exchange'];
  buyNotional: number;
  sellNotional: number;
  buyFee: number;
  sellFee: number;
  buyFilledSize: number;
  sellFilledSize: number;
}

function validateAmount(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be finite and non-negative.`);
  }
}

function clampResidual(value: number): number {
  return Math.abs(value) <= PAPER_BALANCE_EPSILON ? 0 : value;
}

export function clonePaperBalances(
  balances: Readonly<PaperBalances>,
): PaperBalances {
  return {
    bybit: { ...balances.bybit },
    okx: { ...balances.okx },
  };
}

export function createPaperBalances(
  balances: Readonly<PaperBalances>,
): PaperBalances {
  const cloned = clonePaperBalances(balances);
  for (const exchange of ['bybit', 'okx'] as const) {
    const balance = cloned[exchange];
    if (balance.exchange !== exchange) {
      throw new RangeError(`Paper balance exchange mismatch for ${exchange}.`);
    }
    validateAmount(`${exchange} BTC balance`, balance.btcAvailable);
    validateAmount(`${exchange} USDT balance`, balance.usdtAvailable);
  }
  return cloned;
}

export function applyPaperBuy(
  balance: Readonly<PaperBalance>,
  buyNotional: number,
  buyFee: number,
  filledSize: number,
): PaperBalance {
  validateAmount('Current BTC balance', balance.btcAvailable);
  validateAmount('Current USDT balance', balance.usdtAvailable);
  validateAmount('Buy notional', buyNotional);
  validateAmount('Buy fee', buyFee);
  validateAmount('Buy filled size', filledSize);
  const requiredUsdt = buyNotional + buyFee;
  if (balance.usdtAvailable + PAPER_BALANCE_EPSILON < requiredUsdt) {
    throw new RangeError('Insufficient paper USDT for buy leg.');
  }
  return {
    exchange: balance.exchange,
    btcAvailable: balance.btcAvailable + filledSize,
    usdtAvailable: clampResidual(balance.usdtAvailable - requiredUsdt),
  };
}

export function applyPaperSell(
  balance: Readonly<PaperBalance>,
  sellNotional: number,
  sellFee: number,
  filledSize: number,
): PaperBalance {
  validateAmount('Current BTC balance', balance.btcAvailable);
  validateAmount('Current USDT balance', balance.usdtAvailable);
  validateAmount('Sell notional', sellNotional);
  validateAmount('Sell fee', sellFee);
  validateAmount('Sell filled size', filledSize);
  if (balance.btcAvailable + PAPER_BALANCE_EPSILON < filledSize) {
    throw new RangeError('Insufficient paper BTC for sell leg.');
  }
  const nextUsdt = balance.usdtAvailable + sellNotional - sellFee;
  if (nextUsdt < -PAPER_BALANCE_EPSILON) {
    throw new RangeError('Paper sell leg would produce negative USDT.');
  }
  return {
    exchange: balance.exchange,
    btcAvailable: clampResidual(balance.btcAvailable - filledSize),
    usdtAvailable: clampResidual(nextUsdt),
  };
}

export function settlePaperTradeAtomically(
  balances: Readonly<PaperBalances>,
  settlement: Readonly<PaperSettlement>,
): PaperBalances {
  if (settlement.buyExchange === settlement.sellExchange) {
    throw new RangeError('Paper trade legs must use different exchanges.');
  }
  const next = clonePaperBalances(balances);
  next[settlement.buyExchange] = applyPaperBuy(
    balances[settlement.buyExchange],
    settlement.buyNotional,
    settlement.buyFee,
    settlement.buyFilledSize,
  );
  next[settlement.sellExchange] = applyPaperSell(
    balances[settlement.sellExchange],
    settlement.sellNotional,
    settlement.sellFee,
    settlement.sellFilledSize,
  );
  return next;
}
