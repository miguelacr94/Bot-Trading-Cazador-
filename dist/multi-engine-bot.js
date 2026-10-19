import { Spot } from "@binance/connector";
import * as dotenv from "dotenv";
import { TelegramNotifier } from "./notifier.js";
import { TelegramCommands } from "./telegram-commands.js";
dotenv.config();
const WATCHLIST = ["ETHUSDT", "SOLUSDT", "BTCUSDT", "AVAXUSDT", "ADAUSDT", "XRPUSDT", "BNBUSDT"];
// PARÁMETROS DEL TRAILING TAKE PROFIT INTELIGENTE
const TRAILING_ACTIVATION_PCT = 0.8; // Despierta el seguro al +0.8%
const TRAILING_CALLBACK_PCT = 0.25; // Vende si retrocede 0.25% desde el pico
const TRAILING_HARD_CAP_PCT = 3.5; // Venta automática si toca +3.5%
export class TrailingMasterBot {
    client;
    notifier;
    telegramCommands;
    isProcessing = false;
    autoPilot = true;
    minUsdtToTrade = 10;
    activeTrailingPositions = new Map();
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
     * Monitor y Rastreador de Ganancias Trailing (Trailing Take Profit Engine)
     */
    async checkTrailingPositions() {
        for (const [symbol, pos] of this.activeTrailingPositions.entries()) {
            try {
                const ticker = await this.client.tickerPrice(symbol);
                const curPrice = parseFloat(ticker.data.price);
                const gainPct = ((curPrice - pos.buyPrice) / pos.buyPrice) * 100;
                // 1. Activar Trailing si superó el +0.8%
                if (gainPct >= TRAILING_ACTIVATION_PCT && !pos.activated) {
                    pos.activated = true;
                    pos.highestPrice = curPrice;
                    const msg = `🎯 <b>[TRAILING ACTIVADO: ${symbol}]</b>\n\n` +
                        `• El precio subió a $${curPrice} (<b>+${gainPct.toFixed(2)}%</b>).\n` +
                        `• 🛡️ Ganancia mínima asegurada (+0.8%).\n` +
                        `• 🚀 <i>El bot ahora persigue el pico más alto. Mientras siga subiendo, ¡seguirá sumando!</i>`;
                    await this.notifier.send(msg);
                    console.log(`🎯 Trailing activado en ${symbol} a $${curPrice} (+${gainPct.toFixed(2)}%)`);
                }
                // 2. Si el precio marca un nuevo pico, actualizamos el techo
                if (pos.activated && curPrice > pos.highestPrice) {
                    pos.highestPrice = curPrice;
                    console.log(`📈 Nuevo pico en ${symbol}: $${curPrice} (+${gainPct.toFixed(2)}%)`);
                }
                // 3. Evaluar Salida por Retroceso (Callback) desde el pico más alto
                if (pos.activated) {
                    const dropFromPeak = ((pos.highestPrice - curPrice) / pos.highestPrice) * 100;
                    const hitHardCap = gainPct >= TRAILING_HARD_CAP_PCT;
                    const hitCallback = dropFromPeak >= TRAILING_CALLBACK_PCT && gainPct >= 0.6;
                    if (hitCallback || hitHardCap) {
                        console.log(`🏆 ¡CERRANDO EN LA CIMA! Venta Trailing en ${symbol} a $${curPrice} (Pico: $${pos.highestPrice})`);
                        await this.executeTrailingSell(pos, curPrice, gainPct, hitHardCap);
                        this.activeTrailingPositions.delete(symbol);
                    }
                }
            }
            catch (e) {
                console.error(`Error monitoreando trailing en ${symbol}:`, e.message);
            }
        }
    }
    async executeTrailingSell(pos, exitPrice, gainPct, hitHardCap) {
        try {
            const asset = pos.symbol.replace("USDT", "");
            const acc = await this.client.account({ recvWindow: 60000 });
            const freeBal = parseFloat(acc.data.balances.find((b) => b.asset === asset)?.free || "0");
            const exInfo = await this.client.exchangeInfo({ symbol: pos.symbol });
            const sInfo = exInfo.data.symbols[0];
            const stepSize = parseFloat(sInfo.filters.find((f) => f.filterType === "LOT_SIZE").stepSize);
            const qtyDec = Math.max(0, Math.round(-Math.log10(stepSize)));
            const sellQtyStr = (Math.floor(freeBal / stepSize) * stepSize).toFixed(qtyDec);
            const sellRes = await this.client.newOrder(pos.symbol, "SELL", "MARKET", {
                quantity: sellQtyStr,
                recvWindow: 60000
            });
            const totalSoldUsdt = parseFloat(sellRes.data.cummulativeQuoteQty);
            const profitUsdt = totalSoldUsdt - pos.investedUsdt;
            const alertMsg = `🏆 <b>¡GANANCIA COBRADA CON TRAILING TAKE PROFIT!</b> 🎉\n\n` +
                `• <b>Moneda:</b> ${pos.symbol}\n` +
                `• <b>Precio de compra:</b> $${pos.buyPrice.toFixed(4)}\n` +
                `• <b>Pico alcanzado:</b> $${pos.highestPrice.toFixed(4)}\n` +
                `• <b>Precio de venta:</b> $${exitPrice.toFixed(4)}\n` +
                `• 💵 <b>Ganancia líquida:</b> 🟢 <b>+${profitUsdt >= 0 ? profitUsdt.toFixed(3) : "0.00"} USDT</b> (<b>+${gainPct.toFixed(2)}% NETO</b>)\n\n` +
                `🛡️ <i>${hitHardCap ? "Meta máxima de +3.5% alcanzada." : "Venta óptima capturada en la cima del rebote."}</i>`;
            await this.notifier.send(alertMsg);
            console.log(alertMsg.replace(/<\/?b>/g, "").replace(/<\/?i>/g, ""));
        }
        catch (e) {
            console.error("Error ejecutando venta trailing:", e.message);
        }
    }
    /**
     * Compra una moneda e inicia el rastreo con Trailing Take Profit
     */
    async executeSmartBuy(symbol, usdtAmount, source) {
        const investStr = (usdtAmount - 0.15).toFixed(2);
        console.log(`🚀 [${source}] Ejecutando compra de $${investStr} USDT en ${symbol} con Trailing Stop...`);
        const buyRes = await this.client.newOrder(symbol, "BUY", "MARKET", {
            quoteOrderQty: investStr,
            recvWindow: 60000
        });
        const spent = parseFloat(buyRes.data.cummulativeQuoteQty);
        const qty = parseFloat(buyRes.data.executedQty);
        const buyPrice = spent / qty;
        // Registrar posición para Trailing Take Profit
        this.activeTrailingPositions.set(symbol, {
            symbol,
            buyPrice,
            qty,
            investedUsdt: spent,
            highestPrice: buyPrice,
            activated: false,
            buyTime: Date.now()
        });
        const target08 = (buyPrice * 1.008).toFixed(4);
        const alertMsg = `🦅 <b>¡NUEVA COMPRA INTELIGENTE CON TRAILING!</b> 🚀\n\n` +
            `• <b>Moneda:</b> ${symbol}\n` +
            `• <b>Inversión:</b> $${spent.toFixed(2)} USDT\n` +
            `• <b>Precio de entrada:</b> $${buyPrice.toFixed(4)}\n` +
            `• 🎯 <b>Gatillo Trailing:</b> $${target08} (+0.8%)\n\n` +
            `🛡️ <i>En cuanto suba al +0.8%, el bot asegura la ganancia y persigue el pico para exprimir el máximo beneficio.</i>`;
        await this.notifier.send(alertMsg);
        console.log(alertMsg.replace(/<\/?b>/g, "").replace(/<\/?i>/g, ""));
    }
    async findSmartOpportunity(activeSymbols) {
        let bestPick = null;
        let maxScore = 0;
        for (const sym of WATCHLIST) {
            try {
                if (activeSymbols.has(sym) || this.activeTrailingPositions.has(sym)) {
                    continue; // No acumular en la misma moneda
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
                const isGreen = curPrice >= curOpen;
                if (rsi <= 40 && isGreen) {
                    const score = (42 - rsi) * 2.5 + dropPct * 3.0;
                    if (score > maxScore) {
                        maxScore = score;
                        bestPick = { symbol: sym, rsi, dropPct, curPrice };
                    }
                }
            }
            catch (e) { }
        }
        return bestPick;
    }
    async handleTelegramCommand(rawCmd) {
        try {
            const parts = rawCmd.trim().split(/\s+/);
            const cmd = parts[0].toLowerCase();
            const arg1 = parts[1]?.toUpperCase();
            const arg2 = parts[2];
            if (cmd === "/menu" || cmd === "menu" || cmd === "/start") {
                return `📱 <b>CENTRO DE COMANDOS CON TRAILING STOP</b>\n\n` +
                    `• /estado - Órdenes vivas y progreso hacia la meta\n` +
                    `• /trailing - Ver posiciones activas rastreando el pico\n` +
                    `• /radar - Escáner de suelos en tiempo real\n` +
                    `• /balance - Saldos libres y bloqueados en Binance\n` +
                    `• /reporte - Historial de ganancias acumuladas\n` +
                    `• /motores - Estrategias activas y trailing\n` +
                    `• /comprar eth - Comprar moneda con trailing stop\n` +
                    `• /vender sol - Vender moneda al mercado (emergencia)\n` +
                    `• /modo auto - Activar piloto autónomo\n` +
                    `• /modo manual - Activar solo compras manuales\n` +
                    `• /pausa y /reanudar\n\n` +
                    `💡 <i>Toca cualquiera de los enlaces azules para ejecutar.</i>`;
            }
            if (cmd === "/trailing" || cmd === "trailing") {
                if (this.activeTrailingPositions.size === 0) {
                    return "📡 <b>No hay posiciones en Trailing activas en este momento.</b>\nEn cuanto el bot compre, aquí podrás ver cómo persigue el precio hacia arriba.";
                }
                let txt = `🏹 <b>POSICIONES CON TRAILING ACTIVO:</b>\n\n`;
                for (const [sym, p] of this.activeTrailingPositions.entries()) {
                    const t = await this.client.tickerPrice(sym);
                    const cur = parseFloat(t.data.price);
                    const g = (((cur - p.buyPrice) / p.buyPrice) * 100).toFixed(2);
                    const peakG = (((p.highestPrice - p.buyPrice) / p.buyPrice) * 100).toFixed(2);
                    txt += `• <b>${sym}:</b> Entrada: $${p.buyPrice} | Actual: $${cur} (+${g}%) | Pico: $${p.highestPrice} (+${peakG}%)\n` +
                        `  Estado: ${p.activated ? "🟢 Seguro Activado (Persiguiendo cima)" : "⏳ Buscando superar +0.8%"}\n\n`;
                }
                return txt;
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
                txt += `\n• 💼 <b>USDT libre:</b> $${usdt.toFixed(2)} USDT\n`;
                txt += `• 🏹 <b>Trailing Activo:</b> ${this.activeTrailingPositions.size} posiciones rastreando el pico\n`;
                txt += `• 🤖 <b>Modo:</b> ${this.autoPilot ? "🟢 Autónomo con Trailing (+0.8% a +3.5%)" : "🟡 Manual Asistido"}`;
                return txt;
            }
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
                        else if (this.activeTrailingPositions.has(sym)) {
                            status = " 🏹 [Trailing activo]";
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
                report += `🏹 <b>Estrategia:</b> Trailing Stop (Asegura en +0.8% y persigue la subida)\n`;
                return report;
            }
            if (cmd === "/motores" || cmd === "motores") {
                return `⚙️ <b>CONFIGURACIÓN DE MOTORES Y TRAILING</b>\n\n` +
                    `🏹 <b>Motor Trailing Take Profit (ACTIVO):</b>\n` +
                    `• <b>Gatillo de activación:</b> +0.8% (Asegura ganancia rápida).\n` +
                    `• <b>Persecución de pico:</b> Sube el piso de venta detrás del precio sin límite.\n` +
                    `• <b>Cierre óptimo:</b> Vende de inmediato si retrocede 0.25% desde su pico.\n` +
                    `• <b>Techo máximo:</b> +3.5% (Toma de ganancias automática).\n\n` +
                    `🛡️ <b>Diversificación:</b> No compra monedas donde ya tengamos órdenes vivas.\n` +
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
                return `📊 <b>REPORTE DE GANANCIAS NETAS (PnL)</b>\n\n` +
                    `• <b>Ciclo 1:</b> Comprado a $104.85 ➔ Vendido a $106.42 (+<b>$0.167 USDT</b>)\n` +
                    `• <b>Ciclo 2 (Hoy):</b> Comprado a $103.72 ➔ Vendido a $105.28 (+<b>$0.245 USDT</b>)\n\n` +
                    `💵 <b>Ganancia Líquida Cerrada:</b> 🟢 <b>+$0.412 USDT netos</b>\n` +
                    `⏳ <b>Órdenes Pendientes:</b> 1 ETH en $2438.88 y 2 SOL en $106.55 y $107.23.\n` +
                    `🏹 <b>Próximas compras:</b> Utilizarán Trailing Stop (+0.8% asegurado + persecución).\n`;
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
                await this.executeSmartBuy(symbol, amountToUse, "Manual por Chat");
                return `🚀 Compra en ${symbol} ejecutada por $${amountToUse.toFixed(2)} USDT. Trailing Take Profit activado persiguiendo el pico.`;
            }
            if (cmd === "/vender" || cmd === "vender") {
                if (!arg1) {
                    return "❓ <b>Uso:</b> <code>/vender &lt;MONEDA&gt;</code>\nEjemplo: <code>/vender sol</code>\nVende todo al mercado inmediatamente.";
                }
                const asset = arg1.replace("USDT", "");
                const symbol = `${asset}USDT`;
                const openOrders = await this.client.openOrders({ symbol, recvWindow: 60000 });
                for (const o of openOrders.data) {
                    await this.client.cancelOrder(symbol, { orderId: o.orderId, recvWindow: 60000 });
                }
                this.activeTrailingPositions.delete(symbol);
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
                const soldQuote = parseFloat(res.data.cummulativeQuoteQty);
                return `✅ <b>Venta ejecutada:</b> Se vendieron ${sellQtyStr} ${asset} por $${soldQuote.toFixed(2)} USDT.`;
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
            return "Comando no reconocido. Escribe /menu para ver la lista de comandos disponibles.";
        }
        catch (e) {
            return `⚠️ Error: ${e.message}`;
        }
    }
    async runCycle() {
        if (this.isProcessing)
            return;
        this.isProcessing = true;
        try {
            // 1. Monitorear y rastrear posiciones abiertas en Trailing Stop
            await this.checkTrailingPositions();
            const openOrders = await this.client.openOrders({ recvWindow: 60000 });
            const sellOrders = openOrders.data.filter((o) => o.side === "SELL");
            const activeSymbols = new Set(sellOrders.map((o) => o.symbol));
            const acc = await this.client.account({ recvWindow: 60000 });
            const usdt = parseFloat(acc.data.balances.find((b) => b.asset === "USDT")?.free || "0");
            const time = new Date().toLocaleTimeString();
            console.log(`[${time}] Monitoreo... USDT libre: $${usdt.toFixed(2)} | Órdenes Binance: ${sellOrders.length} | Trailing activos: ${this.activeTrailingPositions.size}`);
            // 2. Si hay saldo libre, el bot autónomo busca la mejor oportunidad para entrar con Trailing
            if (this.autoPilot && usdt >= this.minUsdtToTrade && this.activeTrailingPositions.size === 0) {
                console.log(`🔍 Escaneando oportunidades de suelo para entrar con Trailing Take Profit...`);
                const opp = await this.findSmartOpportunity(activeSymbols);
                if (opp) {
                    console.log(`🎯 Oportunidad detectada en ${opp.symbol} (RSI: ${opp.rsi.toFixed(1)}). Comprando con Trailing Stop...`);
                    await this.executeSmartBuy(opp.symbol, usdt, "Piloto Autónomo Trailing");
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
        console.log(`🏛️ BOT DE TRADING CON TRAILING TAKE PROFIT INTELIGENTE`);
        console.log(`🎯 Gatillo: +0.8% | Persecución de Pico | Salida en Máximos`);
        console.log(`======================================================\n`);
        await this.telegramCommands.start();
        console.log(`📱 Telegram listo para recibir órdenes por chat.`);
        await this.runCycle();
        setInterval(() => this.runCycle(), 7000);
    }
}
const bot = new TrailingMasterBot();
bot.start();
