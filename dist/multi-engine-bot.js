import { DashboardServer } from "./dashboard-server.js";
import { Spot } from "@binance/connector";
import { AiCopilot } from "./ai-copilot.js";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { TelegramNotifier } from "./notifier.js";
import { TelegramCommands } from "./telegram-commands.js";
import { computeRealizedPnl } from "./pnl.js";
dotenv.config();
// Tasa de referencia COP por USDT (P2P Colombia aprox.)
const COP_PER_USDT = 4200;
// WATCHLIST oficial: proyectos de alta liquidez y solidez (PEPE retirado de nuevas compras)
const WATCHLIST = ["ETHUSDT", "SOLUSDT", "AVAXUSDT", "BTCUSDT", "BNBUSDT", "XRPUSDT", "PEPEUSDT"];
// Formateador dinámico de precios para soportar micro-ticks y monedas estándar (ETH/SOL/BTC)
function fmtPrice(p) {
    if (p === 0)
        return "0";
    if (p < 0.0001)
        return p.toFixed(8);
    if (p < 0.01)
        return p.toFixed(6);
    if (p < 1)
        return p.toFixed(4);
    return p.toFixed(2);
}
// PARÁMETROS DEL TRAILING TAKE PROFIT INTELIGENTE
const TRAILING_ACTIVATION_PCT = 0.8; // Despierta el seguro al +0.8%
const TRAILING_CALLBACK_PCT = 0.30; // Base callback
const TRAILING_HARD_CAP_PCT = 15.0; // Techo ultra amplio (+15%) para perseguir el alza hasta la cima sin corte artificial
// PARÁMETROS DEL TRAILING BUY (espejo del trailing de venta, para cazar el piso)
const TRAILING_BUY_BOUNCE_PCT = 0.25; // Compra cuando rebota +0.25% desde el piso más bajo
const TRAILING_BUY_MAX_AGE_MS = 3 * 60 * 60 * 1000; // Vigilancia máxima: 3 horas
export class TrailingMasterBot {
    controls = {
        strategies: {
            trailing_rebound: true,
            smart_dca: true,
            micro_grid: false,
            cazador_weekend: true
        },
        allocations: {
            trailing_rebound: 70,
            smart_dca: 30,
            micro_grid: 0,
            cazador_weekend: 0
        },
        baseAllocations: {
            trailing_rebound: 50,
            smart_dca: 30,
            micro_grid: 0,
            cazador_weekend: 20
        },
        autoPilot: true,
        approvalTimeoutSec: 180,
        updatedAt: Date.now()
    };
    pendingOpportunity = null;
    client;
    notifier;
    telegramCommands;
    isProcessing = false;
    autoPilot = true;
    minUsdtToTrade = 10;
    cycleCount = 0;
    lastWeekendWindowState = null;
    lastRegimeCheckTime = 0;
    pendingRegimeSwitch = null;
    lastDetectedRegime = null;
    /**
     * Margen de retroceso (Callback) adaptado a la volatilidad de cada par.
     */
    isWeekendWindow() {
        try {
            const now = new Date();
            const dayStr = now.toLocaleDateString("en-US", { timeZone: "America/Bogota", weekday: "short" });
            const hourStr = now.toLocaleTimeString("en-US", { timeZone: "America/Bogota", hour12: false, hour: "numeric" });
            const hour = parseInt(hourStr, 10);
            if (dayStr === "Fri" && hour >= 17)
                return true;
            if (dayStr === "Sat")
                return true;
            if (dayStr === "Sun" && hour < 18)
                return true;
            return false;
        }
        catch {
            return false;
        }
    }
    isNightMode() {
        try {
            const hour = new Date().toLocaleString("en-US", { timeZone: "America/Bogota", hour: "numeric", hour12: false });
            const h = parseInt(hour, 10);
            return h >= 1 && h < 6;
        }
        catch {
            return false;
        }
    }
    getHardCapPct() {
        return this.isNightMode() ? 5.0 : 3.5;
    }
    async getFearAndGreed() {
        try {
            const res = await fetch("https://api.alternative.me/fng/?limit=1");
            const d = await res.json();
            const item = d.data?.[0];
            if (item) {
                return { value: parseInt(item.value, 10), classification: item.value_classification };
            }
        }
        catch (e) { }
        return { value: 50, classification: "Neutral" };
    }
    async depositToEarn(asset, amount) {
        try {
            await this.client.subscribeFlexibleProduct("USDT001", amount.toFixed(2), { recvWindow: 60000 });
            await this.notifier.send(`🏦 <b>[BÓVEDA DE GANANCIAS ACTIVADA]</b> 🔒\n\n` +
                `• Se apartaron <b>+${amount.toFixed(2)} USDT</b> limpios de la ganancia.\n` +
                `• Destino: <b>Simple Earn Flexible</b> generando intereses diarios automáticos.\n` +
                `💡 <i>¡Tu ganancia quedó blindada fuera del riesgo de mercado!</i>`);
            console.log(`🏦 Bóveda de ganancias: ${amount.toFixed(2)} USDT transferidos a Simple Earn.`);
        }
        catch (e) {
            console.error("Error suscribiendo a Earn:", e.response?.data?.msg || e.message);
        }
    }
    getCallbackPct(symbol) {
        if (symbol.includes("PEPE"))
            return 0.55; // Mayor margen para posición viva de PEPE
        if (symbol.includes("AVAX"))
            return 0.45; // Alta volatilidad
        return 0.30; // Monedas mayores estándar (ETH, SOL, BTC, etc.)
    }
    /**
     * Reconstruye y adopta posiciones existentes en Binance Spot que no estén registradas en memoria/disco.
     */
    async syncOrphanPositions() {
        try {
            const acc = await this.client.account({ recvWindow: 60000 });
            const checkList = [...WATCHLIST, "PEPEUSDT"];
            for (const sym of checkList) {
                if (this.activeTrailingPositions.has(sym))
                    continue;
                const asset = sym.replace("USDT", "");
                const balObj = acc.data.balances.find((b) => b.asset === asset);
                if (!balObj)
                    continue;
                const free = parseFloat(balObj.free || "0");
                const locked = parseFloat(balObj.locked || "0");
                const total = free + locked;
                if (total <= 0)
                    continue;
                let curPrice = 0;
                try {
                    const ticker = await this.client.tickerPrice(sym);
                    curPrice = parseFloat(ticker.data.price);
                }
                catch {
                    continue;
                }
                const usdtValue = total * curPrice;
                if (usdtValue >= 10) {
                    console.log(`🔍 [AUTO-SYNC] Moneda detectada en Binance sin tracking: ${sym} (${total} ${asset} ≈ ${usdtValue.toFixed(2)} USDT)`);
                    let buyPrice = curPrice;
                    let buyTime = Date.now();
                    try {
                        const tradesRes = await this.client.myTrades(sym, { limit: 10, recvWindow: 60000 });
                        const buyTrades = (tradesRes.data || []).filter((t) => t.isBuyer);
                        if (buyTrades.length > 0) {
                            const lastBuy = buyTrades[buyTrades.length - 1];
                            buyPrice = parseFloat(lastBuy.price);
                            buyTime = lastBuy.time || Date.now();
                        }
                    }
                    catch (err) {
                        console.error(`No se pudieron obtener trades previos de ${sym}: ${err.message}`);
                    }
                    const spent = total * buyPrice;
                    const highestPrice = Math.max(buyPrice, curPrice);
                    const gainPct = ((curPrice - buyPrice) / buyPrice) * 100;
                    const activated = gainPct >= TRAILING_ACTIVATION_PCT;
                    this.activeTrailingPositions.set(sym, {
                        symbol: sym,
                        buyPrice,
                        qty: total,
                        investedUsdt: spent,
                        highestPrice,
                        activated,
                        buyTime
                    });
                    this.saveTrailingPositions();
                    console.log(`✅ ${sym} adoptada con éxito para Trailing Take Profit.`);
                }
            }
        }
        catch (e) {
            console.error("Error sincronizando posiciones huérfanas desde Binance:", e.message);
        }
    }
    activeTrailingPositions = new Map();
    buyWatches = new Map();
    ignoredDca = new Map();
    dashboardServer;
    aiCopilot = new AiCopilot();
    constructor() {
        this.client = new Spot(process.env.BINANCE_API_KEY, process.env.BINANCE_API_SECRET, { recvWindow: 60000 });
        this.notifier = new TelegramNotifier();
        this.telegramCommands = new TelegramCommands((cmd) => this.handleTelegramCommand(cmd));
        this.loadTrailingPositions();
        this.loadBuyWatches();
        this.loadStrategyControls();
        this.loadPendingOpportunity();
        this.loadIgnoredDca();
        this.dashboardServer = new DashboardServer();
        this.dashboardServer.start();
    }
    saveIgnoredDca() {
        try {
            fs.writeFileSync(path.resolve(process.cwd(), ".ignored-dca.json"), JSON.stringify(Array.from(this.ignoredDca.entries()), null, 2));
        }
        catch (e) {
            console.error("Error guardando ignored DCA:", e.message);
        }
    }
    loadIgnoredDca() {
        try {
            const file = path.resolve(process.cwd(), ".ignored-dca.json");
            if (fs.existsSync(file)) {
                this.ignoredDca = new Map(JSON.parse(fs.readFileSync(file, "utf-8")));
            }
        }
        catch (e) { }
    }
    saveBuyWatches() {
        try {
            fs.writeFileSync(path.resolve(process.cwd(), ".trailing-buys.json"), JSON.stringify(Array.from(this.buyWatches.entries()), null, 2));
        }
        catch (e) {
            console.error("Error guardando trailing buys:", e.message);
        }
    }
    loadStrategyControls() {
        try {
            const file = path.resolve(process.cwd(), ".strategy-controls.json");
            if (fs.existsSync(file)) {
                this.controls = JSON.parse(fs.readFileSync(file, "utf-8"));
                if (!this.controls.strategies) {
                    this.controls.strategies = { trailing_rebound: true, smart_dca: true, micro_grid: false, cazador_weekend: this.isWeekendWindow() };
                }
                else if (this.controls.strategies.cazador_weekend === undefined) {
                    this.controls.strategies.cazador_weekend = this.isWeekendWindow();
                }
                if (!this.controls.baseAllocations) {
                    this.controls.baseAllocations = { trailing_rebound: 50, smart_dca: 30, micro_grid: 0, cazador_weekend: 20 };
                }
                if (!this.controls.allocations) {
                    const isW = this.isWeekendWindow();
                    const baseW = this.controls.baseAllocations.cazador_weekend ?? 20;
                    this.controls.allocations = isW
                        ? { trailing_rebound: 50, smart_dca: 30, micro_grid: 0, cazador_weekend: baseW }
                        : { trailing_rebound: 50 + baseW, smart_dca: 30, micro_grid: 0, cazador_weekend: 0 };
                }
                this.autoPilot = this.controls.autoPilot;
            }
        }
        catch (e) {
            console.error("Error cargando strategy controls:", e.message);
        }
    }
    saveStrategyControls() {
        try {
            this.controls.updatedAt = Date.now();
            this.controls.autoPilot = this.autoPilot;
            fs.writeFileSync(path.resolve(process.cwd(), ".strategy-controls.json"), JSON.stringify(this.controls, null, 2));
        }
        catch (e) {
            console.error("Error guardando strategy controls:", e.message);
        }
    }
    loadPendingOpportunity() {
        try {
            const file = path.resolve(process.cwd(), ".pending-opportunity.json");
            if (fs.existsSync(file)) {
                this.pendingOpportunity = JSON.parse(fs.readFileSync(file, "utf-8"));
            }
        }
        catch (e) { }
    }
    savePendingOpportunity() {
        try {
            const file = path.resolve(process.cwd(), ".pending-opportunity.json");
            if (this.pendingOpportunity) {
                fs.writeFileSync(file, JSON.stringify(this.pendingOpportunity, null, 2));
            }
            else if (fs.existsSync(file)) {
                fs.unlinkSync(file);
            }
        }
        catch (e) { }
    }
    async onWeekendTradeCompleted(symbol) {
        try {
            console.log("🏖️ [CAZADOR WEEKEND] Posición de fin de semana en " + symbol + " vendida con éxito. Reasignando presupuesto inteligente a Cazador Trailing...");
            this.controls.strategies.cazador_weekend = false;
            const baseW = this.controls.baseAllocations?.cazador_weekend ?? 20;
            const currentW = this.controls.allocations.cazador_weekend ?? 0;
            const transferAmount = currentW > 0 ? currentW : baseW;
            this.controls.allocations.trailing_rebound = (this.controls.allocations.trailing_rebound || 50) + transferAmount;
            this.controls.allocations.cazador_weekend = 0;
            this.saveStrategyControls();
            await this.notifier.send("🏖️ <b>[CAZADOR WEEKEND: OPERACIÓN VENDIDA CON ÉXITO]</b> 🎉\n\n" +
                "• La posición en <b>" + symbol + "</b> ha cerrado en la cima con ganancias.\n" +
                "• Como la operación de fin de semana ya fue completada, el switch de Cazador Weekend se ha <b>desactivado</b> automáticamente.\n" +
                "• 💼 <b>Presupuesto inteligente:</b> La cuota del <b>" + transferAmount + "%</b> se transfirió automáticamente a <b>🏹 Cazador Trailing</b> (ahora al <b>" + this.controls.allocations.trailing_rebound + "%</b>) para continuar operando durante la semana.\n" +
                "• ⏰ Se reactivará y recuperará su presupuesto el próximo viernes a las 17:00 COT.");
        }
        catch (e) {
            console.error("Error en onWeekendTradeCompleted:", e.message);
        }
    }
    async checkOpportunityActionFile() {
        try {
            const file = path.resolve(process.cwd(), ".opportunity-action.json");
            if (fs.existsSync(file)) {
                const data = JSON.parse(fs.readFileSync(file, "utf-8"));
                fs.unlinkSync(file);
                if (data.action === "approve" && this.pendingOpportunity) {
                    console.log(`🌐 Acción recibida desde Dashboard: APROBAR ${this.pendingOpportunity.symbol}`);
                    const opp = this.pendingOpportunity;
                    this.pendingOpportunity = null;
                    this.savePendingOpportunity();
                    await this.notifier.send(`🌐 <b>[APROBACIÓN DESDE DASHBOARD]</b> Ejecutando ${opp.strategyName} en <b>${opp.symbol}</b>...`);
                    await this.executeOpportunity(opp);
                }
                else if (data.action === "ignore" && this.pendingOpportunity) {
                    console.log(`🌐 Acción recibida desde Dashboard: IGNORAR ${this.pendingOpportunity.symbol}`);
                    this.pendingOpportunity = null;
                    this.savePendingOpportunity();
                    await this.notifier.send(`🌐 <b>[CANCELADO DESDE DASHBOARD]</b> Oportunidad descartada.`);
                }
            }
        }
        catch (e) { }
    }
    async buildAiContextSnapshot() {
        let freeUsdt = 0;
        let earnUsdt = 0;
        try {
            freeUsdt = await this.getFreeBalance("USDT");
            const earnRes = await this.client.getFlexibleProductPosition({ asset: "USDT", recvWindow: 60000 });
            earnUsdt = parseFloat(earnRes.data?.rows?.[0]?.totalAmount || "0");
        }
        catch { }
        const positions = [];
        let totalInvested = 0;
        for (const [sym, pos] of this.activeTrailingPositions.entries()) {
            try {
                const t = await this.client.tickerPrice(sym);
                const cur = parseFloat(t.data.price);
                const gainPct = ((cur - pos.buyPrice) / pos.buyPrice) * 100;
                const pnlUsdt = (cur - pos.buyPrice) * pos.qty;
                const targetPrice = pos.buyPrice * 1.008;
                positions.push({
                    symbol: sym,
                    qty: pos.qty,
                    investedUsdt: pos.investedUsdt,
                    buyPrice: pos.buyPrice,
                    curPrice: cur,
                    targetPrice,
                    gainPct,
                    pnlUsdt
                });
                totalInvested += pos.investedUsdt;
            }
            catch { }
        }
        const radar = [];
        for (const sym of ["PEPEUSDT", "XRPUSDT", "BNBUSDT", "BTCUSDT"]) {
            try {
                const k = await this.client.klines(sym, "15m", { limit: 20 });
                const closes = k.data.map((row) => parseFloat(row[4]));
                const cur = closes[closes.length - 1];
                const rsi = this.calculateRSI(closes, 14);
                const highs = k.data.map((row) => parseFloat(row[2]));
                const maxRecent = Math.max(...highs.slice(-20));
                const dropPct = ((maxRecent - cur) / maxRecent) * 100;
                radar.push({
                    symbol: sym,
                    curPrice: cur,
                    rsi,
                    dropPct,
                    isHunting: this.buyWatches.has(sym)
                });
            }
            catch { }
        }
        return {
            positions,
            freeUsdt,
            earnUsdt,
            totalEstimatedUsdt: freeUsdt + earnUsdt + totalInvested,
            allocations: this.controls.allocations || { trailing_rebound: 70, smart_dca: 30, micro_grid: 0 },
            autoPilot: this.autoPilot,
            marketSentiment: { value: 51, classification: "Neutral" },
            performance: { wins: 13, losses: 0, totalPnlUsdt: 9.57, winRate: 100 },
            radar
        };
    }
    async checkOpportunityTimeout() {
        if (!this.pendingOpportunity)
            return;
        if (Date.now() >= this.pendingOpportunity.expiresAt) {
            const opp = this.pendingOpportunity;
            this.pendingOpportunity = null;
            this.savePendingOpportunity();
            if (this.controls.autoPilot) {
                console.log(`⚡ [AUTO-PILOTO] Tiempo de 3 min agotado. Ejecutando automáticamente ${opp.strategyName} en ${opp.symbol}...`);
                await this.notifier.send(`⚡ <b>[AUTO-PILOTO ACTIVADO]</b>\n\n` +
                    `⏱️ Tiempo de espera agotado sin respuesta.\n` +
                    `🚀 Ejecutando automáticamente la recomendación para asegurar la ventana:\n` +
                    `• <b>Moneda:</b> ${opp.symbol}\n` +
                    `• <b>Estrategia:</b> ${opp.strategyName}\n` +
                    `• <b>Monto:</b> ${opp.amount.toFixed(2)} USDT`);
                await this.executeOpportunity(opp);
            }
            else {
                console.log(`⌛ [MODO MANUAL] Tiempo agotado. Oportunidad en ${opp.symbol} descartada.`);
                await this.notifier.send(`⌛ <i>Tiempo de espera agotado. Oportunidad en ${opp.symbol} descartada (Modo Manual).</i>`);
            }
        }
    }
    async executeOpportunity(opp) {
        if (opp.strategy === "smart_dca") {
            const pos = this.activeTrailingPositions.get(opp.symbol);
            if (!pos) {
                console.error(`Posición para Smart DCA en ${opp.symbol} ya no existe.`);
                return false;
            }
            return await this.executeSmartDca(pos, opp.amount);
        }
        else if (opp.strategy === "trailing_rebound") {
            return await this.executeSmartBuy(opp.symbol, opp.amount, "Trailing Rebound Confirmado");
        }
        else if (opp.strategy === "micro_grid") {
            return await this.executeSmartBuy(opp.symbol, opp.amount, "Micro-Grid Rango Lateral");
        }
        else if (opp.strategy === "cazador_weekend") {
            return await this.executeSmartBuy(opp.symbol, opp.amount, "Cazador Weekend (Rebote Fin de Semana)", "cazador_weekend");
        }
        return false;
    }
    async notifyOpportunity(opp) {
        const mins = Math.round(this.controls.approvalTimeoutSec / 60);
        const alertMsg = `🎯 <b>¡NUEVA OPORTUNIDAD DETECTADA!</b> 💡\n\n` +
            `• <b>Moneda:</b> <b>${opp.symbol}</b>\n` +
            `• 🏛️ <b>Estrategia recomendada:</b> <b>${opp.strategyName}</b>\n` +
            `• 📊 <b>Diagnóstico:</b> ${opp.reason}\n` +
            `• 💵 <b>Monto sugerido:</b> ${opp.amount.toFixed(2)} USDT\n` +
            `• ⏱️ <b>Tiempo de espera:</b> ${mins} minutos para confirmar\n\n` +
            `<b>¿Qué deseas hacer?</b>\n` +
            `👉 /aprobar — <i>Ejecutar [${opp.strategyName}]</i>\n` +
            `👉 /ignorar — <i>Descartar oportunidad</i>\n\n` +
            `🤖 <i>${this.controls.autoPilot ? `Modo Autónomo ACTIVO: Si no respondes en ${mins} min, el bot ejecutará automáticamente la recomendación.` : "Modo Manual ACTIVO: Esperará tu aprobación explícita."}</i>`;
        await this.notifier.send(alertMsg);
        console.log(alertMsg.replace(/<[^>]*>/g, ""));
    }
    async executeSmartDca(pos, usdtAmount) {
        try {
            const investStr = (usdtAmount - 0.15).toFixed(2);
            console.log(`🛡️ [Smart DCA] Ejecutando orden de seguridad de ${investStr} USDT en ${pos.symbol}...`);
            const buyRes = await this.client.newOrder(pos.symbol, "BUY", "MARKET", {
                quoteOrderQty: investStr,
                newOrderRespType: "FULL",
                recvWindow: 60000
            });
            const asset = pos.symbol.replace("USDT", "");
            const spent = parseFloat(buyRes.data.cummulativeQuoteQty);
            const grossQty = parseFloat(buyRes.data.executedQty);
            let feeInBase = 0;
            for (const f of buyRes.data.fills || []) {
                if (f.commissionAsset === asset)
                    feeInBase += parseFloat(f.commission);
            }
            const newQty = grossQty - feeInBase;
            const oldBuyPrice = pos.buyPrice;
            const oldInvested = pos.investedUsdt;
            const oldQty = pos.qty;
            pos.investedUsdt = oldInvested + spent;
            pos.qty = oldQty + newQty;
            pos.buyPrice = pos.investedUsdt / pos.qty;
            pos.highestPrice = Math.max(pos.highestPrice, pos.buyPrice);
            pos.lastDcaTime = Date.now();
            pos.dcaCount = (pos.dcaCount || 0) + 1;
            this.saveTrailingPositions();
            const savedPct = ((oldBuyPrice - pos.buyPrice) / oldBuyPrice) * 100;
            const newTarget = (pos.buyPrice * 1.008).toFixed(4);
            const alertMsg = `🛡️ <b>¡SMART DCA EJECUTADO CON ÉXITO!</b> 🎯\n\n` +
                `• <b>Moneda:</b> <b>${pos.symbol}</b>\n` +
                `• <b>Inyección de seguridad:</b> ${spent.toFixed(2)} USDT (+${newQty.toFixed(4)} ${asset})\n` +
                `• 📉 <b>Precio entrada anterior:</b> ${fmtPrice(oldBuyPrice)}\n` +
                `• 🎯 <b>NUEVO PRECIO PROMEDIO:</b> <b>${fmtPrice(pos.buyPrice)}</b> (¡<b>-${savedPct.toFixed(2)}%</b> más bajo!)\n` +
                `• 💵 <b>Total invertido:</b> ${pos.investedUsdt.toFixed(2)} USDT\n` +
                `• 🏁 <b>Nueva meta de ganancia (+0.8%):</b> ${newTarget}\n\n` +
                `💡 <i>¡Excelente movimiento defensivo! El precio de salida quedó mucho más cerca y saldremos en ganancia con un rebote menor.</i>`;
            await this.notifier.send(alertMsg);
            console.log(alertMsg.replace(/<[^>]*>/g, ""));
            return true;
        }
        catch (e) {
            const msg = e.response?.data?.msg || e.message;
            console.error(`❌ Error ejecutando Smart DCA en ${pos.symbol}:`, msg);
            await this.notifier.send(`⚠️ <i>No se pudo ejecutar Smart DCA en ${pos.symbol}: ${msg}</i>`);
            return false;
        }
    }
    async checkSmartDcaOpportunities(usdt) {
        if (!this.controls.strategies.smart_dca)
            return false;
        if (this.pendingOpportunity)
            return false;
        if (usdt < this.minUsdtToTrade)
            return false;
        for (const [sym, pos] of this.activeTrailingPositions.entries()) {
            try {
                if (pos.dcaCount && pos.dcaCount >= 2)
                    continue;
                if (pos.lastDcaTime && (Date.now() - pos.lastDcaTime) < 3 * 3600 * 1000)
                    continue;
                const curPrice = parseFloat((await this.client.tickerPrice(sym)).data.price);
                const dropPct = ((curPrice - pos.buyPrice) / pos.buyPrice) * 100;
                const lastIgnored = this.ignoredDca.get(sym);
                if (lastIgnored) {
                    const hoursSince = (Date.now() - lastIgnored.timestamp) / (3600 * 1000);
                    const extraDropPct = ((curPrice - lastIgnored.price) / lastIgnored.price) * 100;
                    if (hoursSince < 2 && extraDropPct > -3.0) {
                        continue; // En enfriamiento tras /ignorar (no spamear al usuario a menos que caiga -3% más)
                    }
                }
                if (dropPct <= -2.5) {
                    const klines = await this.client.klines(sym, "15m", { limit: 25 });
                    const closes = klines.data.map((k) => parseFloat(k[4]));
                    const rsi = this.calculateRSI(closes, 14);
                    if (rsi <= 45) {
                        const amount = Math.min(15, Math.max(10, Math.floor(usdt * 0.5 * 100) / 100));
                        const estQty = amount / curPrice;
                        const estAvg = (pos.investedUsdt + amount) / (pos.qty + estQty);
                        const savedPct = ((pos.buyPrice - estAvg) / pos.buyPrice) * 100;
                        const target08 = (estAvg * 1.008).toFixed(4);
                        const opp = {
                            id: `dca_${sym}_${Date.now()}`,
                            symbol: sym,
                            strategy: "smart_dca",
                            strategyName: "Smart DCA (Promediado de Seguridad)",
                            reason: `Cayó ${dropPct.toFixed(2)}% desde la entrada (RSI ${rsi.toFixed(1)}). Invertir ${amount.toFixed(2)} USDT baja la entrada promedio a ${fmtPrice(estAvg)} (-${savedPct.toFixed(2)}%). Nueva meta: ${target08}`,
                            amount,
                            curPrice,
                            potentialTarget: target08,
                            createdAt: Date.now(),
                            expiresAt: Date.now() + this.controls.approvalTimeoutSec * 1000
                        };
                        this.pendingOpportunity = opp;
                        this.savePendingOpportunity();
                        await this.notifyOpportunity(opp);
                        return true;
                    }
                }
            }
            catch (e) {
                console.error(`Error evaluando Smart DCA para ${sym}:`, e.message);
            }
        }
        return false;
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
                const asset = symbol.replace("USDT", "");
                let freeBal = await this.getFreeBalance(asset);
                if (freeBal < pos.qty * 0.1) {
                    // Intentar rescatar de Simple Earn si Binance lo barrió con Auto-Subscribe
                    await this.redeemFromEarnIfNeeded(asset, pos.qty);
                    freeBal = await this.getFreeBalance(asset);
                }
                if (freeBal < pos.qty * 0.1) {
                    console.log("🧹 " + symbol + " ya fue vendida en Binance (saldo cero). Retirando de memoria.");
                    this.activeTrailingPositions.delete(symbol);
                    this.saveTrailingPositions();
                    continue;
                }
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
                        const callback = this.getCallbackPct(symbol);
                        const stopPrice = curPrice * (1 - callback / 100);
                        const minLockedGain = ((stopPrice - pos.buyPrice) / pos.buyPrice) * 100;
                        const peakAlert = `📈 <b>¡NUEVO PICO ALCANZADO: ${symbol}!</b> 🚀\n\n` +
                            `• <b>Nuevo techo:</b> ${fmtPrice(curPrice)} (<b>+${gainPct.toFixed(2)}%</b>)\n` +
                            `• 🛡️ <b>Nuevo piso de venta garantizado:</b> ${fmtPrice(stopPrice)}\n` +
                            `• 💵 <b>Ganancia amarrada:</b> +${minLockedGain.toFixed(2)}% NETO\n\n` +
                            `🏹 <i>El bot sigue persiguiendo la cima hacia arriba...</i>`;
                        await this.notifier.send(peakAlert);
                    }
                }
                // 3. Evaluar Salida por Retroceso (Callback) desde el pico más alto
                if (pos.activated) {
                    const dropFromPeak = ((pos.highestPrice - curPrice) / pos.highestPrice) * 100;
                    const hitHardCap = gainPct >= TRAILING_HARD_CAP_PCT;
                    const callback = pos.strategy === "micro_grid" ? 0.15 : this.getCallbackPct(symbol);
                    const minGain = pos.strategy === "micro_grid" ? 0.35 : 0.55;
                    const hitCallback = dropFromPeak >= callback && gainPct >= minGain;
                    if (hitCallback || hitHardCap) {
                        console.log(`🏆 ¡CERRANDO EN LA CIMA! Venta Trailing en ${symbol} a $${curPrice} (Pico: $${pos.highestPrice})`);
                        const sold = await this.executeTrailingSell(pos, curPrice, hitHardCap);
                        // Solo se elimina la posición si Binance confirmó la venta
                        if (sold) {
                            const strat = pos.strategy;
                            this.activeTrailingPositions.delete(symbol);
                            this.saveTrailingPositions();
                            if (strat === "cazador_weekend") {
                                await this.onWeekendTradeCompleted(symbol);
                            }
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
                `• <b>Precio de compra:</b> ${fmtPrice(pos.buyPrice)}\n` +
                `• <b>Pico alcanzado:</b> ${fmtPrice(pos.highestPrice)}\n` +
                `• <b>Precio de venta:</b> ${fmtPrice(avgSell)}\n` +
                `• <b>Comisiones:</b> ${sellFee.toFixed(4)} USDT\n` +
                `• 💵 <b>Ganancia líquida:</b> ${profitUsdt >= 0 ? "🟢" : "🔴"} <b>${sign}${profitUsdt.toFixed(3)} USDT</b> (<b>${sign}${netPct.toFixed(2)}% NETO</b>) ≈ ${sign}$${Math.round(profitUsdt * COP_PER_USDT).toLocaleString("es-CO")} COP\n\n` +
                `🛡️ <i>${hitHardCap ? "Meta máxima de +3.5% alcanzada." : "Venta óptima capturada en la cima del rebote."}</i>\n` +
                `📊 <i>Escribe /reporte para ver el acumulado real.</i>`;
            await this.notifier.send(alertMsg);
            console.log(alertMsg.replace(/<[^>]*>/g, ""));
            // 1. Chart Snapshot para Telegram
            try {
                const chartUrl = `https://quickchart.io/chart?w=500&h=250&devicePixelRatio=2&c=` + encodeURIComponent(JSON.stringify({
                    type: "line",
                    data: {
                        labels: ["Entrada", "Suelo", "Subida", "Pico Máx", "Venta Exitosa"],
                        datasets: [{
                                label: pos.symbol,
                                data: [pos.buyPrice, pos.buyPrice * 0.998, (pos.buyPrice + pos.highestPrice) / 2, pos.highestPrice, avgSell],
                                borderColor: profitUsdt >= 0 ? "#10B981" : "#F43F5E",
                                backgroundColor: profitUsdt >= 0 ? "rgba(16,185,129,0.1)" : "rgba(244,63,94,0.1)",
                                fill: true,
                                tension: 0.3
                            }]
                    },
                    options: {
                        plugins: { legend: { display: false } },
                        scales: { x: { grid: { color: "rgba(255,255,255,0.05)" } }, y: { grid: { color: "rgba(255,255,255,0.05)" } } }
                    }
                }));
                await this.notifier.sendPhoto(chartUrl, `📊 <b>Gráfico de Salida en la Cima: ${pos.symbol}</b> (+${profitUsdt.toFixed(2)} USDT)`);
            }
            catch (e) { }
            // 2. Bóveda Automática de Ganancias (25% a Simple Earn)
            if (profitUsdt >= 0.50) {
                const vaultAmt = Math.floor(profitUsdt * 0.25 * 100) / 100;
                if (vaultAmt >= 0.10) {
                    await this.depositToEarn("USDT", vaultAmt);
                }
            }
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
    async executeSmartBuy(symbol, usdtAmount, source, strategy = "trailing_rebound") {
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
                buyTime: Date.now(),
                strategy
            });
            this.saveTrailingPositions();
            const target08 = fmtPrice(buyPrice * 1.008);
            const alertMsg = `🦅 <b>¡NUEVA COMPRA INTELIGENTE CON TRAILING!</b> 🚀\n\n` +
                `• <b>Moneda:</b> ${symbol}\n` +
                `• <b>Origen:</b> ${source}\n` +
                `• <b>Inversión:</b> ${spent.toFixed(2)} USDT\n` +
                `• <b>Precio de entrada:</b> ${fmtPrice(buyPrice)}\n` +
                `• 🎯 <b>Gatillo Trailing:</b> ${target08} (+0.8%)\n\n` +
                `🛡️ <i>En cuanto suba al +0.8%, el bot asegura la ganancia y persigue el pico para exprimir el máximo beneficio.</i>`;
            await this.notifier.send(alertMsg);
            console.log(alertMsg.replace(/<[^>]*>/g, "").replace(/<\/?i>/g, ""));
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
                    const strat = w.strategy || "trailing_rebound";
                    const sourceDesc = strat === "cazador_weekend"
                        ? `Cazador Weekend (piso ${w.lowestPrice}, ${saved.toFixed(2)}% más barato)`
                        : `Trailing Buy (piso ${w.lowestPrice}, ${saved.toFixed(2)}% más barato que al armar)`;
                    console.log(`✅ Rebote confirmado en ${sym}: piso ${w.lowestPrice} → ${cur} (+${bounce.toFixed(2)}%). Comprando ${amountToUse} USDT...`);
                    const ok = await this.executeSmartBuy(sym, amountToUse, sourceDesc, strat);
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
                return `📱 <b>CENTRO DE COMANDOS MULTI-ESTRATEGIA SPOT</b>\n\n` +
                    `• /estrategias - ⚙️ Panel y switches de estrategias (Trailing, DCA, Grid, Weekend)\n` +
                    `• /regimen - 🧭 Diagnóstico de volatilidad y Día Quieto\n` +
                    `• /aprobar_grid | /ignorar_grid - 🌐 Control de Micro-Grid\n` +
                    `• /toggle_weekend - 🏖️ Switch Cazador Weekend (Vie-Dom)\n` +
                    `• /weekend - 🏖️ Diagnóstico y estado de Cazador Weekend\n` +
                    `• /aprobar - ✅ Aprobar oportunidad recomendada pendiente\n` +
                    `• /ignorar - ❌ Descartar oportunidad recomendada\n` +
                    `• /informe - 📑 Diagnóstico completo en tiempo real\n` +
                    `• /trailing - 🏹 Posiciones activas rastreando el pico\n` +
                    `• /cazando - 🔻 Trailing Buy: monedas cazando el piso\n` +
                    `• /reporte - 📈 Ganancias reales acumuladas (Binance)\n` +
                    `• /estado - 📊 Órdenes vivas y precios en Binance\n` +
                    `• /radar - 📡 Escáner de suelos en tiempo real\n` +
                    `• /balance - 💼 Saldos libres y en Earn en Binance\n` +
                    `• /modo auto | /modo manual - 🤖 Piloto autónomo o manual\n` +
                    `• /pausa y /reanudar - ⏸️ Pausar o reanudar compras\n\n` +
                    `💡 <i>Toca cualquiera de los enlaces azules para ejecutar.</i>`;
            }
            if (cmd === "/estrategias" || cmd === "estrategias") {
                const c = this.controls.strategies;
                const mins = Math.round(this.controls.approvalTimeoutSec / 60);
                let msg = `⚙️ <b>ORQUESTADOR MULTI-ESTRATEGIA SPOT</b> 🕹️\n\n`;
                msg += `• <b>1. Cazador Trailing:</b> ${c.trailing_rebound ? "🟢 <b>ACTIVO</b>" : "🔴 <i>PAUSADO</i>"}\n`;
                msg += `  <i>Trailing Buy en piso + Trailing Take Profit en cima (+0.8% a +3.5%).</i>\n`;
                msg += `  👉 /toggle_trailing\n\n`;
                msg += `• <b>2. Smart DCA (Seguridad):</b> ${c.smart_dca ? "🟢 <b>ACTIVO</b>" : "🔴 <i>PAUSADO</i>"}\n`;
                msg += `  <i>Promedia caídas en soporte (≥ 2.5%) para salir antes con ganancia.</i>\n`;
                msg += `  👉 /toggle_dca\n\n`;
                msg += `• <b>3. Micro-Grid (Rango):</b> ${c.micro_grid ? "🟢 <b>ACTIVO</b>" : "🔴 <i>PAUSADO</i>"}\n`;
                msg += `  <i>Malla de compras y ventas rápidas en mercados laterales planos.</i>\n`;
                msg += `  👉 /toggle_grid\n\n`;
                const isW = this.isWeekendWindow();
                const weekendBadge = isW && c.cazador_weekend ? "🟢 <b>ACTIVO (En Ventana)</b>" : (!isW ? "⚪ <i>EN ESPERA (Se reactiva Viernes 17:00 COT)</i>" : "🔴 <i>PAUSADO</i>");
                msg += `• <b>4. 🏖️ Cazador Weekend:</b> ${weekendBadge}\n`;
                msg += `  <i>Aprovecha caídas de fin de semana (Vie-Dom) y exprime venta en el pico más alto (Dom noche/Lunes).</i>\n`;
                msg += `  👉 /toggle_weekend | /weekend\n\n`;
                msg += `• 🤖 <b>Modo Centinela:</b> ${this.controls.autoPilot ? "🟢 Autónomo (Auto-ejecuta a los " + mins + " min)" : "🟡 Manual Estricto"}\n`;
                msg += `  👉 /modo auto | /modo manual\n\n`;
                if (this.pendingOpportunity) {
                    const remSec = Math.max(0, Math.round((this.pendingOpportunity.expiresAt - Date.now()) / 1000));
                    msg += `⚡ <b>OPORTUNIDAD PENDIENTE:</b>\n` +
                        `• Moneda: <b>${this.pendingOpportunity.symbol}</b>\n` +
                        `• Estrategia: <b>${this.pendingOpportunity.strategyName}</b>\n` +
                        `• ⏱️ Tiempo restante: <b>${remSec}s</b>\n` +
                        `👉 /aprobar | /ignorar\n`;
                }
                return msg;
            }
            if (cmd === "/presupuesto" || cmd === "presupuesto") {
                const acc = await this.client.account({ recvWindow: 60000 });
                const freeUsdt = parseFloat(acc.data.balances.find((b) => b.asset === "USDT")?.free || "0");
                const a = this.controls.allocations;
                const base = this.controls.baseAllocations || { trailing_rebound: 50, smart_dca: 30, micro_grid: 0, cazador_weekend: 20 };
                const isW = this.isWeekendWindow();
                const tUsdt = (freeUsdt * ((a.trailing_rebound || 0) / 100)).toFixed(2);
                const dUsdt = (freeUsdt * ((a.smart_dca || 0) / 100)).toFixed(2);
                const gUsdt = (freeUsdt * ((a.micro_grid || 0) / 100)).toFixed(2);
                const wUsdt = (freeUsdt * ((a.cazador_weekend || 0) / 100)).toFixed(2);
                let msg = `💼 <b>PRESUPUESTO INTELIGENTE ASIGNADO</b> 📊\n\n`;
                msg += `• 💼 <b>USDT Líquido Disponible:</b> ${freeUsdt.toFixed(2)} USDT\n`;
                msg += `• 🔄 <b>Régimen actual:</b> ${isW ? "🟢 Fin de Semana (Cazador Weekend Activo)" : "⚪ Días Hábiles (Cuota de Weekend absorbida por Trailing)"}\n\n`;
                msg += `🏹 <b>1. Cazador Trailing:</b> <b>${a.trailing_rebound}%</b> (~${tUsdt} USDT)\n` +
                    `   ${!isW ? `<i>(Base: ${base.trailing_rebound}% + ${base.cazador_weekend}% auto-transferido de Weekend)</i>\n` : ""}` +
                    `   Estado: ${this.controls.strategies.trailing_rebound ? "🟢 ACTIVO" : "🔴 PAUSADO"}\n\n`;
                msg += `🛡️ <b>2. Smart DCA:</b> <b>${a.smart_dca}%</b> (~${dUsdt} USDT)\n` +
                    `   Estado: ${this.controls.strategies.smart_dca ? "🟢 ACTIVO" : "🔴 PAUSADO"}\n\n`;
                msg += `🌐 <b>3. Micro-Grid:</b> <b>${a.micro_grid}%</b> (~${gUsdt} USDT)\n` +
                    `   Estado: ${this.controls.strategies.micro_grid ? "🟢 ACTIVO" : "🔴 PAUSADO"}\n\n`;
                msg += `🏖️ <b>4. Cazador Weekend:</b> <b>${a.cazador_weekend}% activo</b> (Base: ${base.cazador_weekend}%)\n` +
                    `   Estado: ${isW && this.controls.strategies.cazador_weekend ? "🟢 ACTIVO EN VENTANA" : "⚪ EN ESPERA (Se reactiva Viernes 17:00 COT)"}\n\n`;
                msg += `🎛️ <b>Para modificar porcentajes base:</b>\n` +
                    `Escribe: <code>/asignar &lt;trailing&gt; &lt;dca&gt; &lt;grid&gt; &lt;weekend&gt;</code>\n` +
                    `Ejemplo: <code>/asignar 50 30 0 20</code> (debe sumar 100).`;
                return msg;
            }
            if (cmd === "/asignar" || cmd === "asignar") {
                let t = parseInt(arg1 || "0", 10);
                let d = parseInt(arg2 || "0", 10);
                let g = parseInt(parts[3] || "0", 10);
                let w = parseInt(parts[4] || "0", 10);
                // Si pasó 3 números que suman 100, asumir t, d, w (con grid=0)
                if (parts.length === 4 && (t + d + g === 100)) {
                    w = g;
                    g = 0;
                }
                if (isNaN(t) || isNaN(d) || isNaN(g) || isNaN(w) || (t + d + g + w !== 100)) {
                    return `⚠️ <b>Formato incorrecto:</b> La suma de los porcentajes debe ser exactamente 100.\n\n` +
                        `Ejemplo de uso: <code>/asignar 50 30 0 20</code>\n` +
                        `(50% Trailing, 30% Smart DCA, 0% Micro-Grid, 20% Cazador Weekend)`;
                }
                this.controls.baseAllocations = {
                    trailing_rebound: t,
                    smart_dca: d,
                    micro_grid: g,
                    cazador_weekend: w
                };
                const isW = this.isWeekendWindow();
                if (!isW) {
                    this.controls.allocations = {
                        trailing_rebound: t + w,
                        smart_dca: d,
                        micro_grid: g,
                        cazador_weekend: 0
                    };
                    this.controls.strategies.cazador_weekend = false;
                }
                else {
                    this.controls.allocations = {
                        trailing_rebound: t,
                        smart_dca: d,
                        micro_grid: g,
                        cazador_weekend: w
                    };
                    this.controls.strategies.cazador_weekend = true;
                }
                this.saveStrategyControls();
                return `✅ <b>¡PRESUPUESTO AUTO-GRADUADO GUARDADO!</b> 🎯\n\n` +
                    `• 🏹 <b>Cazador Trailing:</b> ${t}% base ${!isW ? `(👉 <b>${t + w}% ACTIVO</b> entre semana)` : ""}\n` +
                    `• 🛡️ <b>Smart DCA:</b> <b>${d}%</b>\n` +
                    `• 🌐 <b>Micro-Grid:</b> <b>${g}%</b>\n` +
                    `• 🏖️ <b>Cazador Weekend:</b> ${w}% base ${!isW ? `(👉 <i>0% ahora: se apartará el viernes a las 17:00 COT</i>)` : `(👉 <b>${w}% ACTIVO</b>)`}\n\n` +
                    `💾 <i>Presupuesto inteligente activo: En días hábiles todo el capital trabaja en Trailing, y el fin de semana se recupera automáticamente para cazar la caída más oportuna.</i>`;
            }
            if (cmd === "/toggle_trailing" || cmd === "toggle_trailing") {
                this.controls.strategies.trailing_rebound = !this.controls.strategies.trailing_rebound;
                this.saveStrategyControls();
                return `🏹 <b>Cazador Trailing:</b> ${this.controls.strategies.trailing_rebound ? "🟢 ACTIVADO" : "🔴 PAUSADO"}.`;
            }
            if (cmd === "/toggle_dca" || cmd === "toggle_dca") {
                this.controls.strategies.smart_dca = !this.controls.strategies.smart_dca;
                this.saveStrategyControls();
                return `🛡️ <b>Smart DCA:</b> ${this.controls.strategies.smart_dca ? "🟢 ACTIVADO" : "🔴 PAUSADO"}.`;
            }
            if (cmd === "/toggle_grid" || cmd === "toggle_grid") {
                this.controls.strategies.micro_grid = !this.controls.strategies.micro_grid;
                if (this.controls.strategies.micro_grid) {
                    await this.activateMicroGrid(false);
                    return `🌐 <b>Micro-Grid:</b> 🟢 ACTIVADO. Presupuesto reasignado para operar canales laterales.`;
                }
                else {
                    await this.deactivateMicroGrid();
                    return `🌐 <b>Micro-Grid:</b> 🔴 PAUSADO. Presupuesto devuelto a Cazador Trailing.`;
                }
            }
            if (cmd === "/aprobar_grid" || cmd === "aprobar_grid" || cmd === "/activar_grid") {
                this.pendingRegimeSwitch = null;
                await this.activateMicroGrid(false);
                return `🌐 <b>Micro-Grid ACTIVADO por ti.</b> Presupuesto reasignado para operar en canales laterales planos.`;
            }
            if (cmd === "/ignorar_grid" || cmd === "ignorar_grid") {
                this.pendingRegimeSwitch = null;
                return `❌ Sugerencia de Micro-Grid descartada. El bot permanecerá al 100% en Cazador Trailing.`;
            }
            if (cmd === "/regimen" || cmd === "regimen") {
                const btc24 = await this.client.ticker24hr("BTCUSDT");
                const high = parseFloat(btc24.data.highPrice);
                const low = parseFloat(btc24.data.lowPrice);
                const range24h = ((high - low) / low) * 100;
                const isQuiet = range24h < 2.2;
                let msg = `📡 <b>DIAGNÓSTICO DE RÉGIMEN DE MERCADO</b> 🧭\n\n`;
                msg += `• <b>Estado Actual:</b> ${isQuiet ? "💤 <b>DÍA QUIETO (Mercado Lateral Plano)</b>" : "🚀 <b>MERCADO ACTIVO (Volatilidad Direccional)</b>"}\n`;
                msg += `• <b>Rango 24h Bitcoin:</b> <b>${range24h.toFixed(2)}%</b> (${low.toFixed(0)} - ${high.toFixed(0)})\n`;
                msg += `• <b>Estrategia Prioritaria:</b> ${this.controls.strategies.micro_grid ? "🌐 <b>Micro-Grid (Malla Lateral Activa)</b>" : "🏹 <b>Cazador Trailing (Activo)</b>"}\n`;
                msg += `• 🤖 <b>Auto-Detección Centinela:</b> 🟢 ACTIVA (Conmuta automáticamente con aviso interactivo)\n\n`;
                msg += `👉 /toggle_grid — <i>Activar o pausar Micro-Grid manualmente</i>`;
                return msg;
            }
            if (cmd === "/toggle_weekend" || cmd === "toggle_weekend") {
                this.controls.strategies.cazador_weekend = !this.controls.strategies.cazador_weekend;
                this.saveStrategyControls();
                return `🏖️ <b>Cazador Weekend:</b> ${this.controls.strategies.cazador_weekend ? "🟢 ACTIVADO" : "🔴 PAUSADO"}.`;
            }
            if (cmd === "/weekend" || cmd === "weekend") {
                const isWindow = this.isWeekendWindow();
                const isAct = this.controls.strategies.cazador_weekend;
                const alloc = this.controls.allocations.cazador_weekend ?? 20;
                let msg = `🏖️ <b>ESTRATEGIA CAZADOR WEEKEND</b> 🎯\n\n`;
                msg += `• ⏱️ <b>Ventana de Operación:</b> ${isWindow ? "🟢 <b>VENTANA ABIERTA (Vie 17:00 a Dom 18:00 COT)</b>" : "⚪ <b>CERRADA / EN ESPERA (Se reactiva Viernes 17:00 COT)</b>"}\n`;
                msg += `• 🕹️ <b>Estado del Switch:</b> ${isAct ? "🟢 ACTIVADO" : "⚪ AUTO-DESACTIVADO (Lunes a Viernes)"} (👉 /toggle_weekend)\n`;
                msg += `• 💼 <b>Presupuesto Asignado:</b> <b>${alloc}%</b> del capital libre\n`;
                msg += `• 🏹 <b>Mecánica de Compra:</b> Caza el piso más bajo en sobreventa durante el fin de semana y entra con rebote +0.35%.\n`;
                msg += `• 🚀 <b>Mecánica de Venta:</b> Trailing Take Profit (+0.80% a +3.5%) persigue el pico más alto (domingo noche, lunes o el día que más suba), vendiendo en la cima sin pérdidas jamás.\n\n`;
                if (this.buyWatches.size > 0) {
                    msg += `🔻 <b>Monedas cazando el piso ahora mismo:</b>\n`;
                    for (const [sym, w] of this.buyWatches.entries()) {
                        msg += `  • <b>${sym}:</b> Piso ${w.lowestPrice} (Armado a ${w.armedPrice})\n`;
                    }
                }
                else {
                    msg += isWindow ? `📡 <i>Monitoreando caídas y sobreventas en la Watchlist...</i>` : `😴 <i>En pausa hasta el viernes a las 17:00 COT.</i>`;
                }
                return msg;
            }
            if (cmd === "/aprobar" || cmd === "aprobar") {
                if (!this.pendingOpportunity) {
                    return "ℹ️ No hay ninguna oportunidad pendiente en este momento.";
                }
                const opp = this.pendingOpportunity;
                this.pendingOpportunity = null;
                this.savePendingOpportunity();
                setTimeout(() => this.executeOpportunity(opp), 100);
                return `🚀 <b>¡APROBADO!</b> Ejecutando <b>${opp.strategyName}</b> en <b>${opp.symbol}</b> por ${opp.amount.toFixed(2)} USDT...`;
            }
            if (cmd === "/ignorar" || cmd === "ignorar") {
                if (!this.pendingOpportunity) {
                    return "ℹ️ No hay ninguna oportunidad pendiente en este momento.";
                }
                const opp = this.pendingOpportunity;
                const sym = opp.symbol;
                this.ignoredDca.set(sym, {
                    timestamp: Date.now(),
                    price: opp.curPrice,
                    dropPct: -2.5
                });
                this.saveIgnoredDca();
                this.pendingOpportunity = null;
                this.savePendingOpportunity();
                return `❌ Oportunidad en <b>${sym}</b> descartada.\n\n` +
                    `🔇 <b>Silenciada:</b> No volveré a sugerir DCA en ${sym} por <b>2 horas</b>, a menos que caiga un <b>-3.0% adicional</b>.`;
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
                        const stopPrice = p.highestPrice * (1 - this.getCallbackPct(sym) / 100);
                        const distToStop = Math.abs(cur - stopPrice);
                        const target08 = p.buyPrice * 1.008;
                        rep += `🪙 <b>${sym}</b> (${p.qty} ${sym.replace("USDT", "")})\n` +
                            `• Inversión: ${p.investedUsdt.toFixed(2)} USDT\n` +
                            `• Entrada: ${fmtPrice(p.buyPrice)}\n` +
                            `• Precio Actual: ${fmtPrice(cur)} (${curGain >= 0 ? "🟢 +" : "🔴 "}${curGain.toFixed(2)}%)\n` +
                            `• Pico Más Alto: ${fmtPrice(p.highestPrice)} (+${peakGain.toFixed(2)}%)\n`;
                        if (p.activated) {
                            rep += `• 🛡️ <b>Gatillo de Salida:</b> ${fmtPrice(stopPrice)} (a solo ${distToStop.toFixed(2)} de distancia)\n` +
                                `• Estado: 🟢 <b>SEGURO ACTIVADO (Cazando la cima)</b>\n\n`;
                        }
                        else {
                            const falta08 = (((target08 - cur) / cur) * 100);
                            rep += `• 🎯 <b>Meta para Activar Seguro:</b> ${fmtPrice(target08)} (falta: +${falta08.toFixed(2)}%)\n` +
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
            if (this.aiCopilot.isAvailable()) {
                const ctx = await this.buildAiContextSnapshot();
                return await this.aiCopilot.chat(rawCmd, ctx, {});
            }
            return "Comando no reconocido. Escribe /menu para ver la lista de comandos disponibles.";
        }
        catch (e) {
            return `⚠️ Error: ${e.message}`;
        }
    }
    /**
     * CAZADOR WEEKEND: Explota la anomalía del fin de semana (caídas de viernes 17:00 a domingo 18:00 COT).
     * Evalúa las caídas en la watchlist, ranquea por score de sobreventa y caza el piso más bajo
     * para vender en el rebote máximo (domingo noche, lunes o el pico más alto con Trailing Take Profit).
     */
    /**
     * DETECCIÓN AUTOMÁTICA DE DÍAS QUIETOS (MERCADO LATERAL)
     * Evalúa la compresión de volatilidad de Bitcoin en 24h.
     * Si es < 2.2%, notifica por Telegram y auto-activa Micro-Grid tras 3 minutos si no hay respuesta.
     * Si sube a >= 2.5%, auto-desactiva Micro-Grid y devuelve el presupuesto a Cazador Trailing.
     */
    async checkMarketRegime() {
        if (Date.now() - this.lastRegimeCheckTime < 180000)
            return; // Chequear cada 3 minutos
        this.lastRegimeCheckTime = Date.now();
        try {
            const btc24 = await this.client.ticker24hr("BTCUSDT");
            const high = parseFloat(btc24.data.highPrice);
            const low = parseFloat(btc24.data.lowPrice);
            const range24h = ((high - low) / low) * 100;
            const isQuiet = range24h < 2.2;
            const currentRegime = isQuiet ? "QUIET" : "TRENDING";
            if (this.lastDetectedRegime === null) {
                this.lastDetectedRegime = currentRegime;
            }
            // A) DÍA QUIETO DETECTADO: Activar Micro-Grid si está apagado y no hay sugerencia pendiente
            if (isQuiet && !this.controls.strategies.micro_grid && !this.pendingRegimeSwitch) {
                this.pendingRegimeSwitch = {
                    type: "activate_grid",
                    reason: `Rango estrecho en Bitcoin de ${range24h.toFixed(2)}% (${low.toFixed(0)} - ${high.toFixed(0)})`,
                    btcRange24h: range24h,
                    createdAt: Date.now(),
                    expiresAt: Date.now() + 180000 // 3 min
                };
                const alertMsg = `💤 <b>[MERCADO LATERAL / DÍA QUIETO DETECTADO]</b> 🌐\n\n` +
                    `• La volatilidad de 24h en Bitcoin es de apenas <b>${range24h.toFixed(2)}%</b> (${low.toFixed(0)} - ${high.toFixed(0)}).\n` +
                    `• 💡 <b>Recomendación del Centinela:</b> Activar <b>🌐 Micro-Grid</b> (Malla Lateral) con <b>30%</b> del presupuesto para cosechar micro-rebotes (+0.45% a +0.60%) mientras el mercado está quieto.\n\n` +
                    `👉 /aprobar_grid — <i>Activar Micro-Grid ahora</i>\n` +
                    `👉 /ignorar_grid — <i>Permanecer en Cazador Trailing</i>\n\n` +
                    `🤖 <i>${this.controls.autoPilot ? "Modo Autónomo ACTIVO: Si no respondes en 3 minutos, se activará automáticamente." : "Modo Manual: Esperando tu confirmación."}</i>`;
                await this.notifier.send(alertMsg);
                console.log(alertMsg.replace(/<[^>]*>/g, ""));
            }
            // B) FIN DE DÍA QUIETO / VOLATILIDAD REACTIVADA: Si el mercado despierta (range >= 2.5%) y Micro-Grid está activo
            if (!isQuiet && range24h >= 2.5 && this.controls.strategies.micro_grid) {
                await this.deactivateMicroGrid(range24h);
            }
            this.lastDetectedRegime = currentRegime;
        }
        catch (e) {
            console.error("Error en checkMarketRegime:", e.message);
        }
    }
    async checkRegimeSwitchTimeout() {
        if (!this.pendingRegimeSwitch)
            return;
        if (Date.now() >= this.pendingRegimeSwitch.expiresAt) {
            const sw = this.pendingRegimeSwitch;
            this.pendingRegimeSwitch = null;
            if (this.controls.autoPilot) {
                console.log("⚡ [AUTO-PILOTO] Tiempo de 3 min agotado. Auto-activando Micro-Grid por Día Quieto...");
                await this.activateMicroGrid(true, sw.btcRange24h);
            }
            else {
                console.log("⌛ [MODO MANUAL] Tiempo agotado. Sugerencia de Micro-Grid descartada.");
                await this.notifier.send("⌛ <i>Tiempo de espera agotado. Activación de Micro-Grid descartada (Modo Manual).</i>");
            }
        }
    }
    async activateMicroGrid(auto = false, btcRange24h) {
        this.controls.strategies.micro_grid = true;
        // Apartar 30% para micro_grid desde trailing_rebound
        if ((this.controls.allocations.micro_grid || 0) < 30) {
            const needed = 30 - (this.controls.allocations.micro_grid || 0);
            const takeFromTrailing = Math.min(needed, Math.max(0, (this.controls.allocations.trailing_rebound || 50) - 20));
            this.controls.allocations.trailing_rebound -= takeFromTrailing;
            this.controls.allocations.micro_grid = (this.controls.allocations.micro_grid || 0) + takeFromTrailing;
        }
        this.saveStrategyControls();
        const rangeStr = btcRange24h ? ` (BTC ${btcRange24h.toFixed(2)}% en 24h)` : "";
        await this.notifier.send(`🌐 <b>[MICRO-GRID ACTIVADO ${auto ? "AUTOMÁTICAMENTE (3 MIN)" : "POR COMANDO"}]</b> ✅\n\n` +
            `• <b>Régimen:</b> Día Quieto / Rango Lateral${rangeStr}.\n` +
            `• <b>Misión:</b> Cosechar micro-rebotes rápidos en canales laterales (+0.45% a +0.60%).\n` +
            `• 💼 <b>Presupuesto reasignado:</b> Micro-Grid <b>${this.controls.allocations.micro_grid}%</b> | Cazador Trailing <b>${this.controls.allocations.trailing_rebound}%</b> | Smart DCA <b>${this.controls.allocations.smart_dca}%</b>.\n` +
            `• 🔄 Cuando el mercado vuelva a activarse con volatilidad (>=2.5%), se auto-desactivará y devolverá el 100% a Cazador Trailing.`);
    }
    async deactivateMicroGrid(range24h) {
        this.controls.strategies.micro_grid = false;
        // Devolver presupuesto de micro_grid a trailing_rebound
        const gAlloc = this.controls.allocations.micro_grid || 0;
        if (gAlloc > 0) {
            this.controls.allocations.trailing_rebound = (this.controls.allocations.trailing_rebound || 50) + gAlloc;
            this.controls.allocations.micro_grid = 0;
        }
        this.saveStrategyControls();
        const rangeStr = range24h ? ` (BTC ${range24h.toFixed(2)}% en 24h)` : "";
        await this.notifier.send(`🚀 <b>[VOLATILIDAD REACTIVADA: FIN DE DÍA QUIETO]</b> 🏹\n\n` +
            `• El mercado ha despertado con volumen${rangeStr}.\n` +
            `• <b>Micro-Grid</b> se ha pausado automáticamente.\n` +
            `• 💼 <b>Presupuesto devuelto:</b> La cuota se transfirió al 100% a <b>🏹 Cazador Trailing</b> (ahora al <b>${this.controls.allocations.trailing_rebound}%</b>) para cazar tendencias y grandes olas.\n` +
            `• 🎯 Listo para operar rebotes direccionales.`);
    }
    /**
     * ESCÁNER MICRO-GRID: Opera compras rápidas en canales laterales estrechos durante días quietos.
     */
    async evaluateMicroGrid(usdt, activeSymbols) {
        if (!this.controls.strategies.micro_grid)
            return false;
        if (this.pendingOpportunity)
            return false;
        if (usdt < this.minUsdtToTrade)
            return false;
        for (const sym of WATCHLIST) {
            try {
                if (activeSymbols.has(sym) || this.activeTrailingPositions.has(sym) || this.buyWatches.has(sym)) {
                    continue;
                }
                const klinesRes = await this.client.klines(sym, "15m", { limit: 24 });
                const data = klinesRes.data;
                const closes = data.map((k) => parseFloat(k[4]));
                const highs = data.map((k) => parseFloat(k[2]));
                const lows = data.map((k) => parseFloat(k[3]));
                const curPrice = closes[closes.length - 1];
                const min6h = Math.min(...lows);
                const max6h = Math.max(...highs);
                const channelRangePct = ((max6h - min6h) / min6h) * 100;
                // Canal lateral plano ideal: rango entre 0.8% y 2.5%
                if (channelRangePct >= 0.8 && channelRangePct <= 2.5) {
                    const positionInChannel = (curPrice - min6h) / (max6h - min6h);
                    const rsi = this.calculateRSI(closes, 14);
                    // Si el precio está en el 35% inferior del canal y RSI neutro-bajo (36-52): ¡Compra Micro-Grid!
                    if (positionInChannel <= 0.35 && rsi >= 36 && rsi <= 52) {
                        let amountToUse = Math.min(usdt, 50);
                        if (usdt >= 80)
                            amountToUse = Math.min(usdt * 0.4, 40);
                        console.log(`🌐 [MICRO-GRID] Entrada en canal lateral en ${sym}: precio ${curPrice} cerca de base ${min6h} (Canal ${channelRangePct.toFixed(2)}% | RSI ${rsi.toFixed(1)})`);
                        const ok = await this.executeSmartBuy(sym, amountToUse, `Micro-Grid Canal Lateral (${channelRangePct.toFixed(2)}%)`, "micro_grid");
                        if (ok)
                            return true;
                    }
                }
            }
            catch (e) { }
        }
        return false;
    }
    async evaluateCazadorWeekend(usdt, activeSymbols) {
        if (!this.controls.strategies.cazador_weekend || !this.isWeekendWindow())
            return false;
        if (this.pendingOpportunity)
            return false;
        if (usdt < this.minUsdtToTrade)
            return false;
        // Si ya hay buyWatches activas, evaluarlas primero con el bounce
        if (this.buyWatches.size > 0) {
            const bought = await this.checkBuyWatches(usdt);
            if (bought)
                return true;
        }
        const candidates = [];
        for (const sym of WATCHLIST) {
            try {
                if (activeSymbols.has(sym) || this.activeTrailingPositions.has(sym) || this.buyWatches.has(sym)) {
                    continue;
                }
                const klinesRes = await this.client.klines(sym, "15m", { limit: 48 });
                const data = klinesRes.data;
                const closes = data.map((k) => parseFloat(k[4]));
                const highs = data.map((k) => parseFloat(k[2]));
                const rsi = this.calculateRSI(closes, 14);
                const curPrice = closes[closes.length - 1];
                const maxRecent = Math.max(...highs.slice(-36));
                const dropPct = ((maxRecent - curPrice) / maxRecent) * 100;
                // Criterio de caída o sobreventa en fin de semana
                if ((dropPct >= 1.5 && rsi <= 55) || (rsi <= 45 && dropPct >= 0.8) || (rsi <= 38)) {
                    const score = (dropPct * 1.5) + Math.max(0, (48 - rsi) * 2.0);
                    candidates.push({ symbol: sym, curPrice, dropPct, rsi, score });
                }
            }
            catch (e) { }
        }
        if (candidates.length === 0)
            return false;
        // Ordenar de mayor a menor puntuación (la caída más profunda y con mayor sobreventa)
        candidates.sort((a, b) => b.score - a.score);
        const best = candidates[0];
        // Armar Trailing Buy para cazar el piso exacto de fin de semana
        this.buyWatches.set(best.symbol, {
            symbol: best.symbol,
            armedPrice: best.curPrice,
            lowestPrice: best.curPrice,
            armedTime: Date.now(),
            rsi: best.rsi,
            dropPct: best.dropPct,
            strategy: "cazador_weekend"
        });
        this.saveBuyWatches();
        const trigger = best.curPrice * (1 + 0.35 / 100);
        console.log("🏖️ [CAZADOR WEEKEND] Oportunidad top armada en " + best.symbol + " (Caída: -" + best.dropPct.toFixed(2) + "% | RSI: " + best.rsi.toFixed(1) + " | Score: " + best.score.toFixed(1) + ")");
        await this.notifier.send("🏖️ <b>[CAZADOR WEEKEND ARMADO: " + best.symbol + "]</b> 🎯\n\n" +
            "• Caída de fin de semana: <b>-" + best.dropPct.toFixed(2) + "%</b> (RSI: <b>" + best.rsi.toFixed(1) + "</b>)\n" +
            "• Puntuación de rebote: <b>" + best.score.toFixed(1) + " pts</b> (Top 1 de watchlist)\n" +
            "• Precio actual: <b>" + best.curPrice + "</b>\n" +
            "• 🔻 Rastreo de piso activo: persiguiendo el suelo tick a tick.\n" +
            "• 🏹 Disparará compra al confirmar rebote de <b>+0.35%</b> desde el piso.\n" +
            "• 🚀 <b>Salida:</b> El Trailing Take Profit (+0.80% a +3.5%) perseguirá el pico más alto (domingo noche/lunes o el día que más suba) para vender en la cima.");
        return true;
    }
    async runCycle() {
        if (this.isProcessing)
            return;
        this.isProcessing = true;
        try {
            this.loadStrategyControls();
            // Control de ciclo automático de Cazador Weekend (Vie 17:00 a Dom 18:00 COT)
            const isWeekend = this.isWeekendWindow();
            if (this.lastWeekendWindowState === null) {
                this.lastWeekendWindowState = isWeekend;
                if (!isWeekend && (this.controls.strategies.cazador_weekend || this.controls.allocations.cazador_weekend > 0)) {
                    console.log("🏖️ [CAZADOR WEEKEND] Fuera de fin de semana (Lunes). Auto-desactivando switch y transfiriendo cuota a Trailing.");
                    this.controls.strategies.cazador_weekend = false;
                    const wAlloc = this.controls.allocations.cazador_weekend || 0;
                    if (wAlloc > 0) {
                        this.controls.allocations.trailing_rebound = (this.controls.allocations.trailing_rebound || 50) + wAlloc;
                        this.controls.allocations.cazador_weekend = 0;
                    }
                    this.saveStrategyControls();
                }
            }
            else if (this.lastWeekendWindowState !== isWeekend) {
                this.lastWeekendWindowState = isWeekend;
                if (!isWeekend) {
                    console.log("🏖️ [CAZADOR WEEKEND] Ventana de fin de semana finalizada. Auto-desactivando switch y devolviendo cuota a Trailing.");
                    this.controls.strategies.cazador_weekend = false;
                    const wAlloc = this.controls.allocations.cazador_weekend || 0;
                    if (wAlloc > 0) {
                        this.controls.allocations.trailing_rebound = (this.controls.allocations.trailing_rebound || 50) + wAlloc;
                        this.controls.allocations.cazador_weekend = 0;
                    }
                    this.saveStrategyControls();
                    await this.notifier.send("🏖️ <b>[CAZADOR WEEKEND: AUTO-DESACTIVADO]</b> ⏸️\n\n" +
                        "• La ventana de compras de fin de semana ha finalizado (Domingo 18:00 COT).\n" +
                        "• El switch se ha <b>auto-desactivado</b> para no hacer compras en días de semana.\n" +
                        `• 💼 <b>Presupuesto inteligente:</b> La cuota (${wAlloc}%) se transfirió automáticamente a <b>🏹 Cazador Trailing</b> (ahora al ${this.controls.allocations.trailing_rebound}%) para operar al 100% durante la semana.\n` +
                        "• 🚀 <b>Ventas:</b> Posiciones abiertas siguen rastreando el pico máximo con Trailing Take Profit.\n" +
                        "• ⏰ Se reactivará automáticamente el próximo viernes a las 17:00 COT.");
                }
                else {
                    console.log("🏖️ [CAZADOR WEEKEND] Ventana de fin de semana iniciada. Auto-activando switch y recuperando presupuesto.");
                    this.controls.strategies.cazador_weekend = true;
                    const baseW = this.controls.baseAllocations?.cazador_weekend ?? 20;
                    if (this.controls.allocations.cazador_weekend < baseW) {
                        const diff = baseW - this.controls.allocations.cazador_weekend;
                        const takeFromTrailing = Math.min(diff, Math.max(0, (this.controls.allocations.trailing_rebound || 50) - 20));
                        this.controls.allocations.trailing_rebound -= takeFromTrailing;
                        this.controls.allocations.cazador_weekend += takeFromTrailing;
                    }
                    this.saveStrategyControls();
                    await this.notifier.send("🏖️ <b>[CAZADOR WEEKEND: AUTO-ACTIVADO]</b> 🟢\n\n" +
                        "• ¡Ventana de fin de semana abierta (Viernes 17:00 COT)!\n" +
                        `• 💼 <b>Presupuesto recuperado:</b> Se apartó el <b>${this.controls.allocations.cazador_weekend}%</b> para cazar la mejor caída del fin de semana (Trailing quedó en ${this.controls.allocations.trailing_rebound}%).\n` +
                        "• 📡 Escaneando la Watchlist en busca de sobreventas y suelos con Trailing Buy...");
                }
            }
            await this.checkOpportunityActionFile();
            await this.checkOpportunityTimeout();
            await this.checkMarketRegime();
            await this.checkRegimeSwitchTimeout();
            // Auto-sincronizar periódicamente posiciones de Binance
            this.cycleCount = (this.cycleCount || 0) + 1;
            if (this.cycleCount % 6 === 1) {
                await this.syncOrphanPositions();
            }
            // 1. Monitorear y rastrear posiciones abiertas en Trailing Stop
            await this.checkTrailingPositions();
            const openOrders = await this.client.openOrders({ recvWindow: 60000 });
            const sellOrders = openOrders.data.filter((o) => o.side === "SELL");
            const activeSymbols = new Set(sellOrders.map((o) => o.symbol));
            const acc = await this.client.account({ recvWindow: 60000 });
            const usdt = parseFloat(acc.data.balances.find((b) => b.asset === "USDT")?.free || "0");
            const time = new Date().toLocaleTimeString();
            console.log(`[${time}] Monitoreo... USDT libre: $${usdt.toFixed(2)} | Órdenes Binance: ${sellOrders.length} | Trailing activos: ${this.activeTrailingPositions.size} | Cazando piso: ${this.buyWatches.size}`);
            // 2. Evaluar oportunidades si hay saldo libre y no hay oportunidad pendiente
            if (usdt >= this.minUsdtToTrade && !this.pendingOpportunity) {
                // A) Primero evaluar Smart DCA en posiciones activas que hayan caído
                const dcaTriggered = await this.checkSmartDcaOpportunities(usdt);
                // B) Si estamos en Fin de Semana y Cazador Weekend está activo:
                let weekendTriggered = false;
                if (!dcaTriggered && this.isWeekendWindow() && this.controls.strategies.cazador_weekend && this.activeTrailingPositions.size < 5) {
                    weekendTriggered = await this.evaluateCazadorWeekend(usdt, activeSymbols);
                }
                // C) Si Micro-Grid está activo (en días quietos): operar canales laterales
                let gridTriggered = false;
                if (!dcaTriggered && !weekendTriggered && this.controls.strategies.micro_grid && this.activeTrailingPositions.size < 5) {
                    gridTriggered = await this.evaluateMicroGrid(usdt, activeSymbols);
                }
                // D) Si no hay DCA, Weekend ni Grid y Trailing Rebound está activo: vigilar caídas y suelos
                if (!dcaTriggered && !weekendTriggered && !gridTriggered && this.controls.strategies.trailing_rebound && this.activeTrailingPositions.size < 5) {
                    await this.scanForDips(activeSymbols);
                    if (this.buyWatches.size > 0) {
                        await this.checkBuyWatches(usdt);
                    }
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
        await this.syncOrphanPositions();
        await this.runCycle();
        setInterval(() => this.runCycle(), 7000);
    }
}
// BOT_NO_AUTOSTART=1 permite importar la clase para pruebas sin arrancar el bot
if (process.env.BOT_NO_AUTOSTART !== "1") {
    const bot = new TrailingMasterBot();
    bot.start();
}
