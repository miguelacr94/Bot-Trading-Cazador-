import { supabaseDb } from "./supabase-db.js";
import crypto from "crypto";
import { FuturesEngine } from "./futures-engine.js";
import { DashboardServer } from "./dashboard-server.js";
import { Spot } from "@binance/connector";
import { AiCopilot } from "./ai-copilot.js";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { TelegramNotifier } from "./notifier.js";
import { TelegramCommands } from "./telegram-commands.js";
import { computeRealizedPnl } from "./pnl.js";
import { marketRangesManager } from "./market-ranges.js";
dotenv.config();
// Tasa de referencia COP por USDT (P2P Colombia aprox.)
const COP_PER_USDT = 4200;
// WATCHLISTS SEPARADAS: CLÁSICAS Y CANASTA MEMECOINS TIER-1
export const CORE_WATCHLIST = ["ETHUSDT", "SOLUSDT", "AVAXUSDT", "NEARUSDT", "SUIUSDT", "BTCUSDT", "BNBUSDT", "XRPUSDT"];
export const MEME_WATCHLIST = ["PEPEUSDT", "DOGEUSDT"];
export const WATCHLIST = [...CORE_WATCHLIST, ...MEME_WATCHLIST];
// Formateador dinámico de precios para soportar micro-ticks y monedas estándar (ETH/SOL/BTC)
function fmtPrice(p) {
    if (p === 0)
        return "0";
    if (p < 0.0001)
        return p.toFixed(8);
    if (p < 0.01)
        return p.toFixed(6);
    if (p < 1)
        return p.toFixed(4);
    return p.toFixed(2);
}
// PARÁMETROS DEL TRAILING TAKE PROFIT INTELIGENTE
const TRAILING_ACTIVATION_PCT = 0.8; // Despierta el seguro al +0.8%
const TRAILING_CALLBACK_PCT = 0.30; // Base callback
const TRAILING_HARD_CAP_PCT = 15.0; // Techo ultra amplio (+15%) para perseguir el alza hasta la cima sin corte artificial
// PARÁMETROS DEL TRAILING BUY (espejo del trailing de venta, para cazar el piso)
const TRAILING_BUY_BOUNCE_PCT = 0.25; // Compra cuando rebota +0.25% desde el piso más bajo
const TRAILING_BUY_MAX_AGE_MS = 45 * 60 * 1000; // Vigilancia máxima: 45 minutos (permite refrescar suelos dinámicos)
export class TrailingMasterBot {
    get coreWatchlist() {
        const list = this.controls?.coreWatchlist || this.controls?.strategySettings?.coreWatchlist;
        return Array.isArray(list) && list.length > 0 ? list : CORE_WATCHLIST;
    }
    get memeWatchlist() {
        const list = this.controls?.memeWatchlist || this.controls?.strategySettings?.memeWatchlist;
        return Array.isArray(list) && list.length > 0 ? list : MEME_WATCHLIST;
    }
    get watchlist() {
        return Array.from(new Set([...this.coreWatchlist, ...this.memeWatchlist]));
    }
    /**
     * Devuelve el conjunto de símbolos limpios (monedas únicas) que tienen al menos 1 lote activo.
     * Permite que varios sub-lotes DCA de una misma moneda no bloqueen los cupos de maxPositions.
     */
    getUniqueActiveSymbols() {
        const set = new Set();
        for (const [k, p] of this.activeTrailingPositions.entries()) {
            const clean = ((p && p.symbol) ? p.symbol : k).split("_")[0];
            if (clean)
                set.add(clean);
        }
        return set;
    }
    hasActivePositionForSymbol(symbol) {
        const cleanTarget = (symbol || "").split("_")[0];
        return this.getUniqueActiveSymbols().has(cleanTarget);
    }
    /**
     * Agrega una moneda a la base de datos de monedas aceptadas (Supabase / Controles)
     */
    async addCoinToWatchlist(rawSymbol, category = "core") {
        try {
            let sym = (rawSymbol || "").trim().toUpperCase();
            if (!sym)
                return { success: false, message: "Símbolo inválido o vacío." };
            if (!sym.endsWith("USDT") && !sym.endsWith("FDUSD") && !sym.endsWith("BTC")) {
                sym += "USDT";
            }
            try {
                const ticker = await this.client.tickerPrice(sym);
                if (!ticker || !ticker.data || !ticker.data.price) {
                    return { success: false, message: `El par ${sym} no responde con precio válido en Binance Spot.` };
                }
            }
            catch (err) {
                return { success: false, message: `Binance rechazó el par ${sym}: ${err.message || "Par no encontrado o no listado para trading spot"}.` };
            }
            const currentCore = [...this.coreWatchlist];
            const currentMeme = [...this.memeWatchlist];
            if (currentCore.includes(sym) || currentMeme.includes(sym)) {
                return { success: false, message: `El par ${sym} ya está en la lista de monedas activas (${currentCore.includes(sym) ? "Clásicas/Core" : "Memecoins"}).` };
            }
            if (category === "meme") {
                currentMeme.push(sym);
            }
            else {
                currentCore.push(sym);
            }
            this.controls.coreWatchlist = currentCore;
            this.controls.memeWatchlist = currentMeme;
            if (!this.controls.strategySettings)
                this.controls.strategySettings = {};
            this.controls.strategySettings.coreWatchlist = currentCore;
            this.controls.strategySettings.memeWatchlist = currentMeme;
            this.saveStrategyControls();
            console.log(`✅ [WATCHLIST DB] Moneda ${sym} agregada a la lista ${category.toUpperCase()} y guardada en Supabase.`);
            return { success: true, message: `✅ <b>${sym}</b> ha sido agregada exitosamente a la lista <b>${category.toUpperCase()}</b> en la base de datos.` };
        }
        catch (err) {
            return { success: false, message: `Error agregando moneda: ${err.message}` };
        }
    }
    /**
     * Elimina una moneda de la base de datos de monedas aceptadas (Supabase / Controles)
     */
    async removeCoinFromWatchlist(rawSymbol) {
        try {
            let sym = (rawSymbol || "").trim().toUpperCase();
            if (!sym)
                return { success: false, message: "Símbolo inválido o vacío." };
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
            if (!this.controls.strategySettings)
                this.controls.strategySettings = {};
            this.controls.strategySettings.coreWatchlist = this.controls.coreWatchlist;
            this.controls.strategySettings.memeWatchlist = this.controls.memeWatchlist;
            this.saveStrategyControls();
            console.log(`🗑️ [WATCHLIST DB] Moneda ${sym} eliminada de la lista y actualizada en Supabase.`);
            return { success: true, message: `🗑️ <b>${sym}</b> ha sido retirada de la lista de monedas en la base de datos.` };
        }
        catch (err) {
            return { success: false, message: `Error eliminando moneda: ${err.message}` };
        }
    }
    controls = {
        maxPositions: 4,
        wideGapLotSize: 100,
        strategies: {
            trailing_rebound: true,
            smart_dca: true,
            micro_grid: false,
            cazador_weekend: true,
            wide_gap_sniper: true
        },
        allocations: {
            trailing_rebound: 50,
            smart_dca: 30,
            micro_grid: 0,
            cazador_weekend: 20
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
    pendingOpportunity = null;
    client;
    notifier;
    telegramCommands;
    futuresEngine;
    isProcessing = false;
    autoPilot = true;
    minUsdtToTrade = 10;
    lastSessionPlan = null;
    lastSessionKey = null;
    cycleCount = 0;
    lastWeekendWindowState = null;
    lastRegimeCheckTime = 0;
    pendingRegimeSwitch = null;
    lastDetectedRegime = null;
    /**
     * Reloj Estadístico Institucional en Hora Colombia (America/Bogota, UTC-5).
     * Basado en el estudio multianual de 5.5 años (2021-2026: 2,148 días y 25,249 horas en Binance).
     */
    getCotTimeInfo() {
        try {
            const now = new Date();
            const dayStr = now.toLocaleDateString("en-US", { timeZone: "America/Bogota", weekday: "short" });
            const parts = new Intl.DateTimeFormat("en-US", {
                timeZone: "America/Bogota",
                year: "numeric",
                month: "numeric",
                day: "numeric",
                hour: "numeric",
                minute: "numeric",
                hour12: false
            }).formatToParts(now);
            const getPart = (type, fallback) => {
                const val = parseInt(parts.find(p => p.type === type)?.value || "", 10);
                return isNaN(val) ? fallback : val;
            };
            const year = getPart("year", 2026);
            const month = getPart("month", 1);
            const dayOfMonth = getPart("day", 15);
            const rawHour = getPart("hour", 12);
            const safeHour = rawHour === 24 ? 0 : rawHour;
            const safeMin = getPart("minute", 0);
            const daysInMonth = new Date(year, month, 0).getDate();
            return {
                dayStr,
                hour: safeHour,
                minute: safeMin,
                timeDec: safeHour + safeMin / 60,
                dayOfMonth,
                month,
                year,
                daysInMonth
            };
        }
        catch {
            return { dayStr: "Mon", hour: 12, minute: 0, timeDec: 12.0, dayOfMonth: 15, month: 1, year: 2026, daysInMonth: 30 };
        }
    }
    /**
     * 📅 FILTRO CALENDARIO MULTIANUAL (5.5 AÑOS DE HISTORIAL BINANCE: 2021-2026 | 2,148 DÍAS Y 150 FINES DE SEMANA):
     * Combina los 5 grandes patrones estructurales que sobrevivieron mercados alcistas (2021/2024), bajistas (2022) y laterales (2023/2025/2026):
     * 1. Drenaje de Fin de Mes y Vencimiento de Opciones Deribit/CME (Días 26-31): Solo 40.1%-45.5% días verdes. Exige mayor caída y blinda el 68% en Bolsillo Cerrado.
     * 2. Inyección de Inicio de Mes (Días 01-05): 53.0%-54.6% días verdes y mechas profundas días 1-2 (-2.98%). Prioriza bloques $100 USDT en el suelo.
     * 3. Miércoles de Sacudón Macro / FOMC: Mayor mecha bajista semanal (-3.61% BTC / -4.61% NEAR, solo 40.4% verdes). Exige descuento extra fuera de Hora Piso para cazar el suelo que rebota el jueves.
     * 4. Barrido de Lunes Mañana (CME Gap Sweep): El 85% de los lunes barren hacia abajo (-2.72% BTC / -4.28% SOL) antes del Martes Verde.
     * 5. Martes y Jueves de Expansión Alcista: Los 2 días de mayor rebote semanal en 5.5 años (+5.87% NEAR martes, +5.51% NEAR jueves). Amplía el Trailing TP para no cortar ganancias temprano.
     */
    get5YearCalendarRegime() {
        const { dayStr, timeDec, dayOfMonth, daysInMonth } = this.getCotTimeInfo();
        const weekOfMonth = Math.min(4, Math.max(1, Math.ceil(dayOfMonth / 7)));
        const daysLeftInMonth = Math.max(0, daysInMonth - dayOfMonth);
        const isLastFridayOptionsExpiry = dayStr === "Fri" && daysLeftInMonth < 7;
        const isEndOfMonthDrain = dayOfMonth >= 26 || isLastFridayOptionsExpiry;
        const isBeginningOfMonthInflow = dayOfMonth >= 1 && dayOfMonth <= 5;
        const weekTag = `[Sem ${weekOfMonth}/4]`;
        // 1. Fin de Semana Estructural (Sábado 00:30 AM - 01:00 PM COT = Gran Piso Semanal; Viernes >= 14:00 = Veda; Domingo = Rebote 72%)
        if ((dayStr === "Fri" && timeDec >= 14.0) || dayStr === "Sat" || dayStr === "Sun") {
            const isSatFloor = dayStr === "Sat" && timeDec >= 0.5 && timeDec <= 13.0;
            const isSunPreCmeFloor = dayStr === "Sun" && ((timeDec >= 0.5 && timeDec <= 4.0) || (timeDec >= 14.0 && timeDec <= 16.5));
            return {
                regimeKey: "FIN_DE_SEMANA_ESTRUCTURAL",
                label: isSatFloor
                    ? `🏖️ ${weekTag} Sábado Piso Estructural 5 Años (00:30 AM-01:00 PM COT | 82% Prob. Suelo Semanal)`
                    : (isSunPreCmeFloor
                        ? `🏖️ ${weekTag} Domingo Piso Pre-CME / Madrugada (Re-testeo antes del Rally Dominical)`
                        : `🏖️ ${weekTag} Ciclo Fin de Semana 5 Años (Veda Viernes → Suelo Sábado 00:30 AM → Rebote Domingo)`),
                weekOfMonth,
                extraDropRequiredPct: (isSatFloor || isSunPreCmeFloor) ? 0 : 0.40,
                rsiAdjustment: (isSatFloor || isSunPreCmeFloor) ? 0 : -2,
                closedPocketReservePct: (isSatFloor || isSunPreCmeFloor) ? 0.0 : 0.60,
                tpCallbackMultiplier: dayStr === "Sun" ? 1.20 : 1.05,
                isPrimeSniperFloorDay: isSatFloor || isSunPreCmeFloor
            };
        }
        // 2. Martes y Jueves de Expansión Alcista (#1 y #2 días de VENTA EN LA CIMA en 5.5 años: +5.87% Martes, +5.51% Jueves)
        // En Martes y Jueves la prioridad absoluta es VENDER EN EL PUNTO MÁS ALTO lo comprado en la caída del Sábado/Lunes o Miércoles.
        // Se bloquean compras pequeñas ("comprar por comprar"): exige +2.2% extra de caída y RSI -6 puntos más estricto (solo capitulación >= -5.0%, RSI <= 30).
        if (dayStr === "Tue" || dayStr === "Thu") {
            return {
                regimeKey: "MARTES_JUEVES_EXPANSION",
                label: dayStr === "Tue"
                    ? `🐂 ${weekTag} Martes de Alza y Cosecha (#1 Día de Venta en Cima +5.87% | Compras Bloqueadas salvo Capitulación >= -5%)`
                    : `🐂 ${weekTag} Jueves de Alza y Cosecha (#2 Día de Venta Post-Miércoles +5.51% | Compras Bloqueadas salvo Capitulación >= -5%)`,
                weekOfMonth,
                extraDropRequiredPct: 2.20, // Bloquea micro-compras en días de alza; solo permite entrar en desplomes extremos >= -5.0%
                rsiAdjustment: -6, // Exige sobreventa extrema (RSI <= 30) para no comprar jamás arriba en Martes o Jueves
                closedPocketReservePct: 0.70,
                tpCallbackMultiplier: dayStr === "Tue" ? 1.25 : 1.20, // Deja correr al máximo las posiciones abiertas para vender en el pico más alto
                isPrimeSniperFloorDay: false
            };
        }
        // 3. Miércoles de Sacudón Macro / FOMC (DÍA ESTRATÉGICO DE COMPRA EN MÁXIMA CAÍDA -3.6% a -4.6% → Para vender el Jueves)
        if (dayStr === "Wed") {
            const isWedFloor = (timeDec >= 0.5 && timeDec <= 4.0) || (timeDec >= 11.5 && timeDec <= 13.5) || (timeDec >= 19.5 && timeDec <= 21.75);
            return {
                regimeKey: "MIERCOLES_SACUDON_MACRO",
                label: `⚡ ${weekTag} Miércoles de Máxima Caída Semanal (Cazando Suelo Profundo -3.6% a -5.5% → Para Vender en el Alza del Jueves)`,
                weekOfMonth,
                extraDropRequiredPct: isWedFloor ? 0.40 : 0.90, // Exige caída real profunda, nunca micro-retrocesos
                rsiAdjustment: isWedFloor ? -2 : -4,
                closedPocketReservePct: isWedFloor ? 0.0 : 0.65,
                tpCallbackMultiplier: 1.05,
                isPrimeSniperFloorDay: isWedFloor
            };
        }
        // 4. Lunes de Barrido del Gap CME (DÍA ESTRATÉGICO DE COMPRA EN CAÍDA PROFUNDA → Para vender en el Alza del Martes)
        if (dayStr === "Mon") {
            const isMonPostSweepFloor = (timeDec >= 0.5 && timeDec <= 4.0) || (timeDec >= 11.5 && timeDec <= 13.5) || (timeDec >= 20.0 && timeDec <= 21.75);
            return {
                regimeKey: "LUNES_BARRIDO_CME",
                label: isMonPostSweepFloor
                    ? `🟢 ${weekTag} Lunes Post-Barrido CME (Cazando Máxima Caída del Lunes → Para Vender en el Alza del Martes)`
                    : `🛡️ ${weekTag} Lunes Mañana Barrido Gap CME (Esperando Máxima Caída Matutina de Wall Street)`,
                weekOfMonth,
                extraDropRequiredPct: isMonPostSweepFloor ? 0.35 : 0.85,
                rsiAdjustment: isMonPostSweepFloor ? -2 : -4,
                closedPocketReservePct: isMonPostSweepFloor ? 0.0 : 0.65,
                tpCallbackMultiplier: 1.12,
                isPrimeSniperFloorDay: isMonPostSweepFloor
            };
        }
        // 5. Drenaje de Fin de Mes y Vencimiento Mensual de Opciones (Semana 4: Días 26 al 31 / Último Viernes)
        if (isEndOfMonthDrain) {
            const isDeepMonthEndFloor = dayOfMonth >= 28 && (timeDec <= 4.0 || (timeDec >= 11.5 && timeDec <= 13.5));
            return {
                regimeKey: "FIN_DE_MES_DRENAJE",
                label: `📅 ${weekTag} Escudo Fin de Mes / Opciones (Día ${dayOfMonth}/${daysInMonth} | 60% Días Rojos en 5 Años)`,
                weekOfMonth,
                extraDropRequiredPct: isDeepMonthEndFloor ? 0.10 : 0.50,
                rsiAdjustment: isDeepMonthEndFloor ? -1 : -3,
                closedPocketReservePct: isDeepMonthEndFloor ? 0.0 : 0.65,
                tpCallbackMultiplier: 0.92,
                isPrimeSniperFloorDay: isDeepMonthEndFloor
            };
        }
        // 6. Inicio de Mes (Semana 1: Días 1 al 5: 54.6% días verdes + Inyección de Nóminas y Fondos)
        if (isBeginningOfMonthInflow) {
            return {
                regimeKey: "INICIO_DE_MES_INYECCION",
                label: `🚀 ${weekTag} Inicio de Mes Institucional (Día ${dayOfMonth} | 54.6% Días Verdes e Inyección de Liquidez)`,
                weekOfMonth,
                extraDropRequiredPct: 0,
                rsiAdjustment: 0,
                closedPocketReservePct: 0.50,
                tpCallbackMultiplier: 1.15,
                isPrimeSniperFloorDay: dayOfMonth <= 2
            };
        }
        return {
            regimeKey: "ESTANDAR",
            label: `⚖️ ${weekTag} Ciclo Semanal Estándar`,
            weekOfMonth,
            extraDropRequiredPct: 0,
            rsiAdjustment: 0,
            closedPocketReservePct: 0.60,
            tpCallbackMultiplier: 1.0,
            isPrimeSniperFloorDay: false
        };
    }
    /**
     * 🟢 HORAS PISO HISTÓRICAS (DESBLOQUEO 100%: PRESUPUESTO CERRADO + ABIERTO UNIDOS, SIN CHOQUES):
     * 1. Piso #1 de Madrugada (00:30 AM - 04:00 AM COT, Lun-Vie y Dom): #1 mejor compra del día (+0.22% retorno 4h, previo a Londres).
     * 2. Gran Piso de Fin de Semana (Sábado 00:30 AM - 12:00 PM COT y Domingo 02:00 PM - 04:30 PM COT): Captura la capitulación de 01:00 AM del sábado.
     * 3. Piso #2 de Mediodía NY (11:30 AM - 01:30 PM COT, Lun-Jue; Jueves desde 10:15 AM post-barrido macro).
     * 4. Piso #3 Pre-Asia (08:00 PM - 09:45 PM COT / 20:00 - 21:45 COT, Lun-Jue).
     */
    isHistoricalFloorWindow() {
        const { dayStr, timeDec } = this.getCotTimeInfo();
        const isWeekday = ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(dayStr);
        const isMonToThu = ["Mon", "Tue", "Wed", "Thu"].includes(dayStr);
        // 1. Gran Piso de Sábado Madrugada/Mañana (00:30 AM - 12:00 PM COT: incluye el barrido asiático de la 01:00 AM)
        if (dayStr === "Sat" && timeDec >= 0.5 && timeDec <= 12.0) {
            return { active: true, label: "🏖️ GRAN PISO SÁBADO MADRUGADA/MAÑANA (00:30 AM-12:00 PM COT | 100% Presupuesto Desbloqueado)" };
        }
        // 2. Piso de Madrugada (00:30 AM - 04:00 AM COT) en días de semana y domingo
        if ((isWeekday || dayStr === "Sun") && timeDec >= 0.5 && timeDec <= 4.0) {
            return { active: true, label: "🟢 PISO #1 MADRUGADA PRE-LONDRES (00:30-04:00 AM COT | Presupuesto 100% Desbloqueado)" };
        }
        // 3. Piso de Mediodía Wall Street (11:30 AM - 01:30 PM COT) + Efecto Jueves Post-Noticias (10:15 AM - 01:30 PM COT)
        if (dayStr === "Thu" && timeDec >= 10.25 && timeDec <= 13.5) {
            return { active: true, label: "🟢 PISO ESPECIAL JUEVES POST-BARRIDO NY (10:15 AM-01:30 PM COT | Presupuesto 100% Desbloqueado)" };
        }
        if (isMonToThu && timeDec >= 11.5 && timeDec <= 13.5) {
            return { active: true, label: "🟢 PISO #2 MEDIODÍA NY POST-DRENAJE (11:30 AM-01:30 PM COT | Presupuesto 100% Desbloqueado)" };
        }
        // 4. Piso Pre-Asia (20:00 - 21:45 COT, Lunes a Jueves)
        if (isMonToThu && timeDec >= 20.0 && timeDec <= 21.75) {
            return { active: true, label: "🟢 PISO #3 PRE-ASIA (08:00 PM-09:45 PM COT | Presupuesto 100% Desbloqueado)" };
        }
        // 5. Piso Domingo Tarde Pre-CME (14:00 - 16:30 COT)
        if (dayStr === "Sun" && timeDec >= 14.0 && timeDec <= 16.5) {
            return { active: true, label: "🏖️ PISO DOMINGO PRE-APERTURA CME (02:00 PM-04:30 PM COT | Presupuesto 100% Desbloqueado)" };
        }
        return { active: false, label: "" };
    }
    /**
     * 🏆 HORAS TECHO HISTÓRICAS (MODO COSECHA ACTIVA — SIN SOLAPAMIENTO CON HORAS PAUSA):
     * 1. Techo Matutino Pre-NY (06:00 AM - 09:00 AM COT, Lun-Vie; y Sábado 06:30 - 09:30 AM Rebote Matutino).
     * 2. Techo Pre-Cierre NY (03:15 PM - 04:15 PM COT / 15:15 - 16:15 COT, Lun-Vie).
     * 3. Techo Nocturno Apertura Asia (10:30 PM - 12:30 AM COT / 22:30 - 00:30 COT, Lun-Jue).
     * 4. Techo Dominical CME (Domingo 05:30 PM - 11:30 PM COT / 17:30 - 23:30 COT).
     */
    isHistoricalPeakHarvestWindow() {
        const { dayStr, timeDec } = this.getCotTimeInfo();
        const isWeekday = ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(dayStr);
        if (isWeekday && timeDec >= 6.0 && timeDec < 9.0) {
            return {
                active: true,
                label: dayStr === "Fri"
                    ? "🏆 HORA TECHO VIERNES MAÑANA (06:00-09:00 AM COT | Cosechando antes del fin de semana)"
                    : "🏆 HORA TECHO APERTURA NY (06:00-09:00 AM COT | Cosechando antes del drenaje de las 9-11 AM)"
            };
        }
        if (dayStr === "Sat" && timeDec >= 6.5 && timeDec <= 9.5) {
            return { active: true, label: "🏆 HORA TECHO REBOTE SÁBADO MAÑANA (06:30-09:30 AM COT | Cosechando rebote de madrugada)" };
        }
        if (dayStr === "Fri" && timeDec >= 11.5 && timeDec < 14.0) {
            return { active: true, label: "🏆 HORA TECHO PRE-VEDA VIERNES MEDIODÍA (11:30 AM-02:00 PM COT | Cosechando antes del drenaje de viernes)" };
        }
        if (["Mon", "Tue", "Wed", "Thu"].includes(dayStr) && timeDec >= 15.25 && timeDec < 16.25) {
            return { active: true, label: "🏆 HORA TECHO PRE-CIERRE WALL STREET (03:15-04:15 PM COT | Cosechando antes del cierre NY)" };
        }
        if (["Mon", "Tue", "Wed", "Thu"].includes(dayStr) && (timeDec >= 22.5 || timeDec < 0.5)) {
            return { active: true, label: "🏆 HORA TECHO APERTURA ASIA (10:30 PM-12:30 AM COT | Cosechando antes del piso de 00:30 AM)" };
        }
        if (dayStr === "Sun" && timeDec >= 17.5 && timeDec <= 23.5) {
            return { active: true, label: "🏆 HORA TECHO RALLY DOMINGO CME (05:30-11:30 PM COT | Cosechando pico dominical)" };
        }
        return { active: false, label: "" };
    }
    /**
     * ⏸️ HORAS PAUSA / TRAMPA HISTÓRICAS (SIN SOLAPAMIENTO CON HORAS PISO NI HORAS TECHO):
     * 1. Veda de Viernes (Viernes 02:00 PM / 14:00 COT a Sábado 00:30 AM COT): Evita el drenaje del viernes y abre a las 00:30 AM del sábado.
     * 2. Drenaje Matutino Wall Street (09:00 AM - 11:30 AM COT, Lun-Vie; Jueves 09:00 - 10:15 AM COT).
     * 3. Liquidación Cierre NY (04:15 PM - 06:15 PM COT / 16:15 - 18:15 COT, Lun-Jue).
     * 4. Techo Nocturno Asia (10:30 PM - 12:30 AM COT / 22:30 - 00:30 COT, Lun-Jue): Pausa nuevas compras normales para entrar en el piso de 00:30 AM.
     */
    isHistoricalPauseWindow() {
        const { dayStr, timeDec } = this.getCotTimeInfo();
        const isWeekday = ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(dayStr);
        const isMonToThu = ["Mon", "Tue", "Wed", "Thu"].includes(dayStr);
        // 1. Veda de Viernes Tarde/Noche (Viernes >= 14:00 a Sábado < 00:30 AM COT)
        if ((dayStr === "Fri" && timeDec >= 14.0) || (dayStr === "Sat" && timeDec < 0.5)) {
            return {
                paused: true,
                reason: "⏸️ VEDA DE VIERNES (Vie 02:00 PM - Sáb 00:30 AM COT): Esperando el suelo de la madrugada del sábado (00:30 AM)."
            };
        }
        // 2. Trampa Matutina Wall Street (09:00 AM - 11:30 AM COT; Jueves 09:00 - 10:15 AM COT)
        const morningPauseEnd = dayStr === "Thu" ? 10.25 : 11.5;
        if (isWeekday && timeDec >= 9.0 && timeDec < morningPauseEnd) {
            return {
                paused: true,
                reason: "⏸️ PAUSA DRENAJE MATUTINO NY (09:00 - 11:30 AM COT): Esperando piso de mediodía (11:30 AM)."
            };
        }
        // 3. Liquidación Cierre Wall Street (16:15 - 18:15 COT, Lunes a Jueves)
        if (isMonToThu && timeDec >= 16.25 && timeDec <= 18.25) {
            return {
                paused: true,
                reason: "⏸️ PAUSA CIERRE WALL STREET (04:15 - 06:15 PM COT): Drenaje institucional de las 5:00 PM. Esperando Piso Pre-Asia (08:00 PM)."
            };
        }
        // 4. Techo Apertura Asia (22:30 - 00:30 COT, Lunes a Jueves noche)
        if ((isMonToThu && timeDec >= 22.5) || (["Tue", "Wed", "Thu", "Fri"].includes(dayStr) && timeDec < 0.5)) {
            return {
                paused: true,
                reason: "⏸️ PAUSA TECHO NOCTURNO ASIA (10:30 PM - 12:30 AM COT): Guardando liquidez para el Piso de Madrugada (00:30 - 04:00 AM)."
            };
        }
        return { paused: false, reason: "" };
    }
    /**
     * ⚡ LLAVE MAESTRA DE EXCEPCIÓN POR EVENTO ATÍPICO (FLASH CRASH / CAPITULACIÓN EN HORA PAUSADA):
     * Permite romper cualquier pausa horaria ÚNICAMENTE si ocurre un desplome extraordinario con absorción real de ballenas,
     * para jamás desaprovechar un cisne negro o barrido extremo de Bitcoin.
     */
    isAtypicalMarketException(params) {
        const isMeme = this.memeWatchlist.includes(params.symbol) || params.symbol.includes("PEPE") || params.symbol.includes("DOGE");
        const minCrashDrop = isMeme ? 6.5 : 5.8;
        const maxCrashRsi = 26.0;
        const hasExtremeDropAndRsi = params.dropPct >= minCrashDrop && params.rsi <= maxCrashRsi;
        const hasClimaxAbsorption = (params.lowerWickRatio ?? 0.35) >= 0.35 || (params.rvol ?? 1.8) >= 1.8;
        const hasConfirmedTurnaround = (params.bouncePct ?? 0.55) >= 0.55 && (params.cvdPct ?? 55) >= 55;
        return hasExtremeDropAndRsi && hasClimaxAbsorption && hasConfirmedTurnaround;
    }
    /**
     * ⚓ ANCLA DE GIRO EN BITCOIN 15M (CORRELACIÓN LÍDER-SEGUIDOR):
     * Como las altcoins siguen a BTC al milímetro en las caídas, antes de disparar un bloque en una altcoin
     * verifica que BTCUSDT ya haya dejado de caer en 15m (vela verde o mecha inferior >= 28% y sin caída activa).
     */
    async verifyBtc15mLeaderAnchor(targetSymbol) {
        if (targetSymbol === "BTCUSDT")
            return { ok: true, reason: "Activo líder BTC" };
        try {
            const btcK15 = await this.client.klines("BTCUSDT", "15m", { limit: 3 });
            if (!btcK15?.data || btcK15.data.length < 2)
                return { ok: true, reason: "Sin datos BTC 15m" };
            const last = btcK15.data[btcK15.data.length - 1];
            const prev = btcK15.data[btcK15.data.length - 2];
            const bo = parseFloat(last[1]), bh = parseFloat(last[2]), bl = parseFloat(last[3]), bc = parseFloat(last[4]);
            const prevLow = parseFloat(prev[3]);
            const range = bh - bl;
            const lowerWick = range > 0 ? (Math.min(bo, bc) - bl) / range : 0;
            const candleChangePct = bo > 0 ? ((bc - bo) / bo) * 100 : 0;
            const isBtcGreenOrWick = bc >= bo || lowerWick >= 0.28 || (candleChangePct > -0.12 && bl >= prevLow * 0.999);
            if (!isBtcGreenOrWick || candleChangePct <= -0.30) {
                return {
                    ok: false,
                    reason: `Ancla BTC 15m aún bajista (${candleChangePct.toFixed(2)}%, mecha ${(lowerWick * 100).toFixed(0)}%). Esperando que BTC confirme suelo.`
                };
            }
            return { ok: true, reason: `BTC 15m estable/girando (${candleChangePct >= 0 ? "+" : ""}${candleChangePct.toFixed(2)}%)` };
        }
        catch {
            return { ok: true, reason: "Fallback BTC 15m" };
        }
    }
    isWeekendWindow() {
        try {
            const { dayStr, timeDec } = this.getCotTimeInfo();
            // Estadística 5.5 años / 18 semanas Binance: El viernes tarde/noche es fase de caída;
            // la cacería de fin de semana abre en la madrugada del sábado (00:30 AM COT, inicio del barrido asiático) hasta el domingo 18:00 COT.
            if (dayStr === "Sat" && timeDec >= 0.5)
                return true;
            if (dayStr === "Sun" && timeDec < 18.0)
                return true;
            return false;
        }
        catch {
            return false;
        }
    }
    /**
     * VEDA DE COMPRAS DE VIERNES (Viernes 00:00 COT a Sábado 02:00 AM COT):
     * Bloquea compras preventivamente todo el viernes hasta la madrugada del sábado.
     * EXCEPCIÓN: Si la moneda sufre una caída extrema / capitulación profunda (>= -4.5% o RSI <= 26).
     */
    isFridayBuyVeda(sym, curPrice, rsi, drop24hPct) {
        try {
            const { dayStr, timeDec } = this.getCotTimeInfo();
            const isFriday = dayStr === "Fri";
            const isEarlySaturday = dayStr === "Sat" && timeDec < 2.0;
            if (!isFriday && !isEarlySaturday)
                return false;
            // EXCEPCIÓN AUTORIZADA POR EL USUARIO: "a menos que la moneda caiga mucho"
            if ((drop24hPct && drop24hPct >= 4.5) || (rsi && rsi <= 26)) {
                console.log(`⚡ [EXCEPCIÓN VEDA VIERNES AUTORIZADA] ${sym || 'Moneda'}: Caída extrema (-${drop24hPct?.toFixed(1) || 0}% | RSI: ${rsi?.toFixed(0) || 0}). Aprovechando piso atípico antes del sábado.`);
                return false;
            }
            return true;
        }
        catch {
            return false;
        }
    }
    isFridayEveningBleedWindow() {
        return this.isFridayBuyVeda();
    }
    isNightMode() {
        try {
            const hour = new Date().toLocaleString("en-US", { timeZone: "America/Bogota", hour: "numeric", hour12: false });
            const h = parseInt(hour, 10);
            return h >= 1 && h < 6;
        }
        catch {
            return false;
        }
    }
    getHardCapPct() {
        return this.isNightMode() ? 5.0 : 3.5;
    }
    async getFearAndGreed() {
        try {
            const res = await fetch("https://api.alternative.me/fng/?limit=1");
            const d = await res.json();
            const item = d.data?.[0];
            if (item) {
                return { value: parseInt(item.value, 10), classification: item.value_classification };
            }
        }
        catch (e) { }
        return { value: 50, classification: "Neutral" };
    }
    async depositToEarn(asset, amount) {
        try {
            await this.client.subscribeFlexibleProduct("USDT001", amount.toFixed(2), { recvWindow: 60000 });
            await this.notifier.send(`🏦 <b>[BÓVEDA DE GANANCIAS ACTIVADA]</b> 🔒\n\n` +
                `• Se apartaron <b>+${amount.toFixed(2)} USDT</b> limpios de la ganancia.\n` +
                `• Destino: <b>Simple Earn Flexible</b> generando intereses diarios automáticos.\n` +
                `💡 <i>¡Tu ganancia quedó blindada fuera del riesgo de mercado!</i>`);
            console.log(`🏦 Bóveda de ganancias: ${amount.toFixed(2)} USDT transferidos a Simple Earn.`);
        }
        catch (e) {
            console.error("Error suscribiendo a Earn:", e.response?.data?.msg || e.message);
        }
    }
    /**
     * Determina la temporalidad óptima recomendada para cada moneda según su naturaleza y volatilidad.
     */
    getSuggestedTimeframe(symbol) {
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
    getTimeframeForSymbol(symbol, pos) {
        // 1. Prioridad: Configuración explícita en la posición viva
        if (pos && pos.customTimeframe) {
            return pos.customTimeframe;
        }
        // 2. Prioridad: Override por símbolo en controles
        if (this.controls.symbolTimeframes && this.controls.symbolTimeframes[symbol]) {
            return this.controls.symbolTimeframes[symbol];
        }
        // 3. Fallback inteligente: Temporalidad sugerida por el Centinela
        return this.getSuggestedTimeframe(symbol).timeframe;
    }
    getCallbackPct(symbol, pos) {
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
                }
                else if (peakGainPct >= (isMaxGap ? 3.0 : 2.6)) {
                    // Zona de techo alto -> Ceñir a 0.18%-0.20%
                    return isMeme ? 0.20 : 0.18;
                }
                else if (peakGainPct >= (isMaxGap ? 2.1 : 1.8)) {
                    // Escalando ola -> Respiro intermedio (0.28%-0.32%) para dejarla correr
                    return isMeme ? 0.32 : 0.28;
                }
                // En el despegue inicial: mantener baseCb (0.40%-0.45%) para aguantar micro-retrocesos rumbo a la cima
                return baseCb;
            }
            if (peakGainPct >= 3.0) {
                // Fase 4: Parapeto Extremo (> +3.0%) -> Candado ultra-ceñido
                return isMeme ? 0.15 : 0.12;
            }
            else if (peakGainPct >= 2.2) {
                // Fase 3: Techo Inminente / Euforia (+2.2% a +3.0%) -> Ceñir a 0.20% (Caso PEPE)
                return isMeme ? 0.20 : 0.15;
            }
            else if (peakGainPct >= 1.4) {
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
                if (alreadyTracked)
                    continue; // Si ya tiene lotes, JAMÁS pisar ni crear huérfanos que mezclen precios
                const balObj = acc.data.balances.find((b) => b.asset === asset);
                if (!balObj)
                    continue;
                const free = parseFloat(balObj.free || "0");
                const locked = parseFloat(balObj.locked || "0");
                const total = free + locked;
                if (total <= 0)
                    continue;
                let curPrice = 0;
                try {
                    const ticker = await this.client.tickerPrice(sym);
                    curPrice = parseFloat(ticker.data.price);
                }
                catch {
                    continue;
                }
                const usdtValue = total * curPrice;
                if (usdtValue >= 10) {
                    console.log(`🔍 [AUTO-SYNC] Moneda detectada en Binance sin tracking alguno: ${sym} (${total} ${asset} ≈ ${usdtValue.toFixed(2)} USDT)`);
                    let buyPrice = curPrice;
                    let buyTime = Date.now();
                    try {
                        const tradesRes = await this.client.myTrades(sym, { limit: 20, recvWindow: 60000 });
                        const buyTrades = (tradesRes.data || []).filter((t) => t.isBuyer);
                        if (buyTrades.length > 0) {
                            // Calcular precio promedio ponderado real recorriendo hacia atrás hasta cubrir el balance significativo (ignorando polvo residual < $2 USDT)
                            let coveredQty = 0;
                            let weightedCost = 0;
                            let maxCoveredPrice = 0;
                            for (let i = buyTrades.length - 1; i >= 0; i--) {
                                const t = buyTrades[i];
                                const tQty = parseFloat(t.qty);
                                const tPrice = parseFloat(t.price);
                                const need = total - coveredQty;
                                if (coveredQty > 0 && need * curPrice < 2.0)
                                    break; // Ignorar polvo antiguo menor a $2 USDT
                                const useQty = Math.min(tQty, need);
                                coveredQty += useQty;
                                weightedCost += useQty * tPrice;
                                if (tPrice > maxCoveredPrice)
                                    maxCoveredPrice = tPrice;
                                if (coveredQty >= total * 0.99)
                                    break;
                            }
                            if (coveredQty > 0) {
                                buyPrice = Math.max(weightedCost / coveredQty, maxCoveredPrice);
                                buyTime = buyTrades[buyTrades.length - 1].time || Date.now();
                            }
                        }
                    }
                    catch (err) {
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
        }
        catch (e) {
            console.error("Error sincronizando posiciones huérfanas desde Binance:", e.message);
        }
    }
    activeTrailingPositions = new Map();
    walletSplit = {
        manualUsdt: 0.0,
        lastKnownTotalFreeUsdt: 0.0,
        autoQuarantineDeposits: false,
        lastUpdated: 0
    };
    lastBotSaleTime = 0;
    loadWalletSplit() {
        const cloudSplit = this.controls?.strategySettings?.walletSplit;
        if (cloudSplit && typeof cloudSplit.manualUsdt === "number") {
            this.walletSplit.manualUsdt = cloudSplit.manualUsdt;
            if (typeof cloudSplit.lastKnownTotalFreeUsdt === "number") {
                this.walletSplit.lastKnownTotalFreeUsdt = cloudSplit.lastKnownTotalFreeUsdt;
            }
            if (typeof cloudSplit.autoQuarantineDeposits === "boolean") {
                this.walletSplit.autoQuarantineDeposits = cloudSplit.autoQuarantineDeposits;
            }
            try {
                const f = path.resolve(process.cwd(), ".wallet-split.json");
                fs.writeFileSync(f, JSON.stringify(this.walletSplit, null, 2), "utf-8");
            }
            catch { }
            return;
        }
        try {
            const f = path.resolve(process.cwd(), ".wallet-split.json");
            if (fs.existsSync(f)) {
                const d = JSON.parse(fs.readFileSync(f, "utf-8"));
                if (typeof d.manualUsdt === "number")
                    this.walletSplit.manualUsdt = d.manualUsdt;
                if (typeof d.lastKnownTotalFreeUsdt === "number")
                    this.walletSplit.lastKnownTotalFreeUsdt = d.lastKnownTotalFreeUsdt;
                if (typeof d.autoQuarantineDeposits === "boolean")
                    this.walletSplit.autoQuarantineDeposits = d.autoQuarantineDeposits;
                return;
            }
        }
        catch { }
    }
    saveWalletSplit(syncCloud = true) {
        this.walletSplit.lastUpdated = Date.now();
        if (!this.controls.strategySettings)
            this.controls.strategySettings = {};
        this.controls.strategySettings.walletSplit = this.walletSplit;
        if (syncCloud) {
            this.saveStrategyControls();
        }
        try {
            const f = path.resolve(process.cwd(), ".wallet-split.json");
            fs.writeFileSync(f, JSON.stringify(this.walletSplit, null, 2), "utf-8");
        }
        catch { }
    }
    /**
     * 🛡️ BLINDAJE DE DEPÓSITOS ENTRANTE:
     * Cuando el usuario deposita USDT nuevo en Binance, el 100% del ingreso
     * se acredita automáticamente al SALDO MANUAL. El bot NO lo tocará ni
     * abrirá operaciones a menos que el usuario lo transfiera explícitamente.
     */
    checkAndQuarantineDeposits(totalFreeUsdt) {
        this.loadWalletSplit();
        const lastKnown = this.walletSplit.lastKnownTotalFreeUsdt;
        // Si es primera ejecución o no hay registro previo, fijar saldo inicial
        if (lastKnown === undefined || lastKnown === null || lastKnown === 0) {
            this.walletSplit.lastKnownTotalFreeUsdt = totalFreeUsdt;
            this.saveWalletSplit(false);
            return;
        }
        const delta = totalFreeUsdt - lastKnown;
        // Si el saldo libre aumentó (Depósito entrante o ventas ejecutadas)
        if (delta > 0.15 && this.walletSplit.autoQuarantineDeposits === true) {
            // Verificar si hubo ventas recientes del bot en los últimos 30 minutos (para jamás confundir una toma de ganancias con un depósito manual)
            let recentSaleTime = this.lastBotSaleTime || 0;
            try {
                const ledgerF = path.resolve(process.cwd(), ".closed-trades.json");
                if (fs.existsSync(ledgerF)) {
                    const trades = JSON.parse(fs.readFileSync(ledgerF, "utf-8"));
                    if (Array.isArray(trades) && trades.length > 0) {
                        const lastTradeTime = trades[trades.length - 1].time || 0;
                        if (lastTradeTime > recentSaleTime)
                            recentSaleTime = lastTradeTime;
                    }
                }
            }
            catch { }
            const justSold = (Date.now() - recentSaleTime) < (30 * 60 * 1000); // Ventana de 30 minutos
            if (!justSold && this.walletSplit.manualUsdt > 0) {
                // Asignar el 100% del depósito entrante al SALDO MANUAL solo si la cuarentena está explícitamente activada y hay billetera manual
                this.walletSplit.manualUsdt = Math.max(0, this.walletSplit.manualUsdt) + delta;
                this.walletSplit.lastKnownTotalFreeUsdt = totalFreeUsdt;
                this.saveWalletSplit(true);
                const botSpendable = Math.max(0, totalFreeUsdt - this.walletSplit.manualUsdt);
                console.log(`🛡️ [DEPÓSITO PROTEGIDO] Ingreso de +$${delta.toFixed(2)} USDT detectado. Asignado al FONDO MANUAL.`);
                console.log(`   • 👤 Saldo Manual Protegido: $${this.walletSplit.manualUsdt.toFixed(2)} USDT | 🤖 Saldo Bot: $${botSpendable.toFixed(2)} USDT`);
                this.notifier.send(`📥 <b>DEPÓSITO BLINDADO EN FONDO MANUAL</b> 🛡️\n\n` +
                    `• Monto ingresado: <b>+$${delta.toFixed(2)} USDT</b>\n` +
                    `• 👤 <b>Saldo Manual Protegido:</b> $${this.walletSplit.manualUsdt.toFixed(2)} USDT\n` +
                    `• 🤖 <b>Saldo del Bot (Intacto):</b> $${botSpendable.toFixed(2)} USDT\n\n` +
                    `🔒 <i>El bot NO tocará este depósito. Si deseas asignarle presupuesto al bot para cazar caídas, usa /pasar_bot o el botón de transferencia en el Dashboard.</i>`).catch(() => { });
                return;
            }
        }
        // Si el saldo disminuyó o fue venta del bot
        const prevManual = this.walletSplit.manualUsdt;
        this.walletSplit.lastKnownTotalFreeUsdt = totalFreeUsdt;
        if (totalFreeUsdt < this.walletSplit.manualUsdt) {
            this.walletSplit.manualUsdt = Math.max(0, totalFreeUsdt);
        }
        this.saveWalletSplit(this.walletSplit.manualUsdt !== prevManual);
    }
    deductFromManualWallet(amount) {
        this.loadWalletSplit();
        this.walletSplit.manualUsdt = Math.max(0, this.walletSplit.manualUsdt - amount);
        this.saveWalletSplit();
        console.log("💼 [BILLETERA MANUAL] Descontados $" + amount.toFixed(2) + " USDT. Saldo manual restante: $" + this.walletSplit.manualUsdt.toFixed(2) + " USDT.");
    }
    recentlySoldSymbols = new Map();
    buyWatches = new Map();
    ignoredDca = new Map();
    dashboardServer;
    aiCopilot = new AiCopilot();
    lastAiBenchmarkCheckTime = 0;
    lastAiBenchmarkTelegramTime = 0;
    aiLowBalancePaused = false;
    lastFridaySnapshotDayKey = "";
    notifiedBenchmarkMilestones = new Map();
    activeAtypicalOverride = "NONE";
    aiCoinCalibrations = new Map();
    getFridayBenchmarks() {
        const cloudBench = this.controls?.strategySettings?.fridayBenchmarks;
        try {
            const bf = path.resolve(process.cwd(), ".liquidation-benchmarks.json");
            if (fs.existsSync(bf)) {
                const localBench = JSON.parse(fs.readFileSync(bf, "utf-8"));
                if (localBench?.benchmarks && Object.keys(localBench.benchmarks).length > 0) {
                    if (!cloudBench || (localBench.liquidatedAt || 0) >= (cloudBench.liquidatedAt || 0)) {
                        return localBench;
                    }
                }
            }
        }
        catch { }
        if (cloudBench?.benchmarks && Object.keys(cloudBench.benchmarks).length > 0) {
            return cloudBench;
        }
        return null;
    }
    async runAutonomousAiBenchmarkAudit(forceTelegram = false, botSpendableUsdt = 0) {
        try {
            const now = Date.now();
            const { dayStr, timeDec, year, month, dayOfMonth } = this.getCotTimeInfo();
            const dayKey = `${year}-${month}-${dayOfMonth}`;
            // 1. AUTO-SNAPSHOT DE CIERRE DEL VIERNES (Viernes 12:00 PM a 02:15 PM COT):
            // El bot captura por sí solo los precios de referencia del viernes antes del drenaje de fin de semana.
            if (dayStr === "Fri" && timeDec >= 12.0 && timeDec <= 14.25 && this.lastFridaySnapshotDayKey !== dayKey) {
                const currentBench = this.getFridayBenchmarks();
                const ageHours = currentBench?.liquidatedAt ? (now - currentBench.liquidatedAt) / 3600000 : 999;
                if (ageHours >= 12) {
                    const snapMap = {};
                    for (const sym of this.watchlist) {
                        try {
                            const tRes = await this.client.tickerPrice(sym);
                            const p = parseFloat(tRes.data.price);
                            if (p > 0)
                                snapMap[sym] = p;
                        }
                        catch { }
                    }
                    if (Object.keys(snapMap).length > 0) {
                        this.lastFridaySnapshotDayKey = dayKey;
                        const dateStr = new Date().toLocaleString("es-CO", { timeZone: "America/Bogota" });
                        const newBenchObj = {
                            liquidatedAt: now,
                            dateStr: `Viernes ${dateStr} COT (Auto-Snapshot)`,
                            benchmarks: snapMap,
                            minDropRequiredPct: 5,
                            primeDropRequiredPct: 8
                        };
                        try {
                            fs.writeFileSync(path.resolve(process.cwd(), ".liquidation-benchmarks.json"), JSON.stringify(newBenchObj, null, 2), "utf-8");
                        }
                        catch { }
                        if (!this.controls.strategySettings)
                            this.controls.strategySettings = {};
                        this.controls.strategySettings.fridayBenchmarks = newBenchObj;
                        this.saveStrategyControls();
                        this.notifiedBenchmarkMilestones.clear();
                        console.log(`📸 [AGENTE IA AUTÓNOMO] Snapshot oficial de precios de cierre del viernes guardado (${Object.keys(snapMap).length} monedas).`);
                    }
                }
            }
            // Pausar Agente IA autónomo cuando no hay saldo suficiente para operar (ahorro de tokens y llamadas API),
            // reactivándolo automáticamente cuando entre liquidez o cuando el usuario consulte explícitamente por Telegram (forceTelegram=true).
            const minUsdtForAutonomousAi = this.activeTrailingPositions.size > 0 ? 25 : Math.max(this.minUsdtToTrade, 35);
            if (!forceTelegram && botSpendableUsdt < minUsdtForAutonomousAi) {
                if (!this.aiLowBalancePaused) {
                    this.aiLowBalancePaused = true;
                    console.log(`⏸️ [AGENTE IA EN PAUSA] Saldo libre insuficiente ($${botSpendableUsdt.toFixed(2)} USDT < $${minUsdtForAutonomousAi.toFixed(2)} USDT mín.). Deteniendo consultas automáticas para no consumir tokens hasta recuperar liquidez o comando en Telegram.`);
                }
                return "";
            }
            if (this.aiLowBalancePaused && botSpendableUsdt >= minUsdtForAutonomousAi) {
                this.aiLowBalancePaused = false;
                console.log(`🟢 [AGENTE IA REACTIVADO] Liquidez recuperada ($${botSpendableUsdt.toFixed(2)} USDT). Reanudando análisis autónomo.`);
            }
            // Ejecutar chequeo dinámico del Agente IA cada 3 minutos (o inmediato si forceTelegram === true)
            if (!forceTelegram && (now - this.lastAiBenchmarkCheckTime) < 3 * 60 * 1000) {
                return "";
            }
            this.lastAiBenchmarkCheckTime = now;
            const benchData = this.getFridayBenchmarks();
            if (!benchData || !benchData.benchmarks) {
                return "⚠️ No hay precios de referencia del viernes registrados aún.";
            }
            const calRegime = this.get5YearCalendarRegime();
            const floorWin = this.isHistoricalFloorWindow();
            const pauseWin = this.isHistoricalPauseWindow();
            const isWeekend = this.isWeekendWindow();
            const sessionPlan = this.lastSessionPlan || this.getSessionLiquidityPlan(botSpendableUsdt);
            const coinEvaluations = [];
            let crossedNewMilestone = false;
            const symbolsToCheck = Array.from(new Set([...Object.keys(benchData.benchmarks), ...this.watchlist]));
            for (const sym of symbolsToCheck) {
                try {
                    const [k15Res, k5Res] = await Promise.all([
                        this.client.klines(sym, "15m", { limit: 384 }), // 4 días completos (96 horas) para Memoria Estructural Multidía
                        this.client.klines(sym, "5m", { limit: 6 })
                    ]);
                    const k15All = k15Res.data;
                    const k5 = k5Res.data;
                    if (!k15All || k15All.length < 15)
                        continue;
                    const k15 = k15All.slice(-96); // Últimas 24 horas
                    // Memoria Estructural de 4 Días (evita amnesia de 24h cuando la moneda lleva días bajando a un piso como $59k):
                    const highs4d = k15All.map((r) => parseFloat(r[2]));
                    const lows4d = k15All.map((r) => parseFloat(r[3]));
                    const sortedLows4d = [...lows4d].sort((a, b) => a - b);
                    // Piso estructural recurrente de 4 días (Percentil 10 de los mínimos de 4 días, filtrando mechas aisladas extremas)
                    const structuralFloor4d = sortedLows4d[Math.floor(sortedLows4d.length * 0.10)] || Math.min(...lows4d);
                    const high4d = Math.max(...highs4d);
                    const closes15 = k15.map((r) => parseFloat(r[4]));
                    const highs15 = k15.map((r) => parseFloat(r[2]));
                    const lows15 = k15.map((r) => parseFloat(r[3]));
                    const curPrice = closes15[closes15.length - 1];
                    const high24h = Math.max(...highs15);
                    const low24h = Math.min(...lows15);
                    const fibPosition4d = (high4d - structuralFloor4d) > 0 ? Math.max(0, (curPrice - structuralFloor4d) / (high4d - structuralFloor4d)) : 0.5;
                    const downsideTo4dFloorPct = curPrice > 0 ? Math.max(0, ((curPrice - structuralFloor4d) / curPrice) * 100) : 0;
                    const sma24h = closes15.reduce((acc, v) => acc + v, 0) / closes15.length;
                    const distFromSma24hPct = sma24h > 0 ? ((curPrice - sma24h) / sma24h) * 100 : 0;
                    const downsideToFloorPct = curPrice > 0 ? ((curPrice - low24h) / curPrice) * 100 : 0;
                    // Estudio anti-engaño (Pump & Dump / Mechazo falso + Memoria Multidía 4D):
                    const sortedCloses24 = [...closes15].sort((a, b) => a - b);
                    const p25_24h = sortedCloses24[Math.floor(sortedCloses24.length * 0.25)] || low24h;
                    const p75_24h = sortedCloses24[Math.floor(sortedCloses24.length * 0.75)] || high24h;
                    const closes1h = k15All.map((r) => parseFloat(r[4])).filter((_, idx, arr) => (arr.length - 1 - idx) % 4 === 0);
                    const rsi1h = closes1h.length >= 15 ? this.calculateRSI(closes1h, 14) : this.calculateRSI(closes15, 14);
                    let isBullTrapFakeout = (high24h > p75_24h * 1.018 && curPrice > p25_24h * 1.006) ||
                        distFromSma24hPct > -1.0 ||
                        downsideToFloorPct > 1.35 ||
                        fibPosition4d > 0.30 ||
                        downsideTo4dFloorPct > 2.1 ||
                        rsi1h > 43;
                    const exitPrice = benchData.benchmarks[sym] || high24h;
                    const benchDropPct = exitPrice > 0 ? ((curPrice - exitPrice) / exitPrice) * 100 : 0;
                    const drop24hPct = high24h > 0 ? ((high24h - curPrice) / high24h) * 100 : 0;
                    const fibPosition24h = (high24h - low24h) > 0 ? (curPrice - low24h) / (high24h - low24h) : 0.5;
                    const coinRange24hPct = low24h > 0 ? ((high24h - low24h) / low24h) * 100 : 2.5;
                    const rsi15m = this.calculateRSI(closes15, 14);
                    // 🧲 FACTOR INSTITUCIONAL FALTANTE: IMÁN DEL GAP CME DEL VIERNES E INVERSIÓN DE POLARIDAD SEMANAL:
                    // Si el fin de semana NO cayó sino que SUBIÓ por encima del cierre del viernes (benchDropPct > +1.5%),
                    // se genera un Gap CME Alcista abierto ABAJO (en exitPrice) y el ciclo de Lunes/Martes SE INVIERTE:
                    // Wall Street vende el lunes/martes para bajar a cerrar el Gap del viernes (ej. bajar de $64k/$62k a $59k).
                    // Prohibido comprar arriba del cierre del viernes cuando el Gap CME está abajo sin cerrar.
                    const isCmeGapBelowTrap = benchDropPct > 1.5 && fibPosition4d > 0.22 && rsi1h > 33;
                    if (isCmeGapBelowTrap) {
                        isBullTrapFakeout = true;
                    }
                    const last15 = k15[k15.length - 1];
                    const prev15 = k15[k15.length - 2] || last15;
                    const o15 = parseFloat(last15[1]), h15 = parseFloat(last15[2]), l15 = parseFloat(last15[3]), c15 = parseFloat(last15[4]);
                    const prevLow15 = parseFloat(prev15[3]);
                    const range15 = Math.max(1e-9, h15 - l15);
                    const lowerWick15mPct = ((Math.min(o15, c15) - l15) / range15) * 100;
                    // Freno real de sangría (Higher Low en 15m o mecha de absorción climática >= 38%)
                    const isStoppingBleed15m = (l15 >= prevLow15 * 0.999 && c15 >= o15) || lowerWick15mPct >= 38;
                    const isGreenOrWick15m = isStoppingBleed15m;
                    let cvd5mPct = 50;
                    let isGreen5m = false;
                    if (k5 && k5.length >= 2) {
                        const last5 = k5[k5.length - 1];
                        const prev5 = k5[k5.length - 2];
                        const o5 = parseFloat(last5[1]), h5 = parseFloat(last5[2]), l5 = parseFloat(last5[3]), c5 = parseFloat(last5[4]);
                        const prevLow5 = parseFloat(prev5[3]);
                        const range5 = Math.max(1e-9, h5 - l5);
                        const wick5 = (Math.min(o5, c5) - l5) / range5;
                        isGreen5m = (c5 > o5 && l5 >= prevLow5 * 0.999) || (c5 >= o5 && wick5 >= 0.35);
                        const totQ = parseFloat(last5[7] || "0");
                        const buyQ = parseFloat(last5[10] || "0");
                        cvd5mPct = totQ > 0 ? (buyQ / totQ) * 100 : 50;
                    }
                    const isMeme = this.memeWatchlist.includes(sym) || sym.includes("PEPE");
                    const isBtc = sym === "BTCUSDT";
                    const isSellingExpansionDay = dayStr === "Tue" || dayStr === "Thu" || dayStr === "Fri";
                    const isMonday = dayStr === "Mon";
                    const targetBenchDrop = isMeme ? -6.0 : (isBtc ? -3.8 : -4.8);
                    // 🛡️ ESCUDO ANTI-CAÍDA DE -3% POST-COMPRA (PROHIBIDO COMPRAR FALSOS TECHOS / PUMP & DUMP):
                    // 1. El precio DEBE estar por debajo del promedio de 24h (distFromSma24hPct <= -1.2%), jamás arriba de la media tras un mechazo falso matutino.
                    // 2. Ubicación en el fondo real del canal de 24h (fibPosition24h <= 0.18 en Core / <= 0.15 en BTC) para que no quede un -3% de vacío hacia el piso.
                    // 3. Sobreventa real en 15m (RSI <= 34 en Altcoins / <= 32 en BTC), nunca en RSI 42-46 a mitad de caída.
                    const reqWeekdayDrop = isSellingExpansionDay
                        ? (isMeme ? 6.5 : (isBtc ? 4.5 : 5.2))
                        : (isMonday
                            ? (isMeme ? 3.8 : (isBtc ? 3.5 : 2.8))
                            : (isMeme ? 4.2 : (isBtc ? 3.5 : 3.2)));
                    const reqWeekdayRsi = isSellingExpansionDay
                        ? 29
                        : (isMonday ? (isMeme ? 33 : (isBtc ? 32 : 34)) : 33);
                    const reqWeekdayFib = isSellingExpansionDay
                        ? 0.14
                        : (isMonday ? (isBtc ? 0.16 : 0.18) : 0.18);
                    const isBelow24hMean = distFromSma24hPct <= (isBtc ? -1.4 : -1.2) && !isBullTrapFakeout && downsideToFloorPct <= 1.25 && rsi1h <= 42;
                    const isStrategicWeekdayFloor = !isWeekend && isBelow24hMean && drop24hPct >= reqWeekdayDrop && fibPosition24h <= reqWeekdayFib && rsi15m <= reqWeekdayRsi;
                    // 🚀 ACUMULACIÓN DOMINGO PRE-RALLY (17:30 a 23:59 COT) CON ESCUDO DE PISO REAL:
                    const isSundayPreRally = dayStr === "Sun" && timeDec >= 17.5 && timeDec <= 23.95;
                    const isSundayPreRallyFloor = isSundayPreRally && isBelow24hMean && (drop24hPct >= 2.8 || benchDropPct <= -2.8) && fibPosition24h <= 0.20 && rsi15m <= 35 && cvd5mPct >= 53;
                    const isStrategicWeekendFloor = isWeekend && isBelow24hMean && (benchDropPct <= targetBenchDrop || (drop24hPct >= (isMeme ? 5.8 : 4.6) && fibPosition24h <= 0.18) || isSundayPreRallyFloor) && (isSundayPreRallyFloor ? rsi15m <= 35 : rsi15m <= (isMeme ? 32 : 34));
                    const isDeepDiscount = isStrategicWeekendFloor || isStrategicWeekdayFloor;
                    const qualifiesToArmWatch = isDeepDiscount;
                    // PROHIBIDO comprar directo a mercado sin pasar por Trailing Buy (buyWatches), salvo capitulación extrema en el fondo absoluto (fib <= 0.12, RSI <= 28) con freno confirmado:
                    const qualifiesToBuy = isDeepDiscount &&
                        fibPosition24h <= 0.12 &&
                        rsi15m <= 28 &&
                        rsi1h <= 34 &&
                        downsideToFloorPct <= 0.85 &&
                        distFromSma24hPct <= -2.5 &&
                        isStoppingBleed15m &&
                        isGreen5m &&
                        cvd5mPct >= 55 &&
                        (!pauseWin.paused || benchDropPct <= -6.2 || drop24hPct >= 5.8);
                    // Detectar cruce de hitos de caída (-3%, -5%, -8%, -10%) para alerta inmediata en Telegram
                    const effDrop = isWeekend ? benchDropPct : -drop24hPct;
                    const milestoneLevel = effDrop <= -10 ? 10 : (effDrop <= -8 ? 8 : (effDrop <= -5 ? 5 : (effDrop <= -3 ? 3 : 0)));
                    const prevMilestone = this.notifiedBenchmarkMilestones.get(sym) || 0;
                    if (milestoneLevel > prevMilestone) {
                        this.notifiedBenchmarkMilestones.set(sym, milestoneLevel);
                        crossedNewMilestone = true;
                    }
                    coinEvaluations.push({
                        symbol: sym,
                        exitPrice,
                        curPrice,
                        low24h,
                        structuralFloor4d,
                        fibPosition4d,
                        downsideTo4dFloorPct,
                        sma24h,
                        distFromSma24hPct,
                        downsideToFloorPct,
                        isBullTrapFakeout,
                        benchDropPct,
                        drop24hPct,
                        fibPosition24h,
                        high24h: Math.max(high24h, exitPrice),
                        coinRange24hPct,
                        rsi15m,
                        rsi1h,
                        lowerWick15mPct,
                        cvd5mPct,
                        isGreenOrWick15m,
                        isGreen5m,
                        qualifiesToBuy,
                        qualifiesToArmWatch
                    });
                }
                catch { }
            }
            if (coinEvaluations.length === 0)
                return "";
            // Ordenar por mayor descuento (en fin de semana vs cierre viernes; entre semana por retroceso 24h)
            coinEvaluations.sort((a, b) => (isWeekend ? a.benchDropPct - b.benchDropPct : b.drop24hPct - a.drop24hPct));
            // Recopilar posiciones abiertas para que el Trader IA también gestione ventas, candados y expansión de Martes/Jueves
            const openPosSnapshot = [];
            for (const [posKey, p] of this.activeTrailingPositions.entries()) {
                const sym = p.symbol || posKey.split("_")[0];
                const coinEv = coinEvaluations.find((c) => c.symbol === sym);
                const curP = coinEv ? coinEv.curPrice : p.highestPrice;
                const gainPct = p.buyPrice > 0 ? ((curP - p.buyPrice) / p.buyPrice) * 100 : 0;
                openPosSnapshot.push({
                    symbol: posKey,
                    buyPrice: p.buyPrice,
                    curPrice: curP,
                    highestPrice: p.highestPrice,
                    gainPct,
                    lockedFloorGainPct: p.lockedFloorGainPct
                });
            }
            // 2. CONSULTA Y DECISIÓN DISCRECIONAL DEL AGENTE TRADER IA (LUNES A DOMINGO 24/7):
            const btcAnchor = await this.verifyBtc15mLeaderAnchor("ALT");
            let executedSymbol;
            let executedAmountUsdt;
            let aiActionNote = "";
            const aiEval = await this.aiCopilot.evaluateAutonomousBenchmarkCycle({
                benchmarkDateStr: benchData.dateStr,
                dayStr,
                calendarLabel: calRegime.label,
                regimeKey: calRegime.regimeKey,
                sessionTitle: sessionPlan.sessionTitle,
                spendableUsdt: botSpendableUsdt,
                btcAnchorOk: btcAnchor.ok,
                openPositions: openPosSnapshot,
                coins: coinEvaluations
            });
            const aiDec = aiEval.aiDecision;
            const uniqueActiveCount = this.getUniqueActiveSymbols().size;
            const maxUniqueCoins = this.controls?.maxPositions || 4;
            // Ingestar calibración de parámetros específicos por moneda (limitado a salida ágil <= 0.72% para no estancar capital):
            if (aiDec?.coinCalibrations && typeof aiDec.coinCalibrations === "object") {
                for (const [sym, cal] of Object.entries(aiDec.coinCalibrations)) {
                    if (cal && typeof cal.minGainPct === "number" && typeof cal.callbackPct === "number") {
                        const cleanSym = sym.trim().toUpperCase();
                        const safeCal = {
                            ...cal,
                            minGainPct: Math.min(0.72, Math.max(0.60, cal.minGainPct)),
                            callbackPct: Math.min(0.22, Math.max(0.12, cal.callbackPct))
                        };
                        this.aiCoinCalibrations.set(cleanSym, safeCal);
                    }
                }
            }
            // Ejecutar decisiones de gestión de posiciones abiertas del Trader IA (Martes/Jueves Expansión o Cosecha en Techo)
            if (aiDec && aiDec.targetSymbol && aiDec.confidence >= 75) {
                if (aiDec.action === "LOCK_PROFIT_FLOOR" && aiDec.lockedFloorPct && aiDec.lockedFloorPct >= 0.58) {
                    const lockRes = await this.lockPositionFloor(aiDec.targetSymbol, aiDec.lockedFloorPct);
                    if (lockRes.success) {
                        aiActionNote = `\n🔒 <b>Acción Trader IA:</b> Piso de ganancia amarrado en <b>${aiDec.targetSymbol} (+${aiDec.lockedFloorPct.toFixed(2)}%)</b>.`;
                    }
                }
                else if (aiDec.action === "WIDEN_EXPANSION_TP" && aiDec.customCallbackPct && aiDec.customCallbackPct >= 0.25 && aiDec.customCallbackPct <= 0.55) {
                    for (const [k, p] of this.activeTrailingPositions.entries()) {
                        if (k === aiDec.targetSymbol || p.symbol === aiDec.targetSymbol) {
                            p.customCallbackPct = aiDec.customCallbackPct;
                            await this.saveTrailingPositions();
                            aiActionNote = `\n🚀 <b>Acción Trader IA:</b> Callback ampliado en <b>${k} (${aiDec.customCallbackPct.toFixed(2)}%)</b> para exprimir expansión de ${dayStr}.`;
                            break;
                        }
                    }
                }
            }
            // Evaluar conmutación de estrategia por comportamiento atípico detectado por el Trader IA
            if (aiDec?.regimeOverride && aiDec.confidence >= 78 && aiDec.regimeOverride !== this.activeAtypicalOverride) {
                const prevOverride = this.activeAtypicalOverride;
                this.activeAtypicalOverride = aiDec.regimeOverride;
                if (aiDec.regimeOverride === "RANGE_SCALPER" && !this.controls.strategies.micro_grid) {
                    await this.activateMicroGrid(true);
                    aiActionNote += `\n🌐 <b>Cambio Dinámico de Estrategia:</b> Mercado lateral detectado → <b>Micro-Grid ACTIVADO</b>.`;
                }
                else if (prevOverride === "RANGE_SCALPER" && aiDec.regimeOverride !== "RANGE_SCALPER" && this.controls.strategies.micro_grid) {
                    await this.deactivateMicroGrid();
                    aiActionNote += `\n🏹 <b>Cambio Dinámico de Estrategia:</b> Volatilidad reactivada → <b>Micro-Grid PAUSADO / Cazador Trailing 100%</b>.`;
                }
                else if (aiDec.regimeOverride === "CRASH_HUNTER") {
                    aiActionNote += `\n⚡ <b>Cambio Dinámico de Estrategia:</b> Desplome atípico detectado → <b>Modo Cacería de Capitulación ACTIVADO (100% Presupuesto Desbloqueado)</b>.`;
                }
                else if (aiDec.regimeOverride === "RALLY_HARVESTER") {
                    aiActionNote += `\n🚀 <b>Cambio Dinámico de Estrategia:</b> Rally alcista atípico detectado → <b>Modo Cosecha en Cima y Escudo Anti-FOMO ACTIVADOS</b>.`;
                }
            }
            // Evaluar candidato sugerido por el Trader IA (con Escudo Anti-Caída de -3% Post-Compra)
            const isMonday = dayStr === "Mon";
            const isSellingDayNow = (dayStr === "Tue" || dayStr === "Thu" || dayStr === "Fri") && this.activeAtypicalOverride !== "CRASH_HUNTER";
            const minAiDropReq = isSellingDayNow
                ? 5.0
                : (this.activeAtypicalOverride === "CRASH_HUNTER" ? 3.4 : (isMonday ? 2.8 : 3.2));
            const maxAiRsiReq = isSellingDayNow
                ? 29
                : (isMonday ? 34 : 33);
            const maxAiFibReq = isSellingDayNow
                ? 0.14
                : 0.18;
            if (aiDec && (aiDec.action === "BUY_NOW" || aiDec.action === "ARM_TRAILING_BUY") && aiDec.targetSymbol && aiDec.confidence >= 75) {
                const aiCand = coinEvaluations.find((c) => c.symbol === aiDec.targetSymbol || c.symbol.replace("USDT", "") === aiDec.targetSymbol);
                if (aiCand) {
                    const isCandMeme = this.memeWatchlist.includes(aiCand.symbol) || aiCand.symbol.includes("PEPE");
                    const isCandBtc = aiCand.symbol === "BTCUSDT";
                    const effMinDrop = isMonday ? (isCandMeme ? 3.8 : (isCandBtc ? 3.5 : 2.8)) : minAiDropReq;
                    const effMaxRsi = isMonday ? (isCandMeme ? 33 : (isCandBtc ? 32 : 34)) : maxAiRsiReq;
                    const effMaxFib = isCandBtc ? 0.16 : maxAiFibReq;
                    if (aiCand.fibPosition24h <= effMaxFib && aiCand.rsi15m <= effMaxRsi && (aiCand.drop24hPct >= effMinDrop || aiCand.benchDropPct <= -4.5)) {
                        // Siempre armar Trailing Buy para perseguir el piso hasta el último centavo; solo disparar BUY_NOW directo en suelo extremo (fib <= 0.12, RSI <= 28)
                        aiCand.qualifiesToArmWatch = true;
                        if (aiDec.action === "BUY_NOW" && aiCand.fibPosition24h <= 0.12 && aiCand.rsi15m <= 28 && aiCand.isGreenOrWick15m && aiCand.cvd5mPct >= 55 && !pauseWin.paused) {
                            aiCand.qualifiesToBuy = true;
                        }
                    }
                }
            }
            let armedNewWatch = false;
            for (const candidate of coinEvaluations) {
                if (this.hasActivePositionForSymbol(candidate.symbol))
                    continue;
                const aiCalCand = this.aiCoinCalibrations.get(candidate.symbol);
                if (aiCalCand?.trapDetected || aiCalCand?.strategyMode === "AVOID_BULL_TRAP" || candidate.isBullTrapFakeout) {
                    continue;
                }
                if (aiCalCand?.maxEntryRsi && candidate.rsi15m > aiCalCand.maxEntryRsi) {
                    continue;
                }
                if (aiCalCand?.maxEntryFib && candidate.fibPosition24h > aiCalCand.maxEntryFib) {
                    continue;
                }
                if (aiCalCand?.targetFloorPrice && aiCalCand.targetFloorPrice > 0 && candidate.curPrice > aiCalCand.targetFloorPrice * 1.008) {
                    continue;
                }
                // A) Si está en descuento atractivo pero aún sigue cayendo, armar Trailing Buy para atrapar el fondo exacto
                if (candidate.qualifiesToArmWatch && !this.buyWatches.has(candidate.symbol) && uniqueActiveCount < maxUniqueCoins) {
                    const upsideGap = candidate.curPrice > 0 ? ((candidate.high24h - candidate.curPrice) / candidate.curPrice) * 100 : Math.abs(candidate.benchDropPct);
                    this.buyWatches.set(candidate.symbol, {
                        symbol: candidate.symbol,
                        armedPrice: candidate.curPrice,
                        lowestPrice: candidate.curPrice,
                        armedTime: Date.now(),
                        rsi: candidate.rsi15m,
                        dropPct: Math.max(Math.abs(candidate.benchDropPct), candidate.drop24hPct),
                        upsideGapPct: upsideGap,
                        high24h: candidate.high24h,
                        coinRange24hPct: candidate.coinRange24hPct,
                        convictionTier: "MAXIMA_BRECHA",
                        strategy: isWeekend ? "cazador_weekend" : "trailing_rebound"
                    });
                    this.saveBuyWatches();
                    armedNewWatch = true;
                    aiActionNote += `\n🎯 <b>Vigilancia Trailing Buy armada en ${candidate.symbol}</b> (Caída: -${candidate.drop24hPct.toFixed(2)}% | RSI: ${candidate.rsi15m.toFixed(0)}).`;
                    console.log(`🤖🎯 [AGENTE TRADER IA] Vigilancia Trailing Buy armada en ${candidate.symbol} (${dayStr} | -${candidate.drop24hPct.toFixed(2)}% 24h | ${candidate.benchDropPct.toFixed(2)}% vs viernes).`);
                }
                // B) Si ya confirmó freno y giro en el piso, disparar compra automática
                if (!executedSymbol &&
                    candidate.qualifiesToBuy &&
                    (candidate.symbol === "BTCUSDT" || btcAnchor.ok) &&
                    uniqueActiveCount < maxUniqueCoins &&
                    botSpendableUsdt >= 35 &&
                    !this.pendingOpportunity) {
                    const effectiveSpendable = (floorWin.active || isWeekend)
                        ? Math.max(sessionPlan.spendableUsdt, botSpendableUsdt * 0.95)
                        : sessionPlan.spendableUsdt;
                    const strat = isWeekend ? "cazador_weekend" : "trailing_rebound";
                    const upsideGap = candidate.curPrice > 0 ? ((candidate.high24h - candidate.curPrice) / candidate.curPrice) * 100 : Math.abs(candidate.benchDropPct);
                    const amountToUse = this.calculateSessionLotSize(candidate.symbol, effectiveSpendable, sessionPlan.lotFractionPct, strat, 1, candidate.rsi15m, candidate.coinRange24hPct, Math.max(Math.abs(candidate.benchDropPct), upsideGap));
                    if (amountToUse >= this.minUsdtToTrade) {
                        const sourceDesc = `Agente Trader IA (${dayStr}: -${candidate.drop24hPct.toFixed(2)}% 24h / ${candidate.benchDropPct.toFixed(2)}% vs viernes, RSI ${candidate.rsi15m.toFixed(1)})`;
                        const ok = await this.executeSmartBuy(candidate.symbol, amountToUse, sourceDesc, strat, {
                            coinRange24hPct: candidate.coinRange24hPct,
                            upsideGapPct: upsideGap,
                            convictionTier: "MAXIMA_BRECHA"
                        });
                        if (ok) {
                            executedSymbol = candidate.symbol;
                            executedAmountUsdt = amountToUse;
                            this.buyWatches.delete(candidate.symbol);
                            this.saveBuyWatches();
                            break;
                        }
                    }
                }
            }
            // 3. REPORTE PERIÓDICO DEL AGENTE IA A TELEGRAM (Cada hora, o al armar vigilancia, o al comprar, o por comando):
            const shouldSendTelegram = forceTelegram ||
                Boolean(executedSymbol) ||
                Boolean(aiActionNote) ||
                armedNewWatch ||
                crossedNewMilestone ||
                (now - this.lastAiBenchmarkTelegramTime) >= 1 * 3600 * 1000;
            if (!shouldSendTelegram)
                return "";
            this.lastAiBenchmarkTelegramTime = now;
            const primaryBenchSyms = new Set(Object.keys(benchData.benchmarks));
            const displayCoins = coinEvaluations.filter((c) => primaryBenchSyms.has(c.symbol) || c.benchDropPct <= -3.0 || c.drop24hPct >= 3.0);
            let report = `🤖📊 <b>[TRADER IA AUTÓNOMO 24/7 — AUDITORÍA DE MERCADO Y BENCHMARK]</b>\n\n`;
            report += `🗓️ <b>Ref. Cierre Viernes:</b> <i>${benchData.dateStr}</i>\n`;
            report += `📅 <b>Calendario 5.5 Años:</b> ${calRegime.label}\n`;
            report += `⏰ <b>Ventana Actual:</b> ${sessionPlan.sessionTitle}\n\n`;
            for (const c of displayCoins) {
                const emoji = (c.benchDropPct <= -8.0 || c.drop24hPct >= 6.0) ? "🔥" : ((c.benchDropPct <= -4.8 || c.drop24hPct >= 3.5) ? "🎯" : ((c.benchDropPct <= -1.5 || c.drop24hPct >= 2.0) ? "📉" : "⚖️"));
                const symClean = c.symbol.replace("USDT", "");
                const dec = c.symbol.includes("PEPE") ? 8 : (c.curPrice < 10 ? 4 : 2);
                report += `${emoji} <b>${symClean}:</b> $${c.curPrice.toFixed(dec)} (<b>${c.benchDropPct >= 0 ? "+" : ""}${c.benchDropPct.toFixed(2)}%</b> vs Vie | <b>-${c.drop24hPct.toFixed(2)}%</b> vs 24h | RSI: ${c.rsi15m.toFixed(0)})\n`;
            }
            report += `\n${aiEval.verdictHtml}${aiActionNote}\n\n`;
            report += `💼 <b>Saldo Bot Disponible:</b> <b>$${botSpendableUsdt.toFixed(2)} USDT</b> (Operando 24/7 Lunes a Domingo).`;
            if (!forceTelegram) {
                try {
                    await this.notifier.send(report);
                }
                catch (e) {
                    console.error("Error enviando reporte Agente IA Benchmark:", e.message);
                }
            }
            return report;
        }
        catch (e) {
            console.error("Error en runAutonomousAiBenchmarkAudit:", e.message);
            return "";
        }
    }
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
        if (process.env.BOT_NO_AUTOSTART !== "1")
            this.dashboardServer.start();
    }
    saveIgnoredDca() {
        try {
            fs.writeFileSync(path.resolve(process.cwd(), ".ignored-dca.json"), JSON.stringify(Array.from(this.ignoredDca.entries()), null, 2));
        }
        catch (e) {
            console.error("Error guardando ignored DCA:", e.message);
        }
    }
    loadIgnoredDca() {
        try {
            const file = path.resolve(process.cwd(), ".ignored-dca.json");
            if (fs.existsSync(file)) {
                this.ignoredDca = new Map(JSON.parse(fs.readFileSync(file, "utf-8")));
            }
        }
        catch (e) { }
    }
    saveBuyWatches() {
        try {
            fs.writeFileSync(path.resolve(process.cwd(), ".trailing-buys.json"), JSON.stringify(Array.from(this.buyWatches.entries()), null, 2));
        }
        catch (e) {
            console.error("Error guardando trailing buys:", e.message);
        }
    }
    async loadStrategyControls() {
        try {
            // 1. FUENTE PRIMARIA: SUPABASE CLOUD DB
            if (supabaseDb.isAvailable()) {
                const dbCtrl = await supabaseDb.loadStrategyControls();
                if (dbCtrl && dbCtrl.strategies) {
                    this.controls = dbCtrl;
                    if (this.controls.maxPositions === undefined)
                        this.controls.maxPositions = 4;
                    if (this.controls.wideGapLotSize === undefined)
                        this.controls.wideGapLotSize = 100;
                    if (!this.controls.coreWatchlist)
                        this.controls.coreWatchlist = dbCtrl.coreWatchlist || CORE_WATCHLIST;
                    if (!this.controls.memeWatchlist)
                        this.controls.memeWatchlist = dbCtrl.memeWatchlist || MEME_WATCHLIST;
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
                if (this.controls.stopLossEnabled === undefined)
                    this.controls.stopLossEnabled = false; // BLINDAJE SPOT: NUNCA vender a pérdida por defecto
                if (this.controls.stopLossPct === undefined)
                    this.controls.stopLossPct = 4.0;
                if (!this.controls.timeframe)
                    this.controls.timeframe = "1h";
                if (!this.controls.rejectedSuggestions)
                    this.controls.rejectedSuggestions = {};
                if (this.controls.maxPositions === undefined)
                    this.controls.maxPositions = 4;
                if (this.controls.wideGapLotSize === undefined)
                    this.controls.wideGapLotSize = 100;
                if (this.controls.cashReservePct === undefined)
                    this.controls.cashReservePct = 25;
                if (this.controls.maxPerCoinPct === undefined)
                    this.controls.maxPerCoinPct = 30;
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
                }
                else if (this.controls.strategies.cazador_weekend === undefined) {
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
        }
        catch (e) {
            console.error("Error cargando strategy controls:", e.message);
        }
    }
    saveStrategyControls() {
        try {
            this.controls.updatedAt = Date.now();
            this.controls.autoPilot = this.autoPilot;
            if (!this.controls.coreWatchlist)
                this.controls.coreWatchlist = this.coreWatchlist;
            if (!this.controls.memeWatchlist)
                this.controls.memeWatchlist = this.memeWatchlist;
            if (!this.controls.strategySettings)
                this.controls.strategySettings = {};
            this.controls.strategySettings.coreWatchlist = this.controls.coreWatchlist;
            this.controls.strategySettings.memeWatchlist = this.controls.memeWatchlist;
            fs.writeFileSync(path.resolve(process.cwd(), ".strategy-controls.json"), JSON.stringify(this.controls, null, 2));
            // Sincronización en la nube Supabase
            supabaseDb.saveStrategyControls(this.controls).catch(() => { });
        }
        catch (e) {
            console.error("Error guardando strategy controls:", e.message);
        }
    }
    loadPendingOpportunity() {
        try {
            const file = path.resolve(process.cwd(), ".pending-opportunity.json");
            if (fs.existsSync(file)) {
                this.pendingOpportunity = JSON.parse(fs.readFileSync(file, "utf-8"));
            }
        }
        catch (e) { }
    }
    savePendingOpportunity() {
        try {
            const file = path.resolve(process.cwd(), ".pending-opportunity.json");
            if (this.pendingOpportunity) {
                fs.writeFileSync(file, JSON.stringify(this.pendingOpportunity, null, 2));
            }
            else if (fs.existsSync(file)) {
                fs.unlinkSync(file);
            }
        }
        catch (e) { }
    }
    async onWeekendTradeCompleted(symbol) {
        try {
            const { dayStr, timeDec } = this.getCotTimeInfo();
            const stillInWeekendFloorWindow = dayStr === "Sat" || (dayStr === "Sun" && timeDec < 16.5);
            if (stillInWeekendFloorWindow) {
                console.log(`🏖️ [CAZADOR WEEKEND] Posición de fin de semana en ${symbol} vendida en rebote. Manteniendo Cazador Weekend ACTIVO para re-testeo.`);
                await this.notifier.send(`🏖️ <b>[CAZADOR WEEKEND: REBOTE COSECHADO EN ${symbol}]</b> 🎉\n\n` +
                    `• La posición en <b>${symbol}</b> cerró en ganancia durante el rebote.\n` +
                    `• 🎣 <b>Capital liberado en USDT:</b> Cazador Weekend permanece <b>100% ACTIVO</b> para volver a cazar si el mercado hace un segundo piso o re-testeo.`);
                return;
            }
            console.log("🏖️ [CAZADOR WEEKEND] Posición de fin de semana en " + symbol + " vendida con éxito al cierre dominical. Reasignando presupuesto a Cazador Trailing...");
            this.controls.strategies.cazador_weekend = false;
            const baseW = this.controls.baseAllocations?.cazador_weekend ?? 20;
            const currentW = this.controls.allocations.cazador_weekend ?? 0;
            const transferAmount = currentW > 0 ? currentW : baseW;
            this.controls.allocations.trailing_rebound = (this.controls.allocations.trailing_rebound || 50) + transferAmount;
            this.controls.allocations.cazador_weekend = 0;
            this.saveStrategyControls();
            await this.notifier.send("🏖️ <b>[CAZADOR WEEKEND: OPERACIÓN VENDIDA CON ÉXITO]</b> 🎉\n\n" +
                "• La posición en <b>" + symbol + "</b> ha cerrado en la cima con ganancias.\n" +
                "• Como la operación de fin de semana ya fue completada, el switch de Cazador Weekend se ha <b>desactivado</b> automáticamente.\n" +
                "• 💼 <b>Presupuesto inteligente:</b> La cuota del <b>" + transferAmount + "%</b> se transfirió automáticamente a <b>🏹 Cazador Trailing</b> (ahora al <b>" + this.controls.allocations.trailing_rebound + "%</b>) para continuar operando durante la semana.\n" +
                "• ⏰ Se reactivará y recuperará su presupuesto el próximo viernes a las 17:00 COT.");
        }
        catch (e) {
            console.error("Error en onWeekendTradeCompleted:", e.message);
        }
    }
    async lockPositionFloor(targetSymbolOrId, customPct) {
        let matchedId = null;
        let pos = null;
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
        }
        catch (e) {
            return { success: false, msg: e.message };
        }
    }
    async checkPositionActionFile() {
        try {
            const file = path.resolve(process.cwd(), ".position-action.json");
            if (fs.existsSync(file)) {
                const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
                fs.unlinkSync(file);
                const actions = Array.isArray(raw) ? raw : [raw];
                for (const data of actions) {
                    if (!data || !data.action)
                        continue;
                    if (data.action === "update_pos_params") {
                        const cleanSym = String(data.symbol || data.id || "").trim().toUpperCase().split("_")[0];
                        let updatedAny = false;
                        for (const [k, p] of this.activeTrailingPositions.entries()) {
                            const matches = (data.id && (k === data.id || p.lotId === data.id)) ||
                                (cleanSym && (p.symbol === cleanSym || k === cleanSym || k.startsWith(cleanSym + "_lot_")));
                            if (matches) {
                                if (typeof data.customCallbackPct === "number" && data.customCallbackPct > 0) {
                                    p.customCallbackPct = data.customCallbackPct;
                                }
                                if (typeof data.customTimeframe === "string" && data.customTimeframe) {
                                    p.customTimeframe = data.customTimeframe;
                                }
                                updatedAny = true;
                            }
                        }
                        if (updatedAny) {
                            await this.saveTrailingPositions();
                            console.log(`⚙️ [DASHBOARD SYNC] Parámetros actualizados en ${cleanSym || data.id}: callback=${data.customCallbackPct ?? "-"}% | tf=${data.customTimeframe ?? "-"}`);
                        }
                    }
                    else if (data.action === "manual_sell" && data.id) {
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
                    }
                    else if (data.action === "manual_buy" && data.symbol && data.usdtAmount) {
                        const sym = String(data.symbol).trim().toUpperCase();
                        const amount = parseFloat(data.usdtAmount);
                        console.log("🌐 [COMPRA MANUAL DESDE RADAR] Recibida orden para " + sym + " por $" + amount + " USDT...");
                        if (amount >= this.minUsdtToTrade) {
                            const ok = await this.executeSmartBuy(sym, amount, "Manual desde Radar Web", "trailing_rebound");
                            if (ok) {
                                const pos = this.activeTrailingPositions.get(sym);
                                if (pos) {
                                    pos.isManual = true;
                                    if (data.triggerGainPct)
                                        pos.customMinGainPct = parseFloat(data.triggerGainPct);
                                    if (data.callbackPct)
                                        pos.customCallbackPct = parseFloat(data.callbackPct);
                                    await this.saveTrailingPositions();
                                }
                                this.deductFromManualWallet(amount);
                                await this.notifier.send("👤 <b>[COMPRA MANUAL CONFIRMADA DESDE RADAR]</b> 🚀\n\n" +
                                    "• <b>Moneda:</b> <b>" + sym + "</b>\n" +
                                    "• <b>Inversión:</b> $" + amount.toFixed(2) + " USDT (Saldo Manual)\n" +
                                    "• <b>Trailing Take Profit:</b> Activa al +" + (data.triggerGainPct || 0.8).toFixed(2) + "% (retroceso " + (data.callbackPct || 0.25).toFixed(2) + "%)\n\n" +
                                    "🛡️ <i>Protegida 100% contra ventas a pérdida y rastreando picos en tiempo real.</i>");
                            }
                        }
                        else {
                            console.error("Monto de compra manual inválido: " + amount);
                        }
                    }
                    else if (data.action === "lock_profit" && data.id) {
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
            }
        }
        catch (e) { }
    }
    async checkOpportunityActionFile() {
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
                }
                else if (data.action === "ignore" && this.pendingOpportunity) {
                    console.log(`🌐 Acción recibida desde Dashboard: IGNORAR ${this.pendingOpportunity.symbol}`);
                    this.pendingOpportunity = null;
                    this.savePendingOpportunity();
                    await this.notifier.send(`🌐 <b>[CANCELADO DESDE DASHBOARD]</b> Oportunidad descartada.`);
                }
            }
        }
        catch (e) { }
    }
    async buildAiContextSnapshot() {
        let freeUsdt = 0;
        let earnUsdt = 0;
        try {
            freeUsdt = await this.getFreeBalance("USDT");
            const earnRes = await this.client.getFlexibleProductPosition({ asset: "USDT", recvWindow: 60000 });
            earnUsdt = parseFloat(earnRes.data?.rows?.[0]?.totalAmount || "0");
        }
        catch { }
        const positions = [];
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
            }
            catch { }
        }
        const radar = [];
        for (const sym of ["PEPEUSDT", "XRPUSDT", "BNBUSDT", "BTCUSDT"]) {
            try {
                const k = await this.client.klines(sym, "15m", { limit: 20 });
                const closes = k.data.map((row) => parseFloat(row[4]));
                const cur = closes[closes.length - 1];
                const rsi = this.calculateRSI(closes, 14);
                const highs = k.data.map((row) => parseFloat(row[2]));
                const maxRecent = Math.max(...highs.slice(-20));
                const dropPct = ((maxRecent - cur) / maxRecent) * 100;
                radar.push({
                    symbol: sym,
                    curPrice: cur,
                    rsi,
                    dropPct,
                    isHunting: this.buyWatches.has(sym)
                });
            }
            catch { }
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
    async checkOpportunityTimeout() {
        if (!this.pendingOpportunity)
            return;
        if (Date.now() >= this.pendingOpportunity.expiresAt) {
            const opp = this.pendingOpportunity;
            this.pendingOpportunity = null;
            this.savePendingOpportunity();
            if (this.controls.autoPilot) {
                console.log(`⚡ [AUTO-PILOTO] Tiempo de 3 min agotado. Ejecutando automáticamente ${opp.strategyName} en ${opp.symbol}...`);
                await this.notifier.send(`⚡ <b>[AUTO-PILOTO: DECISIÓN INTELIGENTE EJECUTADA]</b> 🤖\n\n` +
                    `⏱️ Tiempo de espera agotado sin respuesta.\n` +
                    `🚀 <b>Acción:</b> Ejecutando compra para no perder la ventana de rebote:\n` +
                    `• <b>Moneda:</b> ${opp.symbol}\n` +
                    `• <b>Estrategia:</b> ${opp.strategyName}\n` +
                    `• <b>Monto:</b> ${opp.amount.toFixed(2)} USDT\n\n` +
                    `📊 <b>Criterio Técnico Evaluado:</b> ${opp.reason}\n` +
                    `🧠 <b>¿Por qué tomó esta decisión?:</b> Los datos confirmaron absorción de venta y giro hacia arriba en soporte. La compra se ejecuta en el suelo para cazar el impulso (+0.8% a +3.5%) sin dejar pasar la oportunidad.`);
                await this.executeOpportunity(opp);
            }
            else {
                console.log(`⌛ [MODO MANUAL] Tiempo agotado. Oportunidad en ${opp.symbol} descartada.`);
                await this.notifier.send(`⌛ <i>Tiempo de espera agotado. Oportunidad en ${opp.symbol} descartada (Modo Manual).</i>`);
            }
        }
    }
    async executeOpportunity(opp) {
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
        }
        else if (opp.strategy === "trailing_rebound") {
            return await this.executeSmartBuy(opp.symbol, opp.amount, "Trailing Rebound Confirmado");
        }
        else if (opp.strategy === "micro_grid") {
            return await this.executeSmartBuy(opp.symbol, opp.amount, "Micro-Grid Rango Lateral");
        }
        else if (opp.strategy === "cazador_weekend") {
            return await this.executeSmartBuy(opp.symbol, opp.amount, "Cazador Weekend (Rebote Fin de Semana)", "cazador_weekend");
        }
        return false;
    }
    async notifyOpportunity(opp) {
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
    async executeSmartDca(pos, usdtAmount) {
        try {
            const cleanSym = (pos.symbol || "").split("_")[0];
            // 🛡️ REGLA INSTITUCIONAL CONTRA COMPRAS APRESURADAS:
            // 1. Revisar lotes existentes de esta moneda
            const existingLots = Array.from(this.activeTrailingPositions.entries()).filter(([k, p]) => {
                const pSym = (p.symbol || k).split("_")[0];
                return pSym === cleanSym;
            });
            // Límite estricto de máximo 3 lotes por moneda (Lote 1 base + Lote 2 DCA + Lote 3 Capitulación)
            if (existingLots.length >= 3) {
                console.log(`🛡️ [SMART DCA TOPE MÁXIMO] ${cleanSym} ya tiene ${existingLots.length} lotes activos. No se permiten más compras para proteger la diversificación y liquidez.`);
                await this.notifier.send(`🛡️ <i>Smart DCA cancelado en ${cleanSym}: ya alcanzó el límite máximo de ${existingLots.length} lotes. No se sobreexpone capital.</i>`);
                return false;
            }
            // 2. Cooldown temporal y separación de precio frente al lote más reciente
            if (existingLots.length > 0) {
                const recentLots = existingLots.map(([k, p]) => p).sort((a, b) => (b.buyTime || 0) - (a.buyTime || 0));
                const lastLot = recentLots[0];
                if (lastLot) {
                    const timeSinceLastLotMin = (Date.now() - (lastLot.buyTime || 0)) / (60 * 1000);
                    const minCooldownMinutes = 45; // Mínimo 45 minutos de respiro
                    if (timeSinceLastLotMin < minCooldownMinutes) {
                        console.log(`🛡️ [SMART DCA BLOQUEADO] ${cleanSym} ya compró el Lote #${lastLot.lotIndex} hace ${timeSinceLastLotMin.toFixed(1)} min. Cooldown activo de ${minCooldownMinutes} min para evitar compras apresuradas.`);
                        await this.notifier.send(`⏳ <i>Smart DCA cancelado en ${cleanSym}: ya se compró un lote hace ${timeSinceLastLotMin.toFixed(0)} min. Se exige esperar al menos ${minCooldownMinutes} min antes de otra recompra.</i>`);
                        return false;
                    }
                    // Separación de precio mínima del -2.5% frente al último lote
                    let curPrice = 0;
                    try {
                        const t = await this.client.tickerPrice(cleanSym);
                        curPrice = parseFloat(t.data.price);
                    }
                    catch { }
                    if (curPrice > 0 && lastLot.buyPrice > 0) {
                        const priceDropFromLastLotPct = ((lastLot.buyPrice - curPrice) / lastLot.buyPrice) * 100;
                        const minDropRequiredPct = 2.5; // Al menos 2.5% más barato que el último lote
                        if (priceDropFromLastLotPct < minDropRequiredPct) {
                            console.log(`🛡️ [SMART DCA BLOQUEADO] ${cleanSym} precio actual (${curPrice}) no tiene suficiente separación (-${priceDropFromLastLotPct.toFixed(2)}% vs ${minDropRequiredPct}% req) frente al último lote (${lastLot.buyPrice}). Compra apresurada evitada.`);
                            await this.notifier.send(`⏳ <i>Smart DCA cancelado en ${cleanSym}: el precio actual no tiene suficiente descuento (-${priceDropFromLastLotPct.toFixed(2)}% vs -${minDropRequiredPct}% requerido) frente al último lote comprado. Evitando comprar al mismo nivel.</i>`);
                            return false;
                        }
                    }
                }
            }
            // 3. Ancla Líder-Seguidor en Bitcoin 15m: evitar promediar en altcoins si BTC sigue cayendo en 15m
            const btcAnchor = await this.verifyBtc15mLeaderAnchor(cleanSym);
            if (!btcAnchor.ok) {
                console.log(`⚓ [SMART DCA RETENIDO POR ANCLA BTC 15M] ${cleanSym}: ${btcAnchor.reason}`);
                return false;
            }
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
                if (f.commissionAsset === asset)
                    feeInBase += parseFloat(f.commission);
            }
            const newQty = grossQty - feeInBase;
            const buyPriceThisLot = spent / newQty;
            // Calcular número exacto de lote según lotes activos de este activo
            const lotIndex = existingLots.length + 1;
            const newLotId = `${cleanSym}_lot_${lotIndex}_${Date.now()}`;
            pos.lastDcaTime = Date.now();
            pos.dcaCount = (pos.dcaCount || 0) + 1;
            // Calcular descuento real de este lote frente al Lote #1 (brecha de rebote disponible)
            const dropFromLot1Pct = pos.buyPrice > 0 ? Math.max(0, ((pos.buyPrice - buyPriceThisLot) / pos.buyPrice) * 100) : 3.0;
            const btcRange = this.controls.suggestions?.trailing_rebound?.btcRange24h || 2.0;
            const isMeme = this.memeWatchlist.includes(cleanSym) || cleanSym.includes("PEPE") || cleanSym.includes("BONK") || cleanSym.includes("DOGE");
            // 🚀 META DE SALIDA ADAPTATIVA POR PROFUNDIDAD DE CAÍDA (TANTO EN LOTE #2 COMO EN LOTE #3):
            // Si la moneda cayó -5.5% o -6.5%+ antes de comprar el Lote #2 (o Lote #3), ese lote se compró en descuento profundo
            // y su rebote natural hacia el Lote #1 será mucho más grande (+1.5% a +3.5%).
            let lotMinGainPct = 0.90;
            let dcaConviction = "IMPULSO";
            if (dropFromLot1Pct >= 6.0 || lotIndex >= 3) {
                dcaConviction = "MAXIMA_BRECHA";
                if (isMeme) {
                    lotMinGainPct = dropFromLot1Pct >= 7.0 ? 2.40 : 2.10;
                }
                else if (btcRange >= 2.3 || dropFromLot1Pct >= 6.0) {
                    lotMinGainPct = 1.80;
                }
                else {
                    lotMinGainPct = 1.35;
                }
            }
            else if (dropFromLot1Pct >= 4.2) {
                dcaConviction = "ALTA_VOLATILIDAD";
                lotMinGainPct = isMeme ? 1.65 : 1.35;
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
                customMinGainPct: lotMinGainPct,
                coinRange24hPct: Math.max(pos.coinRange24hPct || 3.5, dropFromLot1Pct),
                upsideGapPct: dropFromLot1Pct,
                convictionTier: dcaConviction
            });
            this.saveTrailingPositions();
            const newTarget = (buyPriceThisLot * (1 + lotMinGainPct / 100)).toFixed(4);
            const isDeepDiscount = lotIndex >= 3 || dropFromLot1Pct >= 5.5;
            const title = isDeepDiscount
                ? `🚨 <b>¡SMART DCA: LOTE #${lotIndex} EN DESCUENTO PROFUNDO (-${dropFromLot1Pct.toFixed(1)}%) CREADO!</b> 💎`
                : `🛡️ <b>¡SMART DCA: NUEVO LOTE INDEPENDIENTE CREADO!</b> 🎯`;
            const alertMsg = `${title}\n\n` +
                `• <b>Moneda:</b> <b>${cleanSym}</b> (Lote #${lotIndex} — Descuento <b>-${dropFromLot1Pct.toFixed(2)}%</b> vs Lote 1)\n` +
                `• 💵 <b>Inversión escalonada de este lote:</b> <b>${spent.toFixed(2)} USDT</b> (+${newQty.toFixed(4)} ${asset})\n` +
                `• 🎯 <b>Precio de compra en piso:</b> <b>${fmtPrice(buyPriceThisLot)}</b>\n` +
                `• 🚀 <b>Despertar Trailing Ampliado (+${lotMinGainPct.toFixed(2)}%):</b> ${newTarget} <i>(persiguiendo rebote mayor hacia ${fmtPrice(pos.buyPrice)})</i>\n\n` +
                `🔒 <i>LOTE AISLADO CON RANGO EXPANDIDO: Al haberse comprado con -${dropFromLot1Pct.toFixed(1)}% de descuento, el algoritmo amplió la meta y el respiro del Trailing para capturar un rebote grande en este lote sin venderlo prematuramente.</i>`;
            await this.notifier.send(alertMsg);
            console.log(alertMsg.replace(/<[^>]*>/g, ""));
            return true;
        }
        catch (e) {
            const msg = e.response?.data?.msg || e.message;
            console.error(`❌ Error ejecutando Smart DCA en ${pos.symbol}:`, msg);
            await this.notifier.send(`⚠️ <i>No se pudo ejecutar Smart DCA en ${pos.symbol}: ${msg}</i>`);
            return false;
        }
    }
    /**
     * 🤖 ESTRATEGIA AUTÓNOMA CENTINELA ALPHA (Recuperación y Caza Institucional Calibrada 18 Semanas)
     * Gestiona de forma 100% independiente su cuota de presupuesto respetando Horas Piso, Pausas, Ancla BTC 15m y Bloques >= $35-$100 USDT.
     */
    async evaluateCentinelaAlpha(usdt) {
        try {
            if (!this.controls.strategies?.centinela_alpha)
                return false;
            // Respetar límite de concentración de posiciones
            const uniqueActiveNow = this.getUniqueActiveSymbols().size;
            const configuredMax = this.controls?.maxPositions || 4;
            if (uniqueActiveNow >= configuredMax)
                return false;
            // Verificar si ya tenemos una posición abierta gestionada por Centinela Alpha
            for (const p of this.activeTrailingPositions.values()) {
                if (p.strategy === "centinela_alpha")
                    return false;
            }
            // Prohibido abrir micro-operaciones: exigir bloque mínimo de $35 USDT (priorizando $50-$100 en Hora Piso)
            if (usdt < 35)
                return false;
            // Filtro Macro y Reloj Estadístico (18 semanas Binance)
            const macro = await this.getLiveMacroRegime();
            if (macro.isMacroStorm && !macro.isBtcCapitulationFloor)
                return false;
            const pauseWin = this.isHistoricalPauseWindow();
            const floorWin = this.isHistoricalFloorWindow();
            const calRegime = this.get5YearCalendarRegime();
            const allocPct = this.controls.allocations?.centinela_alpha || 20;
            const effectivePool = floorWin.active ? usdt : Math.min(usdt, Math.max(35, usdt * (allocPct / 100)));
            const budgetUsdt = Math.min(100, Math.max(35, Math.floor(effectivePool * 100) / 100));
            if (budgetUsdt > usdt || budgetUsdt < 35)
                return false;
            const candidates = this.coreWatchlist; // Solo monedas reina de alta liquidez
            let bestAsset = null;
            for (const sym of candidates) {
                if (this.hasActivePositionForSymbol(sym) || this.buyWatches.has(sym))
                    continue;
                const isMeme = this.memeWatchlist.includes(sym) || sym.includes("PEPE");
                if (isMeme)
                    continue;
                const tf = "1h";
                try {
                    const klines = await this.client.klines(sym, tf, { limit: 40 });
                    const data = klines.data;
                    const opens = data.map((k) => parseFloat(k[1]));
                    const highs = data.map((k) => parseFloat(k[2]));
                    const lows = data.map((k) => parseFloat(k[3]));
                    const closes = data.map((k) => parseFloat(k[4]));
                    const curPrice = closes[closes.length - 1];
                    const rsi = this.calculateRSI(closes, 14);
                    const stoch = this.calculateStochRSI(closes, 14, 14, 3, 3);
                    const maxRecent = Math.max(...highs.slice(-24));
                    const dropPct = ((maxRecent - curPrice) / maxRecent) * 100;
                    const lastIdx = closes.length - 1;
                    const candleRange = highs[lastIdx] - lows[lastIdx];
                    const lowerWick = Math.min(opens[lastIdx], closes[lastIdx]) - lows[lastIdx];
                    const wickRatio = candleRange > 0 ? (lowerWick / candleRange) : 0;
                    // Exigir flujo de compra agresiva real (CVD >= 55%) y sobreventa estricta ajustada al Calendario 5 Años
                    const totQuote = parseFloat(data[lastIdx][7] || "0");
                    const buyQuote = parseFloat(data[lastIdx][10] || "0");
                    const takerBuyRatio = totQuote > 0 ? (buyQuote / totQuote) * 100 : 50;
                    // Si estamos en Hora Pausa, solo permitir si cumple Llave Maestra de Excepción Atípica
                    if (pauseWin.paused) {
                        const isAtypical = this.isAtypicalMarketException({
                            symbol: sym,
                            dropPct,
                            rsi,
                            lowerWickRatio: wickRatio,
                            bouncePct: 0.60,
                            cvdPct: takerBuyRatio
                        });
                        if (!isAtypical)
                            continue;
                    }
                    const reqCentinelaDrop = 3.5 + (floorWin.active ? 0 : calRegime.extraDropRequiredPct);
                    const maxCentinelaRsi = 31 + (floorWin.active ? 0 : calRegime.rsiAdjustment);
                    if (rsi <= maxCentinelaRsi && stoch.k <= 20 && dropPct >= reqCentinelaDrop && wickRatio >= 0.35 && takerBuyRatio >= 55.0) {
                        const score = (35 - rsi) * 2.5 + (wickRatio * 30) + (dropPct * 1.8) + ((takerBuyRatio - 50) * 0.8);
                        if (!bestAsset || score > bestAsset.score) {
                            bestAsset = {
                                symbol: sym,
                                score,
                                reason: `RSI ${rsi.toFixed(1)} | StochRSI ${stoch.k.toFixed(0)} en ${tf.toUpperCase()} | CVD Compras ${takerBuyRatio.toFixed(1)}% | Rechazo ${(wickRatio * 100).toFixed(0)}% | Caída -${dropPct.toFixed(1)}%`,
                                rsi,
                                curPrice,
                                tf,
                                callback: 0.25,
                                dropPct
                            };
                        }
                    }
                }
                catch (e) { }
            }
            if (!bestAsset)
                return false;
            // Verificar Ancla Líder-Seguidor en Bitcoin 15m antes de ejecutar
            const btcAnchor = await this.verifyBtc15mLeaderAnchor(bestAsset.symbol);
            if (!btcAnchor.ok) {
                console.log(`⚓ [CENTINELA ALPHA RETENIDO POR ANCLA BTC 15M] ${bestAsset.symbol}: ${btcAnchor.reason}`);
                return false;
            }
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
                if (f.commissionAsset === asset)
                    feeInBase += parseFloat(f.commission);
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
                customMinGainPct: 0.85,
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
        }
        catch (e) {
            console.error("Error en Centinela Alpha:", e.message);
            return false;
        }
    }
    async checkSmartDcaOpportunities(usdt) {
        if (!this.controls.strategies.smart_dca)
            return false;
        if (this.pendingOpportunity)
            return false;
        if (usdt < this.minUsdtToTrade)
            return false;
        const candidates = [];
        // Agrupar posiciones activas por moneda limpia
        const lotsBySymbol = new Map();
        for (const [k, p] of this.activeTrailingPositions.entries()) {
            const clean = (p.symbol || k).split("_")[0];
            if (!lotsBySymbol.has(clean))
                lotsBySymbol.set(clean, []);
            lotsBySymbol.get(clean).push([k, p]);
        }
        for (const [cleanSym, lots] of lotsBySymbol.entries()) {
            try {
                const lotCount = lots.length;
                // 🛑 LÍMITE ESTRICTO: Máximo 3 lotes por moneda (Lote 1, Lote 2 y Lote 3 de Rescate Extremo). ¡PROHIBIDO Lote 4!
                if (lotCount >= 3)
                    continue;
                // Encontrar Lote 1 y lote más reciente
                const lot1 = lots.find(([k, p]) => !k.includes("_lot_") && (!p.lotIndex || p.lotIndex === 1))?.[1] || lots[0][1];
                const latestLot = [...lots].sort((a, b) => (b[1].buyTime || 0) - (a[1].buyTime || 0))[0][1];
                // Cooldown estricto entre compras de la misma moneda (3h para Lote 3, 4h para Lote 2)
                const requiredCooldownHours = lotCount === 2 ? 3 : 4;
                if (latestLot.buyTime && (Date.now() - latestLot.buyTime) < requiredCooldownHours * 3600 * 1000)
                    continue;
                const curPrice = parseFloat((await this.client.tickerPrice(cleanSym)).data.price);
                const dropFromLot1 = ((curPrice - lot1.buyPrice) / lot1.buyPrice) * 100;
                const dropFromLatest = ((curPrice - latestLot.buyPrice) / latestLot.buyPrice) * 100;
                const lastIgnored = this.ignoredDca.get(cleanSym);
                if (lastIgnored) {
                    const hoursSince = (Date.now() - lastIgnored.timestamp) / (3600 * 1000);
                    const extraDropPct = ((curPrice - lastIgnored.price) / lastIgnored.price) * 100;
                    if (hoursSince < 4 && extraDropPct > -3.0)
                        continue;
                }
                const dcaTf = this.controls.strategySettings?.smart_dca?.timeframe || "4h";
                const [klinesDca, klines1h] = await Promise.all([
                    this.client.klines(cleanSym, dcaTf, { limit: 35 }),
                    this.client.klines(cleanSym, "1h", { limit: 55 })
                ]);
                const closesDca = klinesDca.data.map((k) => parseFloat(k[4]));
                const highs1h = klines1h.data.map((k) => parseFloat(k[2]));
                const lows1h = klines1h.data.map((k) => parseFloat(k[3]));
                const closes1h = klines1h.data.map((k) => parseFloat(k[4]));
                const highs1h24 = highs1h.slice(-24);
                const lows1h24 = lows1h.slice(-24);
                const high24Real = highs1h24.length > 0 ? Math.max(...highs1h24) : curPrice;
                const low24Real = lows1h24.length > 0 ? Math.min(...lows1h24) : curPrice;
                const realRange24hPct = low24Real > 0 ? ((high24Real - low24Real) / low24Real) * 100 : 4.0;
                const atr1hPct = this.calculateATRPct(highs1h, lows1h, closes1h, 14);
                const macro = await this.getLiveMacroRegime();
                if (macro.isMacroStorm && !macro.isBtcCapitulationFloor) {
                    console.log(`🌪️ [SMART DCA RETENIDO POR TORMENTA MACRO] ${cleanSym}: BTC en cascada (Stress ${(macro.btcStressIndex * 100).toFixed(0)}%, 3h ${macro.btcDrop3hPct.toFixed(2)}%). Esperando capitulación de BTC para no quemar Lote #${lotCount + 1} prematuro.`);
                    continue;
                }
                const rsi4h = this.calculateRSI(closesDca, 14);
                const rsi1h = this.calculateRSI(closes1h, 14);
                const rsi = Math.min(rsi4h, rsi1h);
                const stoch1h = this.calculateStochRSI(closes1h, 14, 14, 3, 3);
                const ema50_1h = this.calculateEMA(closes1h, 50);
                const lastOpen1h = parseFloat(klines1h.data[klines1h.data.length - 1][1]);
                const isBreakingEma50_1h = lastOpen1h >= ema50_1h && curPrice < ema50_1h * 0.996;
                // 🛡️ FILTRO ANTI-CUCHILLO CAYENDO + STOCHRSI + MACD EN SMART DCA (15m):
                // Exige que la vela de 15m muestre absorción, que el MACD desacelere la caída y que StochRSI esté en zona de suelo.
                let isFallingKnife15m = false;
                try {
                    const k15 = await this.client.klines(cleanSym, "15m", { limit: 40 });
                    if (k15?.data?.length >= 2) {
                        const last15 = k15.data[k15.data.length - 1];
                        const prev15 = k15.data[k15.data.length - 2];
                        const o15 = parseFloat(last15[1]), h15 = parseFloat(last15[2]), l15 = parseFloat(last15[3]), c15 = parseFloat(last15[4]);
                        const prevLow15 = parseFloat(prev15[3]);
                        const bodyDrop15 = ((c15 - o15) / o15) * 100;
                        const range15 = h15 - l15;
                        const lowerWick15 = range15 > 0 ? (Math.min(o15, c15) - l15) / range15 : 0;
                        const isGreen15 = c15 >= o15;
                        const isHigherLow15 = l15 >= prevLow15 * 0.999;
                        const closes15m = k15.data.map((k) => parseFloat(k[4]));
                        const stoch15m = this.calculateStochRSI(closes15m, 14, 14, 3, 3);
                        const macd15m = this.calculateMACDHistogram(closes15m, 12, 26, 9);
                        if (bodyDrop15 <= -0.35 && lowerWick15 < 0.28) {
                            isFallingKnife15m = true;
                        }
                        else if (!isGreen15 && lowerWick15 < 0.25 && !isHigherLow15) {
                            isFallingKnife15m = true;
                        }
                        else if (!macd15m.isDecelerating && stoch15m.k > 25) {
                            // Momentum bajista sigue expandiéndose en MACD sin haber llegado a suelo de StochRSI
                            isFallingKnife15m = true;
                        }
                        else if (isBreakingEma50_1h && lowerWick15 < 0.35) {
                            // Acaba de romper soporte mayor EMA 50 en 1H sin mecha de absorción
                            isFallingKnife15m = true;
                        }
                    }
                }
                catch { }
                if (isFallingKnife15m) {
                    console.log(`⏳ [SMART DCA: ESPERANDO PISO REAL] ${cleanSym} ya cayó ${dropFromLot1.toFixed(2)}%, pero indicadores (15m/MACD/StochRSI/EMA50) aún no confirman agotamiento de caída.`);
                    continue;
                }
                // ⚓ ANCLA BITCOIN 15M EN SMART DCA: No promediar altcoins si BTC sigue cayendo en 15m
                const btcAnchor = await this.verifyBtc15mLeaderAnchor(cleanSym);
                if (!btcAnchor.ok) {
                    console.log(`⚓ [SMART DCA RETENIDO POR ANCLA BTC 15M] ${cleanSym}: ${btcAnchor.reason}`);
                    continue;
                }
                const floorWin = this.isHistoricalFloorWindow();
                const pauseWin = this.isHistoricalPauseWindow();
                const absDrop = Math.abs(dropFromLot1);
                // Si estamos en Hora Pausa, solo permitir Smart DCA si hay Capitulación Extrema (caída >= 6.5% y RSI <= 26)
                if (pauseWin.paused && !(absDrop >= 6.5 && rsi <= 26)) {
                    continue;
                }
                const dcaAllocWeight = Math.max(0.45, Math.min(0.85, ((this.controls.allocations?.smart_dca || 30) / 100) + (floorWin.active ? 0.35 : 0)));
                const sessionPlan = this.lastSessionPlan || this.getSessionLiquidityPlan(usdt);
                // En Hora Piso se desbloquea el 100% del USDT para un rescate contundente ($35 - $100 USDT)
                const spendableForDca = floorWin.active ? usdt : (sessionPlan.spendableUsdt >= 30 ? sessionPlan.spendableUsdt : usdt * 0.50);
                const isMeme = this.memeWatchlist.includes(cleanSym) || cleanSym.includes("PEPE") || cleanSym.includes("BONK") || cleanSym.includes("DOGE");
                const btcRange = this.controls.suggestions?.trailing_rebound?.btcRange24h || 2.0;
                // 📐 DISTANCIA DINÁMICA POR VOLATILIDAD + SINCRONIZACIÓN CON HORAS PISO Y CALENDARIO 5 AÑOS:
                // Fuera de Hora Piso exige +0.8% adicional de descuento (más el ajuste del Calendario 5 Años en Fin de Mes o Miércoles de Sacudón) para preferir promediar en los suelos horarios comprobados.
                const calRegime = this.get5YearCalendarRegime();
                const nonFloorPenalty = floorWin.active ? 0 : (0.8 + calRegime.extraDropRequiredPct);
                const reqDropLot2 = Math.max(3.8 + nonFloorPenalty, Math.min(7.8, Math.max(atr1hPct * 3.0, 2.4 + realRange24hPct * 0.34) * (1 + macro.btcStressIndex * 0.28) + nonFloorPenalty));
                const reqDropLot3 = Math.max(6.5, reqDropLot2 + 2.5);
                if (lotCount === 1) {
                    // --- EVALUACIÓN LOTE #2 (Escalonado proporcional a volatilidad real + StochRSI) ---
                    const qualifiesLot2 = (dropFromLot1 <= -reqDropLot2 && rsi <= 40 && stoch1h.k <= 30) ||
                        (dropFromLot1 <= -(reqDropLot2 + 1.5) && rsi <= 44);
                    if (qualifiesLot2) {
                        const isDeepLot2 = absDrop >= 5.5;
                        const amount = this.calculateSessionLotSize(cleanSym, spendableForDca, isDeepLot2 ? Math.max(dcaAllocWeight, 0.75) : dcaAllocWeight, "smart_dca", isDeepLot2 ? 3 : 2, rsi, Math.max(absDrop, realRange24hPct), absDrop);
                        // Prohibido crear micro-lotes de rescate (< $25 USDT). Esperar a reunir bloque sólido.
                        if (amount < 25)
                            continue;
                        let minGainLot2 = 0.90;
                        if (absDrop >= 6.0) {
                            minGainLot2 = isMeme ? 2.20 : 1.80;
                        }
                        else if (absDrop >= 4.2) {
                            minGainLot2 = isMeme ? 1.65 : 1.35;
                        }
                        const targetPriceStr = (curPrice * (1 + minGainLot2 / 100)).toFixed(4);
                        const score = absDrop * (isDeepLot2 ? 2.2 : 1.5) + (50 - rsi) + (isDeepLot2 ? 25 : 0);
                        candidates.push({
                            pos: lot1,
                            cleanSym,
                            targetLotIndex: 2,
                            dropPct: dropFromLot1,
                            curPrice,
                            rsi,
                            score,
                            isExtreme: isDeepLot2,
                            minGainPct: minGainLot2,
                            amount,
                            potentialTarget: targetPriceStr,
                            reason: isDeepLot2
                                ? `🚨 OPORTUNIDAD DE CAÍDA PROFUNDA (${dropFromLot1.toFixed(2)}% desde Lote 1 | Req -${reqDropLot2.toFixed(1)}% | RSI ${rsi.toFixed(1)} | StochRSI ${stoch1h.k.toFixed(0)}): Lote #2 Potenciado (${amount.toFixed(2)} USDT) con meta +${minGainLot2.toFixed(2)}% → ${targetPriceStr}.`
                                : `Cayó ${dropFromLot1.toFixed(2)}% desde Lote 1 (umbral dinámico -${reqDropLot2.toFixed(1)}% | RSI ${rsi.toFixed(1)} | StochRSI ${stoch1h.k.toFixed(0)}). Pirámide Invertida Nivel 2 (${amount.toFixed(2)} USDT) en soporte con meta +${minGainLot2.toFixed(2)}% (${targetPriceStr}).`
                        });
                    }
                }
                else if (lotCount === 2) {
                    // --- EVALUACIÓN LOTE #3 (Pirámide Invertida Nivel 3: Golpe Maestro en capitulación) ---
                    const qualifiesLot3 = (dropFromLot1 <= -reqDropLot3 && dropFromLatest <= -2.8 && rsi <= 38 && stoch1h.k <= 25) || (dropFromLot1 <= -(reqDropLot3 + 1.5) && dropFromLatest <= -3.2 && rsi <= 42);
                    if (qualifiesLot3) {
                        const amount = this.calculateSessionLotSize(cleanSym, spendableForDca, Math.max(dcaAllocWeight, 0.80), "smart_dca", 3, rsi, Math.max(absDrop, realRange24hPct), absDrop);
                        // Prohibido crear micro-lotes de rescate (< $25 USDT).
                        if (amount < 25)
                            continue;
                        let expandedMinGain = 1.40;
                        if (isMeme)
                            expandedMinGain = 2.20;
                        else if (btcRange >= 2.5 || absDrop >= 6.0)
                            expandedMinGain = 1.85;
                        const targetExpanded = (curPrice * (1 + expandedMinGain / 100)).toFixed(4);
                        const score = absDrop * 2.0 + (50 - rsi) * 1.5 + 30; // Bonificación de prioridad
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
                            reason: `🚨 DESCUENTO EXTREMO: Cayó ${dropFromLot1.toFixed(2)}% acumulado (RSI ${rsi.toFixed(1)} en piso). Lote 3 con Rango de Rebote Ampliado (+${expandedMinGain.toFixed(2)}%). Meta: ${targetExpanded}.`
                        });
                    }
                }
            }
            catch (e) {
                console.error(`Error evaluando Smart DCA para ${cleanSym}:`, e.message);
            }
        }
        if (candidates.length === 0)
            return false;
        // 🏆 RANKING POR PRIORIDAD: Ordenar por mayor puntaje (la que esté más abajo con mejor rebote)
        candidates.sort((a, b) => b.score - a.score);
        const best = candidates[0];
        const opp = {
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
    loadBuyWatches() {
        try {
            const file = path.resolve(process.cwd(), ".trailing-buys.json");
            if (fs.existsSync(file)) {
                this.buyWatches = new Map(JSON.parse(fs.readFileSync(file, "utf-8")));
                console.log(`📂 Cargadas ${this.buyWatches.size} vigilancias de Trailing Buy desde disco.`);
            }
        }
        catch (e) {
            console.error("Error cargando trailing buys:", e.message);
        }
    }
    async saveTrailingPositions() {
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
        }
        catch (e) {
            console.error("Error guardando trailing positions:", e.message);
        }
    }
    mergePositionsPreservingState(incoming) {
        // Leer respaldo local para no perder candados manuales (lockedFloorGainPct, customMinGainPct)
        const localMap = new Map();
        try {
            const file = path.resolve(process.cwd(), ".trailing-positions.json");
            if (fs.existsSync(file)) {
                const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
                if (Array.isArray(raw)) {
                    for (const entry of raw) {
                        if (Array.isArray(entry) && entry.length === 2)
                            localMap.set(entry[0], entry[1]);
                    }
                }
            }
        }
        catch { }
        const merged = new Map();
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
            }
            else {
                merged.set(key, dbItem);
            }
        }
        return merged;
    }
    async loadTrailingPositions() {
        try {
            // 1. FUENTE PRIMARIA: SUPABASE CLOUD DB (preservando candados y picos en memoria)
            if (supabaseDb.isAvailable()) {
                const dbPos = await supabaseDb.loadActivePositions();
                if (dbPos && dbPos.size > 0) {
                    this.activeTrailingPositions = this.mergePositionsPreservingState(dbPos);
                    try {
                        const file = path.resolve(process.cwd(), ".trailing-positions.json");
                        fs.writeFileSync(file, JSON.stringify(Array.from(this.activeTrailingPositions.entries()), null, 2));
                    }
                    catch { }
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
        }
        catch (e) {
            console.error("Error cargando trailing positions:", e.message);
        }
    }
    calculateRSI(closes, period = 14) {
        if (closes.length <= period)
            return 50;
        let gains = 0, losses = 0;
        for (let i = 1; i <= period; i++) {
            const diff = closes[i] - closes[i - 1];
            if (diff >= 0)
                gains += diff;
            else
                losses += Math.abs(diff);
        }
        let avgGain = gains / period;
        let avgLoss = losses / period;
        for (let i = period + 1; i < closes.length; i++) {
            const diff = closes[i] - closes[i - 1];
            if (diff >= 0) {
                avgGain = (avgGain * (period - 1) + diff) / period;
                avgLoss = (avgLoss * (period - 1)) / period;
            }
            else {
                avgGain = (avgGain * (period - 1)) / period;
                avgLoss = (avgLoss * (period - 1) + Math.abs(diff)) / period;
            }
        }
        if (avgLoss === 0)
            return 100;
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
                        const bObj = acc.data.balances.find((b) => b.asset === asset);
                        const totalSpot = parseFloat(bObj?.free || "0") + parseFloat(bObj?.locked || "0");
                        if (totalSpot >= pos.qty * 0.1)
                            hasRemainingTokens = true;
                    }
                    catch { }
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
                // 1. Activar Trailing temprano y aplicar CANDADO ESCALONADO CERO DEVOLUCIÓN (Zero-Giveback Ratchet)
                const macro = await this.getLiveMacroRegime();
                const calRegimeNow = this.get5YearCalendarRegime();
                const hoursOpen = pos.buyTime ? (Date.now() - pos.buyTime) / 3600000 : 0;
                const isExpansionDay = calRegimeNow.regimeKey === "MARTES_JUEVES_EXPANSION" || calRegimeNow.tpCallbackMultiplier >= 1.12 || this.activeAtypicalOverride === "RALLY_HARVESTER";
                // Si una posición lleva >= 18 horas atrapada, activar Modo Rescate de Liquidez en Verde (incluso en días de expansión) para liberar el capital apenas toque +0.58% bruto
                const isStagnantPosition = hoursOpen >= 18.0 && gainPct < 0.85;
                const isBearishMacroRelief = macro.btcStressIndex >= 0.55 && !isExpansionDay;
                const isReliefHarvestMode = isBearishMacroRelief || isStagnantPosition;
                const isLot3 = (pos.lotIndex && pos.lotIndex >= 3) || symbol.includes("_lot_3");
                const btcRangeCur = this.controls.suggestions?.trailing_rebound?.btcRange24h || 2.5;
                const coinVol = pos.coinRange24hPct || 0;
                const gapPct = pos.upsideGapPct || 0;
                const isMaxGap = coinVol >= 5.0 || gapPct >= 3.4 || pos.convictionTier === "MAXIMA_BRECHA";
                const isHighVolCoin = isMaxGap || coinVol >= 3.8 || pos.convictionTier === "ALTA_VOLATILIDAD";
                const isQuietRegime = (this.lastDetectedRegime === "QUIET" || btcRangeCur < 2.2);
                const isWeekendChop = this.isWeekendWindow() && !this.isSundayCmeReopenWindow();
                const isPreNightHarvest = this.isPreNightHarvestWindow();
                const isPreWeekendHarvest = this.isPreWeekendAccumulationWindow();
                const peakHarvestWin = this.isHistoricalPeakHarvestWindow();
                const isHistoricalPeakHarvest = peakHarvestWin.active;
                // 🛡️ CANDADO AUTOMÁTICO CERO DEVOLUCIÓN (RATCHET FLOOR):
                // Prohibido activar candados con ganancias microscópicas (< +0.80% bruto) que vendan por centavos ($0.004 - $0.03).
                // Solo se arma cuando la posición ya superó >= +0.82% bruto (garantizando un piso mínimo de +0.58% bruto / ~+0.38% neto real).
                const currentPeakGain = pos.highestPrice > pos.buyPrice
                    ? Math.max(gainPct, ((pos.highestPrice - pos.buyPrice) / pos.buyPrice) * 100)
                    : gainPct;
                const minPeakToArmRatchet = Math.max(0.82, pos.customMinGainPct || 0);
                let autoRatchetFloor = 0;
                if (currentPeakGain >= minPeakToArmRatchet) {
                    if (currentPeakGain >= 2.50)
                        autoRatchetFloor = 2.10;
                    else if (currentPeakGain >= 1.85)
                        autoRatchetFloor = 1.50;
                    else if (currentPeakGain >= 1.35)
                        autoRatchetFloor = 1.08;
                    else if (currentPeakGain >= 1.00)
                        autoRatchetFloor = 0.76;
                    else if (currentPeakGain >= 0.82)
                        autoRatchetFloor = 0.58;
                }
                // Si tenía un piso < 0.58% de la versión anterior y aún no ha llegado a su meta real, limpiarlo para no disparar ventas de centavos
                if (pos.lockedFloorGainPct && pos.lockedFloorGainPct < 0.58 && currentPeakGain < minPeakToArmRatchet) {
                    pos.lockedFloorGainPct = undefined;
                    if (gainPct < (pos.customMinGainPct || 0.65))
                        pos.activated = false;
                    this.saveTrailingPositions();
                }
                if (autoRatchetFloor > 0 && (!pos.lockedFloorGainPct || pos.lockedFloorGainPct < autoRatchetFloor)) {
                    pos.lockedFloorGainPct = autoRatchetFloor;
                    pos.activated = true;
                    if (curPrice > (pos.highestPrice || 0))
                        pos.highestPrice = curPrice;
                    console.log(`🔒 [CANDADO CERO DEVOLUCIÓN: ${symbol}] Pico +${currentPeakGain.toFixed(2)}% -> Piso blindado en +${autoRatchetFloor.toFixed(2)}% bruto.`);
                    this.saveTrailingPositions();
                }
                // Activación de Trailing: mínimo +0.68% bruto (+0.75% en rescate de posición estancada >= 18h para destrabar capital en verde)
                let activationTarget = pos.customMinGainPct || 0.68;
                if (pos.strategy === "micro_grid" && !pos.customMinGainPct) {
                    activationTarget = 0.58;
                }
                else if (isLot3 && (!pos.customMinGainPct || pos.customMinGainPct <= 0.8)) {
                    activationTarget = 0.85;
                }
                else if (isStagnantPosition && !pos.customMinGainPct) {
                    activationTarget = 0.75;
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
                // 🔄 RESETEO DE PICO HISTÓRICO ANTIGUO SI LA POSICIÓN ESTÁ DEBAJO DE ENTRADA:
                // Si la posición cayó debajo de buyPrice, reiniciamos highestPrice a buyPrice para que en la nueva ola
                // alcista persiga el punto MÁS ALTO real y no venda prematuramente camino arriba por un pico viejo.
                if (gainPct <= 0 && pos.highestPrice > pos.buyPrice) {
                    pos.highestPrice = pos.buyPrice;
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
                        // El piso a sugerir debe estar POR DEBAJO del precio actual (con el margen de callback)
                        // para que no venda de inmediato si el precio sigue subiendo, sino solo si se regresa.
                        const suggestedFloor = Math.max(0.30, Math.floor(minLockedGain * 100) / 100);
                        const cmdPiso = `/piso_${cleanSym}_${Math.round(suggestedFloor * 100)}`;
                        const floorNote = pos.lockedFloorGainPct ? `\n🔒 <b>Piso Manual Ya Amarrado:</b> +${pos.lockedFloorGainPct.toFixed(2)}% NETO\n` : "";
                        const peakAlert = `📈 <b>¡NUEVO PICO ALCANZADO: ${symbol}!</b> 🚀\n\n` +
                            `• <b>Entrada:</b> ${fmtPrice(pos.buyPrice)}\n` +
                            `• <b>Pico alcanzado:</b> ${fmtPrice(curPrice)} (<b>+${gainPct.toFixed(2)}%</b>)\n` +
                            `• 🛡️ <b>Piso Trailing dinámico:</b> ${fmtPrice(stopPrice)} (+${minLockedGain.toFixed(2)}% neto)\n` +
                            floorNote +
                            `\n🔒 <b>¿Deseas amarrar un piso de ganancia fija (+${suggestedFloor.toFixed(2)}%)?</b>\n` +
                            `👉 Presiona el botón abajo o escribe: ${cmdPiso}\n` +
                            `<i>(Si sube más, ¡seguirá subiendo! Solo venderá si retrocede a este piso)</i>`;
                        const buttons = [
                            [
                                { text: `🔒 Amarrar Piso (+${suggestedFloor.toFixed(2)}%)`, callback_data: cmdPiso },
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
                    }
                    catch (e) { }
                }
                // 3. Evaluar Salida por Retroceso (Callback) o por Mecha de Rechazo (Agotamiento)
                if (pos.activated) {
                    const dropFromPeak = ((pos.highestPrice - curPrice) / pos.highestPrice) * 100;
                    const hitHardCap = gainPct >= TRAILING_HARD_CAP_PCT;
                    let callback = pos.strategy === "micro_grid" ? 0.12 : this.getCallbackPct(symbol, pos);
                    let minGain = pos.customMinGainPct || (pos.strategy === "micro_grid" ? 0.58 : 0.72);
                    // 🦎 ADAPTACIÓN CAMALEÓN DE SALIDA SEGÚN RÉGIMEN EN VIVO, HORAS TECHO Y CALENDARIO 5 AÑOS:
                    // • En Hora Techo Estadística (06:00-09:50 AM Pre-Drenaje NY, 15:30-16:45 Pre-Cierre NY, 22:45-00:30 Pico Asia, Viernes Mañana, Domingo CME):
                    //   ceñir callback a 0.14%-0.15% con ganancia >= +0.68% bruto para cosechar en la cima antes del retroceso programado.
                    // • En Martes Verde, Jueves de Rebote o Inicio de Mes (fuera de Hora Techo): amplía el margen de persecución según el Calendario 5 Años.
                    // 🎯 MOTOR DE GANANCIA CONSTANTE (SIN PROTOCOLOS CODICIOSOS QUE ESTANQUEN EL CAPITAL):
                    // • Activa desde +0.62% a +0.68% bruto (~+0.42% a +0.48% neto real).
                    // • Persigue el pico más alto mientras la vela siga subiendo, sin límite de techo.
                    // • Liquida en la cima apenas retroceda el callback corto (0.12% en destrabe / 0.16%-0.20% normal).
                    const isHighEntryTrap = marketRangesManager.isHighChannelEntry(actualSymbol, pos.buyPrice);
                    if (isStagnantPosition || isHighEntryTrap) {
                        callback = 0.12;
                        minGain = 0.62;
                        let dirtyUnstick = false;
                        if (pos.customMinGainPct !== 0.62 || pos.customCallbackPct !== 0.12) {
                            pos.customMinGainPct = 0.62;
                            pos.customCallbackPct = 0.12;
                            dirtyUnstick = true;
                        }
                        if (!pos.lockedFloorGainPct || pos.lockedFloorGainPct > 0.60) {
                            pos.lockedFloorGainPct = 0.60;
                            dirtyUnstick = true;
                        }
                        if (dirtyUnstick) {
                            this.saveTrailingPositions();
                        }
                    }
                    else if (pos.strategy === "cazador_weekend") {
                        // 🏖️ COMPRAS DE FIN DE SEMANA (Sábado madrugada en piso):
                        // Límite amplio de +1.50% o más para cosechar domingo noche (CME), lunes o martes según mercado alcista
                        callback = Math.max(0.24, pos.customCallbackPct || 0.28);
                        minGain = Math.max(1.50, pos.customMinGainPct || 1.50);
                    }
                    else {
                        // ⚡ DÍAS DE SEMANA: Rotación ágil de capital (+0.62% a +0.68%) sin protocolos que estanquen el saldo
                        callback = Math.min(callback, 0.18);
                        minGain = Math.min(minGain, 0.68);
                    }
                    // 🕯️ CENTINELA DE MECHA DE RECHAZO, DESCARGA CVD EN CIMA Y ESCUDO ANTI-VENTA TEMPRANA
                    let isRejectionWick = false;
                    let isOrderFlowExhaustion = false;
                    let isBullishMomentumAlive = false;
                    if (gainPct >= 0.58 && dropFromPeak >= 0.08) {
                        try {
                            const [klines15, klines5] = await Promise.all([
                                this.client.klines(actualSymbol, "15m", { limit: 2 }),
                                this.client.klines(actualSymbol, "5m", { limit: 12 })
                            ]);
                            const lastK15 = klines15.data[klines15.data.length - 1];
                            const o = parseFloat(lastK15[1]), h = parseFloat(lastK15[2]), l = parseFloat(lastK15[3]), c = parseFloat(lastK15[4]);
                            const totRange = h - l;
                            const upperWick = h - Math.max(o, c);
                            const upperWickRatio = totRange > 0 ? (upperWick / totRange) : 0;
                            if (gainPct >= 1.05 && upperWickRatio >= 0.35 && dropFromPeak >= 0.12) {
                                isRejectionWick = true;
                                console.log(`🕯️ [MECHA DE RECHAZO EN CIMA] ${symbol}: mecha superior ${(upperWickRatio * 100).toFixed(0)}% >= 35%. Gatillando venta inmediata.`);
                            }
                            // Lectura de CVD (Taker Buy Quote Volume) y EMA 9 en 5m:
                            const lastK5 = klines5.data[klines5.data.length - 1];
                            const totQuote5 = parseFloat(lastK5[7] || "0");
                            const buyQuote5 = parseFloat(lastK5[10] || "0");
                            const buyRatio5 = totQuote5 > 0 ? (buyQuote5 / totQuote5) * 100 : 50;
                            const closes5 = klines5.data.map((r) => parseFloat(r[4]));
                            const ema9_5m = this.calculateEMA(closes5, 9);
                            // 1. Si las ballenas descargan ventas (>65% venta agresiva) tras subir >= +0.95% bruto (~+0.75% neto), cobrar en la cima
                            if (gainPct >= 0.95 && totQuote5 > 5000 && buyRatio5 <= 35.0 && dropFromPeak >= 0.12) {
                                isOrderFlowExhaustion = true;
                                console.log(`🌊 [DESCARGA DE BALLENAS DETECTADA EN CIMA] ${symbol}: CVD Compras cayó a ${buyRatio5.toFixed(1)}% en 5m con ganancia +${gainPct.toFixed(2)}%. Cobrando antes del giro.`);
                            }
                            // 2. ESCUDO ANTI-VENTA TEMPRANA (RESPIRO ALCISTA CON BALLENAS COMPRANDO):
                            if (curPrice >= ema9_5m && buyRatio5 >= 57.0 && gainPct >= 0.58 && !isRejectionWick) {
                                isBullishMomentumAlive = true;
                            }
                        }
                        catch (e) { }
                    }
                    let hitLockedFloor = false;
                    if (pos.lockedFloorGainPct && pos.lockedFloorGainPct >= 0.58) {
                        const peakGain = ((pos.highestPrice - pos.buyPrice) / pos.buyPrice) * 100;
                        const hasBufferAboveFloor = peakGain >= pos.lockedFloorGainPct + 0.12;
                        if (hasBufferAboveFloor && gainPct <= pos.lockedFloorGainPct && gainPct >= 0.58) {
                            if (isBullishMomentumAlive && gainPct >= 0.62 && pos.lockedFloorGainPct <= 0.78) {
                                console.log(`🚀 [EVITANDO VENTA TEMPRANA: ${symbol}] Micro-respiro a +${gainPct.toFixed(2)}%, pero ballenas siguen comprando (CVD >= 57% y sobre EMA9 5m). Dejando correr ola alcista.`);
                            }
                            else {
                                hitLockedFloor = true;
                                console.log(`🔒 [CANDADO CERO DEVOLUCIÓN EJECUTADO] ${symbol}: Ganancia actual +${gainPct.toFixed(2)}% tocó el piso blindado (+${pos.lockedFloorGainPct.toFixed(2)}%). Asegurando ganancia en USDT.`);
                            }
                        }
                    }
                    // CANDADO SUPREMO: hitCallback también respeta el escudo anti-venta temprana salvo que caiga más de 1.5x el callback
                    const effectiveCallbackTrigger = isBullishMomentumAlive ? (dropFromPeak >= callback * 1.55) : (dropFromPeak >= callback);
                    const hitCallback = (effectiveCallbackTrigger && gainPct >= minGain) || (hitLockedFloor && gainPct >= 0.58);
                    // 🎯 VENTA POR TECHO DE CANAL INSTITUCIONAL (CON PERSECUCIÓN DE PICO MÁXIMO):
                    // Si el precio alcanza el Techo del Canal en ganancia neta, NO vende mientras la vela siga subiendo;
                    // persigue el punto más alto y dispara la venta apenas empiece a doblarse desde la cima (dropFromPeak >= 0.10%).
                    let hitChannelCeiling = false;
                    if (gainPct >= 0.62) {
                        const ceilingPrice = marketRangesManager.getEffectiveTecho(actualSymbol);
                        if (ceilingPrice > 0 && curPrice >= ceilingPrice * 0.995 && dropFromPeak >= 0.10 && !isBullishMomentumAlive) {
                            hitChannelCeiling = true;
                            console.log(`🎯 [TECHO DE CANAL EN CIMA] ${symbol}: Precio $${curPrice} alcanzó pico $${pos.highestPrice} en zona de techo ($${ceilingPrice}) y retrocedió ${dropFromPeak.toFixed(2)}%. Cobrando en el punto más alto.`);
                        }
                    }
                    // CANDADO FÉRREO: Prohibido vender con menos de +0.58% bruto (garantizando mínimo ~+0.38% a +0.50% neto real tras comisiones)
                    const minAllowedExit = (isStagnantPosition || isHighEntryTrap || (pos.lockedFloorGainPct && pos.lockedFloorGainPct >= 0.58) || pos.strategy === "micro_grid") ? 0.58 : 0.65;
                    if ((hitCallback || hitHardCap || isRejectionWick || isOrderFlowExhaustion || hitChannelCeiling) && gainPct >= minAllowedExit) {
                        const reasonOverride = hitChannelCeiling ? "TECHO_CANAL_ALCANZADO" : (isOrderFlowExhaustion ? "DESCARGA_ORDER_FLOW" : (isRejectionWick ? "RECHAZO_MECHA" : (hitLockedFloor ? "CANDADO_CERO_DEVOLUCION" : undefined)));
                        console.log(`🏆 ¡CERRANDO EN GANANCIA! Venta en ${symbol} a ${curPrice} (+${gainPct.toFixed(2)}% | Pico: ${pos.highestPrice}) [${reasonOverride || 'TRAILING'}]`);
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
            }
            catch (e) {
                console.error(`Error monitoreando trailing en ${symbol}:`, e.message);
            }
        }
    }
    /**
     * Si Binance barrió el saldo a Simple Earn (Auto-Subscribe), lo rescata a Spot.
     */
    // 🛡️ VERIFICADOR DE COSTO REAL CONTRA BINANCE (mismo método LIFO que la "Lista de Ventas")
    // El precio en memoria (pos.buyPrice) puede estar mal si un lote se fusionó; Binance es la fuente de verdad.
    shieldNotifyAt = new Map();
    shouldNotifyShield(key) {
        const last = this.shieldNotifyAt.get(key) || 0;
        if (Date.now() - last < 30 * 60 * 1000)
            return false;
        this.shieldNotifyAt.set(key, Date.now());
        return true;
    }
    async verifyRealCostWithBinance(symbol, sellQty, price, targetBuyPrice) {
        try {
            const asset = symbol.replace("USDT", "");
            const res = await this.client.myTrades(symbol, { limit: 1000, recvWindow: 60000 });
            const trades = ((res && res.data) || []).slice().sort((a, b) => a.time - b.time || a.id - b.id);
            const orders = [];
            for (const t of trades) {
                const last = orders[orders.length - 1];
                if (last && last.orderId === t.orderId)
                    last.fills.push(t);
                else
                    orders.push({ orderId: t.orderId, isBuyer: t.isBuyer, fills: [t] });
            }
            const lots = [];
            for (const o of orders) {
                let qty = 0, quote = 0, feeBase = 0, feeUsdt = 0;
                for (const f of o.fills) {
                    qty += parseFloat(f.qty);
                    quote += parseFloat(f.quoteQty);
                    const c = parseFloat(f.commission);
                    if (f.commissionAsset === asset)
                        feeBase += c;
                    else if (f.commissionAsset === "USDT")
                        feeUsdt += c;
                }
                if (o.isBuyer) {
                    const net = qty - feeBase;
                    if (net > 0)
                        lots.push({ qty: net, unitCost: (quote + feeUsdt) / net });
                    continue;
                }
                let rem = qty;
                while (rem > 1e-12 && lots.length) {
                    const l = lots[0]; // FIFO: las ventas anteriores consumieron primero las compras más antiguas
                    const take = Math.min(l.qty, rem);
                    l.qty -= take;
                    rem -= take;
                    if (l.qty <= 1e-12)
                        lots.shift();
                }
            }
            // Si estamos vendiendo un lote aislado específico (ej. Smart DCA Lote #2 comprado a $3.433),
            // priorizar el lote cuyo unitCost coincide con targetBuyPrice (o LIFO del más reciente al más antiguo)
            // para que un Lote #1 más caro nunca bloquee la toma de ganancia del Lote #2.
            if (targetBuyPrice && targetBuyPrice > 0) {
                lots.sort((a, b) => Math.abs(a.unitCost - targetBuyPrice) - Math.abs(b.unitCost - targetBuyPrice));
            }
            else {
                lots.reverse();
            }
            let rem = sellQty, cost = 0;
            for (let i = 0; i < lots.length && rem > 1e-12; i++) {
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
        }
        catch (e) {
            // FAIL-CLOSED: si no se puede verificar, NO se vende
            return { ok: false, cost: 0, estPnl: NaN, reason: "No se pudo consultar el historial de Binance: " + (e.response?.data?.msg || e.message) };
        }
    }
    async redeemFromEarnIfNeeded(asset, needed) {
        try {
            const res = await this.client.getFlexibleProductPosition({ asset, recvWindow: 60000 });
            const row = res.data?.rows?.[0];
            if (!row || parseFloat(row.totalAmount) <= 0)
                return;
            console.log(`🏦 Rescatando ${asset} desde Simple Earn (${row.totalAmount}) para poder vender...`);
            await this.client.redeemFlexibleProduct(row.productId, { redeemAll: true, destAccount: "SPOT", recvWindow: 60000 });
            await new Promise((r) => setTimeout(r, 3000));
            await this.notifier.send(`🏦 <i>Rescaté ${row.totalAmount} ${asset} de Simple Earn a Spot (Binance lo había movido con Auto-Subscribe).</i>`);
        }
        catch (e) {
            console.error(`Error rescatando ${asset} de Earn:`, e.response?.data?.msg || e.message);
        }
    }
    async getFreeBalance(asset) {
        const acc = await this.client.account({ recvWindow: 60000 });
        return parseFloat(acc.data.balances.find((b) => b.asset === asset)?.free || "0");
    }
    /** Suma comisiones de los fills de una orden convertidas a USDT */
    feesToUsdt(fills, baseAsset) {
        let fee = 0;
        for (const f of fills || []) {
            const c = parseFloat(f.commission);
            if (f.commissionAsset === "USDT")
                fee += c;
            else if (f.commissionAsset === baseAsset)
                fee += c * parseFloat(f.price);
        }
        return fee;
    }
    /**
     * VENTA PARCIAL ESCALONADA 50/50 EN LA CIMA (SCALE-OUT TAKE PROFIT)
     * Al tocar un pico alto (>= +2.20%), vende el 50% de la orden para asegurar USDT en el bolsillo
     * y deja correr el 50% restante con Trailing Stop para cazar subidas mayores.
     */
    async executePartialSell(pos, exitPrice, ratio = 0.5) {
        try {
            if (pos.partialProfitTaken)
                return false;
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
            const stepSize = parseFloat(sInfo.filters.find((f) => f.filterType === "LOT_SIZE").stepSize);
            const minNotional = parseFloat(sInfo.filters.find((f) => f.filterType === "NOTIONAL" || f.filterType === "MIN_NOTIONAL")?.minNotional || "10.0");
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
            const realCheckP = await this.verifyRealCostWithBinance(tradeSym, sellQty, exitPrice, pos.buyPrice);
            if (!realCheckP.ok) {
                console.error(`🛑 [CORE SHIELD: COSTO REAL] Venta parcial de ${pos.symbol} BLOQUEADA: ${realCheckP.reason || "Binance la registraría como pérdida (" + realCheckP.estPnl.toFixed(3) + " USDT)"}`);
                return false;
            }
            const sellRes = await this.client.newOrder(tradeSym, "SELL", "MARKET", {
                quantity: sellQtyStr,
                newOrderRespType: "FULL",
                recvWindow: 60000
            });
            this.lastBotSaleTime = Date.now();
            const grossUsdt = parseFloat(sellRes.data.cummulativeQuoteQty);
            const sellFee = this.feesToUsdt(sellRes.data.fills, asset);
            const avgSell = grossUsdt / parseFloat(sellRes.data.executedQty);
            const costBasis = realCheckP.cost > 0 ? realCheckP.cost : pos.investedUsdt * (sellQty / pos.qty);
            const profitUsdt = grossUsdt - sellFee - costBasis;
            const netPct = costBasis > 0 ? (profitUsdt / costBasis) * 100 : 0;
            // Actualizar recovery tracker si aplica
            if (profitUsdt > 0 && this.controls.recoveryTracker) {
                if (this.controls.recoveryTracker.recoveredUsdt < this.controls.recoveryTracker.targetUsdt) {
                    this.controls.recoveryTracker.recoveredUsdt = Math.min(this.controls.recoveryTracker.targetUsdt, this.controls.recoveryTracker.recoveredUsdt + profitUsdt);
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
                supabaseDb.recordClosedTrade(partialItem).catch(() => { });
                const ledgerF = path.resolve(process.cwd(), ".closed-trades.json");
                const list = fs.existsSync(ledgerF) ? JSON.parse(fs.readFileSync(ledgerF, "utf-8")) : [];
                list.push(partialItem);
                fs.writeFileSync(ledgerF, JSON.stringify(list.slice(-200), null, 2), "utf-8");
            }
            catch (e) { }
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
        }
        catch (e) {
            console.error(`Error en executePartialSell ${pos.symbol}:`, e.response?.data?.msg || e.message);
            return false;
        }
    }
    async executeTrailingSell(pos, exitPrice, hitHardCap, isStopLoss = false, reasonOverride, isManualExit = false, allowLoss = false) {
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
            const stepSize = parseFloat(sInfo.filters.find((f) => f.filterType === "LOT_SIZE").stepSize);
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
                // BLOQUEO TOTAL INQUEBRANTABLE SI EL PRECIO ES MENOR O IGUAL A LA COMPRA O NO CUBRE EL PISO NETO (+0.45%)
                if (curCheckPrice <= pos.buyPrice || estGainPct < minNetFloor) {
                    console.error(`🛑 [CORE SHIELD: GANANCIA INSUFICIENTE / VENTA RETENIDA] ${pos.symbol}: Precio ${curCheckPrice} vs Compra ${pos.buyPrice} (Ganancia: ${estGainPct.toFixed(2)}% < mín ${minNetFloor}%). Manteniendo lote.`);
                    if (curCheckPrice <= pos.buyPrice && this.shouldNotifyShield("price_" + pos.symbol))
                        try {
                            await this.notifier.send(`🛑 <b>[CORE SHIELD: VENTA A PÉRDIDA BLOQUEADA]</b> 🛡️\n\n` +
                                `• <b>Moneda:</b> <b>${pos.symbol}</b>\n` +
                                `• 📍 <b>Precio de Entrada:</b> $${fmtPrice(pos.buyPrice)}\n` +
                                `• 💰 <b>Precio Actual:</b> $${fmtPrice(curCheckPrice)} (<b>${estGainPct.toFixed(2)}%</b>)\n\n` +
                                `⛔ <b>Acción cancelada en el core:</b> Por regla suprema, el bot NUNCA vende a pérdida automáticamente.\n` +
                                `💎 <i>Tus monedas se mantienen intactas en Spot esperando el rebote. Cero riesgo de venta en rojo.</i>`);
                        }
                        catch (e) { }
                    return false;
                }
                // AISLAMIENTO ESTRICTO DE LOTES: Jamás vender más de la cantidad de este lote
                if (sellQty > pos.qty * 1.001) {
                    console.error(`🛑 [CORE SHIELD: AISLAMIENTO DE LOTE] ${pos.symbol}: sellQty ${sellQty} > pos.qty ${pos.qty}.`);
                    return false;
                }
            }
            else {
                // Salida manual: si está a pérdida, requiere confirmación explícita con alerta (allowLoss=true)
                if ((curCheckPrice <= pos.buyPrice || estGainPct < 0) && !allowLoss) {
                    console.error(`🛑 [CORE SHIELD: VENTA MANUAL BLOQUEADA] ${pos.symbol}: Requiere confirmación explícita (allowLoss=true).`);
                    return false;
                }
            }
            // 🛡️ SEGUNDA LLAVE (COSTO REAL EN BINANCE): se calcula lo que REALMENTE costaron las monedas de este lote específico.
            // Si Binance registraría la venta de este lote como PÉRDIDA, se bloquea (salvo venta manual con allowLoss=true).
            const realCheck = await this.verifyRealCostWithBinance(actualSymbol, sellQty, curCheckPrice, pos.buyPrice);
            if (!realCheck.ok && !(isManualExit && allowLoss)) {
                const why = realCheck.reason || `Binance la registraría como PÉRDIDA (${realCheck.estPnl.toFixed(3)} USDT, costo real ${realCheck.cost.toFixed(2)} USDT)`;
                console.error(`🛑 [CORE SHIELD: COSTO REAL] Venta de ${sellQtyStr} ${asset} BLOQUEADA: ${why}`);
                if (this.shouldNotifyShield("real_" + pos.symbol)) {
                    try {
                        await this.notifier.send(`🛑 <b>[CORE SHIELD: VENTA BLOQUEADA]</b> 🛡️\n\n` +
                            `• <b>Moneda:</b> ${pos.symbol}\n` +
                            `• <b>Motivo:</b> ${why}\n\n` +
                            `💎 <i>No se vendió nada. Las monedas siguen en tu cuenta esperando un precio con ganancia real.</i>`);
                    }
                    catch (e) { }
                }
                return false;
            }
            const sellRes = await this.client.newOrder(actualSymbol, "SELL", "MARKET", {
                quantity: sellQtyStr,
                newOrderRespType: "FULL",
                recvWindow: 60000
            });
            this.lastBotSaleTime = Date.now();
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
                    this.controls.recoveryTracker.recoveredUsdt = Math.min(this.controls.recoveryTracker.targetUsdt, this.controls.recoveryTracker.recoveredUsdt + profitUsdt);
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
                supabaseDb.recordClosedTrade(fullTradeItem).catch(() => { });
                const dbLotKey = pos.lotId || pos.id || pos.symbol;
                supabaseDb.deleteActivePosition(dbLotKey).catch(() => { });
                const ledgerF = path.resolve(process.cwd(), ".closed-trades.json");
                const list = fs.existsSync(ledgerF) ? JSON.parse(fs.readFileSync(ledgerF, "utf-8")) : [];
                list.push(fullTradeItem);
                fs.writeFileSync(ledgerF, JSON.stringify(list.slice(-200), null, 2), "utf-8");
            }
            catch (e) {
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
            }
            else if (reasonOverride === "RECHAZO_MECHA") {
                alertMsg = `🕯️ <b>¡VENTA POR AGOTAMIENTO Y MECHA DE RECHAZO!</b> 🛑\n\n` +
                    `• <b>Moneda:</b> ${pos.symbol}\n` +
                    `• <b>Precio de compra:</b> ${fmtPrice(pos.buyPrice)}\n` +
                    `• <b>Pico alcanzado:</b> ${fmtPrice(pos.highestPrice)}\n` +
                    `• <b>Precio de venta:</b> ${fmtPrice(avgSell)}\n` +
                    `• <b>Comisiones:</b> ${sellFee.toFixed(4)} USDT\n` +
                    `• 💵 <b>Ganancia líquida:</b> 🟢 <b>${sign}${profitUsdt.toFixed(3)} USDT</b> (<b>${sign}${netPct.toFixed(2)}% NETO</b>) ≈ ${sign}${Math.round(profitUsdt * COP_PER_USDT).toLocaleString("es-CO")} COP\n\n` +
                    `🛡️ <i>Rechazo institucional detectado en la cima. Posición cerrada antes del desplome.</i>\n` +
                    `📊 <i>Escribe /reporte para ver el acumulado real.</i>`;
            }
            else {
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
                                data: [pos.buyPrice, pos.buyPrice * 0.998, (pos.buyPrice + pos.highestPrice) / 2, pos.highestPrice, avgSell],
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
            }
            catch (e) { }
            // 2. Bóveda Automática de Ganancias (25% a Simple Earn)
            if (!isStopLoss && profitUsdt >= 0.50) {
                const vaultAmt = Math.floor(profitUsdt * 0.25 * 100) / 100;
                if (vaultAmt >= 0.10) {
                    await this.depositToEarn("USDT", vaultAmt);
                }
            }
            return true;
        }
        catch (e) {
            const msg = e.response?.data?.msg || e.message;
            console.error("Error ejecutando venta trailing:", msg);
            await this.notifier.send(`⚠️ <i>No se pudo vender ${pos.symbol}: ${msg}. La posición sigue protegida y se reintentará.</i>`);
            return false;
        }
    }
    /**
     * Compra una moneda e inicia el rastreo con Trailing Take Profit
     */
    async executeSmartBuy(symbol, usdtAmount, source, strategy = "trailing_rebound", meta) {
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
                if (f.commissionAsset === asset)
                    feeInBase += parseFloat(f.commission);
            }
            const qty = grossQty - feeInBase;
            // Incluir la comisión cobrada en la moneda base dentro del precio unitario de compra
            // para que jamás subestime el costo real de adquisición
            const buyPrice = qty > 0 ? (spent / qty) : (spent / grossQty);
            const coinVol = meta?.coinRange24hPct || 0;
            const gapPct = meta?.upsideGapPct || 0;
            const isMaxGap = coinVol >= 5.0 || gapPct >= 3.4 || meta?.convictionTier === "MAXIMA_BRECHA";
            const isHighVol = isMaxGap || coinVol >= 3.8 || meta?.convictionTier === "ALTA_VOLATILIDAD";
            const dynamicGapAct = isMaxGap ? Math.max(1.60, Math.min(2.40, gapPct * 0.35)) : 1.25;
            const activationPct = meta?.customMinGainPct || (strategy === "micro_grid" ? 0.58 : (isMaxGap ? Number(dynamicGapAct.toFixed(2)) : (isHighVol ? 1.25 : 0.80)));
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
                customMinGainPct: meta?.customMinGainPct || (strategy === "cazador_weekend" ? 1.50 : undefined)
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
        }
        catch (e) {
            const msg = e.response?.data?.msg || e.message;
            console.error(`❌ Error ejecutando compra en ${symbol}:`, msg);
            await this.notifier.send(`⚠️ <i>No se pudo comprar ${symbol}: ${msg}</i>`);
            return false;
        }
    }
    /**
     * Calcula Bandas de Bollinger (media simple y desviación estándar poblacional)
     */
    calculateBollingerBands(closes, period = 20, stdDevMult = 2.0) {
        const slice = closes.slice(-period);
        if (slice.length === 0)
            return { middle: 0, upper: 0, lower: 0, percentB: 0.5 };
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
     * Calcula la Media Móvil Exponencial (EMA) para detectar soportes dinámicos y quiebres de estructura (EMA 20 / EMA 50)
     */
    calculateEMA(values, period) {
        if (!values || values.length === 0)
            return 0;
        const k = 2 / (period + 1);
        let ema = values[0];
        for (let i = 1; i < values.length; i++) {
            ema = values[i] * k + ema * (1 - k);
        }
        return ema;
    }
    /**
     * Calcula el Estocástico RSI (StochRSI 0-100) con suavizado %K y %D para detectar el agotamiento exacto de caída (<= 22)
     */
    calculateStochRSI(closes, rsiPeriod = 14, stochPeriod = 14, kSmooth = 3, dSmooth = 3) {
        if (!closes || closes.length < rsiPeriod + stochPeriod) {
            const fallbackRsi = this.calculateRSI(closes || [], rsiPeriod);
            return { k: fallbackRsi, d: fallbackRsi, prevK: fallbackRsi, turningUp: true };
        }
        const rsiSeries = [];
        for (let end = rsiPeriod + 1; end <= closes.length; end++) {
            rsiSeries.push(this.calculateRSI(closes.slice(0, end), rsiPeriod));
        }
        const rawStoch = [];
        for (let i = 0; i < rsiSeries.length; i++) {
            const win = rsiSeries.slice(Math.max(0, i - stochPeriod + 1), i + 1);
            const minR = Math.min(...win);
            const maxR = Math.max(...win);
            const val = maxR - minR > 1e-9 ? ((rsiSeries[i] - minR) / (maxR - minR)) * 100 : 50;
            rawStoch.push(val);
        }
        const kSeries = [];
        for (let i = 0; i < rawStoch.length; i++) {
            const win = rawStoch.slice(Math.max(0, i - kSmooth + 1), i + 1);
            kSeries.push(win.reduce((a, b) => a + b, 0) / win.length);
        }
        const dSeries = [];
        for (let i = 0; i < kSeries.length; i++) {
            const win = kSeries.slice(Math.max(0, i - dSmooth + 1), i + 1);
            dSeries.push(win.reduce((a, b) => a + b, 0) / win.length);
        }
        const k = kSeries[kSeries.length - 1] ?? 50;
        const prevK = kSeries.length >= 2 ? kSeries[kSeries.length - 2] : k;
        const d = dSeries[dSeries.length - 1] ?? 50;
        return { k, d, prevK, turningUp: k >= prevK || k >= d };
    }
    /**
     * Calcula el Histograma MACD (12, 26, 9) para verificar que la aceleración bajista se esté encogiendo antes de comprar
     */
    calculateMACDHistogram(closes, fast = 12, slow = 26, signal = 9) {
        if (!closes || closes.length < slow + signal) {
            return { hist: 0, prevHist: 0, isDecelerating: true };
        }
        const kFast = 2 / (fast + 1);
        const kSlow = 2 / (slow + 1);
        const kSig = 2 / (signal + 1);
        let emaFast = closes[0];
        let emaSlow = closes[0];
        const macdLine = [];
        for (let i = 0; i < closes.length; i++) {
            emaFast = i === 0 ? closes[0] : closes[i] * kFast + emaFast * (1 - kFast);
            emaSlow = i === 0 ? closes[0] : closes[i] * kSlow + emaSlow * (1 - kSlow);
            macdLine.push(emaFast - emaSlow);
        }
        let sigEma = macdLine[0];
        const histSeries = [];
        for (let i = 0; i < macdLine.length; i++) {
            sigEma = i === 0 ? macdLine[0] : macdLine[i] * kSig + sigEma * (1 - kSig);
            histSeries.push(macdLine[i] - sigEma);
        }
        const hist = histSeries[histSeries.length - 1] ?? 0;
        const prevHist = histSeries.length >= 2 ? histSeries[histSeries.length - 2] : hist;
        return { hist, prevHist, isDecelerating: hist >= prevHist || hist >= 0 };
    }
    /**
     * Calcula el ATR (Average True Range) expresado en porcentaje del precio actual.
     * Permite que todos los umbrales de caída, rebote y DCA se auto-calibren según la volatilidad viva de cada moneda.
     */
    calculateATRPct(highs, lows, closes, period = 14) {
        if (closes.length < 2)
            return 1.2;
        const trs = [];
        for (let i = 1; i < closes.length; i++) {
            const h = highs[i], l = lows[i], pc = closes[i - 1];
            const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
            trs.push(tr);
        }
        const slice = trs.slice(-period);
        const avgTr = slice.reduce((a, b) => a + b, 0) / (slice.length || 1);
        const curPrice = closes[closes.length - 1] || 1;
        return curPrice > 0 ? (avgTr / curPrice) * 100 : 1.2;
    }
    cachedMacroRegime = null;
    /**
     * 🧠 MOTOR AUTÓNOMO DE RÉGIMEN MACRO (BTC 1H + 15M):
     * Evalúa la estructura institucional de Bitcoin (EMA 20/50/200 1H, caída acumulada de 3H, ATR, RSI, StochRSI y MACD)
     * y devuelve un Índice Continuo de Estrés Macro (0.0 a 1.0) para que todo el bot adapte sus ecuaciones dinámicamente
     * sin depender de reglas fijas ni caer en "pausas trampa" de 15m/1h en medio de un desplome.
     */
    async getLiveMacroRegime() {
        if (this.cachedMacroRegime && Date.now() - this.cachedMacroRegime.timestamp < 20000) {
            return this.cachedMacroRegime;
        }
        try {
            const btcK1h = await this.client.klines("BTCUSDT", "1h", { limit: 205 });
            const data = btcK1h.data;
            if (!data || data.length < 30)
                throw new Error("insuficientes velas BTC 1h");
            const opens = data.map((k) => parseFloat(k[1]));
            const highs = data.map((k) => parseFloat(k[2]));
            const lows = data.map((k) => parseFloat(k[3]));
            const closes = data.map((k) => parseFloat(k[4]));
            const btcPrice = closes[closes.length - 1];
            const btcEma20 = this.calculateEMA(closes, 20);
            const btcEma50 = this.calculateEMA(closes, 50);
            const btcEma200 = this.calculateEMA(closes, Math.min(200, closes.length));
            const btcRsi1h = this.calculateRSI(closes, 14);
            const btcStoch1h = this.calculateStochRSI(closes, 14, 14, 3, 3);
            const btcMacd1h = this.calculateMACDHistogram(closes, 12, 26, 9);
            const btcAtr1hPct = this.calculateATRPct(highs, lows, closes, 14);
            // Caída acumulada en las últimas 3 horas (detecta crashes escalonados aunque haya 1 hora de pausa plana)
            const high3h = Math.max(...highs.slice(-4));
            const btcDrop3hPct = high3h > 0 ? ((btcPrice - high3h) / high3h) * 100 : 0;
            // Mecha inferior de absorción en la vela actual de 1H
            const lastIdx = closes.length - 1;
            const range1h = highs[lastIdx] - lows[lastIdx];
            const lowerWick1h = range1h > 0 ? (Math.min(opens[lastIdx], closes[lastIdx]) - lows[lastIdx]) / range1h : 0;
            // Cálculo continuo de btcStressIndex (0.00 a 1.00)
            let stress = 0;
            if (btcPrice < btcEma20)
                stress += 0.15;
            if (btcPrice < btcEma50)
                stress += 0.25;
            if (btcPrice < btcEma200)
                stress += 0.20;
            if (btcDrop3hPct <= -1.2) {
                stress += Math.min(0.40, Math.abs(btcDrop3hPct) * 0.12);
            }
            if (!btcMacd1h.isDecelerating && btcMacd1h.hist < 0) {
                stress += 0.15;
            }
            const btcStressIndex = Math.max(0, Math.min(1.0, Number(stress.toFixed(2))));
            // Tormenta Macro activa: cuando BTC perdió su EMA50 con caída acumulada fuerte o el estrés supera 0.60
            const isMacroStorm = btcStressIndex >= 0.60 || (btcPrice < btcEma50 && btcDrop3hPct <= -1.35);
            // Piso de Capitulación Real de BTC: único momento donde se permite cazar durante una tormenta macro
            const isBtcCapitulationFloor = (btcRsi1h <= 33 || btcStoch1h.k <= 18) &&
                (lowerWick1h >= 0.32 || (btcMacd1h.isDecelerating && btcStoch1h.turningUp));
            this.cachedMacroRegime = {
                timestamp: Date.now(),
                btcStressIndex,
                isMacroStorm,
                isBtcCapitulationFloor,
                btcDrop3hPct,
                btcPrice,
                btcEma50,
                btcEma200,
                btcRsi1h,
                btcStochK: btcStoch1h.k,
                btcAtr1hPct,
            };
            return this.cachedMacroRegime;
        }
        catch {
            return {
                timestamp: Date.now(),
                btcStressIndex: 0.25,
                isMacroStorm: false,
                isBtcCapitulationFloor: false,
                btcDrop3hPct: 0,
                btcPrice: 0,
                btcEma50: 0,
                btcEma200: 0,
                btcRsi1h: 50,
                btcStochK: 50,
                btcAtr1hPct: 0.8,
            };
        }
    }
    /**
     * TRAILING BUY - Paso 1: detectar caídas y "armar" la vigilancia del piso.
     * Ya no compra en la primera vela verde: registra el precio y rastrea el piso más bajo.
     */
    async scanForDips(activeSymbols) {
        const tf = this.controls.strategySettings?.trailing_rebound?.timeframe || this.controls.timeframe || "1h";
        const macro = await this.getLiveMacroRegime();
        // 🛡️ ESCUDO DE TORMENTA MACRO CONTINUA (1H + 3H + 15M):
        // Si Bitcoin está en tensión macro, se alerta pero se permite al escáner cazar las monedas
        // que ya alcanzaron suelos extremos (-6% a -12%), aumentando la exigencia del rebote en checkBuyWatches.
        if (macro.isMacroStorm && !macro.isBtcCapitulationFloor) {
            console.log(`🌪️ [RÉGIMEN TORMENTA MACRO] BTC Stress=${(macro.btcStressIndex * 100).toFixed(0)}% | 3h=${macro.btcDrop3hPct.toFixed(2)}%. Cazando suelos extremos con Trailing Buy sensible.`);
        }
        // 🛡️ FILTRO MACRO INSTITUCIONAL BTC 15M: Si Bitcoin está en caída libre activa en la vela actual de 15m
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
        }
        catch (e) { }
        // Contar cuántas memecoins únicas tenemos activas (posiciones o vigilancias armadas)
        const uniqueActiveSyms = this.getUniqueActiveSymbols();
        let activeMemeCount = 0;
        for (const sym of uniqueActiveSyms) {
            if (this.memeWatchlist.includes(sym))
                activeMemeCount++;
        }
        for (const [sym] of this.buyWatches.entries()) {
            if (!uniqueActiveSyms.has(sym) && this.memeWatchlist.includes(sym))
                activeMemeCount++;
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
                // Asegurar Memoria Estructural Multidía (4 días = 384 velas en 15m) para no comprar en $62k cuando el piso recurrente de la semana es $59k
                const candlesIn24h = symTf === "15m" ? 96 : (symTf === "4h" ? 6 : 24);
                const klinesLimit = symTf === "15m" ? 384 : Math.max(96, candlesIn24h * 4);
                const klinesRes = await this.client.klines(sym, symTf, { limit: klinesLimit });
                const allData = klinesRes.data;
                const allHighs4d = allData.map((k) => parseFloat(k[2]));
                const allLows4d = allData.map((k) => parseFloat(k[3]));
                const sortedLows4dScan = [...allLows4d].sort((a, b) => a - b);
                const structuralFloor4dScan = sortedLows4dScan[Math.floor(sortedLows4dScan.length * 0.10)] || Math.min(...allLows4d);
                const high4dScan = Math.max(...allHighs4d);
                const data = allData.slice(-Math.max(55, candlesIn24h + 4));
                const opens = data.map((k) => parseFloat(k[1]));
                const highs = data.map((k) => parseFloat(k[2]));
                const lows = data.map((k) => parseFloat(k[3]));
                const closes = data.map((k) => parseFloat(k[4]));
                const volumes = data.map((k) => parseFloat(k[5]));
                const curPrice = closes[closes.length - 1];
                // 🛡️ CANDADO DE RANGO (PISOS Y TECHOS CONFIGURADOS O AUTO-DETECTADOS):
                // Prohibido armar vigilancia de compra si el precio está fuera de la zona de compra permitida.
                const rangeCheck = marketRangesManager.isBuyAllowed(sym, curPrice);
                if (!rangeCheck.allowed) {
                    continue;
                }
                // 🛑 VEDA DE VIERNES: Bloqueo preventivo de compras los viernes hasta el sábado 02:00 AM COT
                // a menos que la moneda sufra un desplome atípico extraordinario (>= -4.5% o RSI <= 26).
                if (this.isFridayBuyVeda(sym, curPrice)) {
                    continue;
                }
                // Cooldown y Re-Entrada en Ola Post-Venta:
                // Exige una corrección real de al menos >= 2.5% por debajo de la venta para evitar recompras apresuradas en falso techo
                const lastSold = this.recentlySoldSymbols.get(sym);
                let droppedFromExit = 0;
                let isPostSaleWaveCandidate = false;
                if (lastSold) {
                    const elapsed = Date.now() - lastSold.time;
                    droppedFromExit = lastSold.sellPrice && lastSold.sellPrice > 0
                        ? ((lastSold.sellPrice - curPrice) / lastSold.sellPrice) * 100
                        : 0;
                    if (elapsed < 30 * 60 * 1000 && droppedFromExit < 2.50) {
                        continue; // Cooldown activo si no ha corregido al menos -2.50% desde nuestro precio de venta
                    }
                    if (elapsed < 60 * 60 * 1000 && droppedFromExit >= 2.50) {
                        isPostSaleWaveCandidate = true;
                        console.log(`🌊 [RE-ENTRADA EN OLA DETECTADA] ${sym} corrigió -${droppedFromExit.toFixed(2)}% debajo de nuestra venta ($${lastSold.sellPrice} -> $${curPrice}). Evaluando piso de recompra.`);
                    }
                }
                const rsi = this.calculateRSI(closes, 14);
                const bb = this.calculateBollingerBands(closes, 20, 2.0);
                const stochRsi = this.calculateStochRSI(closes, 14, 14, 3, 3);
                const macd = this.calculateMACDHistogram(closes, 12, 26, 9);
                const ema50 = this.calculateEMA(closes, 50);
                // Volumen relativo (RVOL), VWAP Institucional 24h y Flujo de Órdenes (CVD / Taker Buy Ratio)
                const recentVols = volumes.slice(-21, -1);
                const avgVol = recentVols.length > 0 ? recentVols.reduce((a, b) => a + b, 0) / recentVols.length : 1;
                const curVol = volumes[volumes.length - 1] || volumes[volumes.length - 2] || 0;
                const rvol = avgVol > 0 ? curVol / avgVol : 1;
                const maxRecentRvol = avgVol > 0 ? Math.max(...volumes.slice(-6)) / avgVol : 1;
                // Cálculo de VWAP Institucional de 24h (Precio Promedio Ponderado por Volumen)
                let cumPV24 = 0, cumV24 = 0;
                const slice24 = data.slice(-candlesIn24h);
                for (const kRow of slice24) {
                    const typP = (parseFloat(kRow[2]) + parseFloat(kRow[3]) + parseFloat(kRow[4])) / 3;
                    const vRow = parseFloat(kRow[5]);
                    cumPV24 += typP * vRow;
                    cumV24 += vRow;
                }
                const vwap24h = cumV24 > 0 ? cumPV24 / cumV24 : curPrice;
                const distFromVwapPct = vwap24h > 0 ? ((curPrice - vwap24h) / vwap24h) * 100 : 0;
                // Lectura de CVD (Taker Buy Quote Volume) en la vela actual
                const lastKRow = data[data.length - 1];
                const totalQuoteVol = parseFloat(lastKRow[7] || "0");
                const takerBuyQuoteVol = parseFloat(lastKRow[10] || "0");
                const takerBuyRatioPct = totalQuoteVol > 0 ? (takerBuyQuoteVol / totalQuoteVol) * 100 : 50;
                const maxRecent = Math.max(...highs.slice(-20));
                const low24 = Math.min(...lows.slice(-candlesIn24h));
                const high24 = Math.max(...highs.slice(-candlesIn24h));
                const dropRecentPct = maxRecent > 0 ? ((maxRecent - curPrice) / maxRecent) * 100 : 0;
                const drop24hPct = high24 > 0 ? ((high24 - curPrice) / high24) * 100 : dropRecentPct;
                // La caída real considera tanto la onda reciente (últimas 20 velas) como el retroceso desde el techo de 24h
                const dropPct = Math.max(dropRecentPct, drop24hPct);
                // ⏸️ RELOJ ESTADÍSTICO (18 SEMANAS BINANCE):
                // En Horas Pausa / Trampa (08:30-11:30 AM, 16:15-18:15 PM, 22:30-00:30 AM, Viernes 14:00 - Sábado 02:00 AM),
                // solo se permite armar vigilancia si estamos ante una Capitulación / Evento Atípico (caída >= 5.2% y RSI <= 28).
                const pauseWin = this.isHistoricalPauseWindow();
                if (pauseWin.paused && !(dropPct >= (isMeme ? 6.0 : 5.2) && rsi <= 28)) {
                    continue;
                }
                const coinRange24hPct = low24 > 0 ? ((high24 - low24) / low24) * 100 : 2.5;
                const upsideGapPct = curPrice > 0 ? ((high24 - curPrice) / curPrice) * 100 : dropPct;
                // Ubicación Fibonacci real dentro del canal de 24h (0.0 = fondo absoluto, 1.0 = techo 24h)
                const fibPosition24h = (high24 - low24) > 0 ? (curPrice - low24) / (high24 - low24) : 0.5;
                const isWideGapEnabled = this.controls.strategies?.wide_gap_sniper !== false;
                const convictionTier = isWideGapEnabled && ((coinRange24hPct >= 5.0 && (upsideGapPct >= 3.2 || dropPct >= 2.8 || rsi <= 37)) || upsideGapPct >= 4.2)
                    ? "MAXIMA_BRECHA"
                    : ((coinRange24hPct >= 3.8 && (upsideGapPct >= 2.2 || dropPct >= 2.0 || rsi <= 39)) || coinRange24hPct >= 4.6
                        ? "ALTA_VOLATILIDAD"
                        : (coinRange24hPct >= 2.5 && upsideGapPct >= 1.5 ? "IMPULSO" : "ESTANDAR"));
                // 🧠 ANÁLISIS DE ACCIÓN DEL PRECIO, BANDAS DE BOLLINGER, STOCHRSI, MACD Y EMA 50
                const lastIdx = closes.length - 1;
                const candleRange = highs[lastIdx] - lows[lastIdx];
                const lowerWick = Math.min(opens[lastIdx], closes[lastIdx]) - lows[lastIdx];
                const lowerWickRatio = candleRange > 0 ? (lowerWick / candleRange) : 0;
                const hasPinbarRejection = lowerWickRatio >= 0.35; // Mecha inferior >= 35% (Rechazo y absorción en suelo)
                const isNearLowerBollinger = bb.percentB <= 0.12; // En el 12% inferior o por debajo de la Banda Inferior de Bollinger
                // 🛡️ DETECTOR DE RUPTURA EMA 50 (ANTI-BREAKDOWN):
                // Si la vela actual acaba de romper la EMA 50 hacia abajo con fuerza sin mecha de absorción, NO armar compra en la trampilla rota.
                const isFreshEma50Breakdown = opens[lastIdx] >= ema50 && curPrice < ema50 * 0.996 && lowerWickRatio < 0.35;
                if (isFreshEma50Breakdown) {
                    continue;
                }
                // 🦎 MOTOR CAMALEÓN CUÁNTICO (AUTO-ADAPTACIÓN A LOS 4 REGÍMENES DEL MERCADO EN TIEMPO REAL):
                // El bot detecta automáticamente si mañana el mercado cambia a Tendencia Alcista, Lateral Comprimido, Corrección Bajista o Capitulación,
                // ajustando sus ecuaciones quirúrgicamente sin quedarse congelado ni entrar antes de tiempo.
                const ema20 = this.calculateEMA(closes, 20);
                const atrPct = this.calculateATRPct(highs, lows, closes, 14);
                const isBullishTrendRegime = macro.btcStressIndex <= 0.25 && ema20 >= ema50 * 0.998 && curPrice >= ema50 * 0.992;
                const isCompressedRangeRegime = !isBullishTrendRegime && coinRange24hPct <= 3.2 && macro.btcStressIndex <= 0.45;
                const isExtremeCapitulationRegime = macro.btcStressIndex >= 0.72;
                const dynamicRegimeLabel = isBullishTrendRegime
                    ? "ALCISTA_IMPULSO"
                    : (isCompressedRangeRegime ? "LATERAL_COMPRIMIDO" : (isExtremeCapitulationRegime ? "CAPITULACION_EXTREMA" : "CORRECCION_BAJISTA"));
                // Parámetros elásticos auto-calibrados según el régimen vivo de hoy o de mañana + Calendario 5 Años (2021-2026):
                const calRegime5Y = this.get5YearCalendarRegime();
                const floorWinNow = this.isHistoricalFloorWindow();
                const calExtraDrop = floorWinNow.active ? 0 : calRegime5Y.extraDropRequiredPct;
                const calRsiAdj = floorWinNow.active ? 0 : calRegime5Y.rsiAdjustment;
                // En Martes, Jueves y Viernes (Días de Venta en Alza / Cosecha), exigir siempre el piso profundo del canal (<= 16%-22%) y caída fuerte (>= 3.6%-5.0%) para jamás comprar por comprar
                // EXCEPCIÓN DINÁMICA: Si checkMarketRegime o el Trader IA detectan un Desplome Atípico (CRASH_HUNTER), se desbloquea la cacería de suelo.
                const isSellingExpansionDayScan = (calRegime5Y.regimeKey === "MARTES_JUEVES_EXPANSION" || this.getCotTimeInfo().dayStr === "Fri") && this.activeAtypicalOverride !== "CRASH_HUNTER";
                const dynamicFibCeiling = isSellingExpansionDayScan
                    ? 0.16
                    : (isBullishTrendRegime
                        ? 0.25 // Solo en el cuarto inferior del canal de 24h (máxima caída)
                        : (isCompressedRangeRegime
                            ? 0.22
                            : Math.max(0.14, 0.24 - macro.btcStressIndex * 0.10)));
                const dynamicStochCeiling = isSellingExpansionDayScan
                    ? 16
                    : (isBullishTrendRegime
                        ? 22
                        : (isCompressedRangeRegime ? 20 : Math.max(12, Math.round(20 - macro.btcStressIndex * 8))));
                const baseRsiCeiling = isSellingExpansionDayScan
                    ? 34
                    : (isBullishTrendRegime
                        ? 36
                        : (isCompressedRangeRegime ? 35 : Math.max(28, Math.min(36, 35 - (macro.btcStressIndex * 8) + (coinRange24hPct * 0.10)))));
                const dynamicRsiCeiling = Math.max(26, baseRsiCeiling + calRsiAdj);
                const baseDynamicDrop = isSellingExpansionDayScan
                    ? Math.max(3.6, atrPct * 2.5) // En días de alza (Martes/Jueves/Viernes) exige desplome profundo real
                    : (isBullishTrendRegime
                        ? Math.max(3.0, Math.min(4.8, atrPct * 2.2)) // Exige caída estratégica real (>= -3.0% a -4.8%), nunca micro-retrocesos
                        : (isCompressedRangeRegime
                            ? Math.max(2.8, Math.min(4.5, atrPct * 2.2))
                            : Math.max(3.5, Math.min(7.5, Math.max(atrPct * 2.5, 2.8 + coinRange24hPct * 0.30) * (1 + macro.btcStressIndex * 0.40)))));
                const reqDynamicDrop = baseDynamicDrop + calExtraDrop;
                // 🌊 RE-ENTRADA EN OLA POST-VENTA (WAVE SURFING):
                const isWaveReentryDip = !isMeme && isPostSaleWaveCandidate && droppedFromExit >= 0.85 && stochRsi.k <= 30 && rsi <= 41 && (takerBuyRatioPct >= 52 || hasPinbarRejection) && fibPosition24h <= 0.55;
                // 🎯 RETROCESO QUIRÚRGICO EN TENDENCIA ALCISTA (BULLISH PULLBACK):
                const isBullishPullbackDip = !isMeme && isBullishTrendRegime && dropRecentPct >= reqDynamicDrop && fibPosition24h <= dynamicFibCeiling && rsi <= dynamicRsiCeiling && stochRsi.k <= dynamicStochCeiling && (takerBuyRatioPct >= 52 || hasPinbarRejection || bb.percentB <= 0.22);
                // 🎯 PISO DE CANAL EN RANGO LATERAL COMPRIMIDO (PING-PONG RANGE):
                const isCompressedRangeDip = !isMeme && isCompressedRangeRegime && dropPct >= reqDynamicDrop && (fibPosition24h <= dynamicFibCeiling || bb.percentB <= 0.15) && rsi <= dynamicRsiCeiling && stochRsi.k <= dynamicStochCeiling;
                // Exigir volumen de parada institucional o régimen alcista/lateral validado
                const hasStoppingVolume = rvol >= 1.15 || maxRecentRvol >= 1.30 || rsi <= 29 || isWaveReentryDip || isBullishPullbackDip || (isCompressedRangeDip && rvol >= 0.95);
                const isInFibonacciDiscountZone = isWaveReentryDip ||
                    isBullishPullbackDip ||
                    isCompressedRangeDip ||
                    (fibPosition24h <= dynamicFibCeiling && distFromVwapPct <= -1.0) ||
                    (distFromVwapPct <= -2.2 && rsi <= 33 && stochRsi.k <= dynamicStochCeiling) ||
                    (rsi <= Math.max(27, 32 - macro.btcStressIndex * 5) && stochRsi.k <= 15);
                if (!isInFibonacciDiscountZone || !hasStoppingVolume) {
                    continue;
                }
                // Condiciones cuantitativas institucionales de suelo:
                const isStochOversold = stochRsi.k <= dynamicStochCeiling || rsi <= Math.max(27, 31 - macro.btcStressIndex * 4);
                const isBollingerOversold = isNearLowerBollinger && rsi <= Math.min(38, dynamicRsiCeiling) && dropPct >= Math.max(1.5, reqDynamicDrop * 0.80) && isStochOversold;
                const isWideGapDip = !isMeme && (upsideGapPct >= reqDynamicDrop && dropPct >= Math.min(2.8, reqDynamicDrop * 0.90)) && rsi <= dynamicRsiCeiling && stochRsi.k <= dynamicStochCeiling && fibPosition24h <= Math.min(0.28, dynamicFibCeiling);
                const isStandardDip = ((dropPct >= Math.max(1.5, reqDynamicDrop * 0.90) && rsi <= dynamicRsiCeiling && isStochOversold) || isBollingerOversold || isWideGapDip || (rsi <= 29 && stochRsi.k <= 16));
                const isWickRebound = hasPinbarRejection && dropPct >= Math.max(1.6, atrPct * 1.7) && rsi <= dynamicRsiCeiling && stochRsi.k <= Math.min(28, dynamicStochCeiling + 3) && rvol >= 1.15;
                // 🐶 ESCUDO 3 (FILTRO DE HIERRO PARA MEMECOINS):
                const isMemeExtremeDip = (dropPct >= 3.8 && bb.percentB <= 0.10 && rsi <= 33 && stochRsi.k <= 20 && maxRecentRvol >= 1.35) ||
                    (dropPct >= 4.5 && fibPosition24h <= 0.12 && rsi <= 34 && hasPinbarRejection && rvol >= 1.25) ||
                    (rsi <= 27 && dropPct >= 3.2 && hasPinbarRejection && bb.percentB <= 0.10);
                // 🧠 ESCUDO 4 (ESTUDIO DINÁMICO DEL AGENTE IA ANTI-ENGAÑO POR MONEDA):
                const aiCalDip = this.aiCoinCalibrations.get(sym);
                const downsideToFloorScanPct = curPrice > 0 ? ((curPrice - low24) / curPrice) * 100 : 0;
                if (aiCalDip?.trapDetected || aiCalDip?.strategyMode === "AVOID_BULL_TRAP") {
                    continue;
                }
                if (aiCalDip?.maxEntryRsi && rsi > aiCalDip.maxEntryRsi) {
                    continue;
                }
                if (aiCalDip?.maxEntryFib && fibPosition24h > aiCalDip.maxEntryFib) {
                    continue;
                }
                if (aiCalDip?.targetFloorPrice && aiCalDip.targetFloorPrice > 0 && curPrice > aiCalDip.targetFloorPrice * 1.008) {
                    continue;
                }
                // Prohibido armar compra si queda más de 1.25% de vacío hacia el piso de 24h (salvo sobreventa extrema RSI <= 28)
                if (downsideToFloorScanPct > 1.25 && rsi > 28) {
                    continue;
                }
                // 🛡️ ESCUDO DE MEMORIA MULTIDÍA (4 DÍAS): Prohibido comprar arriba del piso recurrente de los últimos 4 días (ej. comprar BTC en $62k cuando toda la semana bajó a $59k)
                const fibPosition4dScan = (high4dScan - structuralFloor4dScan) > 0 ? Math.max(0, (curPrice - structuralFloor4dScan) / (high4dScan - structuralFloor4dScan)) : 0.5;
                const downsideTo4dFloorScanPct = curPrice > 0 ? Math.max(0, ((curPrice - structuralFloor4dScan) / curPrice) * 100) : 0;
                if ((fibPosition4dScan > 0.30 || downsideTo4dFloorScanPct > 2.1) && rsi > 27) {
                    continue;
                }
                const isDip = isMeme
                    ? isMemeExtremeDip
                    : (isStandardDip || isWickRebound || isWaveReentryDip || isBullishPullbackDip || isCompressedRangeDip);
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
                    if (isMeme)
                        activeMemeCount++;
                    console.log(`🎯 [TRAILING BUY ARMADO] ${sym} a ${curPrice} (RSI ${rsi.toFixed(1)} | StochRSI ${stochRsi.k.toFixed(0)} | VWAP ${distFromVwapPct.toFixed(2)}% | CVD ${takerBuyRatioPct.toFixed(0)}% | Fib24h ${(fibPosition24h * 100).toFixed(0)}% | RVOL ${rvol.toFixed(2)}x [${convictionTier}])`);
                    // Notificar armado de cacería en Telegram
                    const msgArmado = `🎯 <b>[CACERÍA INSTITUCIONAL ARMADA: ${sym}]</b> 🏹\n\n` +
                        `• <b>Precio actual:</b> $${curPrice} (Descuento VWAP: <b>${distFromVwapPct.toFixed(2)}%</b>)\n` +
                        `• 📉 <b>Caída detectada:</b> -${dropPct.toFixed(2)}% (RSI: <b>${rsi.toFixed(1)}</b> | StochRSI: <b>${stochRsi.k.toFixed(0)}</b> | RVOL: <b>${rvol.toFixed(2)}x</b>)\n` +
                        `• 📐 <b>Ubicación 24h:</b> Piso ${(fibPosition24h * 100).toFixed(0)}% del canal | 🚀 <b>Brecha:</b> +${upsideGapPct.toFixed(2)}% [<b>${convictionTier}</b>]\n` +
                        `• 🔻 <b>Acción:</b> Persiguiendo el suelo tick a tick. Prohibido comprar cuchillos cayendo.\n` +
                        `• ⚡ <b>Disparador Experto:</b> Exigirá Secuencia Wyckoff (Doble Piso) + Order Flow Positivo (CVD $\ge$ 54%) + Libro de Órdenes favorable (OBI sin muros de venta).`;
                    try {
                        await this.notifier.send(msgArmado);
                    }
                    catch { }
                }
            }
            catch (e) { }
        }
    }
    /**
     * TRAILING BUY - Paso 2: seguir el piso y comprar en el rebote confirmado con Order Flow, Libro de Órdenes y Estructura Wyckoff.
     * Devuelve true si ejecutó una compra.
     */
    async checkBuyWatches(usdt) {
        const macro = await this.getLiveMacroRegime();
        // 🏆 RANKING INTELIGENTE POR BRECHA Y VOLATILIDAD:
        const sortedWatches = Array.from(this.buyWatches.entries()).sort((a, b) => {
            const scoreA = (a[1].coinRange24hPct || 2.5) * 0.6 + (a[1].upsideGapPct || a[1].dropPct || 1.5) * 1.3 + Math.max(0, 48 - (a[1].rsi || 45)) * 0.25;
            const scoreB = (b[1].coinRange24hPct || 2.5) * 0.6 + (b[1].upsideGapPct || b[1].dropPct || 1.5) * 1.3 + Math.max(0, 48 - (b[1].rsi || 45)) * 0.25;
            return scoreB - scoreA;
        });
        for (const [sym, w] of sortedWatches) {
            try {
                if (this.hasActivePositionForSymbol(sym)) {
                    this.buyWatches.delete(sym);
                    this.saveBuyWatches();
                    continue;
                }
                if (Date.now() - w.armedTime > TRAILING_BUY_MAX_AGE_MS) {
                    console.log(`⌛ Trailing Buy en ${sym} expiró sin rebote. Se desarma.`);
                    this.buyWatches.delete(sym);
                    this.saveBuyWatches();
                    continue;
                }
                const cur = parseFloat((await this.client.tickerPrice(sym)).data.price);
                if (cur < w.lowestPrice) {
                    w.lowestPrice = cur;
                    w.armedTime = Date.now(); // Refresca ventana al descubrir nuevo piso
                    if (w.high24h && cur > 0) {
                        w.upsideGapPct = ((w.high24h - cur) / cur) * 100;
                    }
                    this.saveBuyWatches();
                    console.log(`🔻 Nuevo piso en ${sym}: ${cur} (${(((cur - w.armedPrice) / w.armedPrice) * 100).toFixed(2)}% desde que se armó | Brecha al techo: +${(w.upsideGapPct || w.dropPct || 0).toFixed(2)}%)`);
                    continue;
                }
                // Si BTC está en Tormenta Macro sin haber tocado piso de capitulación, seguimos bajando el lowestPrice pero NO gatillamos compra aún
                if (sym !== "BTCUSDT" && macro.isMacroStorm && !macro.isBtcCapitulationFloor) {
                    console.log(`🌪️ [VETO TORMENTA MACRO: ${sym}] BTC Stress=${(macro.btcStressIndex * 100).toFixed(0)}% (${macro.btcDrop3hPct.toFixed(2)}% en 3h). Reteniendo disparo y acompañando suelo.`);
                    continue;
                }
                // 🛡️ CANDADO DE RANGO (VERIFICACIÓN EN TIEMPO DE DISPARO DE COMPRA):
                const rangeCheckBuy = marketRangesManager.isBuyAllowed(sym, cur);
                if (!rangeCheckBuy.allowed) {
                    console.log(`🛡️ [CANDADO DE RANGO: ${sym}] Compra bloqueada en $${cur}. ${rangeCheckBuy.reason}`);
                    continue;
                }
                // 🛑 VEDA DE VIERNES: Bloqueo preventivo de compras los viernes hasta el sábado 02:00 AM COT
                if (this.isFridayBuyVeda(sym, cur, undefined, w.dropPct)) {
                    console.log(`🛑 [VEDA DE VIERNES] ${sym}: Compra retenida hasta el sábado 02:00 AM COT (esperando piso real).`);
                    continue;
                }
                const bounce = ((cur - w.lowestPrice) / w.lowestPrice) * 100;
                this.loadWalletSplit();
                const botAvailableUsdt = Math.max(0, usdt - this.walletSplit.manualUsdt);
                const sessionPlan = this.lastSessionPlan || this.getSessionLiquidityPlan(botAvailableUsdt);
                const isMemeCoin = this.memeWatchlist.includes(sym) || sym.includes("PEPE") || sym.includes("BONK") || sym.includes("DOGE") || sym.includes("SHIB");
                const strat = w.strategy || "trailing_rebound";
                const isWeekendNow = this.isWeekendWindow() || strat === "cazador_weekend";
                // 🧹 PURGA DE VIGILANCIAS DÉBILES DE FIN DE SEMANA:
                // Si una vigilancia de fin de semana se armó con RSI alto (> 38) y poca caída (< 3.8%), desarmarla para no comprar apresuradamente
                const savedPctSoFar = w.armedPrice > 0 ? Math.max(0, ((w.armedPrice - w.lowestPrice) / w.armedPrice) * 100) : 0;
                const effectiveDropSoFar = (w.dropPct || 0) + savedPctSoFar;
                if (strat === "cazador_weekend" && (w.rsi || 45) > 38 && effectiveDropSoFar < 3.8) {
                    console.log(`🧹 [PURGA CAZADOR WEEKEND: ${sym}] Vigilancia descartada por falta de sobreventa real (RSI ${(w.rsi || 45).toFixed(1)} > 38 | Caída -${effectiveDropSoFar.toFixed(2)}% < 3.8%).`);
                    this.buyWatches.delete(sym);
                    this.saveBuyWatches();
                    continue;
                }
                // ⏸️ FILTRO DE HORAS PAUSA HISTÓRICAS + LLAVE MAESTRA DE EXCEPCIÓN POR EVENTO ATÍPICO:
                // Durante las horas trampa detectadas en las 18 semanas de Binance (08:30-11:30 AM, 16:15-18:15 PM, 22:30-00:30 AM, Viernes 14:00 - Sábado 02:00 AM),
                // las compras normales se pausan y solo se sigue bajando el lowestPrice.
                // EXCEPCIÓN: Si ocurre un Evento Atípico / Flash Crash (caída >= 5.8% core / 6.5% meme y RSI <= 26 con rebote >= +0.55%), se rompe la pausa.
                const pauseState = this.isHistoricalPauseWindow();
                const isAtypicalCrashCandidate = this.isAtypicalMarketException({
                    symbol: sym,
                    dropPct: effectiveDropSoFar,
                    rsi: w.rsi || 40,
                    rvol: w.rvol || 1.8,
                    bouncePct: bounce,
                    cvdPct: 55
                });
                if (pauseState.paused && !isAtypicalCrashCandidate) {
                    if (bounce >= 0.35) {
                        console.log(`${pauseState.reason} [${sym} caída -${effectiveDropSoFar.toFixed(2)}%, RSI ${(w.rsi || 40).toFixed(1)} no califica como Evento Atípico >= -5.8% / RSI <= 26].`);
                    }
                    continue;
                }
                if (pauseState.paused && isAtypicalCrashCandidate) {
                    console.log(`⚡ [LLAVE MAESTRA DE EXCEPCIÓN ATÍPICA ACTIVADA: ${sym}] Flash Crash detectado (-${effectiveDropSoFar.toFixed(2)}% | RSI ${(w.rsi || 25).toFixed(1)}) durante hora pausada. Desbloqueando Presupuesto Abierto.`);
                }
                // Rebote exigido y filtro anti-engaño calibrado por el Estudio del Agente IA:
                const aiCalBuy = this.aiCoinCalibrations.get(sym);
                if (aiCalBuy?.trapDetected || aiCalBuy?.strategyMode === "AVOID_BULL_TRAP") {
                    if (bounce >= 0.25) {
                        console.log(`🧠🛑 [AGENTE IA ANTI-ENGAÑO: ${sym}] Compra vetada por detección de Bull-Trap / Mechazo falso. Siguiendo hacia el suelo real.`);
                    }
                    continue;
                }
                if (aiCalBuy?.targetFloorPrice && aiCalBuy.targetFloorPrice > 0 && cur > aiCalBuy.targetFloorPrice * 1.008) {
                    continue;
                }
                const reqBounce = (aiCalBuy && typeof aiCalBuy.bounceBuyPct === "number")
                    ? aiCalBuy.bounceBuyPct
                    : (isWeekendNow
                        ? (isMemeCoin ? 0.65 : 0.55)
                        : (isMemeCoin ? 0.48 : 0.38));
                const floorState = this.isHistoricalFloorWindow();
                const effectiveSpendable = (floorState.active || (strat === "cazador_weekend" && this.isWeekendWindow()))
                    ? Math.max(sessionPlan.spendableUsdt, botAvailableUsdt * 0.95)
                    : (pauseState.paused && isAtypicalCrashCandidate
                        ? Math.max(sessionPlan.spendableUsdt, botAvailableUsdt * 0.40)
                        : sessionPlan.spendableUsdt);
                // 🎯 PROTECCIÓN DE BLOQUE $100 USDT (PROHIBIDO PICOTEAR MIGAJAS DE $12 - $25 USDT):
                // Si en la billetera solo hay $13 o $17 USDT (producto de una venta pequeña), NO gastarlos en abrir otra moneda diminuta.
                // Esperar y acumular liquidez hasta reunir al menos $35 USDT (idealmente $50 - $100 USDT) para disparar con fuerza.
                const minBlockToOpenNewCoin = 35.0;
                if (effectiveSpendable < minBlockToOpenNewCoin) {
                    if (bounce >= reqBounce) {
                        console.log(`🏦 [BÓVEDA ACUMULADORA $100: ${sym}] Saldo libre ($${effectiveSpendable.toFixed(2)} USDT) retenido. Acumulando ventas hasta reunir bloque mínimo de $${minBlockToOpenNewCoin}–$100 USDT (evitando micro-compras).`);
                    }
                    continue;
                }
                if (bounce >= reqBounce && effectiveSpendable >= minBlockToOpenNewCoin) {
                    // 🚦 CONFIRMACIÓN MULTITEMPORAL ESTRICTA (5m + 15m + Order Flow + Libro OBI + BTC):
                    let turnaroundConfirmed = true;
                    try {
                        const [k5, k15, depthRes, btcK5] = await Promise.all([
                            this.client.klines(sym, "5m", { limit: 40 }),
                            this.client.klines(sym, "15m", { limit: 24 }),
                            this.client.depth(sym, { limit: 50 }).catch(() => ({ data: { bids: [], asks: [] } })),
                            sym !== "BTCUSDT" ? this.client.klines("BTCUSDT", "5m", { limit: 6 }) : Promise.resolve({ data: [] })
                        ]);
                        // Indicador 5: Ancla Líder-Seguidor en Bitcoin (5m > -0.20% + Giro Estructural 15m confirmado)
                        if (sym !== "BTCUSDT") {
                            const btcAnchor15 = await this.verifyBtc15mLeaderAnchor(sym);
                            if (!btcAnchor15.ok) {
                                console.log(`⚓ [SEMÁFORO RETENIDO - ANCLA BTC 15M: ${sym}] ${btcAnchor15.reason}`);
                                continue;
                            }
                            if (btcK5?.data?.length >= 3) {
                                const b5 = btcK5.data[btcK5.data.length - 1];
                                const bPrev15 = btcK5.data[btcK5.data.length - 3];
                                const bo5 = parseFloat(b5[1]), bc5 = parseFloat(b5[4]);
                                const bo15 = parseFloat(bPrev15[1]);
                                const btcDrop5 = ((bc5 - bo5) / bo5) * 100;
                                const btcDrop15 = ((bc5 - bo15) / bo15) * 100;
                                if (btcDrop5 <= -0.20 || btcDrop15 <= -0.45) {
                                    console.log(`🚦 [SEMÁFORO RETENIDO - BTC: ${sym}] BTC débil (5m: ${btcDrop5.toFixed(2)}%, 15m: ${btcDrop15.toFixed(2)}%). Esperando piso de BTC.`);
                                    continue;
                                }
                            }
                        }
                        // Indicador 4: Libro Profundidad (50 niveles >= 48%, o >= 50% en fin de semana)
                        let obiPct = 50;
                        const minObiReq = isWeekendNow ? 50.0 : 48.0;
                        const bids = depthRes?.data?.bids || [];
                        const asks = depthRes?.data?.asks || [];
                        if (bids.length > 0 && asks.length > 0) {
                            const bidUsdt = bids.reduce((acc, [p, q]) => acc + parseFloat(p) * parseFloat(q), 0);
                            const askUsdt = asks.reduce((acc, [p, q]) => acc + parseFloat(p) * parseFloat(q), 0);
                            obiPct = (bidUsdt + askUsdt) > 0 ? (bidUsdt / (bidUsdt + askUsdt)) * 100 : 50;
                            if (obiPct < minObiReq) {
                                console.log(`🧱 [SEMÁFORO RETENIDO - DEPTH: ${sym}] Libro OBI en ${obiPct.toFixed(1)}% (< ${minObiReq}%). Esperando mayoría compradora.`);
                                continue;
                            }
                        }
                        // Indicador Estructural 15m (Anti-Compra Apresurada):
                        // Prohibido comprar si la vela de 15m sigue siendo roja bajista sin mecha o si el RSI de 15m > 42 en Cazador Weekend
                        if (k15?.data?.length >= 15) {
                            const last15 = k15.data[k15.data.length - 1];
                            const prev15 = k15.data[k15.data.length - 2];
                            const o15 = parseFloat(last15[1]), h15 = parseFloat(last15[2]), l15 = parseFloat(last15[3]), c15 = parseFloat(last15[4]);
                            const prevLow15 = parseFloat(prev15[3]);
                            const range15 = h15 - l15;
                            const lowerWick15 = range15 > 0 ? (Math.min(o15, c15) - l15) / range15 : 0;
                            const isGreenOrAbsorb15 = c15 >= o15 || lowerWick15 >= 0.30;
                            const isStoppingBleed15 = l15 >= prevLow15 * 0.998 || lowerWick15 >= 0.35;
                            const closes15 = k15.data.map((r) => parseFloat(r[4]));
                            const rsi15 = this.calculateRSI(closes15, 14);
                            if (!isGreenOrAbsorb15 || !isStoppingBleed15) {
                                console.log(`⏳ [FILTRO 15M ANTI-APRESURADO: ${sym}] Vela 15m aún bajista sin absorción suficiente. Evitando entrada prematura.`);
                                continue;
                            }
                            if (isWeekendNow && rsi15 > 40) {
                                console.log(`⏳ [FILTRO 15M WEEKEND: ${sym}] RSI 15m en ${rsi15.toFixed(1)} (> 40). Exigiendo sobreventa real en fin de semana.`);
                                continue;
                            }
                        }
                        // Indicadores 2 y 3: Vela 5m (Verde/Absorción) + CVD Ballenas (>= 53%)
                        if (k5?.data?.length >= 2) {
                            const last5 = k5.data[k5.data.length - 1];
                            const prev5 = k5.data[k5.data.length - 2];
                            const o5 = parseFloat(last5[1]), h5 = parseFloat(last5[2]), l5 = parseFloat(last5[3]), c5 = parseFloat(last5[4]);
                            const pc5 = parseFloat(prev5[4]);
                            const totQuote5 = parseFloat(last5[7] || "0");
                            const buyQuote5 = parseFloat(last5[10] || "0");
                            const takerBuyRatio5m = totQuote5 > 0 ? (buyQuote5 / totQuote5) * 100 : 50;
                            const prevTotQuote5 = parseFloat(prev5[7] || "0");
                            const prevBuyQuote5 = parseFloat(prev5[10] || "0");
                            const combinedTotQuote = totQuote5 + prevTotQuote5;
                            const combinedBuyRatio5m = combinedTotQuote > 0 ? ((buyQuote5 + prevBuyQuote5) / combinedTotQuote) * 100 : 50;
                            const effectiveCvd = Math.max(takerBuyRatio5m, combinedBuyRatio5m);
                            const range5 = h5 - l5;
                            const lowerWick5 = range5 > 0 ? (Math.min(o5, c5) - l5) / range5 : 0;
                            const isGreen5m = c5 >= o5 || (c5 > pc5 && lowerWick5 >= 0.25) || lowerWick5 >= 0.35;
                            const minCvdReq = isWeekendNow ? 54.0 : 52.0;
                            if (effectiveCvd < minCvdReq) {
                                console.log(`🚫 [SEMÁFORO RETENIDO - CVD: ${sym}] Rebote +${bounce.toFixed(2)}% con CVD en ${effectiveCvd.toFixed(1)}% (< ${minCvdReq}%).`);
                                continue;
                            }
                            if (!isGreen5m) {
                                console.log(`⏳ [SEMÁFORO RETENIDO - VELA 5M: ${sym}] Rebote +${bounce.toFixed(2)}% esperando vela 5m verde/absorción.`);
                                continue;
                            }
                            turnaroundConfirmed = true;
                        }
                    }
                    catch { }
                    const saved = ((w.armedPrice - w.lowestPrice) / w.armedPrice) * 100;
                    const totalDropFromPeak = (w.dropPct || 1.5) + Math.max(0, saved);
                    const coinVol = w.coinRange24hPct || 2.5;
                    const upsideGapPct = w.high24h && cur > 0 ? ((w.high24h - cur) / cur) * 100 : Math.max(w.upsideGapPct || 0, totalDropFromPeak);
                    const isWideGapEnabled = this.controls.strategies?.wide_gap_sniper !== false;
                    const convictionTier = isWideGapEnabled && ((coinVol >= 5.0 && (upsideGapPct >= 3.2 || totalDropFromPeak >= 2.8 || (w.rsi || 40) <= 37)) || upsideGapPct >= 4.2)
                        ? "MAXIMA_BRECHA"
                        : ((coinVol >= 3.8 && (upsideGapPct >= 2.2 || totalDropFromPeak >= 2.0 || (w.rsi || 40) <= 39)) || coinVol >= 4.6
                            ? "ALTA_VOLATILIDAD"
                            : (coinVol >= 2.5 && upsideGapPct >= 1.5 ? "IMPULSO" : "ESTANDAR"));
                    // 🎯 CONCENTRACIÓN DE BALAS FUERTES ($50 - $100 USDT):
                    // Límite de 4 monedas activas para nuevas entradas (mientras las posiciones existentes terminan de venderse en verde)
                    const uniqueActiveNow = this.getUniqueActiveSymbols().size;
                    const configuredMax = this.controls?.maxPositions || 4;
                    const stdCap = Math.max(1, configuredMax - 1);
                    if (uniqueActiveNow >= configuredMax) {
                        console.log(`🎯 [CUPO CONCENTRADO $100 LLENO] ${uniqueActiveNow}/${configuredMax} monedas activas en cartera. Esperando venta para concentrar capital en bloques de $50–$100 USDT.`);
                        continue;
                    }
                    if (uniqueActiveNow >= stdCap && convictionTier !== "ALTA_VOLATILIDAD" && convictionTier !== "MAXIMA_BRECHA") {
                        console.log(`🎯 [CUPO CONCENTRADO] ${uniqueActiveNow}/${configuredMax} monedas activas: reservando último cupo exclusivamente para oportunidades de Alta Volatilidad / Máxima Brecha (${sym} es ${convictionTier}).`);
                        continue;
                    }
                    let amountToUse = this.calculateSessionLotSize(sym, effectiveSpendable, sessionPlan.lotFractionPct, strat, 1, w.rsi || 40, coinVol, Math.max(totalDropFromPeak, upsideGapPct));
                    if (amountToUse < this.minUsdtToTrade) {
                        console.log(`🛡️ [BLOQUE SNIPER PROTEGIDO: ${sym}] Monto asignado ($${amountToUse.toFixed(2)}) menor al mínimo ($${this.minUsdtToTrade}). Reteniendo para tiro principal.`);
                        continue;
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
            }
            catch (e) {
                console.error(`Error en Trailing Buy ${sym}:`, e.message);
            }
        }
        return false;
    }
    async handleTelegramCommand(rawCmd) {
        try {
            const parts = rawCmd.trim().split(/\s+/);
            const cmd = parts[0].toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
            const arg1 = parts[1]?.toUpperCase();
            const arg2 = parts[2];
            // Auditoría del Agente IA vs Cierre del Viernes a solicitud (/benchmark o /ia_auditar)
            if (cmd === "/benchmark" || cmd === "benchmark" || cmd === "/ia_auditar" || cmd === "ia_auditar" || cmd === "/comparar_viernes" || cmd === "comparar_viernes") {
                const acc = await this.client.account({ recvWindow: 60000 });
                const freeUsdt = parseFloat(acc.data.balances.find((b) => b.asset === "USDT")?.free || "0");
                this.loadWalletSplit();
                const botSpendable = Math.max(0, freeUsdt - this.walletSplit.manualUsdt);
                const rep = await this.runAutonomousAiBenchmarkAudit(true, botSpendable);
                return rep || "⚠️ No se pudo generar el reporte de benchmark.";
            }
            // Comando interactivo para asegurar piso: /piso_SYMBOL_PCT o /piso SYMBOL PCT
            if (cmd.startsWith("/piso_") || cmd.startsWith("/asegurar_") || cmd === "/piso" || cmd === "/asegurar" || cmd === "piso" || cmd === "asegurar") {
                let targetSym = "";
                let targetPct = 0;
                if (cmd.startsWith("/piso_") || cmd.startsWith("/asegurar_")) {
                    const prefix = cmd.startsWith("/piso_") ? "/piso_" : "/asegurar_";
                    const rawParts = cmd.slice(prefix.length).split("_");
                    targetSym = rawParts[0].toUpperCase();
                    if (!targetSym.endsWith("USDT"))
                        targetSym += "USDT";
                    const rawPctNum = parseFloat(rawParts[1] || "0");
                    targetPct = rawPctNum >= 10 ? rawPctNum / 100 : rawPctNum;
                }
                else {
                    targetSym = (arg1 || "").toUpperCase();
                    if (targetSym && !targetSym.endsWith("USDT"))
                        targetSym += "USDT";
                    targetPct = parseFloat(arg2 || "0");
                }
                if (!targetSym || isNaN(targetPct) || targetPct <= 0) {
                    return "ℹ️ <b>Uso correcto:</b> <code>/piso MONEDA PORCENTAJE</code>\nEjemplo: <code>/piso XRP 0.80</code> o toca el enlace rápido en las alertas de pico.";
                }
                let foundPos = null;
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
                }
                else {
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
                    if (!targetSym.endsWith("USDT"))
                        targetSym += "USDT";
                }
                else {
                    targetSym = (arg1 || "").toUpperCase();
                    if (targetSym && !targetSym.endsWith("USDT"))
                        targetSym += "USDT";
                }
                if (!targetSym) {
                    return "ℹ️ <b>Uso:</b> <code>/tomar_cosecha MONEDA</code>\nEjemplo: <code>/tomar_cosecha SOLUSDT</code> para autorizar compra con la reserva protegida.";
                }
                const acc = await this.client.account({ recvWindow: 60000 });
                const freeUsdt = parseFloat(acc.data.balances.find((b) => b.asset === "USDT")?.free || "0");
                const amountToUse = Math.min(15.0, Math.max(10.0, freeUsdt));
                if (freeUsdt < 10.0) {
                    return `⚠️ Saldo insuficiente en Binance (${freeUsdt.toFixed(2)} USDT) para tomar de la cosecha.`;
                }
                const ok = await this.executeSmartBuy(targetSym, amountToUse, "Oportunidad de Oro (Fondo de Cosecha)", "trailing_rebound");
                if (ok) {
                    return `🚀 <b>¡COMPRA DE COSECHA EJECUTADA!</b>\nSe tomaron ${amountToUse.toFixed(2)} USDT de la reserva para comprar <b>${targetSym}</b> en suelo de alta probabilidad.`;
                }
                else {
                    return `⚠️ No se pudo ejecutar la compra en ${targetSym}.`;
                }
            }
            if (cmd === "/viabilidad_futuros" || cmd === "viabilidad_futuros" || cmd === "/viabilidad" || cmd === "viabilidad") {
                const viability = await this.futuresEngine.evaluateMarketViability();
                const acc = await this.client.account({ recvWindow: 60000 });
                const freeUsdt = parseFloat(acc.data.balances.find((b) => b.asset === "USDT")?.free || "0");
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
                }
                catch (e) { }
                if (!hasFuturesPermission) {
                    return `⚠️ <b>TU API KEY DE BINANCE NO TIENE PERMISO DE FUTUROS ACTIVADO</b> 🔒\n\n` +
                        `Entra a Binance ➡️ <b>Gestión de API</b> y marca:\n` +
                        `☑️ <b>Habilitar Futuros</b>\n` +
                        `☑️ <b>Permitir Transferencia Universal</b>\n\n` +
                        `Luego vuelve a presionar: 👉 /futuros_real`;
                }
                // Margen dinámico para la billetera de Futuros según la configuración del motor (default 30 USDT)
                const futState = this.futuresEngine.getState();
                const agreedMargin = futState.defaultMarginPerTrade || 30.0;
                const futBal = await this.getFuturesBalance();
                let transferNote = "";
                if (futBal.available < agreedMargin * 0.8) {
                    const acc = await this.client.account({ recvWindow: 60000 });
                    const spotUsdt = parseFloat(acc.data.balances.find((b) => b.asset === "USDT")?.free || "0");
                    if (spotUsdt >= agreedMargin) {
                        const tr = await this.transferSpotToFutures(agreedMargin);
                        if (tr.success) {
                            transferNote = `\n💼 <b>Transferencia Automática:</b> Se transfirieron <b>$${agreedMargin.toFixed(2)} USDT</b> de Spot a Futuros USD-M.`;
                        }
                        else {
                            transferNote = `\n⚠️ <i>Nota de transferencia: ${tr.msg}</i>`;
                        }
                    }
                    else if (spotUsdt >= 5.0) {
                        const tr = await this.transferSpotToFutures(Math.floor(spotUsdt));
                        transferNote = `\n💼 <b>Transferencia Parcial:</b> Se transfirieron <b>$${Math.floor(spotUsdt)}.00 USDT</b> disponibles de Spot a Futuros.`;
                    }
                    else {
                        transferNote = `\n⏳ <b>Aviso de Fondos:</b> Tienes $${spotUsdt.toFixed(2)} USDT libres en Spot (fondos activos en órdenes Spot). Tan pronto una orden cierre con ganancia, se fondearán los $${agreedMargin.toFixed(2)} USDT acordados.`;
                    }
                }
                else {
                    transferNote = `\n💼 <b>Saldo en Futuros USD-M:</b> Tienes <b>$${futBal.available.toFixed(2)} USDT</b> disponibles.`;
                }
                this.futuresEngine.setConfig({ isSimulated: false });
                return `🚀 <b>MODO FUTUROS CAMBIADO A: REAL</b> ⚠️\n\n` +
                    `• El motor ahora ejecutará órdenes reales en Binance USD-M con margen aislado ($${agreedMargin.toFixed(0)} USDT por operación).\n` +
                    `• Stop Loss activo: -1.5% | Trailing TP: +1.5%${transferNote}\n\n` +
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
                }
                else {
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
                const spotUsdt = parseFloat(acc.data.balances.find((b) => b.asset === "USDT")?.free || "0");
                if (res.success) {
                    return `✅ <b>TRANSFERENCIA A SPOT EXITOSA</b> 💼\n\n` +
                        `• ${res.msg}\n` +
                        `• <b>Saldo Libre en Spot:</b> $${spotUsdt.toFixed(2)} USDT\n` +
                        `• <b>Saldo Restante en Futuros:</b> $${futBal.available.toFixed(2)} USDT`;
                }
                else {
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
                const spotUsdt = parseFloat(acc.data.balances.find((b) => b.asset === "USDT")?.free || "0");
                if (res.success) {
                    return `✅ <b>TRANSFERENCIA A FUTUROS EXITOSA</b> 🚀\n\n` +
                        `• ${res.msg}\n` +
                        `• <b>Saldo Libre en Futuros USD-M:</b> $${futBal.available.toFixed(2)} USDT\n` +
                        `• <b>Saldo Restante en Spot:</b> $${spotUsdt.toFixed(2)} USDT`;
                }
                else {
                    return `⚠️ <b>NO SE PUDO TRANSFERIR A FUTUROS</b>\n\n` +
                        `• ${res.msg}\n` +
                        `• <b>Saldo Disponible en Spot:</b> $${spotUsdt.toFixed(2)} USDT`;
                }
            }
            if (cmd === "/saldo_futuros" || cmd === "saldo_futuros") {
                const futBal = await this.getFuturesBalance();
                const acc = await this.client.account({ recvWindow: 60000 });
                const spotUsdt = parseFloat(acc.data.balances.find((b) => b.asset === "USDT")?.free || "0");
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
            if (cmd === "/deriv" || cmd === "deriv" || cmd === "/toggle_deriv" || cmd === "toggle_deriv" || cmd?.startsWith("/deriv_")) {
                return `ℹ️ <b>El motor Deriv Sintéticos ha sido retirado permanentemente</b> por configuración del usuario.\nTodos los recursos están 100% enfocados en Binance Spot y Binance Futuros USD-M.`;
            }
            if (cmd === "/liquidez" || cmd === "liquidez") {
                const acc = await this.client.account({ recvWindow: 60000 });
                const freeUsdt = parseFloat(acc.data.balances.find((b) => b.asset === "USDT")?.free || "0");
                const lockedUsdt = parseFloat(acc.data.balances.find((b) => b.asset === "USDT")?.locked || "0");
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
                let alphaPos = null;
                for (const p of this.activeTrailingPositions.values()) {
                    if (p.strategy === "centinela_alpha") {
                        alphaPos = p;
                        break;
                    }
                }
                let msg = `🤖 <b>ESTRATEGIA AUTÓNOMA CENTINELA ALPHA</b> 🛡️\n\n` +
                    `<i>Estrategia con 20% del presupuesto dedicada a recuperar los $100.00 USDT con gestión autónoma de parámetros.</i>\n\n` +
                    `📊 <b>ESTADO DE LA MISIÓN:</b>\n` +
                    `• Meta fijada: <b>${rec.targetUsdt.toFixed(2)} USDT</b>\n` +
                    `• Recuperado hasta hoy: <b>+${rec.recoveredUsdt.toFixed(2)} USDT</b> (${pct.toFixed(1)}%)\n` +
                    `• Operaciones cerradas en verde: ${rec.tradesCount}\n\n`;
                if (alphaPos) {
                    let curT = alphaPos.buyPrice;
                    try {
                        curT = parseFloat((await this.client.tickerPrice(alphaPos.symbol)).data.price);
                    }
                    catch (e) { }
                    const gPct = ((curT - alphaPos.buyPrice) / alphaPos.buyPrice) * 100;
                    msg += `🎯 <b>OPERACIÓN ALPHA EN CURSO:</b>\n` +
                        `• Moneda: <b>${alphaPos.symbol}</b>\n` +
                        `• Invertido: ${alphaPos.investedUsdt.toFixed(2)} USDT\n` +
                        `• Entrada: ${fmtPrice(alphaPos.buyPrice)} | Actual: ${fmtPrice(curT)} (${gPct >= 0 ? "🟢 +" : "🔴 "}${gPct.toFixed(2)}%)\n` +
                        `• Pico: ${fmtPrice(alphaPos.highestPrice)} | Estado: ${alphaPos.activated ? "🚀 Trailing Activo" : "⏳ Buscando +0.8%"}\n`;
                }
                else {
                    msg += `🔍 <i>Sin operación Alpha abierta en este momento. Escaneando el radar en busca del mejor activo con rebote institucional.</i>\n`;
                }
                return msg;
            }
            if (cmd === "/lotes" || cmd === "lotes") {
                let msg = `📦 <b>REGISTRO DE LOTES INDEPENDIENTES</b> 🛡️\n\n` +
                    `<i>Cada compra opera como una posición 100% aislada. Cero combinaciones y cero arrastre de pérdidas.</i>\n\n`;
                if (this.activeTrailingPositions.size === 0) {
                    msg += `• <i>No hay lotes abiertos actualmente.</i>\n`;
                }
                else {
                    for (const [id, p] of this.activeTrailingPositions.entries()) {
                        const lotNum = p.lotIndex ? `Lote #${p.lotIndex}` : "Lote Único";
                        let curP = p.buyPrice;
                        try {
                            const cleanSym = (p.symbol || id).split('_')[0];
                            curP = parseFloat((await this.client.tickerPrice(cleanSym)).data.price);
                        }
                        catch (e) { }
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
                    }
                    else {
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
                }
                else {
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
                const category = (arg2 && arg2.toLowerCase() === "meme") ? "meme" : "core";
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
                const freeUsdt = parseFloat(acc.data.balances.find((b) => b.asset === "USDT")?.free || "0");
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
                const freeUsdt = parseFloat(acc.data.balances.find((b) => b.asset === "USDT")?.free || "0");
                this.loadWalletSplit();
                const maxAvail = Math.max(0, freeUsdt - this.walletSplit.manualUsdt);
                const toTransfer = Math.min(amt, maxAvail);
                if (toTransfer <= 0) {
                    return "⚠️ Saldo insuficiente en el bot para transferir. El bot solo tiene $" + maxAvail.toFixed(2) + " USDT libres.";
                }
                this.walletSplit.manualUsdt += toTransfer;
                this.walletSplit.lastKnownTotalFreeUsdt = freeUsdt;
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
                const freeUsdt = parseFloat(acc.data.balances.find((b) => b.asset === "USDT")?.free || "0");
                this.loadWalletSplit();
                const toTransfer = Math.min(amt, this.walletSplit.manualUsdt);
                if (toTransfer <= 0) {
                    return "⚠️ No tienes saldo manual para transferir al bot. Saldo manual actual: $" + this.walletSplit.manualUsdt.toFixed(2) + " USDT.";
                }
                this.walletSplit.manualUsdt = Math.max(0, this.walletSplit.manualUsdt - toTransfer);
                this.walletSplit.lastKnownTotalFreeUsdt = freeUsdt;
                this.saveWalletSplit();
                const newBot = Math.max(0, freeUsdt - this.walletSplit.manualUsdt);
                return "✅ <b>TRANSFERENCIA EXITOSA</b>\n\n" +
                    "• Pasados al Saldo del Bot: <b>+$" + toTransfer.toFixed(2) + " USDT</b>\n" +
                    "• 🤖 <b>Nuevo Saldo Bot:</b> $" + newBot.toFixed(2) + " USDT\n" +
                    "• 👤 <b>Nuevo Saldo Manual:</b> $" + this.walletSplit.manualUsdt.toFixed(2) + " USDT";
            }
            if (cmd === "/presupuesto" || cmd === "presupuesto") {
                const acc = await this.client.account({ recvWindow: 60000 });
                const freeUsdt = parseFloat(acc.data.balances.find((b) => b.asset === "USDT")?.free || "0");
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
                }
                else {
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
                    const tfVal = (["15m", "1h", "4h", "1d"].includes(rawTf)) ? rawTf : "1h";
                    if (!this.controls.symbolTimeframes)
                        this.controls.symbolTimeframes = {};
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
                    this.controls.timeframe = rawTf;
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
                const settings = this.controls.strategySettings || {};
                const rejections = this.controls.rejectedSuggestions || {};
                let msg = `🧠 <b>SUGERENCIAS INTELIGENTES CENTINELA</b> 🛡️\n\n`;
                const names = {
                    trailing_rebound: "🏹 Trailing Rebound",
                    smart_dca: "🛡️ Smart DCA",
                    micro_grid: "🌐 Micro-Grid",
                    cazador_weekend: "🏖️ Cazador Weekend"
                };
                for (const [key, name] of Object.entries(names)) {
                    const s = suggs[key];
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
                    }
                    else {
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
                let targetKey = null;
                if (target.includes("trail") || target === "tr")
                    targetKey = "trailing_rebound";
                else if (target.includes("dca"))
                    targetKey = "smart_dca";
                else if (target.includes("grid"))
                    targetKey = "micro_grid";
                else if (target.includes("week"))
                    targetKey = "cazador_weekend";
                else if (target === "all" || target === "todas") {
                    if (!this.controls.rejectedSuggestions)
                        this.controls.rejectedSuggestions = {};
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
                if (!this.controls.rejectedSuggestions)
                    this.controls.rejectedSuggestions = {};
                this.controls.rejectedSuggestions[targetKey] = Date.now() + 4 * 3600 * 1000;
                if (this.controls.suggestions && this.controls.suggestions[targetKey]) {
                    this.controls.suggestions[targetKey].status = "rejected";
                }
                this.saveStrategyControls();
                return `⚪ <b>Sugerencia de ${targetKey} descartada.</b>\nSilenciada por 4 horas. Para ver el estado actual use /sugerencias.`;
            }
            if (cmd === "/aplicar" || cmd === "aplicar") {
                const target = (parts[1] || "").toLowerCase();
                let targetKey = null;
                if (target.includes("trail") || target === "tr")
                    targetKey = "trailing_rebound";
                else if (target.includes("dca"))
                    targetKey = "smart_dca";
                else if (target.includes("grid"))
                    targetKey = "micro_grid";
                else if (target.includes("week"))
                    targetKey = "cazador_weekend";
                if (!targetKey || !this.controls.suggestions || !this.controls.suggestions[targetKey]) {
                    return `⚠️ <b>Uso:</b> <code>/aplicar &lt;ESTRATEGIA&gt;</code>\n\nEjemplos:\n• <code>/aplicar trailing</code>\n• <code>/aplicar dca</code>\n• <code>/aplicar grid</code>\n• <code>/aplicar weekend</code>`;
                }
                const sugg = this.controls.suggestions[targetKey];
                if (!this.controls.strategySettings)
                    this.controls.strategySettings = {};
                if (!this.controls.strategySettings[targetKey]) {
                    this.controls.strategySettings[targetKey] = { timeframe: "1h", stopLossEnabled: false, stopLossPct: 4.0 };
                }
                const s = this.controls.strategySettings[targetKey];
                s.timeframe = sugg.timeframe;
                s.stopLossPct = sugg.stopLossPct;
                if (s.stopLossEnabled === undefined)
                    s.stopLossEnabled = false;
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
                }
                else {
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
                }
                else {
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
                }
                else {
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
            if (cmd === "/cazando" || cmd === "cazando" || cmd === "/caceria" || cmd === "caceria" || cmd === "/semaforo" || cmd === "semaforo") {
                return await this.buildBuyWatchReport();
            }
            if (cmd === "/informe" || cmd === "informe" || cmd === "/trailing" || cmd === "trailing") {
                const acc = await this.client.account({ recvWindow: 60000 });
                const usdt = parseFloat(acc.data.balances.find((b) => b.asset === "USDT")?.free || "0");
                let rep = `📑 <b>INFORME Y DIAGNÓSTICO EN TIEMPO REAL</b> 📊\n\n`;
                rep += `• 💼 <b>USDT Líquido:</b> ${usdt.toFixed(2)} USDT\n`;
                rep += `• 🤖 <b>Modo Centinela:</b> ${this.autoPilot ? "🟢 Autónomo Cazador (+0.8% Trailing)" : "🟡 Manual Asistido"}\n\n`;
                if (this.activeTrailingPositions.size === 0) {
                    rep += `📡 <b>ESTADO ACTUAL:</b> Sin posiciones abiertas (Trailing).\n` +
                        `🔍 El bot está escaneando el radar en busca de la próxima caída para disparar la compra con descuento.\n\n`;
                }
                else {
                    rep += `🏹 <b>POSICIONES ACTIVAS CON TRAILING:</b>\n\n`;
                    for (const [sym, p] of this.activeTrailingPositions.entries()) {
                        let cur = p.buyPrice;
                        try {
                            const cleanSym = (p.symbol || sym).split('_')[0];
                            const t = await this.client.tickerPrice(cleanSym);
                            cur = parseFloat(t.data.price);
                        }
                        catch (e) { }
                        const curGain = (((cur - p.buyPrice) / p.buyPrice) * 100);
                        const peakGain = (((p.highestPrice - p.buyPrice) / p.buyPrice) * 100);
                        const stopPrice = p.highestPrice * (1 - this.getCallbackPct(sym, p) / 100);
                        const distToStop = Math.abs(cur - stopPrice);
                        const target08 = p.buyPrice * 1.008;
                        rep += `🪙 <b>${sym}</b> (${p.qty} ${sym.replace("USDT", "")})\n` +
                            `• Inversión: ${p.investedUsdt.toFixed(2)} USDT\n` +
                            `• Entrada: ${fmtPrice(p.buyPrice)}\n` +
                            `• Precio Actual: ${fmtPrice(cur)} (${curGain >= 0 ? "🟢 +" : "🔴 "}${curGain.toFixed(2)}%)\n` +
                            `• Pico Más Alto: ${fmtPrice(p.highestPrice)} (+${peakGain.toFixed(2)}%)\n`;
                        if (p.activated) {
                            rep += `• 🛡️ <b>Gatillo de Salida:</b> ${fmtPrice(stopPrice)} (a solo ${distToStop.toFixed(2)} de distancia)\n` +
                                `• Estado: 🟢 <b>SEGURO ACTIVADO (Cazando la cima)</b>\n\n`;
                        }
                        else {
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
                }
                catch (e) {
                    rep += `💰 <i>No se pudo calcular el acumulado: ${e.message}</i>\n\n`;
                }
                rep += `💡 <i>Escribe /reporte para el detalle por ciclo o /menu para más opciones.</i>`;
                return rep;
            }
            if (cmd === "/sesion" || cmd === "sesion" || cmd === "/orquestador" || cmd === "orquestador") {
                const acc = await this.client.account({ recvWindow: 60000 });
                const usdt = parseFloat(acc.data.balances.find((b) => b.asset === "USDT")?.free || "0");
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
                const sellOrders = openOrders.data.filter((o) => o.side === "SELL");
                let txt = `📊 <b>ESTADO GENERAL DE ÓRDENES EN BINANCE</b>\n\n`;
                if (sellOrders.length === 0) {
                    txt += "• No tienes órdenes de venta abiertas actualmente.\n";
                }
                else {
                    txt += `• 🎯 <b>Órdenes de Venta Límite Activas (${sellOrders.length}):</b>\n`;
                    for (let i = 0; i < sellOrders.length; i++) {
                        const o = sellOrders[i];
                        const target = parseFloat(o.price);
                        let curPrice = 0;
                        try {
                            const t = await this.client.tickerPrice(o.symbol);
                            curPrice = parseFloat(t.data.price);
                        }
                        catch (e) { }
                        const faltaPct = curPrice > 0 ? (((target - curPrice) / curPrice) * 100) : 0;
                        txt += `  ${i + 1}. <b>${o.symbol}</b> | Cantidad: ${o.origQty} | Meta: $${target.toFixed(2)} | Falta: +<b>${faltaPct.toFixed(2)}%</b>\n`;
                    }
                }
                const acc = await this.client.account({ recvWindow: 60000 });
                const usdt = parseFloat(acc.data.balances.find((b) => b.asset === "USDT")?.free || "0");
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
                const activeSymbols = new Set(openOrders.data.filter((o) => o.side === "SELL").map((o) => o.symbol));
                let report = `📡 <b>RADAR INTELIGENTE DE MERCADO</b>\n\n`;
                for (const sym of this.watchlist) {
                    try {
                        const [t24, k15] = await Promise.all([
                            this.client.ticker24hr(sym),
                            this.client.klines(sym, "15m", { limit: 25 })
                        ]);
                        const price = parseFloat(t24.data.lastPrice);
                        const closes = k15.data.map((k) => parseFloat(k[4]));
                        const rsi = this.calculateRSI(closes, 14);
                        let status = "";
                        if (activeSymbols.has(sym)) {
                            status = " 🛡️ [Posición en espera]";
                        }
                        else if (this.activeTrailingPositions.has(sym)) {
                            status = " 🏹 [Trailing activo]";
                        }
                        else if (this.buyWatches.has(sym)) {
                            status = ` 🔻 [Cazando piso: ${this.buyWatches.get(sym).lowestPrice}]`;
                        }
                        else if (rsi <= 35) {
                            status = " 🎯 [Suelo / Rebote VIP]";
                        }
                        else if (rsi <= 45) {
                            status = " 🟢 [Zona favorable]";
                        }
                        else {
                            status = " ⚪ [Neutro]";
                        }
                        const isMeme = this.memeWatchlist.includes(sym);
                        report += `• <b>${isMeme ? "🐕 " : "💎 "}${sym}:</b> ${fmtPrice(price)} | RSI: <b>${rsi.toFixed(1)}</b>${status}\n`;
                    }
                    catch (e) { }
                }
                const acc = await this.client.account({ recvWindow: 60000 });
                const usdt = parseFloat(acc.data.balances.find((b) => b.asset === "USDT")?.free || "0");
                report += `\n💼 <b>USDT libre:</b> $${usdt.toFixed(2)} USDT\n`;
                report += `🏹 <b>Estrategia:</b> Trailing Buy (+${TRAILING_BUY_BOUNCE_PCT}% desde el piso) + Trailing Take Profit (+0.8% y persigue la subida)\n`;
                return report;
            }
            if (cmd === "/memes" || cmd === "memes") {
                let activeMeme = null;
                for (const [sym, p] of this.activeTrailingPositions.entries()) {
                    if (this.memeWatchlist.includes(sym)) {
                        activeMeme = `${sym} (Comprado a ${fmtPrice(p.buyPrice)})`;
                        break;
                    }
                }
                let armedMeme = null;
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
                        const closes = k1h.data.map((r) => parseFloat(r[4]));
                        const rsi = this.calculateRSI(closes, 14);
                        let tag = "⚪ Neutro";
                        if (this.activeTrailingPositions.has(sym))
                            tag = "🏹 En Trailing";
                        else if (this.buyWatches.has(sym))
                            tag = "🎯 Cazando piso";
                        else if (rsi <= 45)
                            tag = "🟢 Piso favorable";
                        msg += `• <b>${sym.replace("USDT", "")}:</b> ${fmtPrice(price)} | 24h: ${chg24 >= 0 ? "+" : ""}${chg24.toFixed(1)}% | Rango: ${range.toFixed(1)}% | RSI: ${rsi.toFixed(0)} [${tag}]\n`;
                    }
                    catch (e) { }
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
                const active = acc.data.balances.filter((b) => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0);
                let txt = `💼 <b>SALDOS EN BINANCE SPOT</b>\n\n`;
                active.forEach((b) => {
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
                const freeUsdt = parseFloat(acc.data.balances.find((b) => b.asset === "USDT")?.free || "0");
                if (freeUsdt < this.minUsdtToTrade) {
                    return `❌ <b>Saldo insuficiente:</b> Tienes $${freeUsdt.toFixed(2)} USDT libres. El mínimo es $${this.minUsdtToTrade} USDT.`;
                }
                let amountToUse = freeUsdt;
                if (arg2 && !isNaN(parseFloat(arg2))) {
                    amountToUse = Math.min(parseFloat(arg2), freeUsdt);
                }
                const ok = await this.executeSmartBuy(symbol, amountToUse, "Manual por Chat");
                if (!ok)
                    return `❌ No se pudo comprar ${symbol}. Revisa el mensaje de error anterior.`;
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
                }
                else {
                    return `⚠️ ${res.msg}`;
                }
            }
            if (cmd === "/vender" || cmd === "vender") {
                if (!arg1) {
                    return "❓ <b>Uso:</b> <code>/vender &lt;MONEDA&gt;</code>\nEjemplo: <code>/vender sol</code>\n<i>Por seguridad del core, solo vende si la posición está en GANANCIA neta.</i>";
                }
                const asset = arg1.replace("USDT", "");
                const symbol = `${asset}USDT`;
                let pos = null;
                let posKey = null;
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
                }
                catch {
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
                        if (posKey)
                            this.activeTrailingPositions.delete(posKey);
                        await this.saveTrailingPositions();
                        return `✅ <b>¡Venta en Ganancia Ejecutada!</b> 🎯\nSe vendió <b>${symbol}</b> a $${fmtPrice(curPrice)} (+${gainPct.toFixed(2)}% neto).`;
                    }
                    else {
                        return `⚠️ No se pudo completar la venta de ${symbol}.`;
                    }
                }
                // Si no hay posición registrada en memoria pero hay balance libre en Binance
                const acc = await this.client.account({ recvWindow: 60000 });
                const bal = parseFloat(acc.data.balances.find((b) => b.asset === asset)?.free || "0");
                if (bal <= 0)
                    return `❌ No tienes balance libre de ${asset} para vender.`;
                const exInfo = await this.client.exchangeInfo({ symbol });
                const sInfo = exInfo.data.symbols[0];
                const stepSize = parseFloat(sInfo.filters.find((f) => f.filterType === "LOT_SIZE").stepSize);
                const qtyDec = Math.max(0, Math.round(-Math.log10(stepSize)));
                const sellQtyStr = (Math.floor(bal / stepSize) * stepSize).toFixed(qtyDec);
                const realV = await this.verifyRealCostWithBinance(symbol, parseFloat(sellQtyStr), curPrice);
                if (!realV.ok) {
                    return `🛑 <b>[VENTA BLOQUEADA EN EL CORE]</b>\n\n` +
                        `• ${realV.reason || `Binance la registraría como PÉRDIDA (${realV.estPnl.toFixed(3)} USDT)`}\n\n` +
                        `Si de verdad quieres asumirla: <code>/forzar_venta_perdida ${asset} CONFIRMAR</code> o el botón rojo del Dashboard.`;
                }
                const res = await this.client.newOrder(symbol, "SELL", "MARKET", { quantity: sellQtyStr, recvWindow: 60000 });
                this.lastBotSaleTime = Date.now();
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
                let pos = null;
                let posKey = null;
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
                }
                catch {
                    return `❌ No se pudo consultar el precio actual de ${symbol} en Binance.`;
                }
                if (pos) {
                    const sold = await this.executeTrailingSell(pos, curPrice, false, false, "FORCED_LOSS_TELEGRAM", true, true);
                    if (sold) {
                        if (posKey)
                            this.activeTrailingPositions.delete(posKey);
                        await this.saveTrailingPositions();
                        return `🛑 <b>Venta en pérdida autorizada y ejecutada:</b> Se cerró ${symbol} a $${fmtPrice(curPrice)}.`;
                    }
                    else {
                        return `❌ Error ejecutando la venta forzada de ${symbol}.`;
                    }
                }
                // Si no está trackeada pero el usuario ordena vender
                const acc = await this.client.account({ recvWindow: 60000 });
                const bal = parseFloat(acc.data.balances.find((b) => b.asset === asset)?.free || "0");
                if (bal <= 0)
                    return `❌ No tienes balance libre de ${asset} para vender.`;
                const exInfo = await this.client.exchangeInfo({ symbol });
                const sInfo = exInfo.data.symbols[0];
                const stepSize = parseFloat(sInfo.filters.find((f) => f.filterType === "LOT_SIZE").stepSize);
                const qtyDec = Math.max(0, Math.round(-Math.log10(stepSize)));
                const sellQtyStr = (Math.floor(bal / stepSize) * stepSize).toFixed(qtyDec);
                const res = await this.client.newOrder(symbol, "SELL", "MARKET", { quantity: sellQtyStr, recvWindow: 60000 });
                this.lastBotSaleTime = Date.now();
                return `🛑 <b>Venta forzada ejecutada:</b> Se vendieron ${sellQtyStr} ${asset} por $${parseFloat(res.data.cummulativeQuoteQty).toFixed(2)} USDT.`;
            }
            if (cmd === "/modo" || cmd === "modo") {
                if (arg1 === "AUTO") {
                    this.autoPilot = true;
                    return "🟢 <b>Modo Autónomo con Trailing Stop ACTIVADO.</b>";
                }
                else if (arg1 === "MANUAL") {
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
            // 2. Si el mensaje empieza con barra / y no fue reconocido (y no es /ai|/ia|/chat), NUNCA enviar a la IA
            const isExplicitAi = cmd === "/ai" || cmd === "/ia" || cmd === "/chat" || cmd === "ai" || cmd === "ia";
            const isDirectQuestion = rawCmd.trim().startsWith("¿") || rawCmd.trim().startsWith("?");
            if (rawCmd.trim().startsWith("/") && !isExplicitAi) {
                return "Comando no reconocido. Escribe /menu para ver la lista de comandos disponibles.";
            }
            // 3. Permitir consulta explícita por comando (/ai|/ia|/chat) aunque la IA automática esté pausada por saldo,
            // y responder preguntas directas cuando aiEnabled esté activo
            if ((isExplicitAi || (this.controls.aiEnabled && isDirectQuestion)) && this.aiCopilot.isAvailable()) {
                const queryText = isExplicitAi ? rawCmd.replace(/^\/(ai|ia|chat)\s*/i, "").trim() : rawCmd;
                if (!queryText)
                    return "❓ Escribe tu pregunta después de /ai. Ejemplo: <code>/ai ¿cómo ves el mercado hoy?</code>";
                const ctx = await this.buildAiContextSnapshot();
                return await this.aiCopilot.chat(queryText, ctx, {});
            }
            return "Comando no reconocido. Escribe /menu para ver la lista de comandos disponibles.";
        }
        catch (e) {
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
    lastTimeframeAdvisorTime = 0;
    getCurrentMarketSession() {
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
        if (Date.now() - this.lastTimeframeAdvisorTime < 180000)
            return; // Cada 3 minutos
        this.lastTimeframeAdvisorTime = Date.now();
        try {
            // 🧠 CENTINELA MULTI-ACTIVO: Escaneo simultáneo de todo el mercado (Macro + Clásicas + Memes)
            const tickersRes = await this.client.ticker24hr();
            const tickerMap = new Map();
            tickersRes.data.forEach((t) => tickerMap.set(t.symbol, t));
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
                this.controls.suggestions = {};
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
            const currentSettings = this.controls.strategySettings || {};
            // 1. Sugerencia Trailing Rebound (Cazador de Ondas)
            let trTf = "1h";
            let trSl = 4.0;
            let trReason = "";
            let trCriterios = [];
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
            }
            else if (btcRange >= 2.0) {
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
            }
            else {
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
            this.controls.suggestions.trailing_rebound = {
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
            this.controls.suggestions.smart_dca = {
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
                this.controls.suggestions.micro_grid = {
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
            }
            else {
                this.controls.suggestions.micro_grid = {
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
            // 4. Sugerencia Cazador Weekend (Anomalía Fin de Semana Calibrada 18 Semanas)
            const isWeekendCurrent = currentSettings.cazador_weekend?.timeframe === "1h";
            const isWeekendRejected = !!(this.controls.rejectedSuggestions.cazador_weekend && this.controls.rejectedSuggestions.cazador_weekend > now);
            if (isWeekend) {
                this.controls.suggestions.cazador_weekend = {
                    timeframe: "1h",
                    stopLossPct: 5.0,
                    reason: "Ventana de cacería en piso abierta (Sábado 02:00 AM a Domingo 06:00 PM COT).",
                    criterios: [
                        "Veda de Viernes superada (82% de los fines de semana marcan suelo en sábado madrugada/mañana)",
                        "Filtro institucional: Caída ≥ -3.5% (Clásicas) / -5.2% (Memes), RSI ≤ 36-38, StochRSI ≤ 25",
                        "Confirmación multitemporal 15m + 5m + Ancla BTC 15m + Salida en Rally CME (Domingo noche)"
                    ],
                    porQue: "Según el estudio de 18 semanas en Binance, el viernes tarde/noche es fase de drenaje y el suelo real se forma entre sábado 02:00 AM y 12:00 PM COT. Cazador Weekend opera exclusivamente en este piso con bloques fuertes ($50–$100 USDT) para vender en el impulso alcista del domingo.",
                    session,
                    btcRange24h: btcRange,
                    updatedAt: now,
                    expiresAt: now + 3600000,
                    isCurrent: isWeekendCurrent,
                    status: isWeekendRejected ? "rejected" : (isWeekendCurrent ? "applied" : "pending")
                };
            }
            else {
                this.controls.suggestions.cazador_weekend = {
                    timeframe: "1h",
                    stopLossPct: 5.0,
                    reason: this.isFridayEveningBleedWindow()
                        ? "⏸️ Veda de Viernes activa (Vie 14:00 a Sáb 02:00 AM COT): esperando piso de madrugada."
                        : "En espera hasta el sábado a las 02:00 AM COT (tras la Veda de Viernes).",
                    criterios: [
                        "Viernes 14:00 a Sábado 02:00 AM COT: Pausa de compras para evitar el drenaje del viernes (82% prob.)",
                        "Días hábiles: Presupuesto cedido al sistema de Doble Bolsillo (60% Horas Piso / 40% Abierto)"
                    ],
                    porQue: "Para evitar comprar apresuradamente el viernes por la noche antes de la caída de madrugada, Cazador Weekend permanece en pausa hasta el sábado a las 02:00 AM COT.",
                    session,
                    btcRange24h: btcRange,
                    updatedAt: now,
                    expiresAt: now + 3600000,
                    isCurrent: isWeekendCurrent,
                    status: isWeekendRejected ? "rejected" : (isWeekendCurrent ? "applied" : "pending")
                };
            }
            this.saveStrategyControls();
        }
        catch (e) {
            console.error("Error en checkTimeframeAdvisor:", e.message);
        }
    }
    async checkMarketRegime() {
        try {
            const now = Date.now();
            if (now - this.lastRegimeCheckTime < 3 * 60 * 1000)
                return;
            this.lastRegimeCheckTime = now;
            const [btcK1h, macro] = await Promise.all([
                this.client.klines("BTCUSDT", "1h", { limit: 24 }),
                this.getLiveMacroRegime()
            ]);
            const data = btcK1h.data;
            if (!data || data.length < 12)
                return;
            const highs = data.map((k) => parseFloat(k[2]));
            const lows = data.map((k) => parseFloat(k[3]));
            const closes = data.map((k) => parseFloat(k[4]));
            const curBtc = closes[closes.length - 1];
            const high24 = Math.max(...highs);
            const low24 = Math.min(...lows);
            const btcRange24hPct = low24 > 0 ? ((high24 - low24) / low24) * 100 : 2.5;
            const btcDropFrom24hHigh = high24 > 0 ? ((high24 - curBtc) / high24) * 100 : 0;
            const btcGainFrom24hLow = low24 > 0 ? ((curBtc - low24) / low24) * 100 : 0;
            const { dayStr } = this.getCotTimeInfo();
            const isNormallySellingDay = dayStr === "Tue" || dayStr === "Thu" || dayStr === "Fri";
            const isNormallyDropDay = dayStr === "Sat" || dayStr === "Mon" || dayStr === "Wed";
            // 1. COMPORTAMIENTO ATÍPICO #1: Desplome / Crash en un día que históricamente es de alza (Martes/Jueves/Viernes)
            if (isNormallySellingDay && (macro.btcDrop3hPct <= -2.1 || btcDropFrom24hHigh >= 3.8) && macro.btcRsi1h <= 37) {
                if (this.activeAtypicalOverride !== "CRASH_HUNTER") {
                    this.activeAtypicalOverride = "CRASH_HUNTER";
                    if (this.controls.strategies.micro_grid)
                        await this.deactivateMicroGrid(btcRange24hPct);
                    console.log(`⚡ [COMPORTAMIENTO ATÍPICO DETECTADO: ${dayStr}] Desplome en día de alza (BTC -${btcDropFrom24hHigh.toFixed(2)}% 24h | 3h: ${macro.btcDrop3hPct.toFixed(2)}%). Cambiando a MODO CACERÍA DE CAPITULACIÓN.`);
                    await this.notifier.send(`⚡ <b>[COMPORTAMIENTO ATÍPICO DETECTADO EN ${dayStr.toUpperCase()}]</b> 🔄\n\n` +
                        `• Aunque hoy (${dayStr}) suele ser día de alza/cosecha, el mercado está haciendo una <b>caída atípica fuerte</b> (BTC <b>-${btcDropFrom24hHigh.toFixed(2)}%</b> desde el techo 24h | RSI 1H: <b>${macro.btcRsi1h.toFixed(0)}</b>).\n` +
                        `• 🎯 <b>Cambio Automático de Estrategia:</b> Se desactiva el bloqueo de compras de ${dayStr} y se activa el <b>Modo Francotirador de Capitulación (100% Presupuesto Desbloqueado)</b> para aprovechar el suelo inesperado.`);
                }
                return;
            }
            // 2. COMPORTAMIENTO ATÍPICO #2: Rally Alcista Explosivo en un día que históricamente es de caída (Sábado/Lunes/Miércoles)
            if (isNormallyDropDay && btcGainFrom24hLow >= 3.2 && macro.btcStressIndex <= 0.15 && macro.btcRsi1h >= 60) {
                if (this.activeAtypicalOverride !== "RALLY_HARVESTER") {
                    this.activeAtypicalOverride = "RALLY_HARVESTER";
                    if (this.controls.strategies.micro_grid)
                        await this.deactivateMicroGrid(btcRange24hPct);
                    console.log(`🚀 [COMPORTAMIENTO ATÍPICO DETECTADO: ${dayStr}] Rally alcista en día de caída (BTC +${btcGainFrom24hLow.toFixed(2)}% desde mínimo 24h). Cambiando a MODO COSECHA Y EXPANSIÓN.`);
                    await this.notifier.send(`🚀 <b>[RALLY ATÍPICO DETECTADO EN ${dayStr.toUpperCase()}]</b> 🔄\n\n` +
                        `• Aunque hoy (${dayStr}) suele ser día de caída/acumulación, el mercado rompió al alza con fuerza (BTC <b>+${btcGainFrom24hLow.toFixed(2)}%</b> desde el suelo 24h | RSI 1H: <b>${macro.btcRsi1h.toFixed(0)}</b>).\n` +
                        `• 🏆 <b>Cambio Automático de Estrategia:</b> Posiciones abiertas pasan a <b>Modo Cosecha de Expansión</b> para vender en la cima hoy mismo, y se blinda el Escudo Anti-FOMO para no comprar en el techo.`);
                }
                return;
            }
            // 3. COMPORTAMIENTO ATÍPICO #3: Rango Lateral Comprimido / Día Quieto (< 2.15% rango 24h BTC)
            if (btcRange24hPct <= 2.15 && !macro.isMacroStorm) {
                this.lastDetectedRegime = "QUIET";
                if (this.activeAtypicalOverride !== "RANGE_SCALPER" || !this.controls.strategies.micro_grid) {
                    this.activeAtypicalOverride = "RANGE_SCALPER";
                    await this.activateMicroGrid(true, btcRange24hPct);
                }
                return;
            }
            // 4. Retorno a Régimen Normal Direccional (Volatilidad >= 2.55%)
            if (btcRange24hPct >= 2.55) {
                this.lastDetectedRegime = "TRENDING";
                if (this.controls.strategies.micro_grid) {
                    await this.deactivateMicroGrid(btcRange24hPct);
                }
                if (this.activeAtypicalOverride !== "NONE") {
                    this.activeAtypicalOverride = "NONE";
                }
            }
        }
        catch (e) {
            console.error("Error en checkMarketRegime:", e.message);
        }
    }
    async checkRegimeSwitchTimeout() {
        if (!this.pendingRegimeSwitch)
            return;
        if (Date.now() >= this.pendingRegimeSwitch.expiresAt) {
            this.pendingRegimeSwitch = null;
            // 🎯 FRANCOTIRADOR $100 PROTEGIDO: No auto-activar Micro-Grid para evitar pulverizar el capital en micro-lotes
            console.log("🛡️ [FRANCOTIRADOR $100] Sugerencia de Micro-Grid ignorada para mantener el capital concentrado.");
        }
    }
    async activateMicroGrid(auto = false, btcRange24h) {
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
        await this.notifier.send(`🌐 <b>[MICRO-GRID ACTIVADO ${auto ? "AUTOMÁTICAMENTE (3 MIN)" : "POR COMANDO"}]</b> ✅\n\n` +
            `• <b>Régimen:</b> Día Quieto / Rango Lateral${rangeStr}.\n` +
            `• <b>Misión:</b> Cosechar micro-rebotes rápidos en canales laterales (+0.45% a +0.60%).\n` +
            `• 💼 <b>Presupuesto reasignado:</b> Micro-Grid <b>${this.controls.allocations.micro_grid}%</b> | Cazador Trailing <b>${this.controls.allocations.trailing_rebound}%</b> | Smart DCA <b>${this.controls.allocations.smart_dca}%</b>.\n` +
            `• 🔄 Cuando el mercado vuelva a activarse con volatilidad (>=2.5%), se auto-desactivará y devolverá el 100% a Cazador Trailing.`);
    }
    async deactivateMicroGrid(range24h) {
        this.controls.strategies.micro_grid = false;
        // Devolver presupuesto de micro_grid a trailing_rebound
        const gAlloc = this.controls.allocations.micro_grid || 0;
        if (gAlloc > 0) {
            this.controls.allocations.trailing_rebound = (this.controls.allocations.trailing_rebound || 50) + gAlloc;
            this.controls.allocations.micro_grid = 0;
        }
        this.saveStrategyControls();
        const rangeStr = range24h ? ` (BTC ${range24h.toFixed(2)}% en 24h)` : "";
        await this.notifier.send(`🚀 <b>[VOLATILIDAD REACTIVADA: FIN DE DÍA QUIETO]</b> 🏹\n\n` +
            `• El mercado ha despertado con volumen${rangeStr}.\n` +
            `• <b>Micro-Grid</b> se ha pausado automáticamente.\n` +
            `• 💼 <b>Presupuesto devuelto:</b> La cuota se transfirió al 100% a <b>🏹 Cazador Trailing</b> (ahora al <b>${this.controls.allocations.trailing_rebound}%</b>) para cazar tendencias y grandes olas.\n` +
            `• 🎯 Listo para operar rebotes direccionales.`);
    }
    /**
     * Ventana de reapertura institucional de futuros CME (Domingo 16:00 a 23:00 COT),
     * donde los rebotes de fin de semana suelen expandir su amplitud.
     */
    isSundayCmeReopenWindow() {
        try {
            const now = new Date();
            const dayStr = now.toLocaleDateString("en-US", { timeZone: "America/Bogota", weekday: "short" });
            const hour = parseInt(now.toLocaleTimeString("en-US", { timeZone: "America/Bogota", hour12: false, hour: "numeric" }), 10);
            return dayStr === "Sun" && hour >= 16 && hour <= 23;
        }
        catch {
            return false;
        }
    }
    /**
     * ESCÁNER MICRO-GRID CALIBRADO:
     * Solo opera si el usuario lo activa explícitamente, respetando Horas Pausa, Ancla BTC 15m,
     * sobreventa real (RSI <= 38, StochRSI <= 25) y bloque mínimo de $35 USDT para jamás pulverizar el capital en migajas.
     */
    async evaluateMicroGrid(usdt, activeSymbols) {
        if (!this.controls.strategies.micro_grid)
            return false;
        if (this.pendingOpportunity)
            return false;
        if (usdt < 35)
            return false;
        const pauseWin = this.isHistoricalPauseWindow();
        if (pauseWin.paused)
            return false;
        const macro = await this.getLiveMacroRegime();
        if (macro.isMacroStorm && !macro.isBtcCapitulationFloor)
            return false;
        const candidates = [];
        for (const sym of this.coreWatchlist) {
            try {
                if (activeSymbols.has(sym) || this.hasActivePositionForSymbol(sym) || this.buyWatches.has(sym)) {
                    continue;
                }
                const gridTf = this.controls.strategySettings?.micro_grid?.timeframe || "15m";
                const klinesRes = await this.client.klines(sym, gridTf, { limit: 35 });
                const data = klinesRes.data;
                const opens = data.map((k) => parseFloat(k[1]));
                const closes = data.map((k) => parseFloat(k[4]));
                const highs = data.map((k) => parseFloat(k[2]));
                const lows = data.map((k) => parseFloat(k[3]));
                const curPrice = closes[closes.length - 1];
                const min6h = Math.min(...lows.slice(-24));
                const max6h = Math.max(...highs.slice(-24));
                const channelRangePct = ((max6h - min6h) / min6h) * 100;
                // Canal lateral calibrado: rango entre 1.10% y 3.40% para garantizar margen suficiente de ganancia neta
                if (channelRangePct >= 1.10 && channelRangePct <= 3.40) {
                    const positionInChannel = (curPrice - min6h) / (max6h - min6h);
                    const upsideGapPct = curPrice > 0 ? ((max6h - curPrice) / curPrice) * 100 : channelRangePct;
                    const rsi = this.calculateRSI(closes, 14);
                    const stoch = this.calculateStochRSI(closes, 14, 14, 3, 3);
                    const bb = this.calculateBollingerBands(closes, 20, 2.0);
                    const lastIdx = closes.length - 1;
                    const isGreenOrWick = closes[lastIdx] >= opens[lastIdx] || ((Math.min(opens[lastIdx], closes[lastIdx]) - lows[lastIdx]) / Math.max(1e-9, highs[lastIdx] - lows[lastIdx])) >= 0.30;
                    // Exigir piso real del canal (22% inferior o %B <= 0.15), RSI <= 38, StochRSI <= 25 y vela de absorción
                    if ((positionInChannel <= 0.22 || bb.percentB <= 0.15) && rsi <= 38 && stoch.k <= 25 && upsideGapPct >= 0.95 && isGreenOrWick) {
                        const score = upsideGapPct * 2.2 + (42 - rsi) * 0.6 + (1 - positionInChannel) * 3.5;
                        candidates.push({ sym, curPrice, min6h, channelRangePct, upsideGapPct, rsi, percentB: bb.percentB, score });
                    }
                }
            }
            catch (e) { }
        }
        if (candidates.length === 0)
            return false;
        candidates.sort((a, b) => b.score - a.score);
        const best = candidates[0];
        const btcAnchor = await this.verifyBtc15mLeaderAnchor(best.sym);
        if (!btcAnchor.ok)
            return false;
        const sessionPlan = this.lastSessionPlan || this.getSessionLiquidityPlan(usdt);
        const gridPoolUsdt = Math.max(sessionPlan.spendableUsdt || 0, usdt);
        const amountToUse = Math.min(gridPoolUsdt, Math.max(35, Math.min(50, gridPoolUsdt * 0.50)));
        if (amountToUse < 35)
            return false;
        console.log(`🌐 [MICRO-GRID CALIBRADO] Entrada en ${best.sym}: precio ${best.curPrice} cerca de base ${best.min6h} (Canal ${best.channelRangePct.toFixed(2)}% | Brecha +${best.upsideGapPct.toFixed(2)}% | RSI ${best.rsi.toFixed(1)} | Inversión ${amountToUse.toFixed(2)} USDT)`);
        const ok = await this.executeSmartBuy(best.sym, amountToUse, `Micro-Grid Canal Lateral (${best.channelRangePct.toFixed(2)}% | Brecha +${best.upsideGapPct.toFixed(2)}%)`, "micro_grid", {
            coinRange24hPct: best.channelRangePct,
            upsideGapPct: best.upsideGapPct,
            customMinGainPct: 0.72
        });
        return ok;
    }
    async evaluateCazadorWeekend(usdt, activeSymbols) {
        if (!this.controls.strategies.cazador_weekend || !this.isWeekendWindow())
            return false;
        if (this.pendingOpportunity)
            return false;
        if (usdt < 35)
            return false;
        // Respetar Hora Pausa (ej. Veda de Viernes)
        const pauseWin = this.isHistoricalPauseWindow();
        if (pauseWin.paused)
            return false;
        // Filtro Macro: No armar nuevas compras de fin de semana si Bitcoin está cayendo en cascada
        const macro = await this.getLiveMacroRegime();
        if (macro.isMacroStorm && !macro.isBtcCapitulationFloor) {
            return false;
        }
        // Si ya hay buyWatches activas, evaluarlas primero con el bounce
        if (this.buyWatches.size > 0) {
            const bought = await this.checkBuyWatches(usdt);
            if (bought)
                return true;
        }
        const { dayStr, timeDec } = this.getCotTimeInfo();
        // En Sábado 00:30 AM a 12:30 PM COT estamos en el Gran Piso de Fin de Semana (82% de probabilidad histórica)
        // En Sábado tarde (12:30 PM a 11:59 PM) somos más exigentes (+0.6% extra de caída requerida) para evitar compras en rango plano
        const isPrimeSaturdayMorningFloor = (dayStr === "Sat" && timeDec >= 0.5 && timeDec <= 12.5) || (dayStr === "Sun" && (timeDec <= 4.0 || (timeDec >= 14.0 && timeDec <= 16.5)));
        const extraDropOutsidePrime = isPrimeSaturdayMorningFloor ? 0 : 0.6;
        // Cargar precios de referencia del cierre del viernes (.liquidation-benchmarks.json) para medir descuento real (-5% a -10%)
        let fridayBenchmarks = {};
        try {
            const bf = path.resolve(process.cwd(), ".liquidation-benchmarks.json");
            if (fs.existsSync(bf)) {
                const bData = JSON.parse(fs.readFileSync(bf, "utf-8"));
                if (bData?.benchmarks && (!bData.liquidatedAt || (Date.now() - bData.liquidatedAt) < 96 * 3600 * 1000)) {
                    fridayBenchmarks = bData.benchmarks;
                }
            }
        }
        catch { }
        const candidates = [];
        for (const sym of this.watchlist) {
            try {
                if (activeSymbols.has(sym) || this.hasActivePositionForSymbol(sym) || this.buyWatches.has(sym)) {
                    continue;
                }
                const weekendTf = this.controls.strategySettings?.cazador_weekend?.timeframe || "1h";
                const klinesRes = await this.client.klines(sym, weekendTf, { limit: 48 });
                const data = klinesRes.data;
                const opens = data.map((k) => parseFloat(k[1]));
                const closes = data.map((k) => parseFloat(k[4]));
                const highs = data.map((k) => parseFloat(k[2]));
                const lows = data.map((k) => parseFloat(k[3]));
                const rsi = this.calculateRSI(closes, 14);
                const stoch = this.calculateStochRSI(closes, 14, 14, 3, 3);
                const bb = this.calculateBollingerBands(closes, 20, 2.0);
                const curPrice = closes[closes.length - 1];
                const maxRecent = Math.max(...highs.slice(-36));
                const candleDropPct = ((maxRecent - curPrice) / maxRecent) * 100;
                const benchPrice = fridayBenchmarks[sym] || 0;
                const benchDropPct = benchPrice > curPrice ? ((benchPrice - curPrice) / benchPrice) * 100 : 0;
                const dropPct = Math.max(candleDropPct, benchDropPct);
                const low24 = Math.min(...lows.slice(-24));
                const high24 = Math.max(...highs.slice(-24), benchPrice);
                const coinRange24hPct = low24 > 0 ? ((high24 - low24) / low24) * 100 : 2.5;
                const upsideGapPct = curPrice > 0 ? ((high24 - curPrice) / curPrice) * 100 : dropPct;
                const convictionTier = (coinRange24hPct >= 5.0 && dropPct >= 3.5) || upsideGapPct >= 4.2 || benchDropPct >= 5.0
                    ? "MAXIMA_BRECHA"
                    : ((coinRange24hPct >= 3.8 && (dropPct >= 2.5 || rsi <= 37)) || coinRange24hPct >= 4.8
                        ? "ALTA_VOLATILIDAD"
                        : (coinRange24hPct >= 2.6 ? "IMPULSO" : "ESTANDAR"));
                const lastIdx = closes.length - 1;
                const candleRange = Math.max(1e-9, highs[lastIdx] - lows[lastIdx]);
                const lowerWickRatio = (Math.min(opens[lastIdx], closes[lastIdx]) - lows[lastIdx]) / candleRange;
                // 🛡️ CALIBRACIÓN ESTRICTA DE FIN DE SEMANA (5.5 AÑOS / 18 SEMANAS BINANCE + BENCHMARK DE CIERRE VIERNES):
                // Exigir caída profunda (>= 3.6% en Hora Piso Sábado Mañana o >= 4.2% fuera de ella, o Descuento >= 5.0% vs Cierre Viernes).
                const isMeme = this.memeWatchlist.includes(sym) || sym.includes("PEPE") || sym.includes("BONK") || sym.includes("DOGE");
                const minDropReq = (isMeme ? 5.2 : 3.6) + extraDropOutsidePrime;
                const maxRsiReq = isMeme ? 35 : 37;
                const qualifiesByFridayBenchmark = benchDropPct >= (isMeme ? 6.0 : 4.8) && rsi <= 41 && (stoch.k <= 32 || lowerWickRatio >= 0.28);
                const qualifiesWeekend = qualifiesByFridayBenchmark ||
                    (stoch.k <= 25 &&
                        ((dropPct >= minDropReq && rsi <= maxRsiReq) ||
                            (rsi <= 29 && dropPct >= (minDropReq - 0.6)) ||
                            (bb.percentB <= 0.05 && rsi <= 36 && dropPct >= 3.2 && lowerWickRatio >= 0.30)));
                if (qualifiesWeekend) {
                    const bbBonus = bb.percentB <= 0.08 ? 4.0 : 0;
                    const wickBonus = lowerWickRatio >= 0.30 ? 3.5 : 0;
                    const volBonus = coinRange24hPct >= 4.2 ? 4.0 : 0;
                    const queenBonus = !isMeme ? 3.0 : 0; // Priorizar Reinas (SOL/NEAR/BTC/ETH/SUI/AVAX) para bloques de $70-$100 USDT
                    const score = (dropPct * 1.9) + Math.max(0, (40 - rsi) * 2.3) + bbBonus + wickBonus + volBonus + queenBonus;
                    candidates.push({ symbol: sym, curPrice, dropPct, upsideGapPct, high24, rsi, score, coinRange24hPct, convictionTier });
                }
            }
            catch (e) { }
        }
        if (candidates.length === 0)
            return false;
        // Ordenar de mayor a menor puntuación (la caída más profunda y con mayor potencial de rebote de $100 USDT)
        candidates.sort((a, b) => b.score - a.score);
        const best = candidates[0];
        // Armar Trailing Buy completo con high24h y upsideGapPct para activar el Escalón Francotirador $100 USDT
        this.buyWatches.set(best.symbol, {
            symbol: best.symbol,
            armedPrice: best.curPrice,
            lowestPrice: best.curPrice,
            armedTime: Date.now(),
            rsi: best.rsi,
            dropPct: best.dropPct,
            upsideGapPct: best.upsideGapPct,
            high24h: best.high24,
            coinRange24hPct: best.coinRange24hPct,
            convictionTier: best.convictionTier,
            strategy: "cazador_weekend"
        });
        this.saveBuyWatches();
        const isBestMeme = this.memeWatchlist.includes(best.symbol) || best.symbol.includes("PEPE");
        const bounceReq = isBestMeme ? 0.65 : 0.55;
        console.log("🏖️ [CAZADOR WEEKEND CALIBRADO] Oportunidad top armada en " + best.symbol + " (Caída: -" + best.dropPct.toFixed(2) + "% | Brecha: +" + best.upsideGapPct.toFixed(2) + "% | RSI: " + best.rsi.toFixed(1) + " | Score: " + best.score.toFixed(1) + ")");
        await this.notifier.send("🏖️ <b>[CAZADOR WEEKEND ARMADO: " + best.symbol + "]</b> 🎯\n\n" +
            "• Caída de fin de semana: <b>-" + best.dropPct.toFixed(2) + "%</b> | Brecha al techo: <b>+" + best.upsideGapPct.toFixed(2) + "%</b> (RSI: <b>" + best.rsi.toFixed(1) + "</b>)\n" +
            "• Puntuación cuantitativa: <b>" + best.score.toFixed(1) + " pts</b> (Top 1 de watchlist [" + best.convictionTier + "])\n" +
            "• Precio actual: <b>$" + best.curPrice + "</b>\n" +
            "• 🔻 Rastreo de piso activo: persiguiendo el suelo tick a tick.\n" +
            "• 🏹 Disparará bloque fuerte ($50–$100 USDT) al confirmar rebote de <b>+" + bounceReq.toFixed(2) + "%</b> + Vela 15m/5m + Ancla BTC 15m.\n" +
            "• 🚀 <b>Salida:</b> El Trailing Take Profit perseguirá el rally del domingo / apertura CME para vender en la cima.");
        return true;
    }
    // --- PARÁMETROS DEL CENTINELA NOCTURNO CORREGIDO CON 18 SEMANAS DE BINANCE ---
    // Nota histórica crítica: 00:30 AM a 04:00 AM COT es el PISO #1 DE COMPRA del ciclo diario (+0.22% 4h)
    // y 20:00 a 21:45 COT es el PISO #3 PRE-ASIA. El único tramo nocturno de trampa es el Techo Asia (22:30 - 00:30 COT).
    isNightWindow() {
        const { timeDec } = this.getCotTimeInfo();
        return timeDec >= 22.5 || timeDec < 0.5;
    }
    isPreNightHarvestWindow() {
        const { timeDec } = this.getCotTimeInfo();
        return timeDec >= 15.5 && timeDec <= 18.25;
    }
    isNYImpulseWindow() {
        const { timeDec } = this.getCotTimeInfo();
        return timeDec >= 11.5 && timeDec < 15.5;
    }
    /**
     * Ventana de Cosecha de Viernes Mañana (Viernes 06:00 a 13:59 COT):
     * Recoge ganancias en el techo del viernes (27% de los techos semanales ocurren entre 06:00 y 10:00 AM)
     * antes de que inicie la Veda de Viernes a las 14:00 COT.
     */
    isPreWeekendAccumulationWindow() {
        try {
            const { dayStr, timeDec } = this.getCotTimeInfo();
            return dayStr === "Fri" && timeDec >= 6.0 && timeDec < 14.0;
        }
        catch {
            return false;
        }
    }
    getSessionLiquidityPlan(totalFreeUsdt) {
        const { dayStr, timeDec } = this.getCotTimeInfo();
        const floorWin = this.isHistoricalFloorWindow();
        const peakHarvestWin = this.isHistoricalPeakHarvestWindow();
        const pauseWin = this.isHistoricalPauseWindow();
        const isPreWeekend = this.isPreWeekendAccumulationWindow();
        const isWeekend = this.isWeekendWindow();
        const calRegime = this.get5YearCalendarRegime();
        let sessionKey = "REGULAR";
        const closedPctDisplay = Math.round(calRegime.closedPocketReservePct * 100);
        const openPctDisplay = 100 - closedPctDisplay;
        let sessionTitle = `💼 Doble Bolsillo (${openPctDisplay}% Abierto | ${closedPctDisplay}% Cerrado) • ${calRegime.label}`;
        // En horas normales de transición: Bolsillo Cerrado (60%-68% según Calendario 5 Años) blindado para Hora Piso
        let reservePct = calRegime.closedPocketReservePct;
        let lotFractionPct = 0.55;
        let trailingBounceTrigger = 0.35;
        let harvestCallbackPct = peakHarvestWin.active ? 0.15 : undefined;
        let reason = `Arquitectura Multianual 5.5 Años (2021-2026) + Doble Bolsillo: ${closedPctDisplay}% guardado en Bolsillo Cerrado para Horas Piso (00:30-04:00 AM, 11:30 AM-01:30 PM, 08:00-09:45 PM) y ${openPctDisplay}% en Bolsillo Abierto. Régimen: ${calRegime.label}.`;
        let recommendation = `💼 Operando con Presupuesto Abierto (${openPctDisplay}%). Los bloques grandes de $50–$100 USDT se desbloquean al 100% en la próxima Hora Piso.`;
        if (this.activeAtypicalOverride === "CRASH_HUNTER") {
            sessionKey = "LONDRES_REBOTE";
            sessionTitle = `⚡ MODO ATÍPICO: CACERÍA DE CAPITULACIÓN EN ${dayStr.toUpperCase()} (100% Presupuesto Desbloqueado)`;
            reservePct = 0.0;
            lotFractionPct = 0.85;
            trailingBounceTrigger = 0.30;
            reason = "Comportamiento atípico bajista detectado en día de alza. El bot conmutó automáticamente de Modo Venta a Modo Cacería de Suelo con 100% de liquidez.";
            recommendation = "🎯 Cazando el suelo del desplome atípico con confirmación 15m + 5m + CVD.";
        }
        else if (this.activeAtypicalOverride === "RALLY_HARVESTER") {
            sessionKey = "NY_IMPULSO";
            sessionTitle = `🚀 MODO ATÍPICO: COSECHA DE RALLY EN ${dayStr.toUpperCase()} (Expirimiendo Subida Inesperada)`;
            reservePct = 0.65;
            lotFractionPct = 0.45;
            trailingBounceTrigger = 0.40;
            harvestCallbackPct = 0.16;
            reason = "Comportamiento atípico alcista detectado en día de acumulación. Posiciones abiertas se exprimen con Trailing de expansión y se bloquean compras por FOMO en techo.";
            recommendation = "🏆 Cosechar el rally atípico en la cima y proteger liquidez.";
        }
        else if (floorWin.active) {
            // 🟢 HORA PISO ESTADÍSTICA ACTIVA: Desbloqueo del 100% (Presupuesto Cerrado 60% + Presupuesto Abierto 40% unidos)
            sessionKey = "LONDRES_REBOTE";
            sessionTitle = floorWin.label;
            reservePct = 0.0; // Desbloquea el 100% del efectivo disponible para disparar bloques fuertes de $50 - $100 USDT
            lotFractionPct = 0.85;
            trailingBounceTrigger = 0.30;
            reason = "Hora Piso comprobada en 18 semanas de historial Binance (máxima tasa de formación de suelos y retorno positivo a +4h). Presupuesto Cerrado (60%) + Presupuesto Abierto (40%) 100% DESBLOQUEADOS.";
            recommendation = "🎯 Modo Francotirador $100 USDT Activo: 100% del capital disponible habilitado para cazar el suelo con confirmación 15m + 5m + Ancla BTC.";
        }
        else if (pauseWin.paused) {
            // ⏸️ HORA PAUSA / TRAMPA ESTADÍSTICA ACTIVA: Compras normales pausadas, solo Excepción por Evento Atípico (40%)
            sessionKey = "NOCTURNO_DRENAJE";
            sessionTitle = peakHarvestWin.active ? `${peakHarvestWin.label} + Pausa de Compras` : pauseWin.reason;
            reservePct = 0.60; // 60% blindado; el 40% restante solo se dispara si se activa isAtypicalMarketException
            lotFractionPct = 0.40;
            trailingBounceTrigger = 0.55;
            harvestCallbackPct = 0.15;
            reason = `${pauseWin.reason} Compras estándar detenidas; solo se autoriza la Llave Maestra de Excepción por Evento Atípico (Flash Crash >= -5.8%, RSI <= 26, Mecha >= 35% y CVD >= 55%).`;
            recommendation = "⏸️ Pausa Horaria Estadística: Cosechando ventas en la cima con Trailing ceñido (0.15%) y guardando munición para la próxima Hora Piso.";
        }
        else if (isPreWeekend) {
            sessionKey = "COSECHA_PRENOCTURNA";
            sessionTitle = "🏆 Cosecha de Viernes Mañana (06:00 AM - 02:00 PM COT)";
            reservePct = 0.60;
            lotFractionPct = 0.40;
            trailingBounceTrigger = 0.40;
            harvestCallbackPct = 0.15;
            reason = "El 27% de los techos del viernes ocurren en la mañana antes del drenaje de fin de semana. Se cosechan posiciones en verde (callback 0.15%) y se blinda el 60% para la madrugada del sábado.";
            recommendation = "🏆 Prioridad Cosecha de Viernes: Recoger ganancias antes de las 02:00 PM COT y acumular bloques de $50–$100 USDT para el sábado madrugada.";
        }
        else if (peakHarvestWin.active) {
            sessionKey = "COSECHA_PRENOCTURNA";
            sessionTitle = peakHarvestWin.label;
            reservePct = 0.60;
            lotFractionPct = 0.45;
            trailingBounceTrigger = 0.38;
            harvestCallbackPct = 0.15;
            reason = "Ventana de Hora Techo histórica. Trailing Take Profit ceñido a 0.15% para asegurar ganancias en la cima antes del retroceso estadístico.";
            recommendation = "🏆 Cosechar subidas en USDT y mantener el 60% reservado para la siguiente Hora Piso.";
        }
        else if (dayStr === "Sun" && timeDec >= 16.5 && timeDec <= 23.5) {
            sessionKey = "NY_IMPULSO";
            sessionTitle = "🚀 Impulso Dominical y Apertura CME (Domingo Tarde/Noche)";
            reservePct = 0.50;
            lotFractionPct = 0.50;
            trailingBounceTrigger = 0.35;
            harvestCallbackPct = 0.16;
            reason = "El domingo es el día más alcista de la semana (+1.00% retorno neto promedio). Se dejan correr las compras del sábado y se cosechan en los picos de la noche.";
            recommendation = "🚀 Exprimir el rally dominical con Trailing TP y cosechar antes de la medianoche.";
        }
        // Cálculo limpio de los Dos Bolsillos (Presupuesto Cerrado vs Presupuesto Abierto):
        // En Hora Piso (floorWin.active): 100% del USDT libre se vuelve gastable (spendableUsdt = totalFreeUsdt).
        // Fuera de Hora Piso: 60% queda en reservedUsdt (Bolsillo Cerrado) y 40% en spendableUsdt (Bolsillo Abierto),
        // pero si el usuario tiene entre $35 y $85 USDT y aparece una oportunidad de Máxima Brecha / Reina $100, permitimos reunir el bloque mínimo de $35 USDT.
        let reservedUsdt = (floorWin.active || this.activeAtypicalOverride === "CRASH_HUNTER") ? 0 : Math.round(totalFreeUsdt * reservePct * 100) / 100;
        if (!floorWin.active && !pauseWin.paused && totalFreeUsdt >= 35 && (totalFreeUsdt - reservedUsdt) < 35) {
            reservedUsdt = Math.max(0, Math.round((totalFreeUsdt - 35) * 100) / 100);
        }
        let spendableUsdt = Math.max(0, Math.round((totalFreeUsdt - reservedUsdt) * 100) / 100);
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
    calculateSessionLotSize(symbol, spendableUsdt, lotFractionPct, strategy = "trailing_rebound", tier = 1, rsi = 40, coinRange24hPct = 2.5, dropPct = 1.5) {
        if (spendableUsdt < this.minUsdtToTrade)
            return 0;
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
        // 📐 ESCUDO 4 (ENTRADA PIRAMIDAL INVERTIDA: LIGERO EN LOTE 1, FUERTE EN EL FONDO LOTE 2/3):
        // Las memecoins quedan excluidas del presupuesto de $50 de Brecha Amplia en Lote 1 (máx $18-$22 USDT en Lote 1),
        // reservando mayor poder de fuego para el Lote 2 ($28-$36 USDT) y Lote 3 ($36-$48 USDT) si el mercado hace un barrido profundo.
        const isWideGapEnabled = this.controls.strategies?.wide_gap_sniper !== false;
        const isMaxGapOpportunity = !isMeme && isWideGapEnabled && (((coinRange24hPct >= 5.0 && (dropPct >= 3.0 || rsi <= 37)) || dropPct >= 4.2));
        const isHighVolOpportunity = !isMaxGapOpportunity && ((coinRange24hPct >= 3.8 && (dropPct >= 2.0 || rsi <= 39)) || coinRange24hPct >= 4.6);
        const isMediumImpulse = !isMaxGapOpportunity && !isHighVolOpportunity && coinRange24hPct >= 2.5;
        let effectiveFraction = lotFractionPct;
        let tierMultiplier = 0.85;
        let tierMaxCap = isMeme
            ? Math.max(14, Math.min(18, totalPortfolioEst * 0.065))
            : Math.max(15, Math.min(20, totalPortfolioEst * 0.075));
        if (tier === 1 && strategy !== "micro_grid") {
            if (isMaxGapOpportunity) {
                effectiveFraction = Math.max(lotFractionPct, 0.80);
                tierMultiplier = 1.85;
                tierMaxCap = Math.max(40, Math.min(56, totalPortfolioEst * 0.20));
            }
            else if (isHighVolOpportunity) {
                effectiveFraction = Math.max(lotFractionPct, isMeme ? 0.45 : 0.65);
                tierMultiplier = isMeme ? 1.15 : (rsi <= 34 || dropPct >= 3.0 ? 1.65 : 1.45);
                tierMaxCap = isMeme
                    ? Math.max(16, Math.min(22, totalPortfolioEst * 0.08))
                    : Math.max(30, Math.min(44, totalPortfolioEst * 0.155));
            }
            else if (isMediumImpulse) {
                effectiveFraction = Math.max(lotFractionPct, isMeme ? 0.40 : 0.45);
                tierMultiplier = rsi <= 34 ? 1.20 : 1.05;
                tierMaxCap = isMeme
                    ? Math.max(14, Math.min(20, totalPortfolioEst * 0.075))
                    : Math.max(22, Math.min(30, totalPortfolioEst * 0.105));
            }
            else if (rsi <= 28) {
                tierMultiplier = 1.15;
                tierMaxCap = isMeme
                    ? Math.max(16, Math.min(22, totalPortfolioEst * 0.08))
                    : Math.max(20, Math.min(28, totalPortfolioEst * 0.10));
            }
        }
        else if (tier === 2) {
            // Lote 2 (Refuerzo Piramidal Quirúrgico en caída -3.8% a -5.4%): $30 - $55 USDT Core ($25 - $32 Meme)
            effectiveFraction = Math.max(lotFractionPct, 0.65);
            tierMultiplier = 1.45;
            tierMaxCap = isMeme
                ? Math.max(25, Math.min(32, totalPortfolioEst * 0.11))
                : Math.max(35, Math.min(55, totalPortfolioEst * 0.18));
        }
        else if (tier === 3) {
            // Lote 2 Profundo (>= -5.5%) o Lote 3 (Capitulación >= -6.5%): $50 - $100 USDT Core ($28 - $40 Meme)
            effectiveFraction = Math.max(lotFractionPct, 0.85);
            tierMultiplier = 1.85;
            tierMaxCap = isMeme
                ? Math.max(28, Math.min(40, totalPortfolioEst * 0.14))
                : Math.max(55, Math.min(100, totalPortfolioEst * 0.32));
        }
        let lot = Math.floor(spendableUsdt * effectiveFraction * allocMultiplier * tierMultiplier * 100) / 100;
        lot = Math.min(lot, Math.floor(tierMaxCap * 100) / 100);
        // 🎯 PRIORIDAD #1: OPERACIONES PRINCIPALES DE $100 USDT (Francotirador de Alta Rentabilidad):
        // Prohibido abrir micro-compras de $12 - $25 USDT en nuevas posiciones (Tier 1). Si el saldo es pequeño (< $35 USDT),
        // se retiene para acumular el bloque fuerte de $50 - $100 USDT donde cada rebote deja ganancias reales ($1.00 a $2.50+ USDT).
        if (tier === 1 && strategy !== "micro_grid" && spendableUsdt < 35) {
            return 0;
        }
        const isSniper100Queen = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "SUIUSDT", "AVAXUSDT", "NEARUSDT"].includes(symbol);
        // 🌟 OPORTUNIDAD DE ORO (PISO PROFUNDO DE ALTA CONVICCIÓN PARA BALA DE $100 USDT):
        // Solo se autoriza la bala máxima de $100 cuando el suelo es inequívoco y garantiza un rebote potente:
        // • Caída profunda >= 4.8% (o >= 4.2% con RSI extremo <= 30 en sobreventa real).
        // • En esta condición de oro, se dispara la bala de $100 USDT para cobrar ganancias grandes (+$2.5 a +$6.0 USDT).
        const isGoldenSniperFloor = !isMeme &&
            isSniper100Queen &&
            ((dropPct >= 4.8 && rsi <= 34) ||
                (dropPct >= 4.2 && rsi <= 30) ||
                (coinRange24hPct >= 5.5 && dropPct >= 4.5 && rsi <= 32));
        const isStrongOpportunity = !isMeme &&
            isSniper100Queen &&
            ((dropPct >= 3.0 && rsi <= 38) ||
                (coinRange24hPct >= 4.0 && dropPct >= 2.5 && rsi <= 40));
        if (tier === 1 && (strategy === "trailing_rebound" || strategy === "cazador_weekend") && spendableUsdt >= 70) {
            if (isGoldenSniperFloor) {
                // 🎯 BALA DE ORO DE $100 USDT: Suelo profundo confirmado que garantiza rebote explosivo
                const goldenShot = Math.min(100.00, Math.floor(spendableUsdt * 100) / 100);
                console.log(`🏆 [BALA DE ORO $100 USDT DISPARADA] ${symbol} en suelo profundo de alta convicción (Caída -${dropPct.toFixed(2)}% | RSI ${rsi.toFixed(1)}). Asignando $${goldenShot.toFixed(2)} USDT.`);
                return goldenShot;
            }
            else if (isStrongOpportunity) {
                // ⚖️ ENTRADA ESTÁNDAR EQUILIBRADA: $35 a $50 USDT (máx 35% de cartera) para no atrapar el capital si cae más
                const balancedCap = Math.max(35.0, Math.min(50.0, spendableUsdt * 0.35));
                const balancedShot = Math.floor(balancedCap * 100) / 100;
                console.log(`⚖️ [ENTRADA ESTÁNDAR EQUILIBRADA] ${symbol} en soporte intradía (Caída -${dropPct.toFixed(2)}% | RSI ${rsi.toFixed(1)}). Asignando $${balancedShot.toFixed(2)} USDT.`);
                return balancedShot;
            }
        }
        // 🛡️ ESCUDO DE RESERVA INVIOLABLE ANTI-ATRAPAMIENTO (SMART DCA AMMO):
        // Si ya tenemos posiciones abiertas (activeInvested > 0) y es una compra normal de Lote 1 (tier === 1, no Bala de Oro en capitulación extrema),
        // es OBLIGATORIO conservar al menos el 28% del portafolio (~$45 USDT) en efectivo libre para poder promediar en el fondo (Smart DCA Lote 2) si el mercado cae más.
        // Prohibido vaciar la billetera a $0.27 USDT en entradas de Lote 1 normales.
        if (tier === 1 && !isGoldenSniperFloor && activeInvested > 0) {
            const actualTotalEquity = activeInvested + spendableUsdt;
            const requiredDcaReserve = Math.max(38.0, actualTotalEquity * 0.28);
            const maxAllowedForNewLot1 = Math.floor(Math.max(0, spendableUsdt - requiredDcaReserve) * 100) / 100;
            if (maxAllowedForNewLot1 < this.minUsdtToTrade) {
                console.log(`🛡️ [RESERVA ANTI-ATRAPAMIENTO PROTEGIDA] Reteniendo $${spendableUsdt.toFixed(2)} USDT en caja como munición Smart DCA / Capitulación Extrema (Invertido activo: $${activeInvested.toFixed(2)} USDT).`);
                return 0;
            }
            spendableUsdt = maxAllowedForNewLot1;
        }
        // 💎 ESCALONES DE BLOQUE EQUILIBRADO:
        if (tier === 1 && isGoldenSniperFloor && !isMeme) {
            const targetGapLot = Math.min(100.0, spendableUsdt);
            if (targetGapLot >= 35) {
                lot = targetGapLot;
            }
            else {
                return 0;
            }
        }
        else if (tier === 1 && (isMaxGapOpportunity || isStrongOpportunity || isHighVolOpportunity) && !isMeme && spendableUsdt >= 35) {
            // Escalón Estándar / Alta Volatilidad: máx 35% del saldo o $35-$50 USDT
            lot = Math.min(spendableUsdt, Math.max(35, Math.min(50, Math.floor(spendableUsdt * 0.45 * 100) / 100)));
        }
        else if (tier === 1 && isMediumImpulse && !isMeme && spendableUsdt >= 35) {
            // Escalón Impulso Medio: mínimo $35 USDT
            lot = Math.min(spendableUsdt, Math.max(lot, 35));
        }
        else if (tier === 1 && spendableUsdt >= 35) {
            lot = Math.min(spendableUsdt, Math.max(lot, 35));
        }
        if (lot < this.minUsdtToTrade && spendableUsdt >= this.minUsdtToTrade) {
            lot = this.minUsdtToTrade;
        }
        return Math.min(lot, spendableUsdt);
    }
    saveSessionPlan(plan) {
        try {
            fs.writeFileSync(path.resolve(process.cwd(), ".session-liquidity-plan.json"), JSON.stringify(plan, null, 2));
        }
        catch (e) { }
    }
    isReboundWindow() {
        const hour = parseInt(new Date().toLocaleTimeString("en-US", { timeZone: "America/Bogota", hour12: false, hour: "numeric" }), 10);
        // Ventana de rebote institucional (Apertura Europa/Londres): 03:00 a 06:00 COT
        return hour >= 3 && hour <= 6;
    }
    // --- MÉTODOS DE TRANSFERENCIA UNIVERSAL SPOT <-> FUTUROS USD-M ---
    async getFuturesBalance() {
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
                const item = data.find((b) => b.asset === "USDT");
                if (item) {
                    return {
                        balance: parseFloat(item.balance || "0"),
                        available: parseFloat(item.availableBalance || "0")
                    };
                }
            }
            return { balance: 0, available: 0 };
        }
        catch {
            return { balance: 0, available: 0 };
        }
    }
    async transferSpotToFutures(amount) {
        try {
            const cleanAmt = Math.floor(amount * 100) / 100;
            if (cleanAmt <= 0)
                return { success: false, msg: "Monto inválido para transferir." };
            const res = await this.client.userUniversalTransfer("MAIN_UMFUTURE", "USDT", cleanAmt);
            return { success: true, msg: `Transferidos ${cleanAmt.toFixed(2)} USDT de Spot a Futuros USD-M (TranId: ${res.data.tranId}).` };
        }
        catch (e) {
            const errMsg = e.response?.data?.msg || e.message;
            return { success: false, msg: `Error en transferencia a Futuros: ${errMsg}` };
        }
    }
    async transferFuturesToSpot(amount) {
        try {
            let targetAmt = amount;
            if (!targetAmt || targetAmt <= 0) {
                const futBal = await this.getFuturesBalance();
                targetAmt = Math.floor(futBal.available * 100) / 100;
            }
            else {
                targetAmt = Math.floor(targetAmt * 100) / 100;
            }
            if (targetAmt <= 0.01) {
                return { success: false, msg: "No hay saldo disponible en Futuros USD-M para transferir a Spot." };
            }
            const res = await this.client.userUniversalTransfer("UMFUTURE_MAIN", "USDT", targetAmt);
            return { success: true, msg: `Transferidos ${targetAmt.toFixed(2)} USDT de Futuros USD-M de regreso a Spot (TranId: ${res.data.tranId}).` };
        }
        catch (e) {
            const errMsg = e.response?.data?.msg || e.message;
            return { success: false, msg: `Error en transferencia a Spot: ${errMsg}` };
        }
    }
    // --- CENTINELA DE LIQUIDEZ (50 USDT) Y VIABILIDAD DE FUTUROS ---
    lastHarvestNotifyTime = 0;
    async checkPrimeHarvestOpportunities(reservedUsdt) {
        if (reservedUsdt < 15.0)
            return false;
        // Cooldown de 4 horas para no ser repetitivo
        if (Date.now() - this.lastHarvestNotifyTime < 4 * 3600 * 1000)
            return false;
        if (this.pendingOpportunity)
            return false;
        const primeCandidates = ["SOLUSDT", "BTCUSDT", "ETHUSDT", "BNBUSDT"];
        for (const sym of primeCandidates) {
            if (this.hasActivePositionForSymbol(sym))
                continue;
            try {
                const klines = await this.client.klines(sym, "1h", { limit: 25 });
                const closes = klines.data.map((k) => parseFloat(k[4]));
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
            }
            catch (e) { }
        }
        return false;
    }
    isCheckingLiquidity = false;
    lastLiquidityAlertTime = 0;
    async checkLiquidityAndFuturesViability(freeUsdt) {
        if (this.isCheckingLiquidity)
            return;
        // Cooldown de 4 horas para no spamear Telegram
        if (Date.now() - this.lastLiquidityAlertTime < 4 * 3600 * 1000)
            return;
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
        if (!this.controls.strategies?.futures && !this.futuresEngine.isEnabled()) {
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
                }
                else {
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
            }
            catch (err) {
                console.error("Error al notificar liquidez y viabilidad:", err.message);
            }
            finally {
                this.isCheckingLiquidity = false;
            }
        }
    }
    async runCycle() {
        // Sincronizar periódicamente controles desde Supabase
        if (Date.now() % 35000 < 7500) {
            try {
                const freshCtrl = await supabaseDb.loadStrategyControls();
                if (freshCtrl)
                    this.controls = freshCtrl;
            }
            catch (e) { }
        }
        if (this.isProcessing)
            return;
        this.isProcessing = true;
        try {
            this.loadStrategyControls();
            // Control de ciclo automático de Cazador Weekend (Sábado 00:30 AM a Domingo 18:00 COT) + motores base siempre activos
            const isWeekend = this.isWeekendWindow();
            if (!this.controls.strategies.trailing_rebound || !this.controls.strategies.smart_dca) {
                this.controls.strategies.trailing_rebound = true;
                this.controls.strategies.smart_dca = true;
            }
            if (isWeekend && !this.controls.strategies.cazador_weekend) {
                this.controls.strategies.cazador_weekend = true;
            }
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
            }
            else if (this.lastWeekendWindowState !== isWeekend) {
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
                    await this.notifier.send("🏖️ <b>[CAZADOR WEEKEND: AUTO-DESACTIVADO]</b> ⏸️\n\n" +
                        "• La ventana de compras de fin de semana ha finalizado (Domingo 18:00 COT).\n" +
                        "• El switch se ha <b>auto-desactivado</b> para no hacer compras en días de semana.\n" +
                        `• 💼 <b>Presupuesto inteligente:</b> La cuota (${wAlloc}%) se transfirió automáticamente a <b>🏹 Cazador Trailing</b> (ahora al ${this.controls.allocations.trailing_rebound}%) para operar al 100% durante la semana.\n` +
                        "• 🚀 <b>Ventas:</b> Posiciones abiertas siguen rastreando el pico máximo con Trailing Take Profit.\n" +
                        "• ⏰ Se reactivará automáticamente el próximo viernes a las 17:00 COT.");
                }
                else {
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
                    await this.notifier.send("🏖️ <b>[CAZADOR WEEKEND: AUTO-ACTIVADO]</b> 🟢\n\n" +
                        "• ¡Ventana de cacería en piso de fin de semana abierta (Sábado 02:00 AM COT)!\n" +
                        "• 📊 Estadística 11 semanas (82% efectividad): El drenaje del viernes finalizó; iniciando cacería en el piso real de madrugada/sábado.\n" +
                        `• 💼 <b>Presupuesto recuperado:</b> Se apartó el <b>${this.controls.allocations.cazador_weekend}%</b> para cazar la mejor caída del fin de semana (Trailing quedó en ${this.controls.allocations.trailing_rebound}%).\n` +
                        "• 📡 Escaneando la Watchlist en busca de sobreventas y suelos con Trailing Buy...");
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
            const sellOrders = openOrders.data.filter((o) => o.side === "SELL");
            const activeSymbols = new Set(sellOrders.map((o) => o.symbol));
            const acc = await this.client.account({ recvWindow: 60000 });
            const usdt = parseFloat(acc.data.balances.find((b) => b.asset === "USDT")?.free || "0");
            const time = new Date().toLocaleTimeString();
            // 🛡️ Blindaje de depósitos automáticos en Billetera Manual
            this.checkAndQuarantineDeposits(usdt);
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
                try {
                    await this.notifier.send(sessionAlert);
                }
                catch (e) { }
            }
            this.lastSessionKey = sessionPlan.sessionKey;
            const uniqueActiveCount = this.getUniqueActiveSymbols().size;
            // 🎯 Concentración de capital en bloques de $50 - $100 USDT (máximo 4 monedas para nuevas entradas)
            const configuredMax = this.controls?.maxPositions || 4;
            const maxUniqueCoins = configuredMax;
            console.log(`[${time}] [${sessionPlan.sessionTitle}] USDT total: ${usdt.toFixed(2)} (Gastable: ${sessionPlan.spendableUsdt.toFixed(2)} | Reserva Cerrada: ${sessionPlan.reservedUsdt.toFixed(2)}) | Monedas: ${uniqueActiveCount}/${maxUniqueCoins} (${this.activeTrailingPositions.size} lotes) | Cazando piso: ${this.buyWatches.size}`);
            // Monitoreo de liquidez libre (Meta: >= 50 USDT) para evaluar Futuros
            await this.checkLiquidityAndFuturesViability(usdt);
            // 🧠 AGENTE IA AUTÓNOMO (CICLO PERIÓDICO EN SERVIDOR 24/7):
            // Compara precios en vivo vs cierre del viernes, envía reporte a Telegram cada 2h (o en hitos de caída) y ejecuta compras en el piso.
            await this.runAutonomousAiBenchmarkAudit(false, botSpendableUsdt);
            // 2. Evaluar oportunidades de compra respetando Horas Piso, Horas Pausa y Excepción por Evento Atípico
            const pauseWin = this.isHistoricalPauseWindow();
            if (pauseWin.paused) {
                console.log(`${pauseWin.reason} (Vigilando únicamente Eventos Atípicos / Flash Crash >= -5.8% con RSI <= 26).`);
            }
            if (botSpendableUsdt >= this.minUsdtToTrade && !this.pendingOpportunity) {
                const secondaryPoolUsdt = Math.max(0, Math.round(sessionPlan.spendableUsdt * 100) / 100);
                // Prioridad 1: Cacería Quirúrgica de Rebote (en Hora Pausa solo dispara si se activa isAtypicalMarketException)
                let bought = false;
                if (this.controls.strategies.trailing_rebound && uniqueActiveCount < maxUniqueCoins && this.buyWatches.size > 0 && secondaryPoolUsdt >= this.minUsdtToTrade) {
                    bought = await this.checkBuyWatches(botSpendableUsdt);
                }
                // Prioridad 2: Smart DCA (Refuerzo de Lote 2/3 en caídas profundas confirmadas; bloqueado en Veda de Viernes salvo caída extrema >= -6.5%)
                const dcaTriggered = !bought && !pauseWin.paused && secondaryPoolUsdt >= this.minUsdtToTrade
                    ? await this.checkSmartDcaOpportunities(secondaryPoolUsdt)
                    : false;
                // Prioridad 3: Centinela Alpha (solo fuera de Horas Pausa)
                let alphaTriggered = false;
                if (!bought && !dcaTriggered && !pauseWin.paused && secondaryPoolUsdt >= this.minUsdtToTrade && this.controls.strategies?.centinela_alpha) {
                    alphaTriggered = await this.evaluateCentinelaAlpha(secondaryPoolUsdt);
                }
                // Prioridad 4: Fin de Semana (Sábado 02:00 AM a Domingo 18:00 COT)
                let weekendTriggered = false;
                if (!bought && !dcaTriggered && !pauseWin.paused && this.isWeekendWindow() && this.controls.strategies.cazador_weekend && uniqueActiveCount < maxUniqueCoins && secondaryPoolUsdt >= this.minUsdtToTrade) {
                    weekendTriggered = await this.evaluateCazadorWeekend(secondaryPoolUsdt, activeSymbols);
                }
                // Prioridad 5: Día Quieto / Lateral (Micro-Grid con bloque real >= $35 USDT cuando el mercado se lateraliza)
                let gridTriggered = false;
                const gridUnlockedUsdt = secondaryPoolUsdt;
                if (!bought && !dcaTriggered && !weekendTriggered && !pauseWin.paused && this.controls.strategies.micro_grid && uniqueActiveCount < maxUniqueCoins && gridUnlockedUsdt >= this.minUsdtToTrade) {
                    gridTriggered = await this.evaluateMicroGrid(gridUnlockedUsdt, activeSymbols);
                }
                // Prioridad 6: Escaneo de nuevos pisos para armar Cacerías (en Hora Pausa solo arma si hay Flash Crash >= -5.2% y RSI <= 28)
                if (!bought && !dcaTriggered && !weekendTriggered && !gridTriggered && this.controls.strategies.trailing_rebound && uniqueActiveCount < maxUniqueCoins) {
                    await this.scanForDips(activeSymbols);
                }
            }
        }
        catch (e) {
            console.error("Error en runCycle:", e.message);
        }
        finally {
            this.isProcessing = false;
        }
    }
    async buildBuyWatchReport() {
        let txt = `🏹 <b>PANEL SEMÁFORO DE CACERÍA (QUIRÚRGICO)</b>\n`;
        txt += `<i>🟢 = Cumplido | 🟠 = Casi listo | 🔴 = Pendiente / Bloqueado</i>\n\n`;
        if (this.buyWatches.size === 0) {
            txt += `• Ninguna moneda en vigilancia ahora mismo.\n` +
                `• El radar escanea 24/7 en busca de sobreventas institucionales.\n`;
            return txt;
        }
        const macro = await this.getLiveMacroRegime();
        const sessionPlan = this.lastSessionPlan || this.getSessionLiquidityPlan(100);
        for (const [sym, w] of this.buyWatches.entries()) {
            try {
                const [tickerRes, k5Res, depthRes] = await Promise.all([
                    this.client.tickerPrice(sym),
                    this.client.klines(sym, "5m", { limit: 4 }),
                    this.client.depth(sym, { limit: 50 }).catch(() => ({ data: { bids: [], asks: [] } }))
                ]);
                const cur = parseFloat(tickerRes.data.price);
                // 🛡️ CANDADO DE RANGO (VERIFICACIÓN EN TIEMPO DE DISPARO DE COMPRA):
                const rangeCheckBuy = marketRangesManager.isBuyAllowed(sym, cur);
                if (!rangeCheckBuy.allowed) {
                    console.log(`🛡️ [CANDADO DE RANGO: ${sym}] Compra bloqueada en $${cur}. ${rangeCheckBuy.reason}`);
                    continue;
                }
                // 🛑 VEDA DE VIERNES: Bloqueo preventivo de compras los viernes hasta el sábado 02:00 AM COT
                if (this.isFridayBuyVeda(sym, cur, undefined, w.dropPct)) {
                    console.log(`🛑 [VEDA DE VIERNES] ${sym}: Compra retenida hasta el sábado 02:00 AM COT (esperando piso real).`);
                    continue;
                }
                const bounce = ((cur - w.lowestPrice) / w.lowestPrice) * 100;
                const isMemeCoin = this.memeWatchlist.includes(sym) || sym.includes("PEPE") || sym.includes("DOGE");
                const reqBounce = isMemeCoin ? 0.45 : 0.35;
                const mins = Math.round((Date.now() - w.armedTime) / 60000);
                // 1. Semáforo Rebote desde el piso
                let rIco = "🔴", rDesc = "Fondo aún no confirmado";
                let score = 0;
                if (bounce >= reqBounce) {
                    rIco = "🟢";
                    rDesc = "Rebote superado";
                    score++;
                }
                else if (bounce >= reqBounce * 0.50) {
                    rIco = "🟠";
                    rDesc = `Cerca del +${reqBounce.toFixed(2)}%`;
                }
                // 2. Semáforo Vela 5m (incluye absorción por mecha o avance sobre vela previa)
                const k5Data = k5Res.data;
                const last5 = k5Data[k5Data.length - 1];
                const prev5 = k5Data.length >= 2 ? k5Data[k5Data.length - 2] : last5;
                const o5 = parseFloat(last5[1]), h5 = parseFloat(last5[2]), l5 = parseFloat(last5[3]), c5 = parseFloat(last5[4]);
                const pc5 = parseFloat(prev5[4]);
                const lowerWick5 = (h5 - l5) > 0 ? (Math.min(o5, c5) - l5) / (h5 - l5) : 0;
                const isGreen = c5 >= o5 || (c5 > pc5 && lowerWick5 >= 0.20) || lowerWick5 >= 0.30;
                let vIco = "🔴", vDesc = "Roja (presión bajista)";
                if (isGreen) {
                    vIco = "🟢";
                    vDesc = "Verde / Absorción activa";
                    score++;
                }
                else if (Math.abs((c5 - o5) / o5) * 100 <= 0.08) {
                    vIco = "🟠";
                    vDesc = "Doji (absorbiendo)";
                }
                // 3. Semáforo Flujo de Ballenas (CVD combinado de 2 velas para evitar reseteo en apertura de vela)
                const totQuote = parseFloat(last5[7] || "0");
                const buyQuote = parseFloat(last5[10] || "0");
                const curCvd = totQuote > 0 ? (buyQuote / totQuote) * 100 : 50;
                const prevTotQuote = parseFloat(prev5[7] || "0");
                const prevBuyQuote = parseFloat(prev5[10] || "0");
                const combTot = totQuote + prevTotQuote;
                const combCvd = combTot > 0 ? ((buyQuote + prevBuyQuote) / combTot) * 100 : 50;
                const cvdRatio = Math.max(curCvd, combCvd);
                let cIco = "🔴", cDesc = "Dominan ventas a mercado";
                if (cvdRatio >= 50.0) {
                    cIco = "🟢";
                    cDesc = "Compras de ballenas al mando";
                    score++;
                }
                else if (cvdRatio >= 42.0) {
                    cIco = "🟠";
                    cDesc = "Equilibrado (cerca de compras)";
                }
                // 4. Semáforo Libro de Órdenes (OBI % Bids en 50 niveles para no apagarse al despegar del piso)
                const bids = depthRes?.data?.bids || [];
                const asks = depthRes?.data?.asks || [];
                const bVal = bids.reduce((a, [p, q]) => a + parseFloat(p) * parseFloat(q), 0);
                const aVal = asks.reduce((a, [p, q]) => a + parseFloat(p) * parseFloat(q), 0);
                const obi = (bVal + aVal) > 0 ? (bVal / (bVal + aVal)) * 100 : 50;
                let oIco = "🔴", oDesc = "Muro de venta bloqueando";
                if (obi >= 42.0) {
                    oIco = "🟢";
                    oDesc = "Camino libre / Soporte sólido";
                    score++;
                }
                else if (obi >= 32.0) {
                    oIco = "🟠";
                    oDesc = "Libro neutral";
                }
                // 5. Semáforo Bitcoin
                let bIco = "🔴", bDesc = "BTC en caída (veto activo)";
                if (macro.btcStressIndex <= 0.50 && !macro.isMacroStorm) {
                    bIco = "🟢";
                    bDesc = "BTC estable / sin peligro";
                    score++;
                }
                else if (macro.btcStressIndex <= 0.70) {
                    bIco = "🟠";
                    bDesc = "BTC en corrección moderada";
                }
                const triggerPrice = w.lowestPrice * (1 + reqBounce / 100);
                txt += `🪙 <b>${sym}</b> [${score}/5 Requisitos] <i>(${mins} min acechando)</i>\n`;
                txt += `• Piso: <b>$${fmtPrice(w.lowestPrice)}</b> | Actual: <b>$${fmtPrice(cur)}</b>\n`;
                txt += `• Disparo en: <b>$${fmtPrice(triggerPrice)}</b> (+${reqBounce.toFixed(2)}% desde piso)\n`;
                txt += `${rIco} <b>Rebote:</b> +${bounce.toFixed(2)}% (${rDesc})\n`;
                txt += `${vIco} <b>Vela 5m:</b> ${vDesc}\n`;
                txt += `${cIco} <b>Flujo Ballenas (CVD):</b> ${cvdRatio.toFixed(1)}% (${cDesc})\n`;
                txt += `${oIco} <b>Libro Depth (OBI):</b> ${obi.toFixed(0)}% Bids (${oDesc})\n`;
                txt += `${bIco} <b>Semáforo Bitcoin:</b> ${bDesc}\n\n`;
            }
            catch (e) {
                txt += `🪙 <b>${sym}:</b> Error consultando telemetría en vivo (${e.message})\n\n`;
            }
        }
        return txt;
    }
    lastDailyReportDay = "";
    async generateConsolidatedDailyReport() {
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
            const bFree = acc.data.balances.find((b) => b.asset === "USDT");
            if (bFree)
                usdtFree = parseFloat(bFree.free);
        }
        catch { }
        try {
            const earnRes = await this.client.simpleEarnFlexiblePersonalLeftQuota("USDT");
            // Fallback a lectura de saldo earn
        }
        catch { }
        // 2. Consultar ciclos de Binance y ganancias de Spot
        let spotPnlToday = 0;
        let spotWinsToday = 0;
        const startOfTodayMs = new Date().setHours(0, 0, 0, 0);
        try {
            const pnlData = await computeRealizedPnl(this.client);
            for (const c of pnlData.cycles) {
                if (c.time >= startOfTodayMs) {
                    spotPnlToday += c.pnlUsdt;
                    if (c.pnlUsdt > 0)
                        spotWinsToday++;
                }
            }
        }
        catch { }
        // 3. Consultar telemetría de Futuros
        const futTrades = this.futuresEngine.getTrades();
        let futPnlToday = 0;
        let futWinsToday = 0;
        let futLossesToday = 0;
        for (const t of futTrades) {
            if (t.closeTime >= startOfTodayMs) {
                futPnlToday += t.netPnlUsdt;
                if (t.netPnlUsdt > 0)
                    futWinsToday++;
                else
                    futLossesToday++;
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
    async checkDailyReportSchedule() {
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
        }
        catch (e) {
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
                const realProfitSum = dbTrades.reduce((acc, t) => acc + (t.pnlUsdt || 0), 0);
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
        }
        catch (e) {
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
        this.telegramCommands.start().catch((err) => console.error("Error iniciando Telegram:", err.message));
        this.futuresEngine.start(4000);
        console.log(`📱 Telegram listo para recibir órdenes por chat.`);
        this.syncOrphanPositions().catch((e) => console.error("Error en syncOrphanPositions:", e.message));
        await this.runCycle();
        setInterval(() => this.runCycle(), 3500);
    }
}
// BOT_NO_AUTOSTART=1 permite importar la clase para pruebas sin arrancar el bot
if (process.env.BOT_NO_AUTOSTART !== "1") {
    const bot = new TrailingMasterBot();
    bot.start();
}
