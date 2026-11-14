import { supabaseDb } from "./supabase-db.js";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { TelegramNotifier } from "./notifier.js";

// Símbolos de alta liquidez seleccionados para Futuros
export const FUTURES_WATCHLIST = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "BNBUSDT",
  "AVAXUSDT",
  "XRPUSDT",
  "DOGEUSDT"
];


export interface MarketViabilityReport {
  isViable: boolean;
  score: number;
  btcStatus: string;
  fundingStatus: string;
  volatilityStatus: string;
  opportunitiesFound: number;
  favorableSymbols: string[];
  rationale: string;
  recommendedAction: string;
}

export interface FuturesPosition {
  id: string;
  symbol: string;
  side: "LONG" | "SHORT";
  entryPrice: number;
  marginUsdt: number;
  leverage: number;
  notionalUsdt: number;
  contracts: number;
  stopLossPrice: number;
  stopLossPct: number;
  trailingTriggerPrice: number;
  trailingTriggerPct: number;
  trailingCallbackPct: number;
  trailingActive: boolean;
  peakPrice: number;
  trailingStopPrice: number | null;
  openTime: number;
  status: "OPEN" | "CLOSED";
  rationale: string;
}

export interface FuturesClosedTrade {
  id: string;
  symbol: string;
  side: "LONG" | "SHORT";
  entryPrice: number;
  exitPrice: number;
  marginUsdt: number;
  leverage: number;
  notionalUsdt: number;
  openTime: number;
  closeTime: number;
  durationMin: number;
  exitReason: "TRAILING_TP" | "STOP_LOSS";
  grossPnlUsdt: number;
  feesUsdt: number;
  netPnlUsdt: number;
  roePct: number;
}

export interface FuturesState {
  isSimulated: boolean;
  enabled: boolean;
  virtualBalanceUsdt: number;
  startingBalanceUsdt: number;
  maxActivePositions: number;
  defaultMarginPerTrade: number;
  defaultLeverage: number;
  leverageMode?: string;
  stopLossPct: number;
  trailingTriggerPct: number;
  trailingCallbackPct: number;
  lastScanTime: number;
}

export class FuturesEngine {
  private notifier: TelegramNotifier;
  private stateFile: string;
  private positionsFile: string;
  private tradesFile: string;
  private state: FuturesState;
  private positions: FuturesPosition[] = [];
  private trades: FuturesClosedTrade[] = [];
  private symbolCooldowns: Map<string, number> = new Map();
  private isScanning = false;
  private intervalHandle: NodeJS.Timeout | null = null;

  constructor() {
    this.notifier = new TelegramNotifier();
    const basePath = process.cwd();
    this.stateFile = path.resolve(basePath, ".futures-sim-state.json");
    this.positionsFile = path.resolve(basePath, ".futures-sim-positions.json");
    this.tradesFile = path.resolve(basePath, ".futures-sim-trades.json");

    this.state = this.loadState();
    this.positions = this.loadPositions();
    this.trades = this.loadTrades();
  }

  private loadState(): FuturesState {
    const defaults: FuturesState = {
      isSimulated: true,
      enabled: false,
      virtualBalanceUsdt: 100.0,
      startingBalanceUsdt: 100.0,
      maxActivePositions: 3,
      defaultMarginPerTrade: 30.0,
      defaultLeverage: 7,
      leverageMode: "dynamic",
      stopLossPct: 1.5,
      trailingTriggerPct: 1.5,
      trailingCallbackPct: 0.35,
      lastScanTime: 0
    };

    let loaded = { ...defaults };
    try {
      if (fs.existsSync(this.stateFile)) {
        loaded = { ...defaults, ...JSON.parse(fs.readFileSync(this.stateFile, "utf-8")) };
      }
    } catch {}

    // Sincronizar con .strategy-controls.json: si es simulación y stateFile tiene enabled: true, respetarlo
    try {
      const ctrlFile = path.resolve(process.cwd(), ".strategy-controls.json");
      if (fs.existsSync(ctrlFile)) {
        const ctrl = JSON.parse(fs.readFileSync(ctrlFile, "utf-8"));
        const stratFutures = ctrl?.strategies?.futures;
        if (stratFutures === true) {
          loaded.enabled = true;
        } else if (stratFutures === false && !loaded.isSimulated) {
          loaded.enabled = false;
        }
      }
    } catch {}

    return loaded;
  }

  public isEnabled(): boolean {
    this.state = this.loadState();
    return !!this.state.enabled;
  }

