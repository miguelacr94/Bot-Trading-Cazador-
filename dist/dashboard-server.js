import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { Spot } from "@binance/connector";
import { computeRealizedPnl, PNL_SYMBOLS } from "./pnl.js";
dotenv.config();
const PORT = parseInt(process.env.DASHBOARD_PORT || process.env.PORT || "3333", 10);
const COP_PER_USDT = 4200;
export class DashboardServer {
    server = null;
    client;
    publicDir;
    port;
    constructor(port = PORT) {
        this.port = port;
        this.publicDir = path.resolve(process.cwd(), "public");
        this.client = new Spot(process.env.BINANCE_API_KEY, process.env.BINANCE_API_SECRET, { recvWindow: 60000 });
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
    getCallbackPct(symbol) {
        if (symbol.includes("PEPE"))
            return 0.55;
        if (symbol.includes("AVAX"))
            return 0.45;
        return 0.30;
    }
    async getStatusData() {
        // 1. Cargar posiciones trailing desde disco
        let rawPositions = [];
        try {
            const pFile = path.resolve(process.cwd(), ".trailing-positions.json");
            if (fs.existsSync(pFile)) {
                rawPositions = JSON.parse(fs.readFileSync(pFile, "utf-8"));
            }
        }
        catch { }
        // 2. Cargar trailing buys desde disco
        let rawBuys = [];
        try {
            const bFile = path.resolve(process.cwd(), ".trailing-buys.json");
            if (fs.existsSync(bFile)) {
                rawBuys = JSON.parse(fs.readFileSync(bFile, "utf-8"));
            }
        }
        catch { }
        // 3. Precios en tiempo real públicos de Binance
        const tickersMap = {};
        const symsToQuery = Array.from(new Set([
            ...PNL_SYMBOLS,
            ...rawPositions.map(([s]) => s),
            ...rawBuys.map(([s]) => s)
        ]));
        await Promise.all(symsToQuery.map(async (s) => {
            try {
                const t = await this.client.tickerPrice(s);
                tickersMap[s] = parseFloat(t.data.price);
            }
            catch { }
        }));
        // 4. Balances de cuenta
        let usdtFree = 0;
        let usdtEarn = 0;
        let balances = [];
        try {
            const acc = await this.client.account({ recvWindow: 60000 });
            balances = acc.data.balances || [];
            usdtFree = parseFloat(balances.find((b) => b.asset === "USDT")?.free || "0");
            usdtEarn = parseFloat(balances.find((b) => b.asset === "LDUSDT")?.free || "0");
        }
        catch { }
        // 5. Procesar Posiciones Activas
        let totalInvested = 0;
        let totalCurrentValue = usdtFree + usdtEarn;
        const positions = rawPositions.map(([symbol, pos]) => {
            const curPrice = tickersMap[symbol] || pos.buyPrice;
            const target08 = pos.buyPrice * 1.008;
            const gainPct = ((curPrice - pos.buyPrice) / pos.buyPrice) * 100;
            // Progreso hacia la meta (0% en entrada, 100% en target08)
            let progressPct = 0;
            if (target08 > pos.buyPrice) {
                progressPct = ((curPrice - pos.buyPrice) / (target08 - pos.buyPrice)) * 100;
            }
            const pnlUsdt = (pos.qty * curPrice) - pos.investedUsdt;
            const pnlCop = pnlUsdt * COP_PER_USDT;
            const callback = this.getCallbackPct(symbol);
            const stopPrice = pos.highestPrice * (1 - callback / 100);
            const peakGainPct = ((pos.highestPrice - pos.buyPrice) / pos.buyPrice) * 100;
            totalInvested += pos.investedUsdt;
            totalCurrentValue += (pos.qty * curPrice);
            return {
                symbol,
                base: symbol.replace("USDT", ""),
                qty: pos.qty,
                investedUsdt: pos.investedUsdt,
                buyPrice: pos.buyPrice,
                curPrice,
                target08,
                progressPct: Math.max(0, Math.min(150, progressPct)),
                gainPct,
                pnlUsdt,
                pnlCop,
                highestPrice: pos.highestPrice,
                peakGainPct,
                stopPrice,
                callbackPct: callback,
                activated: pos.activated || gainPct >= 0.8,
                buyTime: pos.buyTime
            };
        });
        // 6. Procesar Radar de Caídas
        const radar = await Promise.all(PNL_SYMBOLS.filter((s) => !rawPositions.some(([posSym]) => posSym === s)).map(async (sym) => {
            const curPrice = tickersMap[sym] || 0;
            let rsi = 50;
            let drop20 = 0;
            try {
                const klinesRes = await this.client.klines(sym, "15m", { limit: 35 });
                const closes = klinesRes.data.map((k) => parseFloat(k[4]));
                const highs = klinesRes.data.map((k) => parseFloat(k[2]));
                rsi = this.calculateRSI(closes, 14);
                const maxRecent = Math.max(...highs.slice(-20));
                if (maxRecent > 0 && curPrice > 0) {
                    drop20 = ((maxRecent - curPrice) / maxRecent) * 100;
                }
            }
            catch { }
            const buyWatch = rawBuys.find(([s]) => s === sym)?.[1];
            return {
                symbol: sym,
                base: sym.replace("USDT", ""),
                curPrice,
                rsi: parseFloat(rsi.toFixed(1)),
                dropPct: parseFloat(drop20.toFixed(2)),
                isHunting: !!buyWatch,
                lowestPrice: buyWatch?.lowestPrice || curPrice,
                triggerPrice: buyWatch ? buyWatch.lowestPrice * 1.0025 : null
            };
        }));
        // 7. PnL Auditado y Ciclos Cerrados
        let pnlSummary = { cycles: [], totalPnl: 0, totalFees: 0, wins: 0, losses: 0, bySymbol: {} };
        try {
            pnlSummary = await computeRealizedPnl(this.client);
        }
        catch { }
        return {
            updatedAt: new Date().toISOString(),
            portfolio: {
                totalEstimatedUsdt: totalCurrentValue,
                totalEstimatedCop: totalCurrentValue * COP_PER_USDT,
                usdtFree,
                usdtEarn,
                totalInvested,
                openPositionsCount: positions.length,
                maxSlots: 5
            },
            positions,
            radar,
            performance: {
                totalPnlUsdt: pnlSummary.totalPnl,
                totalPnlCop: pnlSummary.totalPnl * COP_PER_USDT,
                totalFeesUsdt: pnlSummary.totalFees,
                wins: pnlSummary.wins,
                losses: pnlSummary.losses,
                winRate: (pnlSummary.wins + pnlSummary.losses) > 0
                    ? Math.round((pnlSummary.wins / (pnlSummary.wins + pnlSummary.losses)) * 100)
                    : 100,
                cyclesCount: pnlSummary.cycles.length
            },
            recentCycles: pnlSummary.cycles.slice(-15).reverse()
        };
    }
    start() {
        this.server = http.createServer(async (req, res) => {
            // CORS headers
            res.setHeader("Access-Control-Allow-Origin", "*");
            res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
            res.setHeader("Access-Control-Allow-Headers", "Content-Type");
            if (req.method === "OPTIONS") {
                res.writeHead(204);
                res.end();
                return;
            }
            const parsedUrl = new URL(req.url || "/", `http://${req.headers.host}`);
            if (parsedUrl.pathname === "/api/status") {
                try {
                    const data = await this.getStatusData();
                    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                    res.end(JSON.stringify(data));
                }
                catch (e) {
                    res.writeHead(500, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: e.message }));
                }
                return;
            }
            // Servir index.html
            const filePath = path.join(this.publicDir, parsedUrl.pathname === "/" ? "index.html" : parsedUrl.pathname);
            if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
                const ext = path.extname(filePath).toLowerCase();
                const mimeTypes = {
                    ".html": "text/html; charset=utf-8",
                    ".css": "text/css; charset=utf-8",
                    ".js": "application/javascript; charset=utf-8",
                    ".json": "application/json",
                    ".png": "image/png",
                    ".svg": "image/svg+xml"
                };
                res.writeHead(200, { "Content-Type": mimeTypes[ext] || "text/plain" });
                fs.createReadStream(filePath).pipe(res);
                return;
            }
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("404 Not Found");
        });
        this.server.listen(this.port, () => {
            console.log(`🌐 Dashboard web disponible en: http://localhost:${this.port}`);
        });
        return this.server;
    }
    stop() {
        if (this.server) {
            this.server.close();
        }
    }
}
// Iniciar standalone si se invoca directamente
if (process.env.DASHBOARD_STANDALONE === "1") {
    const ds = new DashboardServer();
    ds.start();
}
