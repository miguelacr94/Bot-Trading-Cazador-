import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import https from "https";
import { TelegramNotifier } from "./notifier.js";

dotenv.config();

function fetchPrices(symbols: string[]): Promise<Record<string, number>> {
  return new Promise((resolve, reject) => {
    https.get("https://api.binance.com/api/v3/ticker/price", (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const list = JSON.parse(data);
          const map: Record<string, number> = {};
          for (const item of list) {
            if (symbols.includes(item.symbol)) {
              map[item.symbol] = parseFloat(item.price);
            }
          }
          resolve(map);
        } catch (e) {
          reject(e);
        }
      });
    }).on("error", reject);
  });
}

export class BenchmarkTracker {
  private benchmarkFile: string;
  private notifier: TelegramNotifier;

  constructor() {
    this.benchmarkFile = path.resolve(process.cwd(), ".liquidation-benchmarks.json");
    this.notifier = new TelegramNotifier();
  }

  public getBenchmark(): any | null {
    if (fs.existsSync(this.benchmarkFile)) {
      try {
        return JSON.parse(fs.readFileSync(this.benchmarkFile, "utf-8"));
      } catch {}
    }
    return null;
  }

  public async evaluateAndNotify(forceNotify = false): Promise<string> {
    const data = this.getBenchmark();
    if (!data || !data.benchmarks) {
      return "No hay benchmarks de liquidación registrados.";
    }

    const symbols = Object.keys(data.benchmarks);
    const livePrices = await fetchPrices(symbols);

    let report = `📊 <b>[MONITOREO DE DESCUENTO VS CIERRE DEL VIERNES]</b> 📉\n\n`;
    report += `🗓️ <i>Salida registrada: ${data.dateStr}</i>\n\n`;

    let hasBigDrop = false;
    const comparisons: { symbol: string; exitP: number; curP: number; dropPct: number }[] = [];

    for (const sym of symbols) {
      const exitPrice = data.benchmarks[sym];
      const curPrice = livePrices[sym] || exitPrice;
      const dropPct = ((curPrice - exitPrice) / exitPrice) * 100;
      comparisons.push({ symbol: sym, exitP: exitPrice, curP: curPrice, dropPct });

      const isCheaper = dropPct <= -0.1;
      const dropEmoji = dropPct <= -8.0 ? "🔥" : (dropPct <= -5.0 ? "🎯" : (dropPct <= -2.5 ? "📉" : "⚖️"));
      const symClean = sym.replace("USDT", "");
      const dec = sym.includes("PEPE") ? 8 : 4;

      report += `${dropEmoji} <b>${symClean}:</b> Salida $${exitPrice.toFixed(dec)} ➡️ Actual $${curPrice.toFixed(dec)} (<b>${dropPct >= 0 ? "+" : ""}${dropPct.toFixed(2)}%</b>)\n`;

      if (dropPct <= -5.0) hasBigDrop = true;
    }

    report += `\n💼 <b>Objetivo Sábado/Domingo:</b> Comprar en el verdadero piso con <b>-5% a -10% de descuento</b> sobre el cierre del viernes.\n`;
    report += `🛡️ <b>Capital Líquido:</b> ~$161 USDT listos en billetera.`;

    console.log(report.replace(/<[^>]+>/g, ""));

    if (forceNotify || hasBigDrop) {
      try {
        await this.notifier.send(report);
      } catch (e: any) {
        console.error("Error enviando alerta benchmark Telegram:", e.message);
      }
    }

    return report;
  }
}

if (process.argv[1]?.includes("benchmark-tracker")) {
  const tracker = new BenchmarkTracker();
  tracker.evaluateAndNotify(true).then(() => {
    console.log("Evaluación de benchmark completada.");
  });
}
