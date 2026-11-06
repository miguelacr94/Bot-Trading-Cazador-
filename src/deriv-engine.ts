import WebSocket from "ws";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { TelegramNotifier } from "./notifier.js";

dotenv.config();
try {
  const envPath = path.resolve(process.cwd(), ".env");
  if (fs.existsSync(envPath)) dotenv.config({ path: envPath });
} catch {}

export interface DerivPosition {
  contractId: string;
  symbol: string;
  contractType: "CALL" | "PUT";
  stake: number;
  entrySpot: number;
  entryTime: number;
  barrier?: string;
  duration: number;
  durationUnit: string;
  payoutExpected: number;
  status: "open" | "won" | "lost";
  currentProfit: number;
  rationale: string;
}

export interface DerivTrade {
  contractId: string;
  symbol: string;
  contractType: "CALL" | "PUT";
  stake: number;
  payout: number;
  profit: number;
  entrySpot: number;
  exitSpot: number;
  entryTime: number;
  exitTime: number;
  durationSec: number;
  status: "won" | "lost";
  rationale: string;
}

export interface DerivState {
  enabled: boolean;
  isSimulated: boolean; // Demo account DOT95084693
  accountId: string;
  appId: string;
  balanceUsdt: number;
  startingBalanceUsdt: number;
  totalProfitUsdt: number;
  winsCount: number;
  lossesCount: number;
  winRatePct: number;
  defaultStake: number;
  defaultDurationTicks: number;
  maxConcurrentTrades: number;
  dailyProfitTarget: number;
  dailyStopLoss: number;
  dailyRealizedPnl: number;
  lastDailyReset: string; // YYYY-MM-DD
  activeSymbols: string[];
  lastTradeTime: number;
  // --- BLINDAJE DE CAPITAL ---
  consecutiveLosses: number;      // Pérdidas seguidas actuales
  maxConsecutiveLosses: number;   // Al llegar aquí → pausa de enfriamiento
  cooldownMinutes: number;        // Minutos de pausa tras racha negativa
  pauseUntil: number;             // Timestamp hasta el cual el motor descansa
  capitalFloorUsdt: number;       // Piso absoluto: si el balance cae aquí, el bot se APAGA
  maxStakePctOfBalance: number;   // Stake nunca supera este % del balance actual
}

interface TickData {
  quote: number;
  epoch: number;
}

export class DerivEngine {
  private notifier: TelegramNotifier;
  private stateFile: string;
  private positionsFile: string;
  private tradesFile: string;
  private radarFile: string;
  private state: DerivState;
  private positions: DerivPosition[] = [];
  private trades: DerivTrade[] = [];

  private apiKey: string;
  private appId: string;
  private accountId: string;
  private demoAccountId: string;
  private realAccountId: string;

  private ws: WebSocket | null = null;
  private isConnected = false;
  private isConnecting = false;
  private pingInterval: NodeJS.Timeout | null = null;
  private analysisInterval: NodeJS.Timeout | null = null;

  // Real-time market tick buffers per symbol
  private tickHistory: Map<string, TickData[]> = new Map();
  private symbolCooldowns: Map<string, number> = new Map();

  constructor() {
    this.notifier = new TelegramNotifier();
    const cwd = process.cwd();
    this.stateFile = path.resolve(cwd, ".deriv-state.json");
    this.positionsFile = path.resolve(cwd, ".deriv-positions.json");
    this.tradesFile = path.resolve(cwd, ".deriv-trades.json");
    this.radarFile = path.resolve(cwd, ".deriv-radar.json");

    this.apiKey = process.env.DERIV_KEY || "";
    this.appId = process.env.DERIV_APP_ID || "";
    this.demoAccountId = process.env.DERIV_DEMO_ACCOUNT_ID || "DOT95084693";
    this.realAccountId = process.env.DERIV_REAL_ACCOUNT_ID || "ROT92884781";

    this.state = this.loadState();
    // Sincronización estricta: accountId siempre coincide con el entorno (Real vs Demo)
    this.accountId = this.state.isSimulated ? this.demoAccountId : this.realAccountId;
    this.state.accountId = this.accountId;

    this.positions = this.loadPositions();
    this.trades = this.loadTrades();
  }

  // --- PERSISTENCE ---
  private loadState(): DerivState {
    const defaultState: DerivState = {
      enabled: true,
      isSimulated: true, // Operating on official Deriv Demo DOT account
      accountId: this.accountId,
      appId: this.appId,
      balanceUsdt: 10000.0,
      startingBalanceUsdt: 10000.0,
      totalProfitUsdt: 0.0,
      winsCount: 0,
      lossesCount: 0,
      winRatePct: 0.0,
      defaultStake: 0.5, // $0.50 USD por trade (Ultraconservador: 25+ vidas para balance de $12.78 USD)
      defaultDurationTicks: 15, // 15 ticks (~20-25 seg) para dar tiempo a la racha de desarrollarse
      maxConcurrentTrades: 1, // Ultra-disciplined execution
      dailyProfitTarget: 3.0, // Meta diaria +$3 USD (recupera cuenta a $15.78 USD)
      dailyStopLoss: 2.0, // Stop-loss diario -$2 USD (blindaje estricto de capital)
      dailyRealizedPnl: 0.0,
      lastDailyReset: new Date().toISOString().split("T")[0],
      activeSymbols: ["1HZ75V", "1HZ100V", "1HZ50V", "R_75"],
      lastTradeTime: 0,
      consecutiveLosses: 0,
      maxConsecutiveLosses: 3,
      cooldownMinutes: 30,
      pauseUntil: 0,
      capitalFloorUsdt: 10.0,
      maxStakePctOfBalance: 10
    };

    try {
      if (fs.existsSync(this.stateFile)) {
        const raw = fs.readFileSync(this.stateFile, "utf8");
        return { ...defaultState, ...JSON.parse(raw) };
      }
    } catch (e) {
      console.error("[DERIV] Error loading state:", e);
    }
    return defaultState;
  }

