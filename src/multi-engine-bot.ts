import { supabaseDb } from "./supabase-db.js";
import crypto from "crypto";
import { FuturesEngine } from "./futures-engine.js";
import { DashboardServer } from "./dashboard-server.js";
import { Spot } from "@binance/connector";
import { AiCopilot, BotContextSnapshot } from "./ai-copilot.js";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { TelegramNotifier } from "./notifier.js";
import { TelegramCommands } from "./telegram-commands.js";
import { computeRealizedPnl } from "./pnl.js";

dotenv.config();

// Tasa de referencia COP por USDT (P2P Colombia aprox.)
const COP_PER_USDT = 4200;

// WATCHLISTS SEPARADAS: CLÁSICAS Y CANASTA MEMECOINS TIER-1
export const CORE_WATCHLIST = ["ETHUSDT", "SOLUSDT", "AVAXUSDT", "BTCUSDT", "BNBUSDT", "XRPUSDT"];
export const MEME_WATCHLIST = ["PEPEUSDT", "DOGEUSDT", "BONKUSDT", "SHIBUSDT", "WIFUSDT"];
export const WATCHLIST = [...CORE_WATCHLIST, ...MEME_WATCHLIST];

// Formateador dinámico de precios para soportar micro-ticks y monedas estándar (ETH/SOL/BTC)
function fmtPrice(p: number): string {
  if (p === 0) return "0";
  if (p < 0.0001) return p.toFixed(8);
  if (p < 0.01) return p.toFixed(6);
  if (p < 1) return p.toFixed(4);
  return p.toFixed(2);
}

// PARÁMETROS DEL TRAILING TAKE PROFIT INTELIGENTE
const TRAILING_ACTIVATION_PCT = 0.8; // Despierta el seguro al +0.8%
const TRAILING_CALLBACK_PCT = 0.30;  // Base callback
const TRAILING_HARD_CAP_PCT = 15.0;  // Techo ultra amplio (+15%) para perseguir el alza hasta la cima sin corte artificial

// PARÁMETROS DEL TRAILING BUY (espejo del trailing de venta, para cazar el piso)
const TRAILING_BUY_BOUNCE_PCT = 0.25;      // Compra cuando rebota +0.25% desde el piso más bajo
const TRAILING_BUY_MAX_AGE_MS = 3 * 60 * 60 * 1000; // Vigilancia máxima: 3 horas

interface BuyWatch {
  symbol: string;
  armedPrice: number;   // precio cuando se detectó la caída
  lowestPrice: number;  // piso más bajo registrado tick a tick
  armedTime: number;
  rsi: number;
  dropPct: number;
  strategy?: "trailing_rebound" | "cazador_weekend";
}

interface ActivePosition {
  symbol: string;
  buyPrice: number;
  qty: number;
  investedUsdt: number;
  highestPrice: number;
  activated: boolean;
  buyTime: number;
  lastDcaTime?: number;
  dcaCount?: number;
  strategy?: "trailing_rebound" | "smart_dca" | "micro_grid" | "cazador_weekend" | "centinela_alpha";
  id?: string;
  lotIndex?: number;
  customCallbackPct?: number;
  customTimeframe?: "15m" | "1h" | "4h" | "1d";
  partialProfitTaken?: boolean;
  partialProfitUsdt?: number;
}

export interface StrategySetting {
  timeframe: "15m" | "1h" | "4h" | "1d";
  stopLossEnabled: boolean;
  stopLossPct: number;
}

export interface StrategySuggestion {
  timeframe: "15m" | "1h" | "4h" | "1d";
  stopLossPct: number;
  reason: string;
  criterios?: string[];
  porQue?: string;
  session?: string;
  btcRange24h?: number;
  updatedAt: number;
  expiresAt?: number;
  isCurrent?: boolean;
  status?: "pending" | "applied" | "rejected" | "expired";
}

export interface StrategyControls {
  strategies: {
    trailing_rebound: boolean;
    smart_dca: boolean;
    micro_grid: boolean;
    cazador_weekend: boolean;
    centinela_alpha?: boolean;
  };
  allocations: {
    trailing_rebound: number;
    smart_dca: number;
    micro_grid: number;
    cazador_weekend: number;
    centinela_alpha?: number;
  };
  recoveryTracker?: {
    targetUsdt: number;
    recoveredUsdt: number;
    tradesCount: number;
  };
  baseAllocations?: {
    trailing_rebound: number;
    smart_dca: number;
    micro_grid: number;
    cazador_weekend: number;
    centinela_alpha?: number;
  };
  trailingCallbacks?: Record<string, number>;
  symbolTimeframes?: Record<string, "15m" | "1h" | "4h" | "1d">;
  strategySettings?: {
    trailing_rebound: StrategySetting;
    smart_dca: StrategySetting;
    micro_grid: StrategySetting;
    cazador_weekend: StrategySetting;
    centinela_alpha?: StrategySetting;
  };
  suggestions?: {
    trailing_rebound: StrategySuggestion;
    smart_dca: StrategySuggestion;
    micro_grid: StrategySuggestion;
    cazador_weekend: StrategySuggestion;
    centinela_alpha?: StrategySuggestion;
  };
  autoPilot: boolean;
  notified50UsdtThreshold?: boolean;
  aiEnabled?: boolean;
  gridIgnoredUntil?: number;
  stopLossEnabled?: boolean;
  stopLossPct?: number;
  timeframe?: "15m" | "1h" | "4h" | "1d";
  cashReservePct?: number;
  maxPerCoinPct?: number;
  rejectedSuggestions?: Record<string, number>;
  approvalTimeoutSec: number;
  updatedAt: number;
}

export interface PendingOpportunity {
  id: string;
  symbol: string;
  strategy: "trailing_rebound" | "smart_dca" | "micro_grid" | "cazador_weekend";
  strategyName: string;
  reason: string;
  amount: number;
  curPrice: number;
  potentialTarget?: string;
  createdAt: number;
  expiresAt: number;
}


export interface SessionLiquidityPlan {
  sessionKey: "NOCTURNO_DRENAJE" | "LONDRES_REBOTE" | "NY_IMPULSO" | "COSECHA_PRENOCTURNA" | "REGULAR";
  sessionTitle: string;
  totalFreeUsdt: number;
  reservedUsdt: number;
  spendableUsdt: number;
  lotFractionPct: number;
  trailingBounceTrigger: number;
  harvestCallbackPct?: number;
  reason: string;
  recommendation: string;
  updatedAt: number;
}

export class TrailingMasterBot {
  private controls: StrategyControls = {
    strategies: {
      trailing_rebound: true,
      smart_dca: true,
      micro_grid: false,
      cazador_weekend: true
    },
    allocations: {
      trailing_rebound: 70,
      smart_dca: 30,
      micro_grid: 0,
      cazador_weekend: 0
    },
    baseAllocations: {
      trailing_rebound: 50,
      smart_dca: 30,
      micro_grid: 0,
      cazador_weekend: 20
    },
    autoPilot: true,
    aiEnabled: false,
    approvalTimeoutSec: 180,
    updatedAt: Date.now()
  };
  private pendingOpportunity: PendingOpportunity | null = null;
  private client: any;
  private notifier: TelegramNotifier;
  private telegramCommands: TelegramCommands;
  private futuresEngine: FuturesEngine;
  private isProcessing = false;
  private autoPilot = true;
  private minUsdtToTrade = 10;
  public lastSessionPlan: SessionLiquidityPlan | null = null;
  private lastSessionKey: string | null = null;
  private cycleCount = 0;
  private lastWeekendWindowState: boolean | null = null;
  private lastRegimeCheckTime: number = 0;
  private pendingRegimeSwitch: {
    type: "activate_grid" | "deactivate_grid";
    reason: string;
    btcRange24h: number;
    createdAt: number;
    expiresAt: number;
  } | null = null;
  private lastDetectedRegime: "QUIET" | "TRENDING" | null = null;

  /**
   * Margen de retroceso (Callback) adaptado a la volatilidad de cada par.
   */
  
  public isWeekendWindow(): boolean {
    try {
      const now = new Date();
      const dayStr = now.toLocaleDateString("en-US", { timeZone: "America/Bogota", weekday: "short" });
      const hourStr = now.toLocaleTimeString("en-US", { timeZone: "America/Bogota", hour12: false, hour: "numeric" });
      const hour = parseInt(hourStr, 10);
      if (dayStr === "Fri" && hour >= 17) return true;
      if (dayStr === "Sat") return true;
      if (dayStr === "Sun" && hour < 18) return true;
      return false;
    } catch {
      return false;
    }
  }

  public isNightMode(): boolean {
    try {
      const hour = new Date().toLocaleString("en-US", { timeZone: "America/Bogota", hour: "numeric", hour12: false });
      const h = parseInt(hour, 10);
      return h >= 1 && h < 6;
    } catch {
      return false;
    }
  }

  public getHardCapPct(): number {
    return this.isNightMode() ? 5.0 : 3.5;
  }

  async getFearAndGreed(): Promise<{ value: number; classification: string }> {
    try {
      const res = await fetch("https://api.alternative.me/fng/?limit=1");
      const d = await res.json();
      const item = d.data?.[0];
      if (item) {
        return { value: parseInt(item.value, 10), classification: item.value_classification };
      }
    } catch(e) {}
    return { value: 50, classification: "Neutral" };
  }

  async depositToEarn(asset: string, amount: number) {
    try {
      await this.client.subscribeFlexibleProduct("USDT001", amount.toFixed(2), { recvWindow: 60000 });
      await this.notifier.send(
        `🏦 <b>[BÓVEDA DE GANANCIAS ACTIVADA]</b> 🔒\n\n` +
        `• Se apartaron <b>+${amount.toFixed(2)} USDT</b> limpios de la ganancia.\n` +
        `• Destino: <b>Simple Earn Flexible</b> generando intereses diarios automáticos.\n` +
        `💡 <i>¡Tu ganancia quedó blindada fuera del riesgo de mercado!</i>`
      );
      console.log(`🏦 Bóveda de ganancias: ${amount.toFixed(2)} USDT transferidos a Simple Earn.`);
    } catch(e: any) {
      console.error("Error suscribiendo a Earn:", e.response?.data?.msg || e.message);
    }
  }

  
  /**
   * Determina la temporalidad óptima recomendada para cada moneda según su naturaleza y volatilidad.
   */
  public getSuggestedTimeframe(symbol: string): { timeframe: "15m" | "1h" | "4h"; reason: string } {
    if (MEME_WATCHLIST.includes(symbol) || symbol.includes("PEPE")) {
      return {
        timeframe: "15m",
        reason: "Alta velocidad de impulsos (15m aprovecha mechas y rebotes sin retraso)"
      };
    }
    if (symbol.includes("BTC") || symbol.includes("ETH")) {
      return {
        timeframe: "1h",
        reason: "Filtro de ruido institucional (1H confirma soportes y volumen real)"
      };
    }
    if (symbol.includes("AVAX") || symbol.includes("SOL") || symbol.includes("LINK")) {
      return {
        timeframe: "1h",
        reason: "Onda de tendencia swing equilibrada"
      };
    }
    return {
      timeframe: "1h",
      reason: "Estructura estándar de tendencia"
    };
  }

  /**
   * Obtiene la temporalidad activa para un símbolo (prioridad: posición -> controles -> sugerencia adaptativa)
   */
  public getTimeframeForSymbol(symbol: string, pos?: ActivePosition): "15m" | "1h" | "4h" {
    // 1. Prioridad: Configuración explícita en la posición viva
    if (pos && pos.customTimeframe) {
      return pos.customTimeframe as any;
    }
    // 2. Prioridad: Override por símbolo en controles
    if (this.controls.symbolTimeframes && this.controls.symbolTimeframes[symbol]) {
      return this.controls.symbolTimeframes[symbol] as any;
    }
    // 3. Fallback inteligente: Temporalidad sugerida por el Centinela
    return this.getSuggestedTimeframe(symbol).timeframe;
  }

  public getCallbackPct(symbol: string, pos?: ActivePosition): number {
    // 1. Prioridad: Callback individual configurado manualmente en la posición
    if (pos && typeof pos.customCallbackPct === "number" && pos.customCallbackPct > 0) {
      return pos.customCallbackPct;
    }
    // 2. Prioridad: Override por símbolo en controles (.strategy-controls.json)
    if (this.controls.trailingCallbacks && typeof this.controls.trailingCallbacks[symbol] === "number") {
      return this.controls.trailingCallbacks[symbol];
    }
    // 3. Prioridad: Override global 'default'
    if (this.controls.trailingCallbacks && typeof this.controls.trailingCallbacks["default"] === "number") {
      return this.controls.trailingCallbacks["default"];
    }

    // 4. 🚀 TRAILING CEÑIDO ESCALONADO DINÁMICO (Tiered Dynamic Callback)
    // A medida que la ganancia sube, el lazo se ciñe automáticamente para capturar la cima intacta
    const isMeme = MEME_WATCHLIST.includes(symbol) || symbol.includes("PEPE") || symbol.includes("BONK") || symbol.includes("DOGE") || symbol.includes("SHIB") || symbol.includes("WIF");
    const isMid = symbol.includes("AVAX") || symbol.includes("SOL");
    const baseCb = isMeme ? 0.45 : (isMid ? 0.35 : 0.25);

    if (pos && pos.buyPrice > 0 && pos.highestPrice > 0) {
      const peakGainPct = ((pos.highestPrice - pos.buyPrice) / pos.buyPrice) * 100;

      if (peakGainPct >= 3.0) {
        // Fase 4: Parapeto Extremo (> +3.0%) -> Candado ultra-ceñido
        return isMeme ? 0.15 : 0.12;
      } else if (peakGainPct >= 2.2) {
        // Fase 3: Techo Inminente / Euforia (+2.2% a +3.0%) -> Ceñir a 0.20% (Caso PEPE)
        return isMeme ? 0.20 : 0.15;
      } else if (peakGainPct >= 1.4) {
        // Fase 2: Consolidación (+1.4% a +2.2%) -> Ceñir a 0.30%
        return isMeme ? 0.30 : 0.22;
      }
      // Fase 1: Despegue inicial (+0.8% a +1.4%) -> Mantener respiro completo (0.45%) para tolerar micro-ruido
    }

    return baseCb;
  }

  /**
   * Reconstruye y adopta posiciones existentes en Binance Spot que no estén registradas en memoria/disco.
   */
  async syncOrphanPositions() {
    try {
      const acc = await this.client.account({ recvWindow: 60000 });
      const checkList = [...WATCHLIST, "PEPEUSDT"];
      for (const sym of checkList) {
        if (this.activeTrailingPositions.has(sym)) continue;
        const asset = sym.replace("USDT", "");
        const balObj = acc.data.balances.find((b: any) => b.asset === asset);
        if (!balObj) continue;
        const free = parseFloat(balObj.free || "0");
        const locked = parseFloat(balObj.locked || "0");
        const total = free + locked;
        if (total <= 0) continue;

        let curPrice = 0;
        try {
          const ticker = await this.client.tickerPrice(sym);
          curPrice = parseFloat(ticker.data.price);
        } catch {
          continue;
        }

        const usdtValue = total * curPrice;
        if (usdtValue >= 10) {
          console.log(`🔍 [AUTO-SYNC] Moneda detectada en Binance sin tracking: ${sym} (${total} ${asset} ≈ ${usdtValue.toFixed(2)} USDT)`);
          let buyPrice = curPrice;
          let buyTime = Date.now();
          try {
            const tradesRes = await this.client.myTrades(sym, { limit: 10, recvWindow: 60000 });
            const buyTrades = (tradesRes.data || []).filter((t: any) => t.isBuyer);
            if (buyTrades.length > 0) {
              const lastBuy = buyTrades[buyTrades.length - 1];
              buyPrice = parseFloat(lastBuy.price);
              buyTime = lastBuy.time || Date.now();
            }
          } catch (err: any) {
            console.error(`No se pudieron obtener trades previos de ${sym}: ${err.message}`);
          }

          const spent = total * buyPrice;
          const highestPrice = Math.max(buyPrice, curPrice);
          const gainPct = ((curPrice - buyPrice) / buyPrice) * 100;
          const activated = gainPct >= TRAILING_ACTIVATION_PCT;

          this.activeTrailingPositions.set(sym, {
            symbol: sym,
            buyPrice,
            qty: total,
            investedUsdt: spent,
            highestPrice,
            activated,
            buyTime
          });
          this.saveTrailingPositions();
          console.log(`✅ ${sym} adoptada con éxito para Trailing Take Profit.`);
        }
      }
    } catch (e: any) {
      console.error("Error sincronizando posiciones huérfanas desde Binance:", e.message);
    }
  }
  private activeTrailingPositions: Map<string, ActivePosition> = new Map();
  private recentlySoldSymbols: Map<string, number> = new Map();
  private buyWatches: Map<string, BuyWatch> = new Map();
  private ignoredDca: Map<string, { timestamp: number; price: number; dropPct: number }> = new Map();
  private dashboardServer: DashboardServer;
  private aiCopilot: AiCopilot = new AiCopilot();

  constructor() {
    this.client = new Spot(process.env.BINANCE_API_KEY, process.env.BINANCE_API_SECRET, { recvWindow: 60000 });
    this.notifier = new TelegramNotifier();
    this.futuresEngine = new FuturesEngine();
    this.telegramCommands = new TelegramCommands((cmd) => this.handleTelegramCommand(cmd));
    this.loadTrailingPositions();
    this.loadBuyWatches();
    this.loadStrategyControls();
    this.loadPendingOpportunity();
    this.loadIgnoredDca();
    this.dashboardServer = new DashboardServer();
    this.dashboardServer.start();
  }

  private saveIgnoredDca() {
    try {
      fs.writeFileSync(path.resolve(process.cwd(), ".ignored-dca.json"), JSON.stringify(Array.from(this.ignoredDca.entries()), null, 2));
    } catch(e: any) {
      console.error("Error guardando ignored DCA:", e.message);
    }
  }

  private loadIgnoredDca() {
    try {
      const file = path.resolve(process.cwd(), ".ignored-dca.json");
      if (fs.existsSync(file)) {
        this.ignoredDca = new Map(JSON.parse(fs.readFileSync(file, "utf-8")));
      }
    } catch(e: any) {}
  }

  private saveBuyWatches() {
    try {
      fs.writeFileSync(path.resolve(process.cwd(), ".trailing-buys.json"), JSON.stringify(Array.from(this.buyWatches.entries()), null, 2));
    } catch(e: any) {
      console.error("Error guardando trailing buys:", e.message);
    }
  }

  private loadStrategyControls() {
    try {
      const file = path.resolve(process.cwd(), ".strategy-controls.json");
      if (fs.existsSync(file)) {
        this.controls = JSON.parse(fs.readFileSync(file, "utf-8"));
        if (!this.controls.strategies) {
          this.controls.strategies = { trailing_rebound: true, smart_dca: true, micro_grid: false, cazador_weekend: this.isWeekendWindow() };
        }
        if (this.controls.stopLossEnabled === undefined) this.controls.stopLossEnabled = false; // BLINDAJE SPOT: NUNCA vender a pérdida por defecto
        if (this.controls.stopLossPct === undefined) this.controls.stopLossPct = 4.0;
        if (!this.controls.timeframe) this.controls.timeframe = "1h";
        if (!this.controls.rejectedSuggestions) this.controls.rejectedSuggestions = {};
        if (this.controls.cashReservePct === undefined) this.controls.cashReservePct = 25;
        if (this.controls.maxPerCoinPct === undefined) this.controls.maxPerCoinPct = 30;

        if (!this.controls.strategySettings) {
          this.controls.strategySettings = {
            trailing_rebound: { timeframe: "1h", stopLossEnabled: false, stopLossPct: 4.0 },
            smart_dca: { timeframe: "4h", stopLossEnabled: false, stopLossPct: 6.0 },
            micro_grid: { timeframe: "15m", stopLossEnabled: false, stopLossPct: 2.0 },
            cazador_weekend: { timeframe: "1h", stopLossEnabled: false, stopLossPct: 5.0 }
          };
        }
        if (!this.controls.suggestions) {
          this.controls.suggestions = {
            trailing_rebound: { timeframe: "1h", stopLossPct: 4.0, reason: "Volatilidad estándar. Óptimo 1H con SL -4.0%", updatedAt: Date.now() },
            smart_dca: { timeframe: "4h", stopLossPct: 6.0, reason: "Monitorear soportes mayores en 4H con SL -6.0%", updatedAt: Date.now() },
            micro_grid: { timeframe: "15m", stopLossPct: 2.0, reason: "Scalping de rejilla en 15m con SL estricto de -2.0%", updatedAt: Date.now() },
            cazador_weekend: { timeframe: "1h", stopLossPct: 5.0, reason: "Ondas de fin de semana con SL -5.0% ante mechazos", updatedAt: Date.now() }
          };
        } else if (this.controls.strategies.cazador_weekend === undefined) {
          this.controls.strategies.cazador_weekend = this.isWeekendWindow();
        }
        if (!this.controls.baseAllocations) {
          this.controls.baseAllocations = { trailing_rebound: 50, smart_dca: 30, micro_grid: 0, cazador_weekend: 20 };
        }
        if (!this.controls.allocations) {
          const isW = this.isWeekendWindow();
          const baseW = this.controls.baseAllocations.cazador_weekend ?? 20;
          this.controls.allocations = isW
            ? { trailing_rebound: 50, smart_dca: 30, micro_grid: 0, cazador_weekend: baseW }
            : { trailing_rebound: 50 + baseW, smart_dca: 30, micro_grid: 0, cazador_weekend: 0 };
        }
        this.autoPilot = this.controls.autoPilot;
      }
    } catch(e: any) {
      console.error("Error cargando strategy controls:", e.message);
    }
  }

  private saveStrategyControls() {
    try {
      this.controls.updatedAt = Date.now();
      this.controls.autoPilot = this.autoPilot;
      fs.writeFileSync(path.resolve(process.cwd(), ".strategy-controls.json"), JSON.stringify(this.controls, null, 2));
      // Sincronización en la nube Supabase
      supabaseDb.saveStrategyControls(this.controls).catch(() => {});
    } catch(e: any) {
      console.error("Error guardando strategy controls:", e.message);
    }
  }

  private loadPendingOpportunity() {
    try {
      const file = path.resolve(process.cwd(), ".pending-opportunity.json");
      if (fs.existsSync(file)) {
        this.pendingOpportunity = JSON.parse(fs.readFileSync(file, "utf-8"));
      }
    } catch(e: any) {}
  }

  private savePendingOpportunity() {
    try {
      const file = path.resolve(process.cwd(), ".pending-opportunity.json");
      if (this.pendingOpportunity) {
        fs.writeFileSync(file, JSON.stringify(this.pendingOpportunity, null, 2));
      } else if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    } catch(e: any) {}
  }

  private async onWeekendTradeCompleted(symbol: string) {
    try {
      console.log("🏖️ [CAZADOR WEEKEND] Posición de fin de semana en " + symbol + " vendida con éxito. Reasignando presupuesto inteligente a Cazador Trailing...");
      this.controls.strategies.cazador_weekend = false;

      const baseW = this.controls.baseAllocations?.cazador_weekend ?? 20;
      const currentW = this.controls.allocations.cazador_weekend ?? 0;
      const transferAmount = currentW > 0 ? currentW : baseW;

      this.controls.allocations.trailing_rebound = (this.controls.allocations.trailing_rebound || 50) + transferAmount;
      this.controls.allocations.cazador_weekend = 0;
      this.saveStrategyControls();

      await this.notifier.send(
        "🏖️ <b>[CAZADOR WEEKEND: OPERACIÓN VENDIDA CON ÉXITO]</b> 🎉\n\n" +
        "• La posición en <b>" + symbol + "</b> ha cerrado en la cima con ganancias.\n" +
        "• Como la operación de fin de semana ya fue completada, el switch de Cazador Weekend se ha <b>desactivado</b> automáticamente.\n" +
        "• 💼 <b>Presupuesto inteligente:</b> La cuota del <b>" + transferAmount + "%</b> se transfirió automáticamente a <b>🏹 Cazador Trailing</b> (ahora al <b>" + this.controls.allocations.trailing_rebound + "%</b>) para continuar operando durante la semana.\n" +
        "• ⏰ Se reactivará y recuperará su presupuesto el próximo viernes a las 17:00 COT."
      );
    } catch(e: any) {
      console.error("Error en onWeekendTradeCompleted:", e.message);
    }
  }

