import { Spot } from "@binance/connector";
import * as dotenv from "dotenv";
import { computeRealizedPnl } from "./pnl.js";
dotenv.config();
/** Auditoría de PnL real desde Binance. Uso: npx tsx src/audit-trades.ts */
const client = new Spot(process.env.BINANCE_API_KEY, process.env.BINANCE_API_SECRET, { recvWindow: 60000 });
computeRealizedPnl(client).then(s => {
    for (const c of s.cycles) {
        console.log(`${new Date(c.time).toLocaleString("es-CO")} ${c.symbol} qty ${c.qty.toFixed(5)} | compra ${c.avgBuy.toFixed(4)} -> venta ${c.avgSell.toFixed(4)} | fees ${c.feesUsdt.toFixed(4)} | PnL ${c.pnlUsdt >= 0 ? "+" : ""}${c.pnlUsdt.toFixed(4)} (${c.pnlPct.toFixed(2)}%)`);
    }
    console.log(`\nTOTAL: ${s.totalPnl.toFixed(4)} USDT | ciclos ${s.cycles.length} | ganados ${s.wins} | perdidos ${s.losses} | comisiones ${s.totalFees.toFixed(4)}`);
}).catch(e => console.error(e.response?.data || e.message));
