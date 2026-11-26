import * as fs from "fs";
import * as path from "path";
import { supabaseDb } from "./supabase-db.js";

export interface StoredRangeSettings {
  manualPiso?: number | null;
  manualTecho?: number | null;
  useManual?: boolean;
  maxBuyPct?: number;
  shieldActive?: boolean;
  updatedAt?: number;
}

export interface MarketRangeItem {
  symbol: string;
  autoPiso: number;
  autoTecho: number;
  manualPiso?: number | null;
  manualTecho?: number | null;
  useManual: boolean;
  effectivePiso: number;
  effectiveTecho: number;
  maxBuyPct: number;
  maxAllowedBuyPrice: number;
  shieldActive: boolean;
  curPrice: number;
  rangeWidthPct: number;
  posInBandPct: number; // 0 = Piso, 100 = Techo
  zone: "PISO_COMPRA" | "ZONA_MEDIA" | "TECHO_RESISTENCIA" | "RUPTURA_BAJISTA" | "RUPTURA_ALCISTA";
  pattern: string;
  recommendation: "COMPRAR" | "ESPERAR" | "VENDER_TOMAR_GANANCIA" | "ALERTA_DESPLOME" | "SEGUIR_CON_TRAILING";
  actionAdvice: string;
  updatedAt: number;
}

const RANGES_FILE = path.resolve(process.cwd(), ".market-ranges.json");
const BINANCE_PUBLIC = "https://api.binance.com";

export class MarketRangesManager {
  private static instance: MarketRangesManager;
  private settingsCache: Record<string, StoredRangeSettings> = {};
  private calculatedCache: Record<string, MarketRangeItem> = {};
  private lastCalcTime: number = 0;

  private constructor() {
    this.loadSettings();
  }

  public static getInstance(): MarketRangesManager {
    if (!MarketRangesManager.instance) {
      MarketRangesManager.instance = new MarketRangesManager();
    }
    return MarketRangesManager.instance;
  }

  public loadSettings(): Record<string, StoredRangeSettings> {
    try {
      if (fs.existsSync(RANGES_FILE)) {
        const raw = fs.readFileSync(RANGES_FILE, "utf-8");
        this.settingsCache = JSON.parse(raw);
        return this.settingsCache;
      }
    } catch (e: any) {
      console.warn("Aviso leyendo .market-ranges.json:", e.message);
    }
    return this.settingsCache;
  }

  public async saveSettings(symbol: string, settings: StoredRangeSettings): Promise<Record<string, StoredRangeSettings>> {
    this.loadSettings();
    this.settingsCache[symbol] = {
      ...this.settingsCache[symbol],
      ...settings,
      updatedAt: Date.now()
    };

    try {
      fs.writeFileSync(RANGES_FILE, JSON.stringify(this.settingsCache, null, 2), "utf-8");
    } catch (e: any) {
      console.error("Error guardando .market-ranges.json:", e.message);
    }

    // Sincronizar en background con Supabase
    try {
      if (supabaseDb.isAvailable()) {
        const ctrl = await supabaseDb.loadStrategyControls();
        if (ctrl) {
          ctrl.marketRanges = this.settingsCache;
          await supabaseDb.saveStrategyControls(ctrl);
        }
      }
    } catch {}

    // Invalidar caché calculado para forzar refresco
    this.lastCalcTime = 0;
    return this.settingsCache;
  }

  public getSettingsForSymbol(symbol: string): StoredRangeSettings {
    this.loadSettings();
    return this.settingsCache[symbol] || {
      useManual: false,
      maxBuyPct: 25,
      shieldActive: true
    };
  }

  /**
   * Verifica si el bot tiene permitido comprar según el rango configurado.
   */
  public isBuyAllowed(symbol: string, curPrice: number): { allowed: boolean; reason?: string; effectivePiso?: number; maxAllowedPrice?: number } {
    const s = this.getSettingsForSymbol(symbol);
    if (s.shieldActive === false) {
      return { allowed: true };
    }

    const calc = this.calculatedCache[symbol];
    const piso = (s.useManual && s.manualPiso && s.manualPiso > 0) ? s.manualPiso : (calc?.autoPiso || 0);
    const techo = (s.useManual && s.manualTecho && s.manualTecho > 0) ? s.manualTecho : (calc?.autoTecho || 0);
    const maxBuyPct = s.maxBuyPct ?? 25;

    if (piso > 0 && techo > piso) {
      const maxAllowedPrice = piso + (techo - piso) * (maxBuyPct / 100);
      if (curPrice > maxAllowedPrice) {
        return {
          allowed: false,
          effectivePiso: piso,
          maxAllowedPrice,
          reason: `Precio actual ($${curPrice.toFixed(2)}) supera el límite de compra de rango ($${maxAllowedPrice.toFixed(2)} / ${maxBuyPct}% del canal $${piso}-$${techo}). Zona de compra: $${piso} a $${maxAllowedPrice.toFixed(2)}.`
        };
      }
    }

    return { allowed: true, effectivePiso: piso };
  }