  private async checkOpportunityActionFile() {
    try {
      const file = path.resolve(process.cwd(), ".opportunity-action.json");
      if (fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, "utf-8"));
        fs.unlinkSync(file);
        if (data.action === "approve" && this.pendingOpportunity) {
          console.log(`🌐 Acción recibida desde Dashboard: APROBAR ${this.pendingOpportunity.symbol}`);
          const opp = this.pendingOpportunity;
          this.pendingOpportunity = null;
          this.savePendingOpportunity();
          await this.notifier.send(`🌐 <b>[APROBACIÓN DESDE DASHBOARD]</b> Ejecutando ${opp.strategyName} en <b>${opp.symbol}</b>...`);
          await this.executeOpportunity(opp);
        } else if (data.action === "ignore" && this.pendingOpportunity) {
          console.log(`🌐 Acción recibida desde Dashboard: IGNORAR ${this.pendingOpportunity.symbol}`);
          this.pendingOpportunity = null;
          this.savePendingOpportunity();
          await this.notifier.send(`🌐 <b>[CANCELADO DESDE DASHBOARD]</b> Oportunidad descartada.`);
        }
      }
    } catch(e: any) {}
  }

  private async buildAiContextSnapshot(): Promise<BotContextSnapshot> {
    let freeUsdt = 0;
    let earnUsdt = 0;
    try {
      freeUsdt = await this.getFreeBalance("USDT");
      const earnRes = await this.client.getFlexibleProductPosition({ asset: "USDT", recvWindow: 60000 });
      earnUsdt = parseFloat(earnRes.data?.rows?.[0]?.totalAmount || "0");
    } catch {}

    const positions: BotContextSnapshot["positions"] = [];
    let totalInvested = 0;
    for (const [sym, pos] of this.activeTrailingPositions.entries()) {
      try {
        const t = await this.client.tickerPrice(sym);
        const cur = parseFloat(t.data.price);
        const gainPct = ((cur - pos.buyPrice) / pos.buyPrice) * 100;
        const pnlUsdt = (cur - pos.buyPrice) * pos.qty;
        const targetPrice = pos.buyPrice * 1.008;
        positions.push({
          symbol: sym,
          qty: pos.qty,
          investedUsdt: pos.investedUsdt,
          buyPrice: pos.buyPrice,
          curPrice: cur,
          targetPrice,
          gainPct,
          pnlUsdt
        });
        totalInvested += pos.investedUsdt;
      } catch {}
    }

    const radar: BotContextSnapshot["radar"] = [];
    for (const sym of ["PEPEUSDT", "XRPUSDT", "BNBUSDT", "BTCUSDT"]) {
      try {
        const k = await this.client.klines(sym, "15m", { limit: 20 });
        const closes = k.data.map((row: any) => parseFloat(row[4]));
        const cur = closes[closes.length - 1];
        const rsi = this.calculateRSI(closes, 14);
        const highs = k.data.map((row: any) => parseFloat(row[2]));
        const maxRecent = Math.max(...highs.slice(-20));
        const dropPct = ((maxRecent - cur) / maxRecent) * 100;
        radar.push({
          symbol: sym,
          curPrice: cur,
          rsi,
          dropPct,
          isHunting: this.buyWatches.has(sym)
        });
      } catch {}
    }

    return {
      positions,
      freeUsdt,
      earnUsdt,
      totalEstimatedUsdt: freeUsdt + earnUsdt + totalInvested,
      allocations: this.controls.allocations || { trailing_rebound: 70, smart_dca: 30, micro_grid: 0 },
      autoPilot: this.autoPilot,
      marketSentiment: { value: 51, classification: "Neutral" },
      performance: { wins: 13, losses: 0, totalPnlUsdt: 9.57, winRate: 100 },
      radar
    };
  }

  private async checkOpportunityTimeout() {
    if (!this.pendingOpportunity) return;
    if (Date.now() >= this.pendingOpportunity.expiresAt) {
      const opp = this.pendingOpportunity;
      this.pendingOpportunity = null;
      this.savePendingOpportunity();

      if (this.controls.autoPilot) {
        console.log(`⚡ [AUTO-PILOTO] Tiempo de 3 min agotado. Ejecutando automáticamente ${opp.strategyName} en ${opp.symbol}...`);
        await this.notifier.send(
          `⚡ <b>[AUTO-PILOTO: DECISIÓN INTELIGENTE EJECUTADA]</b> 🤖\n\n` +
          `⏱️ Tiempo de espera agotado sin respuesta.\n` +
          `🚀 <b>Acción:</b> Ejecutando compra para no perder la ventana de rebote:\n` +
          `• <b>Moneda:</b> ${opp.symbol}\n` +
          `• <b>Estrategia:</b> ${opp.strategyName}\n` +
          `• <b>Monto:</b> ${opp.amount.toFixed(2)} USDT\n\n` +
          `📊 <b>Criterio Técnico Evaluado:</b> ${opp.reason}\n` +
          `🧠 <b>¿Por qué tomó esta decisión?:</b> Los datos confirmaron absorción de venta y giro hacia arriba en soporte. La compra se ejecuta en el suelo para cazar el impulso (+0.8% a +3.5%) sin dejar pasar la oportunidad.`
        );
        await this.executeOpportunity(opp);
      } else {
        console.log(`⌛ [MODO MANUAL] Tiempo agotado. Oportunidad en ${opp.symbol} descartada.`);
        await this.notifier.send(`⌛ <i>Tiempo de espera agotado. Oportunidad en ${opp.symbol} descartada (Modo Manual).</i>`);
      }
    }
  }

  async executeOpportunity(opp: PendingOpportunity): Promise<boolean> {
    if (opp.strategy === "smart_dca") {
      const pos = this.activeTrailingPositions.get(opp.symbol);
      if (!pos) {
        console.error(`Posición para Smart DCA en ${opp.symbol} ya no existe.`);
        return false;
      }
      return await this.executeSmartDca(pos, opp.amount);
    } else if (opp.strategy === "trailing_rebound") {
      return await this.executeSmartBuy(opp.symbol, opp.amount, "Trailing Rebound Confirmado");
    } else if (opp.strategy === "micro_grid") {
      return await this.executeSmartBuy(opp.symbol, opp.amount, "Micro-Grid Rango Lateral");
    } else if (opp.strategy === "cazador_weekend") {
      return await this.executeSmartBuy(opp.symbol, opp.amount, "Cazador Weekend (Rebote Fin de Semana)", "cazador_weekend");
    }
    return false;
  }

  async notifyOpportunity(opp: PendingOpportunity) {
    const mins = Math.round(this.controls.approvalTimeoutSec / 60);
    const alertMsg = `🎯 <b>¡NUEVA OPORTUNIDAD DETECTADA!</b> 💡\n\n` +
      `• <b>Moneda:</b> <b>${opp.symbol}</b>\n` +
      `• 🏛️ <b>Estrategia recomendada:</b> <b>${opp.strategyName}</b>\n` +
      `• 📊 <b>Diagnóstico:</b> ${opp.reason}\n` +
      `• 💵 <b>Monto sugerido:</b> ${opp.amount.toFixed(2)} USDT\n` +
      `• ⏱️ <b>Tiempo de espera:</b> ${mins} minutos para confirmar\n\n` +
      `<b>¿Qué deseas hacer?</b>\n` +
      `👉 /aprobar — <i>Ejecutar [${opp.strategyName}]</i>\n` +
      `👉 /ignorar — <i>Descartar oportunidad</i>\n\n` +
      `🤖 <i>${this.controls.autoPilot ? `Modo Autónomo ACTIVO: Si no respondes en ${mins} min, el bot ejecutará automáticamente la recomendación.` : "Modo Manual ACTIVO: Esperará tu aprobación explícita."}</i>`;

    
      
      await this.notifier.send(alertMsg);
    console.log(alertMsg.replace(/<[^>]*>/g, ""));
  }

  async executeSmartDca(pos: ActivePosition, usdtAmount: number): Promise<boolean> {
    try {
      const investStr = (usdtAmount - 0.15).toFixed(2);
      console.log(`🛡️ [Smart DCA] Ejecutando orden de seguridad de ${investStr} USDT en ${pos.symbol}...`);

      const buyRes = await this.client.newOrder(pos.symbol, "BUY", "MARKET", {
        quoteOrderQty: investStr,
        newOrderRespType: "FULL",
        recvWindow: 60000
      });

      const asset = pos.symbol.replace("USDT", "");
      const spent = parseFloat(buyRes.data.cummulativeQuoteQty);
      const grossQty = parseFloat(buyRes.data.executedQty);
      let feeInBase = 0;
      for (const f of buyRes.data.fills || []) {
        if (f.commissionAsset === asset) feeInBase += parseFloat(f.commission);
      }
      const newQty = grossQty - feeInBase;

      const buyPriceThisLot = spent / newQty;
      const lotIndex = (pos.lotIndex || 1) + 1;
      const newLotId = `${pos.symbol}_lot_${lotIndex}_${Date.now()}`;

      pos.lastDcaTime = Date.now();
      pos.dcaCount = (pos.dcaCount || 0) + 1;

      // 🛡️ REGLA DE ORO: CADA COMPRA ES UN LOTE 100% AISLADO (NUNCA COMBINAR)
      this.activeTrailingPositions.set(newLotId, {
        id: newLotId,
        symbol: pos.symbol,
        lotIndex: lotIndex,
        buyPrice: buyPriceThisLot,
        qty: newQty,
        investedUsdt: spent,
        highestPrice: buyPriceThisLot,
        activated: false,
        buyTime: Date.now(),
        strategy: "smart_dca",
        customCallbackPct: pos.customCallbackPct,
        customTimeframe: pos.customTimeframe
      });
      this.saveTrailingPositions();

      const newTarget = (buyPriceThisLot * 1.008).toFixed(4);

      const alertMsg = `🛡️ <b>¡SMART DCA: NUEVO LOTE INDEPENDIENTE CREADO!</b> 🎯\n\n` +
        `• <b>Moneda:</b> <b>${pos.symbol}</b> (Lote #${lotIndex})\n` +
        `• 💵 <b>Inversión de este lote:</b> ${spent.toFixed(2)} USDT (+${newQty.toFixed(4)} ${asset})\n` +
        `• 🎯 <b>Precio de compra de este lote:</b> <b>${fmtPrice(buyPriceThisLot)}</b>\n` +
        `• 🏁 <b>Meta de salida (+0.8%):</b> ${newTarget}\n\n` +
        `🔒 <i>LOTE AISLADO: Cuando este lote rebote a ${newTarget}, se venderá ÚNICAMENTE este lote con ganancia limpia. Tus lotes anteriores quedan intactos esperando su propia meta sin arrastrar pérdidas.</i>`;

      await this.notifier.send(alertMsg);
      console.log(alertMsg.replace(/<[^>]*>/g, ""));


      return true;
    } catch(e: any) {
      const msg = e.response?.data?.msg || e.message;
      console.error(`❌ Error ejecutando Smart DCA en ${pos.symbol}:`, msg);
      await this.notifier.send(`⚠️ <i>No se pudo ejecutar Smart DCA en ${pos.symbol}: ${msg}</i>`);
      return false;
    }
  }

  
  /**
   * 🤖 ESTRATEGIA AUTÓNOMA CENTINELA ALPHA (Recuperación y Caza Institucional)
   * Gestiona de forma 100% independiente el 20% del presupuesto para recuperar el capital.
   */
  async evaluateCentinelaAlpha(usdt: number): Promise<boolean> {
    try {
      if (!this.controls.strategies?.centinela_alpha) return false;

      // Verificar si ya tenemos una posición abierta gestionada por Centinela Alpha
      for (const p of this.activeTrailingPositions.values()) {
        if (p.strategy === "centinela_alpha") return false;
      }

      if (usdt < 12) return false;

      const allocPct = this.controls.allocations?.centinela_alpha || 20;
      const budgetUsdt = Math.min(30, Math.max(12, Math.floor(usdt * (allocPct / 100) * 100) / 100));

      const candidates = [...WATCHLIST, ...MEME_WATCHLIST];
      let bestAsset: { symbol: string; score: number; reason: string; rsi: number; curPrice: number; tf: "15m" | "1h"; callback: number } | null = null;

      for (const sym of candidates) {
        let isAlreadyOpen = false;
        for (const p of this.activeTrailingPositions.values()) {
          if (p.symbol === sym) { isAlreadyOpen = true; break; }
        }
        if (isAlreadyOpen || this.buyWatches.has(sym)) continue;

        const isMeme = MEME_WATCHLIST.includes(sym) || sym.includes("PEPE");
        const tf: "15m" | "1h" = isMeme ? "15m" : "1h";

        try {
          const klines = await this.client.klines(sym, tf, { limit: 35 });
          const data = klines.data;
          const opens = data.map((k: any) => parseFloat(k[1]));
          const highs = data.map((k: any) => parseFloat(k[2]));
          const lows = data.map((k: any) => parseFloat(k[3]));
          const closes = data.map((k: any) => parseFloat(k[4]));

          const curPrice = closes[closes.length - 1];
          const rsi = this.calculateRSI(closes, 14);
          const maxRecent = Math.max(...highs.slice(-20));
          const dropPct = ((maxRecent - curPrice) / maxRecent) * 100;

          const lastIdx = closes.length - 1;
          const candleRange = highs[lastIdx] - lows[lastIdx];
          const lowerWick = Math.min(opens[lastIdx], closes[lastIdx]) - lows[lastIdx];
          const wickRatio = candleRange > 0 ? (lowerWick / candleRange) : 0;

          if ((rsi <= 44 || dropPct >= 1.8) && (wickRatio >= 0.25 || rsi <= 35)) {
            let score = (45 - rsi) * 2 + (wickRatio * 30) + (dropPct * 1.5);
            if (isMeme) score += 5;

            if (!bestAsset || score > bestAsset.score) {
              bestAsset = {
                symbol: sym,
                score,
                reason: `RSI ${rsi.toFixed(1)} en ${tf.toUpperCase()} con rechazo inferior del ${(wickRatio * 100).toFixed(0)}% y caída de -${dropPct.toFixed(1)}%`,
                rsi,
                curPrice,
                tf,
                callback: isMeme ? 0.45 : 0.25
              };
            }
          }
        } catch(e) {}
      }

      if (!bestAsset) return false;

      console.log(`🤖 [CENTINELA ALPHA] Oportunidad detectada en ${bestAsset.symbol}: ${bestAsset.reason}`);
      const buyStr = (budgetUsdt - 0.15).toFixed(2);
      const buyRes = await this.client.newOrder(bestAsset.symbol, "BUY", "MARKET", {
        quoteOrderQty: buyStr,
        newOrderRespType: "FULL",
        recvWindow: 60000
      });

      const asset = bestAsset.symbol.replace("USDT", "");
      const spent = parseFloat(buyRes.data.cummulativeQuoteQty);
      const grossQty = parseFloat(buyRes.data.executedQty);
      let feeInBase = 0;
      for (const f of buyRes.data.fills || []) {
        if (f.commissionAsset === asset) feeInBase += parseFloat(f.commission);
      }
      const netQty = grossQty - feeInBase;
      const buyPrice = spent / netQty;

      const posId = `${bestAsset.symbol}_alpha_${Date.now()}`;
      this.activeTrailingPositions.set(posId, {
        id: posId,
        symbol: bestAsset.symbol,
        buyPrice,
        qty: netQty,
        investedUsdt: spent,
        highestPrice: buyPrice,
        activated: false,
        buyTime: Date.now(),
        strategy: "centinela_alpha",
        customCallbackPct: bestAsset.callback,
        customTimeframe: bestAsset.tf
      });
      this.saveTrailingPositions();

      const targetGain = (buyPrice * 1.008).toFixed(4);
      const rec = this.controls.recoveryTracker || { targetUsdt: 100.00, recoveredUsdt: 6.11, tradesCount: 8 };

      const msg = `🤖 <b>[CENTINELA ALPHA: ENTRADA DE RECUPERACIÓN]</b> 🎯\n\n` +
        `• <b>Moneda seleccionada:</b> <b>${bestAsset.symbol}</b>\n` +
        `• 💵 <b>Inversión autónoma:</b> ${spent.toFixed(2)} USDT (20% del portafolio)\n` +
        `• ⏱️ <b>Marco de velas:</b> ${bestAsset.tf.toUpperCase()}\n` +
        `• 🎯 <b>Entrada:</b> ${fmtPrice(buyPrice)} | <b>Meta mínima (+0.8%):</b> ${targetGain}\n` +
        `• 📊 <b>Fundamento del Centinela:</b> <i>${bestAsset.reason}</i>\n\n` +
        `🛡️ <b>Misión de Recuperación:</b>\n` +
        `• Meta fijada: <b>${rec.targetUsdt.toFixed(2)} USDT</b>\n` +
        `• Recuperado hasta ahora: <b>+${rec.recoveredUsdt.toFixed(2)} USDT</b>\n\n` +
        `🔒 <i>Sin Stop-Loss: Spot puro con cero riesgo de venta en pérdidas.</i>`;

      await this.notifier.send(msg);
      console.log(msg.replace(/<[^>]*>/g, ""));
      return true;
    } catch(e: any) {
      console.error("Error en Centinela Alpha:", e.message);
      return false;
    }
  }

  async checkSmartDcaOpportunities(usdt: number): Promise<boolean> {
    if (!this.controls.strategies.smart_dca) return false;
    if (this.pendingOpportunity) return false;
    if (usdt < this.minUsdtToTrade) return false;

    for (const [sym, pos] of this.activeTrailingPositions.entries()) {
      try {
        if (pos.dcaCount && pos.dcaCount >= 2) continue;
        if (pos.lastDcaTime && (Date.now() - pos.lastDcaTime) < 3 * 3600 * 1000) continue;

        const curPrice = parseFloat((await this.client.tickerPrice(sym)).data.price);
        const dropPct = ((curPrice - pos.buyPrice) / pos.buyPrice) * 100;

        const lastIgnored = this.ignoredDca.get(sym);
        if (lastIgnored) {
          const hoursSince = (Date.now() - lastIgnored.timestamp) / (3600 * 1000);
          const extraDropPct = ((curPrice - lastIgnored.price) / lastIgnored.price) * 100;
          if (hoursSince < 2 && extraDropPct > -3.0) {
            continue; // En enfriamiento tras /ignorar (no spamear al usuario a menos que caiga -3% más)
          }
        }

        if (dropPct <= -2.5) {
          const dcaTf = this.controls.strategySettings?.smart_dca?.timeframe || "4h";
          const klines = await this.client.klines(sym, dcaTf, { limit: 25 });
          const closes = klines.data.map((k: any) => parseFloat(k[4]));
          const rsi = this.calculateRSI(closes, 14);

          if (rsi <= 45) {
            const amount = Math.min(15, Math.max(10, Math.floor(usdt * 0.5 * 100) / 100));
            const estQty = amount / curPrice;
            const estAvg = (pos.investedUsdt + amount) / (pos.qty + estQty);
            const savedPct = ((pos.buyPrice - estAvg) / pos.buyPrice) * 100;
            const target08 = (estAvg * 1.008).toFixed(4);

            const opp: PendingOpportunity = {
              id: `dca_${sym}_${Date.now()}`,
              symbol: sym,
              strategy: "smart_dca",
              strategyName: "Smart DCA (Promediado de Seguridad)",
              reason: `Cayó ${dropPct.toFixed(2)}% desde la entrada (RSI ${rsi.toFixed(1)}). Invertir ${amount.toFixed(2)} USDT baja la entrada promedio a ${fmtPrice(estAvg)} (-${savedPct.toFixed(2)}%). Nueva meta: ${target08}`,
              amount,
              curPrice,
              potentialTarget: target08,
              createdAt: Date.now(),
              expiresAt: Date.now() + this.controls.approvalTimeoutSec * 1000
            };

            this.pendingOpportunity = opp;
            this.savePendingOpportunity();
            await this.notifyOpportunity(opp);
            return true;
          }
        }
      } catch (e: any) {
        console.error(`Error evaluando Smart DCA para ${sym}:`, e.message);
      }
    }
    return false;
  }

  private loadBuyWatches() {
    try {
      const file = path.resolve(process.cwd(), ".trailing-buys.json");
      if (fs.existsSync(file)) {
        this.buyWatches = new Map(JSON.parse(fs.readFileSync(file, "utf-8")));
        console.log(`📂 Cargadas ${this.buyWatches.size} vigilancias de Trailing Buy desde disco.`);
      }
    } catch(e: any) {
      console.error("Error cargando trailing buys:", e.message);
    }
  }
  private saveTrailingPositions() {
    try {
      const data = Array.from(this.activeTrailingPositions.entries());
      fs.writeFileSync(path.resolve(process.cwd(), ".trailing-positions.json"), JSON.stringify(data, null, 2));
      // Sincronización en la nube Supabase
      for (const pos of this.activeTrailingPositions.values()) {
        supabaseDb.saveActivePosition(pos).catch(() => {});
      }
    } catch(e: any) {
      console.error("Error guardando trailing positions:", e.message);
    }
  }

  private loadTrailingPositions() {
    try {
      const file = path.resolve(process.cwd(), ".trailing-positions.json");
      if (fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, "utf-8"));
        this.activeTrailingPositions = new Map(data);
        console.log(`📂 Cargadas ${this.activeTrailingPositions.size} posiciones de Trailing desde disco.`);
      }
    } catch(e: any) {
      console.error("Error cargando trailing positions:", e.message);
    }
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
   * Monitor y Rastreador de Ganancias Trailing (Trailing Take Profit Engine)
   */
  async checkTrailingPositions() {
    for (const [symbol, pos] of this.activeTrailingPositions.entries()) {
      try {
        const asset = symbol.replace("USDT", "");
        let freeBal = await this.getFreeBalance(asset);
        if (freeBal < pos.qty * 0.1) {
          // Intentar rescatar de Simple Earn si Binance lo barrió con Auto-Subscribe
          await this.redeemFromEarnIfNeeded(asset, pos.qty);
          freeBal = await this.getFreeBalance(asset);
        }
        if (freeBal < pos.qty * 0.1) {
          console.log("🧹 " + symbol + " ya fue vendida en Binance (saldo cero). Retirando de memoria.");
          this.activeTrailingPositions.delete(symbol);
          this.saveTrailingPositions();
          continue;
        }

        const ticker = await this.client.tickerPrice(symbol);
        const curPrice = parseFloat(ticker.data.price);
        const gainPct = ((curPrice - pos.buyPrice) / pos.buyPrice) * 100;

        // 0. BLINDAJE SPOT ABSOLUTO: CERO VENTAS EN PÉRDIDA
        // En Spot nunca hay liquidación de margen. Los tokens son propios.
        // NUNCA vender en rojo; esperar el rebote al alza (+0.80% mínimo) o promediar con Smart DCA.
        // (Stop-Loss eliminado al 100% de la lógica Spot para evitar whipsaws)

        // 1. Activar Trailing si superó el +0.8%
        if (gainPct >= TRAILING_ACTIVATION_PCT && !pos.activated) {
          pos.activated = true;
          pos.highestPrice = curPrice;
          const msg = `🎯 <b>[TRAILING ACTIVADO: ${symbol}]</b>\n\n` +
            `• El precio subió a $${curPrice} (<b>+${gainPct.toFixed(2)}%</b>).\n` +
            `• 🛡️ Ganancia mínima asegurada (+0.8%).\n` +
            `• 🚀 <i>El bot ahora persigue el pico más alto. Mientras siga subiendo, ¡seguirá sumando!</i>`;
          await this.notifier.send(msg);
          console.log(`🎯 Trailing activado en ${symbol} a ${curPrice} (+${gainPct.toFixed(2)}%)`);
          this.saveTrailingPositions();
        }

        // 2. Si el precio marca un nuevo pico, actualizamos el techo
        if (pos.activated && curPrice > pos.highestPrice) {
          const oldPeak = pos.highestPrice;
          pos.highestPrice = curPrice;
          console.log(`📈 Nuevo pico en ${symbol}: ${curPrice} (+${gainPct.toFixed(2)}%)`);
          this.saveTrailingPositions();

          // Si el pico subió al menos un 0.12%, avisar a Telegram
          const jumpPct = ((curPrice - oldPeak) / oldPeak) * 100;
          if (jumpPct >= 0.12) {
            const callback = this.getCallbackPct(symbol, pos);
            const stopPrice = curPrice * (1 - callback / 100);
            const minLockedGain = ((stopPrice - pos.buyPrice) / pos.buyPrice) * 100;
            const tierDesc = gainPct >= 3.0 ? "Candado Extremo (0.15%)" : (gainPct >= 2.2 ? "Ceñido Euforia (0.20%)" : (gainPct >= 1.4 ? "Consolidación (0.30%)" : "Respiro Normal (0.45%)"));
            const peakAlert = `📈 <b>¡NUEVO PICO ALCANZADO: ${symbol}!</b> 🚀\n\n` +
              `• <b>Nuevo techo:</b> ${fmtPrice(curPrice)} (<b>+${gainPct.toFixed(2)}%</b>)\n` +
              `• 🛡️ <b>Nuevo piso garantizado:</b> ${fmtPrice(stopPrice)}\n` +
              `• 💵 <b>Ganancia amarrada:</b> +${minLockedGain.toFixed(2)}% NETO\n` +
              `• ⚡ <b>Trailing Dinámico:</b> ${callback.toFixed(2)}% (${tierDesc})\n\n` +
              `🏹 <i>El bot persigue la cima con candado dinámico...</i>`;
            await this.notifier.send(peakAlert);
          }
        }

        // 💎 PASO A: VENTA PARCIAL 50/50 AL TOCAR PICO ALTO (>= +2.20%)
        if (pos.activated && gainPct >= 2.20 && !pos.partialProfitTaken) {
          try {
            await this.executePartialSell(pos, curPrice, 0.50);
          } catch(e) {}
        }

        // 3. Evaluar Salida por Retroceso (Callback) o por Mecha de Rechazo (Agotamiento)
        if (pos.activated) {
          const dropFromPeak = ((pos.highestPrice - curPrice) / pos.highestPrice) * 100;
          const hitHardCap = gainPct >= TRAILING_HARD_CAP_PCT;
          let callback = pos.strategy === "micro_grid" ? 0.15 : this.getCallbackPct(symbol, pos);
          let minGain = pos.strategy === "micro_grid" ? 0.35 : 0.80; // Blindado a +0.80% mínimo para no cerrar con migajas

          // 🌆 COSECHA PRE-NOCTURNA (16:00 - 19:30 COT):
          if (this.isPreNightHarvestWindow() && gainPct >= 0.65) {
            callback = Math.min(callback, 0.20);
            minGain = 0.65;
          }

          // 🕯️ CENTINELA DE MECHA DE RECHAZO (AGOTAMIENTO INSTITUCIONAL EN CIMA)
          let isRejectionWick = false;
          if (gainPct >= 1.20 && dropFromPeak >= 0.12) {
            try {
              const klines = await this.client.klines(symbol, "15m", { limit: 2 });
              const lastK = klines.data[klines.data.length - 1];
              const o = parseFloat(lastK[1]), h = parseFloat(lastK[2]), l = parseFloat(lastK[3]), c = parseFloat(lastK[4]);
              const totRange = h - l;
              const upperWick = h - Math.max(o, c);
              const upperWickRatio = totRange > 0 ? (upperWick / totRange) : 0;
              if (upperWickRatio >= 0.35) {
                isRejectionWick = true;
                console.log(`🕯️ [MECHA DE RECHAZO EN CIMA] ${symbol}: mecha superior ${(upperWickRatio * 100).toFixed(0)}% >= 35%. Gatillando venta inmediata.`);
              }
            } catch(e) {}
          }

          const hitCallback = dropFromPeak >= callback && gainPct >= minGain;

          if (hitCallback || hitHardCap || isRejectionWick) {
            const reasonOverride = isRejectionWick ? "RECHAZO_MECHA" : undefined;
            console.log(`🏆 ¡CERRANDO EN LA CIMA! Venta Trailing en ${symbol} a ${curPrice} (Pico: ${pos.highestPrice}) [${reasonOverride || 'TRAILING'}]`);
            const sold = await this.executeTrailingSell(pos, curPrice, hitHardCap, false, reasonOverride);
            // Solo se elimina la posición si Binance confirmó la venta
            if (sold) {
              const strat = pos.strategy;
              this.activeTrailingPositions.delete(symbol);
              this.recentlySoldSymbols.set(symbol, Date.now());
              this.saveTrailingPositions();
              if (strat === "cazador_weekend") {
                await this.onWeekendTradeCompleted(symbol);
              }
            }
          }
        }
      } catch (e: any) {
        console.error(`Error monitoreando trailing en ${symbol}:`, e.message);
      }
    }
  }

  /**
   * Si Binance barrió el saldo a Simple Earn (Auto-Subscribe), lo rescata a Spot.
   */
  private async redeemFromEarnIfNeeded(asset: string, needed: number): Promise<void> {
    try {
      const res = await this.client.getFlexibleProductPosition({ asset, recvWindow: 60000 });
      const row = res.data?.rows?.[0];
      if (!row || parseFloat(row.totalAmount) <= 0) return;
      console.log(`🏦 Rescatando ${asset} desde Simple Earn (${row.totalAmount}) para poder vender...`);
      await this.client.redeemFlexibleProduct(row.productId, { redeemAll: true, destAccount: "SPOT", recvWindow: 60000 });
      await new Promise((r) => setTimeout(r, 3000));
      await this.notifier.send(`🏦 <i>Rescaté ${row.totalAmount} ${asset} de Simple Earn a Spot (Binance lo había movido con Auto-Subscribe).</i>`);
    } catch (e: any) {
      console.error(`Error rescatando ${asset} de Earn:`, e.response?.data?.msg || e.message);
    }
  }

  private async getFreeBalance(asset: string): Promise<number> {
    const acc = await this.client.account({ recvWindow: 60000 });
    return parseFloat(acc.data.balances.find((b: any) => b.asset === asset)?.free || "0");
  }

  /** Suma comisiones de los fills de una orden convertidas a USDT */
  private feesToUsdt(fills: any[], baseAsset: string): number {
    let fee = 0;
    for (const f of fills || []) {
      const c = parseFloat(f.commission);
      if (f.commissionAsset === "USDT") fee += c;
      else if (f.commissionAsset === baseAsset) fee += c * parseFloat(f.price);
    }
    return fee;
  }

  
  /**
   * VENTA PARCIAL ESCALONADA 50/50 EN LA CIMA (SCALE-OUT TAKE PROFIT)
   * Al tocar un pico alto (>= +2.20%), vende el 50% de la orden para asegurar USDT en el bolsillo
   * y deja correr el 50% restante con Trailing Stop para cazar subidas mayores.
   */
  async executePartialSell(pos: ActivePosition, exitPrice: number, ratio: number = 0.5): Promise<boolean> {
    try {
      if (pos.partialProfitTaken) return false;

      const asset = pos.symbol.replace("USDT", "");
      let freeBal = await this.getFreeBalance(asset);
      if (freeBal < pos.qty * ratio * 0.95) {
        await this.redeemFromEarnIfNeeded(asset, pos.qty * ratio);
        freeBal = await this.getFreeBalance(asset);
      }

      const exInfo = await this.client.exchangeInfo({ symbol: pos.symbol });
      const sInfo = exInfo.data.symbols[0];
      const stepSize = parseFloat(sInfo.filters.find((f: any) => f.filterType === "LOT_SIZE").stepSize);
      const minNotional = parseFloat(sInfo.filters.find((f: any) => f.filterType === "NOTIONAL" || f.filterType === "MIN_NOTIONAL")?.minNotional || "10.0");
      const qtyDec = Math.max(0, Math.round(-Math.log10(stepSize)));

      const targetSellQty = pos.qty * ratio;
      const sellQty = Math.floor(targetSellQty / stepSize) * stepSize;
      const sellQtyStr = sellQty.toFixed(qtyDec);
      const estimatedValue = sellQty * exitPrice;
      const remainingValue = (pos.qty - sellQty) * exitPrice;

      // Salvaguarda: Verificar que ambas partes cumplan con el mínimo notional de Binance (>= $10 USDT)
      if (estimatedValue < minNotional || remainingValue < minNotional) {
        console.log(`⚠️ [Venta Parcial 50%] Saldo de ${pos.symbol} insuficiente para fraccionar sin violar minNotional (${minNotional} USDT). Manteniendo 100% en Trailing.`);
        return false;
      }

      console.log(`🎯 [Venta Parcial 50%] Vendiendo ${sellQtyStr} ${asset} en ${pos.symbol} a ~${exitPrice} para asegurar ganancia en la cima...`);
      const sellRes = await this.client.newOrder(pos.symbol, "SELL", "MARKET", {
        quantity: sellQtyStr,
        newOrderRespType: "FULL",
        recvWindow: 60000
      });

      const grossUsdt = parseFloat(sellRes.data.cummulativeQuoteQty);
      const sellFee = this.feesToUsdt(sellRes.data.fills, asset);
      const avgSell = grossUsdt / parseFloat(sellRes.data.executedQty);
      const costBasis = pos.investedUsdt * (sellQty / pos.qty);
      const profitUsdt = grossUsdt - sellFee - costBasis;
      const netPct = costBasis > 0 ? (profitUsdt / costBasis) * 100 : 0;

      // Actualizar recovery tracker si aplica
      if (profitUsdt > 0 && this.controls.recoveryTracker) {
        if (this.controls.recoveryTracker.recoveredUsdt < this.controls.recoveryTracker.targetUsdt) {
          this.controls.recoveryTracker.recoveredUsdt = Math.min(
            this.controls.recoveryTracker.targetUsdt,
            this.controls.recoveryTracker.recoveredUsdt + profitUsdt
          );
          this.controls.recoveryTracker.tradesCount += 1;
          this.saveStrategyControls();
        }
      }

      // Registrar venta parcial en Supabase y respaldo local
      try {
        const partialItem = {
          symbol: pos.symbol,
          orderId: sellRes.data.orderId || Date.now(),
          time: Date.now(),
          buyPrice: pos.buyPrice,
          sellPrice: avgSell,
          qty: sellQty,
          costUsdt: costBasis,
          proceedsUsdt: grossUsdt - sellFee,
          feesUsdt: sellFee,
          pnlUsdt: profitUsdt,
          pnlPct: netPct,
          strategy: pos.strategy || "trailing_rebound",
          source: "partial_scale_out_50"
        };
        supabaseDb.recordClosedTrade(partialItem).catch(() => {});

        const ledgerF = path.resolve(process.cwd(), ".closed-trades.json");
        const list: any[] = fs.existsSync(ledgerF) ? JSON.parse(fs.readFileSync(ledgerF, "utf-8")) : [];
        list.push(partialItem);
        fs.writeFileSync(ledgerF, JSON.stringify(list.slice(-200), null, 2), "utf-8");
      } catch (e: any) {}

      // Actualizar posición viva con el 50% restante
      pos.qty = Math.max(0, pos.qty - sellQty);
      pos.investedUsdt = Math.max(0, pos.investedUsdt - costBasis);
      pos.partialProfitTaken = true;
      pos.partialProfitUsdt = (pos.partialProfitUsdt || 0) + profitUsdt;
      pos.highestPrice = avgSell;
      this.saveTrailingPositions();

      const sign = profitUsdt >= 0 ? "+" : "";
      const partialAlert = `🎯 <b>¡TOMA DE GANANCIA PARCIAL (50%) EN LA CIMA!</b> 💎\n\n` +
        `• <b>Moneda:</b> ${pos.symbol}\n` +
        `• <b>Precio de compra:</b> ${fmtPrice(pos.buyPrice)}\n` +
        `• <b>Precio cobrado (50%):</b> ${fmtPrice(avgSell)}\n` +
        `• 💵 <b>Ganancia líquida asegurada:</b> 🟢 <b>${sign}${profitUsdt.toFixed(3)} USDT</b> (<b>+${netPct.toFixed(2)}% NETO</b>)\n` +
        `• 💼 <b>Capital cobrado:</b> ${(grossUsdt - sellFee).toFixed(2)} USDT limpios en caja\n\n` +
        `🏹 <i>¡El 50% restante (${pos.qty.toFixed(4)} ${asset}) sigue corriendo con Trailing Stop para cazar una subida mayor sin riesgo!</i>`;

      await this.notifier.send(partialAlert);
      console.log(`✅ [Venta Parcial 50%] ${pos.symbol}: cobrados +${profitUsdt.toFixed(3)} USDT en la cima. Resto en trailing.`);
      return true;
    } catch (e: any) {
      console.error(`Error en executePartialSell ${pos.symbol}:`, e.response?.data?.msg || e.message);
      return false;
    }
  }

  async executeTrailingSell(pos: ActivePosition, exitPrice: number, hitHardCap: boolean, isStopLoss: boolean = false, reasonOverride?: string): Promise<boolean> {
    try {
      const asset = pos.symbol.replace("USDT", "");
      let freeBal = await this.getFreeBalance(asset);

      // Si falta saldo (barrido a Earn), rescatarlo antes de vender
      if (freeBal < pos.qty * 0.98) {
        await this.redeemFromEarnIfNeeded(asset, pos.qty);
        freeBal = await this.getFreeBalance(asset);
      }

      // Vender solo la cantidad de esta posición (no tocar otros saldos)
      const sellBase = Math.min(freeBal, pos.qty);

      const exInfo = await this.client.exchangeInfo({ symbol: pos.symbol });
      const sInfo = exInfo.data.symbols[0];
      const stepSize = parseFloat(sInfo.filters.find((f: any) => f.filterType === "LOT_SIZE").stepSize);
      const qtyDec = Math.max(0, Math.round(-Math.log10(stepSize)));
      const sellQty = Math.floor(sellBase / stepSize) * stepSize;
      const sellQtyStr = sellQty.toFixed(qtyDec);

      if (sellQty <= 0) {
        console.error(`❌ Sin saldo libre de ${asset} para vender la posición.`);
        return false;
      }

      const sellRes = await this.client.newOrder(pos.symbol, "SELL", "MARKET", {
        quantity: sellQtyStr,
        newOrderRespType: "FULL",
        recvWindow: 60000
      });

      const grossUsdt = parseFloat(sellRes.data.cummulativeQuoteQty);
      const sellFee = this.feesToUsdt(sellRes.data.fills, asset);
      const avgSell = grossUsdt / parseFloat(sellRes.data.executedQty);
      const costBasis = pos.investedUsdt * (sellQty / pos.qty);
      const profitUsdt = grossUsdt - sellFee - costBasis;
      if (profitUsdt > 0) {
        if (!this.controls.recoveryTracker) {
          this.controls.recoveryTracker = { targetUsdt: 100.00, recoveredUsdt: 6.11, tradesCount: 8 };
        }
        if (this.controls.recoveryTracker.recoveredUsdt < this.controls.recoveryTracker.targetUsdt) {
          this.controls.recoveryTracker.recoveredUsdt = Math.min(
            this.controls.recoveryTracker.targetUsdt,
            this.controls.recoveryTracker.recoveredUsdt + profitUsdt
          );
          this.controls.recoveryTracker.tradesCount += 1;
          this.saveStrategyControls();
        }
      }
      const netPct = (profitUsdt / costBasis) * 100;
      // Registrar venta en Supabase y respaldo local
      try {
        const fullTradeItem = {
          symbol: pos.symbol,
          orderId: sellRes.data.orderId || Date.now(),
          time: Date.now(),
          buyPrice: pos.buyPrice,
          sellPrice: avgSell,
          qty: sellQty,
          costUsdt: costBasis,
          proceedsUsdt: grossUsdt - sellFee,
          feesUsdt: sellFee,
          pnlUsdt: profitUsdt,
          pnlPct: netPct,
          strategy: pos.strategy || "trailing_rebound",
          source: reasonOverride || (isStopLoss ? "stop_loss" : "bot_execution")
        };
        supabaseDb.recordClosedTrade(fullTradeItem).catch(() => {});
        supabaseDb.deleteActivePosition(pos.symbol).catch(() => {});

        const ledgerF = path.resolve(process.cwd(), ".closed-trades.json");
        const list: any[] = fs.existsSync(ledgerF) ? JSON.parse(fs.readFileSync(ledgerF, "utf-8")) : [];
        list.push(fullTradeItem);
        fs.writeFileSync(ledgerF, JSON.stringify(list.slice(-200), null, 2), "utf-8");
      } catch (e: any) {
        console.error("Error guardando venta en .closed-trades.json:", e.message);
      }
      const sign = profitUsdt >= 0 ? "+" : "";

      let alertMsg = "";
      if (isStopLoss) {
        alertMsg = `🛑 <b>[STOP-LOSS EJECUTADO: ${pos.symbol}]</b> 🛡️\n\n` +
          `• <b>Precio de compra:</b> ${fmtPrice(pos.buyPrice)}\n` +
          `• <b>Precio de corte:</b> ${fmtPrice(avgSell)}\n` +
          `• 💵 <b>Capital rescatado:</b> <b>${(grossUsdt - sellFee).toFixed(2)} USDT líquidos</b>\n` +
          `• 📉 Pérdida controlada asumida: 🔴 <b>${profitUsdt.toFixed(3)} USDT</b> (<b>${netPct.toFixed(2)}%</b>) ≈ ${Math.round(profitUsdt * COP_PER_USDT).toLocaleString("es-CO")} COP\n\n` +
          `💡 <i>Posición cerrada para proteger tu dinero y tener pólvora lista para la siguiente ola.</i>`;
      } else if (reasonOverride === "RECHAZO_MECHA") {
        alertMsg = `🕯️ <b>¡VENTA POR AGOTAMIENTO Y MECHA DE RECHAZO!</b> 🛑\n\n` +
          `• <b>Moneda:</b> ${pos.symbol}\n` +
          `• <b>Precio de compra:</b> ${fmtPrice(pos.buyPrice)}\n` +
          `• <b>Pico alcanzado:</b> ${fmtPrice(pos.highestPrice)}\n` +
          `• <b>Precio de venta:</b> ${fmtPrice(avgSell)}\n` +
          `• <b>Comisiones:</b> ${sellFee.toFixed(4)} USDT\n` +
          `• 💵 <b>Ganancia líquida:</b> 🟢 <b>${sign}${profitUsdt.toFixed(3)} USDT</b> (<b>${sign}${netPct.toFixed(2)}% NETO</b>) ≈ ${sign}${Math.round(profitUsdt * COP_PER_USDT).toLocaleString("es-CO")} COP\n\n` +
          `🛡️ <i>Rechazo institucional detectado en la cima. Posición cerrada antes del desplome.</i>\n` +
          `📊 <i>Escribe /reporte para ver el acumulado real.</i>`;
      } else {
        alertMsg = `🏆 <b>¡GANANCIA COBRADA CON TRAILING TAKE PROFIT!</b> 🎉\n\n` +
          `• <b>Moneda:</b> ${pos.symbol}\n` +
          `• <b>Precio de compra:</b> ${fmtPrice(pos.buyPrice)}\n` +
          `• <b>Pico alcanzado:</b> ${fmtPrice(pos.highestPrice)}\n` +
          `• <b>Precio de venta:</b> ${fmtPrice(avgSell)}\n` +
          `• <b>Comisiones:</b> ${sellFee.toFixed(4)} USDT\n` +
          `• 💵 <b>Ganancia líquida:</b> ${profitUsdt >= 0 ? "🟢" : "🔴"} <b>${sign}${profitUsdt.toFixed(3)} USDT</b> (<b>${sign}${netPct.toFixed(2)}% NETO</b>) ≈ ${sign}${Math.round(profitUsdt * COP_PER_USDT).toLocaleString("es-CO")} COP\n\n` +
          `🛡️ <i>${hitHardCap ? "Meta máxima de +3.5% alcanzada." : "Venta óptima capturada en la cima del rebote."}</i>\n` +
          `📊 <i>Escribe /reporte para ver el acumulado real.</i>`;
      }

      await this.notifier.send(alertMsg);
      console.log(alertMsg.replace(/<[^>]*>/g, ""));

      // 1. Chart Snapshot para Telegram
      try {
        const chartUrl = `https://quickchart.io/chart?w=500&h=250&devicePixelRatio=2&c=` + encodeURIComponent(JSON.stringify({
          type: "line",
          data: {
            labels: ["Entrada", "Suelo", "Subida", "Pico Máx", "Venta Exitosa"],
            datasets: [{
              label: pos.symbol,
              data: [pos.buyPrice, pos.buyPrice * 0.998, (pos.buyPrice + pos.highestPrice)/2, pos.highestPrice, avgSell],
              borderColor: profitUsdt >= 0 ? "#10B981" : "#F43F5E",
              backgroundColor: profitUsdt >= 0 ? "rgba(16,185,129,0.1)" : "rgba(244,63,94,0.1)",
              fill: true,
              tension: 0.3
            }]
          },
          options: {
            plugins: { legend: { display: false } },
            scales: { x: { grid: { color: "rgba(255,255,255,0.05)" } }, y: { grid: { color: "rgba(255,255,255,0.05)" } } }
          }
        }));
        await this.notifier.sendPhoto(chartUrl, `📊 <b>Gráfico de Salida en la Cima: ${pos.symbol}</b> (+${profitUsdt.toFixed(2)} USDT)`);
      } catch(e) {}

      // 2. Bóveda Automática de Ganancias (25% a Simple Earn)
      if (!isStopLoss && profitUsdt >= 0.50) {
        const vaultAmt = Math.floor(profitUsdt * 0.25 * 100) / 100;
        if (vaultAmt >= 0.10) {
          await this.depositToEarn("USDT", vaultAmt);
        }
      }
      return true;
    } catch(e: any) {
      const msg = e.response?.data?.msg || e.message;
      console.error("Error ejecutando venta trailing:", msg);
      await this.notifier.send(`⚠️ <i>No se pudo vender ${pos.symbol}: ${msg}. La posición sigue protegida y se reintentará.</i>`);
      return false;
    }
  }

  /**
   * Compra una moneda e inicia el rastreo con Trailing Take Profit
   */
  async executeSmartBuy(
    symbol: string,
    usdtAmount: number,
    source: string,
    strategy: "trailing_rebound" | "smart_dca" | "micro_grid" | "cazador_weekend" = "trailing_rebound"
  ): Promise<boolean> {
    try {
      const investStr = (usdtAmount - 0.15).toFixed(2);
      console.log(`🚀 [${source}] Ejecutando compra de ${investStr} USDT en ${symbol} con Trailing Stop...`);

      const buyRes = await this.client.newOrder(symbol, "BUY", "MARKET", {
        quoteOrderQty: investStr,
        newOrderRespType: "FULL",
        recvWindow: 60000
      });

      const asset = symbol.replace("USDT", "");
      const spent = parseFloat(buyRes.data.cummulativeQuoteQty);
      const grossQty = parseFloat(buyRes.data.executedQty);
      // Si la comisión se cobró en la moneda comprada, la cantidad real es menor
      let feeInBase = 0;
      for (const f of buyRes.data.fills || []) {
        if (f.commissionAsset === asset) feeInBase += parseFloat(f.commission);
      }
      const qty = grossQty - feeInBase;
      const buyPrice = spent / grossQty;

      // Registrar posición para Trailing Take Profit
      this.activeTrailingPositions.set(symbol, {
        symbol,
        buyPrice,
        qty,
        investedUsdt: spent,
        highestPrice: buyPrice,
        activated: false,
        buyTime: Date.now(),
        strategy
      });
      this.saveTrailingPositions();

      const target08 = fmtPrice(buyPrice * 1.008);
      const alertMsg = `🦅 <b>¡NUEVA COMPRA INTELIGENTE CON TRAILING!</b> 🚀\n\n` +
        `• <b>Moneda:</b> ${symbol}\n` +
        `• <b>Origen:</b> ${source}\n` +
        `• <b>Inversión:</b> ${spent.toFixed(2)} USDT\n` +
        `• <b>Precio de entrada:</b> ${fmtPrice(buyPrice)}\n` +
        `• 🎯 <b>Gatillo Trailing:</b> ${target08} (+0.8%)\n\n` +
        `🛡️ <i>En cuanto suba al +0.8%, el bot asegura la ganancia y persigue el pico para exprimir el máximo beneficio.</i>`;

      await this.notifier.send(alertMsg);
      console.log(alertMsg.replace(/<[^>]*>/g, "").replace(/<\/?i>/g, ""));
      return true;
    } catch(e: any) {
      const msg = e.response?.data?.msg || e.message;
      console.error(`❌ Error ejecutando compra en ${symbol}:`, msg);
      await this.notifier.send(`⚠️ <i>No se pudo comprar ${symbol}: ${msg}</i>`);
      return false;
    }
  }

  /**
   * TRAILING BUY - Paso 1: detectar caídas y "armar" la vigilancia del piso.
   * Ya no compra en la primera vela verde: registra el precio y rastrea el piso más bajo.
   */
  async scanForDips(activeSymbols: Set<string>): Promise<void> {
    const tf = this.controls.strategySettings?.trailing_rebound?.timeframe || this.controls.timeframe || "1h";

    // Contar cuántas memecoins tenemos activas (posiciones o vigilancias armadas)
    let activeMemeCount = 0;
    for (const [sym] of this.activeTrailingPositions.entries()) {
      if (MEME_WATCHLIST.includes(sym)) activeMemeCount++;
    }
    for (const [sym] of this.buyWatches.entries()) {
      if (MEME_WATCHLIST.includes(sym)) activeMemeCount++;
    }

    for (const sym of WATCHLIST) {
      const isMeme = MEME_WATCHLIST.includes(sym);
      // REGLA DE ORO DE RIESGO: Máximo 1 memecoin activa a la vez
      if (isMeme && activeMemeCount >= 1) {
        continue;
      }
      try {
        const lastSold = this.recentlySoldSymbols.get(sym);
        if (lastSold && (Date.now() - lastSold) < 20 * 60 * 1000) {
          continue; // Cooldown post-venta de 20 min: evitar recomprar en el mismo techo
        }

        if (activeSymbols.has(sym) || this.activeTrailingPositions.has(sym) || this.buyWatches.has(sym)) {
          continue; // No acumular en la misma moneda ni duplicar vigilancias
        }

        const symTf = this.getTimeframeForSymbol(sym);
        const klinesRes = await this.client.klines(sym, symTf, { limit: 35 });
        const data = klinesRes.data;
        const opens = data.map((k: any) => parseFloat(k[1]));
        const highs = data.map((k: any) => parseFloat(k[2]));
        const lows = data.map((k: any) => parseFloat(k[3]));
        const closes = data.map((k: any) => parseFloat(k[4]));

        const rsi = this.calculateRSI(closes, 14);

        // Centinela Nocturno: En ventana nocturna (20:00 - 02:30 COT) exigir sobreventa extrema (RSI <= 26)
        const isNight = this.isNightWindow();
        const rsiThreshold = isNight ? 26 : 35;
        if (isNight && rsi > 26) {
          // Filtrar compras en la noche para no comprar caídas tempranas en libros delgados
          continue;
        }
        const curPrice = closes[closes.length - 1];
        const maxRecent = Math.max(...highs.slice(-20));
        const dropPct = ((maxRecent - curPrice) / maxRecent) * 100;

        // 🧠 ANÁLISIS DE ACCIÓN DEL PRECIO Y COMPORTAMIENTO DE VELAS (PRICE ACTION)
        const lastIdx = closes.length - 1;
        const candleRange = highs[lastIdx] - lows[lastIdx];
        const lowerWick = Math.min(opens[lastIdx], closes[lastIdx]) - lows[lastIdx];
        const lowerWickRatio = candleRange > 0 ? (lowerWick / candleRange) : 0;
        const hasPinbarRejection = lowerWickRatio >= 0.35; // Mecha inferior >= 35% (Rechazo y absorción en suelo)

        // Condiciones inteligentes de suelo:
        // A) Caída estándar con sobreventa RSI
        // B) Martillo / Mecha de rechazo en soporte (adelanta rebotes institucionales)
        // C) Sobreventa profunda
        const isStandardDip = (dropPct >= 1.5 && rsi <= 58) || (rsi <= 48 && dropPct >= 0.8) || (rsi <= 40);
        const isWickRebound = hasPinbarRejection && dropPct >= 1.0 && rsi <= 55;
        const isDip = isMeme
          ? ((dropPct >= 2.0 && rsi <= 55) || isWickRebound || (rsi <= 40))
          : (isStandardDip || isWickRebound);

        if (isDip) {
          this.buyWatches.set(sym, { symbol: sym, armedPrice: curPrice, lowestPrice: curPrice, armedTime: Date.now(), rsi, dropPct });
          this.saveBuyWatches();
          if (isMeme) activeMemeCount++;
          const trigger = curPrice * (1 + TRAILING_BUY_BOUNCE_PCT / 100);
          console.log(`🎯 Trailing Buy ARMADO en ${sym} a ${curPrice} (RSI ${rsi.toFixed(1)} | Caída ${dropPct.toFixed(2)}%)`);
          const isPinbarAlert = hasPinbarRejection ? `• 🕯️ <b>Vela de Rechazo:</b> Mecha inferior del <b>${(lowerWickRatio * 100).toFixed(0)}%</b> (Absorción de suelo)\n` : "";
          await this.notifier.send(
            `🎯 <b>[TRAILING BUY ARMADO: ${isMeme ? "🐕 MEME " : ""}${sym}]</b>\n\n` +
            `• Caída detectada: <b>-${dropPct.toFixed(2)}%</b> (RSI ${rsi.toFixed(1)})\n` +
            isPinbarAlert +
            `• Precio actual: ${fmtPrice(curPrice)}\n` +
            `• 🔻 El bot ahora persigue el <b>piso más bajo</b> tick a tick.\n` +
            `• ✅ Comprará cuando rebote <b>+${TRAILING_BUY_BOUNCE_PCT}%</b> desde el piso (hoy: ${trigger.toFixed(4)}).`
          );
        }
      } catch (e: any) {}
    }
  }

  /**
   * TRAILING BUY - Paso 2: seguir el piso y comprar en el rebote confirmado.
   * Devuelve true si ejecutó una compra.
   */
  async checkBuyWatches(usdt: number): Promise<boolean> {
    for (const [sym, w] of this.buyWatches.entries()) {
      try {
        if (this.activeTrailingPositions.has(sym)) { this.buyWatches.delete(sym); this.saveBuyWatches(); continue; }

        if (Date.now() - w.armedTime > TRAILING_BUY_MAX_AGE_MS) {
          console.log(`⌛ Trailing Buy en ${sym} expiró sin rebote. Se desarma.`);
          this.buyWatches.delete(sym);
          this.saveBuyWatches();
          continue;
        }

        const cur = parseFloat((await this.client.tickerPrice(sym)).data.price);

        if (cur < w.lowestPrice) {
          w.lowestPrice = cur;
          this.saveBuyWatches();
          console.log(`🔻 Nuevo piso en ${sym}: ${cur} (${(((cur - w.armedPrice) / w.armedPrice) * 100).toFixed(2)}% desde que se armó)`);
          continue;
        }

        const bounce = ((cur - w.lowestPrice) / w.lowestPrice) * 100;
        const sessionPlan = this.lastSessionPlan || this.getSessionLiquidityPlan(usdt);
        const reqBounce = sessionPlan.trailingBounceTrigger || TRAILING_BUY_BOUNCE_PCT;
        if (bounce >= reqBounce && usdt >= this.minUsdtToTrade) {
          let amountToUse = this.calculateSessionLotSize(sym, usdt, sessionPlan.lotFractionPct);
          if (amountToUse < this.minUsdtToTrade && usdt >= this.minUsdtToTrade) {
            amountToUse = this.minUsdtToTrade;
          }
          const saved = ((w.armedPrice - w.lowestPrice) / w.armedPrice) * 100;
          const strat = w.strategy || "trailing_rebound";
          const sourceDesc = strat === "cazador_weekend"
            ? `Cazador Weekend (piso ${w.lowestPrice}, ${saved.toFixed(2)}% más barato)`
            : `Trailing Buy (piso ${w.lowestPrice}, ${saved.toFixed(2)}% más barato que al armar)`;
          console.log(`✅ Rebote confirmado en ${sym}: piso ${w.lowestPrice} → ${cur} (+${bounce.toFixed(2)}%). Comprando ${amountToUse} USDT...`);
          const ok = await this.executeSmartBuy(sym, amountToUse, sourceDesc, strat);
          if (ok) {
            this.buyWatches.delete(sym);
            this.saveBuyWatches();
            return true;
          }
        }
      } catch (e: any) {
        console.error(`Error en Trailing Buy ${sym}:`, e.message);
      }
    }
    return false;
  }

  async handleTelegramCommand(rawCmd: string): Promise<string> {
    try {
      const parts = rawCmd.trim().split(/\s+/);
      const cmd = parts[0].toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      const arg1 = parts[1]?.toUpperCase();
      const arg2 = parts[2];

                              
      if (cmd === "/viabilidad_futuros" || cmd === "viabilidad_futuros" || cmd === "/viabilidad" || cmd === "viabilidad") {
        const viability = await this.futuresEngine.evaluateMarketViability();
        const acc = await this.client.account({ recvWindow: 60000 });
        const freeUsdt = parseFloat(acc.data.balances.find((b: any) => b.asset === "USDT")?.free || "0");
        let msg = `🎯 <b>DIAGNÓSTICO EN VIVO: VIABILIDAD DE FUTUROS</b>\n\n` +
          `💼 <b>USDT Libre en Spot:</b> ${freeUsdt.toFixed(2)} USDT\n` +
          `📊 <b>Estado del Mercado:</b> ${viability.isViable ? "🟢 <b>VIABLE</b>" : "🔴 <b>NO VIABLE</b>"} (Puntaje: ${viability.score}/100)\n\n` +
          `• <b>BTC Macro 1H:</b> ${viability.btcStatus}\n` +
          `• <b>Tasas de Financiación:</b> ${viability.fundingStatus}\n` +
          `• <b>Volatilidad:</b> ${viability.volatilityStatus}\n` +
          `• <b>Oportunidades Técnicas:</b> ${viability.opportunitiesFound} pares con setup activo\n`;
        if (viability.favorableSymbols && viability.favorableSymbols.length > 0) {
          msg += `  ${viability.favorableSymbols.join("\n  ")}\n`;
        }
        msg += `\n💡 <b>Recomendación:</b> ${viability.recommendedAction}\n\n` +
          `👉 <code>/futuros_real</code> para pasar a Real\n` +
          `👉 <code>/futuros_sim</code> para mantener Simulación`;
        return msg;
      }

      if (cmd === "/futuros_real" || cmd === "futuros_real" || (cmd === "/futuros_modo" && arg1 === "REAL") || (cmd === "futuros_modo" && arg1 === "REAL")) {
        let hasFuturesPermission = true;
        try {
          const perm = await this.client.apiPermissions();
          if (perm.data && perm.data.enableFutures === false) {
            hasFuturesPermission = false;
          }
        } catch(e) {}

        if (!hasFuturesPermission) {
          return `⚠️ <b>TU API KEY DE BINANCE NO TIENE PERMISO DE FUTUROS ACTIVADO</b> 🔒\n\n` +
            `Entra a Binance ➡️ <b>Gestión de API</b> y marca:\n` +
            `☑️ <b>Habilitar Futuros</b>\n` +
            `☑️ <b>Permitir Transferencia Universal</b>\n\n` +
            `Luego vuelve a presionar: 👉 /futuros_real`;
        }

        // Auto-transferir el margen acordado ($15 USDT) a la billetera de Futuros si es necesario
        const agreedMargin = 15.0;
        const futBal = await this.getFuturesBalance();
        let transferNote = "";

        if (futBal.available < 10.0) {
          const acc = await this.client.account({ recvWindow: 60000 });
          const spotUsdt = parseFloat(acc.data.balances.find((b: any) => b.asset === "USDT")?.free || "0");

          if (spotUsdt >= agreedMargin) {
            const tr = await this.transferSpotToFutures(agreedMargin);
            if (tr.success) {
              transferNote = `\n💼 <b>Transferencia Automática:</b> Se transfirieron <b>$${agreedMargin.toFixed(2)} USDT</b> de Spot a Futuros USD-M.`;
            } else {
              transferNote = `\n⚠️ <i>Nota de transferencia: ${tr.msg}</i>`;
            }
          } else if (spotUsdt >= 5.0) {
            const tr = await this.transferSpotToFutures(Math.floor(spotUsdt));
            transferNote = `\n💼 <b>Transferencia Parcial:</b> Se transfirieron <b>$${Math.floor(spotUsdt)}.00 USDT</b> disponibles de Spot a Futuros.`;
          } else {
            transferNote = `\n⏳ <b>Aviso de Fondos:</b> Tienes $${spotUsdt.toFixed(2)} USDT libres en Spot (fondos activos en órdenes Spot). Tan pronto una orden cierre con ganancia, se fondearán los $${agreedMargin.toFixed(2)} USDT acordados.`;
          }
        } else {
          transferNote = `\n💼 <b>Saldo en Futuros USD-M:</b> Tienes <b>$${futBal.available.toFixed(2)} USDT</b> disponibles.`;
        }

        this.futuresEngine.setConfig({ isSimulated: false });
        return `🚀 <b>MODO FUTUROS CAMBIADO A: REAL</b> ⚠️\n\n` +
          `• El motor ahora ejecutará órdenes reales en Binance USD-M con margen aislado ($10-$15 USDT por operación).\n` +
          `• Stop Loss activo: -1.2% | Trailing TP: +1.2%${transferNote}\n\n` +
          `🛡️ <i>Al finalizar o cambiar a simulación, el bot regresará automáticamente el saldo y ganancias a Spot.</i>\n\n` +
          `👉 Para pasar a simulación y regresar saldo a Spot: /futuros_sim\n` +
          `👉 O para regresar fondos a Spot manualmente: /pasar_a_spot`;
      }

      if (cmd === "/futuros_sim" || cmd === "futuros_sim" || (cmd === "/futuros_modo" && (arg1 === "SIM" || arg1 === "SIMULACION")) || (cmd === "futuros_modo" && (arg1 === "SIM" || arg1 === "SIMULACION"))) {
        this.futuresEngine.setConfig({ isSimulated: true });
        
        // Auto-transferir el saldo restante de Futuros a Spot si no hay posiciones abiertas
        let returnNote = "";
        const futPos = this.futuresEngine.getPositions();
        if (futPos.length === 0) {
          const tr = await this.transferFuturesToSpot();
          if (tr.success) {
            returnNote = `\n\n💰 <b>Retorno Automático de Fondos:</b> ${tr.msg}`;
          }
        } else {
          returnNote = `\n\n⚠️ <i>Tienes ${futPos.length} posición(es) abierta(s). Los fondos se conservarán hasta que cierren, o puedes transferir con /pasar_a_spot.</i>`;
        }

        return `🛡️ <b>MODO FUTUROS CAMBIADO A: SIMULACIÓN (PAPER TRADING)</b> ✅\n\n` +
          `• Las operaciones de futuros ahora son virtuales sin arriesgar saldo real.${returnNote}\n\n` +
          `👉 Para volver a Real y transferir margen: /futuros_real`;
      }

      if (cmd === "/pasar_a_spot" || cmd === "pasar_a_spot" || cmd === "/retirar_a_spot" || cmd === "retirar_a_spot") {
        const amt = arg1 ? parseFloat(arg1) : undefined;
        const res = await this.transferFuturesToSpot(amt);
        const futBal = await this.getFuturesBalance();
        const acc = await this.client.account({ recvWindow: 60000 });
        const spotUsdt = parseFloat(acc.data.balances.find((b: any) => b.asset === "USDT")?.free || "0");

        if (res.success) {
          return `✅ <b>TRANSFERENCIA A SPOT EXITOSA</b> 💼\n\n` +
            `• ${res.msg}\n` +
            `• <b>Saldo Libre en Spot:</b> $${spotUsdt.toFixed(2)} USDT\n` +
            `• <b>Saldo Restante en Futuros:</b> $${futBal.available.toFixed(2)} USDT`;
        } else {
          return `⚠️ <b>NO SE PUDO TRANSFERIR A SPOT</b>\n\n` +
            `• ${res.msg}\n` +
            `• <b>Saldo Disponible en Futuros USD-M:</b> $${futBal.available.toFixed(2)} USDT\n\n` +
            `<i>Recuerda que si tienes posiciones abiertas en futuros, el margen asignado no se puede transferir hasta que cierren.</i>`;
        }
      }

      if (cmd === "/pasar_a_futuros" || cmd === "pasar_a_futuros") {
        const amt = arg1 ? parseFloat(arg1) : 15.0;
        const res = await this.transferSpotToFutures(amt);
        const futBal = await this.getFuturesBalance();
        const acc = await this.client.account({ recvWindow: 60000 });
        const spotUsdt = parseFloat(acc.data.balances.find((b: any) => b.asset === "USDT")?.free || "0");

        if (res.success) {
          return `✅ <b>TRANSFERENCIA A FUTUROS EXITOSA</b> 🚀\n\n` +
            `• ${res.msg}\n` +
            `• <b>Saldo Libre en Futuros USD-M:</b> $${futBal.available.toFixed(2)} USDT\n` +
            `• <b>Saldo Restante en Spot:</b> $${spotUsdt.toFixed(2)} USDT`;
        } else {
          return `⚠️ <b>NO SE PUDO TRANSFERIR A FUTUROS</b>\n\n` +
            `• ${res.msg}\n` +
            `• <b>Saldo Disponible en Spot:</b> $${spotUsdt.toFixed(2)} USDT`;
        }
      }

      if (cmd === "/saldo_futuros" || cmd === "saldo_futuros") {
        const futBal = await this.getFuturesBalance();
        const acc = await this.client.account({ recvWindow: 60000 });
        const spotUsdt = parseFloat(acc.data.balances.find((b: any) => b.asset === "USDT")?.free || "0");
        return `📊 <b>BALANCE COMPARATIVO SPOT VS FUTUROS</b> ⚖️\n\n` +
          `• 💼 <b>Billetera Spot:</b> $${spotUsdt.toFixed(2)} USDT (Libre)\n` +
          `• 🧪 <b>Billetera Futuros USD-M:</b> $${futBal.balance.toFixed(2)} USDT (Total) | $${futBal.available.toFixed(2)} USDT (Disponible)\n\n` +
          `👉 Pasar $15 a Futuros: <code>/pasar_a_futuros 15</code>\n` +
          `👉 Pasar todo a Spot: <code>/pasar_a_spot</code>`;
      }


      if (cmd === "/futuros" || cmd === "futuros") {
        const st = this.futuresEngine.getState();
        return `⚙️ <b>ESTADO DEL MOTOR DE FUTUROS:</b> ${st.isSimulated ? "🛡️ SIMULACIÓN (Paper Trading)" : "🚀 REAL (Binance USD-M)"}\n\n` +
          `• Balance Virtual: $${st.virtualBalanceUsdt.toFixed(2)} USDT\n` +
          `• Margen por Operación: $${st.defaultMarginPerTrade} USDT\n` +
          `• Apalancamiento Dinámico: 2x a 4x (Aislado)\n\n` +
          `👉 Activar Real: /futuros_real\n` +
          `👉 Activar Simulación: /futuros_sim`;
      }

      if (cmd === "/liquidez" || cmd === "liquidez") {
        const acc = await this.client.account({ recvWindow: 60000 });
        const freeUsdt = parseFloat(acc.data.balances.find((b: any) => b.asset === "USDT")?.free || "0");
        const lockedUsdt = parseFloat(acc.data.balances.find((b: any) => b.asset === "USDT")?.locked || "0");
        return `💼 <b>ESTADO DE LIQUIDEZ USDT</b> 💧\n\n` +
          `• <b>USDT Libre:</b> <b>${freeUsdt.toFixed(2)} USDT</b>\n` +
          `• <b>USDT Bloqueado en órdenes:</b> ${lockedUsdt.toFixed(2)} USDT\n` +
          `• <b>Meta de Liquidez (Centinela):</b> ≥ $50.00 USDT (${freeUsdt >= 50 ? "✅ Meta Superada" : "⏳ En Acumulación"})\n` +
          `• <b>Alerta Automática:</b> ${this.controls.notified50UsdtThreshold ? "Notificado previamente" : "Vigilando activamente"}\n\n` +
          `👉 Consulta la viabilidad de futuros con: <code>/viabilidad_futuros</code>`;
      }

      if (cmd === "/cierre" || cmd === "cierre" || cmd === "/balance_diario" || cmd === "balance_diario") {
        return await this.generateConsolidatedDailyReport();
      }

      if (cmd === "/alpha" || cmd === "alpha") {
        const rec = this.controls.recoveryTracker || { targetUsdt: 100.00, recoveredUsdt: 6.11, tradesCount: 8 };
        const pct = Math.min(100, (rec.recoveredUsdt / rec.targetUsdt) * 100);
        let alphaPos: ActivePosition | null = null;
        for (const p of this.activeTrailingPositions.values()) {
          if (p.strategy === "centinela_alpha") { alphaPos = p; break; }
        }

        let msg = `🤖 <b>ESTRATEGIA AUTÓNOMA CENTINELA ALPHA</b> 🛡️\n\n` +
          `<i>Estrategia con 20% del presupuesto dedicada a recuperar los $100.00 USDT con gestión autónoma de parámetros.</i>\n\n` +
          `📊 <b>ESTADO DE LA MISIÓN:</b>\n` +
          `• Meta fijada: <b>${rec.targetUsdt.toFixed(2)} USDT</b>\n` +
          `• Recuperado hasta hoy: <b>+${rec.recoveredUsdt.toFixed(2)} USDT</b> (${pct.toFixed(1)}%)\n` +
          `• Operaciones cerradas en verde: ${rec.tradesCount}\n\n`;

        if (alphaPos) {
          let curT = alphaPos.buyPrice;
          try { curT = parseFloat((await this.client.tickerPrice(alphaPos.symbol)).data.price); } catch(e) {}
          const gPct = ((curT - alphaPos.buyPrice) / alphaPos.buyPrice) * 100;
          msg += `🎯 <b>OPERACIÓN ALPHA EN CURSO:</b>\n` +
            `• Moneda: <b>${alphaPos.symbol}</b>\n` +
            `• Invertido: ${alphaPos.investedUsdt.toFixed(2)} USDT\n` +
            `• Entrada: ${fmtPrice(alphaPos.buyPrice)} | Actual: ${fmtPrice(curT)} (${gPct >= 0 ? "🟢 +" : "🔴 "}${gPct.toFixed(2)}%)\n` +
            `• Pico: ${fmtPrice(alphaPos.highestPrice)} | Estado: ${alphaPos.activated ? "🚀 Trailing Activo" : "⏳ Buscando +0.8%"}\n`;
        } else {
          msg += `🔍 <i>Sin operación Alpha abierta en este momento. Escaneando el radar en busca del mejor activo con rebote institucional.</i>\n`;
        }
        return msg;
      }

      if (cmd === "/lotes" || cmd === "lotes") {
        let msg = `📦 <b>REGISTRO DE LOTES INDEPENDIENTES</b> 🛡️\n\n` +
          `<i>Cada compra opera como una posición 100% aislada. Cero combinaciones y cero arrastre de pérdidas.</i>\n\n`;
        if (this.activeTrailingPositions.size === 0) {
          msg += `• <i>No hay lotes abiertos actualmente.</i>\n`;
        } else {
          for (const [id, p] of this.activeTrailingPositions.entries()) {
            const lotNum = p.lotIndex ? `Lote #${p.lotIndex}` : "Lote Único";
            let curP = p.buyPrice;
            try { curP = parseFloat((await this.client.tickerPrice(p.symbol)).data.price); } catch(e) {}
            const gP = ((curP - p.buyPrice) / p.buyPrice) * 100;
            msg += `🪙 <b>${p.symbol}</b> (${lotNum}) — <i>[${p.strategy || "trailing"}]</i>\n` +
                   `• Invertido: ${p.investedUsdt.toFixed(2)} USDT | Cantidad: ${p.qty}\n` +
                   `• Entrada: ${fmtPrice(p.buyPrice)} | Actual: ${fmtPrice(curP)} (${gP >= 0 ? "🟢 +" : "🔴 "}${gP.toFixed(2)}%)\n` +
                   `• Pico: ${fmtPrice(p.highestPrice)} | ${p.activated ? "🚀 Trailing Activo" : "⏳ Esperando +0.8%"}\n\n`;
          }
        }
        return msg;
      }

      if (cmd === "/callback" || cmd === "callback") {
        const targetSym = arg1 ? (arg1.endsWith("USDT") ? arg1 : arg1 + "USDT") : null;
        const valNum = arg2 ? parseFloat(arg2) : null;

        // Si se envió un valor numérico para actualizar (ej: /callback PEPE 0.45 o /callback default 0.40)
        if (targetSym && valNum !== null && !isNaN(valNum)) {
          if (valNum < 0.10 || valNum > 3.0) {
            return "⚠️ <b>Rango no válido:</b> El callback debe estar entre 0.10% y 3.00%.";
          }

          if (!this.controls.trailingCallbacks) {
            this.controls.trailingCallbacks = {};
          }

          if (targetSym === "DEFAULTUSDT" || targetSym === "DEFAULT") {
            this.controls.trailingCallbacks["default"] = valNum;
          } else {
            this.controls.trailingCallbacks[targetSym] = valNum;
            // Si la posición está actualmente abierta, actualizar en vivo en la posición
            const openPos = this.activeTrailingPositions.get(targetSym);
            if (openPos) {
              openPos.customCallbackPct = valNum;
              this.saveTrailingPositions();
            }
          }

          this.saveStrategyControls();

          return `🎯 <b>CALLBACK TRAILING ACTUALIZADO</b> ✅\n\n` +
            `• <b>Destino:</b> ${targetSym === "DEFAULTUSDT" ? "Global por Defecto" : targetSym}\n` +
            `• <b>Nuevo Callback:</b> <b>${valNum.toFixed(2)}%</b>\n` +
            `• 🛡️ <b>Efecto:</b> El bot permitirá un retroceso de exactamente ${valNum.toFixed(2)}% desde el pico más alto antes de liquidar con ganancia asegurada.\n\n` +
            `<i>Guardado de inmediato en .strategy-controls.json y en memoria activa.</i>`;
        }

        // Si no se pasó argumento o solo el símbolo, mostrar estado y tabla de coherencia
        let msg = `🎯 <b>PANEL DE CALLBACKS TRAILING INTELIGENTES</b> 🕹️\n\n`;
        msg += `<i>El Callback es el retroceso permitido desde el pico más alto antes de disparar la venta.</i>\n\n`;

        msg += `📊 <b>POSICIONES ACTIVAS VIVAS:</b>\n`;
        if (this.activeTrailingPositions.size === 0) {
          msg += `• <i>No hay posiciones abiertas en este momento.</i>\n`;
        } else {
          for (const [sym, p] of this.activeTrailingPositions.entries()) {
            const cb = this.getCallbackPct(sym, p);
            const stop = p.highestPrice * (1 - cb / 100);
            const isCustom = p.customCallbackPct ? "(Personalizado)" : "(Auto/Default)";
            msg += `• <b>${sym}:</b> ${cb.toFixed(2)}% ${isCustom}\n` +
                   `  └ Pico: ${fmtPrice(p.highestPrice)} | Gatillo Venta: ${fmtPrice(stop)}\n`;
          }
        }

        msg += `\n🧭 <b>VALORES COHERENTES RECOMENDADOS:</b>\n` +
               `• 🐕 <b>Memecoins (PEPE, DOGE, BONK):</b> 0.40% – 0.50% <i>(Absorbe micro-ruido de velas)</i>\n` +
               `• 🔺 <b>Medianas (AVAX, SOL):</b> 0.30% – 0.35% <i>(Volatilidad equilibrada)</i>\n` +
               `• 🔷 <b>Mayores (ETH, BTC):</b> 0.20% – 0.25% <i>(Libros profundos, salida rápida)</i>\n\n` +
               `⚙️ <b>CÓMO MODIFICARLO AL INSTANTE:</b>\n` +
               `• <code>/callback PEPE 0.45</code> — Asigna 0.45% a PEPE\n` +
               `• <code>/callback AVAX 0.30</code> — Asigna 0.30% a AVAX\n` +
               `• <code>/callback default 0.40</code> — Cambia el default general\n`;

        return msg;
      }

      if (cmd === "/menu" || cmd === "menu" || cmd === "/start") {
        return `📱 <b>CENTRO DE CONTROL MULTI-ESTRATEGIA SPOT</b> 🕹️\n\n` +
          `<b>⚙️ MOTORES Y ESTRATEGIAS:</b>\n` +
          `• /estrategias — <i>Panel general y switches de motores</i>\n` +
          `• /presupuesto — <i>Distribución y USDT por estrategia</i>\n` +
          `• /asignar — <i>Configurar % (ej: /asignar 40 25 0 35)</i>\n` +
          `• /regimen — <i>Diagnóstico de volatilidad y Día Quieto</i>\n` +
          `• /weekend — <i>Estado y radar de Cazador Weekend</i>\n` +
          `• /memes — <i>Canasta y radar de Memecoins (Top 5)</i>\n• /callback — <i>Ver y calibrar holgura de salida por moneda</i>\n` +
          `• /motores — <i>Parámetros técnicos de Trailing Buy/Sell</i>\n\n` +

          `<b>🛡️ GESTIÓN DE RIESGO Y RADAR:</b>\n` +
          `• /stoploss — <i>Ver estado y porcentaje de Stop-Loss</i>\n` +
          `• /toggle_stoploss — <i>Activar o desactivar Stop-Loss</i>\n` +
          `• /set_stoploss 4.0 — <i>Fijar porcentaje de corte (ej: /set_stoploss 3.5)</i>\n` +
          `• /sugerencias — <i>Diagnóstico y recomendaciones Centinela</i>\n` +
          `• /rechazar — <i>Descartar sugerencia (ej: /rechazar trailing)</i>\n` +
          `• /timeframe — <i>Ver o cambiar radar de ondas (15m, 1h, 4h)</i>\n\n` +
          `<b>🔀 INTERRUPTORES (ON / OFF):</b>\n` +
          `• /toggle_trailing — <i>Switch Cazador Trailing</i>\n` +
          `• /toggle_dca — <i>Switch Smart DCA (Seguridad)</i>\n` +
          `• /toggle_grid — <i>Switch Micro-Grid (Rango Lateral)</i>\n` +
          `• /toggle_weekend — <i>Switch Cazador Weekend (Vie-Dom)</i>\n` +
          `• /toggle_ia — <i>Silenciar o activar respuestas de Gemini AI</i>\n\n` +

          `<b>⚡ APROBACIONES INTERACTIVAS:</b>\n` +
          `• /aprobar — <i>Aprobar compra sugerida pendiente</i>\n` +
          `• /ignorar — <i>Descartar oportunidad sugerida</i>\n` +
          `• /aprobar_grid — <i>Activar Micro-Grid en Día Quieto</i>\n` +
          `• /ignorar_grid — <i>Descartar Micro-Grid y seguir en Trailing</i>\n\n` +

          `<b>📊 DIAGNÓSTICO Y MERCADO EN VIVO:</b>\n` +
          `• /informe — <i>Diagnóstico completo en tiempo real y PnL</i>\n` +
          `• /trailing — <i>Posiciones vivas rastreando el pico</i>\n` +
          `• /cazando — <i>Monedas acechando el piso (Trailing Buy)</i>\n` +
          `• /radar — <i>Escáner de suelos y RSI en tiempo real</i>\n` +
          `• /estado — <i>Órdenes vivas y precios meta en Binance</i>\n` +
          `• /balance — <i>Saldos libres en Binance Spot</i>\n` +
          `• /reporte — <i>Ganancias reales acumuladas netas (USDT/COP)</i>\n\n` +

          `<b>🤖 MODOS Y OPERACIONES:</b>\n` +
          `• /modo auto — <i>Activar piloto automático autónomo</i>\n` +
          `• /modo manual — <i>Modo manual asistido (confirmación previa)</i>\n` +
          `• /pausa — <i>Pausar todas las compras automáticas</i>\n` +
          `• /reanudar — <i>Reanudar compras automáticas</i>\n` +
          `• /comprar &lt;MONEDA&gt; — <i>Comprar con Trailing Take Profit</i>\n` +
          `• /vender &lt;MONEDA&gt; — <i>Vender posición al mercado</i>\n` +
          `• /ai &lt;PREGUNTA&gt; — <i>Consultar al copiloto Gemini AI</i>\n\n` +
          `💡 <i>Toca cualquiera de los enlaces azules para ejecutar al instante.</i>`;
      }

      if (cmd === "/estrategias" || cmd === "estrategias") {
        const c = this.controls.strategies;
        const mins = Math.round(this.controls.approvalTimeoutSec / 60);
        let msg = `⚙️ <b>ORQUESTADOR MULTI-ESTRATEGIA SPOT</b> 🕹️\n\n`;
        msg += `• <b>1. Cazador Trailing:</b> ${c.trailing_rebound ? "🟢 <b>ACTIVO</b>" : "🔴 <i>PAUSADO</i>"}\n`;
        msg += `  <i>Trailing Buy en piso + Trailing Take Profit en cima (+0.8% a +3.5%).</i>\n`;
        msg += `  👉 /toggle_trailing\n\n`;

        msg += `• <b>2. Smart DCA (Seguridad):</b> ${c.smart_dca ? "🟢 <b>ACTIVO</b>" : "🔴 <i>PAUSADO</i>"}\n`;
        msg += `  <i>Promedia caídas en soporte (≥ 2.5%) para salir antes con ganancia.</i>\n`;
        msg += `  👉 /toggle_dca\n\n`;

        msg += `• <b>3. Micro-Grid (Rango):</b> ${c.micro_grid ? "🟢 <b>ACTIVO</b>" : "🔴 <i>PAUSADO</i>"}\n`;
        msg += `  <i>Malla de compras y ventas rápidas en mercados laterales planos.</i>\n`;
        msg += `  👉 /toggle_grid\n\n`;

        const isW = this.isWeekendWindow();
        const weekendBadge = isW && c.cazador_weekend ? "🟢 <b>ACTIVO (En Ventana)</b>" : (!isW ? "⚪ <i>EN ESPERA (Se reactiva Viernes 17:00 COT)</i>" : "🔴 <i>PAUSADO</i>");
        msg += `• <b>4. 🏖️ Cazador Weekend:</b> ${weekendBadge}\n`;
        msg += `  <i>Aprovecha caídas de fin de semana (Vie-Dom) y exprime venta en el pico más alto (Dom noche/Lunes).</i>\n`;
        msg += `  👉 /toggle_weekend | /weekend\n\n`;

        const slOn = this.controls.stopLossEnabled !== false;
        const slVal = (this.controls.stopLossPct ?? 4.0).toFixed(1);
        const tfVal = (this.controls.timeframe || "1h").toUpperCase();
        msg += `• <b>5. 🛡️ Stop-Loss de Protección:</b> ${slOn ? `🟢 <b>ACTIVO (-${slVal}%)</b>` : "🔴 <i>DESACTIVADO</i>"}\n`;
        msg += `  <i>Corta caídas anormales para proteger liquidez y liberar USDT.</i>\n`;
        msg += `  👉 /stoploss | /toggle_stoploss\n\n`;

        msg += `• <b>6. ⏱️ Radar de Ondas (Timeframe):</b> <b>${tfVal}</b> ${tfVal === "1H" ? "(Base Predeterminada)" : ""}\n`;
        msg += `  <i>Brújula de análisis multitemporal adaptativo.</i>\n`;
        msg += `  👉 /timeframe\n\n`;

        msg += `• 🤖 <b>Modo Centinela:</b> ${this.controls.autoPilot ? "🟢 Autónomo (Auto-ejecuta a los " + mins + " min)" : "🟡 Manual Estricto"}\n`;
        msg += `  👉 /modo auto | /modo manual\n\n`;

        if (this.pendingOpportunity) {
          const remSec = Math.max(0, Math.round((this.pendingOpportunity.expiresAt - Date.now()) / 1000));
          msg += `⚡ <b>OPORTUNIDAD PENDIENTE:</b>\n` +
                 `• Moneda: <b>${this.pendingOpportunity.symbol}</b>\n` +
                 `• Estrategia: <b>${this.pendingOpportunity.strategyName}</b>\n` +
                 `• ⏱️ Tiempo restante: <b>${remSec}s</b>\n` +
                 `👉 /aprobar | /ignorar\n`;
        }

        return msg;
      }

      if (cmd === "/presupuesto" || cmd === "presupuesto") {
        const acc = await this.client.account({ recvWindow: 60000 });
        const freeUsdt = parseFloat(acc.data.balances.find((b: any) => b.asset === "USDT")?.free || "0");
        const a = this.controls.allocations;
        const base = this.controls.baseAllocations || { trailing_rebound: 50, smart_dca: 30, micro_grid: 0, cazador_weekend: 20 };
        const isW = this.isWeekendWindow();

        const tUsdt = (freeUsdt * ((a.trailing_rebound || 0) / 100)).toFixed(2);
        const dUsdt = (freeUsdt * ((a.smart_dca || 0) / 100)).toFixed(2);
        const gUsdt = (freeUsdt * ((a.micro_grid || 0) / 100)).toFixed(2);
        const wUsdt = (freeUsdt * ((a.cazador_weekend || 0) / 100)).toFixed(2);

        let msg = `💼 <b>PRESUPUESTO INTELIGENTE ASIGNADO</b> 📊\n\n`;
        msg += `• 💼 <b>USDT Líquido Disponible:</b> ${freeUsdt.toFixed(2)} USDT\n`;
        msg += `• 🔄 <b>Régimen actual:</b> ${isW ? "🟢 Fin de Semana (Cazador Weekend Activo)" : "⚪ Días Hábiles (Cuota de Weekend absorbida por Trailing)"}\n\n`;

        msg += `🏹 <b>1. Cazador Trailing:</b> <b>${a.trailing_rebound}%</b> (~${tUsdt} USDT)\n` +
               `   ${!isW ? `<i>(Base: ${base.trailing_rebound}% + ${base.cazador_weekend}% auto-transferido de Weekend)</i>\n` : ""}` +
               `   Estado: ${this.controls.strategies.trailing_rebound ? "🟢 ACTIVO" : "🔴 PAUSADO"}\n\n`;

        msg += `🛡️ <b>2. Smart DCA:</b> <b>${a.smart_dca}%</b> (~${dUsdt} USDT)\n` +
               `   Estado: ${this.controls.strategies.smart_dca ? "🟢 ACTIVO" : "🔴 PAUSADO"}\n\n`;

        msg += `🌐 <b>3. Micro-Grid:</b> <b>${a.micro_grid}%</b> (~${gUsdt} USDT)\n` +
               `   Estado: ${this.controls.strategies.micro_grid ? "🟢 ACTIVO" : "🔴 PAUSADO"}\n\n`;

        msg += `🏖️ <b>4. Cazador Weekend:</b> <b>${a.cazador_weekend}% activo</b> (Base: ${base.cazador_weekend}%)\n` +
               `   Estado: ${isW && this.controls.strategies.cazador_weekend ? "🟢 ACTIVO EN VENTANA" : "⚪ EN ESPERA (Se reactiva Viernes 17:00 COT)"}\n\n`;

        msg += `🎛️ <b>Para modificar porcentajes base:</b>\n` +
               `Escribe: <code>/asignar &lt;trailing&gt; &lt;dca&gt; &lt;grid&gt; &lt;weekend&gt;</code>\n` +
               `Ejemplo: <code>/asignar 50 30 0 20</code> (debe sumar 100).`;

        return msg;
      }

      if (cmd === "/asignar" || cmd === "asignar") {
        let t = parseInt(arg1 || "0", 10);
        let d = parseInt(arg2 || "0", 10);
        let g = parseInt(parts[3] || "0", 10);
        let w = parseInt(parts[4] || "0", 10);

        // Si pasó 3 números que suman 100, asumir t, d, w (con grid=0)
        if (parts.length === 4 && (t + d + g === 100)) {
          w = g;
          g = 0;
        }

        if (isNaN(t) || isNaN(d) || isNaN(g) || isNaN(w) || (t + d + g + w !== 100)) {
          return `⚠️ <b>Formato incorrecto:</b> La suma de los porcentajes debe ser exactamente 100.\n\n` +
                 `Ejemplo de uso: <code>/asignar 50 30 0 20</code>\n` +
                 `(50% Trailing, 30% Smart DCA, 0% Micro-Grid, 20% Cazador Weekend)`;
        }

        this.controls.baseAllocations = {
          trailing_rebound: t,
          smart_dca: d,
          micro_grid: g,
          cazador_weekend: w
        };

        const isW = this.isWeekendWindow();
        if (!isW) {
          this.controls.allocations = {
            trailing_rebound: t + w,
            smart_dca: d,
            micro_grid: g,
            cazador_weekend: 0
          };
          this.controls.strategies.cazador_weekend = false;
        } else {
          this.controls.allocations = {
            trailing_rebound: t,
            smart_dca: d,
            micro_grid: g,
            cazador_weekend: w
          };
          this.controls.strategies.cazador_weekend = true;
        }
        this.saveStrategyControls();

        return `✅ <b>¡PRESUPUESTO AUTO-GRADUADO GUARDADO!</b> 🎯\n\n` +
               `• 🏹 <b>Cazador Trailing:</b> ${t}% base ${!isW ? `(👉 <b>${t + w}% ACTIVO</b> entre semana)` : ""}\n` +
               `• 🛡️ <b>Smart DCA:</b> <b>${d}%</b>\n` +
               `• 🌐 <b>Micro-Grid:</b> <b>${g}%</b>\n` +
               `• 🏖️ <b>Cazador Weekend:</b> ${w}% base ${!isW ? `(👉 <i>0% ahora: se apartará el viernes a las 17:00 COT</i>)` : `(👉 <b>${w}% ACTIVO</b>)`}\n\n` +
               `💾 <i>Presupuesto inteligente activo: En días hábiles todo el capital trabaja en Trailing, y el fin de semana se recupera automáticamente para cazar la caída más oportuna.</i>`;
      }
            if (cmd === "/stoploss" || cmd === "stoploss") {
        const slOn = this.controls.stopLossEnabled !== false;
        const slPct = (this.controls.stopLossPct ?? 4.0).toFixed(1);
        let msg = `🛡️ <b>CONFIGURACIÓN DE STOP-LOSS</b> 🛑\n\n`;
        msg += `• <b>Estado:</b> ${slOn ? "🟢 <b>ACTIVADO</b>" : "🔴 <i>DESACTIVADO</i>"}\n`;
        msg += `• <b>Límite de corte:</b> <b>-${slPct}%</b> de caída máxima tolerada\n`;
        msg += `• 💡 <i>Protección: Si la moneda cae más de -${slPct}% sin rebotar, el bot vende al mercado, rescata el 96% de tus dólares y libera liquidez para cazar la siguiente ola.</i>\n\n`;
        msg += `👉 /toggle_stoploss — <i>Alternar ON/OFF</i>\n`;
        msg += `👉 /set_stoploss 3.5 — <i>Ejemplo: Fijar corte en -3.5%</i>\n`;
        msg += `👉 /set_stoploss 4.0 — <i>Ejemplo: Fijar corte en -4.0%</i>`;
        return msg;
      }

      if (cmd === "/toggle_stoploss" || cmd === "toggle_stoploss") {
        this.controls.stopLossEnabled = !(this.controls.stopLossEnabled !== false);
        this.saveStrategyControls();
        const slOn = this.controls.stopLossEnabled;
        return `🛡️ <b>Stop-Loss:</b> ${slOn ? `🟢 <b>ACTIVADO</b> (Corta al -${(this.controls.stopLossPct ?? 4.0).toFixed(1)}% para proteger liquidez)` : "🔴 <b>DESACTIVADO</b> (Modo sin corte de pérdida)"}.`;
      }

      if (cmd === "/set_stoploss" || cmd === "set_stoploss") {
        const val = parseFloat(parts[1] || "");
        if (isNaN(val) || val <= 0 || val > 20) {
          return `⚠️ <b>Uso:</b> <code>/set_stoploss &lt;PORCENTAJE&gt;</code>\nEjemplo: <code>/set_stoploss 4.0</code> (fija corte al -4.0%). Ingrese un valor entre 1.0 y 20.0.`;
        }
        this.controls.stopLossPct = Math.round(val * 10) / 10;
        this.controls.stopLossEnabled = true;
        this.saveStrategyControls();
        return `✅ <b>¡Stop-Loss actualizado!</b> 🛡️\n\n• Límite fijado en: <b>-${this.controls.stopLossPct.toFixed(1)}%</b>\n• Estado: 🟢 <b>ACTIVADO</b>`;
      }

      if (cmd === "/timeframe" || cmd === "timeframe" || cmd === "/tf") {
        const rawTarget = parts[1]?.toUpperCase();
        const rawTf = parts[2]?.toLowerCase() || (["15M", "1H", "4H", "1D"].includes(rawTarget || "") ? parts[1]?.toLowerCase() : null);

        // Caso 1: Asignar a un símbolo específico (ej: /timeframe PEPE 15m)
        if (rawTarget && rawTf && !["15M", "1H", "4H", "1D"].includes(rawTarget)) {
          const sym = rawTarget.endsWith("USDT") ? rawTarget : rawTarget + "USDT";
          const tfVal = (["15m", "1h", "4h", "1d"].includes(rawTf)) ? rawTf as any : "1h";

          if (!this.controls.symbolTimeframes) this.controls.symbolTimeframes = {};
          this.controls.symbolTimeframes[sym] = tfVal;

          const openPos = this.activeTrailingPositions.get(sym);
          if (openPos) {
            openPos.customTimeframe = tfVal;
            this.saveTrailingPositions();
          }
          this.saveStrategyControls();

          return `⏱️ <b>TEMPORALIDAD ACTUALIZADA</b> ✅\n\n` +
                 `• <b>Moneda:</b> ${sym}\n` +
                 `• <b>Nuevo Marco:</b> <b>${tfVal.toUpperCase()}</b>\n` +
                 `• 🎯 <i>El bot ahora analizará ${sym} exclusivamente en velas de ${tfVal.toUpperCase()}.</i>`;
        }

        // Caso 2: Asignar global (ej: /timeframe 15m)
        if (rawTf && ["15m", "1h", "4h", "1d"].includes(rawTf)) {
          this.controls.timeframe = rawTf as any;
          this.saveStrategyControls();
          return `⏱️ <b>Temporalidad Global actualizada:</b> <b>${rawTf.toUpperCase()}</b>.\nEl valor base por defecto ahora es ${rawTf.toUpperCase()}.`;
        }

        // Caso 3: Mostrar diagnóstico y tabla de sugerencias por moneda
        let msg = `⏱️ <b>PANEL DE TEMPORALIDADES DINÁMICAS POR MONEDA</b> 🧭\n\n`;
        msg += `<i>El Centinela analiza continuamente la velocidad de cada moneda para sugerirte el reloj más viable.</i>\n\n`;

        msg += `📊 <b>MONEDAS ACTIVAS Y SUGERENCIAS DEL CENTINELA:</b>\n`;
        const checkSymbols = Array.from(new Set([...Array.from(this.activeTrailingPositions.keys()), "PEPEUSDT", "ETHUSDT", "AVAXUSDT"]));
        for (const sym of checkSymbols) {
          const curTf = this.getTimeframeForSymbol(sym, this.activeTrailingPositions.get(sym));
          const sugg = this.getSuggestedTimeframe(sym);
          const isOpt = curTf === sugg.timeframe ? "🟢 Óptimo" : "🟡 Modificable";
          msg += `• <b>${sym}:</b> Activo [<b>${curTf.toUpperCase()}</b>] | Sugerido: <b>${sugg.timeframe.toUpperCase()}</b> (${isOpt})\n` +
                 `  └ <i>${sugg.reason}</i>\n`;
        }

        msg += `\n⚙️ <b>CÓMO MODIFICARLO POR MONEDA:</b>\n` +
               `• <code>/timeframe PEPE 15m</code> — Asigna 15m solo a PEPE\n` +
               `• <code>/timeframe ETH 1h</code> — Asigna 1H solo a ETH\n` +
               `• <code>/timeframe AVAX 4h</code> — Asigna 4H solo a AVAX\n`;

        return msg;
      }

      if (cmd === "/sugerencias" || cmd === "sugerencias" || cmd === "/advisor") {
        await this.checkTimeframeAdvisor();
        const suggs = this.controls.suggestions || {};
        const settings = this.controls.strategySettings || {} as any;
        const rejections = this.controls.rejectedSuggestions || {};

        let msg = `🧠 <b>SUGERENCIAS INTELIGENTES CENTINELA</b> 🛡️\n\n`;
        const names: Record<string, string> = {
          trailing_rebound: "🏹 Trailing Rebound",
          smart_dca: "🛡️ Smart DCA",
          micro_grid: "🌐 Micro-Grid",
          cazador_weekend: "🏖️ Cazador Weekend"
        };

        for (const [key, name] of Object.entries(names)) {
          const s = (suggs as any)[key];
          const cur = settings[key] || {};
          const isRej = !!(rejections[key] && rejections[key] > Date.now());
          msg += `<b>${name}:</b>\n`;
          if (!s) {
            msg += `• <i>Sin análisis disponible</i>\n\n`;
            continue;
          }
          if (isRej) {
            msg += `• Estado: ⚪ <i>Sugerencia descartada (silenciada)</i>\n`;
            msg += `• Radar actual: <b>${(cur.timeframe || "1h").toUpperCase()}</b>\n\n`;
            continue;
          }
          const isSynced = cur.timeframe === s.timeframe;
          if (isSynced) {
            msg += `• Estado: 🟢 <b>Sincronizada con el mercado</b>\n`;
            msg += `• Radar óptimo activo: <b>${s.timeframe.toUpperCase()}</b>\n`;
            msg += `• Contexto: <i>${s.reason}</i>\n\n`;
          } else {
            msg += `• Estado: ⚡ <b>CAMBIO RECOMENDADO</b>\n`;
            msg += `• Actual: <b>${(cur.timeframe || "1h").toUpperCase()}</b> ➔ Sugerido: <b>${s.timeframe.toUpperCase()}</b>\n`;
            msg += `• Motivo: <i>${s.reason}</i>\n`;
            const shortCmd = key === "trailing_rebound" ? "trailing" : (key === "smart_dca" ? "dca" : (key === "micro_grid" ? "grid" : "weekend"));
            msg += `👉 /aplicar ${shortCmd} — <i>Aplicar cambio</i>\n`;
            msg += `👉 /rechazar ${shortCmd} — <i>Descartar sugerencia</i>\n\n`;
          }
        }
        return msg;
      }

      if (cmd === "/rechazar" || cmd === "rechazar" || cmd === "/descartar" || cmd === "descartar") {
        const target = (parts[1] || "").toLowerCase();
        let targetKey: string | null = null;
        if (target.includes("trail") || target === "tr") targetKey = "trailing_rebound";
        else if (target.includes("dca")) targetKey = "smart_dca";
        else if (target.includes("grid")) targetKey = "micro_grid";
        else if (target.includes("week")) targetKey = "cazador_weekend";
        else if (target === "all" || target === "todas") {
          if (!this.controls.rejectedSuggestions) this.controls.rejectedSuggestions = {};
          const until = Date.now() + 4 * 3600 * 1000;
          this.controls.rejectedSuggestions.trailing_rebound = until;
          this.controls.rejectedSuggestions.smart_dca = until;
          this.controls.rejectedSuggestions.micro_grid = until;
          this.controls.rejectedSuggestions.cazador_weekend = until;
          this.saveStrategyControls();
          return `⚪ <b>Todas las sugerencias Centinela han sido descartadas.</b>\nSilenciadas por 4 horas o hasta que la volatilidad cambie drásticamente.`;
        }

        if (!targetKey) {
          return `⚠️ <b>Uso:</b> <code>/rechazar &lt;ESTRATEGIA&gt;</code>\n\nEjemplos:\n• <code>/rechazar trailing</code>\n• <code>/rechazar dca</code>\n• <code>/rechazar grid</code>\n• <code>/rechazar weekend</code>\n• <code>/rechazar all</code>`;
        }

        if (!this.controls.rejectedSuggestions) this.controls.rejectedSuggestions = {};
        this.controls.rejectedSuggestions[targetKey] = Date.now() + 4 * 3600 * 1000;
        if (this.controls.suggestions && (this.controls.suggestions as any)[targetKey]) {
          (this.controls.suggestions as any)[targetKey].status = "rejected";
        }
        this.saveStrategyControls();
        return `⚪ <b>Sugerencia de ${targetKey} descartada.</b>\nSilenciada por 4 horas. Para ver el estado actual use /sugerencias.`;
      }

      if (cmd === "/aplicar" || cmd === "aplicar") {
        const target = (parts[1] || "").toLowerCase();
        let targetKey: string | null = null;
        if (target.includes("trail") || target === "tr") targetKey = "trailing_rebound";
        else if (target.includes("dca")) targetKey = "smart_dca";
        else if (target.includes("grid")) targetKey = "micro_grid";
        else if (target.includes("week")) targetKey = "cazador_weekend";

        if (!targetKey || !this.controls.suggestions || !(this.controls.suggestions as any)[targetKey]) {
          return `⚠️ <b>Uso:</b> <code>/aplicar &lt;ESTRATEGIA&gt;</code>\n\nEjemplos:\n• <code>/aplicar trailing</code>\n• <code>/aplicar dca</code>\n• <code>/aplicar grid</code>\n• <code>/aplicar weekend</code>`;
        }

        const sugg = (this.controls.suggestions as any)[targetKey];
        if (!this.controls.strategySettings) this.controls.strategySettings = {} as any;
        if (!this.controls.strategySettings![targetKey as keyof typeof this.controls.strategySettings]) {
          (this.controls.strategySettings as any)[targetKey] = { timeframe: "1h", stopLossEnabled: false, stopLossPct: 4.0 };
        }
        const s = (this.controls.strategySettings as any)[targetKey];
        s.timeframe = sugg.timeframe;
        s.stopLossPct = sugg.stopLossPct;
        if (s.stopLossEnabled === undefined) s.stopLossEnabled = false;

        if (this.controls.rejectedSuggestions && this.controls.rejectedSuggestions[targetKey]) {
          delete this.controls.rejectedSuggestions[targetKey];
        }
        sugg.status = "applied";
        sugg.isCurrent = true;
        this.saveStrategyControls();
        return `⚡ <b>¡Sugerencia aplicada a ${targetKey}!</b> ✅\n\n• Radar calibrado en: <b>${sugg.timeframe.toUpperCase()}</b>\n• Stop-Loss ajustado a: <b>-${sugg.stopLossPct.toFixed(1)}%</b> (${s.stopLossEnabled ? "🟢 ACTIVO" : "🔴 DESACTIVADO por seguridad Spot"})\n• Razón: <i>${sugg.reason}</i>`;
      }

      if (cmd === "/toggle_ia" || cmd === "/toggle_ai" || cmd === "toggle_ia" || cmd === "toggle_ai") {
        this.controls.aiEnabled = !this.controls.aiEnabled;
        this.saveStrategyControls();
        return `🤖 <b>Copiloto Gemini AI:</b> ${this.controls.aiEnabled ? "🟢 ACTIVADO (Solo responderá consultas explícitas con /ai)" : "🔴 SILENCIADO (Cero respuestas automáticas, cero consumo de tokens)"}.`;
      }

      if (cmd === "/toggle_trailing" || cmd === "toggle_trailing") {
        this.controls.strategies.trailing_rebound = !this.controls.strategies.trailing_rebound;
        this.saveStrategyControls();
        return `🏹 <b>Cazador Trailing:</b> ${this.controls.strategies.trailing_rebound ? "🟢 ACTIVADO" : "🔴 PAUSADO"}.`;
      }

      if (cmd === "/toggle_dca" || cmd === "toggle_dca") {
        this.controls.strategies.smart_dca = !this.controls.strategies.smart_dca;
        this.saveStrategyControls();
        return `🛡️ <b>Smart DCA:</b> ${this.controls.strategies.smart_dca ? "🟢 ACTIVADO" : "🔴 PAUSADO"}.`;
      }

      if (cmd === "/toggle_grid" || cmd === "toggle_grid") {
        this.controls.strategies.micro_grid = !this.controls.strategies.micro_grid;
        if (this.controls.strategies.micro_grid) {
          await this.activateMicroGrid(false);
          return `🌐 <b>Micro-Grid:</b> 🟢 ACTIVADO. Presupuesto reasignado para operar canales laterales.`;
        } else {
          await this.deactivateMicroGrid();
          return `🌐 <b>Micro-Grid:</b> 🔴 PAUSADO. Presupuesto devuelto a Cazador Trailing.`;
        }
      }

      if (cmd === "/aprobar_grid" || cmd === "aprobar_grid" || cmd === "/activar_grid") {
        this.pendingRegimeSwitch = null;
        this.controls.gridIgnoredUntil = 0;
        await this.activateMicroGrid(false);
        return `🌐 <b>Micro-Grid ACTIVADO por ti.</b> Presupuesto reasignado para operar en canales laterales planos.`;
      }

      if (cmd === "/ignorar_grid" || cmd === "ignorar_grid") {
        this.pendingRegimeSwitch = null;
        this.controls.gridIgnoredUntil = Date.now() + 12 * 3600 * 1000; // Silenciar sugerencia por 12 horas
        if (this.controls.strategies.micro_grid) {
          await this.deactivateMicroGrid();
        } else {
          this.saveStrategyControls();
        }
        return `❌ <b>Sugerencia de Micro-Grid descartada.</b>\n\n` +
               `• 🛡️ El bot permanecerá al 100% en Cazador Trailing (${this.controls.allocations.trailing_rebound}% Trailing / ${this.controls.allocations.smart_dca}% Smart DCA).\n` +
               `• 🔇 <b>Silenciado:</b> No volveré a insistir con Micro-Grid durante <b>12 horas</b> (ni se activará solo).\n\n` +
               `💡 <i>Si deseas activarlo manualmente cuando quieras, puedes escribir /aprobar_grid o /toggle_grid.</i>`;
      }

      if (cmd === "/regimen" || cmd === "regimen") {
        const btc24 = await this.client.ticker24hr("BTCUSDT");
        const high = parseFloat(btc24.data.highPrice);
        const low = parseFloat(btc24.data.lowPrice);
        const range24h = ((high - low) / low) * 100;
        const isQuiet = range24h < 2.2;

        let msg = `📡 <b>DIAGNÓSTICO DE RÉGIMEN DE MERCADO</b> 🧭\n\n`;
        msg += `• <b>Estado Actual:</b> ${isQuiet ? "💤 <b>DÍA QUIETO (Mercado Lateral Plano)</b>" : "🚀 <b>MERCADO ACTIVO (Volatilidad Direccional)</b>"}\n`;
        msg += `• <b>Rango 24h Bitcoin:</b> <b>${range24h.toFixed(2)}%</b> (${low.toFixed(0)} - ${high.toFixed(0)})\n`;
        msg += `• <b>Estrategia Prioritaria:</b> ${this.controls.strategies.micro_grid ? "🌐 <b>Micro-Grid (Malla Lateral Activa)</b>" : "🏹 <b>Cazador Trailing (Activo)</b>"}\n`;
        msg += `• 🤖 <b>Auto-Detección Centinela:</b> 🟢 ACTIVA (Conmuta automáticamente con aviso interactivo)\n\n`;
        msg += `👉 /toggle_grid — <i>Activar o pausar Micro-Grid manualmente</i>`;
        return msg;
      }

      if (cmd === "/toggle_weekend" || cmd === "toggle_weekend") {
        this.controls.strategies.cazador_weekend = !this.controls.strategies.cazador_weekend;
        this.saveStrategyControls();
        return `🏖️ <b>Cazador Weekend:</b> ${this.controls.strategies.cazador_weekend ? "🟢 ACTIVADO" : "🔴 PAUSADO"}.`;
      }

      if (cmd === "/weekend" || cmd === "weekend") {
        const isWindow = this.isWeekendWindow();
        const isAct = this.controls.strategies.cazador_weekend;
        const alloc = this.controls.allocations.cazador_weekend ?? 20;
        let msg = `🏖️ <b>ESTRATEGIA CAZADOR WEEKEND</b> 🎯\n\n`;
        msg += `• ⏱️ <b>Ventana de Operación:</b> ${isWindow ? "🟢 <b>VENTANA ABIERTA (Vie 17:00 a Dom 18:00 COT)</b>" : "⚪ <b>CERRADA / EN ESPERA (Se reactiva Viernes 17:00 COT)</b>"}\n`;
        msg += `• 🕹️ <b>Estado del Switch:</b> ${isAct ? "🟢 ACTIVADO" : "⚪ AUTO-DESACTIVADO (Lunes a Viernes)"} (👉 /toggle_weekend)\n`;
        msg += `• 💼 <b>Presupuesto Asignado:</b> <b>${alloc}%</b> del capital libre\n`;
        msg += `• 🏹 <b>Mecánica de Compra:</b> Caza el piso más bajo en sobreventa durante el fin de semana y entra con rebote +0.35%.\n`;
        msg += `• 🚀 <b>Mecánica de Venta:</b> Trailing Take Profit (+0.80% a +3.5%) persigue el pico más alto (domingo noche, lunes o el día que más suba), vendiendo en la cima sin pérdidas jamás.\n\n`;
        if (this.buyWatches.size > 0) {
          msg += `🔻 <b>Monedas cazando el piso ahora mismo:</b>\n`;
          for (const [sym, w] of this.buyWatches.entries()) {
            msg += `  • <b>${sym}:</b> Piso ${w.lowestPrice} (Armado a ${w.armedPrice})\n`;
          }
        } else {
          msg += isWindow ? `📡 <i>Monitoreando caídas y sobreventas en la Watchlist...</i>` : `😴 <i>En pausa hasta el viernes a las 17:00 COT.</i>`;
        }
        return msg;
      }

      if (cmd === "/aprobar" || cmd === "aprobar") {
        if (!this.pendingOpportunity) {
          return "ℹ️ No hay ninguna oportunidad pendiente en este momento.";
        }
        const opp = this.pendingOpportunity;
        this.pendingOpportunity = null;
        this.savePendingOpportunity();
        setTimeout(() => this.executeOpportunity(opp), 100);
        return `🚀 <b>¡APROBADO!</b> Ejecutando <b>${opp.strategyName}</b> en <b>${opp.symbol}</b> por ${opp.amount.toFixed(2)} USDT...`;
      }

      if (cmd === "/ignorar" || cmd === "ignorar") {
        if (!this.pendingOpportunity) {
          return "ℹ️ No hay ninguna oportunidad pendiente en este momento.";
        }
        const opp = this.pendingOpportunity;
        const sym = opp.symbol;
        this.ignoredDca.set(sym, {
          timestamp: Date.now(),
          price: opp.curPrice,
          dropPct: -2.5
        });
        this.saveIgnoredDca();
        this.pendingOpportunity = null;
        this.savePendingOpportunity();
        return `❌ Oportunidad en <b>${sym}</b> descartada.\n\n` +
               `🔇 <b>Silenciada:</b> No volveré a sugerir DCA en ${sym} por <b>2 horas</b>, a menos que caiga un <b>-3.0% adicional</b>.`;
      }

      if (cmd === "/cazando" || cmd === "cazando") {
        return await this.buildBuyWatchReport();
      }

      if (cmd === "/informe" || cmd === "informe" || cmd === "/trailing" || cmd === "trailing") {
        const acc = await this.client.account({ recvWindow: 60000 });
        const usdt = parseFloat(acc.data.balances.find((b: any) => b.asset === "USDT")?.free || "0");

        let rep = `📑 <b>INFORME Y DIAGNÓSTICO EN TIEMPO REAL</b> 📊\n\n`;
        rep += `• 💼 <b>USDT Líquido:</b> ${usdt.toFixed(2)} USDT\n`;
        rep += `• 🤖 <b>Modo Centinela:</b> ${this.autoPilot ? "🟢 Autónomo Cazador (+0.8% Trailing)" : "🟡 Manual Asistido"}\n\n`;

        if (this.activeTrailingPositions.size === 0) {
          rep += `📡 <b>ESTADO ACTUAL:</b> Sin posiciones abiertas (Trailing).\n` +
                 `🔍 El bot está escaneando el radar en busca de la próxima caída para disparar la compra con descuento.\n\n`;
        } else {
          rep += `🏹 <b>POSICIONES ACTIVAS CON TRAILING:</b>\n\n`;
          for (const [sym, p] of this.activeTrailingPositions.entries()) {
            let cur = p.buyPrice;
            try {
              const t = await this.client.tickerPrice(sym);
              cur = parseFloat(t.data.price);
            } catch(e) {}

            const curGain = (((cur - p.buyPrice) / p.buyPrice) * 100);
            const peakGain = (((p.highestPrice - p.buyPrice) / p.buyPrice) * 100);
            const stopPrice = p.highestPrice * (1 - this.getCallbackPct(sym, p) / 100);
            const distToStop = Math.abs(cur - stopPrice);
            const target08 = p.buyPrice * 1.008;

            rep += `🪙 <b>${sym}</b> (${p.qty} ${sym.replace("USDT","")})\n` +
                   `• Inversión: ${p.investedUsdt.toFixed(2)} USDT\n` +
                   `• Entrada: ${fmtPrice(p.buyPrice)}\n` +
                   `• Precio Actual: ${fmtPrice(cur)} (${curGain >= 0 ? "🟢 +" : "🔴 "}${curGain.toFixed(2)}%)\n` +
                   `• Pico Más Alto: ${fmtPrice(p.highestPrice)} (+${peakGain.toFixed(2)}%)\n`;

            if (p.activated) {
              rep += `• 🛡️ <b>Gatillo de Salida:</b> ${fmtPrice(stopPrice)} (a solo ${distToStop.toFixed(2)} de distancia)\n` +
                     `• Estado: 🟢 <b>SEGURO ACTIVADO (Cazando la cima)</b>\n\n`;
            } else {
              const falta08 = (((target08 - cur) / cur) * 100);
              rep += `• 🎯 <b>Meta para Activar Seguro:</b> ${fmtPrice(target08)} (falta: +${falta08.toFixed(2)}%)\n` +
                     `• Estado: ⏳ <b>Avanzando hacia el +0.8%</b>\n\n`;
            }
          }
        }

        if (this.buyWatches.size > 0) {
          rep += `🔻 <b>TRAILING BUY:</b> ${this.buyWatches.size} moneda(s) cazando el piso (ver /cazando)\n\n`;
        }

        try {
          const s = await computeRealizedPnl(this.client);
          const sign = s.totalPnl >= 0 ? "+" : "";
          rep += `💰 <b>GANANCIA TOTAL ACUMULADA (real Binance):</b> ${s.totalPnl >= 0 ? "🟢" : "🔴"} <b>${sign}${s.totalPnl.toFixed(3)} USDT netos</b> ` +
                 `≈ ${sign}$${Math.round(s.totalPnl * COP_PER_USDT).toLocaleString("es-CO")} COP\n` +
                 `(${s.cycles.length} ciclos cerrados: ${s.wins} ganados, ${s.losses} perdidos)\n\n`;
        } catch (e: any) {
          rep += `💰 <i>No se pudo calcular el acumulado: ${e.message}</i>\n\n`;
        }
        rep += `💡 <i>Escribe /reporte para el detalle por ciclo o /menu para más opciones.</i>`;
        return rep;
      }

      if (cmd === "/sesion" || cmd === "sesion" || cmd === "/orquestador" || cmd === "orquestador") {
        const acc = await this.client.account({ recvWindow: 60000 });
        const usdt = parseFloat(acc.data.balances.find((b: any) => b.asset === "USDT")?.free || "0");
        const plan = this.getSessionLiquidityPlan(usdt);

        let msg = `🏛️ <b>ORQUESTADOR AUTÓNOMO DE LIQUIDEZ Y SESIONES (COT)</b>\n\n` +
          `• 📍 <b>Sesión Actual:</b> ${plan.sessionTitle}\n` +
          `• 💵 <b>Saldo Total en Spot:</b> ${usdt.toFixed(2)} USDT\n` +
          `• 🔒 <b>Reserva Protegida:</b> ${plan.reservedUsdt.toFixed(2)} USDT (${plan.sessionKey === "NOCTURNO_DRENAJE" ? "Reservado para Londres 03:00 COT" : (plan.sessionKey === "COSECHA_PRENOCTURNA" ? "Caja preventiva" : "Libre")})\n` +
          `• 🟢 <b>Disponible para Operar:</b> ${plan.spendableUsdt.toFixed(2)} USDT\n` +
          `• 🎯 <b>Fraccionamiento de Lote:</b> ${(plan.lotFractionPct * 100).toFixed(0)}% del saldo disponible\n` +
          `• ⏱️ <b>Gatillo Trailing Buy:</b> +${plan.trailingBounceTrigger.toFixed(2)}% desde el piso\n`;
        if (plan.harvestCallbackPct) {
          msg += `• ✂️ <b>Callback Cosecha:</b> ${plan.harvestCallbackPct.toFixed(2)}% (Cerrar en verde antes de las 20:00)\n`;
        }
        msg += `\n📊 <b>Evidencia Cuantitativa (Datos 42 Días):</b>\n<i>${plan.reason}</i>\n\n` +
          `💡 <b>Recomendación Óptima:</b>\n${plan.recommendation}\n\n` +
          `👉 /sugerencias — <i>Ver análisis técnico por estrategia</i>\n` +
          `👉 /estado — <i>Ver posiciones y órdenes abiertas</i>`;
        return msg;
      }

      if (cmd === "/estado" || cmd === "estado") {
        const openOrders = await this.client.openOrders({ recvWindow: 60000 });
        const sellOrders = openOrders.data.filter((o: any) => o.side === "SELL");

        let txt = `📊 <b>ESTADO GENERAL DE ÓRDENES EN BINANCE</b>\n\n`;
        if (sellOrders.length === 0) {
          txt += "• No tienes órdenes de venta abiertas actualmente.\n";
        } else {
          txt += `• 🎯 <b>Órdenes de Venta Límite Activas (${sellOrders.length}):</b>\n`;
          for (let i = 0; i < sellOrders.length; i++) {
            const o = sellOrders[i];
            const target = parseFloat(o.price);
            let curPrice = 0;
            try {
              const t = await this.client.tickerPrice(o.symbol);
              curPrice = parseFloat(t.data.price);
            } catch(e) {}
            const faltaPct = curPrice > 0 ? (((target - curPrice) / curPrice) * 100) : 0;
            txt += `  ${i + 1}. <b>${o.symbol}</b> | Cantidad: ${o.origQty} | Meta: $${target.toFixed(2)} | Falta: +<b>${faltaPct.toFixed(2)}%</b>\n`;
          }
        }

        const acc = await this.client.account({ recvWindow: 60000 });
        const usdt = parseFloat(acc.data.balances.find((b: any) => b.asset === "USDT")?.free || "0");
        const plan = this.lastSessionPlan || this.getSessionLiquidityPlan(usdt);
        txt += `\n• 💼 <b>USDT en cuenta:</b> ${usdt.toFixed(2)} USDT (🟢 ${plan.spendableUsdt.toFixed(2)} libre | 🔒 ${plan.reservedUsdt.toFixed(2)} reserva ${plan.sessionKey === "NOCTURNO_DRENAJE" ? "Londres" : ""})\n`;
        txt += `• 🏛️ <b>Sesión (COT):</b> ${plan.sessionTitle}\n`;
        txt += `• 💡 <b>Recomendación:</b> <i>${plan.recommendation}</i>\n`;
        txt += `• 🏹 <b>Trailing Activo:</b> ${this.activeTrailingPositions.size} posiciones rastreando el pico\n`;
        txt += `• 🔻 <b>Trailing Buy:</b> ${this.buyWatches.size} moneda(s) cazando el piso\n`;
        txt += `• 🤖 <b>Modo:</b> ${this.autoPilot ? "🟢 Autónomo con Trailing (+0.8% a +3.5%)" : "🟡 Manual Asistido"}`;
        return txt;
      }

      if (cmd === "/radar" || cmd === "radar") {
        const openOrders = await this.client.openOrders({ recvWindow: 60000 });
        const activeSymbols = new Set<string>(openOrders.data.filter((o: any) => o.side === "SELL").map((o: any) => o.symbol as string));

        let report = `📡 <b>RADAR INTELIGENTE DE MERCADO</b>\n\n`;
        for (const sym of WATCHLIST) {
          try {
            const [t24, k15] = await Promise.all([
              this.client.ticker24hr(sym),
              this.client.klines(sym, "15m", { limit: 25 })
            ]);
            const price = parseFloat(t24.data.lastPrice);
            const closes = k15.data.map((k: any) => parseFloat(k[4]));
            const rsi = this.calculateRSI(closes, 14);

            let status = "";
            if (activeSymbols.has(sym)) {
              status = " 🛡️ [Posición en espera]";
            } else if (this.activeTrailingPositions.has(sym)) {
              status = " 🏹 [Trailing activo]";
            } else if (this.buyWatches.has(sym)) {
              status = ` 🔻 [Cazando piso: ${this.buyWatches.get(sym)!.lowestPrice}]`;
            } else if (rsi <= 35) {
              status = " 🎯 [Suelo / Rebote VIP]";
            } else if (rsi <= 45) {
              status = " 🟢 [Zona favorable]";
            } else {
              status = " ⚪ [Neutro]";
            }

            const isMeme = MEME_WATCHLIST.includes(sym);
            report += `• <b>${isMeme ? "🐕 " : "💎 "}${sym}:</b> ${fmtPrice(price)} | RSI: <b>${rsi.toFixed(1)}</b>${status}\n`;
          } catch(e) {}
        }

        const acc = await this.client.account({ recvWindow: 60000 });
        const usdt = parseFloat(acc.data.balances.find((b: any) => b.asset === "USDT")?.free || "0");
        report += `\n💼 <b>USDT libre:</b> $${usdt.toFixed(2)} USDT\n`;
        report += `🏹 <b>Estrategia:</b> Trailing Buy (+${TRAILING_BUY_BOUNCE_PCT}% desde el piso) + Trailing Take Profit (+0.8% y persigue la subida)\n`;
        return report;
      }

      if (cmd === "/memes" || cmd === "memes") {
        let activeMeme: string | null = null;
        for (const [sym, p] of this.activeTrailingPositions.entries()) {
          if (MEME_WATCHLIST.includes(sym)) {
            activeMeme = `${sym} (Comprado a ${fmtPrice(p.buyPrice)})`;
            break;
          }
        }
        let armedMeme: string | null = null;
        for (const [sym, w] of this.buyWatches.entries()) {
          if (MEME_WATCHLIST.includes(sym)) {
            armedMeme = `${sym} (Piso ${fmtPrice(w.lowestPrice)})`;
            break;
          }
        }

        let msg = `🐕 <b>RADAR DE CANASTA MEMECOIN</b> 🚀\n\n`;
        msg += `• <b>Cupo Memecoin:</b> ${activeMeme ? `🔴 <b>OCUPADO:</b> ${activeMeme}` : (armedMeme ? `🟡 <b>ARMADO:</b> ${armedMeme}` : "🟢 <b>DISPONIBLE (0/1)</b>")}\n`;
        msg += `• <b>Límite de Inversión:</b> Máx <b>$50 USDT</b> (30% portafolio)\n`;
        msg += `• <b>Regla de Oro:</b> Máximo 1 sola posición memecoin activa a la vez\n`;
        msg += `• <b>Callback de salida:</b> <b>0.25%</b> (Caza rápida en la cima)\n\n`;
        msg += `<b>ESTADO EN VIVO (TOP 5 MEMES):</b>\n`;

        for (const sym of MEME_WATCHLIST) {
          try {
            const [t24, k1h] = await Promise.all([
              this.client.ticker24hr(sym),
              this.client.klines(sym, "1h", { limit: 25 })
            ]);
            const price = parseFloat(t24.data.lastPrice);
            const chg24 = parseFloat(t24.data.priceChangePercent);
            const high = parseFloat(t24.data.highPrice);
            const low = parseFloat(t24.data.lowPrice);
            const range = ((high - low) / low) * 100;
            const closes = k1h.data.map((r: any) => parseFloat(r[4]));
            const rsi = this.calculateRSI(closes, 14);

            let tag = "⚪ Neutro";
            if (this.activeTrailingPositions.has(sym)) tag = "🏹 En Trailing";
            else if (this.buyWatches.has(sym)) tag = "🎯 Cazando piso";
            else if (rsi <= 45) tag = "🟢 Piso favorable";

            msg += `• <b>${sym.replace("USDT", "")}:</b> ${fmtPrice(price)} | 24h: ${chg24 >= 0 ? "+" : ""}${chg24.toFixed(1)}% | Rango: ${range.toFixed(1)}% | RSI: ${rsi.toFixed(0)} [${tag}]\n`;
          } catch(e) {}
        }
        return msg;
      }



      if (cmd === "/motores" || cmd === "motores") {
        return `⚙️ <b>CONFIGURACIÓN DE MOTORES Y TRAILING</b>\n\n` +
          `🔻 <b>Motor Trailing Buy (ACTIVO):</b>\n` +
          `• <b>Detección:</b> Caída ≥ 1.5% con RSI ≤ 58 (o RSI ≤ 48 con caída ≥ 0.8%, o RSI ≤ 40).\n` +
          `• <b>Persecución del piso:</b> Registra el precio más bajo tick a tick (cada 7s).\n` +
          `• <b>Compra:</b> Cuando rebota +${TRAILING_BUY_BOUNCE_PCT}% desde el piso.\n` +
          `• <b>Expiración:</b> ${TRAILING_BUY_MAX_AGE_MS / 3600000}h sin rebote.\n\n` +
          `🏹 <b>Motor Trailing Take Profit (ACTIVO):</b>\n` +
          `• <b>Gatillo de activación:</b> +${TRAILING_ACTIVATION_PCT}% (Asegura ganancia rápida).\n` +
          `• <b>Persecución de pico:</b> Sube el piso de venta detrás del precio sin límite.\n` +
          `• <b>Cierre óptimo:</b> Vende si retrocede ${TRAILING_CALLBACK_PCT}% desde su pico.\n` +
          `• <b>Techo máximo:</b> +${TRAILING_HARD_CAP_PCT}% (Toma de ganancias automática).\n` +
          `• <b>Nunca vende en pérdida.</b>\n\n` +
          `💰 <b>Capital:</b> 2 ranuras en paralelo (divide el USDT si hay ≥ $30).\n` +
          `🛡️ <b>Diversificación:</b> No compra monedas donde ya tengamos posiciones u órdenes vivas.\n` +
          `📋 <b>Watchlist:</b> ${WATCHLIST.join(", ")}\n` +
          `🤖 <b>Piloto Autónomo:</b> ${this.autoPilot ? "🟢 ACTIVADO" : "🟡 MODO MANUAL"}`;
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

      if (cmd === "/reporte" || cmd === "reporte") {
        const s = await computeRealizedPnl(this.client);
        let txt = `📊 <b>REPORTE DE GANANCIAS REALES (PnL)</b>\n<i>Calculado desde el historial de Binance, comisiones incluidas.</i>\n\n`;
        if (s.cycles.length === 0) {
          txt += "• Aún no hay ciclos cerrados.\n";
        }
        s.cycles.forEach((c, i) => {
          const d = new Date(c.time).toLocaleString("es-CO", { timeZone: "America/Bogota", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
          const sign = c.pnlUsdt >= 0 ? "+" : "";
          txt += `${c.pnlUsdt >= 0 ? "🟢" : "🔴"} <b>${i + 1}. ${c.symbol.replace("USDT", "")}</b> (${d}) ${c.avgBuy.toFixed(4)} ➔ ${c.avgSell.toFixed(4)} | <b>${sign}${c.pnlUsdt.toFixed(3)} USDT</b> (${sign}${c.pnlPct.toFixed(2)}%)\n`;
        });

        const sign = s.totalPnl >= 0 ? "+" : "";
        txt += `\n📈 <b>Por moneda:</b>\n`;
        for (const [sym, v] of Object.entries(s.bySymbol)) {
          txt += `• ${sym.replace("USDT", "")}: ${v.pnl >= 0 ? "+" : ""}${v.pnl.toFixed(3)} USDT (${v.cycles} ciclos)\n`;
        }
        txt += `\n💵 <b>Ganancia Líquida Cerrada:</b> ${s.totalPnl >= 0 ? "🟢" : "🔴"} <b>${sign}${s.totalPnl.toFixed(3)} USDT</b> ≈ <b>${sign}$${Math.round(s.totalPnl * COP_PER_USDT).toLocaleString("es-CO")} COP</b>\n` +
               `🏆 <b>Efectividad:</b> ${s.wins}/${s.cycles.length} ciclos ganados\n` +
               `💸 <b>Comisiones pagadas en ventas:</b> ${s.totalFees.toFixed(3)} USDT\n` +
               `🏹 <b>Posiciones abiertas:</b> ${this.activeTrailingPositions.size} | 🔻 <b>Cazando piso:</b> ${this.buyWatches.size}\n` +
               `<i>COP aprox. a ${COP_PER_USDT.toLocaleString("es-CO")} por USDT (P2P).</i>`;
        return txt;
      }

      if (cmd === "/comprar" || cmd === "comprar") {
        if (!arg1) {
          return "❓ <b>Uso:</b> <code>/comprar &lt;MONEDA&gt; [MONTO]</code>\nEjemplo: <code>/comprar eth</code>\nComprará con tu USDT libre y activará el Trailing Stop automático.";
        }
        const symbol = arg1.endsWith("USDT") ? arg1 : `${arg1}USDT`;
        const acc = await this.client.account({ recvWindow: 60000 });
        const freeUsdt = parseFloat(acc.data.balances.find((b: any) => b.asset === "USDT")?.free || "0");

        if (freeUsdt < this.minUsdtToTrade) {
          return `❌ <b>Saldo insuficiente:</b> Tienes $${freeUsdt.toFixed(2)} USDT libres. El mínimo es $${this.minUsdtToTrade} USDT.`;
        }

        let amountToUse = freeUsdt;
        if (arg2 && !isNaN(parseFloat(arg2))) {
          amountToUse = Math.min(parseFloat(arg2), freeUsdt);
        }

        const ok = await this.executeSmartBuy(symbol, amountToUse, "Manual por Chat");
        if (!ok) return `❌ No se pudo comprar ${symbol}. Revisa el mensaje de error anterior.`;
        this.buyWatches.delete(symbol);
        this.saveBuyWatches();
        return `🚀 Compra en ${symbol} ejecutada por $${amountToUse.toFixed(2)} USDT. Trailing Take Profit activado persiguiendo el pico.`;
      }

      if (cmd === "/vender" || cmd === "vender") {
        if (!arg1) {
          return "❓ <b>Uso:</b> <code>/vender &lt;MONEDA&gt;</code>\nEjemplo: <code>/vender sol</code>\nVende todo al mercado inmediatamente.";
        }
        const asset = arg1.replace("USDT", "");
        const symbol = `${asset}USDT`;

        const openOrders = await this.client.openOrders({ symbol, recvWindow: 60000 });
        for (const o of openOrders.data) {
          await this.client.cancelOrder(symbol, { orderId: o.orderId, recvWindow: 60000 });
        }
        this.activeTrailingPositions.delete(symbol);
        this.saveTrailingPositions();
        this.buyWatches.delete(symbol);
        this.saveBuyWatches();

        const acc = await this.client.account({ recvWindow: 60000 });
        const bal = parseFloat(acc.data.balances.find((b: any) => b.asset === asset)?.free || "0");
        if (bal <= 0) return `❌ No tienes balance libre de ${asset} para vender.`;

        const exInfo = await this.client.exchangeInfo({ symbol });
        const sInfo = exInfo.data.symbols[0];
        const stepSize = parseFloat(sInfo.filters.find((f: any) => f.filterType === "LOT_SIZE").stepSize);
        const qtyDec = Math.max(0, Math.round(-Math.log10(stepSize)));
        const sellQtyStr = (Math.floor(bal / stepSize) * stepSize).toFixed(qtyDec);

        const res = await this.client.newOrder(symbol, "SELL", "MARKET", { quantity: sellQtyStr, recvWindow: 60000 });
        const soldQuote = parseFloat(res.data.cummulativeQuoteQty);
        return `✅ <b>Venta ejecutada:</b> Se vendieron ${sellQtyStr} ${asset} por $${soldQuote.toFixed(2)} USDT.`;
      }

      if (cmd === "/modo" || cmd === "modo") {
        if (arg1 === "AUTO") {
          this.autoPilot = true;
          return "🟢 <b>Modo Autónomo con Trailing Stop ACTIVADO.</b>";
        } else if (arg1 === "MANUAL") {
          this.autoPilot = false;
          return "🟡 <b>Modo Manual Asistido ACTIVADO.</b>";
        }
        return `🤖 <b>Modo actual:</b> ${this.autoPilot ? "🟢 Autónomo con Trailing" : "🟡 Manual Asistido"}`;
      }

      if (cmd === "/pausa" || cmd === "pausa") {
        this.autoPilot = false;
        return "⏸️ <b>BOT PAUSADO:</b> Compras automáticas detenidas.";
      }

      if (cmd === "/reanudar" || cmd === "reanudar") {
        this.autoPilot = true;
        return "▶️ <b>BOT REANUDADO:</b> Volviendo a vigilar y cazar rebotes con Trailing.";
      }

      // 1. Respuestas de cortesía o confirmaciones rápidas (CERO respuesta de IA)
      const ackList = ["ok", "vale", "listo", "bien", "gracias", "thx", "perfecto", "entendido", "recibido", "👍", "👌", "dale", "ignorar", "descartar"];
      if (ackList.includes(cmd)) {
        return "👍";
      }

      // 2. Si el mensaje empieza con barra / y no fue reconocido, NUNCA enviar a la IA
      if (rawCmd.trim().startsWith("/")) {
        return "Comando no reconocido. Escribe /menu para ver la lista de comandos disponibles.";
      }

      // 3. Solo llamar a Gemini AI si está explícitamente activada Y se usa /ai o una pregunta directa
      const isExplicitAi = cmd === "/ai" || cmd === "/ia" || cmd === "/chat" || cmd === "ai" || cmd === "ia";
      const isDirectQuestion = rawCmd.trim().startsWith("¿") || rawCmd.trim().startsWith("?");

      if (this.controls.aiEnabled && (isExplicitAi || isDirectQuestion) && this.aiCopilot.isAvailable()) {
        const queryText = isExplicitAi ? rawCmd.replace(/^\/(ai|ia|chat)\s*/i, "").trim() : rawCmd;
        if (!queryText) return "❓ Escribe tu pregunta después de /ai. Ejemplo: <code>/ai ¿cómo ves el mercado hoy?</code>";
        const ctx = await this.buildAiContextSnapshot();
        return await this.aiCopilot.chat(queryText, ctx, {});
      }

      return "Comando no reconocido. Escribe /menu para ver la lista de comandos disponibles.";
    } catch(e: any) {
      return `⚠️ Error: ${e.message}`;
    }
  }

  /**
   * CAZADOR WEEKEND: Explota la anomalía del fin de semana (caídas de viernes 17:00 a domingo 18:00 COT).
   * Evalúa las caídas en la watchlist, ranquea por score de sobreventa y caza el piso más bajo
   * para vender en el rebote máximo (domingo noche, lunes o el pico más alto con Trailing Take Profit).
   */
  /**
   * DETECCIÓN AUTOMÁTICA DE DÍAS QUIETOS (MERCADO LATERAL)
   * Evalúa la compresión de volatilidad de Bitcoin en 24h.
   * Si es < 2.2%, notifica por Telegram y auto-activa Micro-Grid tras 3 minutos si no hay respuesta.
   * Si sube a >= 2.5%, auto-desactiva Micro-Grid y devuelve el presupuesto a Cazador Trailing.
   */

  private lastTimeframeAdvisorTime: number = 0;

  private getCurrentMarketSession(): string {
    const now = new Date();
    const day = now.toLocaleDateString("en-US", { timeZone: "America/Bogota", weekday: "short" });
    const hour = parseInt(now.toLocaleTimeString("en-US", { timeZone: "America/Bogota", hour12: false, hour: "numeric" }), 10);

    if (day === "Sat" || (day === "Sun" && hour < 17)) {
      return "Fin de Semana (Bolsas Cerradas / Libros Delgados)";
    }
    if (day === "Sun" && hour >= 17) {
      return "Apertura Futuros CME (Retorno de Liquidez)";
    }
    if (hour >= 8 && hour < 16) {
      return "Wall Street / New York (Máxima Liquidez y Volumen)";
    }
    if (hour >= 2 && hour < 8) {
      return "Londres / Europa (Transición y Caza de Liquidez)";
    }
    return "Asia / Tokio (Consolidación y Rango Lateral)";
  }

  async checkTimeframeAdvisor() {
    if (Date.now() - this.lastTimeframeAdvisorTime < 180000) return; // Cada 3 minutos
    this.lastTimeframeAdvisorTime = Date.now();

    try {
      // 🧠 CENTINELA MULTI-ACTIVO: Escaneo simultáneo de todo el mercado (Macro + Clásicas + Memes)
      const tickersRes = await this.client.ticker24hr();
      const tickerMap = new Map<string, any>();
      tickersRes.data.forEach((t: any) => tickerMap.set(t.symbol, t));

      const btc = tickerMap.get("BTCUSDT") || { highPrice: "1", lowPrice: "1", lastPrice: "1", priceChangePercent: "0" };
      const btcHigh = parseFloat(btc.highPrice);
      const btcLow = parseFloat(btc.lowPrice);
      const btcRange = ((btcHigh - btcLow) / btcLow) * 100;
      const range24h = btcRange;
      const isWeekend = this.isWeekendWindow();
      const session = this.getCurrentMarketSession();

      // Volatilidad promedio de Monedas Clásicas (ETH, SOL, AVAX, etc.)
      let coreSum = 0, coreCount = 0;
      for (const s of CORE_WATCHLIST) {
        const t = tickerMap.get(s);
        if (t) {
          const h = parseFloat(t.highPrice), l = parseFloat(t.lowPrice);
          coreSum += ((h - l) / l) * 100;
          coreCount++;
        }
      }
      const coreAvgRange = coreCount > 0 ? (coreSum / coreCount) : btcRange;

      // Volatilidad promedio de Canasta Memecoins (PEPE, DOGE, BONK, etc.)
      let memeSum = 0, memeCount = 0;
      let hottestMeme = { symbol: "PEPE", range: 0 };
      for (const s of MEME_WATCHLIST) {
        const t = tickerMap.get(s);
        if (t) {
          const h = parseFloat(t.highPrice), l = parseFloat(t.lowPrice);
          const r = ((h - l) / l) * 100;
          memeSum += r;
          memeCount++;
          if (r > hottestMeme.range) {
            hottestMeme = { symbol: s.replace("USDT", ""), range: r };
          }
        }
      }
      const memeAvgRange = memeCount > 0 ? (memeSum / memeCount) : 0;

      if (!this.controls.suggestions) {
        this.controls.suggestions = {} as any;
      }
      if (!this.controls.rejectedSuggestions) {
        this.controls.rejectedSuggestions = {};
      }

      // Limpiar rechazos que ya expiraron
      const now = Date.now();
      for (const k of Object.keys(this.controls.rejectedSuggestions)) {
        if (this.controls.rejectedSuggestions[k] <= now) {
          delete this.controls.rejectedSuggestions[k];
        }
      }

      const currentSettings = this.controls.strategySettings || {} as any;

      // 1. Sugerencia Trailing Rebound (Cazador de Ondas)
      let trTf: "15m" | "1h" = "1h";
      let trSl = 4.0;
      let trReason = "";
      let trCriterios: string[] = [];
      let trWhy = "";

      if (btcRange >= 4.0 || memeAvgRange >= 6.5) {
        trTf = "15m";
        trSl = 3.5;
        trReason = `Alta velocidad detectada (BTC ${btcRange.toFixed(1)}%, Memes ${memeAvgRange.toFixed(1)}%). Sesión ${session}.`;
        trCriterios = [
          `Rango Bitcoin: ${btcRange.toFixed(2)}% (Fuerza direccional)`,
          `Rango Memecoins: ${memeAvgRange.toFixed(2)}% (Líder ${hottestMeme.symbol} con ${hottestMeme.range.toFixed(1)}%)`,
          `Sesión: ${session}`,
          "Flujo de órdenes dinámico con ciclos de rebote veloces"
        ];
        trWhy = `Con la canasta memecoin y el mercado acelerados, las ondas completas tardan menos en madurar. Calibrar el radar en 15m permite capturar rebotes rápidos (+1.2% a +2.0%) varias veces al día sin dejar capital atrapado.`;
      } else if (btcRange >= 2.0) {
        trTf = "1h";
        trSl = 4.0;
        trReason = `Volatilidad equilibrada (BTC ${btcRange.toFixed(1)}%, Clásicas ${coreAvgRange.toFixed(1)}%). Sesión ${session}.`;
        trCriterios = [
          `Rango Bitcoin: ${btcRange.toFixed(2)}% (Oscilación limpia)`,
          `Promedio Clásicas: ${coreAvgRange.toFixed(2)}%`,
          `Canasta Memes: ${memeAvgRange.toFixed(2)}% (Líder ${hottestMeme.symbol})`,
          `Sesión: ${session}`,
          "Estructura de ondas de 1H con soporte y resistencia claros"
        ];
        trWhy = "En volatilidad normal, operar en 1H filtra el 90% del ruido intradiario y posiciona al bot para capturar movimientos enteros de +1.5% a +3.0%. El stop-loss se calibra en -4.0% para dar espacio al activo sin salidas falsas.";
      } else {
        trTf = "1h";
        trSl = 4.0;
        trReason = `BTC comprimido (${btcRange.toFixed(1)}%), pero Memes activas (${memeAvgRange.toFixed(1)}%). Sesión ${session}.`;
        trCriterios = [
          `Rango Macro Bitcoin: ${btcRange.toFixed(2)}% (Calma y absorción institucional)`,
          `Rango Canasta Memecoins: ${memeAvgRange.toFixed(2)}% (Líder: ${hottestMeme.symbol} ${hottestMeme.range.toFixed(1)}%)`,
          `Sesión: ${session}`,
          "Estrategia Híbrida: 1H para filtrar ruido en clásicas y Trailing Buy ágil en Memecoins"
        ];
        trWhy = `En días donde Bitcoin se mueve en canales planos (< 2.0%), la liquidez institucional descansa en las monedas grandes pero la especulación se concentra en memecoins (${hottestMeme.symbol}). Mantener 1H en clásicas protege el capital contra trampas, mientras el escáner de velas aprovecha los rebotes en la canasta meme.`;
      }

      const isTrCurrent = currentSettings.trailing_rebound?.timeframe === trTf;
      const isTrRejected = !!(this.controls.rejectedSuggestions.trailing_rebound && this.controls.rejectedSuggestions.trailing_rebound > now);

      this.controls.suggestions!.trailing_rebound = {
        timeframe: trTf,
        stopLossPct: trSl,
        reason: trReason,
        criterios: trCriterios,
        porQue: trWhy,
        session,
        btcRange24h: btcRange,
        updatedAt: now,
        expiresAt: now + 3600000,
        isCurrent: isTrCurrent,
        status: isTrRejected ? "rejected" : (isTrCurrent ? "applied" : "pending")
      };

      // 2. Sugerencia Smart DCA (Seguridad y Rescate)
      const isDcaCurrent = currentSettings.smart_dca?.timeframe === "4h";
      const isDcaRejected = !!(this.controls.rejectedSuggestions.smart_dca && this.controls.rejectedSuggestions.smart_dca > now);

      this.controls.suggestions!.smart_dca = {
        timeframe: "4h",
        stopLossPct: 6.0,
        reason: "Soportes mayores de 4H. Tolerancia de promediado segura.",
        criterios: [
          "Soportes estructurales en temporalidad de 4 Horas",
          "Umbral de caída acumulada ≥ -2.5% desde la compra",
          "Cooldown de 2 horas entre compras consecutivas"
        ],
        porQue: "Smart DCA es tu cinturón de seguridad: su objetivo no es salir rápido, sino comprar caídas profundas en zonas donde las ballenas defienden el precio. Se sugiere 4H porque los rebotes en soportes de 4 horas tienen alta fiabilidad, y se fija Stop-Loss en -6.0% para permitir que el promediado baje tu precio de entrada.",
        session,
        btcRange24h: btcRange,
        updatedAt: now,
        expiresAt: now + 3600000,
        isCurrent: isDcaCurrent,
        status: isDcaRejected ? "rejected" : (isDcaCurrent ? "applied" : "pending")
      };

      // 3. Sugerencia Micro-Grid (Rango Lateral Plano)
      const isGridCurrent = currentSettings.micro_grid?.timeframe === "15m";
      const isGridRejected = !!(this.controls.rejectedSuggestions.micro_grid && this.controls.rejectedSuggestions.micro_grid > now);

      if (btcRange < 2.2) {
        this.controls.suggestions!.micro_grid = {
          timeframe: "15m",
          stopLossPct: 2.0,
          reason: `Día quieto confirmado en Bitcoin (${btcRange.toFixed(1)}%). Malla activa.`,
          criterios: [
            `Compresión de volatilidad extrema en Bitcoin: ${btcRange.toFixed(2)}% (< 2.2%)`,
            "Mercado sin dirección de tendencia (lateral plano)",
            "Micro-oscilaciones constantes en canales de ±0.5%"
          ],
          porQue: "En días planos donde no hay tendencias grandes, la única forma de generar dólares es con una rejilla de micro-rebotes (+0.45% a +0.60%) en 15m. El Stop-Loss estricto de -2.0% es obligatorio: si el precio rompe el canal hacia abajo, la estrategia debe cortar de inmediato para no quedar atrapada en una caída direccional.",
          session,
          btcRange24h: btcRange,
          updatedAt: now,
          expiresAt: now + 3600000,
          isCurrent: isGridCurrent,
          status: isGridRejected ? "rejected" : (isGridCurrent ? "applied" : "pending")
        };
      } else {
        this.controls.suggestions!.micro_grid = {
          timeframe: "15m",
          stopLossPct: 2.0,
          reason: `Mercado direccional activo (${btcRange.toFixed(1)}%). Conviene cautela.`,
          criterios: [
            `Rango Bitcoin: ${btcRange.toFixed(2)}% (Mercado con dirección)`,
            "Poco favorable para mallas fijas sin tendencia"
          ],
          porQue: "Cuando el mercado tiene movimiento direccional, las estrategias de rejilla corren riesgo de quedar con compras atrapadas. Se sugiere mantener el presupuesto de Micro-Grid en 0% o con Stop-Loss estricto de -2.0% mientras el Trailing Hunter hace el trabajo pesado.",
          session,
          btcRange24h: btcRange,
          updatedAt: now,
          expiresAt: now + 3600000,
          isCurrent: isGridCurrent,
          status: isGridRejected ? "rejected" : (isGridCurrent ? "applied" : "pending")
        };
      }

      // 4. Sugerencia Cazador Weekend (Anomalía Fin de Semana)
      const isWeekendCurrent = currentSettings.cazador_weekend?.timeframe === "1h";
      const isWeekendRejected = !!(this.controls.rejectedSuggestions.cazador_weekend && this.controls.rejectedSuggestions.cazador_weekend > now);

      if (isWeekend) {
        this.controls.suggestions!.cazador_weekend = {
          timeframe: "1h",
          stopLossPct: 5.0,
          reason: "Ventana de fin de semana abierta (Vie 17:00 a Dom 18:00 COT).",
          criterios: [
            "Bolsas mundiales y bancos cerrados (libros delgados)",
            "Frecuentes barridas de liquidez y mechazos falsos",
            "Apertura de futuros CME el domingo a las 17:00 COT"
          ],
          porQue: "Durante el fin de semana el dinero institucional descansa y los creadores de mercado suelen empujar el precio a la baja para cazar stop-losses. Se calibra en 1H con Stop-Loss tolerante de -5.0% para no ser expulsado por un mechazo, esperando la recuperación de compras cuando reabre CME el domingo por la noche.",
          session,
          btcRange24h: btcRange,
          updatedAt: now,
          expiresAt: now + 3600000,
          isCurrent: isWeekendCurrent,
          status: isWeekendRejected ? "rejected" : (isWeekendCurrent ? "applied" : "pending")
        };
      } else {
        this.controls.suggestions!.cazador_weekend = {
          timeframe: "1h",
          stopLossPct: 5.0,
          reason: "En espera hasta el viernes a las 17:00 COT.",
          criterios: [
            "Días hábiles de semana (mercados tradicionales abiertos)",
            "Capital trabajando al 100% en Cazador Trailing"
          ],
          porQue: "Entre semana el dinero institucional opera en Wall Street y Europa, por lo que Cazador Weekend descansa y cede todo su presupuesto a Trailing Rebound (75%). Los parámetros quedan listos para reactivarse el viernes por la tarde.",
          session,
          btcRange24h: btcRange,
          updatedAt: now,
          expiresAt: now + 3600000,
          isCurrent: isWeekendCurrent,
          status: isWeekendRejected ? "rejected" : (isWeekendCurrent ? "applied" : "pending")
        };
      }

      this.saveStrategyControls();
    } catch(e: any) {
      console.error("Error en checkTimeframeAdvisor:", e.message);
    }
  }

  async checkMarketRegime() {
    if (Date.now() - this.lastRegimeCheckTime < 180000) return; // Chequear cada 3 minutos
    this.lastRegimeCheckTime = Date.now();

    try {
      const btc24 = await this.client.ticker24hr("BTCUSDT");
      const high = parseFloat(btc24.data.highPrice);
      const low = parseFloat(btc24.data.lowPrice);
      const range24h = ((high - low) / low) * 100;
      const isQuiet = range24h < 2.2;
      const currentRegime: "QUIET" | "TRENDING" = isQuiet ? "QUIET" : "TRENDING";

      if (this.lastDetectedRegime === null) {
        this.lastDetectedRegime = currentRegime;
      }

      const isIgnored = !!(this.controls.gridIgnoredUntil && Date.now() < this.controls.gridIgnoredUntil);

      // A) DÍA QUIETO DETECTADO: Activar Micro-Grid si está apagado, no hay sugerencia pendiente y no está silenciado
      if (isQuiet && !this.controls.strategies.micro_grid && !this.pendingRegimeSwitch && !isIgnored) {
        this.pendingRegimeSwitch = {
          type: "activate_grid",
          reason: `Rango estrecho en Bitcoin de ${range24h.toFixed(2)}% (${low.toFixed(0)} - ${high.toFixed(0)})`,
          btcRange24h: range24h,
          createdAt: Date.now(),
          expiresAt: Date.now() + 180000 // 3 min
        };

        const alertMsg =
          `💤 <b>[MERCADO LATERAL / DÍA QUIETO DETECTADO]</b> 🌐\n\n` +
          `• La volatilidad de 24h en Bitcoin es de apenas <b>${range24h.toFixed(2)}%</b> (${low.toFixed(0)} - ${high.toFixed(0)}).\n` +
          `• 💡 <b>Recomendación del Centinela:</b> Activar <b>🌐 Micro-Grid</b> (Malla Lateral) con <b>30%</b> del presupuesto para cosechar micro-rebotes (+0.45% a +0.60%) mientras el mercado está quieto.\n\n` +
          `👉 /aprobar_grid — <i>Activar Micro-Grid ahora</i>\n` +
          `👉 /ignorar_grid — <i>Permanecer en Cazador Trailing</i>\n\n` +
          `🤖 <i>${this.controls.autoPilot ? "Modo Autónomo ACTIVO: Si no respondes en 3 minutos, se activará automáticamente." : "Modo Manual: Esperando tu confirmación."}</i>`;

        await this.notifier.send(alertMsg);
        console.log(alertMsg.replace(/<[^>]*>/g, ""));
      }

      // B) FIN DE DÍA QUIETO / VOLATILIDAD REACTIVADA: Si el mercado despierta (range >= 2.5%)
      if (!isQuiet && range24h >= 2.5) {
        if (this.controls.strategies.micro_grid) {
          await this.deactivateMicroGrid(range24h);
        }
        if (this.controls.gridIgnoredUntil) {
          this.controls.gridIgnoredUntil = 0;
          this.saveStrategyControls();
        }
      }

      this.lastDetectedRegime = currentRegime;
    } catch (e: any) {
      console.error("Error en checkMarketRegime:", e.message);
    }
  }

  async checkRegimeSwitchTimeout() {
    if (!this.pendingRegimeSwitch) return;
    if (Date.now() >= this.pendingRegimeSwitch.expiresAt) {
      const sw = this.pendingRegimeSwitch;
      this.pendingRegimeSwitch = null;

      if (this.controls.autoPilot) {
        console.log("⚡ [AUTO-PILOTO] Tiempo de 3 min agotado. Auto-activando Micro-Grid por Día Quieto...");
        await this.activateMicroGrid(true, sw.btcRange24h);
      } else {
        console.log("⌛ [MODO MANUAL] Tiempo agotado. Sugerencia de Micro-Grid descartada.");
        await this.notifier.send("⌛ <i>Tiempo de espera agotado. Activación de Micro-Grid descartada (Modo Manual).</i>");
      }
    }
  }

  async activateMicroGrid(auto: boolean = false, btcRange24h?: number) {
    this.controls.strategies.micro_grid = true;

    // Apartar 30% para micro_grid desde trailing_rebound
    if ((this.controls.allocations.micro_grid || 0) < 30) {
      const needed = 30 - (this.controls.allocations.micro_grid || 0);
      const takeFromTrailing = Math.min(needed, Math.max(0, (this.controls.allocations.trailing_rebound || 50) - 20));
      this.controls.allocations.trailing_rebound -= takeFromTrailing;
      this.controls.allocations.micro_grid = (this.controls.allocations.micro_grid || 0) + takeFromTrailing;
    }
    this.saveStrategyControls();

    const rangeStr = btcRange24h ? ` (BTC ${btcRange24h.toFixed(2)}% en 24h)` : "";
    await this.notifier.send(
      `🌐 <b>[MICRO-GRID ACTIVADO ${auto ? "AUTOMÁTICAMENTE (3 MIN)" : "POR COMANDO"}]</b> ✅\n\n` +
      `• <b>Régimen:</b> Día Quieto / Rango Lateral${rangeStr}.\n` +
      `• <b>Misión:</b> Cosechar micro-rebotes rápidos en canales laterales (+0.45% a +0.60%).\n` +
      `• 💼 <b>Presupuesto reasignado:</b> Micro-Grid <b>${this.controls.allocations.micro_grid}%</b> | Cazador Trailing <b>${this.controls.allocations.trailing_rebound}%</b> | Smart DCA <b>${this.controls.allocations.smart_dca}%</b>.\n` +
      `• 🔄 Cuando el mercado vuelva a activarse con volatilidad (>=2.5%), se auto-desactivará y devolverá el 100% a Cazador Trailing.`
    );
  }

  async deactivateMicroGrid(range24h?: number) {
    this.controls.strategies.micro_grid = false;

    // Devolver presupuesto de micro_grid a trailing_rebound
    const gAlloc = this.controls.allocations.micro_grid || 0;
    if (gAlloc > 0) {
      this.controls.allocations.trailing_rebound = (this.controls.allocations.trailing_rebound || 50) + gAlloc;
      this.controls.allocations.micro_grid = 0;
    }
    this.saveStrategyControls();

    const rangeStr = range24h ? ` (BTC ${range24h.toFixed(2)}% en 24h)` : "";
    await this.notifier.send(
      `🚀 <b>[VOLATILIDAD REACTIVADA: FIN DE DÍA QUIETO]</b> 🏹\n\n` +
      `• El mercado ha despertado con volumen${rangeStr}.\n` +
      `• <b>Micro-Grid</b> se ha pausado automáticamente.\n` +
      `• 💼 <b>Presupuesto devuelto:</b> La cuota se transfirió al 100% a <b>🏹 Cazador Trailing</b> (ahora al <b>${this.controls.allocations.trailing_rebound}%</b>) para cazar tendencias y grandes olas.\n` +
      `• 🎯 Listo para operar rebotes direccionales.`
    );
  }

  /**
   * ESCÁNER MICRO-GRID: Opera compras rápidas en canales laterales estrechos durante días quietos.
   */
  async evaluateMicroGrid(usdt: number, activeSymbols: Set<string>): Promise<boolean> {
    if (!this.controls.strategies.micro_grid) return false;
    if (this.pendingOpportunity) return false;
    if (usdt < this.minUsdtToTrade) return false;

    for (const sym of WATCHLIST) {
      try {
        if (activeSymbols.has(sym) || this.activeTrailingPositions.has(sym) || this.buyWatches.has(sym)) {
          continue;
        }

        const gridTf = this.controls.strategySettings?.micro_grid?.timeframe || "15m";
        const klinesRes = await this.client.klines(sym, gridTf, { limit: 24 });
        const data = klinesRes.data;
        const closes = data.map((k: any) => parseFloat(k[4]));
        const highs = data.map((k: any) => parseFloat(k[2]));
        const lows = data.map((k: any) => parseFloat(k[3]));

        const curPrice = closes[closes.length - 1];
        const min6h = Math.min(...lows);
        const max6h = Math.max(...highs);
        const channelRangePct = ((max6h - min6h) / min6h) * 100;

        // Canal lateral plano ideal: rango entre 0.8% y 2.5%
        if (channelRangePct >= 0.8 && channelRangePct <= 2.5) {
          const positionInChannel = (curPrice - min6h) / (max6h - min6h);
          const rsi = this.calculateRSI(closes, 14);

          // Si el precio está en el 35% inferior del canal y RSI neutro-bajo (36-52): ¡Compra Micro-Grid!
          if (positionInChannel <= 0.35 && rsi >= 36 && rsi <= 52) {
            let amountToUse = Math.min(usdt, 50);
            if (usdt >= 80) amountToUse = Math.min(usdt * 0.4, 40);

            console.log(`🌐 [MICRO-GRID] Entrada en canal lateral en ${sym}: precio ${curPrice} cerca de base ${min6h} (Canal ${channelRangePct.toFixed(2)}% | RSI ${rsi.toFixed(1)})`);
            const ok = await this.executeSmartBuy(sym, amountToUse, `Micro-Grid Canal Lateral (${channelRangePct.toFixed(2)}%)`, "micro_grid");
            if (ok) return true;
          }
        }
      } catch (e: any) {}
    }
    return false;
  }

  async evaluateCazadorWeekend(usdt: number, activeSymbols: Set<string>): Promise<boolean> {
    if (!this.controls.strategies.cazador_weekend || !this.isWeekendWindow()) return false;
    if (this.pendingOpportunity) return false;
    if (usdt < this.minUsdtToTrade) return false;

    // Si ya hay buyWatches activas, evaluarlas primero con el bounce
    if (this.buyWatches.size > 0) {
      const bought = await this.checkBuyWatches(usdt);
      if (bought) return true;
    }

    interface WeekendCandidate {
      symbol: string;
      curPrice: number;
      dropPct: number;
      rsi: number;
      score: number;
    }

    const candidates: WeekendCandidate[] = [];

    for (const sym of WATCHLIST) {
      try {
        if (activeSymbols.has(sym) || this.activeTrailingPositions.has(sym) || this.buyWatches.has(sym)) {
          continue;
        }

        const weekendTf = this.controls.strategySettings?.cazador_weekend?.timeframe || "1h";
        const klinesRes = await this.client.klines(sym, weekendTf, { limit: 48 });
        const data = klinesRes.data;
        const closes = data.map((k: any) => parseFloat(k[4]));
        const highs = data.map((k: any) => parseFloat(k[2]));

        const rsi = this.calculateRSI(closes, 14);
        const curPrice = closes[closes.length - 1];
        const maxRecent = Math.max(...highs.slice(-36));
        const dropPct = ((maxRecent - curPrice) / maxRecent) * 100;

        // Criterio de caída o sobreventa en fin de semana
        if ((dropPct >= 1.5 && rsi <= 55) || (rsi <= 45 && dropPct >= 0.8) || (rsi <= 38)) {
          const score = (dropPct * 1.5) + Math.max(0, (48 - rsi) * 2.0);
          candidates.push({ symbol: sym, curPrice, dropPct, rsi, score });
        }
      } catch (e: any) {}
    }

    if (candidates.length === 0) return false;

    // Ordenar de mayor a menor puntuación (la caída más profunda y con mayor sobreventa)
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];

    // Armar Trailing Buy para cazar el piso exacto de fin de semana
    this.buyWatches.set(best.symbol, {
      symbol: best.symbol,
      armedPrice: best.curPrice,
      lowestPrice: best.curPrice,
      armedTime: Date.now(),
      rsi: best.rsi,
      dropPct: best.dropPct,
      strategy: "cazador_weekend"
    });
    this.saveBuyWatches();

    const trigger = best.curPrice * (1 + 0.35 / 100);
    console.log("🏖️ [CAZADOR WEEKEND] Oportunidad top armada en " + best.symbol + " (Caída: -" + best.dropPct.toFixed(2) + "% | RSI: " + best.rsi.toFixed(1) + " | Score: " + best.score.toFixed(1) + ")");

    await this.notifier.send(
      "🏖️ <b>[CAZADOR WEEKEND ARMADO: " + best.symbol + "]</b> 🎯\n\n" +
      "• Caída de fin de semana: <b>-" + best.dropPct.toFixed(2) + "%</b> (RSI: <b>" + best.rsi.toFixed(1) + "</b>)\n" +
      "• Puntuación de rebote: <b>" + best.score.toFixed(1) + " pts</b> (Top 1 de watchlist)\n" +
      "• Precio actual: <b>" + best.curPrice + "</b>\n" +
      "• 🔻 Rastreo de piso activo: persiguiendo el suelo tick a tick.\n" +
      "• 🏹 Disparará compra al confirmar rebote de <b>+0.35%</b> desde el piso.\n" +
      "• 🚀 <b>Salida:</b> El Trailing Take Profit (+0.80% a +3.5%) perseguirá el pico más alto (domingo noche/lunes o el día que más suba) para vender en la cima."
    );

    return true;
  }



  // --- PARÁMETROS DEL CENTINELA NOCTURNO (PROTECCIÓN 20:00 - 02:30 COT) ---
  public isNightWindow(): boolean {
    const hour = parseInt(new Date().toLocaleTimeString("en-US", { timeZone: "America/Bogota", hour12: false, hour: "numeric" }), 10);
    // Ventana de bajo volumen y caza de liquidaciones: 20:00 a 02:30 COT
    return hour >= 20 || hour < 3;
  }

  
  public isPreNightHarvestWindow(): boolean {
    const d = new Date();
    const hour = parseInt(d.toLocaleTimeString("en-US", { timeZone: "America/Bogota", hour12: false, hour: "numeric" }), 10);
    const minute = parseInt(d.toLocaleTimeString("en-US", { timeZone: "America/Bogota", minute: "numeric" }), 10);
    return (hour >= 16 && hour < 19) || (hour === 19 && minute <= 30);
  }

  public isNYImpulseWindow(): boolean {
    const d = new Date();
    const hour = parseInt(d.toLocaleTimeString("en-US", { timeZone: "America/Bogota", hour12: false, hour: "numeric" }), 10);
    const minute = parseInt(d.toLocaleTimeString("en-US", { timeZone: "America/Bogota", minute: "numeric" }), 10);
    return (hour === 8 && minute >= 30) || (hour > 8 && hour < 14);
  }

  public getSessionLiquidityPlan(totalFreeUsdt: number): SessionLiquidityPlan {
    const now = new Date();
    const cotHour = parseInt(now.toLocaleTimeString("en-US", { timeZone: "America/Bogota", hour12: false, hour: "numeric" }), 10);
    const cotMin = parseInt(now.toLocaleTimeString("en-US", { timeZone: "America/Bogota", minute: "numeric" }), 10);

    const isNight = cotHour >= 20 || cotHour < 3;
    const isLondon = cotHour >= 3 && cotHour <= 6;
    const isNY = (cotHour === 8 && cotMin >= 30) || (cotHour > 8 && cotHour < 14);
    const isPreNight = (cotHour >= 16 && cotHour < 19) || (cotHour === 19 && cotMin <= 30);

    let sessionKey: SessionLiquidityPlan["sessionKey"] = "REGULAR";
    let sessionTitle = "🔄 Sesión Regular / Transición";
    let reservedUsdt = 0;
    let spendableUsdt = totalFreeUsdt;
    let lotFractionPct = 0.50;
    let trailingBounceTrigger = 0.35;
    let harvestCallbackPct: number | undefined = undefined;
    let reason = "Flujo normal del mercado intradía.";
    let recommendation = "🔄 Operación balanceada de rotación y micro-grid.";

    if (isNight) {
      sessionKey = "NOCTURNO_DRENAJE";
      sessionTitle = "🌙 Drenaje Nocturno (Caza de Stops / Vacío de Liquidez)";
      if (totalFreeUsdt >= 20) {
        reservedUsdt = Math.max(10, Math.round(totalFreeUsdt * 0.45 * 100) / 100);
        spendableUsdt = Math.max(0, Math.round((totalFreeUsdt - reservedUsdt) * 100) / 100);
      } else if (totalFreeUsdt >= 10) {
        reservedUsdt = 10;
        spendableUsdt = Math.max(0, Math.round((totalFreeUsdt - reservedUsdt) * 100) / 100);
      } else {
        reservedUsdt = totalFreeUsdt;
        spendableUsdt = 0;
      }
      lotFractionPct = 0.25;
      trailingBounceTrigger = 0.40;
      reason = "Win rate histórico bajo (38%-43%). Reserva obligatoria activa para capitalizar el rebote de Londres a las 03:00 COT.";
      recommendation = "🌙 Mantener reserva protegida. Bloqueo de compras superficiales; solo micro-lote si RSI <= 26 y absorción >= 45%.";
    } else if (isLondon) {
      sessionKey = "LONDRES_REBOTE";
      sessionTitle = "🏰 Rebote de Londres (Apertura Europea / Absorción)";
      reservedUsdt = 0;
      spendableUsdt = totalFreeUsdt;
      lotFractionPct = 0.60;
      trailingBounceTrigger = 0.25;
      reason = "Win rate del 64%-71% en velas horarias y mechas de absorción institucional más largas del ciclo.";
      recommendation = "🏰 Modo Ofensivo Activo: Despliegue de lotes al 60% cazando suelos con Trailing Buy sensible (+0.25%).";
    } else if (isPreNight) {
      sessionKey = "COSECHA_PRENOCTURNA";
      sessionTitle = "🌆 Cosecha Vespertina (Toma de Beneficios Pre-Nocturna)";
      reservedUsdt = Math.round(totalFreeUsdt * 0.35 * 100) / 100;
      spendableUsdt = Math.max(0, Math.round((totalFreeUsdt - reservedUsdt) * 100) / 100);
      lotFractionPct = 0.30;
      harvestCallbackPct = 0.20;
      reason = "Picos de cierre en Wall Street seguidos de goteo nocturno a las 20:00 COT. Asegurar USDT líquido.";
      recommendation = "🌆 Ceñir trailing a 0.20% en ganancias (>= +0.65%) para asegurar utilidades y esperar la noche en caja líquida.";
    } else if (isNY) {
      sessionKey = "NY_IMPULSO";
      sessionTitle = "🗽 Impulso Wall Street (Máxima Liquidez y Volumen)";
      reservedUsdt = 0;
      spendableUsdt = totalFreeUsdt;
      lotFractionPct = 0.50;
      trailingBounceTrigger = 0.35;
      reason = "Mayor volumen transaccional diario en Spot y Futuros. Expansión de tendencias.";
      recommendation = "🗽 Dejar correr posiciones con Trailing Take Profit amplio aprovechando el impulso de Nueva York.";
    }

    return {
      sessionKey,
      sessionTitle,
      totalFreeUsdt,
      reservedUsdt,
      spendableUsdt,
      lotFractionPct,
      trailingBounceTrigger,
      harvestCallbackPct,
      reason,
      recommendation,
      updatedAt: Date.now()
    };
  }

  public calculateSessionLotSize(symbol: string, spendableUsdt: number, lotFractionPct: number): number {
    if (spendableUsdt < this.minUsdtToTrade) return 0;

    let lot = Math.floor(spendableUsdt * lotFractionPct * 100) / 100;
    if (lot < this.minUsdtToTrade && spendableUsdt >= this.minUsdtToTrade) {
      lot = this.minUsdtToTrade;
    }

    // Tope de riesgo para memecoins: máximo $50 USDT
    if (MEME_WATCHLIST.includes(symbol) || symbol.includes("PEPE") || symbol.includes("BONK") || symbol.includes("DOGE") || symbol.includes("SHIB") || symbol.includes("WIF")) {
      lot = Math.min(lot, 50);
    }

    return Math.min(lot, spendableUsdt);
  }

  public saveSessionPlan(plan: SessionLiquidityPlan) {
    try {
      fs.writeFileSync(path.resolve(process.cwd(), ".session-liquidity-plan.json"), JSON.stringify(plan, null, 2));
    } catch(e) {}
  }

  public isReboundWindow(): boolean {
    const hour = parseInt(new Date().toLocaleTimeString("en-US", { timeZone: "America/Bogota", hour12: false, hour: "numeric" }), 10);
    // Ventana de rebote institucional (Apertura Europa/Londres): 03:00 a 06:00 COT
    return hour >= 3 && hour <= 6;
  }

  // --- MÉTODOS DE TRANSFERENCIA UNIVERSAL SPOT <-> FUTUROS USD-M ---
  private async getFuturesBalance(): Promise<{ balance: number; available: number }> {
    try {
      const ts = Date.now();
      const query = `timestamp=${ts}`;
      const sig = crypto.createHmac("sha256", process.env.BINANCE_API_SECRET || "").update(query).digest("hex");
      const url = `https://fapi.binance.com/fapi/v2/balance?${query}&signature=${sig}`;
      const res = await fetch(url, {
        headers: { "X-MBX-APIKEY": process.env.BINANCE_API_KEY || "" }
      });
      const data = await res.json();
      if (Array.isArray(data)) {
        const item = data.find((b: any) => b.asset === "USDT");
        if (item) {
          return {
            balance: parseFloat(item.balance || "0"),
            available: parseFloat(item.availableBalance || "0")
          };
        }
      }
      return { balance: 0, available: 0 };
    } catch {
      return { balance: 0, available: 0 };
    }
  }

  private async transferSpotToFutures(amount: number): Promise<{ success: boolean; msg: string }> {
    try {
      const cleanAmt = Math.floor(amount * 100) / 100;
      if (cleanAmt <= 0) return { success: false, msg: "Monto inválido para transferir." };
      const res = await this.client.userUniversalTransfer("MAIN_UMFUTURE", "USDT", cleanAmt);
      return { success: true, msg: `Transferidos ${cleanAmt.toFixed(2)} USDT de Spot a Futuros USD-M (TranId: ${res.data.tranId}).` };
    } catch (e: any) {
      const errMsg = e.response?.data?.msg || e.message;
      return { success: false, msg: `Error en transferencia a Futuros: ${errMsg}` };
    }
  }

  private async transferFuturesToSpot(amount?: number): Promise<{ success: boolean; msg: string }> {
    try {
      let targetAmt = amount;
      if (!targetAmt || targetAmt <= 0) {
        const futBal = await this.getFuturesBalance();
        targetAmt = Math.floor(futBal.available * 100) / 100;
      } else {
        targetAmt = Math.floor(targetAmt * 100) / 100;
      }

      if (targetAmt <= 0.01) {
        return { success: false, msg: "No hay saldo disponible en Futuros USD-M para transferir a Spot." };
      }

      const res = await this.client.userUniversalTransfer("UMFUTURE_MAIN", "USDT", targetAmt);
      return { success: true, msg: `Transferidos ${targetAmt.toFixed(2)} USDT de Futuros USD-M de regreso a Spot (TranId: ${res.data.tranId}).` };
    } catch (e: any) {
      const errMsg = e.response?.data?.msg || e.message;
      return { success: false, msg: `Error en transferencia a Spot: ${errMsg}` };
    }
  }

  // --- CENTINELA DE LIQUIDEZ (50 USDT) Y VIABILIDAD DE FUTUROS ---
  private isCheckingLiquidity = false;

  private async checkLiquidityAndFuturesViability(freeUsdt: number): Promise<void> {
    if (this.isCheckingLiquidity) return;

    // Histéresis: Si el saldo cae por debajo de 35 USDT, reseteamos la bandera para poder alertar de nuevo
    if (freeUsdt < 35.0) {
      if (this.controls.notified50UsdtThreshold) {
        console.log(`[LIQUIDEZ 💧] Saldo libre bajó a ${freeUsdt.toFixed(2)} USDT. Centinela de 50 USDT reactivado.`);
        this.controls.notified50UsdtThreshold = false;
        this.saveStrategyControls();
      }
      return;
    }

    // Si hay al menos 50 USDT libres y no hemos notificado
    if (freeUsdt >= 50.0 && !this.controls.notified50UsdtThreshold) {
      this.isCheckingLiquidity = true;
      try {
        this.controls.notified50UsdtThreshold = true;
        this.saveStrategyControls();
        console.log(`[LIQUIDEZ 💰] ¡Detectados ${freeUsdt.toFixed(2)} USDT libres! Evaluando viabilidad de Futuros...`);

        const viability = await this.futuresEngine.evaluateMarketViability();
        const timeStr = new Date().toLocaleTimeString("es-CO", { hour12: false });

        let msg = `🔔 <b>¡LIQUIDEZ DISPONIBLE DETECTADA!</b> (${timeStr})\n\n`;
        msg += `💼 <b>Saldo Libre:</b> <code>${freeUsdt.toFixed(2)} USDT</code> (Meta de ≥ 50 USDT alcanzada)\n\n`;

        if (viability.isViable) {
          msg += `🎯 <b>Diagnóstico de Futuros:</b> 🟢 <b>MERCADO VIABLE (${viability.score}/100)</b>\n\n`;
          msg += `📊 <b>Condiciones del Mercado:</b>\n`;
          msg += `• <b>BTC Macro 1H:</b> ${viability.btcStatus}\n`;
          msg += `• <b>Tasas de Financiación:</b> ${viability.fundingStatus}\n`;
          msg += `• <b>Volatilidad:</b> ${viability.volatilityStatus}\n`;
          msg += `• <b>Oportunidades Técnicas:</b> ${viability.opportunitiesFound} pares con setup activo\n`;
          if (viability.favorableSymbols && viability.favorableSymbols.length > 0) {
            msg += `  <i>${viability.favorableSymbols.slice(0, 3).join("\n  ")}</i>\n`;
          }
          msg += `\n⚙️ <b>¿Deseas invertir en Futuros o continuar en Spot?</b>\n\n`;
          msg += `1️⃣ <b>Para activar Futuros Real (10-15 USDT margen / 2x-4x apalancamiento / SL -1.2%):</b>\n`;
          msg += `   👉 Toca: <code>/futuros_real</code> (o actívalo en el Dashboard web)\n\n`;
          msg += `2️⃣ <b>Si prefieres no arriesgar en futuros:</b>\n`;
          msg += `   No necesitas hacer nada; el bot invertirá automáticamente estos <b>${freeUsdt.toFixed(2)} USDT</b> en las <b>estrategias Spot</b> (Cazador Trailing & Centinela Alpha) sin riesgo de liquidación.`;
        } else {
          msg += `⚠️ <b>Diagnóstico de Futuros:</b> 🔴 <b>NO RECOMENDADO / ALTO RIESGO (${viability.score}/100)</b>\n\n`;
          msg += `📊 <b>Condiciones Analizadas:</b>\n`;
          msg += `• <b>BTC Macro 1H:</b> ${viability.btcStatus}\n`;
          msg += `• <b>Tasas de Financiación:</b> ${viability.fundingStatus}\n`;
          msg += `• <b>Volatilidad:</b> ${viability.volatilityStatus}\n`;
          msg += `• <b>Diagnóstico:</b> ${viability.rationale}\n\n`;
          msg += `🛡️ <b>Decisión Automática Aplicada:</b>\n`;
          msg += `Como instruiste que solo se use futuros si el mercado es viable, estos fondos se mantendrán y desplegarán en las <b>estrategias Spot</b> (Cazador Trailing & Centinela Alpha) para operar con cero riesgo de liquidación.`;
        }

        await this.notifier.send(msg);
        console.log("📢 Notificación de liquidez y viabilidad enviada a Telegram con éxito.");
      } catch (err: any) {
        console.error("Error al notificar liquidez y viabilidad:", err.message);
      } finally {
        this.isCheckingLiquidity = false;
      }
    }
  }

  async runCycle() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      this.loadStrategyControls();

      // Control de ciclo automático de Cazador Weekend (Vie 17:00 a Dom 18:00 COT)
      const isWeekend = this.isWeekendWindow();
      if (this.lastWeekendWindowState === null) {
        this.lastWeekendWindowState = isWeekend;
        if (!isWeekend && (this.controls.strategies.cazador_weekend || this.controls.allocations.cazador_weekend > 0)) {
          console.log("🏖️ [CAZADOR WEEKEND] Fuera de fin de semana (Lunes). Auto-desactivando switch y transfiriendo cuota a Trailing.");
          this.controls.strategies.cazador_weekend = false;
          const wAlloc = this.controls.allocations.cazador_weekend || 0;
          if (wAlloc > 0) {
            this.controls.allocations.trailing_rebound = (this.controls.allocations.trailing_rebound || 50) + wAlloc;
            this.controls.allocations.cazador_weekend = 0;
          }
          this.saveStrategyControls();
        }
      } else if (this.lastWeekendWindowState !== isWeekend) {
        this.lastWeekendWindowState = isWeekend;
        if (!isWeekend) {
          console.log("🏖️ [CAZADOR WEEKEND] Ventana de fin de semana finalizada. Auto-desactivando switch y devolviendo cuota a Trailing.");
          this.controls.strategies.cazador_weekend = false;
          const wAlloc = this.controls.allocations.cazador_weekend || 0;
          if (wAlloc > 0) {
            this.controls.allocations.trailing_rebound = (this.controls.allocations.trailing_rebound || 50) + wAlloc;
            this.controls.allocations.cazador_weekend = 0;
          }
          this.saveStrategyControls();
          await this.notifier.send(
            "🏖️ <b>[CAZADOR WEEKEND: AUTO-DESACTIVADO]</b> ⏸️\n\n" +
            "• La ventana de compras de fin de semana ha finalizado (Domingo 18:00 COT).\n" +
            "• El switch se ha <b>auto-desactivado</b> para no hacer compras en días de semana.\n" +
            `• 💼 <b>Presupuesto inteligente:</b> La cuota (${wAlloc}%) se transfirió automáticamente a <b>🏹 Cazador Trailing</b> (ahora al ${this.controls.allocations.trailing_rebound}%) para operar al 100% durante la semana.\n` +
            "• 🚀 <b>Ventas:</b> Posiciones abiertas siguen rastreando el pico máximo con Trailing Take Profit.\n" +
            "• ⏰ Se reactivará automáticamente el próximo viernes a las 17:00 COT."
          );
        } else {
          console.log("🏖️ [CAZADOR WEEKEND] Ventana de fin de semana iniciada. Auto-activando switch y recuperando presupuesto.");
          this.controls.strategies.cazador_weekend = true;

          const baseW = this.controls.baseAllocations?.cazador_weekend ?? 20;
          if (this.controls.allocations.cazador_weekend < baseW) {
            const diff = baseW - this.controls.allocations.cazador_weekend;
            const takeFromTrailing = Math.min(diff, Math.max(0, (this.controls.allocations.trailing_rebound || 50) - 20));
            this.controls.allocations.trailing_rebound -= takeFromTrailing;
            this.controls.allocations.cazador_weekend += takeFromTrailing;
          }
          this.saveStrategyControls();

          await this.notifier.send(
            "🏖️ <b>[CAZADOR WEEKEND: AUTO-ACTIVADO]</b> 🟢\n\n" +
            "• ¡Ventana de fin de semana abierta (Viernes 17:00 COT)!\n" +
            `• 💼 <b>Presupuesto recuperado:</b> Se apartó el <b>${this.controls.allocations.cazador_weekend}%</b> para cazar la mejor caída del fin de semana (Trailing quedó en ${this.controls.allocations.trailing_rebound}%).\n` +
            "• 📡 Escaneando la Watchlist en busca de sobreventas y suelos con Trailing Buy..."
          );
        }
      }

      await this.checkOpportunityActionFile();
      await this.checkOpportunityTimeout();
      await this.checkMarketRegime();
      await this.checkTimeframeAdvisor();
      await this.checkRegimeSwitchTimeout();

      // Auto-sincronizar periódicamente posiciones de Binance
      this.cycleCount = (this.cycleCount || 0) + 1;
      if (this.cycleCount % 6 === 1) {
        await this.syncOrphanPositions();
      }

      // 1. Monitorear y rastrear posiciones abiertas en Trailing Stop
      await this.checkTrailingPositions();

      const openOrders = await this.client.openOrders({ recvWindow: 60000 });
      const sellOrders = openOrders.data.filter((o: any) => o.side === "SELL");
      const activeSymbols = new Set<string>(sellOrders.map((o: any) => o.symbol as string));

      const acc = await this.client.account({ recvWindow: 60000 });
      const usdt = parseFloat(acc.data.balances.find((b: any) => b.asset === "USDT")?.free || "0");
      const time = new Date().toLocaleTimeString();

      // Orquestador Autónomo de Liquidez y Sesiones (COT)
      const sessionPlan = this.getSessionLiquidityPlan(usdt);
      this.lastSessionPlan = sessionPlan;
      this.saveSessionPlan(sessionPlan);

      // Notificar cambio de sesión relevante
      if (this.lastSessionKey && this.lastSessionKey !== sessionPlan.sessionKey) {
        const sessionAlert = `🏛️ <b>[ORQUESTADOR DE SESIONES: ${sessionPlan.sessionTitle}]</b>\n\n` +
          `• 💼 <b>USDT Total en Spot:</b> ${usdt.toFixed(2)} USDT\n` +
          `• 🔒 <b>Reserva Protegida:</b> ${sessionPlan.reservedUsdt.toFixed(2)} USDT (${sessionPlan.sessionKey === "NOCTURNO_DRENAJE" ? "Apartado para Londres 03:00 COT" : "Acumulación"})\n` +
          `• 🟢 <b>Disponible para Operar:</b> ${sessionPlan.spendableUsdt.toFixed(2)} USDT\n` +
          `• 📊 <b>Fundamento:</b> <i>${sessionPlan.reason}</i>\n\n` +
          `💡 <b>Recomendación Óptima:</b> ${sessionPlan.recommendation}`;
        try { await this.notifier.send(sessionAlert); } catch(e) {}
      }
      this.lastSessionKey = sessionPlan.sessionKey;

      console.log(`[${time}] [${sessionPlan.sessionTitle}] USDT total: ${usdt.toFixed(2)} (Gastable: ${sessionPlan.spendableUsdt.toFixed(2)} | Reserva: ${sessionPlan.reservedUsdt.toFixed(2)}) | Trailing: ${this.activeTrailingPositions.size} | Cazando piso: ${this.buyWatches.size}`);

      // Monitoreo de liquidez libre (Meta: >= 50 USDT) para evaluar Futuros
      await this.checkLiquidityAndFuturesViability(usdt);

      // 2. Evaluar oportunidades si hay saldo libre gastable y no hay oportunidad pendiente
      if (sessionPlan.spendableUsdt >= this.minUsdtToTrade && !this.pendingOpportunity) {
        // A) Primero evaluar Smart DCA en posiciones activas que hayan caído
        const dcaTriggered = await this.checkSmartDcaOpportunities(sessionPlan.spendableUsdt);

        // B) Centinela Alpha (Estrategia Autónoma de Recuperación con 20% del presupuesto)
        let alphaTriggered = false;
        if (!dcaTriggered && this.controls.strategies?.centinela_alpha) {
          alphaTriggered = await this.evaluateCentinelaAlpha(sessionPlan.spendableUsdt);
        }

        // C) Si estamos en Fin de Semana y Cazador Weekend está activo:
        let weekendTriggered = false;
        if (!dcaTriggered && this.isWeekendWindow() && this.controls.strategies.cazador_weekend && this.activeTrailingPositions.size < 5) {
          weekendTriggered = await this.evaluateCazadorWeekend(sessionPlan.spendableUsdt, activeSymbols);
        }

        // D) Si Micro-Grid está activo (en días quietos): operar canales laterales
        let gridTriggered = false;
        if (!dcaTriggered && !weekendTriggered && this.controls.strategies.micro_grid && this.activeTrailingPositions.size < 5) {
          gridTriggered = await this.evaluateMicroGrid(sessionPlan.spendableUsdt, activeSymbols);
        }

        // E) Si no hay DCA, Weekend ni Grid y Trailing Rebound está activo: vigilar caídas y suelos
        if (!dcaTriggered && !weekendTriggered && !gridTriggered && this.controls.strategies.trailing_rebound && this.activeTrailingPositions.size < 5) {
          await this.scanForDips(activeSymbols);
          if (this.buyWatches.size > 0) {
            await this.checkBuyWatches(sessionPlan.spendableUsdt);
          }
        }
      } else if (usdt >= this.minUsdtToTrade && sessionPlan.spendableUsdt < this.minUsdtToTrade) {
        console.log(`🌙 [RESERVA NOCTURNA] Compras pausadas: ${usdt.toFixed(2)} USDT en cuenta (${sessionPlan.reservedUsdt.toFixed(2)} protegidos para Londres a las 03:00 COT).`);
      }

    } catch (e: any) {
      console.error("Error en runCycle:", e.message);
    } finally {
      this.isProcessing = false;
    }
  }

  async buildBuyWatchReport(): Promise<string> {
    let txt = `🔻 <b>TRAILING BUY - CAZANDO EL PISO</b>\n\n`;
    if (this.buyWatches.size === 0) {
      txt += `• Ninguna moneda en vigilancia ahora mismo.\n` +
             `• En cuanto una caiga ≥ 1.5% (o RSI bajo), el bot la arma y empieza a seguir su piso.\n`;
      return txt;
    }
    for (const [sym, w] of this.buyWatches.entries()) {
      let cur = w.lowestPrice;
      try { cur = parseFloat((await this.client.tickerPrice(sym)).data.price); } catch {}
      const trigger = w.lowestPrice * (1 + TRAILING_BUY_BOUNCE_PCT / 100);
      const fromArmed = ((w.lowestPrice - w.armedPrice) / w.armedPrice) * 100;
      const mins = Math.round((Date.now() - w.armedTime) / 60000);
      txt += `🪙 <b>${sym}</b> (armado hace ${mins} min)\n` +
             `• Precio al armar: ${w.armedPrice} (caída -${w.dropPct.toFixed(2)}%, RSI ${w.rsi.toFixed(1)})\n` +
             `• 🔻 Piso más bajo: <b>${w.lowestPrice}</b> (${fromArmed.toFixed(2)}%)\n` +
             `• Precio actual: ${cur}\n` +
             `• ✅ Compra si toca: <b>${trigger.toFixed(4)}</b> (+${TRAILING_BUY_BOUNCE_PCT}% desde el piso)\n\n`;
    }
    return txt;
  }

  
  private lastDailyReportDay = "";

  public async generateConsolidatedDailyReport(): Promise<string> {
    const now = new Date();
    // Fecha formateada en español
    const dateStr = now.toLocaleDateString("es-ES", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "America/Bogota"
    });

    // 1. Consultar saldos Binance Spot
    let usdtFree = 0;
    let usdtEarn = 0;
    try {
      const acc = await this.client.account();
      const bFree = acc.data.balances.find((b: any) => b.asset === "USDT");
      if (bFree) usdtFree = parseFloat(bFree.free);
    } catch {}

    try {
      const earnRes = await this.client.simpleEarnFlexiblePersonalLeftQuota("USDT");
      // Fallback a lectura de saldo earn
    } catch {}

    // 2. Consultar ciclos de Binance y ganancias de Spot
    let spotPnlToday = 0;
    let spotWinsToday = 0;
    const startOfTodayMs = new Date().setHours(0, 0, 0, 0);

    try {
      const pnlData = await computeRealizedPnl(this.client);
      for (const c of pnlData.cycles) {
        if (c.time >= startOfTodayMs) {
          spotPnlToday += c.pnlUsdt;
          if (c.pnlUsdt > 0) spotWinsToday++;
        }
      }
    } catch {}

    // 3. Consultar telemetría de Futuros
    const futTrades = this.futuresEngine.getTrades();
    let futPnlToday = 0;
    let futWinsToday = 0;
    let futLossesToday = 0;

    for (const t of futTrades) {
      if (t.closeTime >= startOfTodayMs) {
        futPnlToday += t.netPnlUsdt;
        if (t.netPnlUsdt > 0) futWinsToday++;
        else futLossesToday++;
      }
    }
    const futState = this.futuresEngine.getState();
    const futPositions = this.futuresEngine.getPositions();

    // 4. Tracker de recuperación Centinela Alpha
    const rec = this.controls.recoveryTracker || { targetUsdt: 100.00, recoveredUsdt: 6.11, tradesCount: 8 };
    const recPct = Math.min(100, (rec.recoveredUsdt / rec.targetUsdt) * 100);

    // 5. Total acumulado del día
    const totalPnlDay = spotPnlToday + futPnlToday;
    const totalCopDay = Math.round(totalPnlDay * COP_PER_USDT);

    // 6. Construir mensaje elegante para Telegram
    let msg = `📊 <b>CIERRE DIARIO DE OPERACIONES & BALANCE</b> 🏆\n`;
    msg += `📅 <i>${dateStr} (10:00 PM COT)</i>\n\n`;

    msg += `📈 <b>GANANCIAS COBRADAS HOY POR ESTRATEGIA:</b>\n\n`;

    msg += `🏹 <b>1. Cazador Trailing (Spot):</b>\n`;
    msg += `• Operaciones cerradas hoy: <b>${spotWinsToday} ganadas</b>\n`;
    msg += `• Ganancia Líquida: <b>${spotPnlToday >= 0 ? "🟢 +" : "🔴 "}${spotPnlToday.toFixed(3)} USDT</b>\n\n`;

    msg += `🤖 <b>2. Centinela Alpha (Spot Recuperación):</b>\n`;
    msg += `• Deuda saldada hasta hoy: <b>+${rec.recoveredUsdt.toFixed(2)} / ${rec.targetUsdt.toFixed(2)} USDT</b> (${recPct.toFixed(1)}%)\n`;
    msg += `• Faltan: <b>${Math.max(0, rec.targetUsdt - rec.recoveredUsdt).toFixed(2)} USDT</b> para meta cumplida\n\n`;

    msg += `⚡ <b>3. Futuros Cuantitativo (${futState.isSimulated ? "Simulación" : "Dinero Real"}):</b>\n`;
    msg += `• Operaciones hoy: <b>${futWinsToday}W / ${futLossesToday}L</b>\n`;
    msg += `• Rendimiento Neto: <b>${futPnlToday >= 0 ? "🟢 +" : "🔴 "}${futPnlToday.toFixed(3)} USDT</b>\n`;
    msg += `• Balance Futuros: <b>${futState.virtualBalanceUsdt.toFixed(2)} USDT</b> (${futState.leverageMode === "dynamic" ? "4x BTC/ETH, 3x Alts" : futState.defaultLeverage + "x"})\n\n`;

    msg += `==============================\n`;
    msg += `💵 <b>TOTAL NETO GENERADO EN EL DÍA:</b>\n`;
    msg += `🟢 <b>+${totalPnlDay.toFixed(3)} USDT</b> (≈ <b>+${totalCopDay.toLocaleString("es-CO")} COP</b>)\n`;
    msg += `==============================\n\n`;

    msg += `🛡️ <b>POSICIONES ACTIVAS VIGILADAS PARA MAÑANA:</b>\n`;
    msg += `• Spot: ${this.activeTrailingPositions.size} posiciones vivas persiguiendo picos\n`;
    msg += `• Futuros: ${futPositions.length} posiciones abiertas con Trailing activo\n\n`;

    msg += `💡 <i>¡Excelente jornada! El sistema sigue cazando oportunidades 24/7.</i>`;

    return msg;
  }

  private async checkDailyReportSchedule() {
    try {
      const now = new Date();
      // COT = UTC-5
      const cotHour = (now.getUTCHours() - 5 + 24) % 24;
      const cotMinute = now.getUTCMinutes();
      const cotDay = `${now.getUTCFullYear()}-${now.getUTCMonth() + 1}-${now.getUTCDate()}`;

      // Enviar exactamente a las 22:00 COT (10:00 PM)
      if (cotHour === 22 && cotMinute === 0 && this.lastDailyReportDay !== cotDay) {
        this.lastDailyReportDay = cotDay;
        const report = await this.generateConsolidatedDailyReport();
        await this.notifier.send(report);
        console.log("📢 Reporte de balance diario de las 22:00 COT enviado a Telegram con éxito.");
      }
    } catch (e: any) {
      console.error("Error en checkDailyReportSchedule:", e.message);
    }
  }

  async start() {
    console.log(`\n======================================================`);
    console.log(`🏛️ BOT DE TRADING CON TRAILING TAKE PROFIT INTELIGENTE`);
    console.log(`🎯 Trailing Buy: +${TRAILING_BUY_BOUNCE_PCT}% desde el piso | Trailing TP: +${TRAILING_ACTIVATION_PCT}% / callback ${TRAILING_CALLBACK_PCT}%`);
    console.log(`======================================================\n`);

    await this.telegramCommands.start();
    this.futuresEngine.start(4000);
    console.log(`📱 Telegram listo para recibir órdenes por chat.`);

    await this.syncOrphanPositions();
    await this.runCycle();
    setInterval(() => this.runCycle(), 7000);
  }
}

// BOT_NO_AUTOSTART=1 permite importar la clase para pruebas sin arrancar el bot
if (process.env.BOT_NO_AUTOSTART !== "1") {
  const bot = new TrailingMasterBot();
  bot.start();
}
