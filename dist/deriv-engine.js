import WebSocket from "ws";
import * as fs from "fs";
import * as path from "path";
import { TelegramNotifier } from "./notifier.js";
export class DerivEngine {
    notifier;
    stateFile;
    positionsFile;
    tradesFile;
    state;
    positions = [];
    trades = [];
    apiKey;
    appId;
    accountId;
    ws = null;
    isConnected = false;
    isConnecting = false;
    pingInterval = null;
    analysisInterval = null;
    // Real-time market tick buffers per symbol
    tickHistory = new Map();
    symbolCooldowns = new Map();
    constructor() {
        this.notifier = new TelegramNotifier();
        const cwd = process.cwd();
        this.stateFile = path.resolve(cwd, ".deriv-state.json");
        this.positionsFile = path.resolve(cwd, ".deriv-positions.json");
        this.tradesFile = path.resolve(cwd, ".deriv-trades.json");
        this.apiKey = process.env.DERIV_KEY || "";
        this.appId = process.env.DERIV_APP_ID || "";
        this.accountId = process.env.DERIV_ACCOUNT_ID || "";
        this.state = this.loadState();
        this.positions = this.loadPositions();
        this.trades = this.loadTrades();
    }
    // --- PERSISTENCE ---
    loadState() {
        const defaultState = {
            enabled: true,
            isSimulated: true, // Operating on official Deriv Demo DOT account
            accountId: this.accountId,
            appId: this.appId,
            balanceUsdt: 10000.0,
            startingBalanceUsdt: 10000.0,
            totalProfitUsdt: 0.0,
            winsCount: 0,
            lossesCount: 0,
            winRatePct: 0.0,
            defaultStake: 10.0, // $10 USD per trade
            defaultDurationTicks: 5, // 5 ticks (~10 seconds)
            maxConcurrentTrades: 1, // Ultra-disciplined execution
            dailyProfitTarget: 50.0,
            dailyStopLoss: 30.0,
            dailyRealizedPnl: 0.0,
            lastDailyReset: new Date().toISOString().split("T")[0],
            activeSymbols: ["R_75", "R_100", "1HZ75V"],
            lastTradeTime: 0
        };
        try {
            if (fs.existsSync(this.stateFile)) {
                const raw = fs.readFileSync(this.stateFile, "utf8");
                return { ...defaultState, ...JSON.parse(raw) };
            }
        }
        catch (e) {
            console.error("[DERIV] Error loading state:", e);
        }
        return defaultState;
    }
    saveState() {
        try {
            fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2), "utf8");
        }
        catch (e) {
            console.error("[DERIV] Error saving state:", e);
        }
    }
    loadPositions() {
        try {
            if (fs.existsSync(this.positionsFile)) {
                return JSON.parse(fs.readFileSync(this.positionsFile, "utf8"));
            }
        }
        catch (e) {
            console.error("[DERIV] Error loading positions:", e);
        }
        return [];
    }
    savePositions() {
        try {
            fs.writeFileSync(this.positionsFile, JSON.stringify(this.positions, null, 2), "utf8");
        }
        catch (e) {
            console.error("[DERIV] Error saving positions:", e);
        }
    }
    loadTrades() {
        try {
            if (fs.existsSync(this.tradesFile)) {
                return JSON.parse(fs.readFileSync(this.tradesFile, "utf8"));
            }
        }
        catch (e) {
            console.error("[DERIV] Error loading trades:", e);
        }
        return [];
    }
    saveTrades() {
        try {
            fs.writeFileSync(this.tradesFile, JSON.stringify(this.trades, null, 2), "utf8");
        }
        catch (e) {
            console.error("[DERIV] Error saving trades:", e);
        }
    }
    // --- ENGINE LIFECYCLE ---
    async start() {
        if (!this.apiKey || !this.appId || !this.accountId) {
            console.warn("[DERIV] Credenciales de Deriv incompletas en .env. Motor pausado.");
            return;
        }
        console.log(`[DERIV] Iniciando motor Deriv Sintéticos (Cuenta: ${this.accountId})...`);
        await this.connectWebSocket();
        // Loop de análisis cuantitativo cada 2.5 segundos
        if (!this.analysisInterval) {
            this.analysisInterval = setInterval(() => {
                this.runStrategyAnalysis().catch((err) => {
                    console.error("[DERIV] Error en ciclo de análisis:", err);
                });
            }, 2500);
        }
    }
    stop() {
        if (this.pingInterval)
            clearInterval(this.pingInterval);
        if (this.analysisInterval)
            clearInterval(this.analysisInterval);
        if (this.ws) {
            try {
                this.ws.close();
            }
            catch (_) { }
        }
        this.isConnected = false;
        console.log("[DERIV] Motor Deriv detenido.");
    }
    // --- DERIV WEBSOCKET CONNECTION & OTP ---
    async getOtpUrl() {
        try {
            const res = await fetch(`https://api.derivws.com/trading/v1/options/accounts/${this.accountId}/otp`, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${this.apiKey}`,
                    "Deriv-App-Id": this.appId,
                    "Content-Type": "application/json"
                }
            });
            if (!res.ok) {
                const txt = await res.text();
                console.error(`[DERIV] Error solicitando OTP (${res.status}): ${txt}`);
                return null;
            }
            const json = await res.json();
            return json?.data?.url || null;
        }
        catch (e) {
            console.error("[DERIV] Fallo de red obteniendo OTP:", e);
            return null;
        }
    }
    async connectWebSocket() {
        if (this.isConnecting)
            return;
        this.isConnecting = true;
        try {
            const wsUrl = await this.getOtpUrl();
            if (!wsUrl) {
                console.error("[DERIV] No se pudo obtener URL de WebSocket con OTP. Reintentando en 15s...");
                this.isConnecting = false;
                setTimeout(() => this.connectWebSocket(), 15000);
                return;
            }
            this.ws = new WebSocket(wsUrl);
            this.ws.on("open", () => {
                console.log("[DERIV] WebSocket conectado y autenticado exitosamente.");
                this.isConnected = true;
                this.isConnecting = false;
                // Suscribirse a balance
                this.send({ balance: 1, subscribe: 1 });
                // Suscribirse a los símbolos activos
                for (const sym of this.state.activeSymbols) {
                    this.send({ ticks: sym });
                    console.log(`[DERIV] Suscrito a ticks de ${sym}`);
                }
                // Mantener vivo con ping cada 30s
                if (this.pingInterval)
                    clearInterval(this.pingInterval);
                this.pingInterval = setInterval(() => {
                    if (this.isConnected && this.ws?.readyState === WebSocket.OPEN) {
                        this.send({ ping: 1 });
                    }
                }, 30000);
            });
            this.ws.on("message", (raw) => {
                this.handleMessage(raw);
            });
            this.ws.on("close", (code, reason) => {
                console.warn(`[DERIV] WebSocket desconectado (${code}): ${reason.toString()}. Reanudando en 5s...`);
                this.isConnected = false;
                this.isConnecting = false;
                setTimeout(() => this.connectWebSocket(), 5000);
            });
            this.ws.on("error", (err) => {
                console.error("[DERIV] Error en WebSocket:", err.message);
            });
        }
        catch (e) {
            console.error("[DERIV] Excepción al conectar WebSocket:", e);
            this.isConnecting = false;
            setTimeout(() => this.connectWebSocket(), 10000);
        }
    }
    send(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
        }
    }
    // --- MESSAGE HANDLER ---
    handleMessage(raw) {
        try {
            const data = JSON.parse(raw.toString());
            const msgType = data.msg_type;
            if (msgType === "balance") {
                const bal = data.balance?.balance;
                if (typeof bal === "number") {
                    this.state.balanceUsdt = bal;
                    this.saveState();
                }
            }
            else if (msgType === "tick") {
                const tick = data.tick;
                if (tick && tick.symbol && typeof tick.quote === "number") {
                    this.storeTick(tick.symbol, tick.quote, tick.epoch || Math.floor(Date.now() / 1000));
                }
            }
            else if (msgType === "proposal") {
                // Respuesta de cotización para una orden
                if (data.proposal && data.echo_req?.req_id) {
                    this.handleProposalResponse(data);
                }
            }
            else if (msgType === "buy") {
                this.handleBuyResponse(data);
            }
            else if (msgType === "proposal_open_contract") {
                this.handleContractUpdate(data.proposal_open_contract);
            }
        }
        catch (e) {
            console.error("[DERIV] Error procesando mensaje WS:", e);
        }
    }
    storeTick(symbol, quote, epoch) {
        if (!this.tickHistory.has(symbol)) {
            this.tickHistory.set(symbol, []);
        }
        const list = this.tickHistory.get(symbol);
        list.push({ quote, epoch });
        if (list.length > 100) {
            list.shift(); // Guardar los últimos 100 ticks
        }
    }
    // --- STRATEGY ENGINE & QUANTITATIVE SIGNALS ---
    async runStrategyAnalysis() {
        // Sincronización dinámica inmediata con .strategy-controls.json (UI y DB)
        try {
            const ctrlFile = path.resolve(process.cwd(), ".strategy-controls.json");
            if (fs.existsSync(ctrlFile)) {
                const ctrls = JSON.parse(fs.readFileSync(ctrlFile, "utf8"));
                if (ctrls?.strategies && typeof ctrls.strategies.deriv === "boolean") {
                    if (this.state.enabled !== ctrls.strategies.deriv) {
                        this.state.enabled = ctrls.strategies.deriv;
                        this.saveState();
                    }
                }
            }
        }
        catch { }
        if (!this.state.enabled || !this.isConnected)
            return;
        // Reset diario de PnL
        const today = new Date().toISOString().split("T")[0];
        if (this.state.lastDailyReset !== today) {
            this.state.lastDailyReset = today;
            this.state.dailyRealizedPnl = 0.0;
            this.saveState();
        }
        // Circuit breakers diarios
        if (this.state.dailyRealizedPnl >= this.state.dailyProfitTarget) {
            return; // Meta diaria alcanzada
        }
        if (this.state.dailyRealizedPnl <= -this.state.dailyStopLoss) {
            return; // Stop loss diario alcanzado
        }
        // Máximo de trades concurrentes (disciplina estricta)
        if (this.positions.length >= this.state.maxConcurrentTrades) {
            return;
        }
        // Analizar cada símbolo
        for (const symbol of this.state.activeSymbols) {
            if (this.positions.length >= this.state.maxConcurrentTrades)
                break;
            const cooldown = this.symbolCooldowns.get(symbol) || 0;
            if (Date.now() < cooldown)
                continue;
            const ticks = this.tickHistory.get(symbol);
            if (!ticks || ticks.length < 30)
                continue; // Necesitamos al menos 30 ticks para cálculo confiable
            const signal = this.calculateSignal(symbol, ticks);
            if (signal) {
                console.log(`[DERIV] 🎯 Señal detectada en ${symbol}: ${signal.type} | Razón: ${signal.rationale}`);
                this.symbolCooldowns.set(symbol, Date.now() + 45000); // 45s de descanso entre entradas del mismo símbolo
                await this.executeTrade(symbol, signal.type, signal.rationale);
            }
        }
    }
    calculateSignal(symbol, ticks) {
        const quotes = ticks.map((t) => t.quote);
        const n = quotes.length;
        const currentPrice = quotes[n - 1];
        // Cálculo de RSI (período 9 ticks)
        const rsi = this.calculateRSI(quotes, 9);
        // Cálculo de EMAs rápidas (5 ticks) y lentas (15 ticks)
        const emaFast = this.calculateEMA(quotes, 5);
        const emaSlow = this.calculateEMA(quotes, 15);
        // Estrategia 1: Momentum Pullback Extremo
        // Si RSI está en sobreventa (< 22) y el precio supera la EMA rápida -> Rebote inminente (CALL)
        if (rsi < 24 && currentPrice > emaFast && emaFast > emaSlow) {
            return {
                type: "CALL",
                rationale: `RSI Oversold Extremo (${rsi.toFixed(1)}) + Rebote alcista sobre EMA(5) en ${symbol}`
            };
        }
        // Si RSI está en sobrecompra (> 76) y el precio quiebra por debajo de la EMA rápida -> Corrección inminente (PUT)
        if (rsi > 76 && currentPrice < emaFast && emaFast < emaSlow) {
            return {
                type: "PUT",
                rationale: `RSI Overbought Extremo (${rsi.toFixed(1)}) + Quiebre bajista bajo EMA(5) en ${symbol}`
            };
        }
        // Estrategia 2: Golden Cross en Ticks Rápidos (Cruces limpios)
        const prevFast = this.calculateEMA(quotes.slice(0, n - 1), 5);
        const prevSlow = this.calculateEMA(quotes.slice(0, n - 1), 15);
        if (prevFast <= prevSlow && emaFast > emaSlow && rsi > 45 && rsi < 65) {
            return {
                type: "CALL",
                rationale: `Tick Golden Cross (EMA 5 cruzó EMA 15 hacia arriba) con RSI neutral (${rsi.toFixed(1)})`
            };
        }
        if (prevFast >= prevSlow && emaFast < emaSlow && rsi > 35 && rsi < 55) {
            return {
                type: "PUT",
                rationale: `Tick Death Cross (EMA 5 cruzó EMA 15 hacia abajo) con RSI neutral (${rsi.toFixed(1)})`
            };
        }
        return null;
    }
    calculateRSI(prices, period) {
        if (prices.length <= period)
            return 50;
        let gains = 0;
        let losses = 0;
        for (let i = prices.length - period; i < prices.length; i++) {
            const diff = prices[i] - prices[i - 1];
            if (diff >= 0)
                gains += diff;
            else
                losses -= diff;
        }
        if (losses === 0)
            return 100;
        const rs = gains / losses;
        return 100 - (100 / (1 + rs));
    }
    calculateEMA(prices, period) {
        if (prices.length === 0)
            return 0;
        const k = 2 / (period + 1);
        let ema = prices[0];
        for (let i = 1; i < prices.length; i++) {
            ema = prices[i] * k + ema * (1 - k);
        }
        return ema;
    }
    // --- TRADE EXECUTION ---
    pendingProposals = new Map();
    reqIdCounter = 100;
    async executeTrade(symbol, contractType, rationale) {
        if (!this.isConnected || !this.ws)
            return;
        const reqId = ++this.reqIdCounter;
        this.pendingProposals.set(reqId, { symbol, contractType, rationale });
        // Solicitar propuesta oficial a Deriv
        this.send({
            proposal: 1,
            amount: this.state.defaultStake,
            basis: "stake",
            contract_type: contractType,
            currency: "USD",
            duration: this.state.defaultDurationTicks,
            duration_unit: "t",
            underlying_symbol: symbol,
            req_id: reqId
        });
    }
    handleProposalResponse(data) {
        const reqId = data.echo_req?.req_id;
        const meta = this.pendingProposals.get(reqId);
        if (!meta)
            return;
        this.pendingProposals.delete(reqId);
        const proposal = data.proposal;
        if (!proposal || !proposal.id) {
            console.warn(`[DERIV] No se pudo obtener propuesta válida para ${meta.symbol}:`, data.error?.message);
            return;
        }
        console.log(`[DERIV] Comprando contrato ${meta.contractType} en ${meta.symbol} (Stake: $${proposal.ask_price}, Payout: $${proposal.payout})...`);
        // Ejecutar compra del contrato
        this.send({
            buy: proposal.id,
            price: proposal.ask_price,
            subscribe: 1,
            passthrough: {
                symbol: meta.symbol,
                contractType: meta.contractType,
                rationale: meta.rationale,
                expectedPayout: proposal.payout
            }
        });
    }
    handleBuyResponse(data) {
        const buy = data.buy;
        if (!buy || !buy.contract_id) {
            console.error("[DERIV] Error al comprar contrato:", data.error?.message);
            return;
        }
        const pt = data.echo_req?.passthrough || {};
        const contractId = String(buy.contract_id);
        const pos = {
            contractId,
            symbol: pt.symbol || "R_75",
            contractType: pt.contractType || "CALL",
            stake: buy.buy_price || this.state.defaultStake,
            entrySpot: buy.start_time || 0,
            entryTime: Date.now(),
            duration: this.state.defaultDurationTicks,
            durationUnit: "ticks",
            payoutExpected: pt.expectedPayout || buy.payout || 0,
            status: "open",
            currentProfit: 0,
            rationale: pt.rationale || "Algoritmo Cuantitativo de Momentum"
        };
        this.positions.push(pos);
        this.savePositions();
        this.state.lastTradeTime = Date.now();
        this.saveState();
        // Notificar apertura a Telegram
        const msg = `🎰 <b>DERIV SINTÉTICOS: OPERACIÓN EJECUTADA</b>\n\n` +
            `• <b>Contrato:</b> ${pos.contractType === "CALL" ? "🟢 ALZA (CALL)" : "🔴 BAJA (PUT)"}\n` +
            `• <b>Índice:</b> <code>${pos.symbol}</code>\n` +
            `• <b>Monto Arriesgado (Stake):</b> $${pos.stake.toFixed(2)} USD\n` +
            `• <b>Duración:</b> ${pos.duration} ticks (~10 seg)\n` +
            `• <b>Ganancia Estimada:</b> +$${(pos.payoutExpected - pos.stake).toFixed(2)} USD\n` +
            `• <b>Motivo Cuantitativo:</b> ${pos.rationale}\n\n` +
            `🛡️ <b>Modo Demo Oficial:</b> Cuenta <code>${this.accountId}</code> con $${this.state.balanceUsdt.toFixed(2)} USD`;
        this.notifier.send(msg).catch(() => { });
        // Suscribir a actualizaciones del contrato
        this.send({
            proposal_open_contract: 1,
            contract_id: buy.contract_id,
            subscribe: 1
        });
    }
    handleContractUpdate(poc) {
        if (!poc || !poc.contract_id)
            return;
        const contractId = String(poc.contract_id);
        const posIdx = this.positions.findIndex((p) => p.contractId === contractId);
        if (posIdx === -1)
            return;
        const pos = this.positions[posIdx];
        pos.currentProfit = poc.profit || 0;
        if (poc.is_sold === 1) {
            // Contrato finalizado
            const isWon = poc.status === "won";
            const netProfit = poc.profit;
            const trade = {
                contractId: pos.contractId,
                symbol: pos.symbol,
                contractType: pos.contractType,
                stake: pos.stake,
                payout: poc.payout || 0,
                profit: netProfit,
                entrySpot: poc.entry_tick || poc.barrier || 0,
                exitSpot: poc.exit_tick || 0,
                entryTime: pos.entryTime,
                exitTime: Date.now(),
                durationSec: Math.round((Date.now() - pos.entryTime) / 1000),
                status: isWon ? "won" : "lost",
                rationale: pos.rationale
            };
            // Remover posición abierta y guardar trade histórico
            this.positions.splice(posIdx, 1);
            this.trades.unshift(trade);
            if (this.trades.length > 200)
                this.trades.pop();
            // Actualizar métricas acumuladas
            if (isWon) {
                this.state.winsCount++;
            }
            else {
                this.state.lossesCount++;
            }
            this.state.totalProfitUsdt += netProfit;
            this.state.dailyRealizedPnl += netProfit;
            const totalTrades = this.state.winsCount + this.state.lossesCount;
            this.state.winRatePct = totalTrades > 0 ? (this.state.winsCount / totalTrades) * 100 : 0;
            this.savePositions();
            this.saveTrades();
            this.saveState();
            // Notificación inmediata a Telegram del resultado
            const icon = isWon ? "🏆" : "⚠️";
            const outcomeText = isWon ? "¡OPERACIÓN GANADA!" : "OPERACIÓN CERRADA EN PÉRDIDA";
            const profitFormatted = isWon
                ? `+$${netProfit.toFixed(2)} USD`
                : `-$${Math.abs(netProfit).toFixed(2)} USD`;
            const closeMsg = `${icon} <b>DERIV SINTÉTICOS: ${outcomeText}</b>\n\n` +
                `• <b>Índice:</b> <code>${trade.symbol}</code> (${trade.contractType})\n` +
                `• <b>Resultado Neto:</b> <b>${profitFormatted}</b>\n` +
                `• <b>Duración:</b> ${trade.durationSec}s\n` +
                `• <b>Balance Demo Actual:</b> $${this.state.balanceUsdt.toFixed(2)} USD\n` +
                `• <b>Win Rate Global:</b> ${this.state.winRatePct.toFixed(1)}% (${this.state.winsCount}W / ${this.state.lossesCount}L)\n` +
                `• <b>PnL Acumulado:</b> ${this.state.totalProfitUsdt >= 0 ? "+" : ""}$${this.state.totalProfitUsdt.toFixed(2)} USD`;
            this.notifier.send(closeMsg).catch(() => { });
        }
        else {
            this.savePositions();
        }
    }
    // --- TELEMETRY & CONTROLS ---
    getTelemetry() {
        return {
            connected: this.isConnected,
            state: this.state,
            openPositions: this.positions,
            recentTrades: this.trades.slice(0, 20),
            metrics: {
                balance: this.state.balanceUsdt,
                totalProfit: this.state.totalProfitUsdt,
                dailyProfit: this.state.dailyRealizedPnl,
                winRate: this.state.winRatePct,
                totalTrades: this.state.winsCount + this.state.lossesCount,
                wins: this.state.winsCount,
                losses: this.state.lossesCount,
                openPositionsCount: this.positions.length
            }
        };
    }
    isEnabled() {
        return this.state.enabled;
    }
    getState() {
        return { ...this.state };
    }
    setEnabled(enabled) {
        this.state.enabled = enabled;
        this.saveState();
    }
    setStake(stake) {
        if (stake >= 0.35 && stake <= 100) {
            this.state.defaultStake = stake;
            this.saveState();
        }
    }
}
// Instancia singleton compartida
export const derivEngine = new DerivEngine();
