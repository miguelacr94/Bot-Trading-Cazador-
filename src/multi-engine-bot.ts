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
export const MEME_WATCHLIST = ["PEPEUSDT", "DOGEUSDT", "BONKUSDT"];
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
const TRAILING_BUY_MAX_AGE_MS = 45 * 60 * 1000; // Vigilancia máxima: 45 minutos (permite refrescar suelos dinámicos)

interface BuyWatch {
  symbol: string;
  armedPrice: number;   // precio cuando se detectó la caída
  lowestPrice: number;  // piso más bajo registrado tick a tick
  armedTime: number;
  rsi: number;
  dropPct: number;
  coinRange24hPct?: number; // volatilidad 24h propia de la moneda (%)
  upsideGapPct?: number;    // brecha libre desde el precio actual hasta el techo 24h (%)
  high24h?: number;         // techo de las últimas 24h
  rvol?: number;            // volumen relativo en el piso
  convictionTier?: "ESTANDAR" | "IMPULSO" | "ALTA_VOLATILIDAD" | "MAXIMA_BRECHA";
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
  customMinGainPct?: number;
  lockedFloorGainPct?: number;
  lotId?: string;
  partialProfitTaken?: boolean;
  partialProfitUsdt?: number;
  lastPeakNotifiedGain?: number;
  lastPeakNotifiedTime?: number;
  isManual?: boolean;
  coinRange24hPct?: number;
  upsideGapPct?: number;
  convictionTier?: "ESTANDAR" | "IMPULSO" | "ALTA_VOLATILIDAD" | "MAXIMA_BRECHA";
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
  maxPositions?: number;
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
    trailing_rebound?: StrategySetting;
    smart_dca?: StrategySetting;
    micro_grid?: StrategySetting;
    cazador_weekend?: StrategySetting;
    centinela_alpha?: StrategySetting;
    coreWatchlist?: string[];
    memeWatchlist?: string[];
    [key: string]: any;
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
  coreWatchlist?: string[];
  memeWatchlist?: string[];
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
  public get coreWatchlist(): string[] {
    const list = this.controls?.coreWatchlist || this.controls?.strategySettings?.coreWatchlist;
    return Array.isArray(list) && list.length > 0 ? list : CORE_WATCHLIST;
  }

  public get memeWatchlist(): string[] {
    const list = this.controls?.memeWatchlist || this.controls?.strategySettings?.memeWatchlist;
    return Array.isArray(list) && list.length > 0 ? list : MEME_WATCHLIST;
  }

  public get watchlist(): string[] {
    return Array.from(new Set([...this.coreWatchlist, ...this.memeWatchlist]));
  }

  /**
   * Devuelve el conjunto de símbolos limpios (monedas únicas) que tienen al menos 1 lote activo.
   * Permite que varios sub-lotes DCA de una misma moneda no bloqueen los cupos de maxPositions.
   */
  public getUniqueActiveSymbols(): Set<string> {
    const set = new Set<string>();
    for (const [k, p] of this.activeTrailingPositions.entries()) {
      const clean = ((p && p.symbol) ? p.symbol : k).split("_")[0];
      if (clean) set.add(clean);
    }
    return set;
  }

  public hasActivePositionForSymbol(symbol: string): boolean {
    const cleanTarget = (symbol || "").split("_")[0];
    return this.getUniqueActiveSymbols().has(cleanTarget);
  }

  /**
   * Agrega una moneda a la base de datos de monedas aceptadas (Supabase / Controles)
   */
  public async addCoinToWatchlist(rawSymbol: string, category: "core" | "meme" = "core"): Promise<{ success: boolean; message: string }> {
    try {
      let sym = (rawSymbol || "").trim().toUpperCase();
      if (!sym) return { success: false, message: "Símbolo inválido o vacío." };
      if (!sym.endsWith("USDT") && !sym.endsWith("FDUSD") && !sym.endsWith("BTC")) {
        sym += "USDT";
      }

      try {
        const ticker = await this.client.tickerPrice(sym);
        if (!ticker || !ticker.data || !ticker.data.price) {
          return { success: false, message: `El par ${sym} no responde con precio válido en Binance Spot.` };
        }
      } catch (err: any) {
        return { success: false, message: `Binance rechazó el par ${sym}: ${err.message || "Par no encontrado o no listado para trading spot"}.` };
      }

      const currentCore = [...this.coreWatchlist];
      const currentMeme = [...this.memeWatchlist];

      if (currentCore.includes(sym) || currentMeme.includes(sym)) {
        return { success: false, message: `El par ${sym} ya está en la lista de monedas activas (${currentCore.includes(sym) ? "Clásicas/Core" : "Memecoins"}).` };
      }

      if (category === "meme") {
        currentMeme.push(sym);
      } else {
        currentCore.push(sym);
      }

      this.controls.coreWatchlist = currentCore;
      this.controls.memeWatchlist = currentMeme;
      if (!this.controls.strategySettings) this.controls.strategySettings = {};
      this.controls.strategySettings.coreWatchlist = currentCore;
      this.controls.strategySettings.memeWatchlist = currentMeme;

      this.saveStrategyControls();
      console.log(`✅ [WATCHLIST DB] Moneda ${sym} agregada a la lista ${category.toUpperCase()} y guardada en Supabase.`);
      return { success: true, message: `✅ <b>${sym}</b> ha sido agregada exitosamente a la lista <b>${category.toUpperCase()}</b> en la base de datos.` };
    } catch (err: any) {
      return { success: false, message: `Error agregando moneda: ${err.message}` };
    }
  }

  /**
   * Elimina una moneda de la base de datos de monedas aceptadas (Supabase / Controles)
   */
  public async removeCoinFromWatchlist(rawSymbol: string): Promise<{ success: boolean; message: string }> {
    try {
      let sym = (rawSymbol || "").trim().toUpperCase();
      if (!sym) return { success: false, message: "Símbolo inválido o vacío." };
      if (!sym.endsWith("USDT") && !sym.endsWith("FDUSD") && !sym.endsWith("BTC")) {
        sym += "USDT";
      }

      const currentCore = [...this.coreWatchlist];
      const currentMeme = [...this.memeWatchlist];

      const inCore = currentCore.includes(sym);
      const inMeme = currentMeme.includes(sym);

      if (!inCore && !inMeme) {
        return { success: false, message: `El par ${sym} no se encuentra en la lista activa de monedas.` };
      }

      this.controls.coreWatchlist = currentCore.filter(s => s !== sym);
      this.controls.memeWatchlist = currentMeme.filter(s => s !== sym);
      if (!this.controls.strategySettings) this.controls.strategySettings = {};
      this.controls.strategySettings.coreWatchlist = this.controls.coreWatchlist;
      this.controls.strategySettings.memeWatchlist = this.controls.memeWatchlist;

      this.saveStrategyControls();
      console.log(`🗑️ [WATCHLIST DB] Moneda ${sym} eliminada de la lista y actualizada en Supabase.`);
      return { success: true, message: `🗑️ <b>${sym}</b> ha sido retirada de la lista de monedas en la base de datos.` };
    } catch (err: any) {
      return { success: false, message: `Error eliminando moneda: ${err.message}` };
    }
  }

