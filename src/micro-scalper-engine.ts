import { Spot } from "@binance/connector";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { TelegramNotifier } from "./notifier.js";

dotenv.config();

export interface MicroScalpTrade {
  id: string;
  symbol: string;
  side: "BUY";
  entryPrice: number;
  exitPrice: number;
  qty: number;
  investedUsdt: number;
  proceedsUsdt: number;
  feesUsdt: number;
  netPnlUsdt: number;
  netPnlPct: number;
  entryTime: number;
  exitTime: number;
  durationSec: number;
  entryReason: string;
  exitReason: string;
}

export interface MicroScalpPosition {
  id: string;
  symbol: string;
  entryPrice: number;
  highestPrice: number;
  qty: number;
  investedUsdt: number;
  entryTime: number;
  entryReason: string;
  breakEvenLocked: boolean;
}

export interface MicroScalperState {
  enabled: boolean;
  initialBalance: number;
  balanceUsdt: number;
  inTradeUsdt: number;
  totalNetPnlUsdt: number;
  totalTrades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  positions: MicroScalpPosition[];
  history: MicroScalpTrade[];
  lastUpdate: number;
}

export class MicroScalperEngine {
  private client: any;
  private notifier: TelegramNotifier;
  private stateFile: string;
  private state: MicroScalperState;
  private isRunning: boolean = false;
  private timer: NodeJS.Timeout | null = null;

  // Parámetros de Microscalping Relámpago Ultrarrápido (Velas de 1 Minuto)
  private readonly watchlist: string[] = ["SOLUSDT", "NEARUSDT", "SUIUSDT", "BTCUSDT", "ETHUSDT", "PEPEUSDT"];
  private readonly tradeAllocationUsdt: number = 33.33; // 3 balas de ~$33 para un balance de $100 USDT
  private readonly maxPositions: number = 3;
  private readonly feeRate: number = 0.00075; // 0.075% comisión Binance con BNB
  private readonly activationGainPct: number = 0.22; // Cosecha rápida: activa trailing al +0.22%
  private readonly breakEvenGainPct: number = 0.18;  // Candado de Cero Pérdidas al +0.18%
  private readonly trailingCallbackPct: number = 0.07; // Vende si retrocede 0.07% desde el pico
  private readonly hardTakeProfitPct: number = 0.65; // Salida instantánea ante impulso de +0.65%
  private readonly maxHoldTimeMinutes: number = 10;  // Vencimiento rápido: 10 minutos máximo en scalping
  private readonly stopLossPct: number = 0.60;       // Stop loss scalper ceñido (-0.60%)

  constructor() {
    this.client = new Spot();
    this.notifier = new TelegramNotifier();
    this.stateFile = path.resolve(process.cwd(), ".micro-scalper-sim.json");
    this.state = this.loadState();
    this.saveState();
  }

  private loadState(): MicroScalperState {
    try {
      if (fs.existsSync(this.stateFile)) {
        const raw = fs.readFileSync(this.stateFile, "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.balanceUsdt === "number") {
          return {
            enabled: parsed.enabled ?? false,
            ...parsed
          };
        }
      }
    } catch {}

    return {
      enabled: false,
      initialBalance: 100.0,
      balanceUsdt: 100.0,
      inTradeUsdt: 0.0,
      totalNetPnlUsdt: 0.0,
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winRatePct: 0.0,
      positions: [],
      history: [],
      lastUpdate: Date.now()
    };
  }

