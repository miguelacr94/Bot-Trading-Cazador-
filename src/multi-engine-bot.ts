import { Spot } from "@binance/connector";
import * as dotenv from "dotenv";
import { TelegramNotifier } from "./notifier.js";
import { TelegramCommands } from "./telegram-commands.js";

dotenv.config();

const WATCHLIST = ["ETHUSDT", "BTCUSDT", "AVAXUSDT", "ADAUSDT", "XRPUSDT", "BNBUSDT", "SOLUSDT"];
const TIMEOUT_SECONDS = 180; // 3 minutos para decidir

interface PendingOpportunity {
  symbol: string;
  rsi: number;
  dropPct: number;
  curPrice: number;
  targetPriceStr: string;
  investAmount: string;
  timer: NodeJS.Timeout;
  expiresAt: number;
}

export class InteractiveBot {
  private client: any;
  private notifier: TelegramNotifier;
  private telegramCommands: TelegramCommands;
  private isProcessing = false;
  private paused = false;
  private pendingOpp: PendingOpportunity | null = null;
  private lastPeriodicScan = 0;

  constructor() {
    this.client = new Spot(process.env.BINANCE_API_KEY, process.env.BINANCE_API_SECRET, { recvWindow: 60000 });
    this.notifier = new TelegramNotifier();
    this.telegramCommands = new TelegramCommands((cmd) => this.handleTelegramCommand(cmd));
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
   * Escanea el mercado priorizando monedas donde NO tengamos posiciones abiertas (diversificación).
   */
  async scanOpportunities(activeSymbols: Set<string>): Promise<{ symbol: string; rsi: number; dropPct: number; curPrice: number; targetPriceStr: string } | null> {
    let bestPick: any = null;
    let bestScore = -100;

    for (const sym of WATCHLIST) {
      try {
        const klinesRes = await this.client.klines(sym, "15m", { limit: 35 });
        const data = klinesRes.data;
        const closes = data.map((k: any) => parseFloat(k[4]));
        const highs = data.map((k: any) => parseFloat(k[2]));
        const lows = data.map((k: any) => parseFloat(k[3]));
        const opens = data.map((k: any) => parseFloat(k[1]));

        const rsi = this.calculateRSI(closes, 14);
        const curPrice = closes[closes.length - 1];
        const curOpen = opens[opens.length - 1];
        const maxRecent = Math.max(...highs.slice(-20));
        const minRecent = Math.min(...lows.slice(-20));

        const dropPct = ((maxRecent - curPrice) / maxRecent) * 100;
        const isDipping = rsi <= 38 || dropPct >= 1.8;
        const isRebounding = curPrice >= curOpen; // Vela verde o iniciando giro

        // PENALIZACIÓN DE DIVERSIFICACIÓN:
        // Si ya tenemos órdenes en esta moneda, le restamos 50 puntos para forzar buscar en OTRAS monedas
        const alreadyActive = activeSymbols.has(sym);
        let score = (45 - rsi) * 2 + dropPct * 3;
        if (alreadyActive) score -= 50;

        if (isDipping && isRebounding) {
          if (score > bestScore) {
            bestScore = score;
            const targetPrice = curPrice * 1.018; // +1.8%
            bestPick = { symbol: sym, rsi, dropPct, curPrice, targetPriceStr: targetPrice.toFixed(4) };
          }
        }
      } catch (e: any) {}
    }
    return bestPick;
  }

  /**
   * Ejecuta la compra y coloca inmediatamente la orden LIMIT SELL en Binance
   */
  async executeBuyAndLimitSell(opp: PendingOpportunity, isAutoTimeout = false) {
    try {
      console.log(`🚀 Ejecutando compra de $${opp.investAmount} USDT en ${opp.symbol} (${isAutoTimeout ? "AUTO-TIMEOUT" : "APROBADO POR USUARIO"})...`);
      
      const buyRes = await this.client.newOrder(opp.symbol, "BUY", "MARKET", {
        quoteOrderQty: opp.investAmount,
        recvWindow: 60000
      });

      const spent = parseFloat(buyRes.data.cummulativeQuoteQty);
      const qty = parseFloat(buyRes.data.executedQty);
      const buyPrice = spent / qty;
      const targetPrice = buyPrice * 1.018; // +1.8% Limpio

      const exInfo = await this.client.exchangeInfo({ symbol: opp.symbol });
      const sInfo = exInfo.data.symbols[0];
      const stepSize = parseFloat(sInfo.filters.find((f: any) => f.filterType === "LOT_SIZE").stepSize);
      const tickSize = parseFloat(sInfo.filters.find((f: any) => f.filterType === "PRICE_FILTER").tickSize);

      const qtyDec = Math.max(0, Math.round(-Math.log10(stepSize)));
      const priceDec = Math.max(0, Math.round(-Math.log10(tickSize)));

      const sellQtyStr = (Math.floor(qty / stepSize) * stepSize).toFixed(qtyDec);
      const targetPriceStr = targetPrice.toFixed(priceDec);

      console.log(`📌 Colocando orden LIMIT SELL en Binance: ${sellQtyStr} ${opp.symbol} @ $${targetPriceStr} (+1.8%)...`);
      await this.client.newOrder(opp.symbol, "SELL", "LIMIT", {
        timeInForce: "GTC",
        quantity: sellQtyStr,
        price: targetPriceStr,
        recvWindow: 60000
      });

      const motivo = isAutoTimeout 
        ? "⚡ <i>Tiempo de espera agotado (3 min). Comprado automáticamente para no perder el rebote.</i>"
        : "✅ <i>Compra autorizada directamente por ti en Telegram.</i>";

      const alertMsg = `🦅 <b>¡OPERACIÓN EJECUTADA CON ÉXITO!</b> 🚀\n\n` +
        `• <b>Par:</b> ${opp.symbol}\n` +
        `• <b>Inversión:</b> $${spent.toFixed(2)} USDT\n` +
        `• <b>Precio de compra:</b> $${buyPrice.toFixed(4)}\n` +
        `• 🎯 <b>Orden LIMIT SELL en Binance:</b> $${targetPriceStr} (<b>+1.8% NETO</b>)\n\n` +
        motivo;

      console.log(alertMsg.replace(/<\/?b>/g, "").replace(/<\/?i>/g, ""));
      await this.notifier.send(alertMsg);

    } catch (e: any) {
      console.error("Error ejecutando compra:", e.message);
      await this.notifier.send(`⚠️ <b>Error ejecutando compra en ${opp.symbol}:</b> ${e.message}`);
    } finally {
      this.pendingOpp = null;
    }
  }

  private async handleTelegramCommand(cmd: string): Promise<string> {
    try {
      // 1. APROBACIÓN DE COMPRA (/comprar, /si, o /comprar_moneda)
      if (cmd.startsWith("/comprar") || cmd === "/si" || cmd === "si" || cmd === "comprar") {
        if (!this.pendingOpp) {
          return "⏳ <b>No hay ninguna oportunidad pendiente por confirmar en este momento.</b>\n\nEscribe /radar para escanear el mercado.";
        }
        clearTimeout(this.pendingOpp.timer);
        const opp = this.pendingOpp;
        this.pendingOpp = null;
        // Ejecutar de inmediato
        this.executeBuyAndLimitSell(opp, false);
        return `🚀 <b>¡Aprobado!</b> Ejecutando compra de $${opp.investAmount} USDT en ${opp.symbol} y fijando venta al +1.8%...`;
      }

      // 2. DESCARTAR COMPRA (/ignorar, /no)
      if (cmd === "/ignorar" || cmd === "ignorar" || cmd === "/no" || cmd === "no") {
        if (!this.pendingOpp) {
          return "No hay ninguna oportunidad pendiente para ignorar.";
        }
        clearTimeout(this.pendingOpp.timer);
        const sym = this.pendingOpp.symbol;
        this.pendingOpp = null;
        return `❌ <b>Oportunidad en ${sym} descartada.</b>\nTus USDT siguen intactos y el bot sigue vigilando el radar.`;
      }

      // 3. RADAR EN VIVO (Bajo Demanda sin textos fijos confusos)
      if (cmd === "/radar" || cmd === "radar") {
        const openOrders = await this.client.openOrders({ recvWindow: 60000 });
        const activeSymbols = new Set<string>(openOrders.data.filter((o: any) => o.side === "SELL").map((o: any) => o.symbol as string));

        let report = `📡 <b>RADAR DE MERCADO EN VIVO</b>\n\n`;
        for (const sym of WATCHLIST) {
          try {
            const [t24, k15] = await Promise.all([
              this.client.ticker24hr(sym),
              this.client.klines(sym, "15m", { limit: 25 })
            ]);
            const price = parseFloat(t24.data.lastPrice);
            const closes = k15.data.map((k: any) => parseFloat(k[4]));
            const rsi = this.calculateRSI(closes, 14);
            const tag = activeSymbols.has(sym) ? " 🛡️ (Posición activa)" : (rsi <= 35 ? " 🎯 (Suelo / Descuento)" : "");
            report += `• <b>${sym}:</b> $${price} | RSI: <b>${rsi.toFixed(1)}</b>${tag}\n`;
          } catch(e) {}
        }

        const acc = await this.client.account({ recvWindow: 60000 });
        const usdt = parseFloat(acc.data.balances.find((b: any) => b.asset === "USDT")?.free || "0");
        report += `\n💼 <b>USDT disponible para cazar:</b> $${usdt.toFixed(2)} USDT`;
        return report;
      }

      // 4. ESTADO DE ÓRDENES EN BINANCE
      if (cmd === "/estado" || cmd === "estado" || cmd === "/start") {
        const openOrders = await this.client.openOrders({ recvWindow: 60000 });
        const sellOrders = openOrders.data.filter((o: any) => o.side === "SELL");

        let txt = `📊 <b>ESTADO DE ÓRDENES EN BINANCE</b>\n\n`;
        if (sellOrders.length === 0) {
          txt += "• No tienes órdenes de venta abiertas actualmente.\n";
        } else {
          txt += `• 🎯 <b>Órdenes de Venta Blindadas (${sellOrders.length}):</b>\n`;
          for (let i = 0; i < sellOrders.length; i++) {
            const o = sellOrders[i];
            const target = parseFloat(o.price);
            let curPrice = 0;
            try {
              const t = await this.client.tickerPrice(o.symbol);
              curPrice = parseFloat(t.data.price);
            } catch(e) {}
            const faltaPct = curPrice > 0 ? (((target - curPrice) / curPrice) * 100) : 0;
            txt += `  ${i + 1}. <b>${o.symbol}</b> | Venta: $${target.toFixed(2)} | Actual: $${curPrice.toFixed(2)} (Falta +<b>${faltaPct.toFixed(2)}%</b>)\n`;
          }
        }

        const acc = await this.client.account({ recvWindow: 60000 });
        const usdt = parseFloat(acc.data.balances.find((b: any) => b.asset === "USDT")?.free || "0");
        txt += `\n• 💼 <b>USDT libre:</b> $${usdt.toFixed(2)} USDT\n`;
        txt += `• 🤖 <b>Modo:</b> ${this.paused ? "⏸️ PAUSADO" : "🟢 RADAR INTERACTIVO ACTIVO"}`;
        return txt;
      }

      if (cmd === "/balance" || cmd === "balance") {
        const acc = await this.client.account({ recvWindow: 60000 });
        const active = acc.data.balances.filter((b: any) => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0);
        let txt = `💼 <b>SALDOS EN BINANCE SPOT</b>\n\n`;
        active.forEach((b: any) => {
          txt += `• <b>${b.asset}:</b> Libre = ${parseFloat(b.free).toFixed(4)} | Bloqueado = ${parseFloat(b.locked).toFixed(4)}\n`;
        });
        return txt;
      }

      if (cmd === "/pausa" || cmd === "pausa") {
        this.paused = true;
        if (this.pendingOpp) {
          clearTimeout(this.pendingOpp.timer);
          this.pendingOpp = null;
        }
        return "⏸️ <b>SISTEMA PAUSADO</b>\nNo se buscarán compras ni se enviarán alertas. Tus ventas en Binance siguen 100% protegidas.";
      }

      if (cmd === "/reanudar" || cmd === "reanudar") {
        this.paused = false;
        return "▶️ <b>SISTEMA REANUDADO</b>\nEl radar vuelve a monitorear oportunidades de rebote.";
      }

      if (cmd === "/menu" || cmd === "menu" || cmd === "/help") {
        return `📱 <b>MENÚ INTERACTIVO CON APROBACIÓN HUMANA</b>\n\n` +
          `• /radar - Escanear mercado en vivo\n` +
          `• /estado - Órdenes activas y precios\n` +
          `• /balance - Saldos en Binance Spot\n` +
          `• /pausa - Pausar el bot\n` +
          `• /reanudar - Reanudar el bot\n\n` +
          `💡 <i>Cuando el radar detecte una oportunidad, te mandará la opción de /si o /no con 3 minutos de gracia antes de auto-ejecutar.</i>`;
      }

      return "Escribe /menu para ver la lista de comandos disponibles.";
    } catch(e: any) {
      return `⚠️ Error: ${e.message}`;
    }
  }

  async runCycle() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const openOrders = await this.client.openOrders({ recvWindow: 60000 });
      const sellOrders = openOrders.data.filter((o: any) => o.side === "SELL");
      const activeSymbols = new Set<string>(sellOrders.map((o: any) => o.symbol as string));

      const acc = await this.client.account({ recvWindow: 60000 });
      const usdt = parseFloat(acc.data.balances.find((b: any) => b.asset === "USDT")?.free || "0");
      const time = new Date().toLocaleTimeString();

      console.log(`[${time}] Monitoreando... USDT libre: $${usdt.toFixed(2)} | Órdenes activas: ${sellOrders.length} (${Array.from(activeSymbols).join(", ") || "Ninguna"})`);

      // Solo busca oportunidades si tenemos al menos 10 USDT disponibles, no está pausado y no hay una ya pendiente
      if (usdt >= 10 && !this.paused && !this.pendingOpp) {
        console.log(`🔍 Escaneando radar buscando oportunidad de rebote (+1.8%) con diversificación...`);
        const opp = await this.scanOpportunities(activeSymbols);

        if (opp) {
          const investAmount = (usdt - 0.15).toFixed(2);
          const assetName = opp.symbol.toLowerCase().replace("usdt", "");
          const cleanTarget = (opp.curPrice * 1.018).toFixed(4);

          console.log(`🎯 ¡OPORTUNIDAD ENCONTRADA EN ${opp.symbol}! Notificando a Telegram para aprobación humana...`);

          const alertMsg = `🎯 <b>¡OPORTUNIDAD DE REBOTE CONFIRMADA!</b>\n\n` +
            `• <b>Moneda:</b> <b>${opp.symbol}</b>\n` +
            `• <b>Precio actual:</b> $${opp.curPrice}\n` +
            `• <b>RSI (15m):</b> ${opp.rsi.toFixed(1)} (Suelo técnico)\n` +
            `• <b>Caída previa:</b> -${opp.dropPct.toFixed(2)}%\n` +
            `• <b>Capital disponible:</b> $${investAmount} USDT\n\n` +
            `📈 <b>Plan de Trading (+1.8% Neto):</b>\n` +
            `• Venta LIMIT programada: $${cleanTarget}\n\n` +
            `<b>¿Deseas entrar en esta oportunidad?</b>\n` +
            `👉 /comprar_${assetName}  (o responde /si)\n` +
            `👉 /ignorar  (o responde /no)\n\n` +
            `⏱️ <i>Tienes 3 minutos para responder. Si no respondes, el bot comprará automáticamente para no perder el rebote.</i>`;

          await this.notifier.send(alertMsg);

          // Configurar temporizador de 3 minutos
          const timer = setTimeout(() => {
            if (this.pendingOpp && this.pendingOpp.symbol === opp.symbol) {
              console.log(`⏰ Tiempo de espera agotado para ${opp.symbol}. Ejecutando automáticamente...`);
              this.executeBuyAndLimitSell(this.pendingOpp, true);
            }
          }, TIMEOUT_SECONDS * 1000);

          this.pendingOpp = {
            symbol: opp.symbol,
            rsi: opp.rsi,
            dropPct: opp.dropPct,
            curPrice: opp.curPrice,
            targetPriceStr: cleanTarget,
            investAmount,
            timer,
            expiresAt: Date.now() + (TIMEOUT_SECONDS * 1000)
          };
        }
      }

    } catch (e: any) {
      console.error("Error en runCycle:", e.message);
    } finally {
      this.isProcessing = false;
    }
  }

  async start() {
    console.log(`\n======================================================`);
    console.log(`🏛️ BOT INTERACTIVO CON APROBACIÓN HUMANA + AUTO-TIMEOUT`);
    console.log(`🎯 Meta: +1.8% | Diversificación Activa | Espera de 3 min`);
    console.log(`======================================================\n`);

    await this.telegramCommands.start();
    console.log(`📱 Telegram listo: /menu, /radar, /estado, /balance`);

    await this.runCycle();
    setInterval(() => this.runCycle(), 10000);
  }
}

const bot = new InteractiveBot();
bot.start();
