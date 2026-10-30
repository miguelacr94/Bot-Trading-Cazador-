import { supabaseDb } from "./supabase-db.js";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { Spot } from "@binance/connector";
import { computeRealizedPnl, PNL_SYMBOLS, PnlSummary } from "./pnl.js";

dotenv.config();

const PORT = parseInt(
  process.env.DASHBOARD_PORT || process.env.PORT || "25573",
  10,
);
const COP_PER_USDT = 4200;
const BINANCE_PUBLIC = "https://api.binance.com";

/**
 * Dashboard de solo lectura.
 * Los datos se refrescan en segundo plano y se guardan en caché:
 * /api/status responde al instante y nunca devuelve datos vacíos por un error puntual.
 */
export class DashboardServer {
  private server: http.Server | null = null;
  private client: any;
  private publicDir: string;
  private port: number;
  private timers: NodeJS.Timeout[] = [];

  public getCopRate(): number {
    return this.prices["USDTCOP"] && this.prices["USDTCOP"] > 1000 ? this.prices["USDTCOP"] : 3103;
  }

  public getWalletSplit(totalFreeUsdt = 0): { manualUsdt: number; botUsdt: number; totalFreeUsdt: number; copRate: number; manualCop: number; botCop: number } {
    let manualUsdt = 25.0; // presupuesto inicial manual por defecto si hay saldo
    try {
      const f = path.resolve(process.cwd(), ".wallet-split.json");
      if (fs.existsSync(f)) {
        const data = JSON.parse(fs.readFileSync(f, "utf-8"));
        if (typeof data.manualUsdt === "number") manualUsdt = data.manualUsdt;
      }
    } catch {}

    if (totalFreeUsdt > 0) {
      manualUsdt = Math.max(0, Math.min(totalFreeUsdt, manualUsdt));
    } else {
      manualUsdt = Math.max(0, manualUsdt);
    }
    const botUsdt = Math.max(0, totalFreeUsdt - manualUsdt);
    const copRate = this.getCopRate();
    return {
      manualUsdt,
      botUsdt,
      totalFreeUsdt,
      copRate,
      manualCop: Math.round(manualUsdt * copRate),
      botCop: Math.round(botUsdt * copRate)
    };
  }

  public saveWalletSplit(manualUsdt: number) {
    try {
      const f = path.resolve(process.cwd(), ".wallet-split.json");
      fs.writeFileSync(f, JSON.stringify({ manualUsdt, lastUpdated: Date.now() }, null, 2), "utf-8");
    } catch (e: any) {
      console.error("Error guardando wallet-split:", e.message);
    }
  }

  // Caché (último valor bueno conocido)
  private prices: Record<string, number> = {};
  private radarMeta: Record<string, { rsi: number; dropPct: number }> = {};
  private usdtFree: number | null = null;
  private usdtEarn: number | null = null;
  private pnl: PnlSummary | null = null;
  private lastPriceOk = 0;
  private authError: string | null = null;
  private busy: Record<string, boolean> = {};
  private fng: {
    value: number;
    classification: string;
    updatedAt: number;
  } | null = null;
  private cachedDbTrades: any[] = [];
  private cachedRecoveryTracker: any = null;

  constructor(port = PORT) {
    this.port = port;
    this.publicDir = path.resolve(process.cwd(), "public");
    this.client = new Spot(
      process.env.BINANCE_API_KEY,
      process.env.BINANCE_API_SECRET,
      { recvWindow: 60000 },
    );
  }

  private readJson(file: string): [string, any][] {
    try {
      const f = path.resolve(process.cwd(), file);
      if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf-8"));
    } catch {}
    return [];
  }

  private trackedSymbols(): string[] {
    const pos = this.readJson(".trailing-positions.json").map(([s]) => (s || "").split("_")[0]);
    const buys = this.readJson(".trailing-buys.json").map(([s]) => (s || "").split("_")[0]);
    const allKnown = ["ETHUSDT","SOLUSDT","AVAXUSDT","BTCUSDT","BNBUSDT","XRPUSDT","PEPEUSDT","DOGEUSDT","BONKUSDT","USDTCOP"];
    const set = new Set([...PNL_SYMBOLS, ...allKnown, ...pos, ...buys]);
    return Array.from(set)
      .map((s: string) => (s || "").trim().toUpperCase())
      .filter((s: string) => /^[A-Z0-9]+$/.test(s) && (s.endsWith("USDT") || s === "USDTCOP"));
  }

  /** Ejecuta una tarea de refresco sin solaparla consigo misma */
  private async guarded(name: string, fn: () => Promise<void>) {
    if (this.busy[name]) return;
    this.busy[name] = true;
    try {
      await fn();
    } catch {
    } finally {
      this.busy[name] = false;
    }
  }

  private async refreshPrices() {
    try {
      const syms = this.trackedSymbols();
      if (!syms.length) return;
      const url = `${BINANCE_PUBLIC}/api/v3/ticker/price?symbols=${encodeURIComponent(JSON.stringify(syms))}`;
      const res = await fetch(url);
      if (res.ok) {
        const arr: any[] = await res.json();
        for (const t of arr) this.prices[t.symbol] = parseFloat(t.price);
        this.lastPriceOk = Date.now();
      } else {
        const errText = await res.text();
        console.error(`⚠️ Error en lote de precios Binance (${res.status}): ${errText}`);
        // Fallback robusto: consultar endpoint global
        const fallbackRes = await fetch(`${BINANCE_PUBLIC}/api/v3/ticker/price`);
        if (fallbackRes.ok) {
          const allArr: any[] = await fallbackRes.json();
          const targetSet = new Set(syms);
          for (const t of allArr) {
            if (targetSet.has(t.symbol)) this.prices[t.symbol] = parseFloat(t.price);
          }
          this.lastPriceOk = Date.now();
          console.log(`✅ Precios recuperados vía fallback para ${Object.keys(this.prices).length} pares.`);
        }
      }
    } catch (err: any) {
      console.error("⚠️ Excepción en refreshPrices:", err.message);
    }
  }

  private async refreshRadar() {
    for (const sym of PNL_SYMBOLS) {
      try {
        const res = await fetch(
          `${BINANCE_PUBLIC}/api/v3/klines?symbol=${sym}&interval=15m&limit=35`,
        );
        if (!res.ok) continue;
        const data: any[] = await res.json();
        const closes = data.map((k) => parseFloat(k[4]));
        const highs = data.map((k) => parseFloat(k[2]));
        const cur = closes[closes.length - 1];
        const maxRecent = Math.max(...highs.slice(-20));
        this.radarMeta[sym] = {
          rsi: this.calculateRSI(closes, 14),
          dropPct: maxRecent > 0 ? ((maxRecent - cur) / maxRecent) * 100 : 0,
        };
      } catch {}
    }
  }

  private describeError(e: any): string {
    const d = e?.response?.data;
    return d?.msg
      ? `${d.msg} (código ${d.code})`
      : e?.message || "Error desconocido";
  }

