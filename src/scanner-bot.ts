import { Spot } from '@binance/connector';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import { TelegramNotifier } from './notifier.js';

dotenv.config();

const STATE_FILE = '.scanner-bot-state.json';
const WATCHLIST = ['SOLUSDT', 'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'AVAXUSDT', 'ADAUSDT', 'XRPUSDT'];

interface Position {
  symbol: string;
  buyPrice: number;
  qty: number;
  spentUSDT: number;
  sellOrderId: number | null;
  targetPrice: number;
}

export class OpportunityScannerBot {
  private client: any;
  private notifier: TelegramNotifier;
  private activePosition: Position | null = null;
  private isScanning = false;

  constructor() {
    this.client = new Spot(process.env.BINANCE_API_KEY, process.env.BINANCE_API_SECRET, { recvWindow: 60000 });
    this.notifier = new TelegramNotifier();
    this.loadState();
  }

  private loadState() {
    if (fs.existsSync(STATE_FILE)) {
      try {
        this.activePosition = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      } catch {}
    }
  }

  private saveState() {
    fs.writeFileSync(STATE_FILE, JSON.stringify(this.activePosition, null, 2));
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

  /**
   * Escanea toda la lista y selecciona el activo con MEJOR oportunidad técnica de rebote
   */
  async findBestOpportunity(): Promise<{ symbol: string; rsi: number; dipDrop: number; curPrice: number } | null> {
    console.log(`\n🔍 [RADAR MULTI-MONEDA] Escaneando ${WATCHLIST.length} pares en busca del mejor suelo...`);
    let bestPick: any = null;
    let bestScore = -100; // Mientras más bajo el RSI y más cerca del suelo, mayor score

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

        // % de caída desde el pico más reciente
        const dipDrop = ((maxRecent - curPrice) / maxRecent) * 100;
        // Posición dentro del rango (0% es el fondo)
        const rangePos = ((curPrice - minRecent) / (maxRecent - minRecent)) * 100;

        console.log(`• ${sym.padEnd(8)}: $${curPrice} | RSI(15m): ${rsi.toFixed(1)} | Caída reciente: -${dipDrop.toFixed(2)}% | Posición en suelo: ${rangePos.toFixed(1)}%`);

        // Filtro estricto: Solo monedas con caída real (RSI < 40 o caída > 2%)
        if (rsi < 40 || rangePos < 20 || dipDrop >= 2.5) {
          const score = (50 - rsi) * 2 + dipDrop * 3 + (30 - rangePos);
          if (score > bestScore) {
            bestScore = score;
            bestPick = { symbol: sym, rsi, dipDrop, curPrice };
          }
        }
      } catch (e: any) {
        console.error(`Error escaneando ${sym}:`, e.message);
      }
    }

    return bestPick;
  }

  async runCycle() {
    if (this.isScanning) return;
    this.isScanning = true;

    try {
      // 1. Si ya tenemos una posición abierta, vigilar si se vendió con ganancia
      if (this.activePosition && this.activePosition.sellOrderId) {
        const order = await this.client.getOrder(this.activePosition.symbol, {
          orderId: this.activePosition.sellOrderId,
          recvWindow: 60000
        });

        if (order.data.status === 'FILLED') {
          const cobrado = parseFloat(order.data.cummulativeQuoteQty);
          const ganancia = (cobrado - this.activePosition.spentUSDT).toFixed(2);

          const msg = `🎉 <b>¡CICLO COMPLETADO Y COBRADO CON GANANCIA!</b>\n\n` +
            `• <b>Moneda ganadora:</b> ${this.activePosition.symbol}\n` +
            `• <b>Precio de compra:</b> $${this.activePosition.buyPrice}\n` +
            `• <b>Precio de venta:</b> $${this.activePosition.targetPrice} (+1.5%)\n` +
            `• 💵 <b>Ganancia neta:</b> +$${ganancia} USDT\n` +
            `• 🔄 <b>Saldo liberado.</b> El bot iniciará un nuevo escaneo para buscar la siguiente moneda en caída.`;
          console.log(msg.replace(/<\/?b>/g, ''));
          await this.notifier.send(msg);

          this.activePosition = null;
          this.saveState();
        } else {
          // Mostrar progreso de la posición abierta
          const p = await this.client.tickerPrice(this.activePosition.symbol);
          const cur = parseFloat(p.data.price);
          const diffPct = (((this.activePosition.targetPrice - cur) / cur) * 100);
          console.log(`[${new Date().toLocaleTimeString()}] ${this.activePosition.symbol} $${cur} | Target: $${this.activePosition.targetPrice} (Falta +${diffPct.toFixed(2)}%)`);
        }
        return;
      }

      // 2. Si NO tenemos posición abierta, buscar USDT libres y encontrar la mejor caída
      const acc = await this.client.account({ recvWindow: 60000 });
      const usdt = parseFloat(acc.data.balances.find((b: any) => b.asset === 'USDT')?.free || '0');

      if (usdt < 10) {
        console.log(`[${new Date().toLocaleTimeString()}] Esperando saldo USDT libre para operar (Mínimo $10 USDT). Tienes: $${usdt.toFixed(2)}`);
        return;
      }

      // 3. Hay dinero libre -> Escanear el mercado
      const opp = await this.findBestOpportunity();
      if (!opp) {
        console.log(`⏳ Ninguna moneda cumple los filtros de descuento extremo en este momento. Esperando caídas para comprar barato...`);
        return;
      }

      console.log(`\n🎯 ¡OPORTUNIDAD DE ORO ENCONTRADA EN ${opp.symbol}!`);
      console.log(`RSI: ${opp.rsi.toFixed(1)} | Caída: -${opp.dipDrop.toFixed(2)}% | Precio: $${opp.curPrice}`);

      // Usar el capital disponible dejando 0.10 de margen
      const amountToInvest = (usdt - 0.15).toFixed(2);
      console.log(`🚀 Comprando $${amountToInvest} USDT en ${opp.symbol}...`);

      const buyRes = await this.client.newOrder(opp.symbol, 'BUY', 'MARKET', {
        quoteOrderQty: amountToInvest,
        recvWindow: 60000
      });

      const spent = parseFloat(buyRes.data.cummulativeQuoteQty);
      const qty = parseFloat(buyRes.data.executedQty);
      const buyPrice = spent / qty;

      // Calcular meta de venta en +1.5%
      const targetPrice = buyPrice * 1.015;

      // Obtener filtros de precisión del par
      const exInfo = await this.client.exchangeInfo({ symbol: opp.symbol });
      const sInfo = exInfo.data.symbols[0];
      const stepSize = parseFloat(sInfo.filters.find((f: any) => f.filterType === 'LOT_SIZE').stepSize);
      const tickSize = parseFloat(sInfo.filters.find((f: any) => f.filterType === 'PRICE_FILTER').tickSize);

      const qtyDec = Math.max(0, Math.round(-Math.log10(stepSize)));
      const priceDec = Math.max(0, Math.round(-Math.log10(tickSize)));

      const sellQtyStr = (Math.floor(qty / stepSize) * stepSize).toFixed(qtyDec);
      const targetPriceStr = targetPrice.toFixed(priceDec);

      // Colocar orden LIMIT SELL inmediata en Binance
      console.log(`📌 Colocando orden LIMIT SELL en Binance: ${sellQtyStr} ${opp.symbol} @ $${targetPriceStr}...`);
      const sellRes = await this.client.newOrder(opp.symbol, 'SELL', 'LIMIT', {
        timeInForce: 'GTC',
        quantity: sellQtyStr,
        price: targetPriceStr,
        recvWindow: 60000
      });

      this.activePosition = {
        symbol: opp.symbol,
        buyPrice,
        qty: parseFloat(sellQtyStr),
        spentUSDT: spent,
        sellOrderId: sellRes.data.orderId,
        targetPrice: parseFloat(targetPriceStr)
      };
      this.saveState();

      const alertMsg = `🎯 <b>NUEVA OPORTUNIDAD ENCONTRADA Y OPERADA</b> 🚀\n\n` +
        `• <b>Moneda:</b> ${opp.symbol}\n` +
        `• <b>Motivo:</b> Descuento/Caída detectada (RSI ${opp.rsi.toFixed(1)} / Caída -${opp.dipDrop.toFixed(2)}%)\n` +
        `• <b>Inversión:</b> $${spent.toFixed(2)} USDT\n` +
        `• <b>Precio compra:</b> $${buyPrice.toFixed(4)}\n` +
        `• 🎯 <b>Orden de venta colocada en Binance:</b> $${targetPriceStr} (+1.5%)\n` +
        `• 🛡️ <i>La venta está guardada en Binance. Se liquidará sola en cuanto rebote.</i>`;
      console.log(alertMsg.replace(/<\/?b>/g, '').replace(/<\/?i>/g, ''));
      await this.notifier.send(alertMsg);

    } catch (e: any) {
      console.error('Error en runCycle:', e.response?.data || e.message);
    } finally {
      this.isScanning = false;
    }
  }

  async start() {
    console.log(`\n======================================================`);
    console.log(`🦅 BOT CAZADOR DE OPORTUNIDADES MULTI-MONEDA INICIADO`);
    console.log(`🎯 Regla: Solo compra en caídas reales | Vende al +1.5% | Vuelve a escanear`);
    console.log(`======================================================\n`);

    await this.runCycle();
    setInterval(() => this.runCycle(), 15000);
  }
}
