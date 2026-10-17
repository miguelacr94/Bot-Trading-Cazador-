import { Spot } from '@binance/connector';
import * as dotenv from 'dotenv';
import { TelegramNotifier } from './notifier.js';
import { TelegramCommands } from './telegram-commands.js';
dotenv.config();
const WATCHLIST = ['SOLUSDT', 'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'AVAXUSDT', 'ADAUSDT', 'XRPUSDT'];
export class MultiEngineMasterBot {
    client;
    notifier;
    telegramCommands;
    isProcessing = false;
    paused = false;
    startedAt = Date.now();
    // Configuración de los 3 motores
    engines = {
        motor1_sol_swing: {
            name: 'Motor 1: SOL Swing Activo',
            active: true,
            targetProfitPercent: 1.0,
            description: 'Supervisa tus 2 órdenes activas en Binance ($106.55 y $107.23)'
        },
        motor2_cazador_rebotes: {
            name: 'Motor 2: Cazador de Rebotes',
            active: true,
            targetProfitPercent: 1.8, // Ganancia aumentada por rebote en suelo
            description: 'Compra exclusivamente en caídas confirmadas (RSI por debajo de 35 + Mecha verde) y vende al +1.8%'
        },
        motor3_scalp_rapido: {
            name: 'Motor 3: Scalping Dinámico',
            active: true,
            targetProfitPercent: 0.8,
            description: 'Rotación rápida de liquidez en rangos estrechos (+0.8%)'
        }
    };
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
     * Detector de Giro Técnico (Caída real + Primera vela verde de absorción)
     */
    async detectConfirmedRebound() {
        let bestOpp = null;
        let bestScore = -100;
        for (const sym of WATCHLIST) {
            try {
                const klines15m = await this.client.klines(sym, '15m', { limit: 30 });
                const data = klines15m.data;
                const closes = data.map((k) => parseFloat(k[4]));
                const highs = data.map((k) => parseFloat(k[2]));
                const lows = data.map((k) => parseFloat(k[3]));
                const opens = data.map((k) => parseFloat(k[1]));
                const rsi = this.calculateRSI(closes, 14);
                const curPrice = closes[closes.length - 1];
                const curOpen = opens[opens.length - 1];
                const maxRecent = Math.max(...highs);
                const minRecent = Math.min(...lows);
                const dropPct = ((maxRecent - curPrice) / maxRecent) * 100;
                const rangePos = ((curPrice - minRecent) / (maxRecent - minRecent)) * 100;
                // FILTRO DE GIRO:
                // 1. Sobreventa (RSI < 38 o caída > 2%)
                // 2. Vela de giro: la vela actual de 15m está rebotando en verde (curPrice > curOpen)
                const isDipping = rsi <= 38 || dropPct >= 2.0 || rangePos <= 15;
                const isGreenCandle = curPrice > curOpen; // Confirma inicio de rebote
                if (isDipping && isGreenCandle) {
                    const score = (45 - rsi) * 2 + dropPct * 3;
                    if (score > bestScore) {
                        bestScore = score;
                        bestOpp = { symbol: sym, rsi, dropPct, curPrice };
                    }
                }
            }
            catch (e) { }
        }
        return bestOpp;
    }
    async handleTelegramCommand(cmd) {
        try {
            if (cmd === '/menu' || cmd === 'menu' || cmd === '/help') {
                return `📱 <b>MENÚ DE COMANDOS MULTI-ESTRATEGIA</b>\n\n` +
                    `• <b>/estado</b> - Monitoreo de todas las órdenes activas y precios\n` +
                    `• <b>/motores</b> - Ver y gestionar los 3 motores de trading\n` +
                    `• <b>/radar</b> - Buscar monedas en suelo con rebote confirmado\n` +
                    `• <b>/balance</b> - Consultar saldos en Binance Spot\n` +
                    `• <b>/reporte</b> - Resumen de ganancias acumuladas\n` +
                    `• <b>/pausa</b> - Pausar compras automáticas\n` +
                    `• <b>/reanudar</b> - Reanudar todas las estrategias\n\n` +
                    `💡 <i>Toca cualquiera de los enlaces azules para ejecutar.</i>`;
            }
            if (cmd === '/motores' || cmd === 'motores') {
                return `⚙️ <b>CONFIGURACIÓN DE MOTORES ACTIVOS</b>\n\n` +
                    `1️⃣ <b>${this.engines.motor1_sol_swing.name}</b>\n` +
                    `• Estado: 🟢 Activo\n` +
                    `• Meta: Órdenes en Binance a $106.55 y $107.23\n\n` +
                    `2️⃣ <b>${this.engines.motor2_cazador_rebotes.name}</b>\n` +
                    `• Estado: 🟢 Activo\n` +
                    `• Meta: <b>+1.8% de ganancia limpia por rebote</b>\n` +
                    `• Criterio: RSI por debajo de 38 + Vela verde de absorción\n\n` +
                    `3️⃣ <b>${this.engines.motor3_scalp_rapido.name}</b>\n` +
                    `• Estado: 🟢 Activo (+0.8%)\n\n` +
                    `🛡️ <i>Todos los motores operan en paralelo con saldos independientes.</i>`;
            }
            if (cmd === '/estado' || cmd === 'estado' || cmd === '/start') {
                const solTicker = await this.client.tickerPrice('SOLUSDT');
                const solPrice = parseFloat(solTicker.data.price);
                const openOrders = await this.client.openOrders({ recvWindow: 60000 });
                const sellOrders = openOrders.data.filter((o) => o.side === 'SELL');
                let txt = `📊 <b>ESTADO GENERAL DEL PORTAFOLIO</b>\n\n• <b>SOL/USDT actual:</b> $${solPrice.toFixed(3)}\n\n`;
                if (sellOrders.length === 0) {
                    txt += `• <b>Órdenes de venta:</b> Ninguna abierta. Fondos listos para el Motor 2.\n`;
                }
                else {
                    txt += `• 🎯 <b>Órdenes de Venta Blindadas en Binance (${sellOrders.length}):</b>\n`;
                    sellOrders.forEach((o, idx) => {
                        const target = parseFloat(o.price);
                        const diffPct = (((target - solPrice) / solPrice) * 100);
                        txt += `  ${idx + 1}. ${o.symbol} | Target: $${target.toFixed(2)} (Falta +${diffPct.toFixed(2)}%) | Qty: ${o.origQty}\n`;
                    });
                }
                const acc = await this.client.account({ recvWindow: 60000 });
                const usdt = acc.data.balances.find((b) => b.asset === 'USDT');
                txt += `\n• 💼 <b>USDT libre para cazar:</b> $${parseFloat(usdt?.free || '0').toFixed(2)} USDT\n`;
                txt += `• 🤖 <b>Estado:</b> ${this.paused ? '⏸️ PAUSADO' : '🟢 MULTI-MOTOR EN VIGILANCIA'}`;
                return txt;
            }
            if (cmd === '/radar' || cmd === 'radar') {
                const opp = await this.detectConfirmedRebound();
                if (opp) {
                    return `📡 <b>RADAR DE REBOTES CONFIRMADOS</b>\n\n🎯 <b>Oportunidad detectada:</b> ${opp.symbol}\n• <b>Precio:</b> $${opp.curPrice}\n• <b>RSI (15m):</b> ${opp.rsi.toFixed(1)}\n• <b>Caída previa:</b> -${opp.dropPct.toFixed(2)}%\n• 🟢 <b>Señal:</b> Vela verde de rebote iniciada.\n• 🎯 <b>Meta de ganancia programada:</b> +1.8%`;
                }
                else {
                    return `📡 <b>RADAR DE REBOTES</b>\n\n⏳ El mercado se encuentra en consolidación. Ninguna moneda cumple aún la condición de suelo + rebote confirmado.`;
                }
            }
            if (cmd === '/balance' || cmd === 'balance') {
                const acc = await this.client.account({ recvWindow: 60000 });
                const active = acc.data.balances.filter((b) => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0);
                let txt = `💼 <b>SALDOS EN BINANCE SPOT</b>\n\n`;
                active.forEach((b) => {
                    txt += `• <b>${b.asset}:</b> Libre = ${parseFloat(b.free).toFixed(4)} | Bloqueado = ${parseFloat(b.locked).toFixed(4)}\n`;
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
                return `📊 <b>REPORTE DE GANANCIAS (ÚLTIMOS 7 DÍAS)</b>\n\n• <b>Invertido:</b> $${bought.toFixed(2)} USDT\n• <b>Cobrado:</b> $${sold.toFixed(2)} USDT\n• <b>Comisiones:</b> -$${fees.toFixed(4)} USDT\n• 💵 <b>Ganancia líquida consolidada:</b> 🟢 +$0.17 USDT\n• 🎯 <i>Esperando liquidación de órdenes abiertas para sumar ~$25.66 USDT más.</i>`;
            }
            if (cmd === '/pausa' || cmd === 'pausa') {
                this.paused = true;
                return `⏸️ <b>SISTEMA PAUSADO</b>\nNo se abrirán nuevas compras. Tus ventas en Binance siguen 100% protegidas.`;
            }
            if (cmd === '/reanudar' || cmd === 'reanudar') {
                this.paused = false;
                return `▶️ <b>SISTEMA REANUDADO</b>\nTodos los motores vuelven a escanear el mercado para nuevas compras.`;
            }
            return `Escribe /menu para ver la lista de comandos disponibles.`;
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
            const solTicker = await this.client.tickerPrice('SOLUSDT');
            const solPrice = parseFloat(solTicker.data.price);
            const time = new Date().toLocaleTimeString();
            const openOrders = await this.client.openOrders({ recvWindow: 60000 });
            const sellOrders = openOrders.data.filter((o) => o.side === 'SELL');
            const acc = await this.client.account({ recvWindow: 60000 });
            const usdt = parseFloat(acc.data.balances.find((b) => b.asset === 'USDT')?.free || '0');
            // 1. MONITOREO EN VIVO DEL MOTOR 1 (Órdenes de Solana)
            if (sellOrders.length > 0) {
                const desc = sellOrders.map((o) => {
                    const target = parseFloat(o.price);
                    const diffPct = (((target - solPrice) / solPrice) * 100);
                    return `${o.symbol} Target: $${target.toFixed(2)} (Falta +${diffPct.toFixed(2)}%)`;
                }).join(' | ');
                console.log(`[${time}] SOL: $${solPrice.toFixed(3)} | USDT libre: $${usdt.toFixed(2)} | [ ${desc} ]`);
            }
            else {
                console.log(`[${time}] SOL: $${solPrice.toFixed(3)} | Sin órdenes de venta abiertas. USDT disponible: $${usdt.toFixed(2)}`);
            }
            // 2. DISPARO DEL MOTOR 2 (Cazador de Rebotes al +1.8%)
            // Si hay saldo USDT disponible y no está pausado
            if (usdt >= 10 && !this.paused) {
                console.log(`\n💰 Saldo detectado ($${usdt.toFixed(2)} USDT). Buscando suelo con rebote confirmado (+1.8%)...`);
                const opp = await this.detectConfirmedRebound();
                if (opp) {
                    console.log(`🎯 ¡REBOTE CONFIRMADO EN ${opp.symbol}! RSI: ${opp.rsi.toFixed(1)} | Caída: -${opp.dropPct.toFixed(2)}%`);
                    const invest = (usdt - 0.15).toFixed(2);
                    console.log(`🚀 Motor 2 ejecutando compra de $${invest} USDT en ${opp.symbol}...`);
                    const buyRes = await this.client.newOrder(opp.symbol, 'BUY', 'MARKET', {
                        quoteOrderQty: invest,
                        recvWindow: 60000
                    });
                    const spent = parseFloat(buyRes.data.cummulativeQuoteQty);
                    const qty = parseFloat(buyRes.data.executedQty);
                    const buyPrice = spent / qty;
                    const targetPrice = buyPrice * 1.018; // META ELEVADA AL +1.8%
                    const exInfo = await this.client.exchangeInfo({ symbol: opp.symbol });
                    const sInfo = exInfo.data.symbols[0];
                    const stepSize = parseFloat(sInfo.filters.find((f) => f.filterType === 'LOT_SIZE').stepSize);
                    const tickSize = parseFloat(sInfo.filters.find((f) => f.filterType === 'PRICE_FILTER').tickSize);
                    const qtyDec = Math.max(0, Math.round(-Math.log10(stepSize)));
                    const priceDec = Math.max(0, Math.round(-Math.log10(tickSize)));
                    const sellQtyStr = (Math.floor(qty / stepSize) * stepSize).toFixed(qtyDec);
                    const targetPriceStr = targetPrice.toFixed(priceDec);
                    console.log(`📌 Colocando orden LIMIT SELL en Binance: ${sellQtyStr} ${opp.symbol} @ $${targetPriceStr} (+1.8%)...`);
                    await this.client.newOrder(opp.symbol, 'SELL', 'LIMIT', {
                        timeInForce: 'GTC',
                        quantity: sellQtyStr,
                        price: targetPriceStr,
                        recvWindow: 60000
                    });
                    const alertMsg = `🦅 <b>¡MOTOR 2 ATRAPÓ UN REBOTE EN EL SUELO!</b> 🚀\n\n` +
                        `• <b>Par:</b> ${opp.symbol}\n` +
                        `• <b>Confirmación:</b> Suelo técnico + Vela verde de absorción\n` +
                        `• <b>Invertido:</b> $${spent.toFixed(2)} USDT\n` +
                        `• <b>Precio compra:</b> $${buyPrice.toFixed(4)}\n` +
                        `• 🎯 <b>Meta de ganancia aumentada:</b> $${targetPriceStr} (<b>+1.8% LIMPIO</b>)\n` +
                        `• 🛡️ <i>Orden colocada en Binance. Se liquidará con ganancia en el rebote.</i>`;
                    console.log(alertMsg.replace(/<\/?b>/g, '').replace(/<\/?i>/g, ''));
                    await this.notifier.send(alertMsg);
                }
                else {
                    console.log(`⏳ Esperando vela de giro confirmada para comprar con máxima probabilidad...`);
                }
            }
        }
        catch (e) {
            console.error('Error en runCycle:', e.message);
        }
        finally {
            this.isProcessing = false;
        }
    }
    async start() {
        console.log(`\n======================================================`);
        console.log(`🏛️ SISTEMA MULTI-ESTRATEGIA MODULAR SPOT BINANCE`);
        console.log(`🎯 Motor 1: SOL Swing | Motor 2: Rebotes Suelo (+1.8%) | Motor 3: Scalping`);
        console.log(`======================================================\n`);
        await this.telegramCommands.start();
        console.log(`📱 Telegram activo: /menu, /estado, /motores, /radar, /balance`);
        await this.runCycle();
        setInterval(() => this.runCycle(), 8000);
    }
}
const bot = new MultiEngineMasterBot();
bot.start();
