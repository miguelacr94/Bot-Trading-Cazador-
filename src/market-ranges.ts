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
  idealBuyPrice: number;
  idealSellPrice: number;
  dcaTargetPrice: number;
  shieldActive: boolean;
  curPrice: number;
  rangeWidthPct: number;
  posInBandPct: number; // 0 = Piso, 100 = Techo
  zone: "PISO_COMPRA" | "ZONA_MEDIA" | "TECHO_RESISTENCIA" | "RUPTURA_BAJISTA" | "RUPTURA_ALCISTA";
  pattern: string;
  recommendation: "COMPRAR" | "ESPERAR" | "VENDER_TOMAR_GANANCIA" | "ALERTA_DESPLOME" | "SEGUIR_CON_TRAILING";
  actionAdvice: string;
  weekendRegime?: "PURGA_PROBABLE" | "AGOTAMIENTO_VENDEDOR" | "HIBERNACION_LATERAL";
  weekendAdvice?: string;
  fridayAnchorPrice?: number;
  fridayDropPct?: number;
  dynamicBounceTriggerPct?: number;
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

  public getEffectiveTecho(symbol: string): number {
    const s = this.getSettingsForSymbol(symbol);
    if (s.useManual && s.manualTecho && s.manualTecho > 0) {
      return s.manualTecho;
    }
    const calc = this.calculatedCache[symbol];
    return calc?.effectiveTecho || calc?.autoTecho || 0;
  }

  /**
   * Detecta si una posición existente fue comprada en la mitad superior del canal (compra alta/mal ubicada)
   * para activar el Modo Destrabe de Capital (salida rápida en +0.62% bruto / +0.42% neto).
   */
  public isHighChannelEntry(symbol: string, buyPrice: number): boolean {
    const s = this.getSettingsForSymbol(symbol);
    const calc = this.calculatedCache[symbol];
    const piso = (s.useManual && s.manualPiso && s.manualPiso > 0) ? s.manualPiso : (calc?.autoPiso || 0);
    const techo = (s.useManual && s.manualTecho && s.manualTecho > 0) ? s.manualTecho : (calc?.autoTecho || 0);
    if (piso > 0 && techo > piso) {
      const entryPctInBand = ((buyPrice - piso) / (techo - piso)) * 100;
      return entryPctInBand >= 50;
    }
    return false;
  }

  /**
   * Calcula el gatillo de rebote dinámico progresivo inverso desde el cierre/pico del viernes (11:30 AM COT)
   * adaptado a la volatilidad propia de cada moneda y a qué tan profundo ha caído.
   */
  public getWeekendDynamicBounce(symbol: string, curPrice: number, fallbackDropPct = 0): {
    fridayAnchorPrice: number;
    fridayDropPct: number;
    minRequiredDropPct: number;
    qualifiesDrop: boolean;
    dynamicBouncePct: number;
  } {
    const calc = this.calculatedCache[symbol];
    const rangeWidthPct = calc?.rangeWidthPct || 5.0;
    const volFactor = Math.max(0.85, Math.min(1.65, rangeWidthPct / 5.2));
    const minRequiredDropPct = Number((1.95 * volFactor).toFixed(2));
    const deepCapitulationDrop = Number((5.20 * volFactor).toFixed(2));

    const fridayAnchorPrice = calc?.fridayAnchorPrice || calc?.effectiveTecho || 0;
    const calcFridayDrop = (fridayAnchorPrice > 0 && curPrice > 0)
      ? Math.max(0, ((fridayAnchorPrice - curPrice) / fridayAnchorPrice) * 100)
      : 0;
    const fridayDropPct = Number(Math.max(calcFridayDrop, fallbackDropPct).toFixed(2));
    const qualifiesDrop = fridayDropPct >= minRequiredDropPct;

    const dropProgress = fridayDropPct <= minRequiredDropPct
      ? 0
      : Math.min(1, (fridayDropPct - minRequiredDropPct) / Math.max(1, deepCapitulationDrop - minRequiredDropPct));

    // A mayor caída desde el viernes, más corto y efectivo es el rebote exigido:
    // -2% -> ~0.35% | -3.5% -> ~0.27% | -5%+ -> ~0.18% (escalado a la volatilidad de la moneda)
    let dynamicBouncePct = (0.35 - dropProgress * 0.17) * Math.sqrt(volFactor);
    if (calc && calc.posInBandPct <= 12) {
      dynamicBouncePct -= 0.03;
    }
    dynamicBouncePct = Number(Math.max(0.14, Math.min(0.48, dynamicBouncePct)).toFixed(2));

    return {
      fridayAnchorPrice,
      fridayDropPct,
      minRequiredDropPct,
      qualifiesDrop,
      dynamicBouncePct
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
          const idealBuyPrice = Number((effectivePiso + rangeSpan * 0.10).toFixed(sym.includes("PEPE") ? 8 : 2));
          const idealSellPrice = Number((effectiveTecho - rangeSpan * 0.04).toFixed(sym.includes("PEPE") ? 8 : 2));
          const dcaTargetPrice = Number((effectivePiso + rangeSpan * 0.05).toFixed(sym.includes("PEPE") ? 8 : 2));

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

          // Diagnóstico Inteligente de Régimen de Fin de Semana (¿Caerá o se quedará plano?)
          const lowsLast36h = lows.slice(-36);
          const minLow36h = Math.min(...lowsLast36h);
          const alreadyPurgedToFloor = effectivePiso > 0 && minLow36h <= effectivePiso * 1.012 && curPrice >= effectivePiso * 1.015;
          let weekendRegime: MarketRangeItem["weekendRegime"] = "HIBERNACION_LATERAL";
          let weekendAdvice = "Canal comprimido: operar solo extremos del rango.";

          if (alreadyPurgedToFloor) {
            weekendRegime = "AGOTAMIENTO_VENDEDOR";
            weekendAdvice = "🟢 Ya purgó al piso recientemente y absorbió ventas. Baja probabilidad de desplome extra el fin de semana (esperar lateralización o rebote al techo).";
          } else if (posInBandPct >= 60 || rsi >= 58) {
            weekendRegime = "PURGA_PROBABLE";
            weekendAdvice = "🔴 Precio alto sin purga previa: Alto riesgo de caída de fin de semana (Long Squeeze). Prohibido comprar arriba; esperar emboscada en el piso.";
          }

          // 📉 ANCLA DEL VIERNES (10:00-12:00 COT) Y REBOTE PROGRESIVO INVERSO DINÁMICO:
          // Buscamos la vela del último viernes entre 10:00 AM y 12:00 PM COT (o el pico de las últimas 36h si estamos en viernes/sábado)
          let fridayAnchorPrice = effectiveTecho;
          try {
            let foundFriAnchor = 0;
            for (let i = klines.length - 1; i >= 0; i--) {
              const kTimeCot = new Date(klines[i][0] - 5 * 3600 * 1000);
              const dDay = kTimeCot.getUTCDay();
              const dHr = kTimeCot.getUTCHours();
              if (dDay === 5 && dHr >= 10 && dHr <= 13) {
                const kh = parseFloat(klines[i][2]);
                if (kh > foundFriAnchor) foundFriAnchor = kh;
              }
            }
            if (foundFriAnchor > 0) fridayAnchorPrice = foundFriAnchor;
          } catch {}

          const fridayDropPct = fridayAnchorPrice > 0 ? Number((Math.max(0, ((fridayAnchorPrice - curPrice) / fridayAnchorPrice) * 100)).toFixed(2)) : 0;
          // Escala dinámica según volatilidad propia de la moneda (rangeWidthPct) y ubicación en el canal:
          const volFactor = Math.max(0.85, Math.min(1.65, rangeWidthPct / 5.2));
          const minRequiredDrop = Number((1.95 * volFactor).toFixed(2));
          const deepCapitulationDrop = Number((5.20 * volFactor).toFixed(2));
          const dropProgress = fridayDropPct <= minRequiredDrop
            ? 0
            : Math.min(1, (fridayDropPct - minRequiredDrop) / Math.max(1, deepCapitulationDrop - minRequiredDrop));
          // Curva progresiva inversa: en caída inicial (-2%) exige ~0.35% (escalado a la moneda); en caída profunda (-5%+) baja hasta ~0.16%-0.22%
          let dynamicBounceTriggerPct = (0.35 - dropProgress * 0.17) * Math.sqrt(volFactor);
          if (posInBandPct <= 12 && lowerWickRatio >= 0.30) {
            dynamicBounceTriggerPct -= 0.03; // En piso extremo con mecha de absorción, disparo ultra-rápido
          }
          dynamicBounceTriggerPct = Number(Math.max(0.14, Math.min(0.48, dynamicBounceTriggerPct)).toFixed(2));

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
            idealBuyPrice,
            idealSellPrice,
            dcaTargetPrice,
            shieldActive,
            curPrice,
            rangeWidthPct: Number(rangeWidthPct.toFixed(2)),
            posInBandPct: Number(posInBandPct.toFixed(1)),
            zone,
            pattern,
            recommendation,
            actionAdvice,
            weekendRegime,
            weekendAdvice,
            fridayAnchorPrice: Number(fridayAnchorPrice.toFixed(sym.includes("PEPE") ? 8 : 2)),
            fridayDropPct,
            dynamicBounceTriggerPct,
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
