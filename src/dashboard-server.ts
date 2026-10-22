import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { Spot } from "@binance/connector";
import { computeRealizedPnl, PNL_SYMBOLS, PnlSummary } from "./pnl.js";

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
  private server: http.Server | null = null;
  private client: any;
  private publicDir: string;
  private port: number;
  private timers: NodeJS.Timeout[] = [];

  // Caché (último valor bueno conocido)
  private prices: Record<string, number> = {};
  private radarMeta: Record<string, { rsi: number; dropPct: number }> = {};
  private usdtFree: number | null = null;
  private usdtEarn: number | null = null;
  private pnl: PnlSummary | null = null;
  private lastPriceOk = 0;
  private authError: string | null = null;
  private busy: Record<string, boolean> = {};

  constructor(port = PORT) {
    this.port = port;
    this.publicDir = path.resolve(process.cwd(), "public");
    this.client = new Spot(process.env.BINANCE_API_KEY, process.env.BINANCE_API_SECRET, { recvWindow: 60000 });
  }

  private readJson(file: string): [string, any][] {
    try {
      const f = path.resolve(process.cwd(), file);
      if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf-8"));
    } catch {}
    return [];
  }

  private trackedSymbols(): string[] {
    const pos = this.readJson(".trailing-positions.json").map(([s]) => s);
    const buys = this.readJson(".trailing-buys.json").map(([s]) => s);
    return Array.from(new Set([...PNL_SYMBOLS, ...pos, ...buys]));
  }

  /** Ejecuta una tarea de refresco sin solaparla consigo misma */
  private async guarded(name: string, fn: () => Promise<void>) {
    if (this.busy[name]) return;
    this.busy[name] = true;
    try { await fn(); } catch {} finally { this.busy[name] = false; }
  }

  private async refreshPrices() {
    const syms = this.trackedSymbols();
    const url = `${BINANCE_PUBLIC}/api/v3/ticker/price?symbols=${encodeURIComponent(JSON.stringify(syms))}`;
    const res = await fetch(url);
    if (!res.ok) return;
    const arr: any[] = await res.json();
    for (const t of arr) this.prices[t.symbol] = parseFloat(t.price);
    this.lastPriceOk = Date.now();
  }

  private async refreshRadar() {
    for (const sym of PNL_SYMBOLS) {
      try {
        const res = await fetch(`${BINANCE_PUBLIC}/api/v3/klines?symbol=${sym}&interval=15m&limit=35`);
        if (!res.ok) continue;
        const data: any[] = await res.json();
        const closes = data.map((k) => parseFloat(k[4]));
        const highs = data.map((k) => parseFloat(k[2]));
        const cur = closes[closes.length - 1];
        const maxRecent = Math.max(...highs.slice(-20));
        this.radarMeta[sym] = {
          rsi: this.calculateRSI(closes, 14),
          dropPct: maxRecent > 0 ? ((maxRecent - cur) / maxRecent) * 100 : 0
        };
      } catch {}
    }
  }

  private describeError(e: any): string {
    const d = e?.response?.data;
    return d?.msg ? `${d.msg} (código ${d.code})` : (e?.message || "Error desconocido");
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
    this.usdtFree = parseFloat(b.find((x: any) => x.asset === "USDT")?.free || "0");
    this.usdtEarn = parseFloat(b.find((x: any) => x.asset === "LDUSDT")?.free || "0");
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
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) gains += diff; else losses += Math.abs(diff);
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
    return 100 - (100 / (1 + avgGain / avgLoss));
  }

  private getCallbackPct(symbol: string): number {
    if (symbol.includes("PEPE")) return 0.55;
    if (symbol.includes("AVAX")) return 0.45;
    return 0.30;
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
      const callback = this.getCallbackPct(symbol);
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
      recentCycles: p ? p.cycles.slice(-15).reverse() : null
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
        } catch (e: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }

      const rel = parsedUrl.pathname === "/" ? "index.html" : parsedUrl.pathname.replace(/^\/+/, "");
      const filePath = path.resolve(this.publicDir, rel);
      if (filePath.startsWith(this.publicDir) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const mime: Record<string, string> = {
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

    this.server.on("error", (e: any) => {
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