  private saveState(): void {
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2), "utf8");
    } catch (e) {
      console.error("[DERIV] Error saving state:", e);
    }
  }

  private loadPositions(): DerivPosition[] {
    try {
      if (fs.existsSync(this.positionsFile)) {
        return JSON.parse(fs.readFileSync(this.positionsFile, "utf8"));
      }
    } catch (e) {
      console.error("[DERIV] Error loading positions:", e);
    }
    return [];
  }

  private savePositions(): void {
    try {
      fs.writeFileSync(this.positionsFile, JSON.stringify(this.positions, null, 2), "utf8");
    } catch (e) {
      console.error("[DERIV] Error saving positions:", e);
    }
  }

  private loadTrades(): DerivTrade[] {
    try {
      if (fs.existsSync(this.tradesFile)) {
        return JSON.parse(fs.readFileSync(this.tradesFile, "utf8"));
      }
    } catch (e) {
      console.error("[DERIV] Error loading trades:", e);
    }
    return [];
  }

  private saveTrades(): void {
    try {
      fs.writeFileSync(this.tradesFile, JSON.stringify(this.trades, null, 2), "utf8");
    } catch (e) {
      console.error("[DERIV] Error saving trades:", e);
    }
  }

  // --- ENGINE LIFECYCLE ---
  public async start(): Promise<void> {
    if (!this.apiKey) this.apiKey = process.env.DERIV_KEY || "";
    if (!this.appId) this.appId = process.env.DERIV_APP_ID || "";
    this.accountId = this.state.isSimulated ? this.demoAccountId : this.realAccountId;
    this.state.accountId = this.accountId;

    if (!this.apiKey || !this.appId || !this.accountId) {
      console.warn("[DERIV] Credenciales de Deriv incompletas en .env. Motor pausado.");
      return;
    }

    console.log(`[DERIV] Iniciando motor Deriv Sintéticos (Cuenta: ${this.accountId} | ${this.state.isSimulated ? "DEMO" : "REAL"})...`);
    await this.connectWebSocket();

    // Loop de análisis cuantitativo cada 2.5 segundos
    if (!this.analysisInterval) {
      this.analysisInterval = setInterval(() => {
        this.runStrategyAnalysis().catch((err) => {
          console.error("[DERIV] Error en ciclo de análisis:", err);
        });
      }, 2500);
    }
  }

  public stop(): void {
    if (this.pingInterval) clearInterval(this.pingInterval);
    if (this.analysisInterval) clearInterval(this.analysisInterval);
    if (this.ws) {
      try {
        this.ws.close();
      } catch (_) {}
    }
    this.isConnected = false;
    console.log("[DERIV] Motor Deriv detenido.");
  }

  // --- DERIV WEBSOCKET CONNECTION & OTP ---
  private async getOtpUrl(): Promise<string | null> {
    try {
      const res = await fetch(`https://api.derivws.com/trading/v1/options/accounts/${this.accountId}/otp`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Deriv-App-Id": this.appId,
          "Content-Type": "application/json"
        }
      });

      if (!res.ok) {
        const txt = await res.text();
        console.error(`[DERIV] Error solicitando OTP (${res.status}): ${txt}`);
        return null;
      }

      const json = await res.json();
      return json?.data?.url || null;
    } catch (e) {
      console.error("[DERIV] Fallo de red obteniendo OTP:", e);
      return null;
    }
  }

  private async connectWebSocket(): Promise<void> {
    if (this.isConnecting) return;
    this.isConnecting = true;

    try {
      const wsUrl = await this.getOtpUrl();
      if (!wsUrl) {
        console.error("[DERIV] No se pudo obtener URL de WebSocket con OTP. Reintentando en 15s...");
        this.isConnecting = false;
        setTimeout(() => this.connectWebSocket(), 15000);
        return;
      }

      this.ws = new WebSocket(wsUrl);

      this.ws.on("open", () => {
        console.log("[DERIV] WebSocket conectado y autenticado exitosamente.");
        this.isConnected = true;
        this.isConnecting = false;

        // Suscribirse a balance
        this.send({ balance: 1, subscribe: 1 });

        // Suscribirse a los símbolos activos con streaming continuo
        for (const sym of this.state.activeSymbols) {
          this.send({ ticks: sym, subscribe: 1 });
          console.log(`[DERIV] Suscrito a streaming continuo de ticks de ${sym}`);
        }

        // Mantener vivo con ping cada 30s
        if (this.pingInterval) clearInterval(this.pingInterval);
        this.pingInterval = setInterval(() => {
          if (this.isConnected && this.ws?.readyState === WebSocket.OPEN) {
            this.send({ ping: 1 });
          }
        }, 30000);
      });

      this.ws.on("message", (raw: WebSocket.Data) => {
        this.handleMessage(raw);
      });

      this.ws.on("close", (code: number, reason: Buffer) => {
        console.warn(`[DERIV] WebSocket desconectado (${code}): ${reason.toString()}. Reanudando en 5s...`);
        this.isConnected = false;
        this.isConnecting = false;
        setTimeout(() => this.connectWebSocket(), 5000);
      });

      this.ws.on("error", (err: Error) => {
        console.error("[DERIV] Error en WebSocket:", err.message);
      });
    } catch (e) {
      console.error("[DERIV] Excepción al conectar WebSocket:", e);
      this.isConnecting = false;
      setTimeout(() => this.connectWebSocket(), 10000);
    }
  }

  private send(data: any): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  // --- MESSAGE HANDLER ---
  private handleMessage(raw: WebSocket.Data): void {
    try {
      const data = JSON.parse(raw.toString());
      const msgType = data.msg_type;

      if (msgType === "balance") {
        const bal = data.balance?.balance;
        const loginid = data.balance?.loginid;
        if (typeof bal === "number") {
          this.state.balanceUsdt = bal;
          if (loginid) {
            this.state.accountId = loginid;
            this.accountId = loginid;
            this.state.isSimulated = loginid.startsWith("DOT");
          }
          if (!this.state.startingBalanceUsdt || this.state.startingBalanceUsdt <= 0) {
            this.state.startingBalanceUsdt = bal; // Línea base del entorno actual
          }
          this.saveState();
        }
      } else if (msgType === "tick") {
        const tick = data.tick;
        if (tick && tick.symbol && typeof tick.quote === "number") {
          this.storeTick(tick.symbol, tick.quote, tick.epoch || Math.floor(Date.now() / 1000));
        }
      } else if (msgType === "proposal") {
        // Respuesta de cotización para una orden
        if (data.proposal && data.echo_req?.req_id) {
          this.handleProposalResponse(data);
        }
      } else if (msgType === "buy") {
        this.handleBuyResponse(data);
      } else if (msgType === "proposal_open_contract") {
        this.handleContractUpdate(data.proposal_open_contract);
      }
    } catch (e) {
      console.error("[DERIV] Error procesando mensaje WS:", e);
    }
  }

  private lastRadarSave = 0;
  private storeTick(symbol: string, quote: number, epoch: number): void {
    if (!this.tickHistory.has(symbol)) {
      this.tickHistory.set(symbol, []);
    }
    const list = this.tickHistory.get(symbol)!;
    list.push({ quote, epoch });
    if (list.length > 100) {
      list.shift(); // Guardar los últimos 100 ticks
    }

    const now = Date.now();
    if (now - this.lastRadarSave > 1500) {
      this.lastRadarSave = now;
      this.saveRadar();
    }
  }

  public saveRadar(): void {
    try {
      const radar = this.getRadar();
      fs.writeFileSync(this.radarFile, JSON.stringify(radar, null, 2), "utf8");
    } catch {}
  }

  public getRadar() {
    return this.state.activeSymbols.map((sym) => {
      const ticks = this.tickHistory.get(sym) || [];
      const quotes = ticks.map((t) => t.quote);
      const curPrice = quotes.length > 0 ? quotes[quotes.length - 1] : 0;
      const prevPrice = quotes.length > 1 ? quotes[quotes.length - 2] : curPrice;
      const rsi = quotes.length >= 10 ? this.calculateRSI(quotes, 9) : 50;
      const emaFast = quotes.length >= 5 ? this.calculateEMA(quotes, 5) : curPrice;
      const emaSlow = quotes.length >= 15 ? this.calculateEMA(quotes, 15) : curPrice;
      const trend = emaFast >= emaSlow ? "BULLISH" : "BEARISH";
      const changeTickPct = prevPrice > 0 ? ((curPrice - prevPrice) / prevPrice) * 100 : 0;

      let status = "🔍 Analizando Ticks en Vivo";
      let statusBadge = "NEUTRAL";
      let statusColor = "#94a3b8";

      if (rsi < 24) {
        status = "🟢 Sobreventa Extrema: Preparando CALL (Alza)";
        statusBadge = "CALL READY";
        statusColor = "#34d399";
      } else if (rsi > 76) {
        status = "🔴 Sobrecompra Extrema: Preparando PUT (Baja)";
        statusBadge = "PUT READY";
        statusColor = "#f87171";
      } else if (trend === "BULLISH") {
        status = "Tendencia Micro-Alcista (EMA 5 > EMA 15)";
        statusBadge = "MOMENTUM UP";
        statusColor = "#38bdf8";
      } else {
        status = "Tendencia Micro-Bajista (EMA 5 < EMA 15)";
        statusBadge = "MOMENTUM DOWN";
        statusColor = "#fbbf24";
      }

      const friendlyName =
        sym === "1HZ75V"
          ? "Volatility 75 (1s)"
          : sym === "1HZ100V"
          ? "Volatility 100 (1s)"
          : sym === "1HZ50V"
          ? "Volatility 50 (1s)"
          : sym === "R_75"
          ? "Volatility 75 Index"
          : sym;

      return {
        symbol: sym,
        name: friendlyName,
        price: curPrice,
        prevPrice,
        changeTickPct: parseFloat(changeTickPct.toFixed(4)),
        rsi: parseFloat(rsi.toFixed(1)),
        emaFast: parseFloat(emaFast.toFixed(2)),
        emaSlow: parseFloat(emaSlow.toFixed(2)),
        trend,
        ticksBuffered: quotes.length,
        status,
        statusBadge,
        statusColor,
        lastUpdate: Date.now()
      };
    });
  }

  // --- STRATEGY ENGINE & QUANTITATIVE SIGNALS ---
  private async runStrategyAnalysis(): Promise<void> {
    // Sincronización dinámica inmediata con .strategy-controls.json (UI y DB)
    try {
      const ctrlFile = path.resolve(process.cwd(), ".strategy-controls.json");
      if (fs.existsSync(ctrlFile)) {
        const ctrls = JSON.parse(fs.readFileSync(ctrlFile, "utf8"));
        if (ctrls?.strategies && typeof ctrls.strategies.deriv === "boolean") {
          if (this.state.enabled !== ctrls.strategies.deriv) {
            this.state.enabled = ctrls.strategies.deriv;
            this.saveState();
          }
        }
      }
    } catch {}

    if (!this.state.enabled || !this.isConnected) return;

    // Reset diario de PnL
    const today = new Date().toISOString().split("T")[0];
    if (this.state.lastDailyReset !== today) {
      this.state.lastDailyReset = today;
      this.state.dailyRealizedPnl = 0.0;
      this.saveState();
    }

    // Circuit breakers diarios
    if (this.state.dailyRealizedPnl >= this.state.dailyProfitTarget) {
      return; // Meta diaria alcanzada
    }
    if (this.state.dailyRealizedPnl <= -this.state.dailyStopLoss) {
      return; // Stop loss diario alcanzado
    }

    // BLINDAJE 1: Pausa de enfriamiento tras racha de pérdidas seguidas
    if (Date.now() < (this.state.pauseUntil || 0)) {
      return;
    }

    // En REAL no se opera hasta conocer el balance verdadero de la cuenta
    if (!this.state.isSimulated && this.state.balanceUsdt <= 0) {
      return;
    }

    // BLINDAJE 2: Piso de capital absoluto (solo aplica en cuenta REAL)
    if (!this.state.isSimulated && this.state.balanceUsdt > 0 &&
        this.state.balanceUsdt - this.state.defaultStake < this.state.capitalFloorUsdt) {
      this.triggerCapitalFloor();
      return;
    }

    // BLINDAJE 3: El stake nunca puede superar el % máximo del balance actual
    if (this.state.balanceUsdt > 0) {
      const maxStake = (this.state.balanceUsdt * this.state.maxStakePctOfBalance) / 100;
      if (this.state.defaultStake > maxStake) {
        return; // Stake demasiado grande para el balance actual → no opera
      }
    }

    // Máximo de trades concurrentes (disciplina estricta)
    if (this.positions.length >= this.state.maxConcurrentTrades) {
      return;
    }

    // Cooldown global anti-sobreoperativa: mínimo 90 segundos de descanso entre operaciones
    if (Date.now() - this.state.lastTradeTime < 90000) {
      return;
    }

    // Analizar cada símbolo
    for (const symbol of this.state.activeSymbols) {
      if (this.positions.length >= this.state.maxConcurrentTrades) break;

      const cooldown = this.symbolCooldowns.get(symbol) || 0;
      if (Date.now() < cooldown) continue;

      const ticks = this.tickHistory.get(symbol);
      if (!ticks || ticks.length < 30) continue; // Necesitamos al menos 30 ticks para cálculo confiable

      const signal = this.calculateSignal(symbol, ticks);
      if (signal) {
        console.log(`[DERIV] 🎯 Señal detectada en ${symbol}: ${signal.type} | Razón: ${signal.rationale}`);
        this.symbolCooldowns.set(symbol, Date.now() + 180000); // 3 min de descanso en el mismo símbolo
        await this.executeTrade(symbol, signal.type, signal.rationale);
        break; // Una operación a la vez
      }
    }
  }

  private calculateSignal(symbol: string, ticks: TickData[]): { type: "CALL" | "PUT"; rationale: string } | null {
    const quotes = ticks.map((t) => t.quote);
    const n = quotes.length;
    if (n < 35) return null;

    const currentPrice = quotes[n - 1];
    const prevPrice = quotes[n - 2];
    const prev2Price = quotes[n - 3];

    // Oscilador de Momentum RSI (período 12 ticks)
    const rsi = this.calculateRSI(quotes, 12);

    // Medias Móviles Institucionales: Rápida (EMA 10) vs Estructura de Tendencia (EMA 30)
    const emaFast = this.calculateEMA(quotes, 10);
    const emaSlow = this.calculateEMA(quotes, 30);
    const isUptrend = emaFast > emaSlow && currentPrice >= emaSlow;
    const isDowntrend = emaFast < emaSlow && currentPrice <= emaSlow;

    // === ESTRATEGIA 1: RACHA ALCISTA - REBOTE EN SOPORTE (PULLBACK SNIPER) ===
    // En tendencia alcista consolidada: el precio retrocedió a la EMA rápida para tomar aire y reanuda la subida.
    if (isUptrend && rsi >= 44 && rsi <= 62) {
      const touchedFast = quotes.slice(n - 4, n).some((p) => p <= emaFast * 1.0005);
      const tickGreen = currentPrice > prevPrice; // Giro alcista confirmado en el último tick
      if (touchedFast && tickGreen) {
        return {
          type: "CALL",
          rationale: `🚀 Racha Alcista: Rebote confirmado sobre EMA(10) con RSI saludable (${rsi.toFixed(1)}) en ${symbol}`
        };
      }
    }

    // === ESTRATEGIA 2: RACHA DE IMPULSO ALCISTA CONTINUO (3 TICKS VERDES + TENDENCIA) ===
    // Racha sostenida con aceleración limpia: 3 ticks consecutivos al alza en plena tendencia sin agotamiento.
    if (isUptrend && currentPrice > prevPrice && prevPrice > prev2Price && currentPrice > emaFast) {
      if (rsi >= 54 && rsi <= 72) {
        return {
          type: "CALL",
          rationale: `🔥 Racha de Impulso: 3 ticks verdes consecutivos sobre EMA 10/30 con RSI en aceleración (${rsi.toFixed(1)}) en ${symbol}`
        };
      }
    }

    // === ESTRATEGIA 3: PISO EXTREMO DE SOBREVENTA (REVERSIÓN DESDE EL FONDO) ===
    // Si el precio cayó a sobreventa extrema y da el primer tick verde fuerte superando la EMA rápida.
    if (rsi < 20 && currentPrice > prevPrice && currentPrice > emaFast) {
      return {
        type: "CALL",
        rationale: `🎯 Piso Extremo: Rebote desde sobreventa crítica (RSI ${rsi.toFixed(1)} < 20) en ${symbol}`
      };
    }

    // === ESTRATEGIA 4: TENDENCIA BAJISTA CLARA (SOLO SI EL MERCADO ESTÁ EN CAÍDA FUERTE Y CONTINUA) ===
    // Prohibido meter PUTs durante subidas. Solo se permite PUT si la caída es absoluta e indiscutible.
    if (isDowntrend && currentPrice < prevPrice && prevPrice < prev2Price && currentPrice < emaFast) {
      if (rsi >= 28 && rsi <= 44) {
        return {
          type: "PUT",
          rationale: `📉 Cascada Bajista: 3 ticks rojos consecutivos bajo EMA 10/30 con RSI (${rsi.toFixed(1)}) en ${symbol}`
        };
      }
    }

    return null;
  }

  private calculateRSI(prices: number[], period: number): number {
    if (prices.length <= period) return 50;

    let gains = 0;
    let losses = 0;

    for (let i = prices.length - period; i < prices.length; i++) {
      const diff = prices[i] - prices[i - 1];
      if (diff >= 0) gains += diff;
      else losses -= diff;
    }

    if (losses === 0) return 100;
    const rs = gains / losses;
    return 100 - (100 / (1 + rs));
  }

  private calculateEMA(prices: number[], period: number): number {
    if (prices.length === 0) return 0;
    const k = 2 / (period + 1);
    let ema = prices[0];
    for (let i = 1; i < prices.length; i++) {
      ema = prices[i] * k + ema * (1 - k);
    }
    return ema;
  }

  // --- TRADE EXECUTION ---
  private pendingProposals: Map<number, { symbol: string; contractType: "CALL" | "PUT"; rationale: string }> = new Map();
  private reqIdCounter = 100;

  private async executeTrade(symbol: string, contractType: "CALL" | "PUT", rationale: string): Promise<void> {
    if (!this.isConnected || !this.ws) return;

    const reqId = ++this.reqIdCounter;
    this.pendingProposals.set(reqId, { symbol, contractType, rationale });

    // Solicitar propuesta oficial a Deriv
    this.send({
      proposal: 1,
      amount: this.state.defaultStake,
      basis: "stake",
      contract_type: contractType,
      currency: "USD",
      duration: this.state.defaultDurationTicks,
      duration_unit: "t",
      underlying_symbol: symbol,
      req_id: reqId
    });
  }

  private handleProposalResponse(data: any): void {
    const reqId = data.echo_req?.req_id;
    const meta = this.pendingProposals.get(reqId);
    if (!meta) return;
    this.pendingProposals.delete(reqId);

    const proposal = data.proposal;
    if (!proposal || !proposal.id) {
      console.warn(`[DERIV] No se pudo obtener propuesta válida para ${meta.symbol}:`, data.error?.message);
      return;
    }

    console.log(`[DERIV] Comprando contrato ${meta.contractType} en ${meta.symbol} (Stake: $${proposal.ask_price}, Payout: $${proposal.payout})...`);

    // Ejecutar compra del contrato
    this.send({
      buy: proposal.id,
      price: proposal.ask_price,
      subscribe: 1,
      passthrough: {
        symbol: meta.symbol,
        contractType: meta.contractType,
        rationale: meta.rationale,
        expectedPayout: proposal.payout
      }
    });
  }

  private handleBuyResponse(data: any): void {
    const buy = data.buy;
    if (!buy || !buy.contract_id) {
      console.error("[DERIV] Error al comprar contrato:", data.error?.message);
      return;
    }

    const pt = data.echo_req?.passthrough || {};
    const contractId = String(buy.contract_id);

    const pos: DerivPosition = {
      contractId,
      symbol: pt.symbol || "R_75",
      contractType: pt.contractType || "CALL",
      stake: buy.buy_price || this.state.defaultStake,
      entrySpot: buy.start_time || 0,
      entryTime: Date.now(),
      duration: this.state.defaultDurationTicks,
      durationUnit: "ticks",
      payoutExpected: pt.expectedPayout || buy.payout || 0,
      status: "open",
      currentProfit: 0,
      rationale: pt.rationale || "Algoritmo Cuantitativo de Momentum"
    };

    this.positions.push(pos);
    this.savePositions();
    this.state.lastTradeTime = Date.now();
    this.saveState();

    // Notificar apertura a Telegram
    const netDayPnl = this.state.dailyRealizedPnl;
    const pnlText = netDayPnl >= 0 ? `🟢 GANANDO +$${netDayPnl.toFixed(2)} USD` : `🔴 -$${Math.abs(netDayPnl).toFixed(2)} USD`;

    const msg =
      `🎰 <b>DERIV SINTÉTICOS: OPERACIÓN EN EJECUCIÓN (~10s)</b>\n\n` +
      `• <b>Contrato:</b> ${pos.contractType === "CALL" ? "🟢 ALZA (CALL)" : "🔴 BAJA (PUT)"}\n` +
      `• <b>Índice:</b> <code>${pos.symbol}</code>\n` +
      `• <b>Monto Arriesgado:</b> $${pos.stake.toFixed(2)} USD\n` +
      `• <b>Ganancia si acierta:</b> +$${(pos.payoutExpected - pos.stake).toFixed(2)} USD\n` +
      `• <b>Estrategia:</b> ${pos.rationale}\n\n` +
      `📊 <b>Estado de tu Cuenta:</b> ${pnlText}\n` +
      `💼 <b>Balance ${this.state.isSimulated ? "Demo" : "🔥 REAL"}:</b> $${this.state.balanceUsdt.toFixed(2)} USD (${this.state.winsCount}W / ${this.state.lossesCount}L)`;

    this.notifier.send(msg).catch(() => {});

    // Suscribir a actualizaciones del contrato
    this.send({
      proposal_open_contract: 1,
      contract_id: buy.contract_id,
      subscribe: 1
    });
  }

  private handleContractUpdate(poc: any): void {
    if (!poc || !poc.contract_id) return;
    const contractId = String(poc.contract_id);

    const posIdx = this.positions.findIndex((p) => p.contractId === contractId);
    if (posIdx === -1) return;

    const pos = this.positions[posIdx];
    pos.currentProfit = poc.profit || 0;

    if (poc.is_sold === 1) {
      // Contrato finalizado
      const isWon = poc.status === "won";
      const netProfit = parseFloat(String(poc.profit || 0));
      const payout = parseFloat(String(poc.payout || 0));

      const trade: DerivTrade = {
        contractId: pos.contractId,
        symbol: pos.symbol,
        contractType: pos.contractType,
        stake: pos.stake,
        payout,
        profit: netProfit,
        entrySpot: poc.entry_tick || poc.barrier || 0,
        exitSpot: poc.exit_tick || 0,
        entryTime: pos.entryTime,
        exitTime: Date.now(),
        durationSec: Math.round((Date.now() - pos.entryTime) / 1000),
        status: isWon ? "won" : "lost",
        rationale: pos.rationale
      };

      // Remover posición abierta y guardar trade histórico
      this.positions.splice(posIdx, 1);
      this.trades.unshift(trade);
      if (this.trades.length > 200) this.trades.pop();

      // Actualizar métricas acumuladas
      if (isWon) {
        this.state.winsCount++;
        this.state.consecutiveLosses = 0;
      } else {
        this.state.lossesCount++;
        this.state.consecutiveLosses = (this.state.consecutiveLosses || 0) + 1;
        if (this.state.consecutiveLosses >= this.state.maxConsecutiveLosses) {
          this.state.pauseUntil = Date.now() + this.state.cooldownMinutes * 60000;
          this.state.consecutiveLosses = 0;
          this.notifier.send(
            `🧊 <b>DERIV: PAUSA DE ENFRIAMIENTO ACTIVADA</b>\n\n` +
            `• Se registraron <b>${this.state.maxConsecutiveLosses} pérdidas seguidas</b>.\n` +
            `• El mercado está errático: el bot descansa <b>${this.state.cooldownMinutes} minutos</b> para no perseguir pérdidas.\n` +
            `• Reanuda automáticamente a las ${new Date(this.state.pauseUntil).toLocaleTimeString("es-CO")}.`
          ).catch(() => {});
        }
      }
      this.state.totalProfitUsdt += netProfit;
      this.state.dailyRealizedPnl += netProfit;
      const totalTrades = this.state.winsCount + this.state.lossesCount;
      this.state.winRatePct = totalTrades > 0 ? (this.state.winsCount / totalTrades) * 100 : 0;

      this.savePositions();
      this.saveTrades();
      this.saveState();

      // Notificación inmediata a Telegram del resultado
      const icon = isWon ? "🏆" : "⚠️";
      const outcomeText = isWon ? "¡OPERACIÓN GANADA!" : "OPERACIÓN CERRADA EN PÉRDIDA";
      const profitFormatted = isWon
        ? `+$${netProfit.toFixed(2)} USD`
        : `-$${Math.abs(netProfit).toFixed(2)} USD`;
      const netDayPnl = this.state.dailyRealizedPnl;
      const pnlText = netDayPnl >= 0 ? `🟢 GANANDO +$${netDayPnl.toFixed(2)} USD` : `🔴 -$${Math.abs(netDayPnl).toFixed(2)} USD`;

      const closeMsg =
        `${icon} <b>DERIV SINTÉTICOS: ${outcomeText}</b>\n\n` +
        `• <b>Índice:</b> <code>${trade.symbol}</code> (${trade.contractType})\n` +
        `• <b>Resultado del Trade:</b> <b>${profitFormatted}</b> (Duración: ${trade.durationSec}s)\n` +
        `• <b>Balance ${this.state.isSimulated ? "Demo" : "🔥 REAL"}:</b> <b>$${this.state.balanceUsdt.toFixed(2)} USD</b> (Inició en $${this.state.startingBalanceUsdt.toFixed(2)})\n` +
        `• <b>Estado General:</b> <b>${pnlText}</b>\n` +
        `• <b>Récord Global:</b> ${this.state.winRatePct.toFixed(1)}% (${this.state.winsCount} Ganadas / ${this.state.lossesCount} Perdidas)`;

      this.notifier.send(closeMsg).catch(() => {});
    } else {
      this.savePositions();
    }
  }

  // --- TELEMETRY & CONTROLS ---
  public getOperationalStatus(): { status: "ACTIVE" | "PAUSED" | "STOP_LOSS" | "PROFIT_TARGET" | "COOLDOWN" | "CAPITAL_FLOOR" | "DISCONNECTED"; message: string } {
    if (!this.isConnected) {
      return { status: "DISCONNECTED", message: "🔴 Desconectado de Deriv WebSocket (reconectando...)" };
    }
    if (!this.state.enabled) {
      return { status: "PAUSED", message: "⏸️ Pausado manualmente. Envía /deriv_reanudar para activar." };
    }
    if (this.state.dailyRealizedPnl >= this.state.dailyProfitTarget) {
      return { status: "PROFIT_TARGET", message: `🎉 Meta diaria alcanzada (+$${this.state.dailyRealizedPnl.toFixed(2)} USD). Modo reposo de protección.` };
    }
    if (this.state.dailyRealizedPnl <= -this.state.dailyStopLoss) {
      return { status: "STOP_LOSS", message: `🛑 Stop loss diario alcanzado (-$${Math.abs(this.state.dailyRealizedPnl).toFixed(2)} USD vs límite -$${this.state.dailyStopLoss.toFixed(2)} USD). Envía /deriv_reanudar para desbloquear nueva sesión.` };
    }
    if (Date.now() < (this.state.pauseUntil || 0)) {
      const restMin = Math.max(1, Math.ceil(((this.state.pauseUntil || 0) - Date.now()) / 60000));
      return { status: "COOLDOWN", message: `⏳ Enfriamiento por 3 pérdidas consecutivas (restan ~${restMin} min). Envía /deriv_reanudar para reanudar de inmediato.` };
    }
    if (!this.state.isSimulated && this.state.balanceUsdt > 0 && this.state.balanceUsdt - this.state.defaultStake < this.state.capitalFloorUsdt) {
      return { status: "CAPITAL_FLOOR", message: `🛡️ Piso de capital activo ($${this.state.balanceUsdt.toFixed(2)} USD <= $${this.state.capitalFloorUsdt.toFixed(2)} USD).` };
    }
    if (this.positions.length >= this.state.maxConcurrentTrades) {
      return { status: "ACTIVE", message: `📊 Trade en ejecución (${this.positions[0]?.symbol} ${this.positions[0]?.contractType}). Esperando resultado.` };
    }
    return { status: "ACTIVE", message: `🟢 Vigilando ticks 24/7 (Estrategia: Rebote Pullback EMA10 & Racha Impulso 15t)` };
  }

  public getTelemetry() {
    const op = this.getOperationalStatus();
    return {
      connected: this.isConnected,
      state: this.state,
      operationalStatus: op,
      radar: this.getRadar(),
      openPositions: this.positions,
      recentTrades: this.trades.slice(0, 20),
      metrics: {
        balance: this.state.balanceUsdt,
        totalProfit: this.state.totalProfitUsdt,
        dailyProfit: this.state.dailyRealizedPnl,
        winRate: this.state.winRatePct,
        totalTrades: this.state.winsCount + this.state.lossesCount,
        wins: this.state.winsCount,
        losses: this.state.lossesCount,
        openPositionsCount: this.positions.length
      }
    };
  }

  public isEnabled(): boolean {
    return this.state.enabled;
  }

  public getState(): DerivState {
    return { ...this.state };
  }

  public setEnabled(enabled: boolean): void {
    this.state.enabled = enabled;
    if (enabled) {
      this.state.pauseUntil = 0;
      this.state.consecutiveLosses = 0;
      if (this.state.dailyRealizedPnl <= -this.state.dailyStopLoss) {
        this.state.dailyRealizedPnl = 0;
      }
    }
    this.saveState();
  }

  public resetDailyPnl(): void {
    this.state.dailyRealizedPnl = 0;
    this.state.pauseUntil = 0;
    this.state.consecutiveLosses = 0;
    this.saveState();
  }

  public setStake(stake: number): void {
    if (stake >= 0.35 && stake <= 100) {
      this.state.defaultStake = stake;
      this.saveState();
    }
  }

  public setDailyProfitTarget(target: number): void {
    if (target > 0) {
      this.state.dailyProfitTarget = target;
      this.saveState();
    }
  }

  public setDailyStopLoss(stopLoss: number): void {
    if (stopLoss > 0) {
      this.state.dailyStopLoss = stopLoss;
      this.saveState();
    }
  }

  public isRealEnvironment(): boolean {
    return !this.state.isSimulated;
  }

  private triggerCapitalFloor(): void {
    if (!this.state.enabled) return;
    this.state.enabled = false;
    this.saveState();
    console.warn(`[DERIV] 🛑 PISO DE CAPITAL alcanzado ($${this.state.balanceUsdt.toFixed(2)}). Motor APAGADO.`);
    this.notifier.send(
      `🛑 <b>DERIV: PISO DE CAPITAL ALCANZADO — BOT APAGADO</b>\n\n` +
      `• Balance real: <b>$${this.state.balanceUsdt.toFixed(2)} USD</b>\n` +
      `• Piso protegido: <b>$${this.state.capitalFloorUsdt.toFixed(2)} USD</b>\n\n` +
      `El bot NO volverá a operar solo. Revisa la situación y reactívalo manualmente con /deriv_reanudar si lo deseas.`
    ).catch(() => {});
  }

  public async setEnvironment(isReal: boolean): Promise<{ success: boolean; isSimulated: boolean; accountId: string }> {
    if (this.positions.length > 0) {
      console.warn("[DERIV] No se puede cambiar de entorno con contratos abiertos.");
      return { success: false, isSimulated: this.state.isSimulated, accountId: this.state.accountId };
    }
    const changed = this.state.isSimulated !== !isReal;
    if (changed) {
      // Estadísticas separadas por entorno: lo de la demo NO contamina la cuenta real
      this.state.dailyRealizedPnl = 0;
      this.state.totalProfitUsdt = 0;
      this.state.winsCount = 0;
      this.state.lossesCount = 0;
      this.state.winRatePct = 0;
      this.state.consecutiveLosses = 0;
      this.state.pauseUntil = 0;
      this.state.startingBalanceUsdt = 0; // se fija con el primer balance recibido
      this.state.balanceUsdt = 0;
    }
    this.state.isSimulated = !isReal;
    this.accountId = isReal ? this.realAccountId : this.demoAccountId;
    this.state.accountId = this.accountId;
    this.saveState();

    console.log(`[DERIV] Entorno cambiado a: ${isReal ? "🔥 REAL (" + this.accountId + ")" : "🧪 DEMO (" + this.accountId + ")"}`);

    // Reconectar WebSocket al nuevo entorno
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch (_) {}
      this.ws = null;
    }
    this.isConnected = false;
    this.isConnecting = false;
    await this.connectWebSocket();

    await this.notifier.send(
      `🎰 <b>DERIV ENTORNO CAMBIADO</b> 🔄\n\n` +
      `• <b>Nuevo Modo:</b> ${isReal ? "🔥 <b>CUENTA REAL (DINERO REAL)</b>" : "🧪 <b>CUENTA DEMO OFICIAL</b>"}\n` +
      `• <b>Account ID:</b> <code>${this.accountId}</code>\n` +
      `• <b>Stake Actual:</b> $${this.state.defaultStake.toFixed(2)} USD\n` +
      `• <b>Meta Diaria:</b> +$${this.state.dailyProfitTarget.toFixed(2)} USD\n` +
      `• <b>Stop-Loss Diario:</b> -$${this.state.dailyStopLoss.toFixed(2)} USD\n\n` +
      `👉 Consulta estado: /deriv`
    );

    return {
      success: true,
      isSimulated: this.state.isSimulated,
      accountId: this.state.accountId
    };
  }
}

// Instancia singleton compartida
export const derivEngine = new DerivEngine();
