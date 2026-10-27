import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { Spot } from "@binance/connector";
import { computeRealizedPnl, PNL_SYMBOLS } from "./pnl.js";
dotenv.config();
const PORT = parseInt(process.env.DASHBOARD_PORT || process.env.PORT || "3333", 10);
const COP_PER_USDT = 4200;
const BINANCE_PUBLIC = "https://api.binance.com";
/**
 * Dashboard de solo lectura.
 * Los datos se refrescan en segundo plano y se guardan en caché:
 * /api/status responde al instante y nunca devuelve datos vacíos por un error puntual.
 */
export class DashboardServer {
    server = null;
    client;
    publicDir;
    port;
    timers = [];
    // Caché (último valor bueno conocido)
    prices = {};
    radarMeta = {};
    usdtFree = null;
    usdtEarn = null;
    pnl = null;
    lastPriceOk = 0;
    authError = null;
    busy = {};
    fng = null;
    constructor(port = PORT) {
        this.port = port;
        this.publicDir = path.resolve(process.cwd(), "public");
        this.client = new Spot(process.env.BINANCE_API_KEY, process.env.BINANCE_API_SECRET, { recvWindow: 60000 });
    }
    readJson(file) {
        try {
            const f = path.resolve(process.cwd(), file);
            if (fs.existsSync(f))
                return JSON.parse(fs.readFileSync(f, "utf-8"));
        }
        catch { }
        return [];
    }
    trackedSymbols() {
        const pos = this.readJson(".trailing-positions.json").map(([s]) => s);
        const buys = this.readJson(".trailing-buys.json").map(([s]) => s);
        return Array.from(new Set([...PNL_SYMBOLS, ...pos, ...buys]));
    }
    /** Ejecuta una tarea de refresco sin solaparla consigo misma */
    async guarded(name, fn) {
        if (this.busy[name])
            return;
        this.busy[name] = true;
        try {
            await fn();
        }
        catch { }
        finally {
            this.busy[name] = false;
        }
    }
    async refreshPrices() {
        const syms = this.trackedSymbols();
        const url = `${BINANCE_PUBLIC}/api/v3/ticker/price?symbols=${encodeURIComponent(JSON.stringify(syms))}`;
        const res = await fetch(url);
        if (!res.ok)
            return;
        const arr = await res.json();
        for (const t of arr)
            this.prices[t.symbol] = parseFloat(t.price);
        this.lastPriceOk = Date.now();
    }
    async refreshRadar() {
        for (const sym of PNL_SYMBOLS) {
            try {
                const res = await fetch(`${BINANCE_PUBLIC}/api/v3/klines?symbol=${sym}&interval=15m&limit=35`);
                if (!res.ok)
                    continue;
                const data = await res.json();
                const closes = data.map((k) => parseFloat(k[4]));
                const highs = data.map((k) => parseFloat(k[2]));
                const cur = closes[closes.length - 1];
                const maxRecent = Math.max(...highs.slice(-20));
                this.radarMeta[sym] = {
                    rsi: this.calculateRSI(closes, 14),
                    dropPct: maxRecent > 0 ? ((maxRecent - cur) / maxRecent) * 100 : 0
                };
            }
            catch { }
        }
    }
    describeError(e) {
        const d = e?.response?.data;
        return d?.msg ? `${d.msg} (código ${d.code})` : (e?.message || "Error desconocido");
    }
    async refreshAccount() {
        let acc;
        try {
            acc = await this.client.account({ recvWindow: 60000 });
            this.authError = null;
        }
        catch (e) {
            this.authError = this.describeError(e);
            return;
        }
        const b = acc.data.balances || [];
        this.usdtFree = parseFloat(b.find((x) => x.asset === "USDT")?.free || "0");
        this.usdtEarn = parseFloat(b.find((x) => x.asset === "LDUSDT")?.free || "0");
        // Sincronizar automáticamente posiciones activas desde Binance (incluye Spot y Simple Earn LD*)
        try {
            const pFile = path.resolve(process.cwd(), ".trailing-positions.json");
            let diskPositions = fs.existsSync(pFile) ? JSON.parse(fs.readFileSync(pFile, "utf-8")) : [];
            let updated = false;
            const candidates = ["PEPE", "SOL", "ETH", "AVAX", "BTC", "BNB", "XRP"];
            for (const base of candidates) {
                const sym = base + "USDT";
                if (diskPositions.some(([s]) => s === sym))
                    continue;
                const spotBal = parseFloat(b.find((x) => x.asset === base)?.free || "0");
                const earnBal = parseFloat(b.find((x) => x.asset === ("LD" + base))?.free || "0");
                const totalQty = spotBal + earnBal;
                const curPrice = this.prices[sym] || 0;
                if (totalQty > 0 && curPrice > 0 && (totalQty * curPrice) >= 10) {
                    let buyPrice = curPrice;
                    let buyTime = Date.now();
                    try {
                        const tr = await this.client.myTrades(sym, { limit: 5 });
                        const lastBuy = (tr.data || []).reverse().find((t) => t.isBuyer);
                        if (lastBuy) {
                            buyPrice = parseFloat(lastBuy.price);
                            buyTime = lastBuy.time;
                        }
                    }
                    catch { }
                    diskPositions.push([
                        sym,
                        {
                            symbol: sym,
                            buyPrice,
                            qty: totalQty,
                            investedUsdt: totalQty * buyPrice,
                            highestPrice: Math.max(buyPrice, curPrice),
                            activated: ((curPrice - buyPrice) / buyPrice) * 100 >= 0.8,
                            buyTime
                        }
                    ]);
                    updated = true;
                    console.log("🔗 [AUTO-DETECT] " + sym + " sincronizado en dashboard: " + totalQty + " " + base + " a $" + buyPrice);
                }
            }
            if (updated) {
                fs.writeFileSync(pFile, JSON.stringify(diskPositions, null, 2), "utf-8");
            }
        }
        catch (e) {
            console.error("Error auto-sincronizando posiciones:", e.message);
        }
    }
    async refreshPnl() {
        // computeRealizedPnl ignora errores por símbolo; si la cuenta no autentica, no tiene sentido llamarlo
        await this.refreshAccount();
        if (this.authError)
            return;
        const s = await computeRealizedPnl(this.client);
        this.pnl = s;
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
        return 100 - (100 / (1 + avgGain / avgLoss));
    }
    isWeekendMode() {
        try {
            const now = new Date();
            const dayStr = now.toLocaleDateString("en-US", { timeZone: "America/Bogota", weekday: "short" });
            const hourStr = now.toLocaleTimeString("en-US", { timeZone: "America/Bogota", hour12: false, hour: "numeric" });
            const hour = parseInt(hourStr, 10);
            if (dayStr === "Fri" && hour >= 17)
                return true;
            if (dayStr === "Sat")
                return true;
            if (dayStr === "Sun" && hour < 18)
                return true;
            return false;
        }
        catch {
            return false;
        }
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
    async refreshFng() {
        try {
            const res = await fetch("https://api.alternative.me/fng/?limit=1");
            const d = await res.json();
            const item = d.data?.[0];
            if (item) {
                this.fng = {
                    value: parseInt(item.value, 10),
                    classification: item.value_classification,
                    updatedAt: Date.now()
                };
            }
        }
        catch (e) { }
    }
    getSuggestedTimeframe(symbol) {
        if (symbol.includes("PEPE") || symbol.includes("BONK") || symbol.includes("DOGE") || symbol.includes("SHIB") || symbol.includes("WIF")) {
            return {
                timeframe: "15m",
                reason: "Alta velocidad meme (15m aprovecha impulsos rápidos)"
            };
        }
        if (symbol.includes("BTC") || symbol.includes("ETH")) {
            return {
                timeframe: "1h",
                reason: "Filtro de ruido institucional (1H confirma soportes y volumen)"
            };
        }
        if (symbol.includes("AVAX") || symbol.includes("SOL") || symbol.includes("LINK")) {
            return {
                timeframe: "1h",
                reason: "Onda swing equilibrada"
            };
        }
        return {
            timeframe: "1h",
            reason: "Estructura estándar de tendencia"
        };
    }
    getTimeframeForSymbol(symbol, pos) {
        if (pos && pos.customTimeframe)
            return pos.customTimeframe;
        const ctrlFile = path.resolve(process.cwd(), ".strategy-controls.json");
        if (fs.existsSync(ctrlFile)) {
            try {
                const controls = JSON.parse(fs.readFileSync(ctrlFile, "utf-8"));
                if (controls.symbolTimeframes && controls.symbolTimeframes[symbol]) {
                    return controls.symbolTimeframes[symbol];
                }
            }
            catch (e) { }
        }
        return this.getSuggestedTimeframe(symbol).timeframe;
    }
    getCallbackPct(symbol, pos) {
        if (pos && typeof pos.customCallbackPct === "number" && pos.customCallbackPct > 0) {
            return pos.customCallbackPct;
        }
        const ctrlFile = path.resolve(process.cwd(), ".strategy-controls.json");
        if (fs.existsSync(ctrlFile)) {
            try {
                const controls = JSON.parse(fs.readFileSync(ctrlFile, "utf-8"));
                if (controls.trailingCallbacks && typeof controls.trailingCallbacks[symbol] === "number") {
                    return controls.trailingCallbacks[symbol];
                }
                if (controls.trailingCallbacks && typeof controls.trailingCallbacks["default"] === "number") {
                    return controls.trailingCallbacks["default"];
                }
            }
            catch (e) { }
        }
        if (symbol.includes("PEPE") || symbol.includes("BONK") || symbol.includes("DOGE") || symbol.includes("SHIB") || symbol.includes("WIF"))
            return 0.45;
        if (symbol.includes("AVAX") || symbol.includes("SOL"))
            return 0.35;
        return 0.25;
    }
    /** Construye la respuesta a partir de la caché (síncrono, instantáneo) */
    getStatusData() {
        const rawPositions = this.readJson(".trailing-positions.json");
        const rawBuys = this.readJson(".trailing-buys.json");
        let totalInvested = 0;
        let positionsValue = 0;
        const positions = rawPositions.map(([symbol, pos]) => {
            const curPrice = this.prices[symbol] || pos.buyPrice;
            const target08 = pos.buyPrice * 1.008;
            const gainPct = ((curPrice - pos.buyPrice) / pos.buyPrice) * 100;
            const progressPct = ((curPrice - pos.buyPrice) / (target08 - pos.buyPrice)) * 100;
            const pnlUsdt = pos.qty * curPrice - pos.investedUsdt;
            const callback = this.getCallbackPct(symbol, pos);
            totalInvested += pos.investedUsdt;
            positionsValue += pos.qty * curPrice;
            return {
                symbol,
                base: symbol.replace("USDT", ""),
                qty: pos.qty,
                investedUsdt: pos.investedUsdt,
                buyPrice: pos.buyPrice,
                curPrice,
                target08,
                progressPct: Math.max(0, Math.min(100, progressPct)),
                gainPct,
                pnlUsdt,
                pnlCop: pnlUsdt * COP_PER_USDT,
                highestPrice: pos.highestPrice,
                peakGainPct: ((pos.highestPrice - pos.buyPrice) / pos.buyPrice) * 100,
                stopPrice: pos.highestPrice * (1 - callback / 100),
                callbackPct: callback,
                isCustomCallback: !!pos.customCallbackPct,
                suggestedCallback: (symbol.includes("PEPE") || symbol.includes("BONK") || symbol.includes("DOGE") || symbol.includes("SHIB") || symbol.includes("WIF")) ? 0.45 : ((symbol.includes("AVAX") || symbol.includes("SOL")) ? 0.35 : 0.25),
                suggestedReason: (symbol.includes("PEPE") || symbol.includes("BONK") || symbol.includes("DOGE") || symbol.includes("SHIB") || symbol.includes("WIF")) ? "Alta volatilidad Meme (tolerar micro-retrocesos)" : ((symbol.includes("AVAX") || symbol.includes("SOL")) ? "Volatilidad media" : "Mercado clásico (salida ágil)"),
                timeframe: this.getTimeframeForSymbol(symbol, pos),
                suggestedTimeframe: this.getSuggestedTimeframe(symbol).timeframe,
                suggestedTimeframeReason: this.getSuggestedTimeframe(symbol).reason,
                isTimeframeOptimal: this.getTimeframeForSymbol(symbol, pos) === this.getSuggestedTimeframe(symbol).timeframe,
                activated: !!pos.activated
            };
        });
        const radar = PNL_SYMBOLS
            .filter((s) => !rawPositions.some(([p]) => p === s))
            .map((sym) => {
            const meta = this.radarMeta[sym];
            const watch = rawBuys.find(([s]) => s === sym)?.[1];
            return {
                symbol: sym,
                curPrice: this.prices[sym] ?? null,
                rsi: meta ? meta.rsi : null,
                dropPct: meta ? meta.dropPct : null,
                isHunting: !!watch,
                lowestPrice: watch?.lowestPrice ?? null
            };
        });
        const cash = (this.usdtFree ?? 0) + (this.usdtEarn ?? 0);
        const total = positionsValue + cash;
        const p = this.pnl;
        return {
            updatedAt: new Date().toISOString(),
            pricesFresh: Date.now() - this.lastPriceOk < 15000,
            accountAvailable: this.usdtFree !== null,
            authError: this.authError,
            portfolio: {
                totalEstimatedUsdt: total,
                totalEstimatedCop: total * COP_PER_USDT,
                usdtFree: this.usdtFree,
                usdtEarn: this.usdtEarn,
                totalInvested,
                openPositionsCount: positions.length,
                maxSlots: 5
            },
            positions,
            radar,
            performance: p ? {
                totalPnlUsdt: p.totalPnl,
                totalPnlCop: p.totalPnl * COP_PER_USDT,
                wins: p.wins,
                losses: p.losses,
                cyclesCount: p.cycles.length,
                winRate: p.cycles.length ? Math.round((p.wins / p.cycles.length) * 100) : 100
            } : null,
            marketSentiment: this.fng || { value: 50, classification: "Neutral", updatedAt: Date.now() },
            nightMode: this.isNightMode(),
            weekendMode: this.isWeekendMode(),
            projections: p && p.cycles.length > 0 ? (() => {
                const firstTime = p.cycles[0].time || (Date.now() - 7 * 86400 * 1000);
                const days = Math.max(1, (Date.now() - firstTime) / (86400 * 1000));
                const dailyRunRate = Math.max(0.1, p.totalPnl / days);
                return {
                    daysTracked: Math.round(days),
                    dailyAvgUsdt: dailyRunRate,
                    dailyAvgCop: dailyRunRate * COP_PER_USDT,
                    p30dUsdt: dailyRunRate * 30,
                    p30dCop: dailyRunRate * 30 * COP_PER_USDT,
                    p60dUsdt: dailyRunRate * 60,
                    p60dCop: dailyRunRate * 60 * COP_PER_USDT,
                    p90dUsdt: dailyRunRate * 90,
                    p90dCop: dailyRunRate * 90 * COP_PER_USDT
                };
            })() : null,
            recentCycles: p ? p.cycles.slice(-15).reverse() : null
        };
    }
    startRefreshLoops() {
        const every = (name, ms, fn) => {
            const run = () => this.guarded(name, fn);
            run();
            this.timers.push(setInterval(run, ms));
        };
        every("prices", 2000, () => this.refreshPrices());
        every("account", 15000, () => this.refreshAccount());
        every("radar", 60000, () => this.refreshRadar());
        every("fng", 300000, () => this.refreshFng());
        every("pnl", 30000, () => this.pnl && !this.authError ? Promise.resolve() : this.refreshPnl());
        every("pnlFull", 120000, () => this.refreshPnl());
    }
    start() {
        this.startRefreshLoops();
        this.server = http.createServer((req, res) => {
            const parsedUrl = new URL(req.url || "/", `http://${req.headers.host}`);
            if (parsedUrl.pathname === "/api/status") {
                try {
                    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
                    res.end(JSON.stringify(this.getStatusData()));
                }
                catch (e) {
                    res.writeHead(500, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: e.message }));
                }
                return;
            }
            if (parsedUrl.pathname === "/api/strategies" && req.method === "GET") {
                try {
                    const ctrlFile = path.resolve(process.cwd(), ".strategy-controls.json");
                    const oppFile = path.resolve(process.cwd(), ".pending-opportunity.json");
                    const controls = fs.existsSync(ctrlFile) ? JSON.parse(fs.readFileSync(ctrlFile, "utf-8")) : {
                        strategies: { trailing_rebound: true, smart_dca: true, micro_grid: false, cazador_weekend: true },
                        autoPilot: true,
                        approvalTimeoutSec: 180
                    };
                    const pending = fs.existsSync(oppFile) ? JSON.parse(fs.readFileSync(oppFile, "utf-8")) : null;
                    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
                    res.end(JSON.stringify({ controls, pendingOpportunity: pending, serverTime: Date.now() }));
                }
                catch (e) {
                    res.writeHead(500, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: e.message }));
                }
                return;
            }
            if (parsedUrl.pathname === "/api/strategies/allocation" && req.method === "POST") {
                let body = "";
                req.on("data", chunk => body += chunk);
                req.on("end", () => {
                    try {
                        const data = JSON.parse(body || "{}");
                        let t = Math.max(0, parseInt(data.trailing || "0", 10));
                        let d = Math.max(0, parseInt(data.dca || "0", 10));
                        let g = Math.max(0, parseInt(data.grid || "0", 10));
                        let w = Math.max(0, parseInt(data.weekend || "0", 10));
                        const sum = t + d + g + w;
                        if (sum === 0) {
                            t = 50;
                            d = 30;
                            g = 0;
                            w = 20;
                        }
                        else if (sum !== 100) {
                            t = Math.round((t / sum) * 100);
                            d = Math.round((d / sum) * 100);
                            g = Math.round((g / sum) * 100);
                            w = 100 - t - d - g;
                        }
                        const ctrlFile = path.resolve(process.cwd(), ".strategy-controls.json");
                        const controls = fs.existsSync(ctrlFile) ? JSON.parse(fs.readFileSync(ctrlFile, "utf-8")) : {
                            strategies: { trailing_rebound: true, smart_dca: true, micro_grid: false, cazador_weekend: true },
                            autoPilot: true,
                            approvalTimeoutSec: 180
                        };
                        controls.baseAllocations = {
                            trailing_rebound: t,
                            smart_dca: d,
                            micro_grid: g,
                            cazador_weekend: w
                        };
                        const isW = this.isWeekendMode();
                        if (!isW) {
                            controls.allocations = {
                                trailing_rebound: t + w,
                                smart_dca: d,
                                micro_grid: g,
                                cazador_weekend: 0
                            };
                            controls.strategies.cazador_weekend = false;
                        }
                        else {
                            controls.allocations = {
                                trailing_rebound: t,
                                smart_dca: d,
                                micro_grid: g,
                                cazador_weekend: w
                            };
                            controls.strategies.cazador_weekend = true;
                        }
                        controls.updatedAt = Date.now();
                        fs.writeFileSync(ctrlFile, JSON.stringify(controls, null, 2), "utf-8");
                        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                        res.end(JSON.stringify({ success: true, controls }));
                    }
                    catch (e) {
                        res.writeHead(400, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ error: e.message }));
                    }
                });
                return;
            }
            // Actualizar ajustes independientes de un módulo de estrategia
            if (parsedUrl.pathname === "/api/strategies/module-settings" && req.method === "POST") {
                let body = "";
                req.on("data", chunk => body += chunk);
                req.on("end", () => {
                    try {
                        const data = JSON.parse(body || "{}");
                        const ctrlFile = path.resolve(process.cwd(), ".strategy-controls.json");
                        const controls = fs.existsSync(ctrlFile) ? JSON.parse(fs.readFileSync(ctrlFile, "utf-8")) : {};
                        if (!controls.strategySettings)
                            controls.strategySettings = {};
                        const strat = data.strategy;
                        if (strat && ["trailing_rebound", "smart_dca", "micro_grid", "cazador_weekend"].includes(strat)) {
                            if (!controls.strategySettings[strat]) {
                                controls.strategySettings[strat] = { timeframe: "1h", stopLossEnabled: true, stopLossPct: 4.0 };
                            }
                            if (data.timeframe)
                                controls.strategySettings[strat].timeframe = data.timeframe;
                            if (data.stopLossEnabled !== undefined)
                                controls.strategySettings[strat].stopLossEnabled = !!data.stopLossEnabled;
                            if (data.stopLossPct !== undefined)
                                controls.strategySettings[strat].stopLossPct = Math.max(1, Math.min(20, parseFloat(data.stopLossPct)));
                        }
                        controls.updatedAt = Date.now();
                        fs.writeFileSync(ctrlFile, JSON.stringify(controls, null, 2), "utf-8");
                        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                        res.end(JSON.stringify({ success: true, controls }));
                    }
                    catch (e) {
                        res.writeHead(400, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ error: e.message }));
                    }
                });
                return;
            }
            // Aplicar sugerencia inteligente del bot a una estrategia específica
            if (parsedUrl.pathname === "/api/strategies/apply-suggestion" && req.method === "POST") {
                let body = "";
                req.on("data", chunk => body += chunk);
                req.on("end", () => {
                    try {
                        const data = JSON.parse(body || "{}");
                        const strat = data.strategy;
                        const ctrlFile = path.resolve(process.cwd(), ".strategy-controls.json");
                        const controls = fs.existsSync(ctrlFile) ? JSON.parse(fs.readFileSync(ctrlFile, "utf-8")) : {};
                        if (strat && controls.suggestions && controls.suggestions[strat]) {
                            if (!controls.strategySettings)
                                controls.strategySettings = {};
                            if (!controls.strategySettings[strat]) {
                                controls.strategySettings[strat] = { timeframe: "1h", stopLossEnabled: false, stopLossPct: 4.0 };
                            }
                            const sugg = controls.suggestions[strat];
                            controls.strategySettings[strat].timeframe = sugg.timeframe;
                            controls.strategySettings[strat].stopLossPct = sugg.stopLossPct;
                            // SEGURIDAD SPOT: NO forzar venta a pérdida; preservar el switch de stopLossEnabled que decidió el usuario
                            if (controls.strategySettings[strat].stopLossEnabled === undefined) {
                                controls.strategySettings[strat].stopLossEnabled = false;
                            }
                            // Si estaba rechazada, limpiar rechazo
                            if (controls.rejectedSuggestions && controls.rejectedSuggestions[strat]) {
                                delete controls.rejectedSuggestions[strat];
                            }
                            if (controls.suggestions[strat]) {
                                controls.suggestions[strat].status = "applied";
                                controls.suggestions[strat].isCurrent = true;
                            }
                            controls.updatedAt = Date.now();
                            fs.writeFileSync(ctrlFile, JSON.stringify(controls, null, 2), "utf-8");
                            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                            res.end(JSON.stringify({ success: true, controls, applied: sugg }));
                        }
                        else {
                            res.writeHead(400, { "Content-Type": "application/json" });
                            res.end(JSON.stringify({ error: "Sugerencia no encontrada para " + strat }));
                        }
                    }
                    catch (e) {
                        res.writeHead(400, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ error: e.message }));
                    }
                });
                return;
            }
            // Descartar / Rechazar sugerencia de Centinela (silenciar por 4h)
            if (parsedUrl.pathname === "/api/strategies/reject-suggestion" && req.method === "POST") {
                let body = "";
                req.on("data", chunk => body += chunk);
                req.on("end", () => {
                    try {
                        const data = JSON.parse(body || "{}");
                        const strat = data.strategy;
                        const ctrlFile = path.resolve(process.cwd(), ".strategy-controls.json");
                        const controls = fs.existsSync(ctrlFile) ? JSON.parse(fs.readFileSync(ctrlFile, "utf-8")) : {};
                        if (!controls.rejectedSuggestions)
                            controls.rejectedSuggestions = {};
                        if (strat) {
                            // Silenciar por 4 horas
                            controls.rejectedSuggestions[strat] = Date.now() + 4 * 3600 * 1000;
                            if (controls.suggestions && controls.suggestions[strat]) {
                                controls.suggestions[strat].status = "rejected";
                            }
                            controls.updatedAt = Date.now();
                            fs.writeFileSync(ctrlFile, JSON.stringify(controls, null, 2), "utf-8");
                            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                            res.end(JSON.stringify({ success: true, controls, rejected: strat }));
                        }
                        else {
                            res.writeHead(400, { "Content-Type": "application/json" });
                            res.end(JSON.stringify({ error: "Parámetro strategy faltante" }));
                        }
                    }
                    catch (e) {
                        res.writeHead(500, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ error: e.message }));
                    }
                });
                return;
            }
            // Deshacer rechazo de sugerencia de Centinela
            if (parsedUrl.pathname === "/api/strategies/undo-reject-suggestion" && req.method === "POST") {
                let body = "";
                req.on("data", chunk => body += chunk);
                req.on("end", () => {
                    try {
                        const data = JSON.parse(body || "{}");
                        const strat = data.strategy;
                        const ctrlFile = path.resolve(process.cwd(), ".strategy-controls.json");
                        const controls = fs.existsSync(ctrlFile) ? JSON.parse(fs.readFileSync(ctrlFile, "utf-8")) : {};
                        if (controls.rejectedSuggestions && strat) {
                            delete controls.rejectedSuggestions[strat];
                            if (controls.suggestions && controls.suggestions[strat]) {
                                const s = controls.strategySettings?.[strat];
                                const isCurrent = s?.timeframe === controls.suggestions[strat].timeframe;
                                controls.suggestions[strat].status = isCurrent ? "applied" : "pending";
                            }
                            controls.updatedAt = Date.now();
                            fs.writeFileSync(ctrlFile, JSON.stringify(controls, null, 2), "utf-8");
                            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                            res.end(JSON.stringify({ success: true, controls, unrejected: strat }));
                        }
                        else {
                            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                            res.end(JSON.stringify({ success: true, controls }));
                        }
                    }
                    catch (e) {
                        res.writeHead(500, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ error: e.message }));
                    }
                });
                return;
            }
            if (parsedUrl.pathname === "/api/strategies/timeframe" && req.method === "POST") {
                let body = "";
                req.on("data", chunk => body += chunk);
                req.on("end", () => {
                    try {
                        const data = JSON.parse(body || "{}");
                        const sym = data.symbol ? (data.symbol.endsWith("USDT") || data.symbol === "default" ? data.symbol : data.symbol + "USDT") : null;
                        const tf = data.timeframe && ["15m", "1h", "4h", "1d"].includes(data.timeframe) ? data.timeframe : null;
                        if (!sym || !tf) {
                            res.writeHead(400, { "Content-Type": "application/json" });
                            res.end(JSON.stringify({ error: "Símbolo y timeframe válidos ('15m', '1h', '4h') requeridos." }));
                            return;
                        }
                        const ctrlFile = path.resolve(process.cwd(), ".strategy-controls.json");
                        const controls = fs.existsSync(ctrlFile) ? JSON.parse(fs.readFileSync(ctrlFile, "utf-8")) : {};
                        if (!controls.symbolTimeframes)
                            controls.symbolTimeframes = {};
                        controls.symbolTimeframes[sym] = tf;
                        controls.updatedAt = Date.now();
                        fs.writeFileSync(ctrlFile, JSON.stringify(controls, null, 2), "utf-8");
                        const posFile = path.resolve(process.cwd(), ".trailing-positions.json");
                        if (fs.existsSync(posFile)) {
                            try {
                                const positions = JSON.parse(fs.readFileSync(posFile, "utf-8"));
                                const map = new Map(positions);
                                if (map.has(sym)) {
                                    const p = map.get(sym);
                                    p.customTimeframe = tf;
                                    map.set(sym, p);
                                    fs.writeFileSync(posFile, JSON.stringify(Array.from(map.entries()), null, 2), "utf-8");
                                }
                            }
                            catch (e) { }
                        }
                        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                        res.end(JSON.stringify({ success: true, symbol: sym, timeframe: tf }));
                    }
                    catch (e) {
                        res.writeHead(400, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ error: e.message }));
                    }
                });
                return;
            }
            if (parsedUrl.pathname === "/api/strategies/callback" && req.method === "POST") {
                let body = "";
                req.on("data", chunk => body += chunk);
                req.on("end", () => {
                    try {
                        const data = JSON.parse(body || "{}");
                        const sym = data.symbol ? (data.symbol.endsWith("USDT") || data.symbol === "default" ? data.symbol : data.symbol + "USDT") : null;
                        const cbPct = data.callbackPct !== undefined ? Math.max(0.10, Math.min(3.0, parseFloat(data.callbackPct))) : null;
                        if (!sym || cbPct === null) {
                            res.writeHead(400, { "Content-Type": "application/json" });
                            res.end(JSON.stringify({ error: "Símbolo y callbackPct (0.10% a 3.00%) requeridos." }));
                            return;
                        }
                        const ctrlFile = path.resolve(process.cwd(), ".strategy-controls.json");
                        const controls = fs.existsSync(ctrlFile) ? JSON.parse(fs.readFileSync(ctrlFile, "utf-8")) : {};
                        if (!controls.trailingCallbacks)
                            controls.trailingCallbacks = {};
                        controls.trailingCallbacks[sym] = cbPct;
                        controls.updatedAt = Date.now();
                        fs.writeFileSync(ctrlFile, JSON.stringify(controls, null, 2), "utf-8");
                        // Si la posición está abierta en .trailing-positions.json, actualizarla también
                        const posFile = path.resolve(process.cwd(), ".trailing-positions.json");
                        if (fs.existsSync(posFile)) {
                            try {
                                const positions = JSON.parse(fs.readFileSync(posFile, "utf-8"));
                                const map = new Map(positions);
                                if (map.has(sym)) {
                                    const p = map.get(sym);
                                    p.customCallbackPct = cbPct;
                                    map.set(sym, p);
                                    fs.writeFileSync(posFile, JSON.stringify(Array.from(map.entries()), null, 2), "utf-8");
                                }
                            }
                            catch (e) { }
                        }
                        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                        res.end(JSON.stringify({ success: true, symbol: sym, callbackPct: cbPct }));
                    }
                    catch (e) {
                        res.writeHead(400, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ error: e.message }));
                    }
                });
                return;
            }
            if (parsedUrl.pathname === "/api/strategies/settings" && req.method === "POST") {
                let body = "";
                req.on("data", chunk => body += chunk);
                req.on("end", () => {
                    try {
                        const data = JSON.parse(body || "{}");
                        const ctrlFile = path.resolve(process.cwd(), ".strategy-controls.json");
                        const controls = fs.existsSync(ctrlFile) ? JSON.parse(fs.readFileSync(ctrlFile, "utf-8")) : {
                            strategies: { trailing_rebound: true, smart_dca: true, micro_grid: false, cazador_weekend: true },
                            autoPilot: true,
                            approvalTimeoutSec: 180
                        };
                        if (data.stopLossEnabled !== undefined)
                            controls.stopLossEnabled = !!data.stopLossEnabled;
                        if (data.stopLossPct !== undefined)
                            controls.stopLossPct = Math.max(1, Math.min(20, parseFloat(data.stopLossPct)));
                        if (data.timeframe && ["15m", "1h", "4h", "1d"].includes(data.timeframe))
                            controls.timeframe = data.timeframe;
                        if (data.cashReservePct !== undefined)
                            controls.cashReservePct = Math.max(5, Math.min(50, parseInt(data.cashReservePct, 10)));
                        if (data.maxPerCoinPct !== undefined)
                            controls.maxPerCoinPct = Math.max(10, Math.min(60, parseInt(data.maxPerCoinPct, 10)));
                        if (data.autoPilot !== undefined)
                            controls.autoPilot = !!data.autoPilot;
                        controls.updatedAt = Date.now();
                        fs.writeFileSync(ctrlFile, JSON.stringify(controls, null, 2), "utf-8");
                        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                        res.end(JSON.stringify({ success: true, controls }));
                    }
                    catch (e) {
                        res.writeHead(400, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ error: e.message }));
                    }
                });
                return;
            }
            if (parsedUrl.pathname === "/api/strategies/toggle" && req.method === "POST") {
                let body = "";
                req.on("data", chunk => body += chunk);
                req.on("end", () => {
                    try {
                        const data = JSON.parse(body || "{}");
                        const ctrlFile = path.resolve(process.cwd(), ".strategy-controls.json");
                        const controls = fs.existsSync(ctrlFile) ? JSON.parse(fs.readFileSync(ctrlFile, "utf-8")) : {
                            strategies: { trailing_rebound: true, smart_dca: true, micro_grid: false, cazador_weekend: true },
                            autoPilot: true,
                            approvalTimeoutSec: 180
                        };
                        if (data.strategy && controls.strategies[data.strategy] !== undefined) {
                            controls.strategies[data.strategy] = !controls.strategies[data.strategy];
                        }
                        else if (data.autoPilot !== undefined) {
                            controls.autoPilot = !!data.autoPilot;
                        }
                        controls.updatedAt = Date.now();
                        fs.writeFileSync(ctrlFile, JSON.stringify(controls, null, 2), "utf-8");
                        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                        res.end(JSON.stringify({ success: true, controls }));
                    }
                    catch (e) {
                        res.writeHead(400, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ error: e.message }));
                    }
                });
                return;
            }
            if (parsedUrl.pathname === "/api/opportunity/action" && req.method === "POST") {
                let body = "";
                req.on("data", chunk => body += chunk);
                req.on("end", () => {
                    try {
                        const data = JSON.parse(body || "{}");
                        const actionFile = path.resolve(process.cwd(), ".opportunity-action.json");
                        fs.writeFileSync(actionFile, JSON.stringify({ action: data.action, time: Date.now() }, null, 2), "utf-8");
                        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                        res.end(JSON.stringify({ success: true }));
                    }
                    catch (e) {
                        res.writeHead(400, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ error: e.message }));
                    }
                });
                return;
            }
            const rel = parsedUrl.pathname === "/" ? "index.html" : parsedUrl.pathname.replace(/^\/+/, "");
            const filePath = path.resolve(this.publicDir, rel);
            if (filePath.startsWith(this.publicDir) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
                const mime = {
                    ".html": "text/html; charset=utf-8",
                    ".css": "text/css; charset=utf-8",
                    ".js": "application/javascript; charset=utf-8",
                    ".json": "application/json",
                    ".svg": "image/svg+xml",
                    ".png": "image/png"
                };
                res.writeHead(200, { "Content-Type": mime[path.extname(filePath).toLowerCase()] || "text/plain" });
                fs.createReadStream(filePath).pipe(res);
                return;
            }
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("404 Not Found");
        });
        this.server.on("error", (e) => {
            console.error(`⚠️ Dashboard no pudo iniciar en el puerto ${this.port}: ${e.message}`);
        });
        this.server.listen(this.port, () => {
            console.log(`🌐 Dashboard web disponible en: http://localhost:${this.port}`);
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
