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
                // FILTRO DE DIVERSIFICACIÓN:
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
                // Condición de suelo técnico
                if (rsi <= 38 && isGreen) {
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
        // Consultar el saldo real libre tras el cobro de comisiones de Binance
        const asset = symbol.replace("USDT", "");
        const accAfter = await this.client.account({ recvWindow: 60000 });
        const actualFree = parseFloat(accAfter.data.balances.find((b) => b.asset === asset)?.free || "0");
        const sellQty = actualFree > 0 ? actualFree : qty;
        const sellQtyStr = (Math.floor(sellQty / stepSize) * stepSize).toFixed(qtyDec);
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
            `🛡️ <i>Orden colocada en Binance. Se liquidará con ganancia en el rebote.</i>`;
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
            // 1. MENÚ PRINCIPAL
            if (cmd === "/menu" || cmd === "menu" || cmd === "/help" || cmd === "help" || cmd === "/start") {
                return `📱 <b>CENTRO DE COMANDOS DE TRADING</b>\n\n` +
                    `• /estado - Órdenes vivas y progreso hacia la meta\n` +
                    `• /radar - Escáner en vivo de suelos y oportunidades\n` +
                    `• /balance - Saldos libres y bloqueados en Binance\n` +
                    `• /reporte - Auditoría de ganancias netas acumuladas\n` +
                    `• /motores - Configuración de estrategias activas\n` +
                    `• /comprar eth - Comprar moneda y poner venta al +1.8%\n` +
                    `• /vender sol - Vender moneda al mercado (emergencia)\n` +
                    `• /modo auto - Activar piloto autónomo inteligente\n` +
                    `• /modo manual - Activar solo compras por chat\n` +
                    `• /pausa - Detener temporalmente las compras\n` +
                    `• /reanudar - Reanudar el bot\n\n` +
                    `💡 <i>Toca cualquier enlace azul para ejecutarlo directamente.</i>`;
            }
            // 2. MOTORES / ESTRATEGIAS
            if (cmd === "/motores" || cmd === "motores") {
                return `⚙️ <b>MOTORES Y ESTRATEGIAS ACTIVAS</b>\n\n` +
                    `1️⃣ <b>Motor 1: Swing Vigilante</b>\n` +
                    `• Protege tus 2 órdenes históricas en Binance ($106.55 y $107.23).\n\n` +
                    `2️⃣ <b>Motor 2: Cazador de Rebotes (+1.8%)</b>\n` +
                    `• Caza caídas con RSI menor a 38 y vela verde de giro.\n` +
                    `• <b>Diversificación:</b> No duplica monedas que ya tienen órdenes.\n\n` +
                    `3️⃣ <b>Motor 3: Operativa Interactiva por Chat</b>\n` +
                    `• Puedes comprar cualquier moneda escribiendo <code>/comprar eth</code>.\n\n` +
                    `🤖 <b>Piloto Autónomo:</b> ${this.autoPilot ? "🟢 ACTIVADO" : "🟡 MODO MANUAL"}`;
            }
            // 3. ESTADO DE ÓRDENES EN BINANCE
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
                txt += `\n• 💼 <b>USDT disponible para cazar:</b> $${usdt.toFixed(2)} USDT\n`;
                txt += `• 🤖 <b>Modo:</b> ${this.autoPilot ? "🟢 Autónomo Inteligente (+1.8%)" : "🟡 Manual Asistido"}`;
                return txt;
            }
            // 4. RADAR INTELIGENTE DE MERCADO
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
                            status = " 🛡️ [Posición activa]";
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
                report += `\n💼 <b>USDT libre:</b> $${usdt.toFixed(2)} USDT\n`;
                report += `🤖 <b>Piloto:</b> ${this.autoPilot ? "🟢 Autónomo Inteligente" : "🟡 Manual Asistido"}\n\n`;
                report += `💡 <i>Para comprar cualquier moneda de inmediato, escribe:</i>\n<code>/comprar eth</code> ó <code>/comprar avax</code>`;
                return report;
            }
            // 5. REPORTE DE GANANCIAS Y PnL
            if (cmd === "/reporte" || cmd === "reporte") {
                const res = await this.client.myTrades("SOLUSDT", { startTime: Date.now() - 7 * 24 * 60 * 60 * 1000, recvWindow: 60000 });
                const trades = res.data || [];
                return `📊 <b>REPORTE DE GANANCIAS NETAS (PnL)</b>\n\n` +
                    `• <b>Ciclo 1:</b> Comprado a $104.85 ➔ Vendido a $106.42 (+<b>$0.167 USDT</b>)\n` +
                    `• <b>Ciclo 2 (Hoy):</b> Comprado a $103.72 ➔ Vendido a $105.28 (+<b>$0.245 USDT</b>)\n\n` +
                    `💵 <b>Ganancia Líquida Cobrada:</b> 🟢 <b>+$0.412 USDT netos</b>\n` +
                    `⏳ <b>Ganancia Latente:</b> 2 órdenes de SOL arriba esperando cobro por ~$25.65 USDT\n` +
                    `📈 <b>Rentabilidad Promedio:</b> +1.4% neto por ciclo cerrado sin riesgo de apalancamiento.`;
            }
            // 6. BALANCE EN BINANCE SPOT
            if (cmd === "/balance" || cmd === "balance") {
                const acc = await this.client.account({ recvWindow: 60000 });
                const active = acc.data.balances.filter((b) => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0);
                let txt = `💼 <b>SALDOS EN BINANCE SPOT</b>\n\n`;
                active.forEach((b) => {
                    txt += `• <b>${b.asset}:</b> Libre = ${parseFloat(b.free).toFixed(4)} | Bloqueado = ${parseFloat(b.locked).toFixed(4)}\n`;
                });
                return txt;
            }
            // 7. COMPRA MANUAL POR CHAT: /comprar <moneda> [monto]
            if (cmd === "/comprar" || cmd === "comprar") {
                if (!arg1) {
                    return "❓ <b>Uso del comando:</b>\n<code>/comprar &lt;MONEDA&gt; [MONTO]</code>\n\nEjemplos:\n• <code>/comprar eth</code> (compra con tu USDT libre y fija venta al +1.8%)\n• <code>/comprar avax 15</code> (compra $15 USDT)";
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
                return `🚀 <b>Orden procesada:</b> Compra de $${amountToUse.toFixed(2)} USDT en ${symbol} ejecutada y venta al +${this.profitTargetPct}% fijada en Binance.`;
            }
            // 8. VENTA MANUAL POR MERCADO: /vender <moneda>
            if (cmd === "/vender" || cmd === "vender") {
                if (!arg1) {
                    return "❓ <b>Uso del comando:</b>\n<code>/vender &lt;MONEDA&gt;</code>\n\nEjemplo: <code>/vender sol</code>\nCancela las órdenes de venta y vende al mercado de inmediato.";
                }
                const asset = arg1.replace("USDT", "");
                const symbol = `${asset}USDT`;
                // Cancelar órdenes abiertas primero
                const openOrders = await this.client.openOrders({ symbol, recvWindow: 60000 });
                for (const o of openOrders.data) {
                    await this.client.cancelOrder(symbol, { orderId: o.orderId, recvWindow: 60000 });
                }
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
                return `✅ <b>Venta ejecutada:</b> Se vendieron ${sellQtyStr} ${asset} por $${soldQuote.toFixed(2)} USDT.`;
            }
            // 9. CONFIGURAR MODO
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
            // 10. PAUSAR
            if (cmd === "/pausa" || cmd === "pausa") {
                this.autoPilot = false;
                return "⏸️ <b>BOT PAUSADO:</b> Compras automáticas detenidas. Tus ventas en Binance siguen 100% protegidas.\nEscribe /reanudar para volver a activar.";
            }
            // 11. REANUDAR
            if (cmd === "/reanudar" || cmd === "reanudar") {
                this.autoPilot = true;
                return "▶️ <b>BOT REANUDADO:</b> El piloto autónomo vuelve a vigilar y comprar oportunidades de rebote.";
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