  private async refreshAccount() {
    let acc: any;
    try {
      acc = await this.client.account({ recvWindow: 60000 });
      this.authError = null;
    } catch (e: any) {
      this.authError = this.describeError(e);
      return;
    }
    const b = acc.data.balances || [];
    this.usdtFree = parseFloat(
      b.find((x: any) => x.asset === "USDT")?.free || "0",
    );
    this.usdtEarn = parseFloat(
      b.find((x: any) => x.asset === "LDUSDT")?.free || "0",
    );

    // Sincronizar automáticamente posiciones activas desde Binance (incluye Spot y Simple Earn LD*)
    try {
      const pFile = path.resolve(process.cwd(), ".trailing-positions.json");
      let diskPositions: [string, any][] = fs.existsSync(pFile)
        ? JSON.parse(fs.readFileSync(pFile, "utf-8"))
        : [];
      let updated = false;

      const candidates = ["ETH","SOL","AVAX","BTC","BNB","XRP","PEPE","DOGE","BONK"];
      for (const base of candidates) {
        const sym = base + "USDT";
        // 🛡️ Si ya existe CUALQUIER lote o posición de esta moneda en el disco, NO TOCAR
        if (diskPositions.some(([s, p]: any) => s === sym || s.startsWith(base + "_") || (p && p.symbol && p.symbol.startsWith(base)))) continue;

        const spotBal = parseFloat(
          b.find((x: any) => x.asset === base)?.free || "0",
        );
        const earnBal = parseFloat(
          b.find((x: any) => x.asset === "LD" + base)?.free || "0",
        );
        const totalQty = spotBal + earnBal;

        const curPrice = this.prices[sym] || 0;
        if (totalQty > 0 && curPrice > 0 && totalQty * curPrice >= 10) {
          let buyPrice = curPrice;
          let buyTime = Date.now();
          try {
            const tr = await this.client.myTrades(sym, { limit: 5 });
            const lastBuy = (tr.data || [])
              .reverse()
              .find((t: any) => t.isBuyer);
            if (lastBuy) {
              buyPrice = parseFloat(lastBuy.price);
              buyTime = lastBuy.time;
            }
          } catch {}

          diskPositions.push([
            sym,
            {
              symbol: sym,
              buyPrice,
              qty: totalQty,
              investedUsdt: totalQty * buyPrice,
              highestPrice: Math.max(buyPrice, curPrice),
              activated: ((curPrice - buyPrice) / buyPrice) * 100 >= 0.8,
              buyTime,
            },
          ]);
          updated = true;
          console.log(
            "🔗 [AUTO-DETECT] " +
              sym +
              " sincronizado en dashboard: " +
              totalQty +
              " " +
              base +
              " a $" +
              buyPrice,
          );
        }
      }

      if (updated) {
        fs.writeFileSync(
          pFile,
          JSON.stringify(diskPositions, null, 2),
          "utf-8",
        );
      }
    } catch (e: any) {
      console.error("Error auto-sincronizando posiciones:", e.message);
    }
  }

  private async refreshPnl() {
    // computeRealizedPnl ignora errores por símbolo; si la cuenta no autentica, no tiene sentido llamarlo
    await this.refreshAccount();
    if (this.authError) return;
    const s = await computeRealizedPnl(this.client);
    this.pnl = s;
  }

  private calculateRSI(closes: number[], period: number = 14): number {
    if (closes.length <= period) return 50;
    let gains = 0,
      losses = 0;
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
    return 100 - 100 / (1 + avgGain / avgLoss);
  }

  private isWeekendMode(): boolean {
    try {
      const now = new Date();
      const dayStr = now.toLocaleDateString("en-US", {
        timeZone: "America/Bogota",
        weekday: "short",
      });
      const hourStr = now.toLocaleTimeString("en-US", {
        timeZone: "America/Bogota",
        hour12: false,
        hour: "numeric",
      });
      const hour = parseInt(hourStr, 10);
      if (dayStr === "Fri" && hour >= 17) return true;
      if (dayStr === "Sat") return true;
      if (dayStr === "Sun" && hour < 18) return true;
      return false;
    } catch {
      return false;
    }
  }

  private isNightMode(): boolean {
    try {
      const hour = new Date().toLocaleString("en-US", {
        timeZone: "America/Bogota",
        hour: "numeric",
        hour12: false,
      });
      const h = parseInt(hour, 10);
      return h >= 1 && h < 6;
    } catch {
      return false;
    }
  }

  private async refreshFng() {
    try {
      const res = await fetch("https://api.alternative.me/fng/?limit=1");
      const d = await res.json();
      const item = d.data?.[0];
      if (item) {
        this.fng = {
          value: parseInt(item.value, 10),
          classification: item.value_classification,
          updatedAt: Date.now(),
        };
      }
    } catch (e) {}
  }

  private getSuggestedTimeframe(symbol: string): {
    timeframe: "15m" | "1h" | "4h";
    reason: string;
  } {
    if (
      symbol.includes("PEPE") ||
      symbol.includes("BONK") ||
      symbol.includes("DOGE") ||
      false
    ) {
      return {
        timeframe: "15m",
        reason: "Alta velocidad meme (15m aprovecha impulsos rápidos)",
      };
    }
    if (symbol.includes("BTC") || symbol.includes("ETH")) {
      return {
        timeframe: "1h",
        reason:
          "Filtro de ruido institucional (1H confirma soportes y volumen)",
      };
    }
    if (
      symbol.includes("AVAX") ||
      symbol.includes("SOL") ||
      symbol.includes("LINK")
    ) {
      return {
        timeframe: "1h",
        reason: "Onda swing equilibrada",
      };
    }
    return {
      timeframe: "1h",
      reason: "Estructura estándar de tendencia",
    };
  }

  private getTimeframeForSymbol(
    symbol: string,
    pos?: any,
  ): "15m" | "1h" | "4h" {
    if (pos && pos.customTimeframe) return pos.customTimeframe;
    const ctrlFile = path.resolve(process.cwd(), ".strategy-controls.json");
    if (fs.existsSync(ctrlFile)) {
      try {
        const controls = JSON.parse(fs.readFileSync(ctrlFile, "utf-8"));
        if (controls.symbolTimeframes && controls.symbolTimeframes[symbol]) {
          return controls.symbolTimeframes[symbol];
        }
      } catch (e) {}
    }
    return this.getSuggestedTimeframe(symbol).timeframe;
  }

  private getRecoveryTracker(): {
    targetUsdt: number;
    recoveredUsdt: number;
    tradesCount: number;
  } | null {
    if (this.cachedRecoveryTracker) return this.cachedRecoveryTracker;
    const ctrlFile = path.resolve(process.cwd(), ".strategy-controls.json");
    if (fs.existsSync(ctrlFile)) {
      try {
        const controls = JSON.parse(fs.readFileSync(ctrlFile, "utf-8"));
        return controls.recoveryTracker || { targetUsdt: 100.00, recoveredUsdt: 6.11, tradesCount: 8 };
      } catch (e) {}
    }
    return { targetUsdt: 100.00, recoveredUsdt: 6.11, tradesCount: 8 };
  }

  private getCallbackPct(symbol: string, pos?: any): number {
    if (
      pos &&
      typeof pos.customCallbackPct === "number" &&
      pos.customCallbackPct > 0
    ) {
      return pos.customCallbackPct;
    }
    const ctrlFile = path.resolve(process.cwd(), ".strategy-controls.json");
    if (fs.existsSync(ctrlFile)) {
      try {
        const controls = JSON.parse(fs.readFileSync(ctrlFile, "utf-8"));
        if (
          controls.trailingCallbacks &&
          typeof controls.trailingCallbacks[symbol] === "number"
        ) {
          return controls.trailingCallbacks[symbol];
        }
        if (
          controls.trailingCallbacks &&
          typeof controls.trailingCallbacks["default"] === "number"
        ) {
          return controls.trailingCallbacks["default"];
        }
      } catch (e) {}
    }
    if (
      symbol.includes("PEPE") ||
      symbol.includes("BONK") ||
      symbol.includes("DOGE") ||
      false
    )
      return 0.45;
    if (symbol.includes("AVAX") || symbol.includes("SOL")) return 0.35;
    return 0.25;
  }

