import { Spot } from "@binance/connector";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { TelegramNotifier } from "./notifier.js";
import { TelegramCommands } from "./telegram-commands.js";
import { computeRealizedPnl } from "./pnl.js";
dotenv.config();
// Tasa de referencia COP por USDT (P2P Colombia aprox.)
const COP_PER_USDT = 4200;
const WATCHLIST = ["SOLUSDT", "ETHUSDT", "BTCUSDT", "XRPUSDT", "BNBUSDT"];
// PARÁMETROS DEL TRAILING TAKE PROFIT INTELIGENTE
const TRAILING_ACTIVATION_PCT = 0.8; // Despierta el seguro al +0.8%
const TRAILING_CALLBACK_PCT = 0.25; // Vende si retrocede 0.25% desde el pico
const TRAILING_HARD_CAP_PCT = 3.5; // Venta automática si toca +3.5%
// PARÁMETROS DEL TRAILING BUY (espejo del trailing de venta, para cazar el piso)
const TRAILING_BUY_BOUNCE_PCT = 0.25; // Compra cuando rebota +0.25% desde el piso más bajo
const TRAILING_BUY_MAX_AGE_MS = 3 * 60 * 60 * 1000; // Vigilancia máxima: 3 horas
export class TrailingMasterBot {
    client;
    notifier;
    telegramCommands;
    isProcessing = false;
    autoPilot = true;
    minUsdtToTrade = 10;
    activeTrailingPositions = new Map();
    buyWatches = new Map();
    constructor() {
        this.client = new Spot(process.env.BINANCE_API_KEY, process.env.BINANCE_API_SECRET, { recvWindow: 60000 });
        this.notifier = new TelegramNotifier();
        this.telegramCommands = new TelegramCommands((cmd) => this.handleTelegramCommand(cmd));
        this.loadTrailingPositions();
        this.loadBuyWatches();
    }
    saveBuyWatches() {
        try {
            fs.writeFileSync(path.resolve(process.cwd(), ".trailing-buys.json"), JSON.stringify(Array.from(this.buyWatches.entries()), null, 2));
        }
        catch (e) {
            console.error("Error guardando trailing buys:", e.message);
        }
    }
    loadBuyWatches() {
        try {
            const file = path.resolve(process.cwd(), ".trailing-buys.json");
            if (fs.existsSync(file)) {
                this.buyWatches = new Map(JSON.parse(fs.readFileSync(file, "utf-8")));
                console.log(`📂 Cargadas ${this.buyWatches.size} vigilancias de Trailing Buy desde disco.`);
            }
        }
        catch (e) {
            console.error("Error cargando trailing buys:", e.message);
        }
    }
    saveTrailingPositions() {
        try {
            const data = Array.from(this.activeTrailingPositions.entries());
            fs.writeFileSync(path.resolve(process.cwd(), ".trailing-positions.json"), JSON.stringify(data, null, 2));
        }
        catch (e) {
            console.error("Error guardando trailing positions:", e.message);
        }
    }
    loadTrailingPositions() {
        try {
            const file = path.resolve(process.cwd(), ".trailing-positions.json");
            if (fs.existsSync(file)) {
                const data = JSON.parse(fs.readFileSync(file, "utf-8"));
                this.activeTrailingPositions = new Map(data);
                console.log(`📂 Cargadas ${this.activeTrailingPositions.size} posiciones de Trailing desde disco.`);
            }
        }
        catch (e) {
            console.error("Error cargando trailing positions:", e.message);
        }
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
                    console.log(`🎯 Trailing activado en ${symbol} a ${curPrice} (+${gainPct.toFixed(2)}%)`);
                    this.saveTrailingPositions();
                }
                // 2. Si el precio marca un nuevo pico, actualizamos el techo
                if (pos.activated && curPrice > pos.highestPrice) {
                    const oldPeak = pos.highestPrice;
                    pos.highestPrice = curPrice;
                    console.log(`📈 Nuevo pico en ${symbol}: ${curPrice} (+${gainPct.toFixed(2)}%)`);
                    this.saveTrailingPositions();
                    // Si el pico subió al menos un 0.12%, avisar a Telegram
                    const jumpPct = ((curPrice - oldPeak) / oldPeak) * 100;
                    if (jumpPct >= 0.12) {
                        const stopPrice = curPrice * (1 - TRAILING_CALLBACK_PCT / 100);
                        const minLockedGain = ((stopPrice - pos.buyPrice) / pos.buyPrice) * 100;
                        const peakAlert = `📈 <b>¡NUEVO PICO ALCANZADO: ${symbol}!</b> 🚀\n\n` +
                            `• <b>Nuevo techo:</b> ${curPrice.toFixed(4)} (<b>+${gainPct.toFixed(2)}%</b>)\n` +
                            `• 🛡️ <b>Nuevo piso de venta garantizado:</b> ${stopPrice.toFixed(4)}\n` +
                            `• 💵 <b>Ganancia amarrada:</b> +${minLockedGain.toFixed(2)}% NETO\n\n` +
                            `🏹 <i>El bot sigue persiguiendo la cima hacia arriba...</i>`;
                        await this.notifier.send(peakAlert);
                    }
                }
                // 3. Evaluar Salida por Retroceso (Callback) desde el pico más alto
                if (pos.activated) {
                    const dropFromPeak = ((pos.highestPrice - curPrice) / pos.highestPrice) * 100;
                    const hitHardCap = gainPct >= TRAILING_HARD_CAP_PCT;
                    const hitCallback = dropFromPeak >= TRAILING_CALLBACK_PCT && gainPct >= 0.6;
                    if (hitCallback || hitHardCap) {
                        console.log(`🏆 ¡CERRANDO EN LA CIMA! Venta Trailing en ${symbol} a $${curPrice} (Pico: $${pos.highestPrice})`);
                        const sold = await this.executeTrailingSell(pos, curPrice, hitHardCap);
                        // Solo se elimina la posición si Binance confirmó la venta
                        if (sold) {
                            this.activeTrailingPositions.delete(symbol);
                            this.saveTrailingPositions();
                        }
                    }
                }
            }
            catch (e) {
                console.error(`Error monitoreando trailing en ${symbol}:`, e.message);
            }
        }
    }
    /**
     * Si Binance barrió el saldo a Simple Earn (Auto-Subscribe), lo rescata a Spot.
     */
    async redeemFromEarnIfNeeded(asset, needed) {
        try {
            const res = await this.client.getFlexibleProductPosition({ asset, recvWindow: 60000 });
            const row = res.data?.rows?.[0];
            if (!row || parseFloat(row.totalAmount) <= 0)
                return;
            console.log(`🏦 Rescatando ${asset} desde Simple Earn (${row.totalAmount}) para poder vender...`);
            await this.client.redeemFlexibleProduct(row.productId, { redeemAll: true, destAccount: "SPOT", recvWindow: 60000 });
            await new Promise((r) => setTimeout(r, 3000));
            await this.notifier.send(`🏦 <i>Rescaté ${row.totalAmount} ${asset} de Simple Earn a Spot (Binance lo había movido con Auto-Subscribe).</i>`);
        }
        catch (e) {
            console.error(`Error rescatando ${asset} de Earn:`, e.response?.data?.msg || e.message);
        }
    }
    async getFreeBalance(asset) {
        const acc = await this.client.account({ recvWindow: 60000 });
        return parseFloat(acc.data.balances.find((b) => b.asset === asset)?.free || "0");
    }
    /** Suma comisiones de los fills de una orden convertidas a USDT */
    feesToUsdt(fills, baseAsset) {
        let fee = 0;
        for (const f of fills || []) {
            const c = parseFloat(f.commission);
            if (f.commissionAsset === "USDT")
                fee += c;
            else if (f.commissionAsset === baseAsset)
                fee += c * parseFloat(f.price);
        }
        return fee;
    }
    async executeTrailingSell(pos, exitPrice, hitHardCap) {
        try {
            const asset = pos.symbol.replace("USDT", "");
            let freeBal = await this.getFreeBalance(asset);
            // Si falta saldo (barrido a Earn), rescatarlo antes de vender
            if (freeBal < pos.qty * 0.98) {
                await this.redeemFromEarnIfNeeded(asset, pos.qty);
                freeBal = await this.getFreeBalance(asset);
            }
            // Vender solo la cantidad de esta posición (no tocar otros saldos)
            const sellBase = Math.min(freeBal, pos.qty);
            const exInfo = await this.client.exchangeInfo({ symbol: pos.symbol });
            const sInfo = exInfo.data.symbols[0];
            const stepSize = parseFloat(sInfo.filters.find((f) => f.filterType === "LOT_SIZE").stepSize);
            const qtyDec = Math.max(0, Math.round(-Math.log10(stepSize)));
            const sellQty = Math.floor(sellBase / stepSize) * stepSize;
            const sellQtyStr = sellQty.toFixed(qtyDec);
            if (sellQty <= 0) {
                console.error(`❌ Sin saldo libre de ${asset} para vender la posición.`);
                return false;
            }
            const sellRes = await this.client.newOrder(pos.symbol, "SELL", "MARKET", {
                quantity: sellQtyStr,
                newOrderRespType: "FULL",
                recvWindow: 60000
            });
            const grossUsdt = parseFloat(sellRes.data.cummulativeQuoteQty);
            const sellFee = this.feesToUsdt(sellRes.data.fills, asset);
            const avgSell = grossUsdt / parseFloat(sellRes.data.executedQty);
            const costBasis = pos.investedUsdt * (sellQty / pos.qty);
            const profitUsdt = grossUsdt - sellFee - costBasis;
            const netPct = (profitUsdt / costBasis) * 100;
            const sign = profitUsdt >= 0 ? "+" : "";
            const alertMsg = `🏆 <b>¡GANANCIA COBRADA CON TRAILING TAKE PROFIT!</b> 🎉\n\n` +
                `• <b>Moneda:</b> ${pos.symbol}\n` +
                `• <b>Precio de compra:</b> $${pos.buyPrice.toFixed(4)}\n` +
                `• <b>Pico alcanzado:</b> $${pos.highestPrice.toFixed(4)}\n` +
                `• <b>Precio de venta:</b> $${avgSell.toFixed(4)}\n` +
                `• <b>Comisiones:</b> ${sellFee.toFixed(4)} USDT\n` +
                `• 💵 <b>Ganancia líquida:</b> ${profitUsdt >= 0 ? "🟢" : "🔴"} <b>${sign}${profitUsdt.toFixed(3)} USDT</b> (<b>${sign}${netPct.toFixed(2)}% NETO</b>) ≈ ${sign}$${Math.round(profitUsdt * COP_PER_USDT).toLocaleString("es-CO")} COP\n\n` +
                `🛡️ <i>${hitHardCap ? "Meta máxima de +3.5% alcanzada." : "Venta óptima capturada en la cima del rebote."}</i>\n` +
                `📊 <i>Escribe /reporte para ver el acumulado real.</i>`;
            await this.notifier.send(alertMsg);
            console.log(alertMsg.replace(/<\/?b>/g, "").replace(/<\/?i>/g, ""));
            return true;
        }
        catch (e) {
            const msg = e.response?.data?.msg || e.message;
            console.error("Error ejecutando venta trailing:", msg);
            await this.notifier.send(`⚠️ <i>No se pudo vender ${pos.symbol}: ${msg}. La posición sigue protegida y se reintentará.</i>`);
            return false;
        }
    }
    /**
     * Compra una moneda e inicia el rastreo con Trailing Take Profit
     */
    async executeSmartBuy(symbol, usdtAmount, source) {
        try {
            const investStr = (usdtAmount - 0.15).toFixed(2);
            console.log(`🚀 [${source}] Ejecutando compra de ${investStr} USDT en ${symbol} con Trailing Stop...`);
            const buyRes = await this.client.newOrder(symbol, "BUY", "MARKET", {
                quoteOrderQty: investStr,
                newOrderRespType: "FULL",
                recvWindow: 60000
            });
            const asset = symbol.replace("USDT", "");
            const spent = parseFloat(buyRes.data.cummulativeQuoteQty);
            const grossQty = parseFloat(buyRes.data.executedQty);
            // Si la comisión se cobró en la moneda comprada, la cantidad real es menor
            let feeInBase = 0;
            for (const f of buyRes.data.fills || []) {
                if (f.commissionAsset === asset)
                    feeInBase += parseFloat(f.commission);
            }
            const qty = grossQty - feeInBase;
            const buyPrice = spent / grossQty;
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
            this.saveTrailingPositions();
            const target08 = (buyPrice * 1.008).toFixed(4);
            const alertMsg = `🦅 <b>¡NUEVA COMPRA INTELIGENTE CON TRAILING!</b> 🚀\n\n` +
                `• <b>Moneda:</b> ${symbol}\n` +
                `• <b>Origen:</b> ${source}\n` +
                `• <b>Inversión:</b> ${spent.toFixed(2)} USDT\n` +
                `• <b>Precio de entrada:</b> ${buyPrice.toFixed(4)}\n` +
                `• 🎯 <b>Gatillo Trailing:</b> ${target08} (+0.8%)\n\n` +
                `🛡️ <i>En cuanto suba al +0.8%, el bot asegura la ganancia y persigue el pico para exprimir el máximo beneficio.</i>`;
            await this.notifier.send(alertMsg);
            console.log(alertMsg.replace(/<\/?b>/g, "").replace(/<\/?i>/g, ""));
            return true;
        }
        catch (e) {
            const msg = e.response?.data?.msg || e.message;
            console.error(`❌ Error ejecutando compra en ${symbol}:`, msg);
            await this.notifier.send(`⚠️ <i>No se pudo comprar ${symbol}: ${msg}</i>`);
            return false;
        }
    }
    /**
     * TRAILING BUY - Paso 1: detectar caídas y "armar" la vigilancia del piso.
     * Ya no compra en la primera vela verde: registra el precio y rastrea el piso más bajo.
     */
    async scanForDips(activeSymbols) {
        for (const sym of WATCHLIST) {
            try {
                if (activeSymbols.has(sym) || this.activeTrailingPositions.has(sym) || this.buyWatches.has(sym)) {
                    continue; // No acumular en la misma moneda ni duplicar vigilancias
                }
                const klinesRes = await this.client.klines(sym, "15m", { limit: 35 });
                const data = klinesRes.data;
                const closes = data.map((k) => parseFloat(k[4]));
                const highs = data.map((k) => parseFloat(k[2]));
                const rsi = this.calculateRSI(closes, 14);
                const curPrice = closes[closes.length - 1];
                const maxRecent = Math.max(...highs.slice(-20));
                const dropPct = ((maxRecent - curPrice) / maxRecent) * 100;
                // Mismas condiciones de caída que antes, pero SIN exigir vela verde:
                // el rebote ahora lo confirma el Trailing Buy (+0.25% desde el piso exacto).
                const isDip = (dropPct >= 1.5 && rsi <= 58) ||
                    (rsi <= 48 && dropPct >= 0.8) ||
                    (rsi <= 40);
                if (isDip) {
                    this.buyWatches.set(sym, { symbol: sym, armedPrice: curPrice, lowestPrice: curPrice, armedTime: Date.now(), rsi, dropPct });
                    this.saveBuyWatches();
                    const trigger = curPrice * (1 + TRAILING_BUY_BOUNCE_PCT / 100);
                    console.log(`🎯 Trailing Buy ARMADO en ${sym} a ${curPrice} (RSI ${rsi.toFixed(1)} | Caída ${dropPct.toFixed(2)}%)`);
                    await this.notifier.send(`🎯 <b>[TRAILING BUY ARMADO: ${sym}]</b>\n\n` +
                        `• Caída detectada: <b>-${dropPct.toFixed(2)}%</b> (RSI ${rsi.toFixed(1)})\n` +
                        `• Precio actual: ${curPrice}\n` +
                        `• 🔻 El bot ahora persigue el <b>piso más bajo</b> tick a tick.\n` +
                        `• ✅ Comprará cuando rebote <b>+${TRAILING_BUY_BOUNCE_PCT}%</b> desde el piso (hoy: ${trigger.toFixed(4)}).`);
                }
            }
            catch (e) { }
        }
    }
    /**
     * TRAILING BUY - Paso 2: seguir el piso y comprar en el rebote confirmado.
     * Devuelve true si ejecutó una compra.
     */
    async checkBuyWatches(usdt) {
        for (const [sym, w] of this.buyWatches.entries()) {
            try {
                if (this.activeTrailingPositions.has(sym)) {
                    this.buyWatches.delete(sym);
                    this.saveBuyWatches();
                    continue;
                }
                if (Date.now() - w.armedTime > TRAILING_BUY_MAX_AGE_MS) {
                    console.log(`⌛ Trailing Buy en ${sym} expiró sin rebote. Se desarma.`);
                    this.buyWatches.delete(sym);
                    this.saveBuyWatches();
                    continue;
                }
                const cur = parseFloat((await this.client.tickerPrice(sym)).data.price);
                if (cur < w.lowestPrice) {
                    w.lowestPrice = cur;
                    this.saveBuyWatches();
                    console.log(`🔻 Nuevo piso en ${sym}: ${cur} (${(((cur - w.armedPrice) / w.armedPrice) * 100).toFixed(2)}% desde que se armó)`);
                    continue;
                }
                const bounce = ((cur - w.lowestPrice) / w.lowestPrice) * 100;
                if (bounce >= TRAILING_BUY_BOUNCE_PCT && usdt >= this.minUsdtToTrade) {
                    // Tamaño de compra para capital ampliado (~$150 USDT):
                    // Prioriza compras fuertes de ~$100 USDT para maximizar ganancias (+$1.20 a +$2.00 por venta)
                    let amountToUse = usdt;
                    if (usdt >= 120) {
                        amountToUse = 100;
                    }
                    else if (usdt >= 90) {
                        amountToUse = Math.min(usdt, 100);
                    }
                    else if (usdt >= 50 && this.activeTrailingPositions.size === 0) {
                        amountToUse = Math.floor((usdt / 2) * 100) / 100;
                    }
                    const saved = ((w.armedPrice - w.lowestPrice) / w.armedPrice) * 100;
                    console.log(`✅ Rebote confirmado en ${sym}: piso ${w.lowestPrice} → ${cur} (+${bounce.toFixed(2)}%). Comprando ${amountToUse} USDT...`);
                    const ok = await this.executeSmartBuy(sym, amountToUse, `Trailing Buy (piso ${w.lowestPrice}, ${saved.toFixed(2)}% más barato que al armar)`);
                    if (ok) {
                        this.buyWatches.delete(sym);
                        this.saveBuyWatches();
                        return true;
                    }
                }
            }
            catch (e) {
                console.error(`Error en Trailing Buy ${sym}:`, e.message);
            }
        }
        return false;
    }
    async handleTelegramCommand(rawCmd) {
        try {
            const parts = rawCmd.trim().split(/\s+/);
            const cmd = parts[0].toLowerCase();
            const arg1 = parts[1]?.toUpperCase();
            const arg2 = parts[2];
            if (cmd === "/menu" || cmd === "menu" || cmd === "/start") {
                return `📱 <b>CENTRO DE COMANDOS CON TRAILING STOP</b>\n\n` +
                    `• /informe - Diagnóstico completo en tiempo real\n` +
                    `• /trailing - Posiciones activas rastreando el pico\n` +
                    `• /cazando - Trailing Buy: monedas cazando el piso\n` +
                    `• /reporte - Ganancias reales acumuladas (desde Binance)\n` +
                    `• /estado - Órdenes vivas y progreso hacia la meta\n` +
                    `• /radar - Escáner de suelos en tiempo real\n` +
                    `• /balance - Saldos libres y bloqueados en Binance\n` +
                    `• /motores - Estrategias y parámetros activos\n` +
                    `• /comprar eth [monto] - Comprar moneda con trailing stop\n` +
                    `• /vender sol - Vender moneda al mercado (emergencia)\n` +
                    `• /modo auto | /modo manual - Piloto autónomo o manual\n` +
                    `• /pausa y /reanudar\n\n` +
                    `💡 <i>Toca cualquiera de los enlaces azules para ejecutar.</i>`;
            }
            if (cmd === "/cazando" || cmd === "cazando") {
                return await this.buildBuyWatchReport();
            }
            if (cmd === "/informe" || cmd === "informe" || cmd === "/trailing" || cmd === "trailing") {
                const acc = await this.client.account({ recvWindow: 60000 });
                const usdt = parseFloat(acc.data.balances.find((b) => b.asset === "USDT")?.free || "0");
                let rep = `📑 <b>INFORME Y DIAGNÓSTICO EN TIEMPO REAL</b> 📊\n\n`;
                rep += `• 💼 <b>USDT Líquido:</b> ${usdt.toFixed(2)} USDT\n`;
                rep += `• 🤖 <b>Modo Centinela:</b> ${this.autoPilot ? "🟢 Autónomo Cazador (+0.8% Trailing)" : "🟡 Manual Asistido"}\n\n`;
                if (this.activeTrailingPositions.size === 0) {
                    rep += `📡 <b>ESTADO ACTUAL:</b> Sin posiciones abiertas (Trailing).\n` +
                        `🔍 El bot está escaneando el radar en busca de la próxima caída para disparar la compra con descuento.\n\n`;
                }
                else {
                    rep += `🏹 <b>POSICIONES ACTIVAS CON TRAILING:</b>\n\n`;
                    for (const [sym, p] of this.activeTrailingPositions.entries()) {
                        let cur = p.buyPrice;
                        try {
                            const t = await this.client.tickerPrice(sym);
                            cur = parseFloat(t.data.price);
                        }
                        catch (e) { }
                        const curGain = (((cur - p.buyPrice) / p.buyPrice) * 100);
                        const peakGain = (((p.highestPrice - p.buyPrice) / p.buyPrice) * 100);
                        const stopPrice = p.highestPrice * (1 - TRAILING_CALLBACK_PCT / 100);
                        const distToStop = Math.abs(cur - stopPrice);
                        const target08 = p.buyPrice * 1.008;
                        rep += `🪙 <b>${sym}</b> (${p.qty} ${sym.replace("USDT", "")})\n` +
                            `• Inversión: ${p.investedUsdt.toFixed(2)} USDT\n` +
                            `• Entrada: ${p.buyPrice.toFixed(4)}\n` +
                            `• Precio Actual: ${cur.toFixed(4)} (${curGain >= 0 ? "🟢 +" : "🔴 "}${curGain.toFixed(2)}%)\n` +
                            `• Pico Más Alto: ${p.highestPrice.toFixed(4)} (+${peakGain.toFixed(2)}%)\n`;
                        if (p.activated) {
                            rep += `• 🛡️ <b>Gatillo de Salida:</b> ${stopPrice.toFixed(4)} (a solo ${distToStop.toFixed(2)} de distancia)\n` +
                                `• Estado: 🟢 <b>SEGURO ACTIVADO (Cazando la cima)</b>\n\n`;
                        }
                        else {
                            const falta08 = (((target08 - cur) / cur) * 100);
                            rep += `• 🎯 <b>Meta para Activar Seguro:</b> ${target08.toFixed(4)} (falta: +${falta08.toFixed(2)}%)\n` +
                                `• Estado: ⏳ <b>Avanzando hacia el +0.8%</b>\n\n`;
                        }
                    }
                }
                if (this.buyWatches.size > 0) {
                    rep += `🔻 <b>TRAILING BUY:</b> ${this.buyWatches.size} moneda(s) cazando el piso (ver /cazando)\n\n`;
                }
                try {
                    const s = await computeRealizedPnl(this.client);
                    const sign = s.totalPnl >= 0 ? "+" : "";
                    rep += `💰 <b>GANANCIA TOTAL ACUMULADA (real Binance):</b> ${s.totalPnl >= 0 ? "🟢" : "🔴"} <b>${sign}${s.totalPnl.toFixed(3)} USDT netos</b> ` +
                        `≈ ${sign}$${Math.round(s.totalPnl * COP_PER_USDT).toLocaleString("es-CO")} COP\n` +
                        `(${s.cycles.length} ciclos cerrados: ${s.wins} ganados, ${s.losses} perdidos)\n\n`;
                }
                catch (e) {
                    rep += `💰 <i>No se pudo calcular el acumulado: ${e.message}</i>\n\n`;
                }
                rep += `💡 <i>Escribe /reporte para el detalle por ciclo o /menu para más opciones.</i>`;
                return rep;
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
                txt += `• 🔻 <b>Trailing Buy:</b> ${this.buyWatches.size} moneda(s) cazando el piso\n`;
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
                        else if (this.buyWatches.has(sym)) {
                            status = ` 🔻 [Cazando piso: ${this.buyWatches.get(sym).lowestPrice}]`;
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
                report += `🏹 <b>Estrategia:</b> Trailing Buy (+${TRAILING_BUY_BOUNCE_PCT}% desde el piso) + Trailing Take Profit (+0.8% y persigue la subida)\n`;
                return report;
            }
            if (cmd === "/motores" || cmd === "motores") {
                return `⚙️ <b>CONFIGURACIÓN DE MOTORES Y TRAILING</b>\n\n` +
                    `🔻 <b>Motor Trailing Buy (ACTIVO):</b>\n` +
                    `• <b>Detección:</b> Caída ≥ 1.5% con RSI ≤ 58 (o RSI ≤ 48 con caída ≥ 0.8%, o RSI ≤ 40).\n` +
                    `• <b>Persecución del piso:</b> Registra el precio más bajo tick a tick (cada 7s).\n` +
                    `• <b>Compra:</b> Cuando rebota +${TRAILING_BUY_BOUNCE_PCT}% desde el piso.\n` +
                    `• <b>Expiración:</b> ${TRAILING_BUY_MAX_AGE_MS / 3600000}h sin rebote.\n\n` +
                    `🏹 <b>Motor Trailing Take Profit (ACTIVO):</b>\n` +
                    `• <b>Gatillo de activación:</b> +${TRAILING_ACTIVATION_PCT}% (Asegura ganancia rápida).\n` +
                    `• <b>Persecución de pico:</b> Sube el piso de venta detrás del precio sin límite.\n` +
                    `• <b>Cierre óptimo:</b> Vende si retrocede ${TRAILING_CALLBACK_PCT}% desde su pico.\n` +
                    `• <b>Techo máximo:</b> +${TRAILING_HARD_CAP_PCT}% (Toma de ganancias automática).\n` +
                    `• <b>Nunca vende en pérdida.</b>\n\n` +
                    `💰 <b>Capital:</b> 2 ranuras en paralelo (divide el USDT si hay ≥ $30).\n` +
                    `🛡️ <b>Diversificación:</b> No compra monedas donde ya tengamos posiciones u órdenes vivas.\n` +
                    `📋 <b>Watchlist:</b> ${WATCHLIST.join(", ")}\n` +
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
                const s = await computeRealizedPnl(this.client);
                let txt = `📊 <b>REPORTE DE GANANCIAS REALES (PnL)</b>\n<i>Calculado desde el historial de Binance, comisiones incluidas.</i>\n\n`;
                if (s.cycles.length === 0) {
                    txt += "• Aún no hay ciclos cerrados.\n";
                }
                s.cycles.forEach((c, i) => {
                    const d = new Date(c.time).toLocaleString("es-CO", { timeZone: "America/Bogota", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
                    const sign = c.pnlUsdt >= 0 ? "+" : "";
                    txt += `${c.pnlUsdt >= 0 ? "🟢" : "🔴"} <b>${i + 1}. ${c.symbol.replace("USDT", "")}</b> (${d}) ${c.avgBuy.toFixed(4)} ➔ ${c.avgSell.toFixed(4)} | <b>${sign}${c.pnlUsdt.toFixed(3)} USDT</b> (${sign}${c.pnlPct.toFixed(2)}%)\n`;
                });
                const sign = s.totalPnl >= 0 ? "+" : "";
                txt += `\n📈 <b>Por moneda:</b>\n`;
                for (const [sym, v] of Object.entries(s.bySymbol)) {
                    txt += `• ${sym.replace("USDT", "")}: ${v.pnl >= 0 ? "+" : ""}${v.pnl.toFixed(3)} USDT (${v.cycles} ciclos)\n`;
                }
                txt += `\n💵 <b>Ganancia Líquida Cerrada:</b> ${s.totalPnl >= 0 ? "🟢" : "🔴"} <b>${sign}${s.totalPnl.toFixed(3)} USDT</b> ≈ <b>${sign}$${Math.round(s.totalPnl * COP_PER_USDT).toLocaleString("es-CO")} COP</b>\n` +
                    `🏆 <b>Efectividad:</b> ${s.wins}/${s.cycles.length} ciclos ganados\n` +
                    `💸 <b>Comisiones pagadas en ventas:</b> ${s.totalFees.toFixed(3)} USDT\n` +
                    `🏹 <b>Posiciones abiertas:</b> ${this.activeTrailingPositions.size} | 🔻 <b>Cazando piso:</b> ${this.buyWatches.size}\n` +
                    `<i>COP aprox. a ${COP_PER_USDT.toLocaleString("es-CO")} por USDT (P2P).</i>`;
                return txt;
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
                const ok = await this.executeSmartBuy(symbol, amountToUse, "Manual por Chat");
                if (!ok)
                    return `❌ No se pudo comprar ${symbol}. Revisa el mensaje de error anterior.`;
                this.buyWatches.delete(symbol);
                this.saveBuyWatches();
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
                this.saveTrailingPositions();
                this.buyWatches.delete(symbol);
                this.saveBuyWatches();
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
            console.log(`[${time}] Monitoreo... USDT libre: $${usdt.toFixed(2)} | Órdenes Binance: ${sellOrders.length} | Trailing activos: ${this.activeTrailingPositions.size} | Cazando piso: ${this.buyWatches.size}`);
            // 2. Si hay saldo libre y ranuras: Trailing Buy (detectar caída -> seguir piso -> comprar en rebote)
            if (this.autoPilot && usdt >= this.minUsdtToTrade && this.activeTrailingPositions.size < 3) {
                await this.scanForDips(activeSymbols);
                if (this.buyWatches.size > 0) {
                    await this.checkBuyWatches(usdt);
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
    async buildBuyWatchReport() {
        let txt = `🔻 <b>TRAILING BUY - CAZANDO EL PISO</b>\n\n`;
        if (this.buyWatches.size === 0) {
            txt += `• Ninguna moneda en vigilancia ahora mismo.\n` +
                `• En cuanto una caiga ≥ 1.5% (o RSI bajo), el bot la arma y empieza a seguir su piso.\n`;
            return txt;
        }
        for (const [sym, w] of this.buyWatches.entries()) {
            let cur = w.lowestPrice;
            try {
                cur = parseFloat((await this.client.tickerPrice(sym)).data.price);
            }
            catch { }
            const trigger = w.lowestPrice * (1 + TRAILING_BUY_BOUNCE_PCT / 100);
            const fromArmed = ((w.lowestPrice - w.armedPrice) / w.armedPrice) * 100;
            const mins = Math.round((Date.now() - w.armedTime) / 60000);
            txt += `🪙 <b>${sym}</b> (armado hace ${mins} min)\n` +
                `• Precio al armar: ${w.armedPrice} (caída -${w.dropPct.toFixed(2)}%, RSI ${w.rsi.toFixed(1)})\n` +
                `• 🔻 Piso más bajo: <b>${w.lowestPrice}</b> (${fromArmed.toFixed(2)}%)\n` +
                `• Precio actual: ${cur}\n` +
                `• ✅ Compra si toca: <b>${trigger.toFixed(4)}</b> (+${TRAILING_BUY_BOUNCE_PCT}% desde el piso)\n\n`;
        }
        return txt;
    }
    async start() {
        console.log(`\n======================================================`);
        console.log(`🏛️ BOT DE TRADING CON TRAILING TAKE PROFIT INTELIGENTE`);
        console.log(`🎯 Trailing Buy: +${TRAILING_BUY_BOUNCE_PCT}% desde el piso | Trailing TP: +${TRAILING_ACTIVATION_PCT}% / callback ${TRAILING_CALLBACK_PCT}%`);
        console.log(`======================================================\n`);
        await this.telegramCommands.start();
        console.log(`📱 Telegram listo para recibir órdenes por chat.`);
        await this.runCycle();
        setInterval(() => this.runCycle(), 7000);
    }
}
// BOT_NO_AUTOSTART=1 permite importar la clase para pruebas sin arrancar el bot
if (process.env.BOT_NO_AUTOSTART !== "1") {
    const bot = new TrailingMasterBot();
    bot.start();
}
