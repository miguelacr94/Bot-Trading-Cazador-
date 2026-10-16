import { Spot } from '@binance/connector';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import { TelegramNotifier } from './notifier.js';

dotenv.config();

const STATE_FILE = '.cazador-state.json';
const WATCHLIST = ['SOLUSDT', 'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'AVAXUSDT', 'ADAUSDT', 'XRPUSDT'];

export class CazadorMasterBot {
  private client: any;
  private notifier: TelegramNotifier;
  private isScanning = false;

  constructor() {
    this.client = new Spot(process.env.BINANCE_API_KEY, process.env.BINANCE_API_SECRET, { recvWindow: 60000 });
    this.notifier = new TelegramNotifier();
  }

  private calculateRSI(closes: number[], period: number = 14): number {
    if (closes.length <= period) return 50;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) gains += diff;
      else losses += Math.abs(diff);
    }
    let avgGain = gains / period;
    let avgLoss = losses / period;
    for (let i = period + 1; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) {
        avgGain = (avgGain * (period - 1) + diff) / period;
        avgLoss = (avgLoss * (period - 1)) / period;
      } else {
        avgGain = (avgGain * (period - 1)) / period;
        avgLoss = (avgLoss * (period - 1) + Math.abs(diff)) / period;
      }
    }
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  async findBestDip(): Promise<{ symbol: string; rsi: number; dipDrop: number; curPrice: number } | null> {
    let bestPick: any = null;
    let bestScore = -100;

    for (const sym of WATCHLIST) {
      try {
        const klinesRes = await this.client.klines(sym, '15m', { limit: 40 });
        const closes = klinesRes.data.map((k: any) => parseFloat(k[4]));
        const highs = klinesRes.data.map((k: any) => parseFloat(k[2]));
        const lows = klinesRes.data.map((k: any) => parseFloat(k[3]));

        const rsi = this.calculateRSI(closes, 14);
        const maxRecent = Math.max(...highs);
        const minRecent = Math.min(...lows);
        const curPrice = closes[closes.length - 1];

        const dipDrop = ((maxRecent - curPrice) / maxRecent) * 100;
        const rangePos = ((curPrice - minRecent) / (maxRecent - minRecent)) * 100;

        if (rsi < 40 || rangePos < 20 || dipDrop >= 2.0) {
          const score = (50 - rsi) * 2 + dipDrop * 3 + (30 - rangePos);
          if (score > bestScore) {
            bestScore = score;
            bestPick = { symbol: sym, rsi, dipDrop, curPrice };
          }
        }
      } catch (e: any) {}
    }
    return bestPick;
  }

  async executeCycle() {
    if (this.isScanning) return;
    this.isScanning = true;

    try {
      // 1. VIGILAR TODAS LAS ÓRDENES DE VENTA ACTIVAS EN BINANCE
      const openOrders = await this.client.openOrders({ recvWindow: 60000 });
      const sellOrders = openOrders.data.filter((o: any) => o.side === 'SELL');

      // Consultar precios actuales de mercado
      const solTicker = await this.client.tickerPrice('SOLUSDT');
      const solPrice = parseFloat(solTicker.data.price);
      const time = new Date().toLocaleTimeString();

      const acc = await this.client.account({ recvWindow: 60000 });
      const usdt = parseFloat(acc.data.balances.find((b: any) => b.asset === 'USDT')?.free || '0');

      if (sellOrders.length > 0) {
        const targetsInfo = sellOrders.map((o: any) => {
          const target = parseFloat(o.price);
          const diffPct = (((target - solPrice) / solPrice) * 100);
          return `${o.symbol} Target: $${target.toFixed(2)} (Falta +${diffPct.toFixed(2)}%)`;
        }).join(' | ');

        console.log(`[${time}] SOL: $${solPrice.toFixed(3)} | USDT libre: $${usdt.toFixed(2)} | [ ${targetsInfo} ]`);
      } else {
        console.log(`[${time}] Sin órdenes de venta abiertas. USDT disponible para cazar: $${usdt.toFixed(2)}`);
      }

      // 2. SI HAY MÁS DE 10 USDT LIBRES -> CAZAR LA MEJOR OPORTUNIDAD EN CAÍDA
      if (usdt >= 10) {
        console.log(`\n💰 Saldo detectado ($${usdt.toFixed(2)} USDT). Escaneando mercado en busca del mejor suelo...`);
        const opp = await this.findBestDip();

        if (opp) {
          console.log(`🎯 OPORTUNIDAD DE COMPRA EN ${opp.symbol}: RSI ${opp.rsi.toFixed(1)} | Caída -${opp.dipDrop.toFixed(2)}%`);
          const investAmount = (usdt - 0.15).toFixed(2);
          
          console.log(`🚀 Comprando $${investAmount} USDT en ${opp.symbol}...`);
          const buyRes = await this.client.newOrder(opp.symbol, 'BUY', 'MARKET', {
            quoteOrderQty: investAmount,
            recvWindow: 60000
          });

          const spent = parseFloat(buyRes.data.cummulativeQuoteQty);
          const qty = parseFloat(buyRes.data.executedQty);
          const buyPrice = spent / qty;
          const targetPrice = buyPrice * 1.015; // Meta al +1.5%

          // Filtros de precisión del par
          const exInfo = await this.client.exchangeInfo({ symbol: opp.symbol });
          const sInfo = exInfo.data.symbols[0];
          const stepSize = parseFloat(sInfo.filters.find((f: any) => f.filterType === 'LOT_SIZE').stepSize);
          const tickSize = parseFloat(sInfo.filters.find((f: any) => f.filterType === 'PRICE_FILTER').tickSize);

          const qtyDec = Math.max(0, Math.round(-Math.log10(stepSize)));
          const priceDec = Math.max(0, Math.round(-Math.log10(tickSize)));

          const sellQtyStr = (Math.floor(qty / stepSize) * stepSize).toFixed(qtyDec);
          const targetPriceStr = targetPrice.toFixed(priceDec);

          console.log(`📌 Colocando orden LIMIT SELL permanente en Binance: ${sellQtyStr} ${opp.symbol} @ $${targetPriceStr} (+1.5%)...`);
          await this.client.newOrder(opp.symbol, 'SELL', 'LIMIT', {
            timeInForce: 'GTC',
            quantity: sellQtyStr,
            price: targetPriceStr,
            recvWindow: 60000
          });

          const alertMsg = `🦅 <b>¡EL CAZADOR ATRAPÓ UNA MONEDA EN EL SUELO!</b> 🚀\n\n` +
            `• <b>Moneda:</b> ${opp.symbol}\n` +
            `• <b>Precio de compra:</b> $${buyPrice.toFixed(4)}\n` +
            `• <b>Inversión:</b> $${spent.toFixed(2)} USDT\n` +
            `• 🎯 <b>Orden de venta colocada en Binance:</b> $${targetPriceStr} (+1.5%)\n` +
            `• 🛡️ <i>La orden está en Binance. Se liquidará con ganancia en el rebote.</i>`;
          console.log(alertMsg.replace(/<\/?b>/g, '').replace(/<\/?i>/g, ''));
          await this.notifier.send(alertMsg);
        } else {
          console.log(`⏳ Ninguna moneda en suelo extremo todavía. Esperando el mejor descuento...`);
        }
      }

    } catch (e: any) {
      console.error('Error en executeCycle:', e.message);
    } finally {
      this.isScanning = false;
    }
  }

  async start() {
    console.log(`\n======================================================`);
    console.log(`🦅 BOT CAZADOR INTEGRAL (MONITOREO + CAZA DE CAÍDAS)`);
    console.log(`======================================================\n`);

    await this.executeCycle();
    setInterval(() => this.executeCycle(), 10000);
  }
}

const bot = new CazadorMasterBot();
bot.start();
