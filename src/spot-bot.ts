import { scanMarketOpportunities } from './scanner.js';
import { Spot } from '@binance/connector';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import { TelegramNotifier } from './notifier.js';
import { TelegramCommands } from './telegram-commands.js';

dotenv.config();

const STATE_FILE = '.bot-state.json';

export interface BotConfig {
  apiKey: string;
  apiSecret: string;
  symbol: string;
  orderAmountUSDT: number;
  profitTargetPercent: number;
  pollIntervalMs: number;
}

export class BinanceSpotBot {
  private client: any;
  private config: BotConfig;
  private notifier: TelegramNotifier;
  private isRunning = false;
  private busy = false;
  private lastErrorAlert = 0;
  private paused = false;
  private startedAt = Date.now();
  private cyclesClosed = 0;
  private totalProfit = 0;
  private lastBuyPrice: number | null = null;
  private positionQty = 0;
  private stepSize = 0.001;
  private baseAsset: string;
  private quoteAsset = 'USDT';

  constructor(config: BotConfig) {
    this.config = config;
    this.client = new Spot(config.apiKey, config.apiSecret, { recvWindow: 60000 });
    this.notifier = new TelegramNotifier();
    this.baseAsset = config.symbol.replace(this.quoteAsset, '');
    this.loadState();
  }

  // Persistencia: si el bot se reinicia, recuerda la posición abierta y NO vuelve a comprar
  private loadState() {
    if (fs.existsSync(STATE_FILE)) {
      const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (s.symbol === this.config.symbol) {
        this.lastBuyPrice = s.lastBuyPrice;
        this.positionQty = s.positionQty;
      }
    }
  }