  private saveState(st?: FuturesState): void {
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify(st || this.state, null, 2), "utf-8");
    } catch (e: any) {
      console.error("Error guardando .futures-sim-state.json:", e.message);
    }
  }

  private loadPositions(): FuturesPosition[] {
    try {
      if (fs.existsSync(this.positionsFile)) {
        return JSON.parse(fs.readFileSync(this.positionsFile, "utf-8"));
      }
    } catch {}
    return [];
  }

  private savePositions(): void {
    try {
      fs.writeFileSync(this.positionsFile, JSON.stringify(this.positions, null, 2), "utf-8");
    } catch (e: any) {
      console.error("Error guardando .futures-sim-positions.json:", e.message);
    }
  }

  private loadTrades(): FuturesClosedTrade[] {
    try {
      if (fs.existsSync(this.tradesFile)) {
        return JSON.parse(fs.readFileSync(this.tradesFile, "utf-8"));
      }
    } catch {}
    return [];
  }

  private saveTrades(): void {
    try {
      // Registrar en Supabase Cloud DB
      if (this.trades.length > 0) {
        const lastT = this.trades[this.trades.length - 1];
        supabaseDb.recordFuturesTrade(lastT).catch(() => {});
      }
      fs.writeFileSync(this.tradesFile, JSON.stringify(this.trades, null, 2), "utf-8");
    } catch (e: any) {
      console.error("Error guardando .futures-sim-trades.json:", e.message);
    }
  }

  
  public setConfig(cfg: { isSimulated?: boolean; marginPerTrade?: number }): FuturesState {
    if (cfg.isSimulated !== undefined) this.state.isSimulated = !!cfg.isSimulated;
    if (cfg.marginPerTrade !== undefined && cfg.marginPerTrade >= 5) {
      this.state.defaultMarginPerTrade = parseFloat(String(cfg.marginPerTrade));
    }
    if ((cfg as any).startingBalance !== undefined && (cfg as any).startingBalance > 0) {
      this.state.startingBalanceUsdt = parseFloat(String((cfg as any).startingBalance));
      this.state.virtualBalanceUsdt = parseFloat(String((cfg as any).startingBalance));
    }
    if ((cfg as any).leverageMode !== undefined) {
      (this.state as any).leverageMode = (cfg as any).leverageMode;
    }
    this.saveState();
    return this.state;
  }

  // --- EJECUCIÓN PRIVADA BINANCE FUTURES (MODO REAL) ---
  private signQuery(params: Record<string, any>, secret: string): string {
    const query = Object.entries(params)
      .filter(([_, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("&");
    const signature = crypto.createHmac("sha256", secret).update(query).digest("hex");
    return `${query}&signature=${signature}`;
  }

  public async privateFuturesRequest(endpoint: string, method = "GET", params: Record<string, any> = {}): Promise<any> {
    const apiKey = process.env.BINANCE_API_KEY || "";
    const secret = process.env.BINANCE_API_SECRET || "";
    if (!apiKey || !secret) throw new Error("API Key o Secret no configurados en .env");

    const timestamp = Date.now();
    const fullParams = { ...params, timestamp, recvWindow: 60000 };
    const querySigned = this.signQuery(fullParams, secret);

    let url = `https://fapi.binance.com${endpoint}`;
    let options: RequestInit = {
      method,
      headers: {
        "X-MBX-APIKEY": apiKey,
        "Content-Type": "application/x-www-form-urlencoded"
      }
    };

    if (method === "GET") {
      url += `?${querySigned}`;
    } else {
      options.body = querySigned;
    }

    const res = await fetch(url, options);
    return res.json();
  }

  // Precisión y límites oficiales de Binance Futures por símbolo
  private getSymbolLotSpec(symbol: string): { precision: number; minQty: number; minNotional: number } {
    const specs: Record<string, { precision: number; minQty: number; minNotional: number }> = {
      BTCUSDT: { precision: 3, minQty: 0.001, minNotional: 50 },
      ETHUSDT: { precision: 3, minQty: 0.001, minNotional: 20 },
      SOLUSDT: { precision: 2, minQty: 0.01, minNotional: 5 },
      BNBUSDT: { precision: 2, minQty: 0.01, minNotional: 5 },
      AVAXUSDT: { precision: 0, minQty: 1, minNotional: 5 },
      XRPUSDT: { precision: 1, minQty: 0.1, minNotional: 5 },
      DOGEUSDT: { precision: 0, minQty: 1, minNotional: 5 }
    };
    return specs[symbol] || { precision: 0, minQty: 1, minNotional: 5 };
  }

  // Precisión de decimales de cantidad por símbolo en Binance Futures
  private roundLotSize(symbol: string, qty: number): string {
    const spec = this.getSymbolLotSpec(symbol);
    const factor = Math.pow(10, spec.precision);
    let val = Math.floor(qty * factor) / factor;
    if (val < spec.minQty) {
      val = spec.minQty;
    }
    return val.toFixed(spec.precision);
  }

  
  // Apalancamiento Dinámico Cuantitativo según Volatilidad Institucional
  public getDynamicLeverage(symbol: string): number {
    if (this.state.leverageMode && this.state.leverageMode.startsWith("fixed_")) {
      const fixed = parseInt(this.state.leverageMode.replace("fixed_", ""), 10);
      if (!isNaN(fixed) && fixed >= 1) return fixed;
    }
    if (this.state.leverageMode !== "dynamic") return this.state.defaultLeverage || 5;
    const levMap: Record<string, number> = {
      BTCUSDT: 5,  // Seguro para cuentas pequeñas
      ETHUSDT: 5,
      SOLUSDT: 5,
      BNBUSDT: 4,
      XRPUSDT: 4,
      AVAXUSDT: 3,
      DOGEUSDT: 3
    };
    return levMap[symbol] !== undefined ? levMap[symbol] : (this.state.defaultLeverage || 5);
  }

  public getState(): FuturesState {
    return this.state;
  }

  public getPositions(): FuturesPosition[] {
    return this.positions;
  }

  public getTrades(): FuturesClosedTrade[] {
    return this.trades;
  }

  public toggle(): boolean {
    this.state.enabled = !this.state.enabled;
    this.saveState();
    return this.state.enabled;
  }

  // --- API BINANCE FUTURES (PUBLIC ENDPOINTS) ---

  private async fetchFuturesTicker(symbol: string): Promise<number | null> {
    try {
      const res = await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`);
      if (!res.ok) return null;
      const data = await res.json();
      return parseFloat(data.price);
    } catch {
      return null;
    }
  }

  private async fetchFundingRate(symbol: string): Promise<number> {
    try {
      const res = await fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`);
      if (!res.ok) return 0;
      const data = await res.json();
      return parseFloat(data.lastFundingRate || "0");
    } catch {
      return 0;
    }
  }

  private async fetchKlines(symbol: string, interval: "15m" | "1h", limit = 100): Promise<any[]> {
    try {
      const res = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
      if (!res.ok) return [];
      const raw = await res.json();
      return raw.map((k: any) => ({
        openTime: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
        closeTime: k[6]
      }));
    } catch {
      return [];
    }
  }

  // --- INDICADORES MATEMÁTICOS ---

  private calculateRSI(closes: number[], period = 14): number {
    if (closes.length < period + 1) return 50;
    let gains = 0;
    let losses = 0;

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

  private calculateEMA(closes: number[], period: number): number {
    if (closes.length < period) return closes[closes.length - 1] || 0;
    const k = 2 / (period + 1);
    let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < closes.length; i++) {
      ema = closes[i] * k + ema * (1 - k);
    }
    return ema;
  }

  // --- MOTOR DE MONITOREO DE POSICIONES ABIERTAS ---
  private lastBinanceSync = 0;

  public async syncRealPositionsFromBinance(): Promise<void> {
    if (this.state.isSimulated) return;
    // Evitar sobrecargar la API: sincronizar como máximo cada 4 segundos
    if (Date.now() - this.lastBinanceSync < 4000) return;
    this.lastBinanceSync = Date.now();

    try {
      const livePositionsRaw = await this.privateFuturesRequest("/fapi/v2/positionRisk", "GET");
      if (!Array.isArray(livePositionsRaw)) return;

      const activeOnBinance = livePositionsRaw.filter((p: any) => Math.abs(parseFloat(p.positionAmt || "0")) > 0);
      const activeSymbols = new Set(activeOnBinance.map((p: any) => p.symbol));

      let changed = false;
      this.positions = this.loadPositions();

      // 1. Si alguna posición local ya no existe en Binance, removerla de activas
      // 1. Si alguna posición local ya no existe en Binance, removerla de activas (con 60s de gracia para propagación de nuevas órdenes)
      const initialLen = this.positions.length;
      this.positions = this.positions.filter(p => activeSymbols.has(p.symbol));
      this.positions = this.positions.filter(p => activeSymbols.has(p.symbol) || (Date.now() - (p.openTime || 0) < 60000));
      if (this.positions.length !== initialLen) changed = true;

      // 2. Agregar o actualizar cada posición activa de Binance
      for (const p of activeOnBinance) {
        const symbol = p.symbol;
        const amt = parseFloat(p.positionAmt);
        const side: "LONG" | "SHORT" = amt > 0 ? "LONG" : "SHORT";
        const contracts = Math.abs(amt);
        const entryPrice = parseFloat(p.entryPrice);
        const leverage = parseInt(p.leverage, 10) || 3;
        const marginUsdt = parseFloat(p.isolatedMargin || "0") || parseFloat(p.isolatedWallet || "0") || ((contracts * entryPrice) / leverage);
        const notionalUsdt = contracts * entryPrice;

        let existing = this.positions.find(pos => pos.symbol === symbol);
        if (existing) {
          if (existing.contracts !== contracts || Math.abs(existing.entryPrice - entryPrice) > 0.0001) {
            existing.contracts = contracts;
            existing.entryPrice = entryPrice;
            existing.marginUsdt = marginUsdt;
            existing.notionalUsdt = notionalUsdt;
            existing.leverage = leverage;
            existing.side = side;
            changed = true;
          }
        } else {
          const stopLossPct = this.state.stopLossPct || 1.5;
          const trailingTriggerPct = this.state.trailingTriggerPct || 1.8;
          const stopLossPrice = side === "LONG"
            ? entryPrice * (1 - stopLossPct / 100)
            : entryPrice * (1 + stopLossPct / 100);
          const trailingTriggerPrice = side === "LONG"
            ? entryPrice * (1 + trailingTriggerPct / 100)
            : entryPrice * (1 - trailingTriggerPct / 100);

          this.positions.push({
            id: `fut_real_${symbol}_${p.updateTime || Date.now()}`,
            symbol,
            side,
            entryPrice,
            marginUsdt,
            leverage,
            notionalUsdt,
            contracts,
            stopLossPrice,
            stopLossPct,
            trailingTriggerPrice,
            trailingTriggerPct,
            trailingCallbackPct: this.state.trailingCallbackPct || 0.35,
            trailingActive: false,
            peakPrice: entryPrice,
            trailingStopPrice: null,
            openTime: parseInt(p.updateTime, 10) || Date.now(),
            status: "OPEN",
            rationale: `⚡ Posición real ejecutada en Binance (${side} ${leverage}x Isolated)`
          });
          changed = true;
        }
      }

      if (changed) {
        this.savePositions();
      }
    } catch (e: any) {
      console.error("Error sincronizando posiciones reales de Binance Futures:", e.message);
    }
  }

  public async updatePositions(): Promise<void> {
    if (!this.isEnabled()) return;
    if (!this.state.isSimulated) {
      await this.syncRealPositionsFromBinance();
    }
    this.positions = this.loadPositions();
    if (this.positions.length === 0) return;

    for (let i = this.positions.length - 1; i >= 0; i--) {
      const pos = this.positions[i];
      const curPrice = await this.fetchFuturesTicker(pos.symbol);
      if (!curPrice) continue;

      if (pos.side === "LONG") {
        await this.handleLongTick(pos, curPrice, i);
      } else {
        await this.handleShortTick(pos, curPrice, i);
      }
    }
  }

  private lastCandleDefenseCheck: Map<string, number> = new Map();

  private async checkAdverseCandleInProfit(symbol: string, side: "LONG" | "SHORT"): Promise<string | null> {
    const lastCheck = this.lastCandleDefenseCheck.get(symbol) || 0;
    if (Date.now() - lastCheck < 25000) return null;
    this.lastCandleDefenseCheck.set(symbol, Date.now());

    try {
      const k15 = await this.fetchKlines(symbol, "15m", 4);
      if (k15.length < 3) return null;
      const prev = k15[k15.length - 3];
      const last = k15[k15.length - 2]; // última vela 15m cerrada
      const range = last.high - last.low;
      if (range <= 0) return null;

      const lowerWickRatio = (Math.min(last.open, last.close) - last.low) / range;
      const upperWickRatio = (last.high - Math.max(last.open, last.close)) / range;
      const prevBody = Math.abs(prev.close - prev.open);
      const lastBody = Math.abs(last.close - last.open);

      if (side === "LONG") {
        const isShootingStarAgainst = upperWickRatio >= 0.45 && last.close <= last.open;
        const isBearishEngulfingAgainst =
          prev.close > prev.open &&
          last.close < last.open &&
          last.close <= prev.open &&
          last.open >= prev.close * 0.9995 &&
          lastBody >= prevBody * 1.05;
        if (isBearishEngulfingAgainst) return "Envolvente Bajista 15M en contra";
        if (isShootingStarAgainst) return `Estrella Fugaz 15M en contra (mecha ${Math.round(upperWickRatio * 100)}%)`;
      } else {
        const isHammerAgainst = lowerWickRatio >= 0.45 && last.close >= last.open;
        const isBullishEngulfingAgainst =
          prev.close < prev.open &&
          last.close > last.open &&
          last.close >= prev.open &&
          last.open <= prev.close * 1.0005 &&
          lastBody >= prevBody * 1.05;
        if (isBullishEngulfingAgainst) return "Envolvente Alcista 15M en contra";
        if (isHammerAgainst) return `Martillo Comprador 15M en contra (mecha ${Math.round(lowerWickRatio * 100)}%)`;
      }
    } catch {}
    return null;
  }

  private async handleLongTick(pos: FuturesPosition, curPrice: number, index: number): Promise<void> {
    // 1. Verificar Stop-Loss Innegociable
    if (curPrice <= pos.stopLossPrice) {
      await this.closePosition(index, curPrice, "STOP_LOSS");
      return;
    }

    const gainPct = ((curPrice - pos.entryPrice) / pos.entryPrice) * 100;
    const modeLabel = this.state.isSimulated ? "SIMULACIÓN" : "REAL";

    // 1.5. Patrón #4: Defensa Inteligente de Salida si ya gana >= +1.10% (+3.3% ROE) y sale vela de rechazo en contra
    if (!pos.trailingActive && gainPct >= 1.10) {
      const adverseReason = await this.checkAdverseCandleInProfit(pos.symbol, "LONG");
      if (adverseReason) {
        pos.trailingActive = true;
        pos.peakPrice = curPrice;
        pos.trailingCallbackPct = Math.min(pos.trailingCallbackPct, 0.22);
        pos.trailingStopPrice = curPrice * (1 - pos.trailingCallbackPct / 100);
        this.savePositions();
        if (this.isEnabled()) {
          await this.notifier.send(
            `🛡️ [FUTUROS ${modeLabel}: DEFENSA POR VELA CONTRARIA] 🕯️\n\n` +
            `• Moneda: <b>${pos.symbol}</b> (LONG ${pos.leverage}x)\n` +
            `• Ganancia actual: <b>+${gainPct.toFixed(2)}%</b>\n` +
            `• Patrón detectado: <b>${adverseReason}</b>\n` +
            `• 🔒 Candado Trailing activado de inmediato para blindar ganancias.`
          );
        }
        return;
      }
    }

    // 2. Activar Trailing si llega al gatillo
    if (!pos.trailingActive && curPrice >= pos.trailingTriggerPrice) {
      pos.trailingActive = true;
      pos.peakPrice = curPrice;
      pos.trailingStopPrice = curPrice * (1 - pos.trailingCallbackPct / 100);
      this.savePositions();

      if (this.isEnabled()) {
        await this.notifier.send(
          `🎯 [FUTUROS ${modeLabel}: TRAILING ACTIVADO] 🚀\n\n` +
          `• Moneda: <b>${pos.symbol}</b> (LONG ${pos.leverage}x)\n` +
          `• Precio actual: <b>${curPrice}</b> (+${gainPct.toFixed(2)}%)\n` +
          `• 🛡️ Ganancia mínima asegurada (+${pos.trailingTriggerPct}%)\n` +
          `• 🏹 El bot ahora persigue el pico más alto hacia arriba...`
        );
      }
      return;
    }

    // 3. Si Trailing ya está activo, rastrear el pico
    if (pos.trailingActive) {
      if (curPrice > pos.peakPrice) {
        pos.peakPrice = curPrice;
        pos.trailingStopPrice = curPrice * (1 - pos.trailingCallbackPct / 100);
        this.savePositions();
      } else if (pos.trailingStopPrice && curPrice <= pos.trailingStopPrice) {
        // Venta en la cima del rebote
        await this.closePosition(index, curPrice, "TRAILING_TP");
      }
    }
  }

  private async handleShortTick(pos: FuturesPosition, curPrice: number, index: number): Promise<void> {
    // 1. Verificar Stop-Loss Innegociable (en SHORT, stop es por arriba)
    if (curPrice >= pos.stopLossPrice) {
      await this.closePosition(index, curPrice, "STOP_LOSS");
      return;
    }

    const gainPct = ((pos.entryPrice - curPrice) / pos.entryPrice) * 100;
    const modeLabel = this.state.isSimulated ? "SIMULACIÓN" : "REAL";

    // 1.5. Patrón #4: Defensa Inteligente de Salida si ya gana >= +1.10% (+3.3% ROE) y sale vela compradora en contra
    if (!pos.trailingActive && gainPct >= 1.10) {
      const adverseReason = await this.checkAdverseCandleInProfit(pos.symbol, "SHORT");
      if (adverseReason) {
        pos.trailingActive = true;
        pos.peakPrice = curPrice;
        pos.trailingCallbackPct = Math.min(pos.trailingCallbackPct, 0.22);
        pos.trailingStopPrice = curPrice * (1 + pos.trailingCallbackPct / 100);
        this.savePositions();
        if (this.isEnabled()) {
          await this.notifier.send(
            `🛡️ [FUTUROS ${modeLabel}: DEFENSA POR VELA CONTRARIA] 🕯️\n\n` +
            `• Moneda: <b>${pos.symbol}</b> (SHORT ${pos.leverage}x)\n` +
            `• Ganancia actual: <b>+${gainPct.toFixed(2)}% neto en corto</b>\n` +
            `• Patrón detectado: <b>${adverseReason}</b>\n` +
            `• 🔒 Candado Trailing activado de inmediato para blindar ganancias.`
          );
        }
        return;
      }
    }

    // 2. Activar Trailing si cae hasta el gatillo
    if (!pos.trailingActive && curPrice <= pos.trailingTriggerPrice) {
      pos.trailingActive = true;
      pos.peakPrice = curPrice;
      pos.trailingStopPrice = curPrice * (1 + pos.trailingCallbackPct / 100);
      this.savePositions();

      if (this.isEnabled()) {
        await this.notifier.send(
          `🎯 [FUTUROS ${modeLabel}: TRAILING ACTIVADO] 🚀\n\n` +
          `• Moneda: <b>${pos.symbol}</b> (SHORT ${pos.leverage}x)\n` +
          `• Precio actual: <b>${curPrice}</b> (+${gainPct.toFixed(2)}% neto en corto)\n` +
          `• 🛡️ Ganancia mínima asegurada (+${pos.trailingTriggerPct}%)\n` +
          `• 🏹 El bot ahora persigue el piso más profundo hacia abajo...`
        );
      }
      return;
    }

    // 3. Si Trailing está activo en SHORT, rastrear el piso más bajo
    if (pos.trailingActive) {
      if (curPrice < pos.peakPrice) {
        pos.peakPrice = curPrice;
        pos.trailingStopPrice = curPrice * (1 + pos.trailingCallbackPct / 100);
        this.savePositions();
      } else if (pos.trailingStopPrice && curPrice >= pos.trailingStopPrice) {
        // Cierre en el piso de la caída
        await this.closePosition(index, curPrice, "TRAILING_TP");
      }
    }
  }

  private async closePosition(
    index: number,
    exitPrice: number,
    reason: "TRAILING_TP" | "STOP_LOSS"
  ): Promise<void> {
    const pos = this.positions[index];
    this.positions.splice(index, 1);
    this.savePositions();

    // En Modo Real: Cerrar contrato en Binance Futures
    if (!this.state.isSimulated) {
      try {
        const roundedQty = this.roundLotSize(pos.symbol, pos.contracts);
        const closeSide = pos.side === "LONG" ? "SELL" : "BUY";
        await this.privateFuturesRequest("/fapi/v1/order", "POST", {
          symbol: pos.symbol,
          side: closeSide,
          type: "MARKET",
          quantity: roundedQty,
          reduceOnly: "true"
        });
        console.log(`⚡ [FUTUROS REAL] Posición cerrada en Binance: ${pos.symbol} ${closeSide} ${roundedQty}`);
      } catch (err: any) {
        console.error(`❌ [FUTUROS REAL] Error cerrando ${pos.symbol}:`, err.message);
      }
    }

    // Cálculo PnL
    let grossPnl = 0;
    if (pos.side === "LONG") {
      grossPnl = (exitPrice - pos.entryPrice) * pos.contracts;
    } else {
      grossPnl = (pos.entryPrice - exitPrice) * pos.contracts;
    }

    // Comisión oficial de Binance Futures Taker (0.05% por lado = 0.10% total sobre notional)
    const feesUsdt = (pos.notionalUsdt + (exitPrice * pos.contracts)) * 0.0005;
    const netPnlUsdt = grossPnl - feesUsdt;
    const roePct = (netPnlUsdt / pos.marginUsdt) * 100;
    const durationMin = Math.round((Date.now() - pos.openTime) / 60000);

    // Actualizar balance simulado
    this.state.virtualBalanceUsdt += netPnlUsdt;
    this.saveState();

    const closedRecord: FuturesClosedTrade = {
      id: pos.id,
      symbol: pos.symbol,
      side: pos.side,
      entryPrice: pos.entryPrice,
      exitPrice,
      marginUsdt: pos.marginUsdt,
      leverage: pos.leverage,
      notionalUsdt: pos.notionalUsdt,
      openTime: pos.openTime,
      closeTime: Date.now(),
      durationMin,
      exitReason: reason,
      grossPnlUsdt: grossPnl,
      feesUsdt,
      netPnlUsdt,
      roePct
    };

    this.trades.push(closedRecord);
    this.saveTrades();

    // Establecer cooldown de 30 min en esta moneda
    this.symbolCooldowns.set(pos.symbol, Date.now() + 30 * 60 * 1000);

    // Notificación Telegram (solo si el motor de Futuros está activo)
    if (!this.isEnabled()) return;
    const modeLabel = this.state.isSimulated ? "SIMULACIÓN" : "REAL";
    if (reason === "TRAILING_TP") {
      await this.notifier.send(
        `🏆 [FUTUROS ${modeLabel}: GANANCIA COBRADA] 🎉\n\n` +
        `• Moneda: <b>${pos.symbol}</b> (${pos.side} ${pos.leverage}x)\n` +
        `• Precio Entrada: ${pos.entryPrice.toFixed(4)}\n` +
        `• Precio Salida: <b>${exitPrice.toFixed(4)}</b>\n` +
        `• Duración: ${durationMin} min\n` +
        `• Comisiones estimadas: ${feesUsdt.toFixed(4)} USDT\n` +
        `• 💵 Ganancia Líquida: 🟢 <b>+${netPnlUsdt.toFixed(3)} USDT</b> (+${roePct.toFixed(2)}% ROE)\n\n` +
        `💼 Balance ${modeLabel === "REAL" ? "en Cartera" : "Simulado"}: <b>${this.state.virtualBalanceUsdt.toFixed(2)} USDT</b>\n` +
        `📊 Escribe /reporte_futuros para ver el balance acumulado.`
      );
    } else {
      await this.notifier.send(
        `🛡️ [FUTUROS ${modeLabel}: STOP-LOSS EJECUTADO] 🛑\n\n` +
        `• Moneda: <b>${pos.symbol}</b> (${pos.side} ${pos.leverage}x)\n` +
        `• Entrada: ${pos.entryPrice.toFixed(4)} | Salida Stop: ${exitPrice.toFixed(4)}\n` +
        `• Duración: ${durationMin} min\n` +
        `• 💵 Pérdida Controlada: 🔴 <b>${netPnlUsdt.toFixed(3)} USDT</b> (${roePct.toFixed(2)}% ROE)\n` +
        `• Capital protegido: ${(pos.marginUsdt + netPnlUsdt).toFixed(2)} USDT devueltos al margen.\n\n` +
        `💼 Balance ${modeLabel === "REAL" ? "en Cartera" : "Simulado"}: <b>${this.state.virtualBalanceUsdt.toFixed(2)} USDT</b>`
      );
    }
  }

  // --- ESCÁNER DE OPORTUNIDADES CUANTITATIVAS BI-DIRECCIONAL ---

  private lastRadarLogTime = 0;
  private radarSnapshot: any[] = [];

  public async scanMarket(): Promise<void> {
    if (!this.isEnabled()) return;
    this.positions = this.loadPositions();
    if (this.isScanning) return;
    this.isScanning = true;

    try {
      this.state.lastScanTime = Date.now();
      const currentRadar: any[] = [];
      const shouldLogRadar = Date.now() - this.lastRadarLogTime > 45000;
      if (shouldLogRadar) {
        this.lastRadarLogTime = Date.now();
        console.log(`[FUTUROS 📡 RADAR] Escaneando ${FUTURES_WATCHLIST.length} pares (2x ISOLATED)... Posiciones activas: ${this.positions.length}/${this.state.maxActivePositions}`);
      }

      for (const symbol of FUTURES_WATCHLIST) {
        // Obtenemos telemetría de todos los pares para el radar del dashboard
        const item = await this.evaluateSymbolWithData(symbol);
        if (item) currentRadar.push(item);
      }

      if (currentRadar.length > 0) {
        this.radarSnapshot = currentRadar;
        try {
          fs.writeFileSync(path.resolve(process.cwd(), ".futures-radar.json"), JSON.stringify(currentRadar, null, 2), "utf-8");
        } catch {}
      }
    } catch (e: any) {
      console.error("Error en scanMarket Futuros:", e.message);
    } finally {
      this.isScanning = false;
    }
  }

  /**
   * Reloj Estadístico de Futuros Bi-Direccional (18 Semanas Binance, Hora Colombia COT):
   * - isLongFloorWindow: Horas Piso donde estadísticamente se forman los suelos para LONG (00:30-04:00 AM, 11:30 AM-01:30 PM, 20:00-21:45 PM, Sábado 02:00 AM-12:00 PM).
   * - isShortDumpWindow: Horas Techo / Drenaje donde estadísticamente inician las caídas para SHORT (08:30-11:30 AM, 16:00-18:15 PM, 22:30-00:30 AM, Viernes 14:00 - Sábado 02:00 AM).
   * - isSundayBullRally: Domingo 16:30 a 23:30 COT (+1.00% retorno alcista promedio), donde se favorecen LONGs y se bloquean SHORTs tempranos.
   */
  public getFuturesStatisticalClock(): {
    isLongFloorWindow: boolean;
    isShortDumpWindow: boolean;
    isSundayBullRally: boolean;
  } {
    try {
      const now = new Date();
      const dayStr = now.toLocaleDateString("en-US", { timeZone: "America/Bogota", weekday: "short" });
      const hour = parseInt(now.toLocaleTimeString("en-US", { timeZone: "America/Bogota", hour12: false, hour: "numeric" }), 10);
      const minute = parseInt(now.toLocaleTimeString("en-US", { timeZone: "America/Bogota", minute: "numeric" }), 10);
      const safeH = isNaN(hour) ? 12 : (hour === 24 ? 0 : hour);
      const safeM = isNaN(minute) ? 0 : minute;
      const timeDec = safeH + safeM / 60;
      const isWeekday = ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(dayStr);
      const isMonToThu = ["Mon", "Tue", "Wed", "Thu"].includes(dayStr);

      const isLongFloorWindow =
        ((isWeekday || dayStr === "Sun") && timeDec >= 0.5 && timeDec <= 4.0) ||
        (dayStr === "Thu" && timeDec >= 10.25 && timeDec <= 13.5) ||
        (isMonToThu && timeDec >= 11.5 && timeDec <= 13.5) ||
        (isMonToThu && timeDec >= 20.0 && timeDec <= 21.75) ||
        (dayStr === "Sat" && timeDec >= 2.0 && timeDec <= 12.0) ||
        (dayStr === "Sun" && timeDec >= 14.0 && timeDec <= 16.5);

      const morningDumpEnd = dayStr === "Thu" ? 10.25 : 11.5;
      const isShortDumpWindow =
        (dayStr === "Fri" && timeDec >= 14.0) ||
        (dayStr === "Sat" && timeDec < 2.0) ||
        (isWeekday && timeDec >= 8.5 && timeDec < morningDumpEnd) ||
        (isMonToThu && timeDec >= 16.0 && timeDec <= 18.25) ||
        (isMonToThu && timeDec >= 22.5) ||
        (["Tue", "Wed", "Thu", "Fri"].includes(dayStr) && timeDec < 0.5);

      const isSundayBullRally = dayStr === "Sun" && timeDec >= 16.5 && timeDec <= 23.5;

      return { isLongFloorWindow, isShortDumpWindow, isSundayBullRally };
    } catch {
      return { isLongFloorWindow: false, isShortDumpWindow: false, isSundayBullRally: false };
    }
  }

  private async checkBtc15mFuturesAlignment(symbol: string, side: "LONG" | "SHORT"): Promise<boolean> {
    if (symbol === "BTCUSDT") return true;
    try {
      const btcK = await this.fetchKlines("BTCUSDT", "15m", 3);
      if (btcK.length < 2) return true;
      const last = btcK[btcK.length - 1];
      const range = Math.max(1e-9, last.high - last.low);
      const lowerWick = (Math.min(last.open, last.close) - last.low) / range;
      const upperWick = (last.high - Math.max(last.open, last.close)) / range;
      const changePct = ((last.close - last.open) / last.open) * 100;

      if (side === "LONG") {
        // Para LONG en altcoins, BTC no debe estar cayendo con fuerza y debe mostrar vela verde o absorción inferior
        return changePct > -0.25 && (last.close >= last.open || lowerWick >= 0.28);
      } else {
        // Para SHORT en altcoins, BTC no debe estar subiendo con fuerza y debe mostrar vela roja o rechazo superior
        return changePct < 0.25 && (last.close <= last.open || upperWick >= 0.28);
      }
    } catch {
      return true;
    }
  }

  private async evaluateSymbolWithData(symbol: string): Promise<any> {
    const hasPosition = this.positions.find((p) => p.symbol === symbol);
    // 1. Obtener velas 1H (Macro) y 15M (Gatillo)
    const [klines1h, klines15m] = await Promise.all([
      this.fetchKlines(symbol, "1h", 60),
      this.fetchKlines(symbol, "15m", 40)
    ]);

    if (klines1h.length < 50 || klines15m.length < 20) return;

    const closes1h = klines1h.map((k) => k.close);
    const closes15m = klines15m.map((k) => k.close);

    const ema50_1h = this.calculateEMA(closes1h, 50);
    const curPrice1h = closes1h[closes1h.length - 1];

    const rsi15m = this.calculateRSI(closes15m, 14);
    const prevCandle15m = klines15m[klines15m.length - 3]; // penúltima vela cerrada
    const lastCandle15m = klines15m[klines15m.length - 2]; // última vela cerrada
    const curPrice = closes15m[closes15m.length - 1];

    const totalRange = lastCandle15m.high - lastCandle15m.low;
    if (totalRange <= 0) return;

    const lowerWick = Math.min(lastCandle15m.open, lastCandle15m.close) - lastCandle15m.low;
    const upperWick = lastCandle15m.high - Math.max(lastCandle15m.open, lastCandle15m.close);
    const lowerWickRatio = lowerWick / totalRange;

    // Reloj Estadístico 18 semanas: solo exigir mecha >= 45% en el tramo trampa de apertura asiática (22:30 - 00:30 COT)
    const clock = this.getFuturesStatisticalClock();
    const minWickRequired = clock.isShortDumpWindow && !clock.isLongFloorWindow ? 0.42 : 0.35;
    const upperWickRatio = upperWick / totalRange;

    // --- DETECTOR DE LOS 3 PATRONES DE ENTRADA MAESTROS (15M) ---
    const prevRange = prevCandle15m ? Math.max(1e-9, prevCandle15m.high - prevCandle15m.low) : 1;
    const prevLowerWickRatio = prevCandle15m ? (Math.min(prevCandle15m.open, prevCandle15m.close) - prevCandle15m.low) / prevRange : 0;
    const prevUpperWickRatio = prevCandle15m ? (prevCandle15m.high - Math.max(prevCandle15m.open, prevCandle15m.close)) / prevRange : 0;
    const prevBody = prevCandle15m ? Math.abs(prevCandle15m.close - prevCandle15m.open) : 0;
    const lastBody = Math.abs(lastCandle15m.close - lastCandle15m.open);

    // 1. Martillo / Estrella Fugaz (Pinbar de Mecha Larga)
    const isHammerPinbar = lowerWickRatio >= minWickRequired;
    const isShootingStarPinbar = upperWickRatio >= minWickRequired;

    // 2. Vela Envolvente Institucional (Bullish / Bearish Engulfing)
    const isBullishEngulfing = !!prevCandle15m &&
      prevCandle15m.close < prevCandle15m.open &&
      lastCandle15m.close > lastCandle15m.open &&
      lastCandle15m.close >= prevCandle15m.open &&
      lastCandle15m.open <= prevCandle15m.close * 1.0005 &&
      lastBody >= prevBody * 1.05 &&
      (lastBody / totalRange) >= 0.50;

    const isBearishEngulfing = !!prevCandle15m &&
      prevCandle15m.close > prevCandle15m.open &&
      lastCandle15m.close < lastCandle15m.open &&
      lastCandle15m.close <= prevCandle15m.open &&
      lastCandle15m.open >= prevCandle15m.close * 0.9995 &&
      lastBody >= prevBody * 1.05 &&
      (lastBody / totalRange) >= 0.50;

    // 3. Doble Mecha / Barrido de Liquidez (Liquidity Sweep / Tweezers)
    const isBullishSweep = !!prevCandle15m &&
      lowerWickRatio >= 0.28 &&
      prevLowerWickRatio >= 0.28 &&
      Math.abs(lastCandle15m.low - prevCandle15m.low) / prevCandle15m.low <= 0.004 &&
      lastCandle15m.close >= lastCandle15m.open;

    const isBearishSweep = !!prevCandle15m &&
      upperWickRatio >= 0.28 &&
      prevUpperWickRatio >= 0.28 &&
      Math.abs(lastCandle15m.high - prevCandle15m.high) / prevCandle15m.high <= 0.004 &&
      lastCandle15m.close <= lastCandle15m.open;

    const bullPatternName = isBullishEngulfing
      ? "🟢 Envolvente Alcista"
      : isBullishSweep
      ? "🛡️ Doble Piso (Barrido Liquidez)"
      : isHammerPinbar
      ? `🔨 Martillo Pinbar (mecha ${(lowerWickRatio * 100).toFixed(0)}%)`
      : ` Pinbar Soporte (mecha ${(lowerWickRatio * 100).toFixed(0)}%)`;

    const bearPatternName = isBearishEngulfing
      ? "🔴 Envolvente Bajista"
      : isBearishSweep
      ? "🧱 Doble Techo (Barrido Liquidez)"
      : `🌠 Estrella Fugaz (mecha ${(upperWickRatio * 100).toFixed(0)}%)`;

    const hasBullishCandleTrigger = isHammerPinbar || isBullishEngulfing || isBullishSweep;
    const hasBearishCandleTrigger = isShootingStarPinbar || isBearishEngulfing || isBearishSweep;

    // Obtener Funding Rate para protección
    const fundingRate = await this.fetchFundingRate(symbol);

    // --- EVALUACIÓN DE SEÑAL LONG CALIBRADA CON 18 SEMANAS DE BINANCE ---
    // En Hora Piso (00:30-04:00 AM, 11:30 AM-01:30 PM, 20:00-21:45 PM, Sáb madrugada): umbrales óptimos de suelo (RSI <= 36 o pullback <= 42).
    // En Hora de Drenaje / Pausa (08:30-11:30 AM, 16:00-18:15 PM, Vie tarde/noche): LONG bloqueado salvo Excepción Atípica (RSI <= 25 y mecha >= 45%).
    const isMacroBullish = curPrice1h >= ema50_1h * 0.996;
    const isAtypicalLongException = rsi15m <= 25 && lowerWickRatio >= 0.45 && hasBullishCandleTrigger;
    const maxLongFloorRsi = clock.isLongFloorWindow ? 36 : 33;
    const maxLongPullbackRsi = (clock.isLongFloorWindow || clock.isSundayBullRally) ? 42 : 38;
    const isFloorAbsorption = !clock.isShortDumpWindow
      ? (rsi15m <= maxLongFloorRsi && hasBullishCandleTrigger)
      : isAtypicalLongException;
    const isTrendPullback = !clock.isShortDumpWindow && isMacroBullish && rsi15m <= maxLongPullbackRsi && (lowerWickRatio >= minWickRequired || isBullishEngulfing || isBullishSweep);
    const isFundingSafeForLong = fundingRate < 0.0003;

    // Cooldown check
    const cd = this.symbolCooldowns.get(symbol);
    const inCooldown = cd && Date.now() < cd;

    if (!hasPosition && !inCooldown && this.positions.length < this.state.maxActivePositions && (isFloorAbsorption || isTrendPullback) && isFundingSafeForLong) {
      const btcAlignedLong = await this.checkBtc15mFuturesAlignment(symbol, "LONG");
      if (btcAlignedLong) {
        const rationale = isAtypicalLongException
          ? `⚡ Excepción Atípica LONG 15M [${bullPatternName}]: Capitulación extrema (RSI ${rsi15m.toFixed(1)})`
          : (isFloorAbsorption
            ? `🔥 Suelo 15M [${bullPatternName}]: RSI (${rsi15m.toFixed(1)}) en zona de absorción${clock.isLongFloorWindow ? " [Hora Piso]" : ""}`
            : `📈 Pullback 1H (>EMA50) [${bullPatternName}]: Rebote en soporte 15M (RSI: ${rsi15m.toFixed(1)})`);
        await this.openPosition(symbol, "LONG", curPrice, rationale);
      }
    }

    // --- EVALUACIÓN DE SEÑAL SHORT CALIBRADA CON 18 SEMANAS DE BINANCE ---
    // En Hora de Drenaje / Techo (08:30-11:30 AM NY, 16:00-18:15 PM Cierre NY, 22:30-00:30 Asia, Vie tarde/noche): ventana ideal para SHORT.
    // En Hora Piso o Rally Dominical CME: SHORT bloqueado salvo sobrecompra extrema (RSI >= 68 con vela de rechazo).
    const isMacroBearish = curPrice1h <= ema50_1h * 1.002;
    const minShortRejectionRsi = clock.isShortDumpWindow ? 54 : 58;
    const isBearishRejection = !clock.isLongFloorWindow && !clock.isSundayBullRally && isMacroBearish && rsi15m >= minShortRejectionRsi && hasBearishCandleTrigger;
    const isOverboughtReversal = rsi15m >= (clock.isLongFloorWindow || clock.isSundayBullRally ? 68 : 64) && hasBearishCandleTrigger;
    const isFundingSafeForShort = fundingRate > -0.0003;

    if (!hasPosition && !inCooldown && this.positions.length < this.state.maxActivePositions && (isBearishRejection || isOverboughtReversal) && isFundingSafeForShort) {
      const btcAlignedShort = await this.checkBtc15mFuturesAlignment(symbol, "SHORT");
      if (btcAlignedShort) {
        const rationale = isBearishRejection
          ? `🔻 Rechazo 1H (<EMA50) [${bearPatternName}]: RSI 15M (${rsi15m.toFixed(1)})${clock.isShortDumpWindow ? " [Hora Drenaje]" : ""}`
          : `⚡ Giro Sobrecompra [${bearPatternName}]: RSI 15M (${rsi15m.toFixed(1)})`;
        await this.openPosition(symbol, "SHORT", curPrice, rationale);
      }
    }

    let statusText = "VIGILANDO";
    if (hasPosition) statusText = `POSICIÓN VIVA (${hasPosition.side} ${hasPosition.leverage}x)`;
    else if (isFloorAbsorption || isTrendPullback) statusText = `🟢 LONG: ${bullPatternName}`;
    else if (isBearishRejection || isOverboughtReversal) statusText = `🔴 SHORT: ${bearPatternName}`;
    else if (hasBullishCandleTrigger) statusText = `🕯️ ${bullPatternName} (Esperando RSI)`;
    else if (hasBearishCandleTrigger) statusText = `🕯️ ${bearPatternName} (Esperando RSI)`;
    else if (rsi15m <= 40) statusText = "🟢 ZONA SOBREVENTA (Buscando Suelo)";
    else if (isMacroBearish && rsi15m >= 48) statusText = "🔴 ZONA REBOTE (Vigilando Rechazo)";
    else if (inCooldown) statusText = "⏳ EN COOLDOWN";

    return {
      symbol,
      price: curPrice,
      ema50: ema50_1h,
      trend: curPrice >= ema50_1h ? "ALCISTA" : "BAJISTA",
      rsi15m: parseFloat(rsi15m.toFixed(1)),
      lowerWickPct: Math.round(lowerWickRatio * 100),
      upperWickPct: Math.round(upperWickRatio * 100),
      fundingRate: (fundingRate * 100).toFixed(4) + "%",
      status: statusText
    };
  }

  private async openPosition(
    symbol: string,
    side: "LONG" | "SHORT",
    price: number,
    rationale: string
  ): Promise<void> {
    const margin = this.state.defaultMarginPerTrade;
    const leverage = this.getDynamicLeverage(symbol);
    const notional = margin * leverage;

    // Simular un pequeño slippage de entrada del 0.02%
    const slippage = side === "LONG" ? 1.0002 : 0.9998;
    const entryPrice = price * slippage;
    const contracts = notional / entryPrice;

    const stopLossPct = this.state.stopLossPct;
    const trailingTriggerPct = this.state.trailingTriggerPct;

    const stopLossPrice = side === "LONG"
      ? entryPrice * (1 - stopLossPct / 100)
      : entryPrice * (1 + stopLossPct / 100);

    const trailingTriggerPrice = side === "LONG"
      ? entryPrice * (1 + trailingTriggerPct / 100)
      : entryPrice * (1 - trailingTriggerPct / 100);

    let realOrderId: any = null;
    if (!this.state.isSimulated) {
      try {
        // 0. Pre-verificación de Margen Disponible en Binance para evitar rebotes
        const account = await this.privateFuturesRequest("/fapi/v2/account", "GET");
        const availableBalance = parseFloat(account?.availableBalance || "0");
        if (availableBalance < margin * 0.95) {
          console.log(`⚠️ [FUTUROS] Margen insuficiente disponible (${availableBalance.toFixed(2)} USDT < ${margin.toFixed(2)} USDT requeridos). Omitiendo orden para proteger la cuenta.`);
          this.symbolCooldowns.set(symbol, Date.now() + 60 * 1000);
          return;
        }

        try {
          await this.privateFuturesRequest("/fapi/v1/marginType", "POST", { symbol, marginType: "ISOLATED" });
        } catch {}
        try {
          await this.privateFuturesRequest("/fapi/v1/leverage", "POST", { symbol, leverage });
        } catch {}

        const spec = this.getSymbolLotSpec(symbol);
        const roundedQty = this.roundLotSize(symbol, contracts);
        const effectiveQty = parseFloat(roundedQty);
        const effectiveNotional = effectiveQty * entryPrice;

        if (effectiveNotional < spec.minNotional) {
          console.log(`⚠️ [FUTUROS] ${symbol} no cumple minNotional (${effectiveNotional.toFixed(2)} < ${spec.minNotional}). Omitiendo para proteger el balance.`);
          return;
        }

        const orderSide = side === "LONG" ? "BUY" : "SELL";
        const res = await this.privateFuturesRequest("/fapi/v1/order", "POST", {
          symbol,
          side: orderSide,
          type: "MARKET",
          quantity: roundedQty
        });
        if (res.orderId) {
          realOrderId = res.orderId;
          this.symbolCooldowns.set(symbol, Date.now() + 60 * 1000);
          console.log(`⚡ [FUTUROS REAL] Orden abierta en Binance: ${symbol} ${orderSide} ${roundedQty} (ID: ${res.orderId})`);
        } else if (res.code) {
          console.error(`❌ [FUTUROS REAL ERROR] ${res.msg} (code: ${res.code})`);
          this.symbolCooldowns.set(symbol, Date.now() + 5 * 60 * 1000);
          await this.notifier.send(`⚠️ <b>[FUTUROS REAL] Error abriendo ${symbol}:</b>\n${res.msg}`);
          return;
        }
      } catch (err: any) {
        console.error(`❌ [FUTUROS REAL] Error en orden de ${symbol}:`, err.message);
        this.symbolCooldowns.set(symbol, Date.now() + 5 * 60 * 1000);
        return;
      }
    }

    const actualQty = parseFloat(this.roundLotSize(symbol, contracts));
    const actualNotional = actualQty * entryPrice;
    const actualMargin = actualNotional / leverage;

    const newPos: FuturesPosition = {
      id: realOrderId ? `fut_real_${realOrderId}` : `sim_fut_${Date.now()}`,
      symbol,
      side,
      entryPrice,
      marginUsdt: actualMargin,
      leverage,
      notionalUsdt: actualNotional,
      contracts: actualQty,
      stopLossPrice,
      stopLossPct,
      trailingTriggerPrice,
      trailingTriggerPct,
      trailingCallbackPct: this.state.trailingCallbackPct,
      trailingActive: false,
      peakPrice: entryPrice,
      trailingStopPrice: null,
      openTime: Date.now(),
      status: "OPEN",
      rationale
    };

    this.positions.push(newPos);
    this.savePositions();

    if (!this.isEnabled()) return;
    const maxRiskUsdt = (margin * (stopLossPct / 100) * leverage);
    const sideEmoji = side === "LONG" ? "🟢 LONG" : "🔴 SHORT";
    const modeLabel = this.state.isSimulated ? "SIMULACIÓN" : "REAL";

    await this.notifier.send(
      `🧪 [FUTUROS ${modeLabel}: ENTRADA ${sideEmoji}] 🎯\n\n` +
      `• Moneda: <b>${symbol}</b>\n` +
      `• Margen asignado: <b>${margin.toFixed(2)} USDT</b> (${leverage}x ISOLATED)\n` +
      `• Tamaño posición: <b>${notional.toFixed(2)} USDT</b> (~${contracts.toFixed(4)} contratos)\n` +
      `• 🎯 Entrada: <b>${entryPrice.toFixed(4)}</b>\n` +
      `• 🛡️ Stop-Loss fijo: <b>${stopLossPrice.toFixed(4)}</b> (-${stopLossPct}% | Máx riesgo: -$${maxRiskUsdt.toFixed(2)} USDT)\n` +
      `• 🏹 Gatillo Trailing: <b>${trailingTriggerPrice.toFixed(4)}</b> (+${trailingTriggerPct}%)\n` +
      `• 📊 Fundamento del Centinela:\n<i>${rationale}</i>\n\n` +
      `🔒 <i>Margen Aislado: Cero riesgo de liquidación.</i>`
    );
  }

  // --- REPORTES Y ESTADÍSTICAS ---

  
  // --- EVALUACIÓN DE VIABILIDAD DEL MERCADO EN TIEMPO REAL ---
  public async evaluateMarketViability(): Promise<MarketViabilityReport> {
    try {
      // 1. Analizar BTC 1H (Macro Salud & Volatilidad)
      const btcKlines = await this.fetchKlines("BTCUSDT", "1h", 60);
      let btcScore = 35;
      let btcStatus = "Macro Estable";
      let volatilityScore = 25;
      let volatilityStatus = "Volatilidad Controlada";

      if (btcKlines.length >= 50) {
        const closes = btcKlines.map((k) => k.close);
        const ema50 = this.calculateEMA(closes, 50);
        const curPrice = closes[closes.length - 1];
        const ratio = curPrice / ema50;

        if (ratio >= 0.995) {
          btcScore = 35;
          btcStatus = `🟢 Alcista/Sólido (${curPrice.toFixed(0)} > EMA50 ${ema50.toFixed(0)})`;
        } else if (ratio >= 0.975) {
          btcScore = 20;
          btcStatus = `🟡 Pullback controlado (${curPrice.toFixed(0)} en zona EMA50 ${ema50.toFixed(0)})`;
        } else {
          btcScore = 0;
          btcStatus = `🔴 Debilidad bajista (${curPrice.toFixed(0)} bajo EMA50 ${ema50.toFixed(0)})`;
        }

        const recentCandles = btcKlines.slice(-5);
        const avgRangePct = recentCandles.reduce((acc, c) => acc + ((c.high - c.low) / c.close) * 100, 0) / recentCandles.length;
        if (avgRangePct <= 2.2) {
          volatilityScore = 25;
          volatilityStatus = `🟢 Volatilidad controlada (Promedio ${avgRangePct.toFixed(2)}%/hora)`;
        } else if (avgRangePct <= 3.8) {
          volatilityScore = 15;
          volatilityStatus = `🟡 Volatilidad moderada (Promedio ${avgRangePct.toFixed(2)}%/hora)`;
        } else {
          volatilityScore = 0;
          volatilityStatus = `🔴 Turbulencia extrema (Promedio ${avgRangePct.toFixed(2)}%/hora)`;
        }
      }

      // 2. Analizar Tasas de Financiación (Funding Rates)
      let fundingScore = 25;
      let fundingStatus = "Tasas neutrales";
      try {
        const btcFunding = await this.fetchFundingRate("BTCUSDT");
        const ethFunding = await this.fetchFundingRate("ETHUSDT");
        const avgFundingPct = ((btcFunding + ethFunding) / 2) * 100;

        if (Math.abs(avgFundingPct) <= 0.02) {
          fundingScore = 25;
          fundingStatus = `🟢 Equilibrada (Promedio ${avgFundingPct.toFixed(4)}% - Sin sobrecompra/venta)`;
        } else if (Math.abs(avgFundingPct) <= 0.045) {
          fundingScore = 15;
          fundingStatus = `🟡 Ligera inclinación (Promedio ${avgFundingPct.toFixed(4)}%)`;
        } else {
          fundingScore = 0;
          fundingStatus = `🔴 Sobrecalentada (Promedio ${avgFundingPct.toFixed(4)}% - Riesgo de squeeze)`;
        }
      } catch {
        fundingScore = 15;
        fundingStatus = "Tasas estables";
      }

      // 3. Evaluar oportunidades técnicas en la lista de seguimiento
      const favorableSymbols: string[] = [];
      let setupScore = 0;
      for (const sym of FUTURES_WATCHLIST.slice(0, 5)) {
        try {
          const k15m = await this.fetchKlines(sym, "15m", 30);
          if (k15m.length >= 14) {
            const closes = k15m.map((k) => k.close);
            const rsi = this.calculateRSI(closes, 14);
            if (rsi <= 44) {
              favorableSymbols.push(`${sym} (RSI 15M: ${rsi.toFixed(1)} en Sobreventa - Setup LONG)`);
            } else if (rsi >= 58) {
              favorableSymbols.push(`${sym} (RSI 15M: ${rsi.toFixed(1)} en Sobrecompra - Setup SHORT)`);
            }
          }
        } catch {}
      }

      if (favorableSymbols.length >= 2) {
        setupScore = 15;
      } else if (favorableSymbols.length === 1) {
        setupScore = 10;
      } else {
        setupScore = 5;
      }

      const totalScore = btcScore + volatilityScore + fundingScore + setupScore;
      const isViable = totalScore >= 60;

      let rationale = "";
      if (isViable) {
        rationale = `Mercado con estructura macro ordenada (${btcStatus}), volatilidad controlada y condiciones técnicas propicias en ${favorableSymbols.length} activos.`;
      } else {
        rationale = `Condiciones no óptimas para apalancamiento: ${btcStatus}, ${volatilityStatus}. Score ${totalScore}/100 insuficiente para asumir riesgo de apalancamiento.`;
      }

      const recommendedAction = isViable
        ? "VIABLE: Se puede operar futuros en modo real con apalancamiento moderado (2x-4x) y stop-loss estricto (-1.2%)."
        : "NO VIABLE: Se recomienda canalizar el capital libre hacia estrategias Spot convencionales sin apalancamiento.";

      return {
        isViable,
        score: totalScore,
        btcStatus,
        fundingStatus,
        volatilityStatus,
        opportunitiesFound: favorableSymbols.length,
        favorableSymbols,
        rationale,
        recommendedAction
      };
    } catch (e: any) {
      return {
        isViable: false,
        score: 40,
        btcStatus: "No disponible",
        fundingStatus: "No disponible",
        volatilityStatus: "No disponible",
        opportunitiesFound: 0,
        favorableSymbols: [],
        rationale: "Error al consultar telemetría: " + e.message,
        recommendedAction: "Mantener capital en estrategias Spot."
      };
    }
  }

  public getSummaryReport(): string {
    const totalTrades = this.trades.length;
    const wins = this.trades.filter((t) => t.netPnlUsdt > 0).length;
    const losses = this.trades.filter((t) => t.netPnlUsdt <= 0).length;
    const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : "0.0";
    const totalPnl = this.trades.reduce((acc, t) => acc + t.netPnlUsdt, 0);

    let report = `📊 <b>INFORME CUANTITATIVO FUTUROS (SIMULACIÓN)</b>\n\n`;
    report += `💼 <b>Balance Simulado:</b> ${this.state.virtualBalanceUsdt.toFixed(2)} USDT (Inicio: ${this.state.startingBalanceUsdt.toFixed(2)} USDT)\n`;
    report += `📈 <b>PnL Total Neto:</b> ${totalPnl >= 0 ? "🟢 +" : "🔴 "}${totalPnl.toFixed(3)} USDT\n`;
    report += `🎯 <b>Efectividad (Win Rate):</b> ${winRate}% (${wins} Ganadas / ${losses} Pérdidas)\n`;
    report += `🛡️ <b>Apalancamiento:</b> ${this.state.defaultLeverage}x (Margen Aislado $${this.state.defaultMarginPerTrade} USDT)\n`;
    report += `🔄 <b>Posiciones Abiertas:</b> ${this.positions.length} / ${this.state.maxActivePositions}\n\n`;

    if (this.positions.length > 0) {
      report += `📍 <b>POSICIONES ACTIVAS:</b>\n`;
      for (const p of this.positions) {
        report += `• <b>${p.symbol}</b> (${p.side} ${p.leverage}x): Entrada $${p.entryPrice.toFixed(4)} | Stop: $${p.stopLossPrice.toFixed(4)}\n`;
      }
      report += `\n`;
    }

    if (totalTrades > 0) {
      report += `📜 <b>ÚLTIMAS 5 OPERACIONES CERRADAS:</b>\n`;
      const recent = this.trades.slice(-5).reverse();
      for (const t of recent) {
        const icon = t.netPnlUsdt >= 0 ? "🟢" : "🔴";
        const sign = t.netPnlUsdt >= 0 ? "+" : "";
        report += `${icon} <b>${t.symbol}</b> (${t.side}): ${sign}${t.netPnlUsdt.toFixed(3)} USDT (${sign}${t.roePct.toFixed(1)}% ROE) [${t.exitReason}]\n`;
      }
    } else {
      report += `<i>Aún no hay operaciones cerradas. El escáner está vigilando oportunidades óptimas.</i>`;
    }

    return report;
  }

  // --- ARRANQUE Y CICLO PERIÓDICO ---

  public start(pollIntervalMs = 4000): void {
    if (this.intervalHandle) return;
    const mode = this.state.isSimulated ? "Simulación Estricta" : "REAL (Fondos en Binance)";
    console.log(`🚀 Motor Cuantitativo de Futuros (${mode}) INICIADO.`);

    if (!this.state.isSimulated) {
      this.syncRealPositionsFromBinance().catch(() => {});
    }

    this.intervalHandle = setInterval(async () => {
      try {
        await this.updatePositions();
        await this.scanMarket();
      } catch (e: any) {
        console.error("Error en ciclo de FuturosEngine:", e.message);
      }
    }, pollIntervalMs);
  }

  public stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      console.log("⏸️ Motor de Futuros detenido.");
    }
  }
}

// Si se ejecuta directamente vía CLI: `npx tsx src/futures-engine.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  const engine = new FuturesEngine();
  engine.start(3500);
  console.log("📡 Escaneando Binance Futures USD-M en modo simulación estricta...");
}
