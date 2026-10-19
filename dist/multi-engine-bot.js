import { Spot } from "@binance/connector";
import * as dotenv from "dotenv";
import { TelegramNotifier } from "./notifier.js";
import { TelegramCommands } from "./telegram-commands.js";
dotenv.config();
const WATCHLIST = ["ETHUSDT", "SOLUSDT", "BTCUSDT", "AVAXUSDT", "ADAUSDT", "XRPUSDT", "BNBUSDT"];
export class SmartAutonomousBot {
    client;
    notifier;
    telegramCommands;
    isProcessing = false;
    autoPilot = true; // Modo autónomo inteligente activado por defecto
    minUsdtToTrade = 10;
    profitTargetPct = 1.8; // +1.8% neto por operación
    constructor() {
        this.client = new Spot(process.env.BINANCE_API_KEY, process.env.BINANCE_API_SECRET, { recvWindow: 60000 });
        this.notifier = new TelegramNotifier();
        this.telegramCommands = new TelegramCommands((cmd) => this.handleTelegramCommand(cmd));
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
     * MOTOR DE INTELIGENCIA Y SCORING MULTI-FACTOR:
     * 1. Descarta monedas que ya tienen órdenes activas (anti-sobreexposición).
     * 2. Evalúa sobreventa técnica (RSI 15m).
     * 3. Evalúa profundidad de la caída intradía.
     * 4. Confirma presencia de compradores (vela verde de absorción).
     */
    async findSmartOpportunity(activeSymbols) {
        let bestPick = null;
        let maxScore = 0;
        for (const sym of WATCHLIST) {
            try {
                // FILTRO DE INTELIGENCIA #1: Diversificación estricta.
                // Si ya tenemos una orden de venta abierta en esta moneda, no compramos más de la misma.
                if (activeSymbols.has(sym)) {
                    continue;
                }
                const klinesRes = await this.client.klines(sym, "15m", { limit: 35 });
                const data = klinesRes.data;
                const closes = data.map((k) => parseFloat(k[4]));
                const highs = data.map((k) => parseFloat(k[2]));
                const opens = data.map((k) => parseFloat(k[1]));
                const rsi = this.calculateRSI(closes, 14);
                const curPrice = closes[closes.length - 1];
                const curOpen = opens[opens.length - 1];
                const maxRecent = Math.max(...highs.slice(-20));
                const dropPct = ((maxRecent - curPrice) / maxRecent) * 100;
                const isGreen = curPrice >= curOpen; // Compradores absorbiendo
                // FILTRO DE INTELIGENCIA #2: Condición de descuento real
                if (rsi <= 38 && isGreen) {
                    // Score = Mayor caída + Menor RSI = Mayor potencial de rebote
                    const score = (40 - rsi) * 2.5 + dropPct * 3.0;
                    if (score > maxScore) {
                        maxScore = score;
                        bestPick = { symbol: sym, rsi, dropPct, curPrice, score };
                    }
                }
            }
            catch (e) { }
        }
        return bestPick;
    }
    /**
     * Ejecuta compra de mercado y coloca inmediatamente orden de venta LIMIT al +1.8% en Binance
     */
    async executeTrade(symbol, usdtAmount, source) {
        const investStr = (usdtAmount - 0.15).toFixed(2);
        console.log(`🚀 [${source}] Ejecutando compra de $${investStr} USDT en ${symbol}...`);
        const buyRes = await this.client.newOrder(symbol, "BUY", "MARKET", {
            quoteOrderQty: investStr,
            recvWindow: 60000
        });
        const spent = parseFloat(buyRes.data.cummulativeQuoteQty);
        const qty = parseFloat(buyRes.data.executedQty);
        const buyPrice = spent / qty;
        const targetPrice = buyPrice * (1 + this.profitTargetPct / 100);
        const exInfo = await this.client.exchangeInfo({ symbol });
        const sInfo = exInfo.data.symbols[0];
        const stepSize = parseFloat(sInfo.filters.find((f) => f.filterType === "LOT_SIZE").stepSize);
        const tickSize = parseFloat(sInfo.filters.find((f) => f.filterType === "PRICE_FILTER").tickSize);
        const qtyDec = Math.max(0, Math.round(-Math.log10(stepSize)));
        const priceDec = Math.max(0, Math.round(-Math.log10(tickSize)));
        const sellQtyStr = (Math.floor(qty / stepSize) * stepSize).toFixed(qtyDec);
        const targetPriceStr = targetPrice.toFixed(priceDec);
        console.log(`📌 Colocando LIMIT SELL en Binance: ${sellQtyStr} ${symbol} @ $${targetPriceStr} (+${this.profitTargetPct}%)...`);
        await this.client.newOrder(symbol, "SELL", "LIMIT", {
            timeInForce: "GTC",
            quantity: sellQtyStr,
            price: targetPriceStr,
            recvWindow: 60000
        });
        const alertMsg = `🦅 <b>¡OPERACIÓN ${source.toUpperCase()} EJECUTADA!</b> 🚀\n\n` +
            `• <b>Par:</b> ${symbol}\n` +
            `• <b>Invertido:</b> $${spent.toFixed(2)} USDT\n` +
            `• <b>Precio de compra:</b> $${buyPrice.toFixed(4)}\n` +
            `• 🎯 <b>Venta LÍMITE en Binance:</b> $${targetPriceStr} (<b>+${this.profitTargetPct}% NETO</b>)\n\n` +
            `🛡️ <i>Orden colocada de por vida en Binance. Cobrará automáticamente en el rebote.</i>`;
        console.log(alertMsg.replace(/<\/?b>/g, "").replace(/<\/?i>/g, ""));
        await this.notifier.send(alertMsg);
        return alertMsg;
    }
    async handleTelegramCommand(rawCmd) {
        try {
            const parts = rawCmd.trim().split(/\s+/);
            const cmd = parts[0].toLowerCase();
            const arg1 = parts[1]?.toUpperCase();
            const arg2 = parts[2];
            // 1. COMANDO DE COMPRA MANUAL POR TELEGRAM: /comprar <MONEDA> [MONTO_USDT]
            // Ejemplo: /comprar eth  ó  /comprar sol 15
            if (cmd === "/comprar" || cmd === "comprar") {
                if (!arg1) {
                    return "❓ <b>Uso del comando:</b>\n<code>/comprar &lt;MONEDA&gt; [MONTO]</code>\n\nEjemplos:\n• <code>/comprar eth</code> (usa todo tu USDT libre)\n• <code>/comprar btc 20</code> (compra $20 USDT en BTC)";
                }
                const symbol = arg1.endsWith("USDT") ? arg1 : `${arg1}USDT`;
                const acc = await this.client.account({ recvWindow: 60000 });
                const freeUsdt = parseFloat(acc.data.balances.find((b) => b.asset === "USDT")?.free || "0");
                if (freeUsdt < this.minUsdtToTrade) {
                    return `❌ <b>Saldo insuficiente:</b> Tienes $${freeUsdt.toFixed(2)} USDT libres. El mínimo para operar en Binance es $${this.minUsdtToTrade} USDT.`;
                }
                let amountToUse = freeUsdt;
                if (arg2 && !isNaN(parseFloat(arg2))) {
                    amountToUse = Math.min(parseFloat(arg2), freeUsdt);
                }
                await this.executeTrade(symbol, amountToUse, "Manual por Chat");
                return `🚀 <b>Orden procesada:</b> Compra de $${amountToUse.toFixed(2)} USDT en ${symbol} completada y venta al +${this.profitTargetPct}% fijada en Binance.`;
            }
            // 2. COMANDO DE VENTA DE EMERGENCIA O TOMA DE GANANCIAS: /vender <MONEDA>
            if (cmd === "/vender" || cmd === "vender") {
                if (!arg1) {
                    return "❓ <b>Uso del comando:</b>\n<code>/vender &lt;MONEDA&gt;</code>\n\nEjemplo: <code>/vender sol</code>\nCancela las órdenes de venta límite y vende todo al mercado de inmediato.";
                }
                const asset = arg1.replace("USDT", "");
                const symbol = `${asset}USDT`;
                // Cancelar órdenes abiertas primero
                const openOrders = await this.client.openOrders({ symbol, recvWindow: 60000 });
                for (const o of openOrders.data) {
                    await this.client.cancelOrder(symbol, { orderId: o.orderId, recvWindow: 60000 });
                }
                // Consultar balance disponible liberado
                const acc = await this.client.account({ recvWindow: 60000 });
                const bal = parseFloat(acc.data.balances.find((b) => b.asset === asset)?.free || "0");
                if (bal <= 0) {
                    return `❌ No tienes balance libre de ${asset} para vender.`;
                }
                const exInfo = await this.client.exchangeInfo({ symbol });
                const sInfo = exInfo.data.symbols[0];
                const stepSize = parseFloat(sInfo.filters.find((f) => f.filterType === "LOT_SIZE").stepSize);
                const qtyDec = Math.max(0, Math.round(-Math.log10(stepSize)));
                const sellQtyStr = (Math.floor(bal / stepSize) * stepSize).toFixed(qtyDec);
                const res = await this.client.newOrder(symbol, "SELL", "MARKET", {
                    quantity: sellQtyStr,
                    recvWindow: 60000
                });
                const soldQuote = parseFloat(res.data.cummulativeQuoteQty);
                return `✅ <b>Venta ejecutada:</b> Se vendieron ${sellQtyStr} ${asset} por mercado por $${soldQuote.toFixed(2)} USDT.`;
            }
            // 3. CAMBIAR MODO DE AUTONOMÍA: /modo auto | /modo manual
            if (cmd === "/modo" || cmd === "modo") {
                if (arg1 === "AUTO") {
                    this.autoPilot = true;
                    return "🟢 <b>Modo Autónomo Inteligente ACTIVADO:</b> El bot analizará el mercado y comprará las mejores oportunidades diversificando tu portafolio.";
                }
                else if (arg1 === "MANUAL") {
                    this.autoPilot = false;
                    return "🟡 <b>Modo Manual Asistido ACTIVADO:</b> El bot solo te notificará oportunidades por el radar. No comprará nada a menos que tú lo ordenes con /comprar.";
                }
                return `🤖 <b>Modo actual:</b> ${this.autoPilot ? "🟢 Autónomo Inteligente" : "🟡 Manual Asistido"}\n\nPuedes cambiarlo con:\n• <code>/modo auto</code>\n• <code>/modo manual</code>`;
            }
            // 4. RADAR INTELIGENTE (Rankeado por oportunidad)
            if (cmd === "/radar" || cmd === "radar") {
                const openOrders = await this.client.openOrders({ recvWindow: 60000 });
                const activeSymbols = new Set(openOrders.data.filter((o) => o.side === "SELL").map((o) => o.symbol));
                let report = `📡 <b>RADAR INTELIGENTE DE MERCADO</b>\n\n`;
                for (const sym of WATCHLIST) {
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
                        else if (rsi <= 35) {
                            status = " 🎯 [Suelo / Rebote VIP]";
                        }
                        else if (rsi <= 45) {
                            status = " 🟢 [Zona favorable]";
                        }
                        else {
                            status = " ⚪ [Neutro]";
                        }
                        report += `• <b>${sym}:</b> $${price} | RSI: <b>${rsi.toFixed(1)}</b>${status}\n`;
                    }
                    catch (e) { }
                }
                const acc = await this.client.account({ recvWindow: 60000 });
                const usdt = parseFloat(acc.data.balances.find((b) => b.asset === "USDT")?.free || "0");
                report += `\n💼 <b>USDT disponible:</b> $${usdt.toFixed(2)} USDT\n`;
                report += `🤖 <b>Piloto:</b> ${this.autoPilot ? "🟢 Autónomo Inteligente" : "🟡 Manual Asistido"}\n\n`;
                report += `💡 <i>Puedes comprar cualquier moneda directamente escribiendo:</i>\n<code>/comprar eth</code> o <code>/comprar avax</code>`;
                return report;
            }
            // 5. ESTADO DE ÓRDENES
            if (cmd === "/estado" || cmd === "estado" || cmd === "/start") {
                const openOrders = await this.client.openOrders({ recvWindow: 60000 });
                const sellOrders = openOrders.data.filter((o) => o.side === "SELL");
                let txt = `📊 <b>ESTADO GENERAL DE ÓRDENES</b>\n\n`;
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
                txt += `\n• 💼 <b>USDT libre:</b> $${usdt.toFixed(2)} USDT\n`;
                txt += `• 🤖 <b>Modo:</b> ${this.autoPilot ? "🟢 Autónomo Inteligente (+1.8%)" : "🟡 Manual Asistido"}`;
                return txt;
            }
            if (cmd === "/balance" || cmd === "balance") {
                const acc = await this.client.account({ recvWindow: 60000 });
                const active = acc.data.balances.filter((b) => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0);
                let txt = `💼 <b>SALDOS SPOT EN BINANCE</b>\n\n`;
                active.forEach((b) => {
                    txt += `• <b>${b.asset}:</b> Libre = ${parseFloat(b.free).toFixed(4)} | Bloqueado = ${parseFloat(b.locked).toFixed(4)}\n`;
                });
                return txt;
            }
            if (cmd === "/menu" || cmd === "menu" || cmd === "/help") {
                return `📱 <b>CENTRO DE COMANDOS DE TRADING</b>\n\n` +
                    `• <b>/comprar eth</b> - Comprar cualquier moneda con tus USDT y fijar venta +1.8%\n` +
                    `• <b>/vender sol</b> - Venta de emergencia por mercado si deseas salir ya\n` +
                    `• <b>/radar</b> - Análisis inteligente del mercado y mejores suelos\n` +
                    `• <b>/estado</b> - Monitoreo de órdenes y % que falta para vender\n` +
                    `• <b>/balance</b> - Consultar saldos en Binance Spot\n` +
                    `• <b>/modo auto</b> - Activar piloto autónomo inteligente\n` +
                    `• <b>/modo manual</b> - Activar solo compras manuales por chat\n\n` +
                    `💡 <i>Toca cualquiera de los comandos para interactuar directamente.</i>`;
            }
            return "Comando no reconocido. Escribe /menu para ver la lista completa de opciones.";
        }
        catch (e) {
            return `⚠️ Error procesando comando: ${e.message}`;
        }
    }
    async runCycle() {
        if (this.isProcessing)
            return;
        this.isProcessing = true;
        try {
            const openOrders = await this.client.openOrders({ recvWindow: 60000 });
            const sellOrders = openOrders.data.filter((o) => o.side === "SELL");
            const activeSymbols = new Set(sellOrders.map((o) => o.symbol));
            const acc = await this.client.account({ recvWindow: 60000 });
            const usdt = parseFloat(acc.data.balances.find((b) => b.asset === "USDT")?.free || "0");
            const time = new Date().toLocaleTimeString();
            console.log(`[${time}] Monitoreo... USDT libre: $${usdt.toFixed(2)} | Activas: ${sellOrders.length} (${Array.from(activeSymbols).join(", ") || "Ninguna"}) | Modo: ${this.autoPilot ? "AUTONOMO" : "MANUAL"}`);
            // EJECUCIÓN AUTÓNOMA INTELIGENTE:
            // Si tenemos al menos 10 USDT y el piloto automático está encendido
            if (this.autoPilot && usdt >= this.minUsdtToTrade) {
                console.log(`🔍 Analizando mercado con motor de inteligencia multi-factor (excluyendo activos ya en cartera)...`);
                const opp = await this.findSmartOpportunity(activeSymbols);
                if (opp) {
                    console.log(`🎯 ¡OPORTUNIDAD INTELIGENTE IDENTIFICADA EN ${opp.symbol}! RSI: ${opp.rsi.toFixed(1)} | Caída: -${opp.dropPct.toFixed(2)}%`);
                    await this.executeTrade(opp.symbol, usdt, "Piloto Autónomo Inteligente");
                }
                else {
                    console.log(`⏳ Sin suelo confirmado en activos diversificados. Esperando mejor oportunidad...`);
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
    async start() {
        console.log(`\n======================================================`);
        console.log(`🏛️ BOT DE TRADING AUTÓNOMO INTELIGENTE + OPERATIVA POR CHAT`);
        console.log(`🎯 Meta: +${this.profitTargetPct}% | Diversificación Estricta | Control Total por Telegram`);
        console.log(`======================================================\n`);
        await this.telegramCommands.start();
        console.log(`📱 Telegram listo para recibir órdenes por chat.`);
        await this.runCycle();
        setInterval(() => this.runCycle(), 10000);
    }
}
const bot = new SmartAutonomousBot();
bot.start();