  private saveState() {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      symbol: this.config.symbol, lastBuyPrice: this.lastBuyPrice, positionQty: this.positionQty,
    }, null, 2));
  }

  private async loadFilters() {
    const res = await this.client.exchangeInfo({ symbol: this.config.symbol });
    const lot = res.data.symbols[0].filters.find((f: any) => f.filterType === 'LOT_SIZE');
    this.stepSize = parseFloat(lot.stepSize);
  }

  private floorToStep(qty: number): string {
    const decimals = Math.max(0, Math.round(-Math.log10(this.stepSize)));
    const floored = Math.floor(qty / this.stepSize) * this.stepSize;
    return floored.toFixed(decimals);
  }

  async getBalances() {
    const res = await this.client.account();
    const find = (a: string) => res.data.balances.find((b: any) => b.asset === a);
    return {
      baseBalance: parseFloat(find(this.baseAsset)?.free ?? '0'),
      quoteBalance: parseFloat(find(this.quoteAsset)?.free ?? '0'),
    };
  }

  async getCurrentPrice(): Promise<number> {
    const res = await this.client.tickerPrice(this.config.symbol);
    return parseFloat(res.data.price);
  }

  async executeBuy(): Promise<void> {
    const res = await this.client.newOrder(this.config.symbol, 'BUY', 'MARKET', {
      quoteOrderQty: this.config.orderAmountUSDT,
    });
    const d = res.data;
    const spent = parseFloat(d.cummulativeQuoteQty);
    const qty = parseFloat(d.executedQty);
    // Comisión cobrada en el activo base reduce la cantidad real recibida
    const feeBase = (d.fills ?? [])
      .filter((f: any) => f.commissionAsset === this.baseAsset)
      .reduce((s: number, f: any) => s + parseFloat(f.commission), 0);

    this.lastBuyPrice = spent / qty;               // precio promedio REAL de llenado
    this.positionQty = qty - feeBase;
    this.saveState();

    const target = this.lastBuyPrice * (1 + this.config.profitTargetPercent / 100);
    const msg = `🟢 <b>COMPRA SPOT EJECUTADA</b>\n\n` +
      `• Par: ${this.config.symbol}\n` +
      `• Precio promedio: $${this.lastBuyPrice.toFixed(3)}\n` +
      `• Cantidad: ${this.positionQty} ${this.baseAsset}\n` +
      `• Invertido: $${spent.toFixed(2)} USDT\n` +
      `• 🎯 Meta de venta: $${target.toFixed(3)} (+${this.config.profitTargetPercent}%)\n` +
      `• Order ID: ${d.orderId}`;
    console.log(msg.replace(/<\/?b>/g, ''));
    await this.notifier.send(msg);
  }

  async executeSell(): Promise<void> {
    const { baseBalance } = await this.getBalances();
    const qty = this.floorToStep(Math.min(this.positionQty, baseBalance));

    const res = await this.client.newOrder(this.config.symbol, 'SELL', 'MARKET', { quantity: qty });
    const received = parseFloat(res.data.cummulativeQuoteQty);
    const cost = this.lastBuyPrice! * parseFloat(qty);
    const pnl = received - cost - received * 0.001; // aprox. comisión 0.1% de la venta

    const msg = `🎉 <b>VENTA SPOT CON GANANCIA</b>\n\n` +
      `• Par: ${this.config.symbol}\n` +
      `• Vendido: ${qty} ${this.baseAsset}\n` +
      `• Recibido: $${received.toFixed(2)} USDT\n` +
      `• 💵 Ganancia neta aprox: $${pnl.toFixed(3)} USDT\n` +
      `• 🔄 Ciclo cerrado, buscando nueva entrada\n` +
      `• Order ID: ${res.data.orderId}`;
    console.log(msg.replace(/<\/?b>/g, ''));
    await this.notifier.send(msg);

    this.cyclesClosed++;
    this.totalProfit += pnl;
    this.lastBuyPrice = null;
    this.positionQty = 0;
    this.saveState();
  }

  async evaluateMarket(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const price = await this.getCurrentPrice();
      const { baseBalance, quoteBalance } = await this.getBalances();
      const t = new Date().toLocaleTimeString();

      if (this.lastBuyPrice === null) {
        console.log(`[${t}] ${this.config.symbol} $${price.toFixed(3)} | USDT libre: $${quoteBalance.toFixed(2)}`);
        if (this.paused) {
          console.log('⏸️ En pausa: no se abren nuevos ciclos.');
        } else if (quoteBalance >= this.config.orderAmountUSDT) {
          console.log('✨ Iniciando nuevo ciclo: compra a mercado...');
          await this.executeBuy();
        } else {
          console.log(`⏳ Saldo insuficiente (necesita $${this.config.orderAmountUSDT}).`);
        }
        return;
      }

      const target = this.lastBuyPrice * (1 + this.config.profitTargetPercent / 100);
      const pnlPct = ((price - this.lastBuyPrice) / this.lastBuyPrice) * 100;
      console.log(`[${t}] ${this.config.symbol} $${price.toFixed(3)} | Entrada $${this.lastBuyPrice.toFixed(3)} | PnL ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% | Meta $${target.toFixed(3)}`);

      if (price >= target) {
        console.log('🚀 Meta alcanzada, vendiendo...');
        await this.executeSell();
      }
    } catch (e: any) {
      const err = JSON.stringify(e.response?.data ?? e.message);
      console.error('⚠️ Error:', err);
      // Alerta al celular como máximo cada 30 min (ej. si cambia tu IP o se cae internet)
      if (Date.now() - this.lastErrorAlert > 30 * 60 * 1000) {
        this.lastErrorAlert = Date.now();
        await this.notifier.send(`⚠️ <b>Bot con error</b>\n${err}`);
      }
    } finally {
      this.busy = false;
    }
  }

  private async handleCommand(cmd: string): Promise<string> {
    try {
      if (cmd === '/menu' || cmd === 'menu' || cmd === '/help') {
        return `📱 <b>MENÚ COMPLETO DE COMANDOS</b>\n\n` +
          `• <b>/estado</b> - Ver PnL y precio de la operación activa\n` +
          `• <b>/reporte</b> - Resumen de ganancias y comisiones de 7 días\n` +
          `• <b>/radar</b> - Escanear el mercado en busca de oportunidades\n` +
          `• <b>/balance</b> - Consultar saldos libres en Binance Spot\n` +
          `• <b>/pausa</b> - Pausar nuevas compras (sigue vigilando la venta actual)\n` +
          `• <b>/reanudar</b> - Reanudar el ciclo de trading automático\n\n` +
          `💡 <i>Toca cualquiera de los comandos azules arriba para ejecutarlo.</i>`;
      }
      if (cmd === '/reporte' || cmd === 'reporte') {
        try {
          const res = await this.client.myTrades(this.config.symbol, { startTime: Date.now() - 7 * 24 * 60 * 60 * 1000, recvWindow: 60000 });
          const trades = res.data || [];
          let boughtUSDT = 0, soldUSDT = 0, feesUSDT = 0;
          for (const t of trades) {
            const q = parseFloat(t.quoteQty);
            if (t.isBuyer) boughtUSDT += q;
            else soldUSDT += q;
            const fee = parseFloat(t.commission);
            if (t.commissionAsset === "USDT") feesUSDT += fee;
            else if (t.commissionAsset === "SOL") feesUSDT += fee * parseFloat(t.price);
          }
          const price = await this.getCurrentPrice();
          const pnlFlotante = this.lastBuyPrice ? (price - this.lastBuyPrice) * this.positionQty : 0;
          return `📊 <b>REPORTE DE RENDIMIENTO (7 DÍAS)</b>\n\n` +
            `• <b>Par:</b> ${this.config.symbol}\n` +
            `• <b>Invertido:</b> ${boughtUSDT.toFixed(2)} USDT\n` +
            `• <b>Vendido:</b> ${soldUSDT.toFixed(2)} USDT\n` +
            `• <b>Comisiones:</b> -${feesUSDT.toFixed(4)} USDT\n` +
            `• <b>Ganancia Realizada:</b> +$0.00 USDT\n` +
            `• <b>Ganancia Flotante:</b> ${pnlFlotante >= 0 ? '+' : ''}${pnlFlotante.toFixed(3)} USDT\n` +
            `• <b>PnL Neto Actual:</b> 🟢 ${pnlFlotante >= 0 ? '+' : ''}${(pnlFlotante - feesUSDT).toFixed(3)} USDT\n\n` +
            `🎯 <i>Operación activa esperando meta de venta (+1.5%).</i>`;
        } catch (err: any) {
          return `⚠️ Error generando reporte: ${err.message}`;
        }
      }
      if (cmd === '/radar' || cmd === 'radar') {
        try {
          await scanMarketOpportunities();
          return "📡 <b>Radar de mercado ejecutado con éxito.</b>\nSi se detectó alguna moneda en sobreventa o suelo técnico, te llegará el aviso arriba.";
        } catch (e: any) {
          return "⚠️ Error escaneando el radar: " + e.message;
        }
      }
      if (cmd === '/estado' || cmd === 'estado' || cmd === '/start') {
        const price = await this.getCurrentPrice();
        const h = ((Date.now() - this.startedAt) / 3600000).toFixed(1);
        let txt = `📊 <b>Estado del bot</b>\n\n• ${this.config.symbol}: ${price.toFixed(3)}\n`;
        if (this.lastBuyPrice) {
          const target = this.lastBuyPrice * (1 + this.config.profitTargetPercent / 100);
          const pnl = ((price - this.lastBuyPrice) / this.lastBuyPrice) * 100;
          const usd = (price - this.lastBuyPrice) * this.positionQty;
          const falta = ((target - price) / price) * 100;
          txt += `• Entrada: ${this.lastBuyPrice.toFixed(3)}\n• PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}% (${usd >= 0 ? '+' : ''}${usd.toFixed(3)})\n• 🎯 Meta: ${target.toFixed(3)} (falta ${falta.toFixed(2)}%)\n`;
        } else {
          txt += `• Sin posición abierta\n`;
        }
        txt += `• Ciclos cerrados (esta sesión): ${this.cyclesClosed} | Ganancia: ${this.totalProfit.toFixed(3)}\n• Encendido hace ${h} h${this.paused ? '\n• ⏸️ EN PAUSA' : ''}`;
        return txt;
      }
      if (cmd === '/balance' || cmd === 'balance') {
        const { baseBalance, quoteBalance } = await this.getBalances();
        return `💼 <b>Balance Spot</b>\n• USDT: ${quoteBalance.toFixed(2)}\n• ${this.baseAsset}: ${baseBalance}`;
      }
      if (cmd === '/pausa' || cmd === 'pausa') {
        this.paused = true;
        return '⏸️ Pausado. No abrirá nuevas compras. Si hay posición abierta, la seguirá vigilando y venderá al llegar a la meta.';
      }
      if (cmd === '/reanudar' || cmd === 'reanudar') {
        this.paused = false;
        return '▶️ Reanudado. El ciclo continúa normal.';
      }
      return 'Comandos:\n/estado - cómo va la operación\n/balance - saldos en Spot\n/pausa - no abrir nuevas compras\n/reanudar - volver a operar';
    } catch (e: any) {
      return `⚠️ Error consultando: ${e.message}`;
    }
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    await this.loadFilters();
    console.log('======================================================');
    console.log('🤖 BOT SPOT INICIADO');
    console.log(`📈 Par: ${this.config.symbol} | 💵 $${this.config.orderAmountUSDT} por ciclo | 🎯 +${this.config.profitTargetPercent}%`);
    if (this.lastBuyPrice) console.log(`♻️ Posición recuperada: ${this.positionQty} ${this.baseAsset} @ $${this.lastBuyPrice.toFixed(3)}`);
    console.log('======================================================');
    await this.notifier.send(`🤖 Bot iniciado en ${this.config.symbol}\nEscribe /estado para ver cómo va.`);
    new TelegramCommands((c) => this.handleCommand(c)).start();

    await this.evaluateMarket();
    setInterval(() => this.isRunning && this.evaluateMarket(), this.config.pollIntervalMs);
    // Escaneo de oportunidades cada 15 minutos en segundo plano
    setInterval(() => this.isRunning && scanMarketOpportunities(), 15 * 60 * 1000);
  }

  stop(): void {
    this.isRunning = false;
    console.log('🛑 Bot detenido.');
  }
}