  /**
   * Calcula o recupera los rangos de mercado y patrones para una lista de símbolos.
   */
  public async getMarketRanges(symbols: string[] = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "DOGEUSDT", "PEPEUSDT"], forceRefresh = false): Promise<Record<string, MarketRangeItem>> {
    const now = Date.now();
    if (!forceRefresh && now - this.lastCalcTime < 45000 && Object.keys(this.calculatedCache).length > 0) {
      return this.calculatedCache;
    }

    this.loadSettings();

    // Consultar precios actuales y klines para cada símbolo
    const results: Record<string, MarketRangeItem> = {};

    await Promise.all(
      symbols.map(async (sym) => {
        try {
          // Obtener velas de 1h de los últimos 4 días (96 velas)
          const kUrl = `${BINANCE_PUBLIC}/api/v3/klines?symbol=${sym}&interval=1h&limit=96`;
          const res = await fetch(kUrl);
          if (!res.ok) return;
          const klines = await res.json();
          if (!Array.isArray(klines) || klines.length < 10) return;

          const closes = klines.map((k: any) => parseFloat(k[4]));
          const highs = klines.map((k: any) => parseFloat(k[2]));
          const lows = klines.map((k: any) => parseFloat(k[3]));
          const opens = klines.map((k: any) => parseFloat(k[1]));

          const curPrice = closes[closes.length - 1];

          // 1. Detección Automática de Piso Estructural
          // Usamos el soporte más respetado: el percentil 8 de los mínimos de las últimas 72 horas para descartar mechas fantasma aisladas
          const recentLows = lows.slice(-72);
          const sortedLows = [...recentLows].sort((a, b) => a - b);
          const p8Idx = Math.max(0, Math.floor(sortedLows.length * 0.08));
          const autoPiso = Number((sortedLows[p8Idx] || Math.min(...recentLows)).toFixed(sym.includes("PEPE") ? 8 : 2));

          // 2. Detección Automática de Techo Estructural
          const recentHighs = highs.slice(-72);
          const autoTecho = Number(Math.max(...recentHighs).toFixed(sym.includes("PEPE") ? 8 : 2));

          // Ajustes guardados por el usuario
          const s = this.settingsCache[sym] || {};
          const useManual = s.useManual === true;
          const manualPiso = s.manualPiso !== undefined ? s.manualPiso : null;
          const manualTecho = s.manualTecho !== undefined ? s.manualTecho : null;
          const maxBuyPct = s.maxBuyPct !== undefined ? s.maxBuyPct : 25;
          const shieldActive = s.shieldActive !== false;

          const effectivePiso = (useManual && manualPiso && manualPiso > 0) ? manualPiso : autoPiso;
          const effectiveTecho = (useManual && manualTecho && manualTecho > effectivePiso) ? manualTecho : autoTecho;

          const rangeSpan = effectiveTecho - effectivePiso;
          const rangeWidthPct = effectivePiso > 0 ? (rangeSpan / effectivePiso) * 100 : 0;
          const posInBandPct = rangeSpan > 0 ? Math.max(0, Math.min(100, ((curPrice - effectivePiso) / rangeSpan) * 100)) : 50;
          const maxAllowedBuyPrice = Number((effectivePiso + rangeSpan * (maxBuyPct / 100)).toFixed(sym.includes("PEPE") ? 8 : 2));

          // Lectura de velas recientes para análisis de patrones
          const lastIdx = closes.length - 1;
          const cOpen = opens[lastIdx];
          const cClose = closes[lastIdx];
          const cHigh = highs[lastIdx];
          const cLow = lows[lastIdx];
          const cRange = cHigh - cLow;
          const lowerWickRatio = cRange > 0 ? (Math.min(cOpen, cClose) - cLow) / cRange : 0;
          const upperWickRatio = cRange > 0 ? (cHigh - Math.max(cOpen, cClose)) / cRange : 0;

          // RSI simple de 14 periodos
          let gains = 0, losses = 0;
          for (let i = closes.length - 14; i < closes.length; i++) {
            const diff = closes[i] - closes[i - 1];
            if (diff >= 0) gains += diff;
            else losses -= diff;
          }
          const rs = losses > 0 ? gains / losses : 1;
          const rsi = 100 - (100 / (1 + rs));

          // Zonas y Patrones
          let zone: MarketRangeItem["zone"] = "ZONA_MEDIA";
          let pattern = "📊 En Rango (Consolidación Neutral)";
          let recommendation: MarketRangeItem["recommendation"] = "ESPERAR";
          let actionAdvice = "El precio se encuentra en zona media de indecisión. Esperar a que toque el piso para no comprar apresurado.";

          if (curPrice < effectivePiso * 0.995) {
            zone = "RUPTURA_BAJISTA";
            pattern = "🚨 Ruptura Bajista del Piso (Pérdida de Soporte)";
            recommendation = "ALERTA_DESPLOME";
            actionAdvice = `El precio perforó el piso de $${effectivePiso}. ¡No comprar! Esperar que el mercado encuentre un nuevo suelo estable.`;
          } else if (curPrice > effectiveTecho * 1.005) {
            zone = "RUPTURA_ALCISTA";
            pattern = "🚀 Ruptura Alcista del Techo (Breakout de Expansión)";
            recommendation = "SEGUIR_CON_TRAILING";
            actionAdvice = `Superó la resistencia de $${effectiveTecho}. Si tienes posición abierta, acompañar con Trailing TP para maximizar ganancias.`;
          } else if (posInBandPct <= maxBuyPct) {
            zone = "PISO_COMPRA";
            if (lowerWickRatio >= 0.35) {
              pattern = "🕯️ Rebote Institucional con Mecha de Absorción en Piso";
            } else if (rsi <= 32) {
              pattern = "💎 Sobreventa Extrema en Soporte Estructural";
            } else {
              pattern = "🟢 Piso de Acumulación / Soporte Válido";
            }
            recommendation = "COMPRAR";
            actionAdvice = `Zona óptima de bajo riesgo. El precio está en el ${posInBandPct.toFixed(1)}% inferior del canal ($${effectivePiso} - $${effectiveTecho}).`;
          } else if (posInBandPct >= 72) {
            zone = "TECHO_RESISTENCIA";
            if (upperWickRatio >= 0.35) {
              pattern = "🔻 Mecha de Rechazo en Techo / Agotamiento Comprador";
            } else {
              pattern = "🔴 Zona de Techo / Distribución";
            }
            recommendation = "VENDER_TOMAR_GANANCIA";
            actionAdvice = `Zona caliente de resistencia ($${effectiveTecho}). Alta probabilidad de corrección. No abrir compras aquí.`;
          } else {
            zone = "ZONA_MEDIA";
            pattern = "⚠️ Zona Media / Peligro de Falso Rebote (Bull Trap)";
            recommendation = "ESPERAR";
            actionAdvice = `El precio está al ${posInBandPct.toFixed(1)}% del rango. Comprar aquí es riesgoso; esperar que baje a menos de $${maxAllowedBuyPrice.toFixed(2)} (zona verde de piso).`;
          }

          results[sym] = {
            symbol: sym,
            autoPiso,
            autoTecho,
            manualPiso,
            manualTecho,
            useManual,
            effectivePiso,
            effectiveTecho,
            maxBuyPct,
            maxAllowedBuyPrice,
            shieldActive,
            curPrice,
            rangeWidthPct: Number(rangeWidthPct.toFixed(2)),
            posInBandPct: Number(posInBandPct.toFixed(1)),
            zone,
            pattern,
            recommendation,
            actionAdvice,
            updatedAt: Date.now()
          };
        } catch (e: any) {
          console.warn(`Error calculando rango para ${sym}:`, e.message);
        }
      })
    );

    this.calculatedCache = results;
    this.lastCalcTime = now;
    return results;
  }
}

export const marketRangesManager = MarketRangesManager.getInstance();