  /**
   * Calcula el plan de liquidez institucional y cosecha según el horario de los mercados (Horario Colombia / COT)
   */
  public computeSessionPlan(freeUsdt = 0): any {
    const now = new Date();
    const cotHour = parseInt(now.toLocaleTimeString("en-US", { timeZone: "America/Bogota", hour12: false, hour: "numeric" }), 10);
    const cotMin = parseInt(now.toLocaleTimeString("en-US", { timeZone: "America/Bogota", minute: "numeric" }), 10);

    const isLondon = cotHour >= 3 && cotHour < 7; // 03:00 - 07:00 COT (Apertura Europea)
    const isNY = (cotHour === 8 && cotMin >= 30) || (cotHour > 8 && cotHour < 14); // 08:30 - 14:00 COT (Wall Street)
    const isAfternoonSlide = cotHour >= 14 && cotHour < 17; // 14:00 - 17:00 COT (Cierre NY y deslizamiento)
    const isPreNight = cotHour >= 17 && cotHour < 20; // 17:00 - 20:00 COT (Cosecha previa a Asia)
    const isNight = cotHour >= 20 || cotHour < 3; // 20:00 - 03:00 COT (Drenaje nocturno y trampas)

    let sessionKey: "NOCTURNO_DRENAJE" | "LONDRES_REBOTE" | "NY_IMPULSO" | "COSECHA_PRENOCTURNA" | "REGULAR" = "REGULAR";
    let sessionTitle = "🔄 Sesión Regular / Transición";
    let reservePct = 0.25;
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
      reason = "Bajo volumen y alto riesgo de caza de stops. El 50% de la caja queda CONGELADA para aprovechar los suelos de Londres a las 03:00 COT.";
      recommendation = "🌙 Mantener reserva congelada. Compras bloqueadas salvo pánico extremo (RSI <= 26 con vela de rechazo).";
    } else if (isLondon) {
      sessionKey = "LONDRES_REBOTE";
      sessionTitle = "🏰 Rebote de Londres (Apertura Europea / Absorción)";
      reservePct = 0.15;
      lotFractionPct = 0.60;
      trailingBounceTrigger = 0.25;
      reason = "Máxima tasa de acierto del ciclo (64%-71%). La liquidez guardada en la noche se despliega en los suelos confirmados.";
      recommendation = "🏰 Modo Ofensivo Activo: Despliegue de lotes al 60% cazando suelos con Trailing Buy sensible (+0.25%).";
    } else if (isNY) {
      sessionKey = "NY_IMPULSO";
      sessionTitle = "🗽 Impulso Wall Street (Máxima Liquidez y Volumen)";
      reservePct = 0.25;
      lotFractionPct = 0.50;
      trailingBounceTrigger = 0.35;
      reason = "Mayor volumen y liquidez institucional del día. Se acompaña la tendencia con Trailing Take Profit expansivo (+0.80% a +3.5%).";
      recommendation = "🗽 Dejar correr posiciones vivas con Trailing Take Profit y reservar 25% para retrocesos.";
    } else if (isAfternoonSlide) {
      sessionKey = "COSECHA_PRENOCTURNA";
      sessionTitle = "📉 Enfriamiento Post-Wall Street (14:00 - 17:00 COT)";
      reservePct = 0.35;
      lotFractionPct = 0.30;
      trailingBounceTrigger = 0.40;
      reason = "Volumen institucional descendente. Desacelerar compras nuevas para no quedar atrapado en deslizamientos de fin de sesión.";
      recommendation = "📉 Proteger ganancias del día y ceñir stops en posiciones que alcancen metas.";
    } else if (isPreNight) {
      sessionKey = "COSECHA_PRENOCTURNA";
      sessionTitle = "🌆 Cosecha Pre-Nocturna (17:00 - 20:00 COT)";
      reservePct = 0.45;
      lotFractionPct = 0.25;
      trailingBounceTrigger = 0.40;
      harvestCallbackPct = 0.20;
      reason = "Ventana dorada de cosecha. Ceñir el Trailing al 0.20% y tomar ganancias con +0.65% para asegurar USDT en el bolsillo antes del corte asiático.";
      recommendation = "🌆 Vender y recoger ganancias del día. Maximizar saldo en USDT para recibir la sesión asiática en liquidez.";
    }

    const reservedUsdt = Math.round(freeUsdt * reservePct * 100) / 100;
    const spendableUsdt = Math.max(0, Math.round((freeUsdt - reservedUsdt) * 100) / 100);