  private saveState() {
    try {
      this.state.lastUpdate = Date.now();
      fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2), "utf-8");
    } catch (e: any) {
      console.error("Error guardando estado de MicroScalper:", e.message);
    }
  }

  public getState(): MicroScalperState {
    return this.state;
  }

  public setEnabled(val: boolean) {
    this.state.enabled = val;
    this.saveState();
    console.log(`🔌 [MICROSCALPER SIMULADOR] Estado cambiado a: ${val ? "ENCENDIDO" : "APAGADO"}`);
  }

  public isEnabled(): boolean {
    return this.state.enabled === true;
  }

  public resetBalance(amount = 100.0) {
    this.state = {
      enabled: this.state.enabled,
      initialBalance: amount,
      balanceUsdt: amount,
      inTradeUsdt: 0.0,
      totalNetPnlUsdt: 0.0,
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winRatePct: 0.0,
      positions: [],
      history: [],
      lastUpdate: Date.now()
    };
    this.saveState();
    console.log(`🔄 [MICROSCALPER SIMULADOR] Balance reseteado a $${amount.toFixed(2)} USDT.`);
  }

  // Indicadores técnicos rápidos en 1m
  private calculateRsi(closes: number[], period = 14): number {
    if (closes.length <= period) return 50;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) gains += diff; else losses -= diff;
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
        avgLoss = (avgLoss * (period - 1) - diff) / period;
      }
    }
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  private calculateStochRsi(closes: number[], rsiPeriod = 14, stochPeriod = 14): { k: number } {
    if (closes.length < rsiPeriod + stochPeriod) return { k: 50 };
    const rsiValues: number[] = [];
    for (let i = closes.length - stochPeriod; i <= closes.length; i++) {
      rsiValues.push(this.calculateRsi(closes.slice(0, i), rsiPeriod));
    }
    const minRsi = Math.min(...rsiValues);
    const maxRsi = Math.max(...rsiValues);
    if (maxRsi === minRsi) return { k: 50 };
    const lastRsi = rsiValues[rsiValues.length - 1];
    return { k: ((lastRsi - minRsi) / (maxRsi - minRsi)) * 100 };
  }

  // 1. Escáner de Oportunidades en 1m
  private async scanForOpportunities(): Promise<void> {
    if (this.state.positions.length >= this.maxPositions) return;
    if (this.state.balanceUsdt < 20.0) return;

    for (const sym of this.watchlist) {
      if (this.state.positions.some(p => p.symbol === sym)) continue;
      if (this.state.positions.length >= this.maxPositions) break;

      try {
        const klines = await this.client.klines(sym, "1m", { limit: 50 });
        if (!klines?.data || klines.data.length < 35) continue;

        const data = klines.data;
        const opens = data.map((k: any) => parseFloat(k[1]));
        const highs = data.map((k: any) => parseFloat(k[2]));
        const lows = data.map((k: any) => parseFloat(k[3]));
        const closes = data.map((k: any) => parseFloat(k[4]));

        const curPrice = closes[closes.length - 1];
        const lastIdx = closes.length - 1;
        const candleRange = highs[lastIdx] - lows[lastIdx];
        const lowerWick = Math.min(opens[lastIdx], closes[lastIdx]) - lows[lastIdx];
        const lowerWickRatio = candleRange > 0 ? lowerWick / candleRange : 0;

        // Order flow (CVD Taker Buy en la vela actual)
        const totalVol = parseFloat(data[lastIdx][7] || "0");
        const takerBuyVol = parseFloat(data[lastIdx][10] || "0");
        const cvdRatio = totalVol > 0 ? (takerBuyVol / totalVol) * 100 : 50;

        const rsi1m = this.calculateRsi(closes, 14);
        const stoch1m = this.calculateStochRsi(closes, 14, 14);

        // Retroceso desde el máximo reciente de 10 velas (10 minutos)
        const maxHigh10 = Math.max(...highs.slice(-10));
        const drop10mPct = maxHigh10 > 0 ? ((maxHigh10 - curPrice) / maxHigh10) * 100 : 0;

        // Condiciones de Microscalping Institucional en 1 minuto:
        // 1. Mecha de absorción en suelo (>= 35%) O StochRSI en sobreventa (k <= 22)
        // 2. Caída mínima de 0.35% a 0.60% en 10 minutos (no comprar techos)
        // 3. CVD comprador en vela activa (>= 51.5% absorbiendo)
        // 4. RSI 1m <= 42 y StochRSI <= 30 (nunca comprar con RSI caliente o neutral alto)
        const hasAbsorptionWick = lowerWickRatio >= 0.35;
        const isOversold = stoch1m.k <= 22 && rsi1m <= 38;
        const hasOrderFlowSupport = cvdRatio >= 51.5;
        const isRsiHealthyForScalp = rsi1m <= 42 && stoch1m.k <= 30;

        if ((hasAbsorptionWick || isOversold) && isRsiHealthyForScalp && drop10mPct >= 0.40 && hasOrderFlowSupport) {
          const reason = `Mecha 1m ${(lowerWickRatio * 100).toFixed(0)}% | Stoch ${stoch1m.k.toFixed(0)} | RSI ${rsi1m.toFixed(1)} | CVD ${cvdRatio.toFixed(0)}% | Caída -${drop10mPct.toFixed(2)}%`;
          this.openSimPosition(sym, curPrice, reason);
        }
      } catch {}
    }
  }

  // 2. Apertura de Posición Simulada
  private openSimPosition(symbol: string, price: number, reason: string) {
    const investAmount = Math.min(this.state.balanceUsdt, this.tradeAllocationUsdt);
    if (investAmount < 15.0) return;

    const qty = investAmount / price;
    const entryFee = investAmount * this.feeRate;
    this.state.balanceUsdt -= investAmount;
    this.state.inTradeUsdt += investAmount;

    const pos: MicroScalpPosition = {
      id: `${symbol}_${Date.now()}`,
      symbol,
      entryPrice: price,
      highestPrice: price,
      qty,
      investedUsdt: investAmount,
      entryTime: Date.now(),
      entryReason: reason,
      breakEvenLocked: false
    };

    this.state.positions.push(pos);
    this.saveState();

    console.log(`\n⚡ [MICROSCALP DISPARO] COMPRA ${symbol} a $${price} ($${investAmount.toFixed(2)} USDT)`);
    console.log(`   Razón: ${reason}`);
    console.log(`   Saldo Libre: $${this.state.balanceUsdt.toFixed(2)} | Invertido: $${this.state.inTradeUsdt.toFixed(2)} USDT`);

    if (process.env.MICRO_SCALPER_TELEGRAM === "true") {
      try {
        this.notifier.send(
          `⚡ <b>[MICROSCALPING SIMULADO: ENTRADA]</b>\n\n` +
          `• <b>Moneda:</b> <code>${symbol}</code>\n` +
          `• <b>Precio Entrada:</b> $${price}\n` +
          `• <b>Monto Simulador:</b> $${investAmount.toFixed(2)} USDT\n` +
          `• 🎯 <b>Gatillo:</b> ${reason}\n` +
          `• 💼 <b>Balance Virtual:</b> $${(this.state.balanceUsdt + this.state.inTradeUsdt).toFixed(2)} USDT`
        );
      } catch {}
    }
  }

  // 3. Gestión y Cosecha Trailing de Posiciones Activas
  private async manageActivePositions(): Promise<void> {
    if (this.state.positions.length === 0) return;

    for (let i = this.state.positions.length - 1; i >= 0; i--) {
      const pos = this.state.positions[i];
      try {
        const ticker = await this.client.tickerPrice(pos.symbol);
        const curPrice = parseFloat(ticker.data.price);

        if (curPrice > pos.highestPrice) {
          pos.highestPrice = curPrice;
        }

        const grossGainPct = ((curPrice - pos.entryPrice) / pos.entryPrice) * 100;
        const maxGainPct = ((pos.highestPrice - pos.entryPrice) / pos.entryPrice) * 100;
        const dropFromPeak = ((pos.highestPrice - curPrice) / pos.highestPrice) * 100;
        const holdMinutes = (Date.now() - pos.entryTime) / 60000;

        // Candado Break-Even: Si tocó +0.32%, asegura que no pueda haber pérdidas
        if (maxGainPct >= this.breakEvenGainPct && !pos.breakEvenLocked) {
          pos.breakEvenLocked = true;
          console.log(`🔒 [MICROSCALP CANDADO] ${pos.symbol} aseguró precio de entrada (+${maxGainPct.toFixed(2)}% de pico).`);
        }

        let shouldExit = false;
        let exitReason = "";

        // Regla A: Salida Explosiva Inmediata (Hard Take Profit al +1.35%)
        if (grossGainPct >= this.hardTakeProfitPct) {
          shouldExit = true;
          exitReason = `🚀 DISPARO EXPLOSIVO (+${grossGainPct.toFixed(2)}%)`;
        }
        // Regla B: Trailing Take Profit Scalper (+0.40% activación + 0.12% callback)
        else if (maxGainPct >= this.activationGainPct && dropFromPeak >= this.trailingCallbackPct) {
          shouldExit = true;
          exitReason = `🎯 TRAILING COSECHA (+${grossGainPct.toFixed(2)}% | Pico +${maxGainPct.toFixed(2)}%)`;
        }
        // Regla C: Ejecución de Candado Break-Even (se devuelve a costo tras haber subido)
        else if (pos.breakEvenLocked && grossGainPct <= 0.05) {
          shouldExit = true;
          exitReason = `🔒 SALIDA PROTEGIDA BREAK-EVEN (+${grossGainPct.toFixed(2)}%)`;
        }
        // Regla D: Stop Loss Rápido Scalper (-0.60%)
        else if (grossGainPct <= -this.stopLossPct) {
          shouldExit = true;
          exitReason = `🛑 STOP LOSS RÁPIDO (${grossGainPct.toFixed(2)}%)`;
        }
        // Regla E: Time-Stop por falta de impulso (más de 10 minutos sin movimiento)
        else if (holdMinutes >= this.maxHoldTimeMinutes) {
          shouldExit = true;
          exitReason = `⏱️ TIME-STOP (Sin impulso tras ${holdMinutes.toFixed(0)}m: ${grossGainPct.toFixed(2)}%)`;
        }

        if (shouldExit) {
          this.closeSimPosition(i, curPrice, exitReason);
        }
      } catch {}
    }
  }

  // 4. Cierre y Liquidación de Ganancias con Comisiones de Binance
  private closeSimPosition(index: number, exitPrice: number, exitReason: string) {
    const pos = this.state.positions[index];
    const proceeds = pos.qty * exitPrice;
    const totalFees = (pos.investedUsdt + proceeds) * this.feeRate;
    const netPnlUsdt = proceeds - pos.investedUsdt - totalFees;
    const netPnlPct = (netPnlUsdt / pos.investedUsdt) * 100;
    const durationSec = Math.round((Date.now() - pos.entryTime) / 1000);

    this.state.balanceUsdt += (proceeds - totalFees);
    this.state.inTradeUsdt -= pos.investedUsdt;
    this.state.totalNetPnlUsdt += netPnlUsdt;
    this.state.totalTrades++;

    if (netPnlUsdt > 0) this.state.wins++; else this.state.losses++;
    this.state.winRatePct = (this.state.wins / this.state.totalTrades) * 100;

    const tradeRecord: MicroScalpTrade = {
      id: pos.id,
      symbol: pos.symbol,
      side: "BUY",
      entryPrice: pos.entryPrice,
      exitPrice,
      qty: pos.qty,
      investedUsdt: pos.investedUsdt,
      proceedsUsdt: proceeds,
      feesUsdt: totalFees,
      netPnlUsdt,
      netPnlPct,
      entryTime: pos.entryTime,
      exitTime: Date.now(),
      durationSec,
      entryReason: pos.entryReason,
      exitReason
    };

    this.state.history.unshift(tradeRecord);
    if (this.state.history.length > 50) this.state.history.pop();
    this.state.positions.splice(index, 1);
    this.saveState();

    const isWin = netPnlUsdt >= 0;
    console.log(`\n======================================================`);
    console.log(`${isWin ? "🎉" : "⚠️"} [MICROSCALP CIERRE] ${pos.symbol}: ${exitReason}`);
    console.log(`   Entrada: $${pos.entryPrice} -> Salida: $${exitPrice}`);
    console.log(`   PnL Neto: ${isWin ? "+" : ""}$${netPnlUsdt.toFixed(4)} USDT (${isWin ? "+" : ""}${netPnlPct.toFixed(2)}%) tras comisiones`);
    console.log(`   Duración: ${Math.floor(durationSec / 60)}m ${durationSec % 60}s | Balance Actual: $${this.state.balanceUsdt.toFixed(2)} USDT`);
    console.log(`   Estadísticas: ${this.state.wins}W / ${this.state.losses}L (${this.state.winRatePct.toFixed(1)}% Acierto) | PnL Acum: ${this.state.totalNetPnlUsdt >= 0 ? "+" : ""}$${this.state.totalNetPnlUsdt.toFixed(2)} USDT`);
    console.log(`======================================================\n`);

    if (process.env.MICRO_SCALPER_TELEGRAM === "true") {
      try {
        this.notifier.send(
          `${isWin ? "🎉" : "⚠️"} <b>[MICROSCALPING SIMULADO: CIERRE]</b>\n\n` +
          `• <b>Moneda:</b> <code>${pos.symbol}</code>\n` +
          `• <b>Entrada:</b> $${pos.entryPrice} ➡️ <b>Salida:</b> $${exitPrice}\n` +
          `• 💰 <b>PnL Neto:</b> ${isWin ? "+" : ""}$${netPnlUsdt.toFixed(4)} USDT (<b>${isWin ? "+" : ""}${netPnlPct.toFixed(2)}%</b>)\n` +
          `• ⏱️ <b>Duración:</b> ${Math.floor(durationSec / 60)}m ${durationSec % 60}s\n` +
          `• 🎯 <b>Razón:</b> ${exitReason}\n` +
          `• 📊 <b>Balance Total:</b> $${(this.state.balanceUsdt + this.state.inTradeUsdt).toFixed(2)} USDT (${this.state.winRatePct.toFixed(0)}% Acierto en ${this.state.totalTrades} trades)`
        );
      } catch {}
    }
  }

  // 5. Bucle Principal de Ejecución
  public async tick(): Promise<void> {
    try {
      if (!this.state.enabled) return; // Si está apagado, no opera
      await this.manageActivePositions();
      await this.scanForOpportunities();
    } catch (e: any) {
      console.error("Error en ciclo MicroScalper:", e.message);
    }
  }

  public start(intervalMs = 4500) {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log(`\n🚀 [MICROSCALPER 1M EN VIVO ACTIVADO]`);
    console.log(`• Balance Virtual Inicial: $${this.state.initialBalance.toFixed(2)} USDT (Actual: $${this.state.balanceUsdt.toFixed(2)} USDT)`);
    console.log(`• Monedas Monitoreadas: ${this.watchlist.join(", ")}`);
    console.log(`• Frecuencia de escáner: cada ${intervalMs / 1000}s`);
    console.log(`• Salida: Trailing +${this.activationGainPct}% (callback ${this.trailingCallbackPct}%) + Candado Break-Even`);
    console.log(`• Guardado en: .micro-scalper-sim.json\n`);

    this.tick();
    this.timer = setInterval(() => this.tick(), intervalMs);
  }

  public stop() {
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log(`🛑 [MICROSCALPER SIMULADOR DETENIDO]`);
  }
}

// Ejecución directa si se corre desde CLI (npm run microscalp)
if (process.argv[1]?.includes("micro-scalper-engine")) {
  const engine = new MicroScalperEngine();
  if (process.argv.includes("--reset")) {
    engine.resetBalance(100.0);
  }
  engine.start(5000);
}
