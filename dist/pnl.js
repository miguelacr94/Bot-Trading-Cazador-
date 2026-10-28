/**
 * Cálculo de PnL REAL a partir del historial de trades de Binance (myTrades).
 * - Fuente única de verdad: lo que Binance registró (precios, cantidades y comisiones).
 * - Cada orden de venta = 1 ciclo cerrado.
 * - Emparejamiento LIFO: cada venta se cruza con las compras más recientes,
 *   que es como opera el bot (compra -> trailing -> venta).
 */
export const PNL_SYMBOLS = [
    "ETHUSDT",
    "SOLUSDT",
    "AVAXUSDT",
    "BTCUSDT",
    "BNBUSDT",
    "XRPUSDT",
    "PEPEUSDT",
    "DOGEUSDT",
    "BONKUSDT",
    "SHIBUSDT",
    "WIFUSDT"
];
// Inicio del bot: ignorar trades anteriores
// Ventana rodante para no agotar el límite de 1000 trades por consulta
export const PNL_SINCE = Date.now() - 14 * 86400 * 1000;
export async function computeRealizedPnl(client, since = PNL_SINCE) {
    let bnbPrice = 0;
    try {
        bnbPrice = parseFloat((await client.tickerPrice("BNBUSDT")).data.price);
    }
    catch { }
    const cycles = [];
    for (const symbol of PNL_SYMBOLS) {
        const base = symbol.replace("USDT", "");
        let trades = [];
        try {
            let res;
            try {
                res = await client.myTrades(symbol, { startTime: since, limit: 1000, recvWindow: 60000 });
            }
            catch {
                res = await client.myTrades(symbol, { limit: 1000, recvWindow: 60000 });
            }
            trades = res ? res.data : [];
        }
        catch {
            continue;
        }
        if (!trades.length)
            continue;
        trades.sort((a, b) => a.time - b.time || a.id - b.id);
        // Agrupar fills por orden
        const orders = [];
        for (const t of trades) {
            const last = orders[orders.length - 1];
            if (last && last.orderId === t.orderId)
                last.fills.push(t);
            else
                orders.push({ orderId: t.orderId, isBuyer: t.isBuyer, time: t.time, fills: [t] });
        }
        const lots = [];
        for (const o of orders) {
            let qty = 0, quote = 0, feeUsdt = 0, feeBase = 0;
            for (const f of o.fills) {
                const c = parseFloat(f.commission);
                qty += parseFloat(f.qty);
                quote += parseFloat(f.quoteQty);
                if (f.commissionAsset === "USDT")
                    feeUsdt += c;
                else if (f.commissionAsset === "BNB")
                    feeUsdt += c * bnbPrice;
                else if (f.commissionAsset === base) {
                    feeBase += c;
                    feeUsdt += c * parseFloat(f.price);
                }
            }
            if (o.isBuyer) {
                const netQty = qty - feeBase;
                // Si la comisión se cobró en la misma moneda ya está reflejada en netQty
                const cost = quote + (feeBase > 0 ? 0 : feeUsdt);
                if (netQty > 0)
                    lots.push({ qty: netQty, unitCost: cost / netQty });
                continue;
            }
            // Venta: cruzar LIFO con las compras más recientes
            let remaining = qty;
            let cost = 0;
            while (remaining > 1e-12 && lots.length) {
                const lot = lots[lots.length - 1];
                const take = Math.min(lot.qty, remaining);
                cost += take * lot.unitCost;
                lot.qty -= take;
                remaining -= take;
                if (lot.qty <= 1e-12)
                    lots.pop();
            }
            const matched = qty - remaining;
            if (matched <= 1e-12)
                continue; // venta de saldo previo al bot
            const ratio = matched / qty;
            const proceeds = quote * ratio - feeUsdt * ratio;
            const pnl = proceeds - cost;
            cycles.push({
                symbol,
                orderId: o.orderId,
                time: o.time,
                qty: matched,
                avgBuy: cost / matched,
                avgSell: quote / qty,
                costUsdt: cost,
                proceedsUsdt: proceeds,
                feesUsdt: feeUsdt * ratio,
                pnlUsdt: pnl,
                pnlPct: (pnl / cost) * 100
            });
        }
    }
    cycles.sort((a, b) => a.time - b.time);
    const bySymbol = {};
    let totalPnl = 0, totalFees = 0, wins = 0, losses = 0;
    for (const c of cycles) {
        totalPnl += c.pnlUsdt;
        totalFees += c.feesUsdt;
        if (c.pnlUsdt >= 0)
            wins++;
        else
            losses++;
        bySymbol[c.symbol] ??= { pnl: 0, cycles: 0 };
        bySymbol[c.symbol].pnl += c.pnlUsdt;
        bySymbol[c.symbol].cycles++;
    }
    return { cycles, totalPnl, totalFees, wins, losses, bySymbol };
}