    return {
      sessionKey,
      sessionTitle,
      totalFreeUsdt: freeUsdt,
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

  /** Construye la respuesta a partir de la caché (síncrono, instantáneo) */
  getStatusData() {
    const rawPositions = this.readJson(".trailing-positions.json");
    const rawBuys = this.readJson(".trailing-buys.json");

    const copRate = this.getCopRate();
    let totalInvested = 0;
    let positionsValue = 0;

    const positions = rawPositions.map(([symbolOrId, pos]) => {
      const sym = pos.symbol || symbolOrId.split("_")[0];
      const curPrice = this.prices[sym] || pos.buyPrice;
      const target08 = pos.buyPrice * 1.008;
      let gainPct = ((curPrice - pos.buyPrice) / pos.buyPrice) * 100;
      const progressPct =
        ((curPrice - pos.buyPrice) / (target08 - pos.buyPrice)) * 100;
      let pnlUsdt = pos.qty * curPrice - pos.investedUsdt;
      // Eliminar micro-ruido de redondeo de Binance (ej: -0.00003769 cuando curPrice == buyPrice)
      if (Math.abs(gainPct) < 0.0001 || Math.abs(curPrice - pos.buyPrice) < 0.00000001) {
        gainPct = 0;
        pnlUsdt = 0;
      }
      const callback = this.getCallbackPct(sym, pos);
      totalInvested += pos.investedUsdt;
      positionsValue += pos.qty * curPrice;
      return {
        id: pos.id || symbolOrId,
        symbol: sym,
        lotIndex: pos.lotIndex || 1,
        strategy: pos.strategy || "trailing_rebound",
        base: sym.replace("USDT", ""),
        qty: pos.qty,
        investedUsdt: pos.investedUsdt,
        buyPrice: pos.buyPrice,
        curPrice,
        target08,
        progressPct: Math.max(0, Math.min(100, progressPct)),
        gainPct,
        pnlUsdt,
        pnlCop: pnlUsdt * copRate,
        highestPrice: pos.highestPrice,
        peakGainPct: ((pos.highestPrice - pos.buyPrice) / pos.buyPrice) * 100,
        stopPrice: pos.highestPrice * (1 - callback / 100),
        lockedFloorGainPct: pos.lockedFloorGainPct || null,
        callbackPct: callback,
        isCustomCallback: !!pos.customCallbackPct,
        suggestedCallback:
          sym.includes("PEPE") ||
          sym.includes("BONK") ||
          sym.includes("DOGE") ||
          false
            ? 0.45
            : sym.includes("AVAX") || sym.includes("SOL")
              ? 0.35
              : 0.25,
        suggestedReason:
          sym.includes("PEPE") ||
          sym.includes("BONK") ||
          sym.includes("DOGE") ||
          false
            ? "Alta volatilidad Meme (tolerar micro-retrocesos)"
            : sym.includes("AVAX") || sym.includes("SOL")
              ? "Volatilidad media"
              : "Mercado clásico (salida ágil)",
        timeframe: this.getTimeframeForSymbol(sym, pos),
        suggestedTimeframe: this.getSuggestedTimeframe(sym).timeframe,
        suggestedTimeframeReason: this.getSuggestedTimeframe(sym).reason,
        isTimeframeOptimal:
          this.getTimeframeForSymbol(sym, pos) ===
          this.getSuggestedTimeframe(sym).timeframe,
        activated: !!pos.activated,
      };
    });

    const radar = PNL_SYMBOLS.filter(
      (s) => !rawPositions.some(([p]) => p === s),
    ).map((sym) => {
      const meta = this.radarMeta[sym];
      const watch = rawBuys.find(([s]) => s === sym)?.[1];
      return {
        symbol: sym,
        curPrice: this.prices[sym] ?? null,
        rsi: meta ? meta.rsi : null,
        dropPct: meta ? meta.dropPct : null,
        isHunting: !!watch,
        lowestPrice: watch?.lowestPrice ?? null,
      };
    });

    
    
    
    // TELEMETRÍA DE FUTUROS (MODO DESARROLLADOR / SIMULACIÓN)
    let futuresState = { isSimulated: true, enabled: true, virtualBalanceUsdt: 30.0, startingBalanceUsdt: 30.0, maxActivePositions: 2, defaultMarginPerTrade: 5.0, defaultLeverage: 2, stopLossPct: 1.2, trailingTriggerPct: 0.8 };
    try {
      const f = path.resolve(process.cwd(), ".futures-sim-state.json");
      if (fs.existsSync(f)) futuresState = { ...futuresState, ...JSON.parse(fs.readFileSync(f, "utf-8")) };
    } catch {}

    let rawFutPositions: any[] = [];
    try {
      const f = path.resolve(process.cwd(), ".futures-sim-positions.json");
      if (fs.existsSync(f)) rawFutPositions = JSON.parse(fs.readFileSync(f, "utf-8"));
    } catch {}

    let rawFutTrades: any[] = [];
    try {
      const f = path.resolve(process.cwd(), ".futures-sim-trades.json");
      if (fs.existsSync(f)) rawFutTrades = JSON.parse(fs.readFileSync(f, "utf-8"));
    } catch {}

    let futuresRadar: any[] = [];
    try {
      const f = path.resolve(process.cwd(), ".futures-radar.json");
      if (fs.existsSync(f)) futuresRadar = JSON.parse(fs.readFileSync(f, "utf-8"));
    } catch {}

    // Calcular PnL flotante tick a tick en posiciones vivas
    const enrichedFutPositions = rawFutPositions.map((pos: any) => {
      const curPrice = this.prices[pos.symbol] || pos.entryPrice;
      let floatingPnlUsdt = 0;
      if (pos.side === "LONG") {
        floatingPnlUsdt = (curPrice - pos.entryPrice) * pos.contracts;
      } else {
        floatingPnlUsdt = (pos.entryPrice - curPrice) * pos.contracts;
      }
      const floatingRoePct = pos.marginUsdt > 0 ? (floatingPnlUsdt / pos.marginUsdt) * 100 : 0;
      return {
        ...pos,
        curPrice,
        floatingPnlUsdt,
        floatingRoePct
      };
    });

    const futWins = rawFutTrades.filter((t: any) => t.netPnlUsdt > 0).length;
    const futLosses = rawFutTrades.filter((t: any) => t.netPnlUsdt <= 0).length;
    const futWinRate = rawFutTrades.length > 0 ? ((futWins / rawFutTrades.length) * 100).toFixed(1) : "0.0";
    const futRealizedPnl = rawFutTrades.reduce((acc: number, t: any) => acc + (t.netPnlUsdt || 0), 0);
    const futFloatingPnl = enrichedFutPositions.reduce((acc: number, p: any) => acc + (p.floatingPnlUsdt || 0), 0);

    const futuresTelemetry = {
      state: futuresState,
      positions: enrichedFutPositions,
      trades: rawFutTrades.slice(-15).reverse(),
      radar: futuresRadar,
      stats: {
        startingBalanceUsdt: futuresState.startingBalanceUsdt,
        virtualBalanceUsdt: futuresState.virtualBalanceUsdt,
        realizedPnlUsdt: futRealizedPnl,
        floatingPnlUsdt: futFloatingPnl,
        wins: futWins,
        losses: futLosses,
        winRate: futWinRate
      }
    };

    const cash = (this.usdtFree ?? 0) + (this.usdtEarn ?? 0);
    const total = positionsValue + cash;
    const p = this.pnl;
    // SINCRONIZACIÓN HÍBRIDA: Fusionar trades locales del bot con la auditoría de Binance
    let localLedger: any[] = this.cachedDbTrades && this.cachedDbTrades.length > 0 ? this.cachedDbTrades : [];
    if (!localLedger.length) {
      try {
        const f = path.resolve(process.cwd(), ".closed-trades.json");
        if (fs.existsSync(f)) localLedger = JSON.parse(fs.readFileSync(f, "utf-8"));
      } catch {}
    }

    const binanceCycles = p ? p.cycles : [];
    const syncMap = new Map();

    // 1. Cargar ciclos de Binance
    for (const c of binanceCycles) {
      const key = String(c.orderId || (c.symbol + "_" + Math.round(c.time / 1000)));
      syncMap.set(key, {
        symbol: c.symbol,
        orderId: c.orderId,
        time: c.time,
        qty: c.qty,
        avgBuy: c.avgBuy,
        avgSell: c.avgSell,
        costUsdt: c.costUsdt,
        proceedsUsdt: c.proceedsUsdt,
        feesUsdt: c.feesUsdt,
        pnlUsdt: c.pnlUsdt,
        pnlPct: c.pnlPct
      });
    }

    // 2. Fusionar trades locales con deduplicación inteligente contra Binance
    for (const l of localLedger) {
      const alreadyInBinance = binanceCycles.some((c: any) => {
        if (c.orderId && l.orderId && String(c.orderId) === String(l.orderId)) return true;
        if (c.symbol === l.symbol) {
          const priceDiff = Math.abs((c.avgSell || 0) - (l.sellPrice || 0)) / (c.avgSell || 1);
          const timeDiff = Math.abs((c.time || 0) - (l.time || 0));
          if (priceDiff < 0.01 && timeDiff < 6 * 3600 * 1000) return true;
        }
        return false;
      });

      if (!alreadyInBinance) {
        const key = String(l.orderId || (l.symbol + "_" + Math.round(l.time / 1000)));
        if (!syncMap.has(key)) {
          syncMap.set(key, {
            symbol: l.symbol,
            orderId: l.orderId,
            time: l.time,
            qty: l.qty,
            avgBuy: l.buyPrice,
            avgSell: l.sellPrice,
            costUsdt: l.costUsdt,
            proceedsUsdt: l.proceedsUsdt,
            feesUsdt: l.feesUsdt,
            pnlUsdt: l.pnlUsdt,
            pnlPct: l.pnlPct
          });
        }
      }
    }

    const allMergedCycles = Array.from(syncMap.values()).sort((a: any, b: any) => a.time - b.time);
    const totalMergedPnl = allMergedCycles.reduce((acc: number, c: any) => acc + (c.pnlUsdt || 0), 0);
    const totalWins = allMergedCycles.filter((c: any) => c.pnlUsdt >= 0).length;
    const totalLosses = allMergedCycles.filter((c: any) => c.pnlUsdt < 0).length;

    return {
      updatedAt: new Date().toISOString(),
      pricesFresh: Date.now() - this.lastPriceOk < 15000,
      accountAvailable: this.usdtFree !== null,
      authError: this.authError,
      walletSplit: this.getWalletSplit((this.usdtFree ?? 0) + (this.usdtEarn ?? 0)),
      portfolio: {
        totalEstimatedUsdt: total,
        totalEstimatedCop: total * copRate,
        copRate: copRate,
        copPerUsdt: copRate,
        p2pCopRate: 4200,
        usdtFree: this.usdtFree,
        usdtEarn: this.usdtEarn,
        totalInvested,
        openPositionsCount: positions.length,
        maxSlots: 5,
      },
      positions,
      radar,
      performance: p
        ? {
            totalPnlUsdt: totalMergedPnl || (p ? p.totalPnl : 0),
            totalPnlCop: (totalMergedPnl || (p ? p.totalPnl : 0)) * copRate,
            wins: p.wins,
            losses: p.losses,
            cyclesCount: p.cycles.length,
            winRate: p.cycles.length
              ? Math.round((p.wins / p.cycles.length) * 100)
              : 100,
          }
        : null,
      marketSentiment: this.fng || {
        value: 50,
        classification: "Neutral",
        updatedAt: Date.now(),
      },
      nightMode: this.isNightMode(),
      weekendMode: this.isWeekendMode(),
      sessionPlan: (() => {
        try {
          const spFile = path.resolve(process.cwd(), ".session-liquidity-plan.json");
          if (fs.existsSync(spFile)) {
            const data = JSON.parse(fs.readFileSync(spFile, "utf-8"));
            if (Date.now() - (data.updatedAt || 0) < 60000) return data;
          }
        } catch(e) {}
        return this.computeSessionPlan(cash);
      })(),
      projections:
        p && p.cycles.length > 0
          ? (() => {
              const firstTime =
                p.cycles[0].time || Date.now() - 7 * 86400 * 1000;
              const days = Math.max(
                1,
                (Date.now() - firstTime) / (86400 * 1000),
              );
              const dailyRunRate = Math.max(0.1, p.totalPnl / days);
              return {
                daysTracked: Math.round(days),
                dailyAvgUsdt: dailyRunRate,
                dailyAvgCop: dailyRunRate * copRate,
                p30dUsdt: dailyRunRate * 30,
                p30dCop: dailyRunRate * 30 * copRate,
                p60dUsdt: dailyRunRate * 60,
                p60dCop: dailyRunRate * 60 * copRate,
                p90dUsdt: dailyRunRate * 90,
                p90dCop: dailyRunRate * 90 * copRate,
              };
            })()
          : null,
      recentCycles: allMergedCycles.slice(-35).reverse(),
      futuresTelemetry,
      recoveryTracker: this.cachedRecoveryTracker || this.getRecoveryTracker(),
    };
  }

  private startRefreshLoops() {
    const every = (name: string, ms: number, fn: () => Promise<void>) => {
      const run = () => this.guarded(name, fn);
      run();
      this.timers.push(setInterval(run, ms));
    };
    every("prices", 2000, () => this.refreshPrices());
    every("account", 15000, () => this.refreshAccount());
    every("radar", 60000, () => this.refreshRadar());
    every("fng", 300000, () => this.refreshFng());
    every("pnl", 30000, () =>
      this.pnl && !this.authError ? Promise.resolve() : this.refreshPnl(),
    );
    every("pnlFull", 120000, () => this.refreshPnl());
  }

  start() {
    this.startRefreshLoops();

    this.server = http.createServer((req, res) => {
      const parsedUrl = new URL(req.url || "/", `http://${req.headers.host}`);

      if (parsedUrl.pathname === "/api/status") {
        try {
          res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          });
          res.end(JSON.stringify(this.getStatusData()));
        } catch (e: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }

      if (parsedUrl.pathname === "/api/strategies" && req.method === "GET") {
        try {
          const ctrlFile = path.resolve(
            process.cwd(),
            ".strategy-controls.json",
          );
          const oppFile = path.resolve(
            process.cwd(),
            ".pending-opportunity.json",
          );
          const controls = fs.existsSync(ctrlFile)
            ? JSON.parse(fs.readFileSync(ctrlFile, "utf-8"))
            : {
                strategies: {
                  trailing_rebound: true,
                  smart_dca: true,
                  micro_grid: false,
                  cazador_weekend: true,
                },
                autoPilot: true,
                approvalTimeoutSec: 180,
              };
          const pending = fs.existsSync(oppFile)
            ? JSON.parse(fs.readFileSync(oppFile, "utf-8"))
            : null;
          res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          });
          res.end(
            JSON.stringify({
              controls,
              pendingOpportunity: pending,
              serverTime: Date.now(),
            }),
          );
        } catch (e: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }

      if (
        parsedUrl.pathname === "/api/strategies/allocation" &&
        req.method === "POST"
      ) {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          try {
            const data = JSON.parse(body || "{}");
            let t = Math.max(0, parseInt(data.trailing || "0", 10));
            let d = Math.max(0, parseInt(data.dca || "0", 10));
            let g = Math.max(0, parseInt(data.grid || "0", 10));
            let w = Math.max(0, parseInt(data.weekend || "0", 10));
            let f = Math.max(0, parseInt(data.futures || "0", 10));
            const sum = t + d + g + w + f;
            if (sum === 0) {
              t = 50;
              d = 30;
              g = 0;
              w = 20;
            } else if (sum !== 100) {
              t = Math.round((t / sum) * 100);
              d = Math.round((d / sum) * 100);
              g = Math.round((g / sum) * 100);
              w = 100 - t - d - g;
            }

            const ctrlFile = path.resolve(
              process.cwd(),
              ".strategy-controls.json",
            );
            const controls = fs.existsSync(ctrlFile)
              ? JSON.parse(fs.readFileSync(ctrlFile, "utf-8"))
              : {
                  strategies: {
                    trailing_rebound: true,
                    smart_dca: true,
                    micro_grid: false,
                    cazador_weekend: true,
                  },
                  autoPilot: true,
                  approvalTimeoutSec: 180,
                };
            controls.baseAllocations = {
              trailing_rebound: t,
              smart_dca: d,
              micro_grid: g,
              cazador_weekend: w,
              futures: f,
            };
            const isW = this.isWeekendMode();
            if (!isW) {
              controls.allocations = {
                trailing_rebound: t + w,
                smart_dca: d,
                micro_grid: g,
                cazador_weekend: 0,
                futures: f,
              };
              controls.strategies.cazador_weekend = false;
            } else {
              controls.allocations = {
                trailing_rebound: t,
                smart_dca: d,
                micro_grid: g,
                cazador_weekend: w,
                futures: f,
              };
              controls.strategies.cazador_weekend = true;
            }
            controls.updatedAt = Date.now();
            fs.writeFileSync(
              ctrlFile,
              JSON.stringify(controls, null, 2),
              "utf-8",
            );
            res.writeHead(200, {
              "Content-Type": "application/json; charset=utf-8",
            });
            res.end(JSON.stringify({ success: true, controls }));
          } catch (e: any) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: e.message }));
          }
        });
        return;
      }

      // Actualizar ajustes independientes de un módulo de estrategia
      if (
        parsedUrl.pathname === "/api/strategies/module-settings" &&
        req.method === "POST"
      ) {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          try {
            const data = JSON.parse(body || "{}");
            const ctrlFile = path.resolve(
              process.cwd(),
              ".strategy-controls.json",
            );
            const controls = fs.existsSync(ctrlFile)
              ? JSON.parse(fs.readFileSync(ctrlFile, "utf-8"))
              : {};
            if (!controls.strategySettings) controls.strategySettings = {};

            const strat = data.strategy;
            if (
              strat &&
              [
                "trailing_rebound",
                "smart_dca",
                "micro_grid",
                "cazador_weekend",
              ].includes(strat)
            ) {
              if (!controls.strategySettings[strat]) {
                controls.strategySettings[strat] = {
                  timeframe: "1h",
                  stopLossEnabled: false,
                  stopLossPct: 4.0,
                };
              }
              if (data.timeframe)
                controls.strategySettings[strat].timeframe = data.timeframe;
              if (data.stopLossEnabled !== undefined)
                controls.strategySettings[strat].stopLossEnabled =
                  !!data.stopLossEnabled;
              if (data.stopLossPct !== undefined)
                controls.strategySettings[strat].stopLossPct = Math.max(
                  1,
                  Math.min(20, parseFloat(data.stopLossPct)),
                );
            }

            controls.updatedAt = Date.now();
            fs.writeFileSync(
              ctrlFile,
              JSON.stringify(controls, null, 2),
              "utf-8",
            );
            res.writeHead(200, {
              "Content-Type": "application/json; charset=utf-8",
            });
            res.end(JSON.stringify({ success: true, controls }));
          } catch (e: any) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: e.message }));
          }
        });
        return;
      }

      // Aplicar sugerencia inteligente del bot a una estrategia específica
      if (
        parsedUrl.pathname === "/api/strategies/apply-suggestion" &&
        req.method === "POST"
      ) {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          try {
            const data = JSON.parse(body || "{}");
            const strat = data.strategy;
            const ctrlFile = path.resolve(
              process.cwd(),
              ".strategy-controls.json",
            );
            const controls = fs.existsSync(ctrlFile)
              ? JSON.parse(fs.readFileSync(ctrlFile, "utf-8"))
              : {};

            if (strat && controls.suggestions && controls.suggestions[strat]) {
              if (!controls.strategySettings) controls.strategySettings = {};
              if (!controls.strategySettings[strat]) {
                controls.strategySettings[strat] = {
                  timeframe: "1h",
                  stopLossEnabled: false,
                  stopLossPct: 4.0,
                };
              }
              const sugg = controls.suggestions[strat];
              controls.strategySettings[strat].timeframe = sugg.timeframe;
              controls.strategySettings[strat].stopLossPct = sugg.stopLossPct;
              // SEGURIDAD SPOT: NO forzar venta a pérdida; preservar el switch de stopLossEnabled que decidió el usuario
              if (
                controls.strategySettings[strat].stopLossEnabled === undefined
              ) {
                controls.strategySettings[strat].stopLossEnabled = false;
              }

              // Si estaba rechazada, limpiar rechazo
              if (
                controls.rejectedSuggestions &&
                controls.rejectedSuggestions[strat]
              ) {
                delete controls.rejectedSuggestions[strat];
              }
              if (controls.suggestions[strat]) {
                controls.suggestions[strat].status = "applied";
                controls.suggestions[strat].isCurrent = true;
              }

              controls.updatedAt = Date.now();
              fs.writeFileSync(
                ctrlFile,
                JSON.stringify(controls, null, 2),
                "utf-8",
              );
              res.writeHead(200, {
                "Content-Type": "application/json; charset=utf-8",
              });
              res.end(
                JSON.stringify({ success: true, controls, applied: sugg }),
              );
            } else {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  error: "Sugerencia no encontrada para " + strat,
                }),
              );
            }
          } catch (e: any) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: e.message }));
          }
        });
        return;
      }

      // Descartar / Rechazar sugerencia de Centinela (silenciar por 4h)
      if (
        parsedUrl.pathname === "/api/strategies/reject-suggestion" &&
        req.method === "POST"
      ) {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          try {
            const data = JSON.parse(body || "{}");
            const strat = data.strategy;
            const ctrlFile = path.resolve(
              process.cwd(),
              ".strategy-controls.json",
            );
            const controls = fs.existsSync(ctrlFile)
              ? JSON.parse(fs.readFileSync(ctrlFile, "utf-8"))
              : {};

            if (!controls.rejectedSuggestions)
              controls.rejectedSuggestions = {};
            if (strat) {
              // Silenciar por 4 horas
              controls.rejectedSuggestions[strat] =
                Date.now() + 4 * 3600 * 1000;
              if (controls.suggestions && controls.suggestions[strat]) {
                controls.suggestions[strat].status = "rejected";
              }
              controls.updatedAt = Date.now();
              fs.writeFileSync(
                ctrlFile,
                JSON.stringify(controls, null, 2),
                "utf-8",
              );
              res.writeHead(200, {
                "Content-Type": "application/json; charset=utf-8",
              });
              res.end(
                JSON.stringify({ success: true, controls, rejected: strat }),
              );
            } else {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Parámetro strategy faltante" }));
            }
          } catch (e: any) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: e.message }));
          }
        });
        return;
      }

      // Deshacer rechazo de sugerencia de Centinela
      if (
        parsedUrl.pathname === "/api/strategies/undo-reject-suggestion" &&
        req.method === "POST"
      ) {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          try {
            const data = JSON.parse(body || "{}");
            const strat = data.strategy;
            const ctrlFile = path.resolve(
              process.cwd(),
              ".strategy-controls.json",
            );
            const controls = fs.existsSync(ctrlFile)
              ? JSON.parse(fs.readFileSync(ctrlFile, "utf-8"))
              : {};

            if (controls.rejectedSuggestions && strat) {
              delete controls.rejectedSuggestions[strat];
              if (controls.suggestions && controls.suggestions[strat]) {
                const s = controls.strategySettings?.[strat];
                const isCurrent =
                  s?.timeframe === controls.suggestions[strat].timeframe;
                controls.suggestions[strat].status = isCurrent
                  ? "applied"
                  : "pending";
              }
              controls.updatedAt = Date.now();
              fs.writeFileSync(
                ctrlFile,
                JSON.stringify(controls, null, 2),
                "utf-8",
              );
              res.writeHead(200, {
                "Content-Type": "application/json; charset=utf-8",
              });
              res.end(
                JSON.stringify({ success: true, controls, unrejected: strat }),
              );
            } else {
              res.writeHead(200, {
                "Content-Type": "application/json; charset=utf-8",
              });
              res.end(JSON.stringify({ success: true, controls }));
            }
          } catch (e: any) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: e.message }));
          }
        });
        return;
      }

      if (
        parsedUrl.pathname === "/api/strategies/timeframe" &&
        req.method === "POST"
      ) {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          try {
            const data = JSON.parse(body || "{}");
            const sym = data.symbol
              ? data.symbol.endsWith("USDT") || data.symbol === "default"
                ? data.symbol
                : data.symbol + "USDT"
              : null;
            const tf =
              data.timeframe &&
              ["15m", "1h", "4h", "1d"].includes(data.timeframe)
                ? data.timeframe
                : null;

            if (!sym || !tf) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  error:
                    "Símbolo y timeframe válidos ('15m', '1h', '4h') requeridos.",
                }),
              );
              return;
            }

            const ctrlFile = path.resolve(
              process.cwd(),
              ".strategy-controls.json",
            );
            const controls = fs.existsSync(ctrlFile)
              ? JSON.parse(fs.readFileSync(ctrlFile, "utf-8"))
              : {};
            if (!controls.symbolTimeframes) controls.symbolTimeframes = {};
            controls.symbolTimeframes[sym] = tf;
            controls.updatedAt = Date.now();
            fs.writeFileSync(
              ctrlFile,
              JSON.stringify(controls, null, 2),
              "utf-8",
            );

            const posFile = path.resolve(
              process.cwd(),
              ".trailing-positions.json",
            );
            if (fs.existsSync(posFile)) {
              try {
                const positions = JSON.parse(fs.readFileSync(posFile, "utf-8"));
                const map = new Map(positions);
                if (map.has(sym)) {
                  const p: any = map.get(sym);
                  p.customTimeframe = tf;
                  map.set(sym, p);
                  fs.writeFileSync(
                    posFile,
                    JSON.stringify(Array.from(map.entries()), null, 2),
                    "utf-8",
                  );
                }
              } catch (e) {}
            }

            res.writeHead(200, {
              "Content-Type": "application/json; charset=utf-8",
            });
            res.end(
              JSON.stringify({ success: true, symbol: sym, timeframe: tf }),
            );
          } catch (e: any) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: e.message }));
          }
        });
        return;
      }

      if (
        parsedUrl.pathname === "/api/strategies/callback" &&
        req.method === "POST"
      ) {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          try {
            const data = JSON.parse(body || "{}");
            const sym = data.symbol
              ? data.symbol.endsWith("USDT") || data.symbol === "default"
                ? data.symbol
                : data.symbol + "USDT"
              : null;
            const cbPct =
              data.callbackPct !== undefined
                ? Math.max(0.1, Math.min(3.0, parseFloat(data.callbackPct)))
                : null;

            if (!sym || cbPct === null) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  error: "Símbolo y callbackPct (0.10% a 3.00%) requeridos.",
                }),
              );
              return;
            }

            const ctrlFile = path.resolve(
              process.cwd(),
              ".strategy-controls.json",
            );
            const controls = fs.existsSync(ctrlFile)
              ? JSON.parse(fs.readFileSync(ctrlFile, "utf-8"))
              : {};
            if (!controls.trailingCallbacks) controls.trailingCallbacks = {};
            controls.trailingCallbacks[sym] = cbPct;
            controls.updatedAt = Date.now();
            fs.writeFileSync(
              ctrlFile,
              JSON.stringify(controls, null, 2),
              "utf-8",
            );

            // Si la posición está abierta en .trailing-positions.json, actualizarla también
            const posFile = path.resolve(
              process.cwd(),
              ".trailing-positions.json",
            );
            if (fs.existsSync(posFile)) {
              try {
                const positions = JSON.parse(fs.readFileSync(posFile, "utf-8"));
                const map = new Map(positions);
                if (map.has(sym)) {
                  const p: any = map.get(sym);
                  p.customCallbackPct = cbPct;
                  map.set(sym, p);
                  fs.writeFileSync(
                    posFile,
                    JSON.stringify(Array.from(map.entries()), null, 2),
                    "utf-8",
                  );
                }
              } catch (e) {}
            }

            res.writeHead(200, {
              "Content-Type": "application/json; charset=utf-8",
            });
            res.end(
              JSON.stringify({
                success: true,
                symbol: sym,
                callbackPct: cbPct,
              }),
            );
          } catch (e: any) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: e.message }));
          }
        });
        return;
      }

      if (
        parsedUrl.pathname === "/api/strategies/settings" &&
        req.method === "POST"
      ) {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          try {
            const data = JSON.parse(body || "{}");
            const ctrlFile = path.resolve(
              process.cwd(),
              ".strategy-controls.json",
            );
            const controls = fs.existsSync(ctrlFile)
              ? JSON.parse(fs.readFileSync(ctrlFile, "utf-8"))
              : {
                  strategies: {
                    trailing_rebound: true,
                    smart_dca: true,
                    micro_grid: false,
                    cazador_weekend: true,
                  },
                  autoPilot: true,
                  approvalTimeoutSec: 180,
                };

            if (data.stopLossEnabled !== undefined)
              controls.stopLossEnabled = !!data.stopLossEnabled;
            if (data.stopLossPct !== undefined)
              controls.stopLossPct = Math.max(
                1,
                Math.min(20, parseFloat(data.stopLossPct)),
              );
            if (
              data.timeframe &&
              ["15m", "1h", "4h", "1d"].includes(data.timeframe)
            )
              controls.timeframe = data.timeframe;
            if (data.cashReservePct !== undefined)
              controls.cashReservePct = Math.max(
                5,
                Math.min(50, parseInt(data.cashReservePct, 10)),
              );
            if (data.maxPerCoinPct !== undefined)
              controls.maxPerCoinPct = Math.max(
                10,
                Math.min(60, parseInt(data.maxPerCoinPct, 10)),
              );
            if (data.autoPilot !== undefined)
              controls.autoPilot = !!data.autoPilot;

            controls.updatedAt = Date.now();
            fs.writeFileSync(
              ctrlFile,
              JSON.stringify(controls, null, 2),
              "utf-8",
            );
            res.writeHead(200, {
              "Content-Type": "application/json; charset=utf-8",
            });
            res.end(JSON.stringify({ success: true, controls }));
          } catch (e: any) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: e.message }));
          }
        });
        return;
      }

      if (
        parsedUrl.pathname === "/api/futures/config" &&
        req.method === "POST"
      ) {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          try {
            const data = JSON.parse(body || "{}");
            const futStateF = path.resolve(process.cwd(), ".futures-sim-state.json");
            const ctrlFile = path.resolve(process.cwd(), ".strategy-controls.json");

            let futSt: any = {
              isSimulated: true,
              enabled: true,
              virtualBalanceUsdt: 100,
              startingBalanceUsdt: 100,
              maxActivePositions: 2,
              defaultMarginPerTrade: 15,
              defaultLeverage: 3,
              leverageMode: "dynamic",
              stopLossPct: 1.2,
              trailingTriggerPct: 1.2,
              trailingCallbackPct: 0.35,
              lastScanTime: 0
            };
            if (fs.existsSync(futStateF)) {
              try { futSt = JSON.parse(fs.readFileSync(futStateF, "utf-8")); } catch {}
            }

            let controls: any = {};
            if (fs.existsSync(ctrlFile)) {
              try { controls = JSON.parse(fs.readFileSync(ctrlFile, "utf-8")); } catch {}
            }
            if (!controls.strategies) controls.strategies = {};
            if (!controls.strategySettings) controls.strategySettings = {};
            if (!controls.strategySettings.futures) {
              controls.strategySettings.futures = {
                timeframe: "15m",
                stopLossEnabled: true,
                stopLossPct: 1.2,
                leverage: 3,
                isSimulated: true
              };
            }

            if (data.enabled !== undefined) {
              futSt.enabled = !!data.enabled;
              controls.strategies.futures = !!data.enabled;
            }
            if (data.isSimulated !== undefined) {
              futSt.isSimulated = !!data.isSimulated;
              controls.strategySettings.futures.isSimulated = !!data.isSimulated;
            }
            if (data.marginPerTrade !== undefined) {
              const m = parseFloat(data.marginPerTrade);
              if (!isNaN(m) && m > 0) {
                futSt.defaultMarginPerTrade = m;
              }
            }
            if (data.startingBalance !== undefined) {
              const b = parseFloat(data.startingBalance);
              if (!isNaN(b) && b > 0) {
                futSt.startingBalanceUsdt = b;
                if (data.reset) futSt.virtualBalanceUsdt = b;
              }
            }
            if (data.leverageMode) {
              futSt.leverageMode = data.leverageMode;
            }

            controls.updatedAt = Date.now();
            fs.writeFileSync(futStateF, JSON.stringify(futSt, null, 2), "utf-8");
            supabaseDb.saveStrategyControls(controls).catch(() => {});
fs.writeFileSync(ctrlFile, JSON.stringify(controls, null, 2), "utf-8");

            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ success: true, state: futSt, controls: controls.strategies }));
          } catch (e: any) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: e.message }));
          }
        });
        return;
      }

      if (parsedUrl.pathname === "/api/strategies/toggle" &&
        req.method === "POST"
      ) {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          try {
            const data = JSON.parse(body || "{}");
            const ctrlFile = path.resolve(
              process.cwd(),
              ".strategy-controls.json",
            );
            const controls = fs.existsSync(ctrlFile)
              ? JSON.parse(fs.readFileSync(ctrlFile, "utf-8"))
              : {
                  strategies: {
                    trailing_rebound: true,
                    smart_dca: true,
                    micro_grid: false,
                    cazador_weekend: true,
                  },
                  autoPilot: true,
                  approvalTimeoutSec: 180,
                };
            if (
              data.strategy &&
              controls.strategies[data.strategy] !== undefined
            ) {
              controls.strategies[data.strategy] =
                !controls.strategies[data.strategy];
              
              if (data.strategy === "futures") {
                try {
                  const futStateF = path.resolve(process.cwd(), ".futures-sim-state.json");
                  if (fs.existsSync(futStateF)) {
                    const futSt = JSON.parse(fs.readFileSync(futStateF, "utf-8"));
                    futSt.enabled = controls.strategies.futures;
                    fs.writeFileSync(futStateF, JSON.stringify(futSt, null, 2), "utf-8");
                  }
                } catch {}
              }
            } else if (data.autoPilot !== undefined) {
              controls.autoPilot = !!data.autoPilot;
            }
            controls.updatedAt = Date.now();
            fs.writeFileSync(
              ctrlFile,
              JSON.stringify(controls, null, 2),
              "utf-8",
            );
            res.writeHead(200, {
              "Content-Type": "application/json; charset=utf-8",
            });
            res.end(JSON.stringify({ success: true, controls }));
          } catch (e: any) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: e.message }));
          }
        });
        return;
      }

      if (
        parsedUrl.pathname === "/api/positions/lock-floor" &&
        req.method === "POST"
      ) {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          try {
            const data = JSON.parse(body || "{}");
            const actionFile = path.resolve(process.cwd(), ".opportunity-action.json");
            fs.writeFileSync(
              actionFile,
              JSON.stringify({ action: "lock_floor", symbol: data.symbol, pct: data.pct, time: Date.now() }, null, 2),
              "utf-8"
            );
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ success: true }));
          } catch (e: any) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: e.message }));
          }
        });
        return;
      }
      if (parsedUrl.pathname === "/api/wallet-split" && req.method === "GET") {
        try {
          const freeUsdt = (this.usdtFree ?? 0) + (this.usdtEarn ?? 0);
          const split = this.getWalletSplit(freeUsdt);
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(split));
        } catch (e: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }

      if (parsedUrl.pathname === "/api/wallet-split/transfer" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          try {
            const data = JSON.parse(body || "{}");
            const freeUsdt = (this.usdtFree ?? 0) + (this.usdtEarn ?? 0);
            const currentSplit = this.getWalletSplit(freeUsdt);
            const amt = Math.max(0, parseFloat(data.amount) || 0);

            let newManual = currentSplit.manualUsdt;
            if (data.direction === "bot_to_manual") {
              const maxFromBot = Math.max(0, freeUsdt - currentSplit.manualUsdt);
              const toMove = Math.min(amt, maxFromBot);
              newManual += toMove;
            } else if (data.direction === "manual_to_bot") {
              const toMove = Math.min(amt, currentSplit.manualUsdt);
              newManual -= toMove;
            }

            this.saveWalletSplit(newManual);
            const updated = this.getWalletSplit(freeUsdt);
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ success: true, walletSplit: updated }));
          } catch (e: any) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: e.message }));
          }
        });
        return;
      }

      if (parsedUrl.pathname === "/api/manual/buy" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          try {
            const data = JSON.parse(body || "{}");
            const sym = (data.symbol || "").trim().toUpperCase();
            const amount = parseFloat(data.usdtAmount);
            if (!sym || isNaN(amount) || amount < 10) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Monto inválido (mínimo 10 USDT) o símbolo requerido." }));
              return;
            }

            const actionFile = path.resolve(process.cwd(), ".position-action.json");
            fs.writeFileSync(
              actionFile,
              JSON.stringify({
                action: "manual_buy",
                symbol: sym,
                usdtAmount: amount,
                triggerGainPct: data.triggerGainPct || 0.8,
                callbackPct: data.callbackPct || 0.25,
                time: Date.now()
              }, null, 2),
              "utf-8"
            );

            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ success: true, message: "Orden de compra manual enviada al bot." }));
          } catch (e: any) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: e.message }));
          }
        });
        return;
      }

      if (
        parsedUrl.pathname === "/api/positions/manual-sell" &&
        req.method === "POST"
      ) {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          try {
            const data = JSON.parse(body || "{}");
            const actionFile = path.resolve(process.cwd(), ".position-action.json");
            fs.writeFileSync(
              actionFile,
              JSON.stringify({
                action: "manual_sell",
                id: data.id,
                allowLoss: data.allowLoss === true,
                time: Date.now()
              }, null, 2),
              "utf-8"
            );

            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ success: true, message: "Orden de venta manual enviada al bot." }));
          } catch (e: any) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: e.message }));
          }
        });
        return;
      }

      if (
        parsedUrl.pathname === "/api/positions/lock-profit" &&
        req.method === "POST"
      ) {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          try {
            const data = JSON.parse(body || "{}");
            const actionFile = path.resolve(process.cwd(), ".position-action.json");
            fs.writeFileSync(
              actionFile,
              JSON.stringify({ action: "lock_profit", id: data.id, targetGainPct: data.targetGainPct, time: Date.now() }, null, 2),
              "utf-8"
            );

            // Sincronizar de inmediato el archivo local de posiciones para que el frontend lo vea al instante
            const pFile = path.resolve(process.cwd(), ".trailing-positions.json");
            if (fs.existsSync(pFile)) {
              try {
                const list = JSON.parse(fs.readFileSync(pFile, "utf-8"));
                const map = new Map<string, any>(list);
                for (const [k, p] of map.entries()) {
                  if (k === data.id || p.lotId === data.id || p.symbol === data.id) {
                    p.activated = true;
                    p.lockedFloorGainPct = data.targetGainPct;
                    p.customMinGainPct = data.targetGainPct;
                    const floorPrice = p.buyPrice * (1 + data.targetGainPct / 100);
                    if ((p.highestPrice || 0) < floorPrice) p.highestPrice = floorPrice;
                  }
                }
                fs.writeFileSync(pFile, JSON.stringify(Array.from(map.entries()), null, 2), "utf-8");
              } catch(e) {}
            }

            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ success: true, message: "Candado de ganancia registrado" }));
          } catch (e: any) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: e.message }));
          }
        });
        return;
      }

      if (
        parsedUrl.pathname === "/api/opportunity/action" &&
        req.method === "POST"
      ) {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          try {
            const data = JSON.parse(body || "{}");
            const actionFile = path.resolve(
              process.cwd(),
              ".opportunity-action.json",
            );
            fs.writeFileSync(
              actionFile,
              JSON.stringify(
                { action: data.action, time: Date.now() },
                null,
                2,
              ),
              "utf-8",
            );
            res.writeHead(200, {
              "Content-Type": "application/json; charset=utf-8",
            });
            res.end(JSON.stringify({ success: true }));
          } catch (e: any) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: e.message }));
          }
        });
        return;
      }
      const rel =
        parsedUrl.pathname === "/"
          ? "index.html"
          : parsedUrl.pathname.replace(/^\/+/, "");
      const filePath = path.resolve(this.publicDir, rel);
      if (
        filePath.startsWith(this.publicDir) &&
        fs.existsSync(filePath) &&
        fs.statSync(filePath).isFile()
      ) {
        const mime: Record<string, string> = {
          ".html": "text/html; charset=utf-8",
          ".css": "text/css; charset=utf-8",
          ".js": "application/javascript; charset=utf-8",
          ".json": "application/json",
          ".svg": "image/svg+xml",
          ".png": "image/png",
        };
        res.writeHead(200, {
          "Content-Type":
            mime[path.extname(filePath).toLowerCase()] || "text/plain",
          "Cache-Control": "no-cache, no-store, must-revalidate",
          "Pragma": "no-cache",
          "Expires": "0"
        });
        fs.createReadStream(filePath).pipe(res);
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("404 Not Found");
    });

    this.server.on("error", (e: any) => {
      console.error(
        `⚠️ Dashboard no pudo iniciar en el puerto ${this.port}: ${e.message}`,
      );
    });

    this.server.listen(this.port, () => {
      console.log(
        `🌐 Dashboard web disponible en: http://localhost:${this.port}`,
      );
    });
    return this.server;
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.server?.close();
  }
}

if (process.env.DASHBOARD_STANDALONE === "1") {
  new DashboardServer().start();
}