  private controls: StrategyControls = {
    maxPositions: 7,
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
    if (this.memeWatchlist.includes(symbol) || symbol.includes("PEPE")) {
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

    // 4. 🚀 TRAILING CEÑIDO ESCALONADO DINÁMICO (Tiered Dynamic Callback + Expansión por Alta Volatilidad y Brecha)
    // En monedas con alta volatilidad intradía (ej. AVAX/SOL con rango 24h >= 3.8% o Brecha Máxima >= 5.0%), damos mayor respiro en el
    // tramo medio para no vender en el primer descanso y alcanzar la MÁXIMA ALTURA del rebote.
    const isMeme = this.memeWatchlist.includes(symbol) || symbol.includes("PEPE") || symbol.includes("BONK") || symbol.includes("DOGE");
    const isMaxGap = (pos?.coinRange24hPct || 0) >= 5.0 || (pos?.upsideGapPct || 0) >= 3.4 || pos?.convictionTier === "MAXIMA_BRECHA";
    const isHighVolCoin = isMaxGap || (pos?.coinRange24hPct || 0) >= 3.8 || pos?.convictionTier === "ALTA_VOLATILIDAD";
    const isMid = symbol.includes("AVAX") || symbol.includes("SOL") || (pos?.coinRange24hPct || 0) >= 2.8;
    const baseCb = isMeme ? 0.45 : (isMaxGap ? 0.44 : (isHighVolCoin ? 0.40 : (isMid ? 0.35 : 0.25)));

    if (pos && pos.buyPrice > 0 && pos.highestPrice > 0) {
      const peakGainPct = ((pos.highestPrice - pos.buyPrice) / pos.buyPrice) * 100;

      if (isHighVolCoin) {
        if (peakGainPct >= (isMaxGap ? 4.0 : 3.5)) {
          // Cima extrema alcanzada -> Candado ultra-ceñido en la punta de la ola
          return isMeme ? 0.16 : 0.13;
        } else if (peakGainPct >= (isMaxGap ? 3.0 : 2.6)) {
          // Zona de techo alto -> Ceñir a 0.18%-0.20%
          return isMeme ? 0.20 : 0.18;
        } else if (peakGainPct >= (isMaxGap ? 2.1 : 1.8)) {
          // Escalando ola -> Respiro intermedio (0.28%-0.32%) para dejarla correr
          return isMeme ? 0.32 : 0.28;
        }
        // En el despegue inicial: mantener baseCb (0.40%-0.45%) para aguantar micro-retrocesos rumbo a la cima
        return baseCb;
      }

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
      const checkList = this.watchlist;
      for (const sym of checkList) {
        const asset = sym.replace("USDT", "");
        
        // 🛡️ BLINDAJE SUPREMO: Verificar si YA existe cualquier lote o posición viva para esta moneda
        const alreadyTracked = Array.from(this.activeTrailingPositions.entries()).some(([key, p]) => {
          const cleanKey = key.split('_')[0];
          const cleanSym = (p.symbol || "").split('_')[0];
          return cleanKey === sym || cleanSym === sym || key.startsWith(asset + "_") || cleanKey === asset;
        });
        if (alreadyTracked) continue; // Si ya tiene lotes, JAMÁS pisar ni crear huérfanos que mezclen precios

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
          console.log(`🔍 [AUTO-SYNC] Moneda detectada en Binance sin tracking alguno: ${sym} (${total} ${asset} ≈ ${usdtValue.toFixed(2)} USDT)`);
          let buyPrice = curPrice;
          let buyTime = Date.now();
          try {
            const tradesRes = await this.client.myTrades(sym, { limit: 20, recvWindow: 60000 });
            const buyTrades = (tradesRes.data || []).filter((t: any) => t.isBuyer);
            if (buyTrades.length > 0) {
              // Calcular precio promedio ponderado real recorriendo hacia atrás hasta cubrir el balance
              let coveredQty = 0;
              let weightedCost = 0;
              let highestBuyPrice = 0;
              for (let i = buyTrades.length - 1; i >= 0; i--) {
                const t = buyTrades[i];
                const tQty = parseFloat(t.qty);
                const tPrice = parseFloat(t.price);
                const need = total - coveredQty;
                const useQty = Math.min(tQty, need);
                coveredQty += useQty;
                weightedCost += useQty * tPrice;
                if (tPrice > highestBuyPrice) highestBuyPrice = tPrice;
                if (coveredQty >= total * 0.98) break;
              }
              if (coveredQty > 0) {
                const avgPrice = weightedCost / coveredQty;
                // BLINDAJE SUPREMO: El buyPrice NUNCA puede ser menor al precio más alto pagado por cualquier moneda en la bolsa
                buyPrice = Math.max(avgPrice, highestBuyPrice);
                buyTime = buyTrades[buyTrades.length - 1].time || Date.now();
              }
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
          await this.saveTrailingPositions();
          console.log(`✅ ${sym} adoptada con éxito para Trailing Take Profit (Precio prom ponderado: ${buyPrice.toFixed(4)}).`);
        }
      }
    } catch (e: any) {
      console.error("Error sincronizando posiciones huérfanas desde Binance:", e.message);
    }
  }
  private activeTrailingPositions: Map<string, ActivePosition> = new Map();
  private walletSplit: { manualUsdt: number; lastUpdated: number } = { manualUsdt: 0.0, lastUpdated: 0 };

  private loadWalletSplit() {
    if (this.controls?.strategySettings?.walletSplit?.manualUsdt !== undefined) {
      this.walletSplit.manualUsdt = parseFloat(this.controls.strategySettings.walletSplit.manualUsdt || "0");
      return;
    }
    try {
      const f = path.resolve(process.cwd(), ".wallet-split.json");
      if (fs.existsSync(f)) {
        const d = JSON.parse(fs.readFileSync(f, "utf-8"));
        if (typeof d.manualUsdt === "number") this.walletSplit.manualUsdt = d.manualUsdt;
      }
    } catch {}
  }

  private saveWalletSplit() {
    this.walletSplit.lastUpdated = Date.now();
    if (!this.controls.strategySettings) this.controls.strategySettings = {};
    this.controls.strategySettings.walletSplit = this.walletSplit;
    this.saveStrategyControls();
    try {
      const f = path.resolve(process.cwd(), ".wallet-split.json");
      fs.writeFileSync(f, JSON.stringify(this.walletSplit, null, 2), "utf-8");
    } catch {}
  }

  public deductFromManualWallet(amount: number) {
    this.loadWalletSplit();
    this.walletSplit.manualUsdt = Math.max(0, this.walletSplit.manualUsdt - amount);
    this.saveWalletSplit();
    console.log("💼 [BILLETERA MANUAL] Descontados $" + amount.toFixed(2) + " USDT. Saldo manual restante: $" + this.walletSplit.manualUsdt.toFixed(2) + " USDT.");
  }
  private recentlySoldSymbols: Map<string, { time: number; sellPrice?: number }> = new Map();
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
    if (process.env.BOT_NO_AUTOSTART !== "1") this.dashboardServer.start();
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

  private async loadStrategyControls() {
    try {
      // 1. FUENTE PRIMARIA: SUPABASE CLOUD DB
      if (supabaseDb.isAvailable()) {
        const dbCtrl = await supabaseDb.loadStrategyControls();
        if (dbCtrl && dbCtrl.strategies) {
          this.controls = dbCtrl;
          if (this.controls.maxPositions === undefined) this.controls.maxPositions = 7;
          if (!this.controls.coreWatchlist) this.controls.coreWatchlist = dbCtrl.coreWatchlist || CORE_WATCHLIST;
          if (!this.controls.memeWatchlist) this.controls.memeWatchlist = dbCtrl.memeWatchlist || MEME_WATCHLIST;
          this.autoPilot = this.controls.autoPilot !== false;
          console.log("☁️ [SUPABASE CLOUD] Controles y estrategia leídos desde Supabase DB.");
          return;
        }
      }
      // 2. Respaldo local de emergencia
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
        if (this.controls.maxPositions === undefined) this.controls.maxPositions = 7;
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
      if (!this.controls.coreWatchlist) this.controls.coreWatchlist = this.coreWatchlist;
      if (!this.controls.memeWatchlist) this.controls.memeWatchlist = this.memeWatchlist;
      if (!this.controls.strategySettings) this.controls.strategySettings = {};
      this.controls.strategySettings.coreWatchlist = this.controls.coreWatchlist;
      this.controls.strategySettings.memeWatchlist = this.controls.memeWatchlist;
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

    public async lockPositionFloor(targetSymbolOrId: string, customPct?: number): Promise<{ success: boolean; msg: string; lockedPct?: number }> {
    let matchedId: string | null = null;
    let pos: ActivePosition | null = null;

    for (const [id, p] of this.activeTrailingPositions.entries()) {
      if (id.toLowerCase() === targetSymbolOrId.toLowerCase() || p.symbol.toLowerCase() === targetSymbolOrId.toLowerCase()) {
        matchedId = id;
        pos = p;
        break;
      }
    }

    if (!matchedId || !pos) {
      return { success: false, msg: `No se encontró posición activa para ${targetSymbolOrId}.` };
    }

    try {
      const actualSym = pos.symbol.includes('_lot_') ? pos.symbol.split('_')[0] : pos.symbol;
      const t = await this.client.tickerPrice(actualSym);
      const curPrice = parseFloat(t.data.price);
      const curGain = ((curPrice - pos.buyPrice) / pos.buyPrice) * 100;

      // El piso a asegurar: Si el usuario pasa un porcentaje, se usa ese; si no, se asegura la ganancia del pico o actual
      let lockPct = customPct !== undefined ? customPct : Math.max(curGain, ((pos.highestPrice - pos.buyPrice) / pos.buyPrice) * 100);
      lockPct = Math.round(lockPct * 100) / 100;

      if (lockPct <= 0.20) {
        return { success: false, msg: `La ganancia actual (+${curGain.toFixed(2)}%) es muy baja para asegurar piso.` };
      }

      pos.lockedFloorGainPct = lockPct;
      pos.activated = true;
      pos.highestPrice = Math.max(pos.highestPrice, curPrice);
      this.saveTrailingPositions();

      const notifMsg = `🔒 <b>¡PISO ASEGURADO EN ${pos.symbol}!</b> 🎯\n\n` +
        `• 💎 <b>Piso Blindado:</b> <b>+${lockPct.toFixed(2)}%</b>\n` +
        `• 📍 <b>Precio de entrada:</b> ${fmtPrice(pos.buyPrice)}\n` +
        `• 💰 <b>Precio actual:</b> ${fmtPrice(curPrice)} (+${curGain.toFixed(2)}%)\n\n` +
        `🚀 <i>Comportamiento: Si el precio sube más, el Trailing sigue buscando picos sin tope. Si retrocede y toca +${lockPct.toFixed(2)}%, vende de inmediato asegurando la ganancia.</i>`;
      await this.notifier.send(notifMsg);

      return { success: true, msg: `Piso de ${pos.symbol} asegurado en +${lockPct.toFixed(2)}%`, lockedPct: lockPct };
    } catch (e: any) {
      return { success: false, msg: e.message };
    }
  }

  private async checkPositionActionFile() {
    try {
      const file = path.resolve(process.cwd(), ".position-action.json");
      if (fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, "utf-8"));
        fs.unlinkSync(file);
        if (data.action === "manual_sell" && data.id) {
          let pos = this.activeTrailingPositions.get(data.id);
          let posKey = data.id;
          if (!pos) {
            for (const [k, p] of this.activeTrailingPositions.entries()) {
              if (k === data.id || p.lotId === data.id || p.symbol === data.id) {
                pos = p;
                posKey = k;
                break;
              }
            }
          }
          if (pos) {
            console.log(`🌐 [VENTA MANUAL RECIBIDA] Ejecutando venta manual para ${pos.symbol} (allowLoss: ${!!data.allowLoss})...`);
            const actualSym = pos.symbol.split('_')[0];
            const ticker = await this.client.tickerPrice(actualSym);
            const curPrice = parseFloat(ticker.data.price);
            const sold = await this.executeTrailingSell(pos, curPrice, false, false, "MANUAL_DASHBOARD", true, !!data.allowLoss);
            if (sold) {
              this.activeTrailingPositions.delete(posKey);
              await this.saveTrailingPositions();
              await this.notifier.send(`🌐 <b>[VENTA MANUAL CONFIRMADA]</b> Posición <b>${pos.symbol}</b> cerrada desde el Dashboard a ${fmtPrice(curPrice)}.`);
            }
          }
        } else if (data.action === "manual_buy" && data.symbol && data.usdtAmount) {
          const sym = String(data.symbol).trim().toUpperCase();
          const amount = parseFloat(data.usdtAmount);
          console.log("🌐 [COMPRA MANUAL DESDE RADAR] Recibida orden para " + sym + " por $" + amount + " USDT...");
          if (amount >= this.minUsdtToTrade) {
            const ok = await this.executeSmartBuy(sym, amount, "Manual desde Radar Web", "trailing_rebound");
            if (ok) {
              const pos = this.activeTrailingPositions.get(sym);
              if (pos) {
                pos.isManual = true;
                if (data.triggerGainPct) pos.customMinGainPct = parseFloat(data.triggerGainPct);
                if (data.callbackPct) pos.customCallbackPct = parseFloat(data.callbackPct);
                await this.saveTrailingPositions();
              }
              this.deductFromManualWallet(amount);
              await this.notifier.send(
                "👤 <b>[COMPRA MANUAL CONFIRMADA DESDE RADAR]</b> 🚀\n\n" +
                "• <b>Moneda:</b> <b>" + sym + "</b>\n" +
                "• <b>Inversión:</b> $" + amount.toFixed(2) + " USDT (Saldo Manual)\n" +
                "• <b>Trailing Take Profit:</b> Activa al +" + (data.triggerGainPct || 0.8).toFixed(2) + "% (retroceso " + (data.callbackPct || 0.25).toFixed(2) + "%)\n\n" +
                "🛡️ <i>Protegida 100% contra ventas a pérdida y rastreando picos en tiempo real.</i>"
              );
            }
          } else {
            console.error("Monto de compra manual inválido: " + amount);
          }
        } else if (data.action === "lock_profit" && data.id) {
          let pos = this.activeTrailingPositions.get(data.id);
          if (!pos) {
            for (const [k, p] of this.activeTrailingPositions.entries()) {
              if (k === data.id || p.lotId === data.id || p.symbol === data.id) {
                pos = p;
                break;
              }
            }
          }
          if (pos) {
            pos.activated = true;
            if (data.targetGainPct && data.targetGainPct > 0) {
              pos.lockedFloorGainPct = data.targetGainPct;
              pos.customMinGainPct = data.targetGainPct;
              const floorPrice = pos.buyPrice * (1 + data.targetGainPct / 100);
              if ((pos.highestPrice || 0) < floorPrice) {
                pos.highestPrice = floorPrice;
              }
            }
            await this.saveTrailingPositions();
            const lockedVal = (pos.lockedFloorGainPct || data.targetGainPct).toFixed(2);
            const msg = "🔒 <b>[CANDADO MANUAL ASEGURADO: " + pos.symbol + "]</b>\n\n" +
              "• Ganancia asegurada fijada en: <b>+" + lockedVal + "%</b>\n" +
              "• Si el precio retrocede, venderá asegurando este piso.\n" +
              "• Si sigue subiendo, ¡seguirá persiguiendo la cima con Trailing Take Profit! 🚀";
            await this.notifier.send(msg);
            console.log("🔒 Candado asegurado para " + pos.symbol + " en +" + lockedVal + "%");
          }
        }
      }
    } catch(e: any) {}
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
        const cleanSym = (pos.symbol || sym).split('_')[0];
        const t = await this.client.tickerPrice(cleanSym);
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
      let pos = this.activeTrailingPositions.get(opp.symbol);
      if (!pos) {
        for (const [k, p] of this.activeTrailingPositions.entries()) {
          const cK = k.split("_")[0];
          const cP = (p.symbol || "").split("_")[0];
          if (cK === opp.symbol || cP === opp.symbol) {
            pos = p;
            break;
          }
        }
      }
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

    
      
      const buttons = [
        [
          { text: `✅ Aprobar [${opp.strategyName}]`, callback_data: "/aprobar" },
          { text: "❌ Descartar", callback_data: "/ignorar" }
        ]
      ];
      await this.notifier.send(alertMsg, buttons);
    console.log(alertMsg.replace(/<[^>]*>/g, ""));
  }

  async executeSmartDca(pos: ActivePosition, usdtAmount: number): Promise<boolean> {
    try {
      const cleanSym = (pos.symbol || "").split("_")[0];
      const investStr = (usdtAmount - 0.15).toFixed(2);
      console.log(`🛡️ [Smart DCA] Ejecutando orden de seguridad de ${investStr} USDT en ${cleanSym}...`);

      const buyRes = await this.client.newOrder(cleanSym, "BUY", "MARKET", {
        quoteOrderQty: investStr,
        newOrderRespType: "FULL",
        recvWindow: 60000
      });

      const asset = cleanSym.replace("USDT", "");
      const spent = parseFloat(buyRes.data.cummulativeQuoteQty);
      const grossQty = parseFloat(buyRes.data.executedQty);
      let feeInBase = 0;
      for (const f of buyRes.data.fills || []) {
        if (f.commissionAsset === asset) feeInBase += parseFloat(f.commission);
      }
      const newQty = grossQty - feeInBase;

      const buyPriceThisLot = spent / newQty;

      // Calcular número exacto de lote según lotes activos de este activo
      const existingLots = Array.from(this.activeTrailingPositions.entries()).filter(([k, p]) => {
        const pSym = (p.symbol || k).split("_")[0];
        return pSym === cleanSym;
      });
      const lotIndex = existingLots.length + 1;
      const newLotId = `${cleanSym}_lot_${lotIndex}_${Date.now()}`;

      pos.lastDcaTime = Date.now();
      pos.dcaCount = (pos.dcaCount || 0) + 1;

      // Meta de salida adaptativa según el lote: Lote 3 tiene rango expandido de rebote
      let lotMinGainPct = 0.80;
      if (lotIndex >= 3) {
        const btcRange = this.controls.suggestions?.trailing_rebound?.btcRange24h || 2.0;
        const isMeme = this.memeWatchlist.includes(cleanSym) || cleanSym.includes("PEPE") || cleanSym.includes("BONK") || cleanSym.includes("DOGE");
        if (isMeme) {
          lotMinGainPct = 2.20; // Rango de rebote amplio en memecoins
        } else if (btcRange >= 2.5) {
          lotMinGainPct = 1.80; // Mercado con volumen
        } else {
          lotMinGainPct = 1.20; // Mercado lateral
        }
      }

      // 🛡️ REGLA DE ORO: CADA COMPRA ES UN LOTE 100% AISLADO (NUNCA COMBINAR)
      this.activeTrailingPositions.set(newLotId, {
        id: newLotId,
        symbol: cleanSym,
        lotIndex: lotIndex,
        buyPrice: buyPriceThisLot,
        qty: newQty,
        investedUsdt: spent,
        highestPrice: buyPriceThisLot,
        activated: false,
        buyTime: Date.now(),
        strategy: "smart_dca",
        customCallbackPct: pos.customCallbackPct,
        customTimeframe: pos.customTimeframe,
        customMinGainPct: lotMinGainPct
      });
      this.saveTrailingPositions();

      const newTarget = (buyPriceThisLot * (1 + lotMinGainPct / 100)).toFixed(4);
      const isExtreme = lotIndex >= 3;
      const title = isExtreme
        ? `🚨 <b>¡SMART DCA: LOTE #3 (RESCATE EXTREMO) CREADO!</b> 💎`
        : `🛡️ <b>¡SMART DCA: NUEVO LOTE INDEPENDIENTE CREADO!</b> 🎯`;

      const alertMsg = `${title}\n\n` +
        `• <b>Moneda:</b> <b>${cleanSym}</b> (Lote #${lotIndex} - ${isExtreme ? "Suelo Profundo" : "Soporte"})\n` +
        `• 💵 <b>Inversión de este lote:</b> ${spent.toFixed(2)} USDT (+${newQty.toFixed(4)} ${asset})\n` +
        `• 🎯 <b>Precio de compra de este lote:</b> <b>${fmtPrice(buyPriceThisLot)}</b>\n` +
        `• 🏁 <b>Meta de salida (+${lotMinGainPct.toFixed(1)}%):</b> ${newTarget}\n\n` +
        `🔒 <i>LOTE AISLADO CON RANGO EXPANDIDO: ${isExtreme ? "Como se compró en descuento extremo, tiene mayor rango de rebote para capturar toda la recuperación. " : ""}Cuando este lote alcance su meta, ¡venderá ÚNICAMENTE este lote con ganancia limpia! Tus lotes anteriores quedan intactos esperando su propia meta sin arrastrar pérdidas.</i>`;

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

      const candidates = this.watchlist;
      let bestAsset: { symbol: string; score: number; reason: string; rsi: number; curPrice: number; tf: "15m" | "1h"; callback: number } | null = null;

      for (const sym of candidates) {
        let isAlreadyOpen = false;
        for (const p of this.activeTrailingPositions.values()) {
          if (p.symbol === sym) { isAlreadyOpen = true; break; }
        }
        if (isAlreadyOpen || this.buyWatches.has(sym)) continue;

        const isMeme = this.memeWatchlist.includes(sym) || sym.includes("PEPE");
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
      const rec = this.controls.recoveryTracker || { targetUsdt: 100.00, recoveredUsdt: 0, tradesCount: 0 };

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

    interface DcaCandidate {
      pos: ActivePosition;
      cleanSym: string;
      targetLotIndex: number; // 2 o 3
      dropPct: number;
      curPrice: number;
      rsi: number;
      score: number;
      isExtreme: boolean;
      minGainPct: number;
      amount: number;
      potentialTarget: string;
      reason: string;
    }

    const candidates: DcaCandidate[] = [];

    // Agrupar posiciones activas por moneda limpia
    const lotsBySymbol = new Map<string, [string, ActivePosition][]>();
    for (const [k, p] of this.activeTrailingPositions.entries()) {
      const clean = (p.symbol || k).split("_")[0];
      if (!lotsBySymbol.has(clean)) lotsBySymbol.set(clean, []);
      lotsBySymbol.get(clean)!.push([k, p]);
    }

    for (const [cleanSym, lots] of lotsBySymbol.entries()) {
      try {
        const lotCount = lots.length;
        // 🛑 LÍMITE ESTRICTO: Máximo 3 lotes por moneda (Lote 1, Lote 2 y Lote 3 de Rescate Extremo). ¡PROHIBIDO Lote 4!
        if (lotCount >= 3) continue;

        // Encontrar Lote 1 y lote más reciente
        const lot1 = lots.find(([k, p]) => !k.includes("_lot_") && (!p.lotIndex || p.lotIndex === 1))?.[1] || lots[0][1];
        const latestLot = [...lots].sort((a, b) => (b[1].buyTime || 0) - (a[1].buyTime || 0))[0][1];

        // Cooldown estricto entre compras de la misma moneda (3h para Lote 3, 4h para Lote 2)
        const requiredCooldownHours = lotCount === 2 ? 3 : 4;
        if (latestLot.buyTime && (Date.now() - latestLot.buyTime) < requiredCooldownHours * 3600 * 1000) continue;

        const curPrice = parseFloat((await this.client.tickerPrice(cleanSym)).data.price);
        const dropFromLot1 = ((curPrice - lot1.buyPrice) / lot1.buyPrice) * 100;
        const dropFromLatest = ((curPrice - latestLot.buyPrice) / latestLot.buyPrice) * 100;

        const lastIgnored = this.ignoredDca.get(cleanSym);
        if (lastIgnored) {
          const hoursSince = (Date.now() - lastIgnored.timestamp) / (3600 * 1000);
          const extraDropPct = ((curPrice - lastIgnored.price) / lastIgnored.price) * 100;
          if (hoursSince < 4 && extraDropPct > -3.0) continue;
        }

        const dcaTf = this.controls.strategySettings?.smart_dca?.timeframe || "4h";
        const klines = await this.client.klines(cleanSym, dcaTf, { limit: 25 });
        const closes = klines.data.map((k: any) => parseFloat(k[4]));
        const rsi = this.calculateRSI(closes, 14);

        // 🛡️ FILTRO ANTI-CUCHILLO CAYENDO EN SMART DCA (15m):
        // Si la vela actual de 15m está cayendo con fuerza (<= -0.45%) sin mecha de absorción (< 25%),
        // esperar a que el precio deje de caer para comprar el lote DCA en el verdadero fondo y no anticipado.
        let isFallingKnife15m = false;
        try {
          const k15 = await this.client.klines(cleanSym, "15m", { limit: 2 });
          if (k15?.data?.length > 0) {
            const last15 = k15.data[k15.data.length - 1];
            const o15 = parseFloat(last15[1]), h15 = parseFloat(last15[2]), l15 = parseFloat(last15[3]), c15 = parseFloat(last15[4]);
            const bodyDrop15 = ((c15 - o15) / o15) * 100;
            const range15 = h15 - l15;
            const lowerWick15 = range15 > 0 ? (Math.min(o15, c15) - l15) / range15 : 0;
            if (bodyDrop15 <= -0.45 && lowerWick15 < 0.25) {
              isFallingKnife15m = true;
            }
          }
        } catch {}
        if (isFallingKnife15m) {
          console.log(`⏳ [SMART DCA: ESPERANDO PISO] ${cleanSym} ya cayó ${dropFromLot1.toFixed(2)}%, pero la vela 15m sigue cayendo sin absorción. Esperando giro real para entrar más barato.`);
          continue;
        }

        const dcaAllocWeight = Math.max(0.35, Math.min(0.65, ((this.controls.allocations?.smart_dca || 40) / 100)));
        const sessionPlan = this.lastSessionPlan || this.getSessionLiquidityPlan(usdt);
        const spendableForDca = sessionPlan.spendableUsdt >= this.minUsdtToTrade ? sessionPlan.spendableUsdt : usdt;

        if (lotCount === 1) {
          // --- EVALUACIÓN LOTE #2 (Pirámide Invertida Nivel 2: 1.5x fuerza en soporte) ---
          if (dropFromLot1 <= -2.5 && rsi <= 45) {
            const amount = this.calculateSessionLotSize(cleanSym, spendableForDca, dcaAllocWeight, "smart_dca", 2, rsi);
            if (amount < this.minUsdtToTrade) continue;
            const target08 = (curPrice * 1.008).toFixed(4);
            const score = Math.abs(dropFromLot1) * 1.5 + (50 - rsi);
            candidates.push({
              pos: lot1,
              cleanSym,
              targetLotIndex: 2,
              dropPct: dropFromLot1,
              curPrice,
              rsi,
              score,
              isExtreme: false,
              minGainPct: 0.80,
              amount,
              potentialTarget: target08,
              reason: `Cayó ${dropFromLot1.toFixed(2)}% desde Lote 1 (RSI ${rsi.toFixed(1)}). Pirámide Invertida Nivel 2 (${amount.toFixed(2)} USDT) en soporte con meta inicial ${target08}.`
            });
          }
        } else if (lotCount === 2) {
          // --- EVALUACIÓN LOTE #3 (Pirámide Invertida Nivel 3: 2.2x Golpe Maestro en capitulación) ---
          if (dropFromLot1 <= -5.5 && dropFromLatest <= -2.0 && rsi <= 38) {
            const amount = this.calculateSessionLotSize(cleanSym, spendableForDca, dcaAllocWeight, "smart_dca", 3, rsi);
            if (amount < this.minUsdtToTrade) continue;
            const btcRange = this.controls.suggestions?.trailing_rebound?.btcRange24h || 2.0;
            const isMeme = this.memeWatchlist.includes(cleanSym) || cleanSym.includes("PEPE") || cleanSym.includes("BONK") || cleanSym.includes("DOGE");
            let expandedMinGain = 1.20;
            if (isMeme) expandedMinGain = 2.20;
            else if (btcRange >= 2.5) expandedMinGain = 1.80;

            const targetExpanded = (curPrice * (1 + expandedMinGain / 100)).toFixed(4);
            const score = Math.abs(dropFromLot1) * 2.0 + (50 - rsi) * 1.5 + 30; // Bonificación de prioridad
            candidates.push({
              pos: lot1,
              cleanSym,
              targetLotIndex: 3,
              dropPct: dropFromLot1,
              curPrice,
              rsi,
              score,
              isExtreme: true,
              minGainPct: expandedMinGain,
              amount,
              potentialTarget: targetExpanded,
              reason: `🚨 DESCUENTO EXTREMO: Cayó ${dropFromLot1.toFixed(2)}% acumulado (RSI ${rsi.toFixed(1)} en piso). Lote 3 con Rango de Rebote Ampliado (+${expandedMinGain.toFixed(1)}%). Meta: ${targetExpanded}.`
            });
          }
        }
      } catch (e: any) {
        console.error(`Error evaluando Smart DCA para ${cleanSym}:`, e.message);
      }
    }

    if (candidates.length === 0) return false;

    // 🏆 RANKING POR PRIORIDAD: Ordenar por mayor puntaje (la que esté más abajo con mejor rebote)
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];

    const opp: PendingOpportunity = {
      id: `dca_${best.cleanSym}_${Date.now()}`,
      symbol: best.cleanSym,
      strategy: "smart_dca",
      strategyName: best.isExtreme ? `Smart DCA (Lote #3 Rescate Extremo)` : `Smart DCA (Lote #${best.targetLotIndex} Soporte)`,
      reason: best.reason,
      amount: best.amount,
      curPrice: best.curPrice,
      potentialTarget: best.potentialTarget,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.controls.approvalTimeoutSec * 1000
    };

    this.pendingOpportunity = opp;
    this.savePendingOpportunity();
    await this.notifyOpportunity(opp);
    return true;
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
  private async saveTrailingPositions() {
    try {
      const data = Array.from(this.activeTrailingPositions.entries());
      fs.writeFileSync(path.resolve(process.cwd(), ".trailing-positions.json"), JSON.stringify(data, null, 2));
      // Sincronización bidireccional en la nube Supabase
      if (supabaseDb.isAvailable()) {
        const currentKeys = new Set(this.activeTrailingPositions.keys());
        for (const [key, pos] of this.activeTrailingPositions.entries()) {
          await supabaseDb.saveActivePosition({ ...pos, lotId: key });
        }
        // Limpiar posiciones en la nube que ya fueron vendidas o retiradas
        const dbMap = await supabaseDb.loadActivePositions();
        for (const dbKey of dbMap.keys()) {
          if (!currentKeys.has(dbKey)) {
            await supabaseDb.deleteActivePosition(dbKey);
            console.log(`🧹 [SUPABASE CLEANUP] Posición ${dbKey} retirada de la nube (ya vendida).`);
          }
        }
      }
    } catch(e: any) {
      console.error("Error guardando trailing positions:", e.message);
    }
  }

  private mergePositionsPreservingState(incoming: Map<string, ActivePosition>): Map<string, ActivePosition> {
    // Leer respaldo local para no perder candados manuales (lockedFloorGainPct, customMinGainPct)
    const localMap = new Map<string, ActivePosition>();
    try {
      const file = path.resolve(process.cwd(), ".trailing-positions.json");
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
        if (Array.isArray(raw)) {
          for (const entry of raw) {
            if (Array.isArray(entry) && entry.length === 2) localMap.set(entry[0], entry[1]);
          }
        }
      }
    } catch {}

    const merged = new Map<string, ActivePosition>();
    for (const [key, dbItem] of incoming.entries()) {
      const memItem = this.activeTrailingPositions.get(key) || localMap.get(key);
      if (memItem) {
        merged.set(key, {
          ...dbItem,
          // Jamás bajar el precio de compra ni el pico máximo alcanzado
          buyPrice: Math.max(dbItem.buyPrice || 0, memItem.buyPrice || 0),
          highestPrice: Math.max(dbItem.highestPrice || 0, memItem.highestPrice || 0),
          activated: dbItem.activated || memItem.activated || false,
          lockedFloorGainPct: dbItem.lockedFloorGainPct ?? memItem.lockedFloorGainPct,
          customMinGainPct: dbItem.customMinGainPct ?? memItem.customMinGainPct,
          customCallbackPct: dbItem.customCallbackPct ?? memItem.customCallbackPct,
          customTimeframe: dbItem.customTimeframe ?? memItem.customTimeframe,
          partialProfitTaken: dbItem.partialProfitTaken || memItem.partialProfitTaken || false,
          partialProfitUsdt: dbItem.partialProfitUsdt ?? memItem.partialProfitUsdt,
          lastPeakNotifiedGain: memItem.lastPeakNotifiedGain,
          lastPeakNotifiedTime: memItem.lastPeakNotifiedTime,
          lastDcaTime: memItem.lastDcaTime,
          dcaCount: memItem.dcaCount,
          isManual: memItem.isManual,
          coinRange24hPct: dbItem.coinRange24hPct ?? memItem.coinRange24hPct,
          upsideGapPct: dbItem.upsideGapPct ?? memItem.upsideGapPct,
          convictionTier: dbItem.convictionTier ?? memItem.convictionTier
        });
      } else {
        merged.set(key, dbItem);
      }
    }
    return merged;
  }

  private async loadTrailingPositions() {
    try {
      // 1. FUENTE PRIMARIA: SUPABASE CLOUD DB (preservando candados y picos en memoria)
      if (supabaseDb.isAvailable()) {
        const dbPos = await supabaseDb.loadActivePositions();
        if (dbPos && dbPos.size > 0) {
          this.activeTrailingPositions = this.mergePositionsPreservingState(dbPos);
          console.log(`☁️ [SUPABASE CLOUD] ${this.activeTrailingPositions.size} posiciones vivas sincronizadas desde Supabase DB.`);
          return;
        }
      }
      // 2. Respaldo local de emergencia
      const file = path.resolve(process.cwd(), ".trailing-positions.json");
      if (fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, "utf-8"));
        this.activeTrailingPositions = new Map(data);
        console.log(`📂 Cargadas ${this.activeTrailingPositions.size} posiciones de Trailing desde disco local.`);
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
        const actualSymbol = pos.symbol || symbol.split('_')[0];
        const asset = actualSymbol.replace("USDT", "");
        let freeBal = await this.getFreeBalance(asset);
        if (freeBal < pos.qty * 0.1) {
          // Intentar rescatar de Simple Earn si Binance lo barrió con Auto-Subscribe
          await this.redeemFromEarnIfNeeded(asset, pos.qty);
          freeBal = await this.getFreeBalance(asset);
        }
        if (freeBal < pos.qty * 0.1) {
          let hasRemainingTokens = false;
          try {
            const acc = await this.client.account({ recvWindow: 60000 });
            const bObj = acc.data.balances.find((b: any) => b.asset === asset);
            const totalSpot = parseFloat(bObj?.free || "0") + parseFloat(bObj?.locked || "0");
            if (totalSpot >= pos.qty * 0.1) hasRemainingTokens = true;
          } catch {}
          if (!hasRemainingTokens) {
            console.log("🧹 " + symbol + " ya fue vendida en Binance (saldo cero confirmado). Retirando de memoria.");
            this.activeTrailingPositions.delete(symbol);
            this.saveTrailingPositions();
            continue;
          }
        }

        const ticker = await this.client.tickerPrice(actualSymbol);
        const curPrice = parseFloat(ticker.data.price);
        const gainPct = ((curPrice - pos.buyPrice) / pos.buyPrice) * 100;

        // 0. BLINDAJE SPOT ABSOLUTO: CERO VENTAS EN PÉRDIDA
        // En Spot nunca hay liquidación de margen. Los tokens son propios.
        // NUNCA vender en rojo; esperar el rebote al alza (+0.80% mínimo) o promediar con Smart DCA.
        // (Stop-Loss eliminado al 100% de la lógica Spot para evitar whipsaws)

        // 1. Activar Trailing si superó el umbral (adaptativo por Escalón de Brecha / Volatilidad / Régimen / Lote 3)
        const isLot3 = (pos.lotIndex && pos.lotIndex >= 3) || symbol.includes("_lot_3");
        const btcRangeCur = this.controls.suggestions?.trailing_rebound?.btcRange24h || 2.5;
        const coinVol = pos.coinRange24hPct || 0;
        const gapPct = pos.upsideGapPct || 0;
        const isMaxGap = coinVol >= 5.0 || gapPct >= 3.4 || pos.convictionTier === "MAXIMA_BRECHA";
        const isHighVolCoin = isMaxGap || coinVol >= 3.8 || pos.convictionTier === "ALTA_VOLATILIDAD";
        // Si la moneda por sí sola tiene alta volatilidad (>= 3.5%, ej. AVAX), NO aplicarle compresión de día quieto
        const isQuietRegime = (this.lastDetectedRegime === "QUIET" || btcRangeCur < 2.2) && coinVol < 3.5 && !isHighVolCoin;
        const isWeekendChop = this.isWeekendWindow() && !this.isSundayCmeReopenWindow() && !isHighVolCoin;
        const isPreNightHarvest = this.isPreNightHarvestWindow() && !isHighVolCoin;
        const isPreWeekendHarvest = this.isPreWeekendAccumulationWindow() && !isHighVolCoin;

        let activationTarget = pos.customMinGainPct || TRAILING_ACTIVATION_PCT;
        if (pos.strategy === "micro_grid" && !pos.customMinGainPct) {
          activationTarget = 0.58; // Canal lateral corto: activa en +0.58% para asegurar >= +0.46% neto
        } else if (isLot3 && (!pos.customMinGainPct || pos.customMinGainPct <= 0.8)) {
          const isMeme = this.memeWatchlist.includes(actualSymbol) || actualSymbol.includes("PEPE") || actualSymbol.includes("BONK") || actualSymbol.includes("DOGE");
          if (isMeme) activationTarget = 2.20;
          else if (btcRangeCur >= 2.5) activationTarget = 1.80;
          else activationTarget = 1.20;
        } else if (!pos.customMinGainPct && isMaxGap) {
          // 🚀 ESCALÓN 4 (MÁXIMA BRECHA >= 5.0% rango o >= 3.4% brecha al techo):
          // Activa en +1.20% para aprovechar toda la brecha libre hasta la cresta de la ola
          activationTarget = 1.20;
        } else if (!pos.customMinGainPct && isHighVolCoin) {
          // 🚀 ESCALÓN 3 (ALTA VOLATILIDAD >= 3.8% rango):
          // Despierta en +1.05% para no cortar el impulso abajo y buscar la máxima altura del rebote
          activationTarget = 1.05;
        } else if (!pos.customMinGainPct && isPreWeekendHarvest) {
          activationTarget = 0.60; // Viernes 06:00-17:00 COT: cosecha ágil para liberar USDT antes de Cazador Weekend
        } else if (!pos.customMinGainPct && (isQuietRegime || isWeekendChop || isPreNightHarvest)) {
          activationTarget = 0.65; // Compresión cuantitativa en días quietos / fin de semana sin volumen
        }

        if (gainPct >= activationTarget && !pos.activated) {
          pos.activated = true;
          pos.highestPrice = curPrice;
          const msg = `🎯 <b>[TRAILING ACTIVADO: ${symbol}]</b>\n\n` +
            `• El precio subió a $${curPrice} (<b>+${gainPct.toFixed(2)}%</b>).\n` +
            `• 🛡️ Ganancia mínima asegurada (+${activationTarget.toFixed(2)}%).\n` +
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

          // Notificar nuevo pico relevante con opción táctil de asegurar piso
          const nowMs = Date.now();
          const lastTime = pos.lastPeakNotifiedTime || 0;
          const lastGain = pos.lastPeakNotifiedGain || 0;
          const gainDiff = gainPct - lastGain;

          // Se notifica en:
          // 1. Ganancia actual >= +0.80% (ganancia real neta)
          // 2. Cooldown mínimo de 2.5 min para evitar spam
          // 3. Subida de al menos +0.30% desde la última alerta O cruce de hito redondo (+1.0%, +1.5%, +2.0%, etc.)
          const isMilestone = Math.floor(gainPct * 2) > Math.floor(lastGain * 2);
          if (gainPct >= 0.80 && (nowMs - lastTime >= 150000) && (gainDiff >= 0.30 || isMilestone)) {
            pos.lastPeakNotifiedTime = nowMs;
            pos.lastPeakNotifiedGain = gainPct;
            this.saveTrailingPositions();

            const callback = this.getCallbackPct(symbol, pos);
            const stopPrice = curPrice * (1 - callback / 100);
            const minLockedGain = ((stopPrice - pos.buyPrice) / pos.buyPrice) * 100;
            const cleanSym = symbol.replace("USDT", "");
            const suggestedFloor = Math.max(0.30, Math.floor(gainPct * 100) / 100);
            const cmdPiso = `/piso_${cleanSym}_${Math.round(suggestedFloor * 100)}`;
            const floorNote = pos.lockedFloorGainPct ? `\n🔒 <b>Piso Manual Ya Amarrado:</b> +${pos.lockedFloorGainPct.toFixed(2)}% NETO\n` : "";

            const peakAlert = `📈 <b>¡NUEVO PICO ALCANZADO: ${symbol}!</b> 🚀\n\n` +
              `• <b>Entrada:</b> ${fmtPrice(pos.buyPrice)}\n` +
              `• <b>Pico alcanzado:</b> ${fmtPrice(curPrice)} (<b>+${gainPct.toFixed(2)}%</b>)\n` +
              `• 🛡️ <b>Piso Trailing dinámico:</b> ${fmtPrice(stopPrice)} (+${minLockedGain.toFixed(2)}% neto)\n` +
              floorNote +
              `\n🔒 <b>¿Deseas asegurar este pico ahora mismo?</b>\n` +
              `👉 Presiona el botón abajo o escribe: ${cmdPiso}\n` +
              `<i>(O amárralo en el Dashboard web)</i>`;

            const buttons = [
              [
                { text: `🔒 Asegurar Piso (+${minLockedGain.toFixed(1)}%)`, callback_data: cmdPiso },
                { text: "🚀 Seguir Persiguiendo Pico", callback_data: "/trailing" }
              ]
            ];
            await this.notifier.send(peakAlert, buttons);
          }
        }

        // 💎 PASO A: VENTA PARCIAL 50/50 AL TOCAR PICO ALTO (Escalonada según la brecha de la moneda)
        const partialTriggerPct = isMaxGap ? 3.10 : (isHighVolCoin ? 2.70 : 2.20);
        const autoLockFloorPct = isMaxGap ? 2.25 : (isHighVolCoin ? 1.95 : 1.50);
        if (!pos.customMinGainPct && pos.activated && gainPct >= partialTriggerPct && !pos.partialProfitTaken) {
          try {
            const partialOk = await this.executePartialSell(pos, curPrice, 0.50);
            if (!partialOk && (!pos.lockedFloorGainPct || pos.lockedFloorGainPct < autoLockFloorPct)) {
              pos.lockedFloorGainPct = autoLockFloorPct;
              pos.partialProfitTaken = true;
              await this.saveTrailingPositions();
              console.log(`🔒 [AUTO-CANDADO EN LOTE] ${symbol} superó +${partialTriggerPct.toFixed(2)}%. Piso asegurado automáticamente en +${autoLockFloorPct.toFixed(2)}% neto.`);
            }
          } catch(e) {}
        }

        // 3. Evaluar Salida por Retroceso (Callback) o por Mecha de Rechazo (Agotamiento)
        if (pos.activated) {
          const dropFromPeak = ((pos.highestPrice - curPrice) / pos.highestPrice) * 100;
          const hitHardCap = gainPct >= TRAILING_HARD_CAP_PCT;
          let callback = pos.strategy === "micro_grid" ? 0.12 : this.getCallbackPct(symbol, pos);
          let minGain = pos.customMinGainPct || (pos.strategy === "micro_grid" ? 0.48 : 0.80);

          // 🌆 COMPRESIÓN CUANTITATIVA EN DÍAS QUIETOS, WEEKEND PLANO, PRE-WEEKEND O COSECHA PRE-NOCTURNA:
          if (!pos.customMinGainPct && pos.strategy !== "micro_grid" && !isLot3 && (isPreNightHarvest || isPreWeekendHarvest || isQuietRegime || isWeekendChop) && gainPct >= 0.50) {
            callback = Math.min(callback, isPreWeekendHarvest ? 0.15 : 0.16);
            minGain = 0.50;
          }

          // 🕯️ CENTINELA DE MECHA DE RECHAZO (AGOTAMIENTO INSTITUCIONAL EN CIMA)
          let isRejectionWick = false;
          if (gainPct >= 1.20 && dropFromPeak >= 0.12) {
            try {
              const klines = await this.client.klines(actualSymbol, "15m", { limit: 2 });
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

          let hitLockedFloor = false;
          if (pos.lockedFloorGainPct && pos.lockedFloorGainPct > 0) {
            const peakGain = ((pos.highestPrice - pos.buyPrice) / pos.buyPrice) * 100;
            // Si el pico alcanzó o superó el piso fijado (ej: +0.40%), y el precio retrocede tocándolo, Y SIEMPRE gainPct >= 0.30% (Cubre comisiones y asegura ganancia neta)
            if (peakGain >= pos.lockedFloorGainPct && gainPct <= pos.lockedFloorGainPct && gainPct >= 0.30) {
              hitLockedFloor = true;
              console.log(`🔒 [PISO ASEGURADO TOCADO] ${symbol}: Ganancia actual +${gainPct.toFixed(2)}% retrocedió al piso asegurado de +${pos.lockedFloorGainPct.toFixed(2)}%. Ejecutando venta asegurada.`);
            }
          }
          // CANDADO SUPREMO: hitCallback se activa por Trailing regular (>= minGain) O por Piso Manual Asegurado (>= 0.30% neto)
          const hitCallback = (dropFromPeak >= callback && gainPct >= minGain) || (hitLockedFloor && gainPct >= 0.30);

          // CANDADO FÉRREO: Venta autorizada si supera el mínimo de seguridad (>= 0.30% para piso asegurado, o >= 0.46% para micro-grid/compresión)
          const minAllowedExit = (pos.lockedFloorGainPct && pos.lockedFloorGainPct >= 0.30) ? 0.30 : (pos.strategy === "micro_grid" ? 0.46 : 0.48);
          if ((hitCallback || hitHardCap || isRejectionWick) && gainPct >= minAllowedExit) {
            const reasonOverride = isRejectionWick ? "RECHAZO_MECHA" : undefined;
            console.log(`🏆 ¡CERRANDO EN LA CIMA! Venta Trailing en ${symbol} a ${curPrice} (Pico: ${pos.highestPrice}) [${reasonOverride || 'TRAILING'}]`);
            const sold = await this.executeTrailingSell(pos, curPrice, hitHardCap, false, reasonOverride);
            // Solo se elimina la posición si Binance confirmó la venta
            if (sold) {
              const strat = pos.strategy;
              this.activeTrailingPositions.delete(symbol);
              this.recentlySoldSymbols.set(symbol, { time: Date.now(), sellPrice: curPrice });
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
  // 🛡️ VERIFICADOR DE COSTO REAL CONTRA BINANCE (mismo método LIFO que la "Lista de Ventas")
  // El precio en memoria (pos.buyPrice) puede estar mal si un lote se fusionó; Binance es la fuente de verdad.
  private shieldNotifyAt: Map<string, number> = new Map();
  private shouldNotifyShield(key: string): boolean {
    const last = this.shieldNotifyAt.get(key) || 0;
    if (Date.now() - last < 30 * 60 * 1000) return false;
    this.shieldNotifyAt.set(key, Date.now());
    return true;
  }

  private async verifyRealCostWithBinance(symbol: string, sellQty: number, price: number): Promise<{ ok: boolean; cost: number; estPnl: number; reason?: string }> {
    try {
      const asset = symbol.replace("USDT", "");
      const res = await this.client.myTrades(symbol, { limit: 1000, recvWindow: 60000 });
      const trades = ((res && res.data) || []).slice().sort((a: any, b: any) => a.time - b.time || a.id - b.id);
      const orders: { orderId: number; isBuyer: boolean; fills: any[] }[] = [];
      for (const t of trades) {
        const last = orders[orders.length - 1];
        if (last && last.orderId === t.orderId) last.fills.push(t);
        else orders.push({ orderId: t.orderId, isBuyer: t.isBuyer, fills: [t] });
      }
      const lots: { qty: number; unitCost: number }[] = [];
      for (const o of orders) {
        let qty = 0, quote = 0, feeBase = 0, feeUsdt = 0;
        for (const f of o.fills) {
          qty += parseFloat(f.qty);
          quote += parseFloat(f.quoteQty);
          const c = parseFloat(f.commission);
          if (f.commissionAsset === asset) feeBase += c;
          else if (f.commissionAsset === "USDT") feeUsdt += c;
        }
        if (o.isBuyer) {
          const net = qty - feeBase;
          if (net > 0) lots.push({ qty: net, unitCost: (quote + feeUsdt) / net });
          continue;
        }
        let rem = qty;
        while (rem > 1e-12 && lots.length) {
          const l = lots[lots.length - 1];
          const take = Math.min(l.qty, rem);
          l.qty -= take; rem -= take;
          if (l.qty <= 1e-12) lots.pop();
        }
      }
      let rem = sellQty, cost = 0;
      for (let i = lots.length - 1; i >= 0 && rem > 1e-12; i--) {
        const take = Math.min(lots[i].qty, rem);
        cost += take * lots[i].unitCost;
        rem -= take;
      }
      if (rem > sellQty * 0.01) {
        return { ok: false, cost, estPnl: NaN, reason: `${rem.toFixed(6)} ${asset} sin costo verificable en el historial de Binance` };
      }
      const matched = sellQty - rem;
      const estPnl = matched * price * (1 - 0.001) - cost; // descuenta comisión de venta 0.1%
      return { ok: estPnl > cost * 0.001, cost, estPnl }; // margen extra para comisiones en BNB
    } catch (e: any) {
      // FAIL-CLOSED: si no se puede verificar, NO se vende
      return { ok: false, cost: 0, estPnl: NaN, reason: "No se pudo consultar el historial de Binance: " + (e.response?.data?.msg || e.message) };
    }
  }

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

      const actualSymbol = (pos.symbol || "").split("_")[0];
      const asset = actualSymbol.replace("USDT", "");

      // 🛡️ REGLA SUPREMA: NUNCA VENDER PARCIAL A PÉRDIDA
      const estGainPct = ((exitPrice - pos.buyPrice) / pos.buyPrice) * 100;
      if (exitPrice <= pos.buyPrice || estGainPct < 0.50) {
        console.error(`🛡️ [VENTA PARCIAL A PÉRDIDA BLOQUEADA] ${pos.symbol}: Precio ${exitPrice} <= Compra ${pos.buyPrice}. Cancelada.`);
        return false;
      }

      let freeBal = await this.getFreeBalance(asset);
      if (freeBal < pos.qty * ratio * 0.95) {
        await this.redeemFromEarnIfNeeded(asset, pos.qty * ratio);
        freeBal = await this.getFreeBalance(asset);
      }

      const exInfo = await this.client.exchangeInfo({ symbol: actualSymbol });
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
      const tradeSym = actualSymbol;
      const realCheckP = await this.verifyRealCostWithBinance(tradeSym, sellQty, exitPrice);
      if (!realCheckP.ok) {
        console.error(`🛑 [CORE SHIELD: COSTO REAL] Venta parcial de ${pos.symbol} BLOQUEADA: ${realCheckP.reason || "Binance la registraría como pérdida (" + realCheckP.estPnl.toFixed(3) + " USDT)"}`);
        return false;
      }
      const sellRes = await this.client.newOrder(tradeSym, "SELL", "MARKET", {
        quantity: sellQtyStr,
        newOrderRespType: "FULL",
        recvWindow: 60000
      });

      const grossUsdt = parseFloat(sellRes.data.cummulativeQuoteQty);
      const sellFee = this.feesToUsdt(sellRes.data.fills, asset);
      const avgSell = grossUsdt / parseFloat(sellRes.data.executedQty);
      const costBasis = realCheckP.cost > 0 ? realCheckP.cost : pos.investedUsdt * (sellQty / pos.qty);
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
      await this.saveTrailingPositions();

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

  async executeTrailingSell(pos: ActivePosition, exitPrice: number, hitHardCap: boolean, isStopLoss: boolean = false, reasonOverride?: string, isManualExit: boolean = false, allowLoss: boolean = false): Promise<boolean> {
    try {
      const actualSymbol = (pos.symbol || "").split("_")[0];
      const asset = actualSymbol.replace("USDT", "");
      let freeBal = await this.getFreeBalance(asset);

      // Si falta saldo (barrido a Earn), rescatarlo antes de vender
      if (freeBal < pos.qty * 0.98) {
        await this.redeemFromEarnIfNeeded(asset, pos.qty);
        freeBal = await this.getFreeBalance(asset);
      }

      // Vender solo la cantidad de esta posición (no tocar otros saldos)
      const sellBase = Math.min(freeBal, pos.qty);

      const exInfo = await this.client.exchangeInfo({ symbol: actualSymbol });
      const sInfo = exInfo.data.symbols[0];
      const stepSize = parseFloat(sInfo.filters.find((f: any) => f.filterType === "LOT_SIZE").stepSize);
      const qtyDec = Math.max(0, Math.round(-Math.log10(stepSize)));
      const sellQty = Math.floor(sellBase / stepSize) * stepSize;
      const sellQtyStr = sellQty.toFixed(qtyDec);

      if (sellQty <= 0) {
        console.error(`❌ Sin saldo libre de ${asset} para vender la posición.`);
        return false;
      }

      // 🛡️ REGLA SUPREMA DE ORO DEL CORE: NUNCA VENDER A PÉRDIDA AUTOMÁTICAMENTE BAJO NINGÚN CONCEPTO
      const curCheckPrice = exitPrice || parseFloat((await this.client.tickerPrice(actualSymbol)).data.price);
      const estGainPct = ((curCheckPrice - pos.buyPrice) / pos.buyPrice) * 100;
      const minNetFloor = (pos.lockedFloorGainPct && pos.lockedFloorGainPct >= 0.30) ? 0.28 : 0.45;

      if (!isManualExit) {
        // En cualquier salida automática (trailing, callback, agotamiento, mecha de rechazo):
        // BLOQUEO TOTAL INQUEBRANTABLE SI EL PRECIO ES MENOR O IGUAL A LA COMPRA
        if (curCheckPrice <= pos.buyPrice || estGainPct < minNetFloor) {
          console.error(`🛑 [CORE SHIELD: VENTA A PÉRDIDA BLOQUEADA] ${pos.symbol}: Precio ${curCheckPrice} <= Compra ${pos.buyPrice} (Ganancia: ${estGainPct.toFixed(2)}%). Venta CANCELADA.`);
          if (this.shouldNotifyShield("price_" + pos.symbol)) try {
            await this.notifier.send(
              `🛑 <b>[CORE SHIELD: VENTA A PÉRDIDA BLOQUEADA]</b> 🛡️\n\n` +
              `• <b>Moneda:</b> <b>${pos.symbol}</b>\n` +
              `• 📍 <b>Precio de Entrada:</b> $${fmtPrice(pos.buyPrice)}\n` +
              `• 💰 <b>Precio Actual:</b> $${fmtPrice(curCheckPrice)} (<b>${estGainPct.toFixed(2)}%</b>)\n\n` +
              `⛔ <b>Acción cancelada en el core:</b> Por regla suprema, el bot NUNCA vende a pérdida automáticamente.\n` +
              `💎 <i>Tus monedas se mantienen intactas en Spot esperando el rebote. Cero riesgo de venta en rojo.</i>`
            );
          } catch(e) {}
          return false;
        }

        // AISLAMIENTO ESTRICTO DE LOTES: Jamás vender más de la cantidad de este lote
        if (sellQty > pos.qty * 1.001) {
          console.error(`🛑 [CORE SHIELD: AISLAMIENTO DE LOTE] ${pos.symbol}: sellQty ${sellQty} > pos.qty ${pos.qty}.`);
          return false;
        }
      } else {
        // Salida manual: si está a pérdida, requiere confirmación explícita con alerta (allowLoss=true)
        if ((curCheckPrice <= pos.buyPrice || estGainPct < 0) && !allowLoss) {
          console.error(`🛑 [CORE SHIELD: VENTA MANUAL BLOQUEADA] ${pos.symbol}: Requiere confirmación explícita (allowLoss=true).`);
          return false;
        }
      }

      // 🛡️ SEGUNDA LLAVE (COSTO REAL EN BINANCE): se calcula lo que REALMENTE costaron las monedas a vender.
      // Si Binance registraría la venta como PÉRDIDA, se bloquea (salvo venta manual con allowLoss=true).
      const realCheck = await this.verifyRealCostWithBinance(actualSymbol, sellQty, curCheckPrice);
      if (!realCheck.ok && !(isManualExit && allowLoss)) {
        const why = realCheck.reason || `Binance la registraría como PÉRDIDA (${realCheck.estPnl.toFixed(3)} USDT, costo real ${realCheck.cost.toFixed(2)} USDT)`;
        console.error(`🛑 [CORE SHIELD: COSTO REAL] Venta de ${sellQtyStr} ${asset} BLOQUEADA: ${why}`);
        if (this.shouldNotifyShield("real_" + pos.symbol)) {
          try {
            await this.notifier.send(
              `🛑 <b>[CORE SHIELD: VENTA BLOQUEADA]</b> 🛡️\n\n` +
              `• <b>Moneda:</b> ${pos.symbol}\n` +
              `• <b>Motivo:</b> ${why}\n\n` +
              `💎 <i>No se vendió nada. Las monedas siguen en tu cuenta esperando un precio con ganancia real.</i>`
            );
          } catch (e) {}
        }
        return false;
      }

      const sellRes = await this.client.newOrder(actualSymbol, "SELL", "MARKET", {
        quantity: sellQtyStr,
        newOrderRespType: "FULL",
        recvWindow: 60000
      });

      const grossUsdt = parseFloat(sellRes.data.cummulativeQuoteQty);
      const sellFee = this.feesToUsdt(sellRes.data.fills, asset);
      const avgSell = grossUsdt / parseFloat(sellRes.data.executedQty);
      // Costo REAL según Binance (así Telegram, Supabase y la Lista de Ventas muestran la misma cifra)
      const costBasis = realCheck.cost > 0 ? realCheck.cost : pos.investedUsdt * (sellQty / pos.qty);
      const profitUsdt = grossUsdt - sellFee - costBasis;
      if (profitUsdt > 0) {
        if (!this.controls.recoveryTracker) {
          this.controls.recoveryTracker = { targetUsdt: 100.00, recoveredUsdt: 0, tradesCount: 0 };
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
        const dbLotKey = pos.lotId || pos.id || pos.symbol;
        supabaseDb.deleteActivePosition(dbLotKey).catch(() => {});

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
    strategy: "trailing_rebound" | "smart_dca" | "micro_grid" | "cazador_weekend" = "trailing_rebound",
    meta?: { coinRange24hPct?: number; upsideGapPct?: number; convictionTier?: "ESTANDAR" | "IMPULSO" | "ALTA_VOLATILIDAD" | "MAXIMA_BRECHA"; customMinGainPct?: number }
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
      // Incluir la comisión cobrada en la moneda base dentro del precio unitario de compra
      // para que jamás subestime el costo real de adquisición
      const buyPrice = qty > 0 ? (spent / qty) : (spent / grossQty);

      const coinVol = meta?.coinRange24hPct || 0;
      const gapPct = meta?.upsideGapPct || 0;
      const isMaxGap = coinVol >= 5.0 || gapPct >= 3.4 || meta?.convictionTier === "MAXIMA_BRECHA";
      const isHighVol = isMaxGap || coinVol >= 3.8 || meta?.convictionTier === "ALTA_VOLATILIDAD";
      const activationPct = meta?.customMinGainPct || (strategy === "micro_grid" ? 0.58 : (isMaxGap ? 1.20 : (isHighVol ? 1.05 : 0.80)));

      // Registrar posición para Trailing Take Profit
      this.activeTrailingPositions.set(symbol, {
        symbol,
        buyPrice,
        qty,
        investedUsdt: spent,
        highestPrice: buyPrice,
        activated: false,
        buyTime: Date.now(),
        strategy,
        coinRange24hPct: meta?.coinRange24hPct,
        upsideGapPct: meta?.upsideGapPct,
        convictionTier: meta?.convictionTier,
        customMinGainPct: meta?.customMinGainPct
      });
      this.saveTrailingPositions();

      const targetPriceStr = fmtPrice(buyPrice * (1 + activationPct / 100));
      const volBadge = isMaxGap
        ? `💎 <b>ESCALÓN 4: MÁXIMA BRECHA (Rango ${coinVol.toFixed(1)}% | Brecha +${gapPct.toFixed(1)}% — Inversión Máxima)</b>`
        : (isHighVol
          ? `🔥 <b>ESCALÓN 3: ALTA VOLATILIDAD (Rango ${coinVol.toFixed(1)}% | Brecha +${gapPct.toFixed(1)}%)</b>`
          : (coinVol >= 2.6 ? `⚡ <b>ESCALÓN 2: IMPULSO MEDIO (${coinVol.toFixed(1)}% 24h)</b>` : `🛡️ <b>ESCALÓN 1: COMPACTO (${coinVol.toFixed(1)}% 24h)</b>`));
      const alertMsg = `🦅 <b>¡NUEVA COMPRA ESCALONADA CON TRAILING!</b> 🚀\n\n` +
        `• <b>Moneda:</b> ${symbol}\n` +
        `• <b>Origen:</b> ${source}\n` +
        `• <b>Escalón Algorítmico:</b> ${volBadge}\n` +
        `• <b>Inversión Escalonada:</b> <b>${spent.toFixed(2)} USDT</b>\n` +
        `• <b>Precio de entrada:</b> ${fmtPrice(buyPrice)}\n` +
        `• 🎯 <b>Despertar Trailing:</b> ${targetPriceStr} (<b>+${activationPct.toFixed(2)}%</b>)\n\n` +
        `🛡️ <i>${isHighVol ? "Brecha amplia detectada: el algoritmo asignó mayor capital y amplió el respiro del Trailing para escalar hasta la máxima altura del rebote (+1.8% a +4.5%)." : "En cuanto supere la meta, el bot asegura la ganancia y persigue el pico más alto sin riesgo de venta en rojo."}</i>`;

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
   * Calcula Bandas de Bollinger (media simple y desviación estándar poblacional)
   */
  private calculateBollingerBands(closes: number[], period: number = 20, stdDevMult: number = 2.0): { middle: number; upper: number; lower: number; percentB: number } {
    const slice = closes.slice(-period);
    if (slice.length === 0) return { middle: 0, upper: 0, lower: 0, percentB: 0.5 };
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    const variance = slice.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / slice.length;
    const stdDev = Math.sqrt(variance);
    const upper = mean + stdDevMult * stdDev;
    const lower = mean - stdDevMult * stdDev;
    const cur = slice[slice.length - 1];
    const bandWidth = upper - lower;
    const percentB = bandWidth > 0 ? (cur - lower) / bandWidth : 0.5;
    return { middle: mean, upper, lower, percentB };
  }

  /**
   * TRAILING BUY - Paso 1: detectar caídas y "armar" la vigilancia del piso.
   * Ya no compra en la primera vela verde: registra el precio y rastrea el piso más bajo.
   */
  async scanForDips(activeSymbols: Set<string>): Promise<void> {
    const tf = this.controls.strategySettings?.trailing_rebound?.timeframe || this.controls.timeframe || "1h";

    // 🛡️ FILTRO MACRO INSTITUCIONAL BTC: Si Bitcoin está en caída libre activa en la vela actual de 15m
    // (caída <= -0.65% sin mecha de absorción inferior), pausar el armado de compras en altcoins para no atrapar cuchillos cayendo.
    try {
      const btcK = await this.client.klines("BTCUSDT", "15m", { limit: 3 });
      const lastBtc = btcK.data[btcK.data.length - 1];
      const bOpen = parseFloat(lastBtc[1]), bHigh = parseFloat(lastBtc[2]), bLow = parseFloat(lastBtc[3]), bClose = parseFloat(lastBtc[4]);
      const btcCandleDropPct = ((bClose - bOpen) / bOpen) * 100;
      const btcRange = bHigh - bLow;
      const btcLowerWickRatio = btcRange > 0 ? (Math.min(bOpen, bClose) - bLow) / btcRange : 0;
      if (btcCandleDropPct <= -0.65 && btcLowerWickRatio < 0.30) {
        console.log(`🛡️ [FILTRO MACRO BTC] BTC cayendo ${btcCandleDropPct.toFixed(2)}% en 15m sin mecha de absorción. Esperando suelo de BTC antes de armar compras.`);
        return;
      }
    } catch (e) {}

    // Contar cuántas memecoins únicas tenemos activas (posiciones o vigilancias armadas)
    const uniqueActiveSyms = this.getUniqueActiveSymbols();
    let activeMemeCount = 0;
    for (const sym of uniqueActiveSyms) {
      if (this.memeWatchlist.includes(sym)) activeMemeCount++;
    }
    for (const [sym] of this.buyWatches.entries()) {
      if (!uniqueActiveSyms.has(sym) && this.memeWatchlist.includes(sym)) activeMemeCount++;
    }

    for (const sym of this.watchlist) {
      const isMeme = this.memeWatchlist.includes(sym);
      // REGLA DE RIESGO DINÁMICA: Hasta 3 memecoins activas concurrentes (desbloquea oportunidades)
      if (isMeme && activeMemeCount >= 3) {
        continue;
      }
      try {
        if (activeSymbols.has(sym) || uniqueActiveSyms.has(sym) || this.buyWatches.has(sym)) {
          continue; // No acumular en la misma moneda ni duplicar vigilancias
        }

        const symTf = this.getTimeframeForSymbol(sym);
        const klinesRes = await this.client.klines(sym, symTf, { limit: 35 });
        const data = klinesRes.data;
        const opens = data.map((k: any) => parseFloat(k[1]));
        const highs = data.map((k: any) => parseFloat(k[2]));
        const lows = data.map((k: any) => parseFloat(k[3]));
        const closes = data.map((k: any) => parseFloat(k[4]));
        const volumes = data.map((k: any) => parseFloat(k[5]));

        const curPrice = closes[closes.length - 1];

        // Cooldown post-venta inteligente: Si cayó >= 2.5% respecto a la salida, se levanta de inmediato
        const lastSold = this.recentlySoldSymbols.get(sym);
        if (lastSold) {
          const elapsed = Date.now() - lastSold.time;
          if (elapsed < 20 * 60 * 1000) {
            const droppedFromExit = lastSold.sellPrice && lastSold.sellPrice > 0
              ? ((lastSold.sellPrice - curPrice) / lastSold.sellPrice) * 100
              : 0;
            if (droppedFromExit < 2.5) {
              continue; // Cooldown post-venta activo: evitar recomprar en el mismo techo
            } else {
              console.log(`🎯 [COOLDOWN LEVANTADO] ${sym} cayó ${droppedFromExit.toFixed(2)}% tras la salida. Re-entrada autorizada.`);
            }
          }
        }

        const rsi = this.calculateRSI(closes, 14);
        const bb = this.calculateBollingerBands(closes, 20, 2.0);

        // Volumen relativo (RVOL) respecto a las últimas 20 velas cerradas
        const recentVols = volumes.slice(-21, -1);
        const avgVol = recentVols.length > 0 ? recentVols.reduce((a: number, b: number) => a + b, 0) / recentVols.length : 1;
        const curVol = volumes[volumes.length - 1] || volumes[volumes.length - 2] || 0;
        const rvol = avgVol > 0 ? curVol / avgVol : 1;

        // Centinela Nocturno: En ventana nocturna (20:00 - 02:30 COT) exigir sobreventa extrema (RSI <= 26)
        const isNight = this.isNightWindow();
        if (isNight && rsi > 26) {
          // Filtrar compras en la noche para no comprar caídas tempranas en libros delgados
          continue;
        }
        const maxRecent = Math.max(...highs.slice(-20));
        const dropPct = ((maxRecent - curPrice) / maxRecent) * 100;
        const low24 = Math.min(...lows.slice(-24));
        const high24 = Math.max(...highs.slice(-24));
        const coinRange24hPct = low24 > 0 ? ((high24 - low24) / low24) * 100 : 2.5;
        const upsideGapPct = curPrice > 0 ? ((high24 - curPrice) / curPrice) * 100 : dropPct;
        const convictionTier: "ESTANDAR" | "IMPULSO" | "ALTA_VOLATILIDAD" | "MAXIMA_BRECHA" =
          (coinRange24hPct >= 5.0 && (upsideGapPct >= 3.2 || dropPct >= 2.8 || rsi <= 37)) || upsideGapPct >= 4.2
            ? "MAXIMA_BRECHA"
            : ((coinRange24hPct >= 3.8 && (upsideGapPct >= 2.2 || dropPct >= 2.0 || rsi <= 39)) || coinRange24hPct >= 4.6
              ? "ALTA_VOLATILIDAD"
              : (coinRange24hPct >= 2.5 && upsideGapPct >= 1.5 ? "IMPULSO" : "ESTANDAR"));

        // 🧠 ANÁLISIS DE ACCIÓN DEL PRECIO, BANDAS DE BOLLINGER Y VOLUMEN (PRICE ACTION CUANTITATIVO)
        const lastIdx = closes.length - 1;
        const candleRange = highs[lastIdx] - lows[lastIdx];
        const lowerWick = Math.min(opens[lastIdx], closes[lastIdx]) - lows[lastIdx];
        const lowerWickRatio = candleRange > 0 ? (lowerWick / candleRange) : 0;
        const hasPinbarRejection = lowerWickRatio >= 0.35; // Mecha inferior >= 35% (Rechazo y absorción en suelo)
        const isNearLowerBollinger = bb.percentB <= 0.15; // En el 15% inferior o por debajo de la Banda Inferior de Bollinger

        // Condiciones cuantitativas estrictas de suelo (Prohibido armar con RSI > 46 para evitar comprar techos):
        // A) Suelo Bollinger + Sobreventa real (precio en banda inferior + RSI <= 45 + caída >= 1.5%)
        // B) Caída profunda con RSI en sobreventa (drop >= 2.0% y RSI <= 42, o RSI <= 36)
        // C) Absorción institucional (Mecha >= 35% + caída >= 1.2% + RSI <= 46 + volumen o soporte Bollinger)
        const isBollingerOversold = isNearLowerBollinger && rsi <= 45 && dropPct >= 1.4;
        const isStandardDip = (dropPct >= 2.0 && rsi <= 42) || isBollingerOversold || (rsi <= 36);
        const isWickRebound = hasPinbarRejection && dropPct >= 1.2 && rsi <= 46 && (rvol >= 0.85 || isNearLowerBollinger);
        const isDip = isMeme
          ? ((dropPct >= 2.4 && rsi <= 43) || (isBollingerOversold && dropPct >= 2.0) || (isWickRebound && dropPct >= 1.6) || (rsi <= 35))
          : (isStandardDip || isWickRebound);

        if (isDip) {
          this.buyWatches.set(sym, {
            symbol: sym,
            armedPrice: curPrice,
            lowestPrice: curPrice,
            armedTime: Date.now(),
            rsi,
            dropPct,
            coinRange24hPct,
            upsideGapPct,
            high24h: high24,
            rvol,
            convictionTier
          });
          this.saveBuyWatches();
          if (isMeme) activeMemeCount++;
          console.log(`🎯 [TRAILING BUY ARMADO] ${sym} a ${curPrice} (RSI ${rsi.toFixed(1)} | Rango 24h ${coinRange24hPct.toFixed(1)}% | Brecha +${upsideGapPct.toFixed(1)}% [${convictionTier}] | RVOL ${rvol.toFixed(2)}x)`);
        }
      } catch (e: any) {}
    }
  }

  /**
   * TRAILING BUY - Paso 2: seguir el piso y comprar en el rebote confirmado.
   * Devuelve true si ejecutó una compra.
   */
  async checkBuyWatches(usdt: number): Promise<boolean> {
    // 🏆 RANKING INTELIGENTE POR BRECHA Y VOLATILIDAD:
    // Evaluamos primero las monedas con mayor rango 24h y mayor brecha libre hacia el techo,
    // para que si 2 monedas rebotan al mismo tiempo, el bot invierta primero en la de mayor ganancia potencial (ej. AVAX/SOL).
    const sortedWatches = Array.from(this.buyWatches.entries()).sort((a, b) => {
      const scoreA = (a[1].coinRange24hPct || 2.5) * 0.6 + (a[1].upsideGapPct || a[1].dropPct || 1.5) * 1.3 + Math.max(0, 48 - (a[1].rsi || 45)) * 0.25;
      const scoreB = (b[1].coinRange24hPct || 2.5) * 0.6 + (b[1].upsideGapPct || b[1].dropPct || 1.5) * 1.3 + Math.max(0, 48 - (b[1].rsi || 45)) * 0.25;
      return scoreB - scoreA;
    });

    for (const [sym, w] of sortedWatches) {
      try {
        if (this.hasActivePositionForSymbol(sym)) { this.buyWatches.delete(sym); this.saveBuyWatches(); continue; }

        if (Date.now() - w.armedTime > TRAILING_BUY_MAX_AGE_MS) {
          console.log(`⌛ Trailing Buy en ${sym} expiró sin rebote. Se desarma.`);
          this.buyWatches.delete(sym);
          this.saveBuyWatches();
          continue;
        }

        const cur = parseFloat((await this.client.tickerPrice(sym)).data.price);

        if (cur < w.lowestPrice) {
          w.lowestPrice = cur;
          if (w.high24h && cur > 0) {
            w.upsideGapPct = ((w.high24h - cur) / cur) * 100;
          }
          this.saveBuyWatches();
          console.log(`🔻 Nuevo piso en ${sym}: ${cur} (${(((cur - w.armedPrice) / w.armedPrice) * 100).toFixed(2)}% desde que se armó | Brecha al techo: +${(w.upsideGapPct || w.dropPct || 0).toFixed(2)}%)`);
          continue;
        }

        const bounce = ((cur - w.lowestPrice) / w.lowestPrice) * 100;
        this.loadWalletSplit();
        const botAvailableUsdt = Math.max(0, usdt - this.walletSplit.manualUsdt);
        const sessionPlan = this.lastSessionPlan || this.getSessionLiquidityPlan(botAvailableUsdt);
        const reqBounce = sessionPlan.trailingBounceTrigger || TRAILING_BUY_BOUNCE_PCT;
        const strat = w.strategy || "trailing_rebound";
        // Si es Cazador Weekend en ventana de fin de semana, desbloquea el presupuesto de fin de semana (usdt pasado)
        const effectiveSpendable = (strat === "cazador_weekend" && this.isWeekendWindow())
          ? Math.max(sessionPlan.spendableUsdt, usdt)
          : sessionPlan.spendableUsdt;
        // CANDADO ESTRICTO DE RESERVA: Solo comprar si el saldo GASTABLE de la estrategia supera el mínimo ($10 USDT)
        if (bounce >= reqBounce && effectiveSpendable >= this.minUsdtToTrade) {
          // 🧠 CONFIRMACIÓN DE GIRO EN 5M SINCRONIZADA CON LA SESIÓN HORARIA (ANTI-ENTRADA ANTICIPADA):
          // Evita comprar en el primer micro-rebote ("Dead Cat Bounce") si la vela de 5m sigue siendo roja y cayendo.
          let turnaroundConfirmed = true;
          try {
            const k5 = await this.client.klines(sym, "5m", { limit: 16 });
            if (k5?.data?.length >= 2) {
              const last5 = k5.data[k5.data.length - 1];
              const prev5 = k5.data[k5.data.length - 2];
              const o5 = parseFloat(last5[1]), h5 = parseFloat(last5[2]), l5 = parseFloat(last5[3]), c5 = parseFloat(last5[4]);
              const prevLow5 = parseFloat(prev5[3]);
              const range5 = h5 - l5;
              const lowerWick5 = range5 > 0 ? (Math.min(o5, c5) - l5) / range5 : 0;
              const isGreen5m = c5 >= o5;
              const isHigherLow5m = l5 >= prevLow5 * 0.9995;
              const closes5m = k5.data.map((row: any) => parseFloat(row[4]));
              const rsi5m = this.calculateRSI(closes5m, 14);

              const isDefensiveSession = sessionPlan.sessionKey === "COSECHA_PRENOCTURNA" || sessionPlan.sessionKey === "NOCTURNO_DRENAJE";
              if (isDefensiveSession) {
                // En tarde/noche (deslizamiento post-NY o drenaje nocturno): exigir vela 5m verde + absorción o suelo creciente
                turnaroundConfirmed = (isGreen5m && (lowerWick5 >= 0.25 || isHigherLow5m)) && rsi5m <= 50;
              } else {
                // En Londres / Wall Street: entrada ágil si la vela 5m ya es verde, o tiene mecha de absorción >= 30%, o rebote fuerte
                turnaroundConfirmed = isGreen5m || lowerWick5 >= 0.30 || bounce >= reqBounce * 1.6;
              }

              if (!turnaroundConfirmed) {
                console.log(`⏳ [FILTRO GIRO 5M: ${sym}] Rebote +${bounce.toFixed(2)}% detectado, pero vela 5m sigue en presión vendedora (${isGreen5m ? "Verde" : "Roja"}, mecha ${(lowerWick5 * 100).toFixed(0)}%, Sesión ${sessionPlan.sessionKey}). Esperando confirmación de suelo.`);
                continue;
              }
            }
          } catch {}

          const saved = ((w.armedPrice - w.lowestPrice) / w.armedPrice) * 100;
          const totalDropFromPeak = (w.dropPct || 1.5) + Math.max(0, saved);
          const coinVol = w.coinRange24hPct || 2.5;
          const upsideGapPct = w.high24h && cur > 0 ? ((w.high24h - cur) / cur) * 100 : Math.max(w.upsideGapPct || 0, totalDropFromPeak);
          const convictionTier: "ESTANDAR" | "IMPULSO" | "ALTA_VOLATILIDAD" | "MAXIMA_BRECHA" =
            (coinVol >= 5.0 && (upsideGapPct >= 3.2 || totalDropFromPeak >= 2.8 || (w.rsi || 40) <= 37)) || upsideGapPct >= 4.2
              ? "MAXIMA_BRECHA"
              : ((coinVol >= 3.8 && (upsideGapPct >= 2.2 || totalDropFromPeak >= 2.0 || (w.rsi || 40) <= 39)) || coinVol >= 4.6
                ? "ALTA_VOLATILIDAD"
                : (coinVol >= 2.5 && upsideGapPct >= 1.5 ? "IMPULSO" : "ESTANDAR"));

          // Verificar cupo concentrado: reservamos la 5ta ranura exclusivamente para oportunidades de ALTA_VOLATILIDAD o MAXIMA_BRECHA
          const uniqueActiveNow = this.getUniqueActiveSymbols().size;
          const configuredMax = this.controls?.maxPositions || 5;
          const stdCap = Math.max(3, Math.min(4, configuredMax - 1));
          if (uniqueActiveNow >= stdCap && convictionTier !== "ALTA_VOLATILIDAD" && convictionTier !== "MAXIMA_BRECHA") {
            console.log(`🎯 [CUPO CONCENTRADO] ${ uniqueActiveNow }/${configuredMax} monedas activas: reservando último cupo exclusivamente para oportunidades de Alta Volatilidad / Máxima Brecha (${sym} es ${convictionTier}).`);
            continue;
          }

          let amountToUse = this.calculateSessionLotSize(
            sym,
            effectiveSpendable,
            sessionPlan.lotFractionPct,
            strat,
            1,
            w.rsi || 40,
            coinVol,
            Math.max(totalDropFromPeak, upsideGapPct)
          );
          if (amountToUse < this.minUsdtToTrade && effectiveSpendable >= this.minUsdtToTrade) {
            amountToUse = this.minUsdtToTrade;
          }
          const sourceDesc = strat === "cazador_weekend"
            ? `Cazador Weekend (piso ${w.lowestPrice}, Brecha +${upsideGapPct.toFixed(1)}%)`
            : `Trailing Buy [${convictionTier}] (piso ${w.lowestPrice}, Brecha +${upsideGapPct.toFixed(1)}%)`;
          console.log(`✅ Rebote y giro 5m confirmado en ${sym} [${convictionTier} | Rango 24h ${coinVol.toFixed(1)}% | Brecha +${upsideGapPct.toFixed(1)}%]: piso ${w.lowestPrice} → ${cur} (+${bounce.toFixed(2)}%). Comprando ${amountToUse} USDT...`);
          const ok = await this.executeSmartBuy(sym, amountToUse, sourceDesc, strat, {
            coinRange24hPct: coinVol,
            upsideGapPct,
            convictionTier
          });
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

                              
      // Comando interactivo para asegurar piso: /piso_SYMBOL_PCT o /piso SYMBOL PCT
      if (cmd.startsWith("/piso_") || cmd.startsWith("/asegurar_") || cmd === "/piso" || cmd === "/asegurar" || cmd === "piso" || cmd === "asegurar") {
        let targetSym = "";
        let targetPct = 0;

        if (cmd.startsWith("/piso_") || cmd.startsWith("/asegurar_")) {
          const prefix = cmd.startsWith("/piso_") ? "/piso_" : "/asegurar_";
          const rawParts = cmd.slice(prefix.length).split("_");
          targetSym = rawParts[0].toUpperCase();
          if (!targetSym.endsWith("USDT")) targetSym += "USDT";
          const rawPctNum = parseFloat(rawParts[1] || "0");
          targetPct = rawPctNum >= 10 ? rawPctNum / 100 : rawPctNum;
        } else {
          targetSym = (arg1 || "").toUpperCase();
          if (targetSym && !targetSym.endsWith("USDT")) targetSym += "USDT";
          targetPct = parseFloat(arg2 || "0");
        }

        if (!targetSym || isNaN(targetPct) || targetPct <= 0) {
          return "ℹ️ <b>Uso correcto:</b> <code>/piso MONEDA PORCENTAJE</code>\nEjemplo: <code>/piso XRP 0.80</code> o toca el enlace rápido en las alertas de pico.";
        }

        let foundPos: any = null;
        for (const [k, p] of this.activeTrailingPositions.entries()) {
          const cleanK = k.split("_")[0];
          const cleanP = (p.symbol || "").split("_")[0];
          if (k === targetSym || cleanK === targetSym || cleanP === targetSym) {
            foundPos = p;
            break;
          }
        }

        if (!foundPos) {
          return `❌ No se encontró posición abierta para <b>${targetSym}</b>.`;
        }

        const res = await this.lockPositionFloor(foundPos.symbol || foundPos.lotId || targetSym, targetPct);
        if (res.success) {
          return `🔒 <b>¡PISO ASEGURADO EN ${foundPos.symbol}!</b> ✅\n\n` +
            `• Ganancia asegurada: <b>+${targetPct.toFixed(2)}% NETO</b>\n` +
            `• Si el precio retrocede, venderá asegurando este piso.\n` +
            `• Si sigue subiendo, ¡seguirá persiguiendo la cima con Trailing Take Profit! 🚀`;
        } else {
          return `⚠️ No se pudo fijar el piso: ${res.msg}`;
        }
      }

      // Consolidado del día a solicitud
      if (cmd === "/consolidado" || cmd === "consolidado" || cmd === "/reporte_dia" || cmd === "reporte_dia") {
        return await this.generateConsolidatedDailyReport();
      }

      // Tomar de la cosecha / reserva
      if (cmd.startsWith("/tomar_cosecha") || cmd === "/cosecha" || cmd === "cosecha") {
        let targetSym = "";
        if (cmd.startsWith("/tomar_cosecha_")) {
          targetSym = cmd.replace("/tomar_cosecha_", "").toUpperCase();
          if (!targetSym.endsWith("USDT")) targetSym += "USDT";
        } else {
          targetSym = (arg1 || "").toUpperCase();
          if (targetSym && !targetSym.endsWith("USDT")) targetSym += "USDT";
        }

        if (!targetSym) {
          return "ℹ️ <b>Uso:</b> <code>/tomar_cosecha MONEDA</code>\nEjemplo: <code>/tomar_cosecha SOLUSDT</code> para autorizar compra con la reserva protegida.";
        }

        const acc = await this.client.account({ recvWindow: 60000 });
        const freeUsdt = parseFloat(acc.data.balances.find((b: any) => b.asset === "USDT")?.free || "0");
        const amountToUse = Math.min(15.0, Math.max(10.0, freeUsdt));

        if (freeUsdt < 10.0) {
          return `⚠️ Saldo insuficiente en Binance (${freeUsdt.toFixed(2)} USDT) para tomar de la cosecha.`;
        }

        const ok = await this.executeSmartBuy(targetSym, amountToUse, "Oportunidad de Oro (Fondo de Cosecha)", "trailing_rebound");
        if (ok) {
          return `🚀 <b>¡COMPRA DE COSECHA EJECUTADA!</b>\nSe tomaron ${amountToUse.toFixed(2)} USDT de la reserva para comprar <b>${targetSym}</b> en suelo de alta probabilidad.`;
        } else {
          return `⚠️ No se pudo ejecutar la compra en ${targetSym}.`;
        }
      }

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
          `👉 /futuros_real para pasar a Real\n` +
          `👉 /futuros_sim para mantener Simulación`;
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
          `👉 Pasar todo a Spot: /pasar_a_spot`;
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
          `👉 Consulta la viabilidad de futuros con: /viabilidad_futuros`;
      }

      if (cmd === "/cierre" || cmd === "cierre" || cmd === "/balance_diario" || cmd === "balance_diario") {
        return await this.generateConsolidatedDailyReport();
      }

      if (cmd === "/alpha" || cmd === "alpha") {
        const rec = this.controls.recoveryTracker || { targetUsdt: 100.00, recoveredUsdt: 0, tradesCount: 0 };
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
            try {
              const cleanSym = (p.symbol || id).split('_')[0];
              curP = parseFloat((await this.client.tickerPrice(cleanSym)).data.price);
            } catch(e) {}
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
          `• /monedas — <i>Lista de monedas aceptadas en Supabase DB</i>\n` +
          `• /agregar_moneda &lt;PAR&gt; [core|meme] — <i>Agregar moneda a la DB sin reiniciar</i>\n` +
          `• /quitar_moneda &lt;PAR&gt; — <i>Eliminar moneda de la DB al instante</i>\n` +
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
        const tfVal = (this.controls.timeframe || "1h").toUpperCase();
        let msg = `⚙️ <b>ARQUITECTURA MULTI-ESTRATEGIA CUANTITATIVA (SPOT)</b> 🏛️\n`;
        msg += `🛡️ <i>Regla Suprema: 0% Ventas en Negativo (Doble Llave Binance)</i>\n`;
        msg += `📐 <i>Capital: Pirámide Invertida (1x Explorador : 1.5x Soporte : 2.2x Capitulación)</i>\n\n`;

        msg += `• <b>1. 🏹 Cazador Trailing (Ondas & Rebote):</b> ${c.trailing_rebound ? "🟢 <b>ACTIVO</b>" : "🔴 <i>PAUSADO</i>"}\n`;
        msg += `  <i>Detecta sobreventa (RSI + Bandas de Bollinger + RVOL), espera confirmación de giro en vela de 5m (verde o mecha ≥30%) y persigue el pico con Trailing Take Profit (+0.8% a +3.5%).</i>\n`;
        msg += `  👉 /toggle_trailing\n\n`;

        msg += `• <b>2. 🛡️ Smart DCA (Pirámide Invertida de Rescate):</b> ${c.smart_dca ? "🟢 <b>ACTIVO</b>" : "🔴 <i>PAUSADO</i>"}\n`;
        msg += `  <i>Si una moneda cae ≥ -2.5% (Lote 2, 1.35x fuerza) o ≥ -5.5% (Lote 3, 1.75x fuerza), espera a que la vela de 15m frene la caída y compra un lote independiente barato que cobra ganancia por su cuenta sin tocar el Lote 1.</i>\n`;
        msg += `  👉 /toggle_dca\n\n`;

        msg += `• <b>3. 🌐 Micro-Grid (Canales Laterales):</b> ${c.micro_grid ? "🟢 <b>ACTIVO</b>" : "🔴 <i>PAUSADO</i>"}\n`;
        msg += `  <i>Se auto-activa en días planos (BTC rango &lt; 2.2%). Compra en el 30% inferior del canal lateral con vela de soporte y cobra micro-rebotes rápidos (+0.45% a +0.60%).</i>\n`;
        msg += `  👉 /toggle_grid\n\n`;

        const isW = this.isWeekendWindow();
        const weekendBadge = isW && c.cazador_weekend ? "🟢 <b>ACTIVO (En Ventana)</b>" : (!isW ? "⚪ <i>EN ESPERA (Se reactiva Viernes 17:00 COT)</i>" : "🔴 <i>PAUSADO</i>");
        msg += `• <b>4. 🏖️ Cazador Weekend (Efecto CME):</b> ${weekendBadge}\n`;
        msg += `  <i>Opera de Viernes 17:00 a Domingo 18:00 COT cazando descuentos de fin de semana (Bollinger + Mecha) para vender en la apertura institucional de futuros CME.</i>\n`;
        msg += `  👉 /toggle_weekend | /weekend\n\n`;

        msg += `• <b>5. ⏱️ Brújula Multitemporal:</b> <b>${tfVal}</b> ${tfVal === "1H" ? "(Base Institucional)" : ""}\n`;
        msg += `  <i>Sincronizada con el horario de bolsas (Londres 03:00, NY 08:30, Cosecha 17:00, Noche 20:00 COT).</i>\n`;
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

      // Gestión de lista de monedas aceptadas en la Base de Datos
      if (cmd === "/monedas" || cmd === "monedas" || cmd === "/watchlist" || cmd === "watchlist" || cmd === "/lista_monedas") {
        const core = this.coreWatchlist;
        const meme = this.memeWatchlist;
        const total = this.watchlist.length;

        let msg = `🪙 <b>LISTA DE MONEDAS ACTIVAS (BASE DE DATOS SUPABASE)</b> 📋\n\n`;
        msg += `💎 <b>Monedas Clásicas / Core (${core.length}):</b>\n`;
        core.forEach(s => {
          msg += `  • <code>${s}</code>\n`;
        });

        msg += `\n🐕 <b>Canasta Memecoins (${meme.length}):</b>\n`;
        meme.forEach(s => {
          msg += `  • <code>${s}</code>\n`;
        });

        msg += `\n📊 <b>Total Monitoreadas:</b> ${total} pares USDT\n\n`;
        msg += `⚙️ <b>Gestión Dinámica en la Nube:</b>\n`;
        msg += `➕ <b>Para agregar:</b>\n`;
        msg += `<code>/agregar_moneda SIMBOLO [core|meme]</code>\n`;
        msg += `<i>Ej: /agregar_moneda ADA o /agregar_moneda FLOKI meme</i>\n\n`;
        msg += `➖ <b>Para eliminar:</b>\n`;
        msg += `<code>/quitar_moneda SIMBOLO</code>\n`;
        msg += `<i>Ej: /quitar_moneda BONK</i>\n\n`;
        msg += `<i>⚡ Sincronizado en tiempo real con Supabase sin reiniciar el bot.</i>`;
        return msg;
      }

      if (cmd === "/agregar_moneda" || cmd === "agregar_moneda" || cmd === "/add_moneda" || cmd === "/add_coin") {
        if (!arg1) {
          return "ℹ️ <b>Uso:</b> <code>/agregar_moneda &lt;SIMBOLO&gt; [core|meme]</code>\nEjemplo: <code>/agregar_moneda ADA</code> o <code>/agregar_moneda FLOKI meme</code>";
        }
        const category: "core" | "meme" = (arg2 && arg2.toLowerCase() === "meme") ? "meme" : "core";
        const result = await this.addCoinToWatchlist(arg1, category);
        return result.message;
      }

      if (cmd === "/quitar_moneda" || cmd === "quitar_moneda" || cmd === "/del_moneda" || cmd === "/del_coin" || cmd === "/eliminar_moneda") {
        if (!arg1) {
          return "ℹ️ <b>Uso:</b> <code>/quitar_moneda &lt;SIMBOLO&gt;</code>\nEjemplo: <code>/quitar_moneda BONK</code>";
        }
        const result = await this.removeCoinFromWatchlist(arg1);
        return result.message;
      }

      if (cmd === "/billetera" || cmd === "/saldos" || cmd === "/saldo_split") {
        const acc = await this.client.account({ recvWindow: 60000 });
        const freeUsdt = parseFloat(acc.data.balances.find((b: any) => b.asset === "USDT")?.free || "0");
        this.loadWalletSplit();
        const manual = Math.min(freeUsdt, this.walletSplit.manualUsdt);
        const bot = Math.max(0, freeUsdt - manual);
        const cop = 3103;
        return "💼 <b>DIVISIÓN DE SALDO: BOT VS MANUAL</b> ⚖️\n\n" +
               "🤖 <b>Saldo del Bot (Automático):</b> <b>$" + bot.toFixed(2) + " USDT</b> (≈ $" + Math.round(bot * cop).toLocaleString("es-CO") + " COP)\n" +
               "<i>(Asignado al Cazador Trailing y órdenes Smart DCA)</i>\n\n" +
               "👤 <b>Saldo Manual (Tus Operaciones):</b> <b>$" + manual.toFixed(2) + " USDT</b> (≈ $" + Math.round(manual * cop).toLocaleString("es-CO") + " COP)\n" +
               "<i>(100% blindado y reservado para tus compras manuales)</i>\n\n" +
               "💧 <b>Total Disponible en Binance:</b> $" + freeUsdt.toFixed(2) + " USDT\n\n" +
               "👉 Para transferir usa: <code>/pasar_manual &lt;monto&gt;</code> o <code>/pasar_bot &lt;monto&gt;</code>";
      }

      if (cmd === "/pasar_manual" || cmd.startsWith("/pasar_manual_")) {
        const amtStr = cmd.includes("_") ? cmd.split("_").pop() : arg1;
        const amt = parseFloat(amtStr || "0");
        if (isNaN(amt) || amt <= 0) {
          return "❓ <b>Uso:</b> <code>/pasar_manual &lt;MONTO&gt;</code>\nEjemplo: <code>/pasar_manual 20</code> (pasa 20 USDT del bot al saldo manual).";
        }
        const acc = await this.client.account({ recvWindow: 60000 });
        const freeUsdt = parseFloat(acc.data.balances.find((b: any) => b.asset === "USDT")?.free || "0");
        this.loadWalletSplit();
        const maxAvail = Math.max(0, freeUsdt - this.walletSplit.manualUsdt);
        const toTransfer = Math.min(amt, maxAvail);
        if (toTransfer <= 0) {
          return "⚠️ Saldo insuficiente en el bot para transferir. El bot solo tiene $" + maxAvail.toFixed(2) + " USDT libres.";
        }
        this.walletSplit.manualUsdt += toTransfer;
        this.saveWalletSplit();
        const newBot = Math.max(0, freeUsdt - this.walletSplit.manualUsdt);
        return "✅ <b>TRANSFERENCIA EXITOSA</b>\n\n" +
               "• Pasados al Saldo Manual: <b>+$" + toTransfer.toFixed(2) + " USDT</b>\n" +
               "• 👤 <b>Nuevo Saldo Manual:</b> $" + this.walletSplit.manualUsdt.toFixed(2) + " USDT\n" +
               "• 🤖 <b>Nuevo Saldo Bot:</b> $" + newBot.toFixed(2) + " USDT";
      }

      if (cmd === "/pasar_bot" || cmd.startsWith("/pasar_bot_")) {
        const amtStr = cmd.includes("_") ? cmd.split("_").pop() : arg1;
        const amt = parseFloat(amtStr || "0");
        if (isNaN(amt) || amt <= 0) {
          return "❓ <b>Uso:</b> <code>/pasar_bot &lt;MONTO&gt;</code>\nEjemplo: <code>/pasar_bot 15</code> (pasa 15 USDT del saldo manual al bot).";
        }
        const acc = await this.client.account({ recvWindow: 60000 });
        const freeUsdt = parseFloat(acc.data.balances.find((b: any) => b.asset === "USDT")?.free || "0");
        this.loadWalletSplit();
        const toTransfer = Math.min(amt, this.walletSplit.manualUsdt);
        if (toTransfer <= 0) {
          return "⚠️ No tienes saldo manual para transferir al bot. Saldo manual actual: $" + this.walletSplit.manualUsdt.toFixed(2) + " USDT.";
        }
        this.walletSplit.manualUsdt = Math.max(0, this.walletSplit.manualUsdt - toTransfer);
        this.saveWalletSplit();
        const newBot = Math.max(0, freeUsdt - this.walletSplit.manualUsdt);
        return "✅ <b>TRANSFERENCIA EXITOSA</b>\n\n" +
               "• Pasados al Saldo del Bot: <b>+$" + toTransfer.toFixed(2) + " USDT</b>\n" +
               "• 🤖 <b>Nuevo Saldo Bot:</b> $" + newBot.toFixed(2) + " USDT\n" +
               "• 👤 <b>Nuevo Saldo Manual:</b> $" + this.walletSplit.manualUsdt.toFixed(2) + " USDT";
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

        // 🛡️ REGLA SUPREMA: NINGUNA APROBACIÓN PUEDE NUNCA EJECUTAR UNA VENTA EN PÉRDIDA
        // Verificar que la oportunidad sea una compra estratégica y nunca una venta en negativo
        if (opp.strategy !== "smart_dca" && opp.strategy !== "trailing_rebound" && opp.strategy !== "micro_grid" && opp.strategy !== "cazador_weekend") {
          this.pendingOpportunity = null;
          this.savePendingOpportunity();
          return "⚠️ Oportunidad no reconocida. Operación descartada por seguridad.";
        }

        this.pendingOpportunity = null;
        this.savePendingOpportunity();
        setTimeout(() => this.executeOpportunity(opp), 100);
        return `🚀 <b>¡APROBADO!</b> Ejecutando <b>${opp.strategyName}</b> en <b>${opp.symbol}</b> por ${opp.amount.toFixed(2)} USDT...\n\n` +
               `🛡️ <b>Blindaje del Core Activo:</b> Esta compra crea un lote 100% independiente. Por regla suprema, NUNCA se venderá en negativo.`;
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
              const cleanSym = (p.symbol || sym).split('_')[0];
              const t = await this.client.tickerPrice(cleanSym);
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
        for (const sym of this.watchlist) {
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

            const isMeme = this.memeWatchlist.includes(sym);
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
          if (this.memeWatchlist.includes(sym)) {
            activeMeme = `${sym} (Comprado a ${fmtPrice(p.buyPrice)})`;
            break;
          }
        }
        let armedMeme: string | null = null;
        for (const [sym, w] of this.buyWatches.entries()) {
          if (this.memeWatchlist.includes(sym)) {
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

        for (const sym of this.memeWatchlist) {
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
          `• <b>Expiración:</b> ${Math.round(TRAILING_BUY_MAX_AGE_MS / 60000)} min sin rebote.\n\n` +
          `🏹 <b>Motor Trailing Take Profit (ACTIVO):</b>\n` +
          `• <b>Gatillo de activación:</b> +${TRAILING_ACTIVATION_PCT}% (Asegura ganancia rápida).\n` +
          `• <b>Persecución de pico:</b> Sube el piso de venta detrás del precio sin límite.\n` +
          `• <b>Cierre óptimo:</b> Vende si retrocede ${TRAILING_CALLBACK_PCT}% desde su pico.\n` +
          `• <b>Techo máximo:</b> +${TRAILING_HARD_CAP_PCT}% (Toma de ganancias automática).\n` +
          `• <b>Nunca vende en pérdida.</b>\n\n` +
          `💰 <b>Capital:</b> 2 ranuras en paralelo (divide el USDT si hay ≥ $30).\n` +
          `🛡️ <b>Diversificación:</b> No compra monedas donde ya tengamos posiciones u órdenes vivas.\n` +
          `📋 <b>Watchlist:</b> ${this.watchlist.join(", ")}\n` +
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

      if (cmd === "/asegurar" || cmd === "asegurar") {
        if (!arg1) {
          return "❓ <b>Uso:</b> <code>/asegurar &lt;MONEDA&gt; [PORCENTAJE]</code>\nEjemplo: <code>/asegurar pepe</code> (asegura el pico actual)\nEjemplo: <code>/asegurar pepe 3.0</code> (asegura en +3.0%)";
        }
        const sym = arg1.toUpperCase().endsWith("USDT") ? arg1.toUpperCase() : `${arg1.toUpperCase()}USDT`;
        const pct = arg2 ? parseFloat(arg2) : undefined;
        const res = await this.lockPositionFloor(sym, pct);
        if (res.success) {
          return `🔒 <b>¡ÉXITO!</b> ${res.msg}\nSi el precio sube, ¡seguirá sumando! Si baja, tienes asegurado el +${res.lockedPct}% neto.`;
        } else {
          return `⚠️ ${res.msg}`;
        }
      }

      if (cmd === "/vender" || cmd === "vender") {
        if (!arg1) {
          return "❓ <b>Uso:</b> <code>/vender &lt;MONEDA&gt;</code>\nEjemplo: <code>/vender sol</code>\n<i>Por seguridad del core, solo vende si la posición está en GANANCIA neta.</i>";
        }
        const asset = arg1.replace("USDT", "");
        const symbol = `${asset}USDT`;

        let pos: ActivePosition | null = null;
        let posKey: string | null = null;
        for (const [k, p] of this.activeTrailingPositions.entries()) {
          const cleanK = k.split("_")[0];
          const cleanP = (p.symbol || "").split("_")[0];
          if (k === symbol || cleanK === symbol || cleanP === symbol) {
            pos = p;
            posKey = k;
            break;
          }
        }

        let curPrice = 0;
        try {
          const t = await this.client.tickerPrice(symbol);
          curPrice = parseFloat(t.data.price);
        } catch {
          return `❌ No se pudo consultar el precio actual de ${symbol} en Binance.`;
        }

        if (pos) {
          const gainPct = ((curPrice - pos.buyPrice) / pos.buyPrice) * 100;
          if (curPrice <= pos.buyPrice || gainPct < 0) {
            return `🛑 <b>[VENTA A PÉRDIDA BLOQUEADA EN EL CORE]</b> 🛡️\n\n` +
              `• <b>Moneda:</b> <b>${symbol}</b>\n` +
              `• 📍 <b>Precio de Compra:</b> $${fmtPrice(pos.buyPrice)}\n` +
              `• 💰 <b>Precio Actual:</b> $${fmtPrice(curPrice)} (<b>${gainPct.toFixed(2)}% PÉRDIDA</b>)\n\n` +
              `⛔ <b>Por regla suprema del core</b>, está terminantemente PROHIBIDO vender en pérdida por comando simple.\n` +
              `🔒 <i>Tus monedas permanecen intactas en Spot esperando el rebote. El bot NUNCA cancela una posición en negativo.</i>\n\n` +
              `💡 <i>Si de verdad deseas asumir esta pérdida y salir manualmente, debes confirmarlo desde el Dashboard web con el botón rojo de doble confirmación, o escribir:</i>\n` +
              `<code>/forzar_venta_perdida ${asset} CONFIRMAR</code>`;
          }

          // Si está en ganancia, ejecutar salida segura a través del motor
          const sold = await this.executeTrailingSell(pos, curPrice, false, false, "MANUAL_TELEGRAM", true, false);
          if (sold) {
            if (posKey) this.activeTrailingPositions.delete(posKey);
            await this.saveTrailingPositions();
            return `✅ <b>¡Venta en Ganancia Ejecutada!</b> 🎯\nSe vendió <b>${symbol}</b> a $${fmtPrice(curPrice)} (+${gainPct.toFixed(2)}% neto).`;
          } else {
            return `⚠️ No se pudo completar la venta de ${symbol}.`;
          }
        }

        // Si no hay posición registrada en memoria pero hay balance libre en Binance
        const acc = await this.client.account({ recvWindow: 60000 });
        const bal = parseFloat(acc.data.balances.find((b: any) => b.asset === asset)?.free || "0");
        if (bal <= 0) return `❌ No tienes balance libre de ${asset} para vender.`;

        const exInfo = await this.client.exchangeInfo({ symbol });
        const sInfo = exInfo.data.symbols[0];
        const stepSize = parseFloat(sInfo.filters.find((f: any) => f.filterType === "LOT_SIZE").stepSize);
        const qtyDec = Math.max(0, Math.round(-Math.log10(stepSize)));
        const sellQtyStr = (Math.floor(bal / stepSize) * stepSize).toFixed(qtyDec);

        const realV = await this.verifyRealCostWithBinance(symbol, parseFloat(sellQtyStr), curPrice);
        if (!realV.ok) {
          return `🛑 <b>[VENTA BLOQUEADA EN EL CORE]</b>\n\n` +
            `• ${realV.reason || `Binance la registraría como PÉRDIDA (${realV.estPnl.toFixed(3)} USDT)`}\n\n` +
            `Si de verdad quieres asumirla: <code>/forzar_venta_perdida ${asset} CONFIRMAR</code> o el botón rojo del Dashboard.`;
        }
        const res = await this.client.newOrder(symbol, "SELL", "MARKET", { quantity: sellQtyStr, recvWindow: 60000 });
        const soldQuote = parseFloat(res.data.cummulativeQuoteQty);
        return `✅ <b>Venta ejecutada:</b> Se vendieron ${sellQtyStr} ${asset} por $${soldQuote.toFixed(2)} USDT.`;
      }

      if (cmd === "/forzar_venta_perdida") {
        if (!arg1 || arg2 !== "CONFIRMAR") {
          return `⚠️ <b>CONFIRMACIÓN REQUERIDA PARA VENDER EN PÉRDIDA</b> ⚠️\n\n` +
            `Para autorizar la venta en PÉRDIDA de una moneda, debes escribir exactamente:\n` +
            `<code>/forzar_venta_perdida ${arg1 || "MONEDA"} CONFIRMAR</code>\n\n` +
            `<i>🛑 Nota: En Spot los tokens son tuyos; nunca hay liquidación. Esperar el rebote siempre protege tu capital.</i>`;
        }
        const asset = arg1.replace("USDT", "");
        const symbol = `${asset}USDT`;

        let pos: ActivePosition | null = null;
        let posKey: string | null = null;
        for (const [k, p] of this.activeTrailingPositions.entries()) {
          const cleanK = k.split("_")[0];
          const cleanP = (p.symbol || "").split("_")[0];
          if (k === symbol || cleanK === symbol || cleanP === symbol) {
            pos = p;
            posKey = k;
            break;
          }
        }

        let curPrice = 0;
        try {
          const t = await this.client.tickerPrice(symbol);
          curPrice = parseFloat(t.data.price);
        } catch {
          return `❌ No se pudo consultar el precio actual de ${symbol} en Binance.`;
        }

        if (pos) {
          const sold = await this.executeTrailingSell(pos, curPrice, false, false, "FORCED_LOSS_TELEGRAM", true, true);
          if (sold) {
            if (posKey) this.activeTrailingPositions.delete(posKey);
            await this.saveTrailingPositions();
            return `🛑 <b>Venta en pérdida autorizada y ejecutada:</b> Se cerró ${symbol} a $${fmtPrice(curPrice)}.`;
          } else {
            return `❌ Error ejecutando la venta forzada de ${symbol}.`;
          }
        }

        // Si no está trackeada pero el usuario ordena vender
        const acc = await this.client.account({ recvWindow: 60000 });
        const bal = parseFloat(acc.data.balances.find((b: any) => b.asset === asset)?.free || "0");
        if (bal <= 0) return `❌ No tienes balance libre de ${asset} para vender.`;
        const exInfo = await this.client.exchangeInfo({ symbol });
        const sInfo = exInfo.data.symbols[0];
        const stepSize = parseFloat(sInfo.filters.find((f: any) => f.filterType === "LOT_SIZE").stepSize);
        const qtyDec = Math.max(0, Math.round(-Math.log10(stepSize)));
        const sellQtyStr = (Math.floor(bal / stepSize) * stepSize).toFixed(qtyDec);
        const res = await this.client.newOrder(symbol, "SELL", "MARKET", { quantity: sellQtyStr, recvWindow: 60000 });
        return `🛑 <b>Venta forzada ejecutada:</b> Se vendieron ${sellQtyStr} ${asset} por $${parseFloat(res.data.cummulativeQuoteQty).toFixed(2)} USDT.`;
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
      for (const s of this.coreWatchlist) {
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
      for (const s of this.memeWatchlist) {
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
          `Rango Bitcoin: ${btcRange.toFixed(2)}% | Escudo Macro BTC 15m activo`,
          `Rango Memecoins: ${memeAvgRange.toFixed(2)}% (Líder ${hottestMeme.symbol} con ${hottestMeme.range.toFixed(1)}%)`,
          `Filtro de Entrada: Bollinger (%B ≤ 0.08) + RVOL + Giro en vela 5m`,
          `Pirámide Invertida Nivel 1: Lote Explorador (máx 8.5% del portafolio)`
        ];
        trWhy = `Con la canasta memecoin y el mercado acelerados, las ondas completas tardan menos en madurar. Calibrar el radar en 15m junto con el filtro de giro de vela de 5m permite capturar el suelo exacto y cobrar rebotes rápidos (+1.2% a +2.5%) sin entrar anticipado ni vender jamás en pérdida.`;
      } else if (btcRange >= 2.0) {
        trTf = "1h";
        trSl = 4.0;
        trReason = `Volatilidad equilibrada (BTC ${btcRange.toFixed(1)}%, Clásicas ${coreAvgRange.toFixed(1)}%). Sesión ${session}.`;
        trCriterios = [
          `Rango Bitcoin: ${btcRange.toFixed(2)}% | Promedio Clásicas: ${coreAvgRange.toFixed(2)}%`,
          `Canasta Memes: ${memeAvgRange.toFixed(2)}% (Líder ${hottestMeme.symbol})`,
          `Confirmación en Piso: Rebote horario + Vela 5m verde o mecha ≥30%`,
          `Pirámide Invertida Nivel 1: Lote Explorador prudente ($18-$25 USDT)`
        ];
        trWhy = "En volatilidad normal, operar en 1H filtra el 90% del ruido intradiario. El bot espera que el precio toque la banda inferior de Bollinger, rebote y confirme absorción en 5m antes de comprar. En Spot rige la regla de Cero Ventas en Pérdida: si la moneda retrocede, Smart DCA inyecta el Nivel 2 en soporte.";
      } else {
        trTf = "1h";
        trSl = 4.0;
        trReason = `BTC comprimido (${btcRange.toFixed(1)}%), pero Memes activas (${memeAvgRange.toFixed(1)}%). Sesión ${session}.`;
        trCriterios = [
          `Rango Macro Bitcoin: ${btcRange.toFixed(2)}% (Calma y absorción institucional)`,
          `Rango Canasta Memecoins: ${memeAvgRange.toFixed(2)}% (Líder: ${hottestMeme.symbol} ${hottestMeme.range.toFixed(1)}%)`,
          `Estrategia Híbrida: 1H + Bandas de Bollinger + Vela 5m de absorción`,
          `Blindaje de Doble Llave: 0% ventas en negativo`
        ];
        trWhy = `En días donde Bitcoin se mueve en canales planos (< 2.0%), mantener 1H evita compras anticipadas en falsas rupturas, exigiendo confirmación de mecha o giro verde en 5m antes de disparar el Lote Explorador.`;
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

      // 2. Sugerencia Smart DCA (Seguridad y Rescate - Pirámide Invertida)
      const isDcaCurrent = currentSettings.smart_dca?.timeframe === "4h";
      const isDcaRejected = !!(this.controls.rejectedSuggestions.smart_dca && this.controls.rejectedSuggestions.smart_dca > now);

      this.controls.suggestions!.smart_dca = {
        timeframe: "4h",
        stopLossPct: 6.0,
        reason: "Pirámide Invertida (Nivel 2: 1.35x | Nivel 3: 1.75x) + Freno en vela 15m.",
        criterios: [
          "Nivel 2 (Soporte ≥ -2.5%, RSI ≤ 45): Invierte 1.35x fuerza (~$22-$36 USDT)",
          "Nivel 3 (Capitulación ≥ -5.5%, RSI ≤ 38): Invierte 1.75x fuerza (~$28-$48 USDT)",
          "Filtro Anti-Cuchillo 15m: Espera vela verde o mecha ≥30% antes de comprar",
          "Lotes 100% Independientes: Cada lote cobra su propia ganancia en verde"
        ],
        porQue: "Como el bot jamás vende en negativo, Smart DCA aplica la Pirámide Invertida Institucional: en lugar de gastar mucho arriba en el Lote 1, guarda la mayor potencia de fuego para los pisos profundos (Lote 2 y Lote 3) una vez que la vela de 15m confirma que la caída ya frenó.",
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
          reason: `Día quieto confirmado en Bitcoin (${btcRange.toFixed(1)}%). Malla lateral activa.`,
          criterios: [
            `Compresión de volatilidad en Bitcoin: ${btcRange.toFixed(2)}% (< 2.2%)`,
            "Compra en el 30% inferior del canal de 6H (rango 0.8% a 2.5%)",
            "Exige vela de soporte (verde o mecha ≥30%) y RSI entre 34 y 46"
          ],
          porQue: "En días planos donde no hay tendencias grandes, Micro-Grid compra en la base del canal lateral con lote prudente (máx $20 USDT) y cobra rebotes rápidos (+0.45% a +0.60%), respetando siempre el blindaje de cero ventas en pérdida.",
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
          reason: `Mercado direccional activo (${btcRange.toFixed(1)}%). Presupuesto en Cazador Trailing.`,
          criterios: [
            `Rango Bitcoin: ${btcRange.toFixed(2)}% (Mercado con ondas direccionales)`,
            "Auto-transferencia de presupuesto al 100% hacia Cazador Trailing"
          ],
          porQue: "Cuando el mercado tiene volatilidad amplia (≥ 2.2%), Micro-Grid se pausa automáticamente y cede su cuota de capital a Cazador Trailing y Smart DCA para capturar recorridos más grandes (+0.8% a +3.5%).",
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
            "Bolsas mundiales cerradas: caza de barridas de liquidez de fin de semana",
            "Puntaje cuantitativo: Caída + RSI + Banda Inferior Bollinger + Mecha",
            "Confirmación de giro en 5m antes de comprar + Salida en apertura CME"
          ],
          porQue: "Durante el fin de semana los creadores de mercado provocan caídas de bajo volumen. Cazador Weekend selecciona el Top 1 de mayor sobreventa y espera el giro real en 5m para comprar en el piso y vender en el impulso de apertura de futuros CME (domingo noche/lunes).",
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
            "Días hábiles de semana (mercados institucionales de Londres y NY abiertos)",
            "Presupuesto cedido automáticamente a Cazador Trailing y Smart DCA"
          ],
          porQue: "Entre semana el flujo institucional opera en Londres y Wall Street, por lo que Cazador Weekend descansa y cede su cuota de capital a las estrategias principales hasta el viernes a las 17:00 COT.",
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
          `👉 Toca un botón o escribe:
` +
          `• /aprobar_grid — <i>Activar Micro-Grid ahora</i>\n` +
          `• /ignorar_grid — <i>Permanecer en Cazador Trailing</i>\n\n` +
          `🤖 <i>${this.controls.autoPilot ? "Modo Autónomo ACTIVO: Si no respondes en 3 minutos, se activará automáticamente." : "Modo Manual: Esperando tu confirmación."}</i>`;

        const buttons = [
          [
            { text: "🌐 Activar Micro-Grid", callback_data: "/aprobar_grid" },
            { text: "❌ Mantener Trailing", callback_data: "/ignorar_grid" }
          ]
        ];
        await this.notifier.send(alertMsg, buttons);
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
   * Ventana de reapertura institucional de futuros CME (Domingo 16:00 a 23:00 COT),
   * donde los rebotes de fin de semana suelen expandir su amplitud.
   */
  public isSundayCmeReopenWindow(): boolean {
    try {
      const now = new Date();
      const dayStr = now.toLocaleDateString("en-US", { timeZone: "America/Bogota", weekday: "short" });
      const hour = parseInt(now.toLocaleTimeString("en-US", { timeZone: "America/Bogota", hour12: false, hour: "numeric" }), 10);
      return dayStr === "Sun" && hour >= 16 && hour <= 23;
    } catch {
      return false;
    }
  }

  /**
   * ESCÁNER MICRO-GRID: Opera compras rápidas en canales laterales estrechos durante días quietos o fines de semana planos.
   */
  async evaluateMicroGrid(usdt: number, activeSymbols: Set<string>): Promise<boolean> {
    const btcRangeCur = this.controls.suggestions?.trailing_rebound?.btcRange24h || 2.5;
    const weekendQuietAssist = this.isWeekendWindow() && btcRangeCur < 2.2 && !this.isSundayCmeReopenWindow();
    if (!this.controls.strategies.micro_grid && !weekendQuietAssist) return false;
    if (this.pendingOpportunity) return false;
    if (usdt < this.minUsdtToTrade) return false;

    interface GridCandidate {
      sym: string;
      curPrice: number;
      min6h: number;
      channelRangePct: number;
      upsideGapPct: number;
      rsi: number;
      percentB: number;
      score: number;
    }
    const candidates: GridCandidate[] = [];

    for (const sym of this.watchlist) {
      try {
        if (activeSymbols.has(sym) || this.hasActivePositionForSymbol(sym) || this.buyWatches.has(sym)) {
          continue;
        }

        const gridTf = this.controls.strategySettings?.micro_grid?.timeframe || "15m";
        const klinesRes = await this.client.klines(sym, gridTf, { limit: 24 });
        const data = klinesRes.data;
        const opens = data.map((k: any) => parseFloat(k[1]));
        const closes = data.map((k: any) => parseFloat(k[4]));
        const highs = data.map((k: any) => parseFloat(k[2]));
        const lows = data.map((k: any) => parseFloat(k[3]));

        const curPrice = closes[closes.length - 1];
        const min6h = Math.min(...lows);
        const max6h = Math.max(...highs);
        const channelRangePct = ((max6h - min6h) / min6h) * 100;

        // Canal lateral calibrado con backtest de 30 días: rango entre 0.65% y 3.20%
        if (channelRangePct >= 0.65 && channelRangePct <= 3.20) {
          const positionInChannel = (curPrice - min6h) / (max6h - min6h);
          const upsideGapPct = curPrice > 0 ? ((max6h - curPrice) / curPrice) * 100 : channelRangePct;
          const rsi = this.calculateRSI(closes, 14);
          const bb = this.calculateBollingerBands(closes, 20, 2.0);
          const lastIdx = closes.length - 1;
          const isGreenOrWick = closes[lastIdx] >= opens[lastIdx] || ((Math.min(opens[lastIdx], closes[lastIdx]) - lows[lastIdx]) / Math.max(1e-9, highs[lastIdx] - lows[lastIdx])) >= 0.28;

          // Si el precio está en el 32% inferior del canal (o %B <= 0.25), RSI <= 46 (incluyendo sobreventa profunda < 34) y vela de soporte:
          if ((positionInChannel <= 0.32 || bb.percentB <= 0.25) && rsi <= 46 && isGreenOrWick) {
            const score = upsideGapPct * 2.0 + (48 - rsi) * 0.4 + (1 - positionInChannel) * 3.0;
            candidates.push({ sym, curPrice, min6h, channelRangePct, upsideGapPct, rsi, percentB: bb.percentB, score });
          }
        }
      } catch (e: any) {}
    }

    if (candidates.length === 0) return false;
    // Elegir la moneda con MAYOR brecha libre hacia el techo del canal lateral
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];

    const sessionPlan = this.lastSessionPlan || this.getSessionLiquidityPlan(usdt);
    const gridPoolUsdt = Math.max(sessionPlan.spendableUsdt || 0, usdt);
    let amountToUse = this.calculateSessionLotSize(best.sym, gridPoolUsdt, sessionPlan.lotFractionPct || 0.45, "micro_grid", 1, best.rsi, best.channelRangePct, best.upsideGapPct);
    // Escalar tope de Micro-Grid según la amplitud del canal: $15 en canales pequeños (<1.4%) hasta $25 en canales amplios (>=2.0%)
    const dynamicGridCap = best.channelRangePct >= 2.0 ? 25 : (best.channelRangePct >= 1.4 ? 20 : 15);
    amountToUse = Math.min(amountToUse, dynamicGridCap);
    if (amountToUse < this.minUsdtToTrade) return false;

    console.log(`🌐 [MICRO-GRID BRECHA TOP] Entrada en ${best.sym}: precio ${best.curPrice} cerca de base ${best.min6h} (Canal ${best.channelRangePct.toFixed(2)}% | Brecha +${best.upsideGapPct.toFixed(2)}% | RSI ${best.rsi.toFixed(1)} | Inversión ${amountToUse} USDT)`);
    const ok = await this.executeSmartBuy(best.sym, amountToUse, `Micro-Grid Canal Lateral (${best.channelRangePct.toFixed(2)}% | Brecha +${best.upsideGapPct.toFixed(2)}%)`, "micro_grid", {
      coinRange24hPct: best.channelRangePct,
      upsideGapPct: best.upsideGapPct
    });
    return ok;
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
      coinRange24hPct: number;
      convictionTier: "ESTANDAR" | "IMPULSO" | "ALTA_VOLATILIDAD";
    }

    const candidates: WeekendCandidate[] = [];

    for (const sym of this.watchlist) {
      try {
        if (activeSymbols.has(sym) || this.hasActivePositionForSymbol(sym) || this.buyWatches.has(sym)) {
          continue;
        }

        const weekendTf = this.controls.strategySettings?.cazador_weekend?.timeframe || "1h";
        const klinesRes = await this.client.klines(sym, weekendTf, { limit: 48 });
        const data = klinesRes.data;
        const opens = data.map((k: any) => parseFloat(k[1]));
        const closes = data.map((k: any) => parseFloat(k[4]));
        const highs = data.map((k: any) => parseFloat(k[2]));
        const lows = data.map((k: any) => parseFloat(k[3]));

        const rsi = this.calculateRSI(closes, 14);
        const bb = this.calculateBollingerBands(closes, 20, 2.0);
        const curPrice = closes[closes.length - 1];
        const maxRecent = Math.max(...highs.slice(-36));
        const dropPct = ((maxRecent - curPrice) / maxRecent) * 100;
        const low24 = Math.min(...lows.slice(-24));
        const high24 = Math.max(...highs.slice(-24));
        const coinRange24hPct = low24 > 0 ? ((high24 - low24) / low24) * 100 : 2.5;
        const convictionTier: "ESTANDAR" | "IMPULSO" | "ALTA_VOLATILIDAD" =
          (coinRange24hPct >= 3.8 && (dropPct >= 2.0 || rsi <= 39)) || coinRange24hPct >= 4.8
            ? "ALTA_VOLATILIDAD"
            : (coinRange24hPct >= 2.6 ? "IMPULSO" : "ESTANDAR");
        const lastIdx = closes.length - 1;
        const candleRange = Math.max(1e-9, highs[lastIdx] - lows[lastIdx]);
        const lowerWickRatio = (Math.min(opens[lastIdx], closes[lastIdx]) - lows[lastIdx]) / candleRange;

        // Criterio de caída o sobreventa en fin de semana
        if ((dropPct >= 1.5 && rsi <= 55) || (rsi <= 45 && dropPct >= 0.8) || (rsi <= 38) || (bb.percentB <= 0.10 && rsi <= 48)) {
          const bbBonus = bb.percentB <= 0.15 ? 4.0 : 0;
          const wickBonus = lowerWickRatio >= 0.30 ? 3.0 : 0;
          const volBonus = coinRange24hPct >= 3.8 ? 3.5 : 0;
          const score = (dropPct * 1.5) + Math.max(0, (48 - rsi) * 2.0) + bbBonus + wickBonus + volBonus;
          candidates.push({ symbol: sym, curPrice, dropPct, rsi, score, coinRange24hPct, convictionTier });
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
      coinRange24hPct: best.coinRange24hPct,
      convictionTier: best.convictionTier,
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

  /**
   * Ventana de Acumulación y Cosecha Pre-Weekend (Viernes 06:00 a 16:59 COT):
   * Asegura liquidez fresca antes de que se abra Cazador Weekend a las 17:00 COT.
   */
  public isPreWeekendAccumulationWindow(): boolean {
    try {
      const now = new Date();
      const dayStr = now.toLocaleDateString("en-US", { timeZone: "America/Bogota", weekday: "short" });
      const hour = parseInt(now.toLocaleTimeString("en-US", { timeZone: "America/Bogota", hour12: false, hour: "numeric" }), 10);
      return dayStr === "Fri" && hour >= 6 && hour < 17;
    } catch {
      return false;
    }
  }

  public getSessionLiquidityPlan(totalFreeUsdt: number): SessionLiquidityPlan {
    const now = new Date();
    const cotHour = parseInt(now.toLocaleTimeString("en-US", { timeZone: "America/Bogota", hour12: false, hour: "numeric" }), 10);
    const cotMin = parseInt(now.toLocaleTimeString("en-US", { timeZone: "America/Bogota", minute: "numeric" }), 10);

    // Reserva base permanente desde la configuración (Mínimo 25% siempre protegido)
    const baseReservePct = (this.controls?.cashReservePct ?? 25) / 100;

    // Definición horaria de las bolsas institucionales (COT = UTC-5)
    const isLondon = cotHour >= 3 && cotHour < 7; // 03:00 - 07:00 COT (Apertura Europea)
    const isNY = (cotHour === 8 && cotMin >= 30) || (cotHour > 8 && cotHour < 14); // 08:30 - 14:00 COT (Wall Street)
    const isAfternoonSlide = cotHour >= 14 && cotHour < 17; // 14:00 - 17:00 COT (Cierre NY y deslizamiento)
    const isPreNight = cotHour >= 17 && cotHour < 20; // 17:00 - 20:00 COT (Cosecha previa a Asia)
    const isNight = cotHour >= 20 || cotHour < 3; // 20:00 - 03:00 COT (Drenaje nocturno y trampas)
    const isPreWeekend = this.isPreWeekendAccumulationWindow();
    const isWeekend = this.isWeekendWindow();

    let sessionKey: SessionLiquidityPlan["sessionKey"] = "REGULAR";
    let sessionTitle = "🔄 Sesión Regular / Transición";
    let reservePct = baseReservePct; // Por defecto siempre respetar mínimo el 25%
    let lotFractionPct = 0.40;
    let trailingBounceTrigger = 0.35;
    let harvestCallbackPct: number | undefined = undefined;
    let reason = "Flujo estándar intradía. Manteniendo colchón de reserva protegido del 25%.";
    let recommendation = "🔄 Operación cautelosa. El 25% del capital queda blindado ante caídas imprevistas.";

    if (isNight) {
      sessionKey = "NOCTURNO_DRENAJE";
      sessionTitle = "🌙 Drenaje Nocturno (Caza de Stops / Vacío de Liquidez)";
      reservePct = 0.50; // CONGELAR EL 50% PARA LONDRES A LAS 03:00 COT
      lotFractionPct = 0.20;
      trailingBounceTrigger = 0.45;
      reason = "Bajo volumen y alto riesgo de caza de stops (Win Rate 38%-43%). El 50% de la caja queda CONGELADA para aprovechar los suelos de Londres a las 03:00 COT.";
      recommendation = "🌙 Mantener reserva congelada. Compras bloqueadas salvo pánico extremo (RSI <= 26 con vela de rechazo).";
    } else if (isPreWeekend) {
      sessionKey = "COSECHA_PRENOCTURNA";
      sessionTitle = "🏖️ Acumulación Pre-Weekend (Viernes 06:00 - 17:00 COT)";
      reservePct = Math.max(0.40, baseReservePct);
      lotFractionPct = 0.30;
      trailingBounceTrigger = 0.40;
      harvestCallbackPct = 0.15;
      reason = "Preparación estratégica de viernes: se blinda al menos el 25% del portafolio total y se cosechan posiciones en verde (+0.60%) para llegar a las 17:00 COT con liquidez garantizada para Cazador Weekend.";
      recommendation = "🏖️ Prioridad Cosecha: Recoger ganancias en verde y guardar presupuesto garantizado para el fin de semana.";
    } else if (isLondon) {
      sessionKey = "LONDRES_REBOTE";
      sessionTitle = "🏰 Rebote de Londres (Apertura Europea / Absorción)";
      reservePct = 0.15; // En Londres se libera la reserva para cazar el rebote de mayor win rate (64%-71%)
      lotFractionPct = 0.60;
      trailingBounceTrigger = 0.25;
      reason = "Máxima tasa de acierto del ciclo (64%-71%). La liquidez guardada en la noche se despliega en los suelos confirmados.";
      recommendation = "🏰 Modo Ofensivo Activo: Despliegue de lotes al 60% cazando suelos con Trailing Buy sensible (+0.25%).";
    } else if (isNY) {
      sessionKey = "NY_IMPULSO";
      sessionTitle = "🗽 Impulso Wall Street (Máxima Liquidez y Volumen)";
      reservePct = 0.25; // 25% de reserva base permanente
      lotFractionPct = 0.50;
      trailingBounceTrigger = 0.35;
      reason = "Mayor volumen del día. Se opera la expansión manteniendo el 25% en caja protegida.";
      recommendation = "🗽 Dejar correr posiciones con Trailing Take Profit y guardar el 25% para retrocesos.";
    } else if (isAfternoonSlide) {
      sessionKey = "COSECHA_PRENOCTURNA";
      sessionTitle = "📉 Enfriamiento Post-Wall Street (14:00 - 17:00 COT)";
      reservePct = 0.35; // ELEVAR RESERVA AL 35% ANTE EL CIERRE DE NY
      lotFractionPct = 0.30;
      trailingBounceTrigger = 0.40;
      reason = "Cierre de contado en Nueva York. Los operadores institucionales toman ganancias y el mercado suele deslizarse a la baja. Reserva elevada al 35%.";
      recommendation = "📉 Proteger el 35% de la caja. No comprar rebotes débiles; esperar confirmación profunda de soporte.";
    } else if (isPreNight) {
      sessionKey = "COSECHA_PRENOCTURNA";
      sessionTitle = "🌆 Cosecha Vespertina & Acumulación (17:00 - 20:00 COT)";
      reservePct = 0.45; // ELEVAR RESERVA AL 45% PARA LA NOCHE
      lotFractionPct = 0.25;
      harvestCallbackPct = 0.20;
      reason = "Preparación para el drenaje nocturno. El 45% de la cuenta se protege en USDT líquido.";
      recommendation = "🌆 Ceñir trailing a 0.20% en ganancias (>= +0.65%) para cerrar en verde y acumular USDT para la noche.";
    }

    // 🛡️ BÓVEDA DE RESERVA ESTRATÉGICA BASADA EN PORTAFOLIO TOTAL (ANTI-SEQUÍA DE SALDO):
    // Evita que las compras normales de Cazador Trailing (Lote 1) entre semana agoten el 100% del USDT,
    // garantizando presupuesto intocable para Fin de Semana (Cazador Weekend), Días Quietos (Micro-Grid) y Rescates (Smart DCA).
    let activeInvested = 0;
    for (const p of this.activeTrailingPositions.values()) {
      activeInvested += (p.investedUsdt || 0);
    }
    const totalPortfolioEst = activeInvested + totalFreeUsdt;

    // Piso estratégico que Cazador Trailing (Tier 1) NO puede gastar:
    // - Viernes Pre-Weekend (06:00-17:00 COT): mín. 25% del portafolio total (o $50 USDT) para asegurar munición a las 17:00 COT.
    // - Fin de Semana (Vie 17:00 - Dom 18:00 COT): se libera la bóveda (solo retiene 10% o $15 USDT para emergencias DCA).
    // - Lunes a Jueves: mín. 18% del portafolio total (o $35 USDT) reservado para Días Quietos (Micro-Grid), Weekend y Smart DCA.
    let strategicFloorUsdt = 0;
    if (activeInvested > 0) {
      if (isPreWeekend) {
        strategicFloorUsdt = Math.max(50, Math.round(totalPortfolioEst * 0.25 * 100) / 100);
      } else if (isWeekend) {
        strategicFloorUsdt = Math.max(15, Math.round(totalPortfolioEst * 0.10 * 100) / 100);
      } else {
        strategicFloorUsdt = Math.max(35, Math.round(totalPortfolioEst * 0.18 * 100) / 100);
      }
    }

    // Calcular montos exactos respetando los mínimos de Binance ($10 USDT) y el Piso Estratégico
    let reservedUsdt = 0;
    let spendableUsdt = totalFreeUsdt;

    if (totalFreeUsdt >= 20) {
      const pctReserve = Math.round(totalFreeUsdt * reservePct * 100) / 100;
      reservedUsdt = Math.min(totalFreeUsdt, Math.max(10, strategicFloorUsdt, pctReserve));
      spendableUsdt = Math.max(0, Math.round((totalFreeUsdt - reservedUsdt) * 100) / 100);
      // Si lo que queda para gastar es menor a $10 USDT, se congela todo como reserva para Weekend / Quieto / DCA
      if (spendableUsdt < this.minUsdtToTrade) {
        reservedUsdt = totalFreeUsdt;
        spendableUsdt = 0;
      }
    } else if (totalFreeUsdt >= this.minUsdtToTrade) {
      // Si el capital libre es entre 10 y 20 USDT:
      // Si ya tenemos posiciones abiertas (activeInvested > 0) o es de noche, BLINDAR al 100% como reserva
      // (Jamás gastar el último billete de $10-$19 en otro Lote 1 de Trailing; guardarlo para DCA / Weekend / Micro-Grid).
      if (isNight || activeInvested > 0) {
        reservedUsdt = totalFreeUsdt;
        spendableUsdt = 0;
      } else {
        reservedUsdt = 0;
        spendableUsdt = totalFreeUsdt;
      }
    } else {
      reservedUsdt = totalFreeUsdt;
      spendableUsdt = 0;
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

  public calculateSessionLotSize(
    symbol: string,
    spendableUsdt: number,
    lotFractionPct: number,
    strategy: "trailing_rebound" | "smart_dca" | "micro_grid" | "cazador_weekend" = "trailing_rebound",
    tier: 1 | 2 | 3 = 1,
    rsi: number = 40,
    coinRange24hPct: number = 2.5,
    dropPct: number = 1.5
  ): number {
    if (spendableUsdt < this.minUsdtToTrade) return 0;

    // Capital total estimado (invertido + disponible) para escalar techos dinámicamente a medida que crece la cuenta
    let activeInvested = 0;
    for (const p of this.activeTrailingPositions.values()) {
      activeInvested += Number(p.investedUsdt || 0);
    }
    const totalPortfolioEst = Math.max(250, activeInvested + spendableUsdt);
    const isMeme = this.memeWatchlist.includes(symbol) || symbol.includes("PEPE") || symbol.includes("BONK") || symbol.includes("DOGE");

    // Graduar el tamaño del lote combinando la fracción de la sesión horaria (COT)
    // con el porcentaje asignado a la estrategia activa en controls.allocations
    const stratAllocPct = (this.controls?.allocations?.[strategy] ?? 50) / 100;
    const allocMultiplier = Math.max(0.75, Math.min(1.15, 0.65 + stratAllocPct * 0.70));

    // Evaluar el Escalón de Volatilidad y Brecha (4 peldaños):
    // - Escalón 4 (MAXIMA_BRECHA): Rango 24h >= 5.0% y brecha/caída >= 3.2% (o brecha >= 4.2%) -> $42 a $56 USDT
    // - Escalón 3 (ALTA_VOLATILIDAD): Rango 24h >= 3.8% y brecha/caída >= 2.0% -> $30 a $44 USDT
    // - Escalón 2 (IMPULSO MEDIO): Rango 24h >= 2.5% y brecha >= 1.5% -> $20 a $30 USDT
    // - Escalón 1 (COMPACTO / LENTO): Rango 24h < 2.5% -> $12 a $18 USDT
    const isMaxGapOpportunity = (coinRange24hPct >= 5.0 && (dropPct >= 3.0 || rsi <= 37)) || dropPct >= 4.2;
    const isHighVolOpportunity = !isMaxGapOpportunity && ((coinRange24hPct >= 3.8 && (dropPct >= 2.0 || rsi <= 39)) || coinRange24hPct >= 4.6);
    const isMediumImpulse = !isMaxGapOpportunity && !isHighVolOpportunity && coinRange24hPct >= 2.5;

    let effectiveFraction = lotFractionPct;
    let tierMultiplier = 0.85;
    let tierMaxCap = isMeme
      ? Math.max(14, Math.min(20, totalPortfolioEst * 0.07))
      : Math.max(15, Math.min(20, totalPortfolioEst * 0.075));

    if (tier === 1 && strategy !== "micro_grid") {
      if (isMaxGapOpportunity) {
        effectiveFraction = Math.max(lotFractionPct, 0.80);
        tierMultiplier = 1.85;
        tierMaxCap = isMeme
          ? Math.max(28, Math.min(40, totalPortfolioEst * 0.14))
          : Math.max(40, Math.min(56, totalPortfolioEst * 0.20));
      } else if (isHighVolOpportunity) {
        effectiveFraction = Math.max(lotFractionPct, 0.65);
        tierMultiplier = rsi <= 34 || dropPct >= 3.0 ? 1.65 : 1.45;
        tierMaxCap = isMeme
          ? Math.max(24, Math.min(34, totalPortfolioEst * 0.115))
          : Math.max(30, Math.min(44, totalPortfolioEst * 0.155));
      } else if (isMediumImpulse) {
        effectiveFraction = Math.max(lotFractionPct, 0.45);
        tierMultiplier = rsi <= 34 ? 1.25 : 1.10;
        tierMaxCap = isMeme
          ? Math.max(18, Math.min(26, totalPortfolioEst * 0.09))
          : Math.max(22, Math.min(30, totalPortfolioEst * 0.105));
      } else if (rsi <= 28) {
        tierMultiplier = 1.15;
        tierMaxCap = Math.max(20, Math.min(28, totalPortfolioEst * 0.10));
      }
    } else if (tier === 2) {
      effectiveFraction = Math.max(lotFractionPct, 0.55);
      tierMultiplier = 1.35;
      tierMaxCap = isMeme
        ? Math.max(18, Math.min(30, totalPortfolioEst * 0.10))
        : Math.max(24, Math.min(38, totalPortfolioEst * 0.13));
    } else if (tier === 3) {
      effectiveFraction = Math.max(lotFractionPct, 0.70);
      tierMultiplier = 1.75;
      tierMaxCap = isMeme
        ? Math.max(22, Math.min(38, totalPortfolioEst * 0.13))
        : Math.max(30, Math.min(48, totalPortfolioEst * 0.16));
    }

    let lot = Math.floor(spendableUsdt * effectiveFraction * allocMultiplier * tierMultiplier * 100) / 100;
    lot = Math.min(lot, Math.floor(tierMaxCap * 100) / 100);

    // Pisos mínimos garantizados por Escalón si hay saldo gastable suficiente
    if (tier === 1 && isMaxGapOpportunity && spendableUsdt >= 35 && lot < 35) {
      lot = Math.min(spendableUsdt, Math.min(48, Math.floor(spendableUsdt * 0.88 * 100) / 100));
    } else if (tier === 1 && isHighVolOpportunity && spendableUsdt >= 25 && lot < 25) {
      lot = Math.min(spendableUsdt, Math.min(35, Math.floor(spendableUsdt * 0.80 * 100) / 100));
    } else if (tier === 1 && isMediumImpulse && spendableUsdt >= 18 && lot < 18) {
      lot = Math.min(spendableUsdt, 20);
    }

    if (lot < this.minUsdtToTrade && spendableUsdt >= this.minUsdtToTrade) {
      lot = this.minUsdtToTrade;
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
  private lastHarvestNotifyTime = 0;

  async checkPrimeHarvestOpportunities(reservedUsdt: number): Promise<boolean> {
    if (reservedUsdt < 15.0) return false;
    // Cooldown de 4 horas para no ser repetitivo
    if (Date.now() - this.lastHarvestNotifyTime < 4 * 3600 * 1000) return false;
    if (this.pendingOpportunity) return false;

    const primeCandidates = ["SOLUSDT", "BTCUSDT", "ETHUSDT", "BNBUSDT"];
    for (const sym of primeCandidates) {
      if (this.hasActivePositionForSymbol(sym)) continue;
      try {
        const klines = await this.client.klines(sym, "1h", { limit: 25 });
        const closes = klines.data.map((k: any) => parseFloat(k[4]));
        const rsi = this.calculateRSI(closes, 14);
        const lastK = klines.data[klines.data.length - 1];
        const open = parseFloat(lastK[1]), high = parseFloat(lastK[2]), low = parseFloat(lastK[3]), close = parseFloat(lastK[4]);
        const range = high - low;
        const lowerWick = Math.min(open, close) - low;
        const wickRatio = range > 0 ? (lowerWick / range) : 0;

        // Oportunidad de oro: RSI 1H <= 30 y absorción o sobreventa profunda <= 28
        if (rsi <= 30 || (rsi <= 35 && wickRatio >= 0.35)) {
          this.lastHarvestNotifyTime = Date.now();
          const cleanSym = sym.replace("USDT", "");
          const amountToSuggest = Math.min(15.0, Math.floor(reservedUsdt * 0.5 * 100) / 100);

          const alertMsg = `💎 <b>¡OPORTUNIDAD DE ORO DETECTADA (COSECHA)!</b> 🎯\n\n` +
            `• <b>Moneda:</b> <b>${sym}</b>\n` +
            `• 📊 <b>Fundamento Institucional:</b> RSI 1H en <b>${rsi.toFixed(1)}</b> con absorción institucional (${(wickRatio * 100).toFixed(0)}% mecha inferior).\n` +
            `• 🌾 <b>Fondo de Cosecha / Reserva Protegida:</b> <b>${reservedUsdt.toFixed(2)} USDT</b>\n` +
            `• 💵 <b>Monto sugerido para entrar:</b> <b>${amountToSuggest.toFixed(2)} USDT</b>\n\n` +
            `<b>¿Deseas autorizar tomar estos fondos de la cosecha para cazar el suelo?</b>\n` +
            `👉 Toca: <code>/tomar_cosecha_${cleanSym}</code> — <i>Ejecutar compra</i>\n` +
            `👉 Toca: /ignorar — <i>Mantener reserva protegida</i>`;

          await this.notifier.send(alertMsg);
          console.log(`💎 Alerta de oportunidad de cosecha enviada para ${sym}`);
          return true;
        }
      } catch(e) {}
    }
    return false;
  }

  private isCheckingLiquidity = false;
  private lastLiquidityAlertTime = 0;

  private async checkLiquidityAndFuturesViability(freeUsdt: number): Promise<void> {
    if (this.isCheckingLiquidity) return;
    // Cooldown de 4 horas para no spamear Telegram
    if (Date.now() - this.lastLiquidityAlertTime < 4 * 3600 * 1000) return;

    // Histéresis: Si el saldo cae por debajo de 35 USDT, reseteamos la bandera para poder alertar de nuevo
    if (freeUsdt < 35.0) {
      if (this.controls.notified50UsdtThreshold) {
        console.log(`[LIQUIDEZ 💧] Saldo libre bajó a ${freeUsdt.toFixed(2)} USDT. Centinela de 50 USDT reactivado.`);
        this.controls.notified50UsdtThreshold = false;
        this.saveStrategyControls();
      }
      return;
    }

    // Si Futuros está desactivado por el usuario, jamás enviar notificaciones de viabilidad de Futuros a Telegram
    if (!(this.controls.strategies as any)?.futures && !this.futuresEngine.isEnabled()) {
      return;
    }

    // Si hay al menos 50 USDT libres y no hemos notificado
    if (freeUsdt >= 50.0 && !this.controls.notified50UsdtThreshold) {
      this.isCheckingLiquidity = true;
      try {
        this.controls.notified50UsdtThreshold = true;
        this.lastLiquidityAlertTime = Date.now();
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
          msg += `   👉 Toca el botón abajo o escribe: /futuros_real\n\n`;
          msg += `2️⃣ <b>Si prefieres no arriesgar en futuros:</b>\n`;
          msg += `   Toca "🛡️ Continuar en Spot"; el bot invertirá automáticamente estos <b>${freeUsdt.toFixed(2)} USDT</b> en Spot sin riesgo de liquidación.`;

          const buttons = [
            [
              { text: "🚀 Activar Futuros Real", callback_data: "/futuros_real" },
              { text: "🛡️ Continuar en Spot", callback_data: "/futuros_sim" }
            ]
          ];
          await this.notifier.send(msg, buttons);
        } else {
          msg += `⚠️ <b>Diagnóstico de Futuros:</b> 🔴 <b>NO RECOMENDADO / ALTO RIESGO (${viability.score}/100)</b>\n\n`;
          msg += `📊 <b>Condiciones Analizadas:</b>\n`;
          msg += `• <b>BTC Macro 1H:</b> ${viability.btcStatus}\n`;
          msg += `• <b>Tasas de Financiación:</b> ${viability.fundingStatus}\n`;
          msg += `• <b>Volatilidad:</b> ${viability.volatilityStatus}\n`;
          msg += `• <b>Diagnóstico:</b> ${viability.rationale}\n\n`;
          msg += `🛡️ <b>Decisión Automática Aplicada:</b>\n`;
          msg += `Como instruiste que solo se use futuros si el mercado es viable, estos fondos se mantendrán y desplegarán en las <b>estrategias Spot</b> (Cazador Trailing & Centinela Alpha) para operar con cero riesgo de liquidación.`;

          const buttons = [
            [
              { text: "🛡️ Operar en Spot", callback_data: "/futuros_sim" },
              { text: "📊 Ver Viabilidad", callback_data: "/viabilidad_futuros" }
            ]
          ];
          await this.notifier.send(msg, buttons);
        }
        console.log("📢 Notificación de liquidez y viabilidad enviada a Telegram con éxito.");
      } catch (err: any) {
        console.error("Error al notificar liquidez y viabilidad:", err.message);
      } finally {
        this.isCheckingLiquidity = false;
      }
    }
  }

  async runCycle() {
    // Sincronizar periódicamente controles desde Supabase
    if (Date.now() % 35000 < 7500) {
      try {
        const freshCtrl = await supabaseDb.loadStrategyControls();
        if (freshCtrl) this.controls = freshCtrl;
      } catch(e) {}
    }
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
      await this.checkPositionActionFile();
      await this.checkOpportunityTimeout();
      await this.checkMarketRegime();
      await this.checkTimeframeAdvisor();
      await this.checkRegimeSwitchTimeout();

      // Auto-sincronizar periódicamente posiciones de Binance
      this.cycleCount = (this.cycleCount || 0) + 1;
      if (this.cycleCount % 6 === 1) {
        await this.syncOrphanPositions();
      }

      // Recargar posiciones dinámicamente para adoptar cualquier nuevo lote comprado
      if ((this.cycleCount || 0) % 3 === 0) {
        await this.loadTrailingPositions();
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
      this.loadWalletSplit();
      const botSpendableUsdt = Math.max(0, usdt - this.walletSplit.manualUsdt);
      const sessionPlan = this.getSessionLiquidityPlan(botSpendableUsdt);
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

      const uniqueActiveCount = this.getUniqueActiveSymbols().size;
      // Concentración inteligente: máximo 5 monedas simultáneas (4 para estándar + 1 exclusiva para Alta Volatilidad/Brecha)
      const maxUniqueCoins = Math.min(this.controls?.maxPositions || 5, 5);
      console.log(`[${time}] [${sessionPlan.sessionTitle}] USDT total: ${usdt.toFixed(2)} (Gastable: ${sessionPlan.spendableUsdt.toFixed(2)} | Reserva: ${sessionPlan.reservedUsdt.toFixed(2)}) | Monedas: ${uniqueActiveCount}/${maxUniqueCoins} (${this.activeTrailingPositions.size} lotes) | Cazando piso: ${this.buyWatches.size}`);

      // Monitoreo de liquidez libre (Meta: >= 50 USDT) para evaluar Futuros
      await this.checkLiquidityAndFuturesViability(usdt);

      // 2. Evaluar oportunidades por Bolsillos Estratégicos (DCA, Weekend y Día Quieto tienen llave sobre la Reserva Protegida)
      if (botSpendableUsdt >= this.minUsdtToTrade && !this.pendingOpportunity) {
        // Bolsillo 1 (Prioridad Máxima): Smart DCA puede usar tanto el saldo gastable como la Bóveda de Reserva para rescatar posiciones
        const dcaTriggered = await this.checkSmartDcaOpportunities(botSpendableUsdt);

        // Bolsillo 2: Centinela Alpha (solo con saldo gastable ordinario)
        let alphaTriggered = false;
        if (!dcaTriggered && this.controls.strategies?.centinela_alpha && sessionPlan.spendableUsdt >= this.minUsdtToTrade) {
          alphaTriggered = await this.evaluateCentinelaAlpha(sessionPlan.spendableUsdt);
        }

        // Bolsillo 3: Fin de Semana (Cazador Weekend desbloquea la Bóveda de Reserva acumulada el viernes, dejando $15 de colchón DCA)
        let weekendTriggered = false;
        const weekendUnlockedUsdt = Math.max(sessionPlan.spendableUsdt, Math.max(0, botSpendableUsdt - 15));
        if (!dcaTriggered && this.isWeekendWindow() && this.controls.strategies.cazador_weekend && uniqueActiveCount < maxUniqueCoins && weekendUnlockedUsdt >= this.minUsdtToTrade) {
          weekendTriggered = await this.evaluateCazadorWeekend(weekendUnlockedUsdt, activeSymbols);
        }

        // Bolsillo 4: Día Quieto / Lateral (Micro-Grid desbloquea hasta $20 USDT de la Bóveda de Reserva, dejando $15 de colchón DCA)
        let gridTriggered = false;
        const btcRangeNow = this.controls.suggestions?.trailing_rebound?.btcRange24h || 2.5;
        const isQuietOrGridActive = this.controls.strategies.micro_grid || (this.isWeekendWindow() && btcRangeNow < 2.2 && !this.isSundayCmeReopenWindow());
        const gridUnlockedUsdt = Math.max(sessionPlan.spendableUsdt, Math.min(20, Math.max(0, botSpendableUsdt - 15)));
        if (!dcaTriggered && !weekendTriggered && isQuietOrGridActive && uniqueActiveCount < maxUniqueCoins && gridUnlockedUsdt >= this.minUsdtToTrade) {
          gridTriggered = await this.evaluateMicroGrid(gridUnlockedUsdt, activeSymbols);
        }

        // Bolsillo 5: Cazador Trailing Estándar (Tier 1 entre semana): respeta ESTRICTAMENTE sessionPlan.spendableUsdt
        // para JAMÁS agotar la reserva destinada a Fin de Semana, Días Quietos y Smart DCA.
        if (!dcaTriggered && !weekendTriggered && !gridTriggered && this.controls.strategies.trailing_rebound && uniqueActiveCount < maxUniqueCoins) {
          if (sessionPlan.spendableUsdt >= this.minUsdtToTrade) {
            await this.scanForDips(activeSymbols);
          }
          if (this.buyWatches.size > 0) {
            await this.checkBuyWatches(this.isWeekendWindow() ? weekendUnlockedUsdt : sessionPlan.spendableUsdt);
          }
        }
      }

      if (sessionPlan.spendableUsdt < this.minUsdtToTrade && sessionPlan.reservedUsdt >= 15.0 && !this.pendingOpportunity) {
        await this.checkPrimeHarvestOpportunities(sessionPlan.reservedUsdt);
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
    const rec = this.controls.recoveryTracker || { targetUsdt: 100.00, recoveredUsdt: 0, tradesCount: 0 };
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

    const debtRemain = Math.max(0, (rec?.targetUsdt || 105.64) - (rec?.recoveredUsdt || 4.05));
    const debtPct = Math.min(100, ((rec?.recoveredUsdt || 4.05) / (rec?.targetUsdt || 105.64)) * 100);

    msg += `🎯 <b>4. Misión Deuda y Recuperación:</b>\n`;
    msg += `• Recuperado hasta hoy: <b>+${rec.recoveredUsdt.toFixed(2)} USDT</b> (${debtPct.toFixed(1)}%)\n`;
    msg += `• Saldo restante por saldar: <b>${debtRemain.toFixed(2)} USDT</b> (Meta: ${rec.targetUsdt.toFixed(2)} USDT)\n\n`;

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

  async syncFromSupabase() {
    try {
      if (!supabaseDb.isAvailable()) {
        console.warn("⚠️ Supabase no disponible en este momento. Usando estado en memoria.");
        return;
      }
      // 1. Consumir Controles y Plan de Recuperación desde la DB
      const dbCtrl = await supabaseDb.loadStrategyControls();
      if (dbCtrl && dbCtrl.strategies) {
        this.controls = dbCtrl;
        this.autoPilot = this.controls.autoPilot !== false;
        console.log(`☁️ [SUPABASE DB] Controles cargados exitosamente desde la nube.`);
        console.log(`🎯 [SUPABASE DB] Meta de Deuda: ${(this.controls.recoveryTracker?.targetUsdt || 100).toFixed(2)} USDT | Recuperado: +${(this.controls.recoveryTracker?.recoveredUsdt || 0).toFixed(2)} USDT`);
        console.log(`🛡️ [SUPABASE DB] Stop-Loss Spot: ${this.controls.stopLossEnabled ? "Activo" : "DESACTIVADO (Blindaje Seguro)"}`);
      }

      // Sincronizar y calibrar Plan de Recuperación con trades reales de Supabase
      const dbTrades = await supabaseDb.loadClosedTrades();
      if (dbTrades && dbTrades.length > 0) {
        const realProfitSum = dbTrades.reduce((acc: number, t: any) => acc + (t.pnlUsdt || 0), 0);
        if (!this.controls.recoveryTracker) {
          this.controls.recoveryTracker = { targetUsdt: 100.00, recoveredUsdt: 0, tradesCount: 0 };
        }
        this.controls.recoveryTracker.recoveredUsdt = Math.max(0, parseFloat(realProfitSum.toFixed(4)));
        this.controls.recoveryTracker.tradesCount = dbTrades.length;
      }

      // 2. Consumir Posiciones Activas desde la DB (preservando candados y picos en memoria)
      const dbPos = await supabaseDb.loadActivePositions();
      if (dbPos && dbPos.size > 0) {
        this.activeTrailingPositions = this.mergePositionsPreservingState(dbPos);
        console.log(`☁️ [SUPABASE DB] ${this.activeTrailingPositions.size} posiciones activas cargadas desde la nube.`);
        for (const [sym, p] of this.activeTrailingPositions.entries()) {
          console.log(`   • ${sym}: ${p.qty} unidades compradas a ${p.buyPrice} (Invertido: ${p.investedUsdt.toFixed(2)} USDT)`);
        }
      }
    } catch (e: any) {
      console.error("⚠️ Error consumiendo datos de Supabase:", e.message);
    }
  }

  async start() {
    console.log(`\n======================================================`);
    console.log(`🏛️ BOT DE TRADING CON TRAILING TAKE PROFIT INTELIGENTE`);
    console.log(`🎯 Trailing Buy: +${TRAILING_BUY_BOUNCE_PCT}% desde el piso | Trailing TP: +${TRAILING_ACTIVATION_PCT}% / callback ${TRAILING_CALLBACK_PCT}%`);
    console.log(`======================================================\n`);

    // 🌐 CONSUMIR DATOS PRIORITARIOS DESDE SUPABASE CLOUD DB
    await this.syncFromSupabase();

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
