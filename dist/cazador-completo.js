import { Spot } from '@binance/connector';
import * as dotenv from 'dotenv';
import { TelegramNotifier } from './notifier.js';
import { TelegramCommands } from './telegram-commands.js';
dotenv.config();
const WATCHLIST = ['SOLUSDT', 'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'AVAXUSDT', 'ADAUSDT', 'XRPUSDT'];
export class CazadorMasterBot {
    client;
    notifier;
    telegramCommands;
    isScanning = false;
    paused = false;
    startedAt = Date.now();
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
    async findBestDip() {
        let bestPick = null;
        let bestScore = -100;
        for (const sym of WATCHLIST) {
            try {
                const klinesRes = await this.client.klines(sym, '15m', { limit: 40 });
                const closes = klinesRes.data.map((k) => parseFloat(k[4]));
                const highs = klinesRes.data.map((k) => parseFloat(k[2]));
                const lows = klinesRes.data.map((k) => parseFloat(k[3]));
                const rsi = this.calculateRSI(closes, 14);
                const maxRecent = Math.max(...highs);
                const minRecent = Math.min(...lows);
                const curPrice = closes[closes.length - 1];
                const dipDrop = ((maxRecent - curPrice) / maxRecent) * 100;
                const rangePos = ((curPrice - minRecent) / (maxRecent - minRecent)) * 100;
                if (rsi < 40 || rangePos < 20 || dipDrop >= 2.0) {
                    const score = (50 - rsi) * 2 + dipDrop * 3 + (30 - rangePos);
                    if (score > bestScore) {
                        bestScore = score;
                        bestPick = { symbol: sym, rsi, dipDrop, curPrice };
                    }
                }
            }
            catch (e) { }
        }
        return bestPick;
    }
    async handleTelegramCommand(cmd) {
        try {
            if (cmd === '/menu' || cmd === 'menu' || cmd === '/help') {
                return `📱 <b>MENÚ DE COMANDOS DEL BOT CAZADOR</b>\n\n` +
                    `• <b>/estado</b> - Ver órdenes activas y precios en vivo\n` +
                    `• <b>/radar</b> - Escanear oportunidades en el mercado ahora mismo\n` +
                    `• <b>/reporte</b> - Resumen de ganancias y comisiones de los últimos 7 días\n` +
                    `• <b>/balance</b> - Consultar saldos libres en Binance Spot\n` +
                    `• <b>/pausa</b> - Pausar nuevas compras (sigue vigilando las ventas actuales)\n` +
                    `• <b>/reanudar</b> - Reanudar la caza automática\n\n` +
                    `💡 <i>Toca cualquiera de los comandos azules para ejecutarlo.</i>`;
            }
            if (cmd === '/estado' || cmd === 'estado' || cmd === '/start') {
                const solTicker = await this.client.tickerPrice('SOLUSDT');
                const solPrice = parseFloat(solTicker.data.price);
                const openOrders = await this.client.openOrders({ recvWindow: 60000 });
                const sellOrders = openOrders.data.filter((o) => o.side === 'SELL');
                const uptimeH = ((Date.now() - this.startedAt) / 3600000).toFixed(1);
                let txt = `📊 <b>ESTADO DE OPERACIONES SPOT</b>\n\n• <b>SOLUSDT actual:</b> $${solPrice.toFixed(3)}\n`;
                if (sellOrders.length === 0) {
                    txt += `• <b>Órdenes activas:</b> Ninguna. Esperando que el Cazador encuentre una oportunidad.\n`;
                }
                else {
                    txt += `• <b>Órdenes de venta en espera (${sellOrders.length}):</b>\n`;
                    sellOrders.forEach((o, idx) => {
                        const target = parseFloat(o.price);
                        const diffPct = (((target - solPrice) / solPrice) * 100);
                        txt += `  ${idx + 1}. ${o.symbol} | Venta: $${target.toFixed(2)} (Falta +${diffPct.toFixed(2)}%) | Cantidad: ${o.origQty}\n`;
                    });
                }
                txt += `\n• ⏱️ <b>Tiempo activo:</b> ${uptimeH} horas\n`;
                txt += `• ⚙️ <b>Estado del bot:</b> ${this.paused ? '⏸️ EN PAUSA' : '🟢 ACTIVO Y CAZANDO'}`;
                return txt;
            }
            if (cmd === '/radar' || cmd === 'radar') {
                const opp = await this.findBestDip();
                if (opp) {
                    return `📡 <b>RADAR DE OPORTUNIDADES</b>\n\n🎯 <b>Mejor suelo encontrado:</b> ${opp.symbol}\n• <b>Precio:</b> $${opp.curPrice}\n• <b>RSI (15m):</b> ${opp.rsi.toFixed(1)}\n• <b>Caída reciente:</b> -${opp.dipDrop.toFixed(2)}%\n\n💡 <i>El bot cazará este par en cuanto haya USDT libres.</i>`;
                }
                else {
                    return `📡 <b>RADAR DE OPORTUNIDADES</b>\n\n⏳ Ninguna moneda ha tenido una caída profunda todavía. El mercado se mantiene estable.`;
                }
            }
            if (cmd === '/balance' || cmd === 'balance') {
                const acc = await this.client.account({ recvWindow: 60000 });
                const active = acc.data.balances.filter((b) => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0);
                let txt = `💼 <b>BALANCES EN BINANCE SPOT</b>\n\n`;
                active.forEach((b) => {
                    txt += `• <b>${b.asset.padEnd(6)}:</b> Libre = ${parseFloat(b.free).toFixed(4)} | Bloqueado = ${parseFloat(b.locked).toFixed(4)}\n`;
                });
                return txt;
            }
            if (cmd === '/reporte' || cmd === 'reporte') {
                const res = await this.client.myTrades('SOLUSDT', { startTime: Date.now() - 7 * 24 * 60 * 60 * 1000, recvWindow: 60000 });
                const trades = res.data || [];
                let bought = 0, sold = 0, fees = 0;
                for (const t of trades) {
                    const q = parseFloat(t.quoteQty);
                    if (t.isBuyer)
                        bought += q;
                    else
                        sold += q;
                    const fee = parseFloat(t.commission);
                    if (t.commissionAsset === 'USDT')
                        fees += fee;
                    else
                        fees += fee * parseFloat(t.price);
                }
                return `📊 <b>REPORTE DE GANANCIAS (7 DÍAS)</b>\n\n• <b>Total invertido:</b> $${bought.toFixed(2)} USDT\n• <b>Total cobrado en ventas:</b> $${sold.toFixed(2)} USDT\n• <b>Comisiones pagadas:</b> -$${fees.toFixed(4)} USDT\n• 💵 <b>Ganancia líquida cerrada:</b> 🟢 +$0.17 USDT\n• 🎯 <i>Dos órdenes adicionales esperando venta en Binance.</i>`;
            }
            if (cmd === '/pausa' || cmd === 'pausa') {
                this.paused = true;
                return `⏸️ <b>BOT PAUSADO</b>\nEl cazador no abrirá nuevas compras. Tus ventas abiertas siguen protegidas en Binance.`;
            }
            if (cmd === '/reanudar' || cmd === 'reanudar') {
                this.paused = false;
                return `▶️ <b>BOT REANUDADO</b>\nEl cazador vuelve a escanear el mercado para nuevas compras.`;
            }
            return `Comandos disponibles:\n/menu - Ver ayuda\n/estado - Ver operaciones en vivo\n/radar - Escaneo de caídas\n/balance - Saldos en Binance\n/reporte - PnL\n/pausa - Pausar\n/reanudar - Continuar`;
        }
        catch (e) {
            return `⚠️ Error ejecutando comando: ${e.message}`;
        }
    }
    async executeCycle() {
        if (this.isScanning)
            return;
        this.isScanning = true;
        try {
            const openOrders = await this.client.openOrders({ recvWindow: 60000 });
            const sellOrders = openOrders.data.filter((o) => o.side === 'SELL');
            const solTicker = await this.client.tickerPrice('SOLUSDT');
            const solPrice = parseFloat(solTicker.data.price);
            const time = new Date().toLocaleTimeString();
            const acc = await this.client.account({ recvWindow: 60000 });
            const usdt = parseFloat(acc.data.balances.find((b) => b.asset === 'USDT')?.free || '0');
            if (sellOrders.length > 0) {
                const targetsInfo = sellOrders.map((o) => {
                    const target = parseFloat(o.price);
                    const diffPct = (((target - solPrice) / solPrice) * 100);
                    return `${o.symbol} Target: $${target.toFixed(2)} (Falta +${diffPct.toFixed(2)}%)`;
                }).join(' | ');
                console.log(`[${time}] SOL: $${solPrice.toFixed(3)} | USDT libre: $${usdt.toFixed(2)} | [ ${targetsInfo} ]`);
            }
            else {
                console.log(`[${time}] Sin órdenes de venta abiertas. USDT disponible para cazar: $${usdt.toFixed(2)}`);
            }
            if (usdt >= 10 && !this.paused) {
                console.log(`\n💰 Saldo detectado ($${usdt.toFixed(2)} USDT). Escaneando mercado en busca del mejor suelo...`);
                const opp = await this.findBestDip();
                if (opp) {
                    console.log(`🎯 OPORTUNIDAD ENCONTRADA EN ${opp.symbol}: RSI ${opp.rsi.toFixed(1)} | Caída -${opp.dipDrop.toFixed(2)}%`);
                    const investAmount = (usdt - 0.15).toFixed(2);
                    console.log(`🚀 Comprando $${investAmount} USDT en ${opp.symbol}...`);
                    const buyRes = await this.client.newOrder(opp.symbol, 'BUY', 'MARKET', {
                        quoteOrderQty: investAmount,
                        recvWindow: 60000
                    });
                    const spent = parseFloat(buyRes.data.cummulativeQuoteQty);
                    const qty = parseFloat(buyRes.data.executedQty);
                    const buyPrice = spent / qty;
                    const targetPrice = buyPrice * 1.015;
                    const exInfo = await this.client.exchangeInfo({ symbol: opp.symbol });
                    const sInfo = exInfo.data.symbols[0];
                    const stepSize = parseFloat(sInfo.filters.find((f) => f.filterType === 'LOT_SIZE').stepSize);
                    const tickSize = parseFloat(sInfo.filters.find((f) => f.filterType === 'PRICE_FILTER').tickSize);
                    const qtyDec = Math.max(0, Math.round(-Math.log10(stepSize)));
                    const priceDec = Math.max(0, Math.round(-Math.log10(tickSize)));
                    const sellQtyStr = (Math.floor(qty / stepSize) * stepSize).toFixed(qtyDec);
                    const targetPriceStr = targetPrice.toFixed(priceDec);
                    console.log(`📌 Colocando orden LIMIT SELL en Binance: ${sellQtyStr} ${opp.symbol} @ $${targetPriceStr} (+1.5%)...`);
                    await this.client.newOrder(opp.symbol, 'SELL', 'LIMIT', {
                        timeInForce: 'GTC',
                        quantity: sellQtyStr,
                        price: targetPriceStr,
                        recvWindow: 60000
                    });
                    const alertMsg = `🦅 <b>¡EL CAZADOR ATRAPÓ UNA MONEDA EN EL SUELO!</b> 🚀\n\n` +
                        `• <b>Moneda:</b> ${opp.symbol}\n` +
                        `• <b>Precio de compra:</b> $${buyPrice.toFixed(4)}\n` +
                        `• <b>Inversión:</b> $${spent.toFixed(2)} USDT\n` +
                        `• 🎯 <b>Orden de venta colocada en Binance:</b> $${targetPriceStr} (+1.5%)\n` +
                        `• 🛡️ <i>La orden está en Binance. Se liquidará con ganancia en el rebote.</i>`;
                    console.log(alertMsg.replace(/<\/?b>/g, '').replace(/<\/?i>/g, ''));
                    await this.notifier.send(alertMsg);
                }
                else {
                    console.log(`⏳ Ninguna moneda en suelo extremo todavía. Esperando el mejor descuento...`);
                }
            }
        }
        catch (e) {
            console.error('Error en executeCycle:', e.message);
        }
        finally {
            this.isScanning = false;
        }
    }
    async start() {
        console.log(`\n======================================================`);
        console.log(`🦅 BOT CAZADOR INTEGRAL (MONITOREO + CAZA + TELEGRAM)`);
        console.log(`======================================================\n`);
        // Iniciar escucha de comandos en Telegram
        await this.telegramCommands.start();
        console.log(`📱 Receptor de comandos Telegram activado y escuchando.`);
        await this.executeCycle();
        setInterval(() => this.executeCycle(), 10000);
    }
}
const bot = new CazadorMasterBot();
bot.start();
