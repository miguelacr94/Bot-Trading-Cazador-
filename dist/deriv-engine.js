import WebSocket from "ws";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { TelegramNotifier } from "./notifier.js";
dotenv.config();
try {
    const envPath = path.resolve(process.cwd(), ".env");
    if (fs.existsSync(envPath))
        dotenv.config({ path: envPath });
}
catch { }
export const SYMBOL_MULTIPLIERS = {
    "1HZ100V": 100,
    "1HZ75V": 100,
    "1HZ50V": 200,
    "1HZ25V": 400,
    "1HZ10V": 1000,
    "R_100": 100,
    "R_75": 100,
    "R_50": 200
};
export class DerivEngine {
    notifier;
    stateFile;
    positionsFile;
    tradesFile;
    radarFile;
    state;
    positions = [];
    trades = [];
    apiKey;
    appId;
    accountId;
    demoAccountId;
    realAccountId;
    ws = null;
    isConnected = false;
    isConnecting = false;
    pingInterval = null;
    analysisInterval = null;
    // Real-time market tick buffers per symbol
    tickHistory = new Map();
    symbolCooldowns = new Map();
    pendingProposals = new Map();
    reqIdCounter = 500;
    isSellingContract = false;
    lastTickReceived = 0;
    constructor() {
        this.notifier = new TelegramNotifier();
        const cwd = process.cwd();
        this.stateFile = path.resolve(cwd, ".deriv-state.json");
        this.positionsFile = path.resolve(cwd, ".deriv-positions.json");
        this.tradesFile = path.resolve(cwd, ".deriv-trades.json");
        this.radarFile = path.resolve(cwd, ".deriv-radar.json");
        this.apiKey = process.env.DERIV_KEY || "";
        this.appId = process.env.DERIV_APP_ID || "";
        this.demoAccountId = process.env.DERIV_DEMO_ACCOUNT_ID || "DOT95084693";
        this.realAccountId = process.env.DERIV_REAL_ACCOUNT_ID || "ROT92884781";
        this.state = this.loadState();
        // Protección absoluta: arranca en DEMO si no se especifica
        this.accountId = this.state.isSimulated ? this.demoAccountId : this.realAccountId;
        this.state.accountId = this.accountId;
        this.positions = this.loadPositions();
        this.trades = this.loadTrades();
    }
    // --- PERSISTENCE ---
    loadState() {
        const defaultState = {
            enabled: true,
            isSimulated: true, // 100% DEMO OFICIAL PARA PRUEBAS SIN RIESGO
            accountId: this.demoAccountId,
            appId: this.appId,
            balanceUsdt: 10000.0,
            startingBalanceUsdt: 10000.0,
            totalProfitUsdt: 0.0,
            winsCount: 0,
            lossesCount: 0,
            winRatePct: 0.0,
            defaultStake: 1.0, // $1.00 USD (mínimo permitido para Multiplicadores)
            defaultStopLoss: 0.30, // -$0.30 USD (Stop loss garantizado sin deslizamiento)
            defaultTakeProfit: 0.80, // +$0.80 USD (Take profit inicial)
            trailingTriggerProfit: 0.35, // +$0.35 USD (Activa Trailing Take Profit)
            trailingCallback: 0.15, // $0.15 USD (Cierra si retrocede 0.15 desde el pico)
            defaultDurationTicks: 0, // No aplica duración fija en Multiplicadores
            maxConcurrentTrades: 1, // Disciplina estricta
            dailyProfitTarget: 5.0, // Meta diaria +$5.00 USD
            dailyStopLoss: 2.0, // Stop-loss diario -$2.00 USD
            dailyRealizedPnl: 0.0,
            lastDailyReset: new Date().toISOString().split("T")[0],
            activeSymbols: ["1HZ100V", "1HZ75V", "1HZ50V", "R_100", "R_75"],
            lastTradeTime: 0,
            consecutiveLosses: 0,
            maxConsecutiveLosses: 3,
            cooldownMinutes: 20,
            pauseUntil: 0,
            capitalFloorUsdt: 10.0,
            maxStakePctOfBalance: 15
        };
        try {
            if (fs.existsSync(this.stateFile)) {
                const raw = fs.readFileSync(this.stateFile, "utf8");
                return { ...defaultState, ...JSON.parse(raw) };
            }
        }
        catch (e) {
            console.error("[DERIV MULTIPLIER] Error loading state:", e);
        }
        return defaultState;
    }
    saveState() {
        try {
            fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2), "utf8");
        }
        catch (e) {
            console.error("[DERIV MULTIPLIER] Error saving state:", e);
        }
    }
    loadPositions() {
        try {
            if (fs.existsSync(this.positionsFile)) {
                return JSON.parse(fs.readFileSync(this.positionsFile, "utf8"));
            }
        }
        catch (e) {
            console.error("[DERIV MULTIPLIER] Error loading positions:", e);
        }
        return [];
    }
    savePositions() {
        try {
            fs.writeFileSync(this.positionsFile, JSON.stringify(this.positions, null, 2), "utf8");
        }
        catch (e) {
            console.error("[DERIV MULTIPLIER] Error saving positions:", e);
        }
    }
    loadTrades() {
        try {
            if (fs.existsSync(this.tradesFile)) {
                return JSON.parse(fs.readFileSync(this.tradesFile, "utf8"));
            }
        }
        catch (e) {
            console.error("[DERIV MULTIPLIER] Error loading trades:", e);
        }
        return [];
    }
    saveTrades() {
        try {
            fs.writeFileSync(this.tradesFile, JSON.stringify(this.trades, null, 2), "utf8");
        }
        catch (e) {
            console.error("[DERIV MULTIPLIER] Error saving trades:", e);
        }
    }
    // --- ENGINE LIFECYCLE ---
    async start() {
        if (!this.apiKey)
            this.apiKey = process.env.DERIV_KEY || "";
        if (!this.appId)
            this.appId = process.env.DERIV_APP_ID || "";
        this.accountId = this.state.isSimulated ? this.demoAccountId : this.realAccountId;
        this.state.accountId = this.accountId;
        if (!this.apiKey || !this.appId || !this.accountId) {
            console.warn("[DERIV MULTIPLIER] Credenciales de Deriv incompletas en .env. Motor pausado.");
            return;
        }
        console.log(`[DERIV MULTIPLIER] Iniciando motor de Multiplicadores con Trailing TP (Cuenta: ${this.accountId} | ${this.state.isSimulated ? "DEMO" : "REAL"})...`);
        await this.connectWebSocket();
        // Loop de análisis cuantitativo cada 2.5 segundos
        if (!this.analysisInterval) {
            this.analysisInterval = setInterval(() => {
                this.runStrategyAnalysis().catch((err) => {
                    console.error("[DERIV MULTIPLIER] Error en ciclo de análisis:", err);
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
        console.log("[DERIV MULTIPLIER] Motor detenido.");
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
                console.error(`[DERIV MULTIPLIER] Error solicitando OTP (${res.status}): ${txt}`);
                return null;
            }
            const json = await res.json();
            return json?.data?.url || null;
        }
        catch (e) {
            console.error("[DERIV MULTIPLIER] Fallo de red obteniendo OTP:", e);
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
                console.error("[DERIV MULTIPLIER] No se pudo obtener URL de WebSocket con OTP. Reintentando en 15s...");
                this.isConnecting = false;
                setTimeout(() => this.connectWebSocket(), 15000);
                return;
            }
            this.ws = new WebSocket(wsUrl);
            this.ws.on("open", () => {
                console.log(`[DERIV MULTIPLIER] WebSocket conectado exitosamente a ${this.state.isSimulated ? "DEMO" : "REAL"} (${this.accountId}).`);
                this.isConnected = true;
                this.isConnecting = false;
                // Suscribirse a balance
                this.send({ balance: 1, subscribe: 1 });
                // Suscribirse a los símbolos activos con streaming continuo
                for (const sym of this.state.activeSymbols) {
                    this.send({ ticks: sym, subscribe: 1 });
                    console.log(`[DERIV MULTIPLIER] Suscrito a streaming de ${sym}`);
                }
                // Si había una posición abierta, resuscribirse a su contrato con contract_id numérico
                if (this.positions.length > 0) {
                    const pos = this.positions[0];
                    const cIdNum = parseInt(pos.contractId, 10);
                    console.log(`[DERIV MULTIPLIER] Reconectando a posición abierta ${pos.contractId} (numérico: ${cIdNum})...`);
                    this.send({ proposal_open_contract: 1, contract_id: cIdNum, subscribe: 1 });
                }
                // Keepalive ping cada 30s
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
                console.warn(`[DERIV MULTIPLIER] WebSocket desconectado (${code}): ${reason.toString()}. Reanudando en 5s...`);
                this.isConnected = false;
                this.isConnecting = false;
                setTimeout(() => this.connectWebSocket(), 5000);
            });
            this.ws.on("error", (err) => {
                console.error("[DERIV MULTIPLIER] Error en WebSocket:", err.message);
            });
        }
        catch (e) {
            console.error("[DERIV MULTIPLIER] Excepción al conectar WebSocket:", e);
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
                const loginid = data.balance?.loginid;
                if (typeof bal === "number") {
                    this.state.balanceUsdt = bal;
                    if (loginid) {
                        this.state.accountId = loginid;
                        this.accountId = loginid;
                        this.state.isSimulated = loginid.startsWith("DOT");
                    }
                    if (!this.state.startingBalanceUsdt || this.state.startingBalanceUsdt <= 0) {
                        this.state.startingBalanceUsdt = bal;
                    }
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
                this.handleProposalResponse(data);
            }
            else if (msgType === "buy") {
                this.handleBuyResponse(data);
            }
            else if (msgType === "proposal_open_contract") {
                if (data.error) {
                    console.error("[DERIV MULTIPLIER] Error en proposal_open_contract:", data.error.message || data.error);
                    const reqContractId = data.echo_req?.contract_id;
                    if (reqContractId) {
                        const cIdStr = String(reqContractId);
                        const idx = this.positions.findIndex((p) => p.contractId === cIdStr);
                        if (idx >= 0) {
                            console.warn(`[DERIV MULTIPLIER] 🧹 Limpiando posición huérfana/inválida ${cIdStr} tras error devuelto por Deriv.`);
                            this.positions.splice(idx, 1);
                            this.savePositions();
                        }
                    }
                }
                else if (data.proposal_open_contract) {
                    this.handleContractUpdate(data.proposal_open_contract);
                }
            }
            else if (msgType === "sell") {
                this.isSellingContract = false;
                console.log(`[DERIV MULTIPLIER] Venta confirmada por Deriv. Sold for: ${data.sell?.sold_for}`);
            }
        }
        catch (e) {
            console.error("[DERIV MULTIPLIER] Error procesando mensaje WS:", e);
        }
    }
    isAnalyzing = false;
    async triggerAnalysis() {
        if (this.isAnalyzing || !this.state.enabled || !this.isConnected)
            return;
        this.isAnalyzing = true;
        try {
            await this.runStrategyAnalysis();
        }
        catch (e) {
            console.error("[DERIV MULTIPLIER] Error analizando tick:", e);
        }
        finally {
            this.isAnalyzing = false;
        }
    }
    lastRadarSave = 0;
    storeTick(symbol, quote, epoch) {
        this.lastTickReceived = Date.now();
        if (!this.tickHistory.has(symbol)) {
            this.tickHistory.set(symbol, []);
        }
        const list = this.tickHistory.get(symbol);
        list.push({ quote, epoch });
        if (list.length > 100) {
            list.shift();
        }
        if (Date.now() - this.lastRadarSave > 4000) {
            this.lastRadarSave = Date.now();
            this.saveRadarSnapshot();
        }
        // DISPARO REACTIVO EN TIEMPO REAL: Analizar inmediatamente con cada tick
        this.triggerAnalysis().catch(() => { });
    }
    saveRadarSnapshot() {
        try {
            const radar = this.getRadar();
            fs.writeFileSync(this.radarFile, JSON.stringify(radar, null, 2), "utf8");
        }
        catch { }
    }
    getRadar() {
        return this.state.activeSymbols.map((sym) => {
            const ticks = this.tickHistory.get(sym) || [];
            const quotes = ticks.map((t) => t.quote);
            const curPrice = quotes.length > 0 ? quotes[quotes.length - 1] : 0;
            const prevPrice = quotes.length > 1 ? quotes[quotes.length - 2] : curPrice;
            const rsi = quotes.length >= 14 ? this.calculateRSI(quotes, 14) : 50;
            const emaFast = quotes.length >= 8 ? this.calculateEMA(quotes, 8) : curPrice;
            const emaSlow = quotes.length >= 20 ? this.calculateEMA(quotes, 20) : curPrice;
            const isUptrend = emaFast > emaSlow;
            const isDowntrend = emaFast < emaSlow;
            const trend = isUptrend ? "ALCISTA (UP)" : isDowntrend ? "BAJISTA (DOWN)" : "LATERAL";
            const changeTick = curPrice - prevPrice;
            // 🎯 CÁLCULO DE RACHA DE TICKS CONSECUTIVOS (STREAK EN VIVO)
            let consecutiveCount = 0;
            let consecutiveDirection = "FLAT";
            if (quotes.length >= 2) {
                const lastChange = quotes[quotes.length - 1] - quotes[quotes.length - 2];
                if (lastChange > 0) {
                    consecutiveDirection = "UP";
                }
                else if (lastChange < 0) {
                    consecutiveDirection = "DOWN";
                }
                if (consecutiveDirection !== "FLAT") {
                    for (let i = quotes.length - 1; i > 0; i--) {
                        const diff = quotes[i] - quotes[i - 1];
                        if ((consecutiveDirection === "UP" && diff > 0) || (consecutiveDirection === "DOWN" && diff < 0)) {
                            consecutiveCount++;
                        }
                        else {
                            break;
                        }
                    }
                }
            }
            // Cinta visual de los últimos 12 ticks con su delta exacto y dirección
            const recentTicks = quotes.slice(-12).map((q, idx, arr) => {
                const prev = idx > 0 ? arr[idx - 1] : q;
                const diff = q - prev;
                const dir = diff > 0 ? "UP" : diff < 0 ? "DOWN" : "FLAT";
                return {
                    price: q,
                    diff: parseFloat(diff.toFixed(4)),
                    dir
                };
            });
            // Racha requerida para disparo (mínimo 2 ticks en tendencia)
            const isUpStreak = isUptrend && consecutiveDirection === "UP";
            const isDownStreak = isDowntrend && consecutiveDirection === "DOWN";
            const requiredConsecutiveMet = (isUpStreak || isDownStreak) && consecutiveCount >= 2;
            // Estado cualitativo
            let status = "Esperando señal";
            let statusBadge = "VIGILANDO";
            let statusColor = "#94a3b8";
            if (isUptrend && rsi >= 45 && rsi <= 78) {
                status = requiredConsecutiveMet ? "🔥 Gatillo MULTUP confirmado" : "Impulso alcista en formación (MULTUP)";
                statusBadge = requiredConsecutiveMet ? "DISPARO" : "BULLISH";
                statusColor = "#10b981";
            }
            else if (isDowntrend && rsi >= 22 && rsi <= 55) {
                status = requiredConsecutiveMet ? "🔥 Gatillo MULTDOWN confirmado" : "Impulso bajista en formación (MULTDOWN)";
                statusBadge = requiredConsecutiveMet ? "DISPARO" : "BEARISH";
                statusColor = "#ef4444";
            }
            // 📊 BARRA DE PROGRESO DE CONVERGENCIA HACIA EL DISPARO (0% a 100%)
            let readinessScore = 0;
            let readinessReason = "Acumulando ticks...";
            if (quotes.length < 20) {
                readinessScore = Math.min(30, Math.round((quotes.length / 20) * 30));
                readinessReason = `Acumulando buffer (${quotes.length}/20 ticks)`;
            }
            else {
                let score = 30; // 1. Base buffer cumplido (30%)
                // 2. Tendencia definida (+30%)
                if (isUptrend || isDowntrend) {
                    score += 30;
                }
                // 3. RSI en zona de momentum (+20%)
                const rsiInZone = (isUptrend && rsi >= 45 && rsi <= 78) || (isDowntrend && rsi >= 22 && rsi <= 55);
                if (rsiInZone) {
                    score += 20;
                }
                else if (rsi >= 35 && rsi <= 65) {
                    score += 10;
                }
                // 4. Ticks de confirmación (+10% por 1er tick, +20% por 2º tick)
                if (isUpStreak || isDownStreak) {
                    if (consecutiveCount >= 2) {
                        score += 20; // 100% ➔ DISPARO INMINENTE
                    }
                    else if (consecutiveCount === 1) {
                        score += 10; // 90%
                    }
                }
                readinessScore = Math.min(100, Math.max(25, score));
                if (readinessScore >= 95) {
                    readinessReason = `🔥 ¡Gatillo listo! (2 ticks en tendencia, disparando)`;
                }
                else if (readinessScore >= 80) {
                    readinessReason = `⚡ Esperando confirmación de 2º tick (${consecutiveCount}/2 ticks)`;
                }
                else if (readinessScore >= 60) {
                    readinessReason = `📈 Tendencia definida, esperando ticks de impulso`;
                }
                else {
                    readinessReason = `⏳ Mercado lateral o consolidando`;
                }
            }
            return {
                symbol: sym,
                multiplier: SYMBOL_MULTIPLIERS[sym] || 100,
                price: curPrice,
                prevPrice,
                changeTick: parseFloat(changeTick.toFixed(4)),
                rsi: parseFloat(rsi.toFixed(1)),
                emaFast: parseFloat(emaFast.toFixed(2)),
                emaSlow: parseFloat(emaSlow.toFixed(2)),
                trend,
                ticksBuffered: quotes.length,
                status,
                statusBadge,
                statusColor,
                readinessScore,
                readinessReason,
                consecutiveCount,
                consecutiveDirection,
                recentTicks,
                requiredConsecutiveMet,
                lastUpdate: Date.now()
            };
        });
    }
    // --- STRATEGY ENGINE & QUANTITATIVE SIGNALS ---
    async runStrategyAnalysis() {
        // Sincronización con .deriv-state.json
        try {
            const stateF = path.resolve(process.cwd(), ".deriv-state.json");
            if (fs.existsSync(stateF)) {
                const diskState = JSON.parse(fs.readFileSync(stateF, "utf8"));
                if (typeof diskState.enabled === "boolean" && this.state.enabled !== diskState.enabled) {
                    this.state.enabled = diskState.enabled;
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
        if (this.state.dailyRealizedPnl >= this.state.dailyProfitTarget)
            return;
        if (this.state.dailyRealizedPnl <= -this.state.dailyStopLoss)
            return;
        // BLINDAJE 1: Pausa de enfriamiento tras racha de pérdidas
        if (Date.now() < (this.state.pauseUntil || 0))
            return;
        // Máximo de trades concurrentes (1 posición a la vez)
        if (this.positions.length >= this.state.maxConcurrentTrades)
            return;
        // Cooldown anti-sobreoperativa: mínimo 45 segundos de descanso entre operaciones
        if (Date.now() - this.state.lastTradeTime < 45000)
            return;
        // Analizar cada símbolo
        for (const symbol of this.state.activeSymbols) {
            if (this.positions.length >= this.state.maxConcurrentTrades)
                break;
            const cooldown = this.symbolCooldowns.get(symbol) || 0;
            if (Date.now() < cooldown)
                continue;
            const ticks = this.tickHistory.get(symbol);
            if (!ticks || ticks.length < 20)
                continue;
            const signal = this.calculateSignal(symbol, ticks);
            if (signal) {
                console.log(`[DERIV MULTIPLIER] 🎯 Señal confirmada en ${symbol}: ${signal.type} | ${signal.rationale}`);
                this.symbolCooldowns.set(symbol, Date.now() + 60000); // 60s de descanso en el mismo símbolo
                await this.executeMultiplierTrade(symbol, signal.type, signal.rationale);
                break;
            }
        }
    }
    calculateSignal(symbol, ticks) {
        const quotes = ticks.map((t) => t.quote);
        const n = quotes.length;
        if (n < 20)
            return null;
        const currentPrice = quotes[n - 1];
        const prevPrice = quotes[n - 2];
        const prev2Price = quotes[n - 3];
        // Momentum RSI (período 14 ticks)
        const rsi = this.calculateRSI(quotes, 14);
        // Medias Móviles Institucionales: Rápida (EMA 8) vs Lenta (EMA 20)
        const emaFast = this.calculateEMA(quotes, 8);
        const emaSlow = this.calculateEMA(quotes, 20);
        const isUptrend = emaFast > emaSlow;
        const isDowntrend = emaFast < emaSlow;
        // === ESTRATEGIA 1: MULTUP (ALZA) ===
        if (isUptrend && rsi >= 45 && rsi <= 78) {
            // Gatillo A: 2 ticks verdes consecutivos en dirección alcista
            if (currentPrice > prevPrice && prevPrice >= prev2Price) {
                return {
                    type: "MULTUP",
                    rationale: `🚀 Impulso Alcista: 2 ticks verdes en tendencia EMA(8 > 20) | RSI: ${rsi.toFixed(1)}`
                };
            }
            // Gatillo B: Rebote en EMA Rápida
            if (currentPrice > emaFast && prevPrice <= emaFast * 1.0008) {
                return {
                    type: "MULTUP",
                    rationale: `📈 Rebote en EMA(8) en tendencia alcista | RSI: ${rsi.toFixed(1)}`
                };
            }
        }
        // === ESTRATEGIA 2: MULTDOWN (BAJA) ===
        if (isDowntrend && rsi >= 22 && rsi <= 55) {
            // Gatillo A: 2 ticks rojos consecutivos en dirección bajista
            if (currentPrice < prevPrice && prevPrice <= prev2Price) {
                return {
                    type: "MULTDOWN",
                    rationale: `🔻 Cascada Bajista: 2 ticks rojos en tendencia EMA(8 < 20) | RSI: ${rsi.toFixed(1)}`
                };
            }
            // Gatillo B: Rechazo en EMA Rápida
            if (currentPrice < emaFast && prevPrice >= emaFast * 0.9992) {
                return {
                    type: "MULTDOWN",
                    rationale: `📉 Rechazo en EMA(8) en tendencia bajista | RSI: ${rsi.toFixed(1)}`
                };
            }
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
    // --- MULTIPLIER EXECUTION ---
    async executeMultiplierTrade(symbol, contractType, rationale) {
        if (!this.isConnected || !this.ws)
            return;
        const multiplier = SYMBOL_MULTIPLIERS[symbol] || 100;
        const reqId = ++this.reqIdCounter;
        this.pendingProposals.set(reqId, { symbol, contractType, multiplier, rationale });
        console.log(`[DERIV MULTIPLIER] Solicitando cotización para ${symbol} (${contractType} x${multiplier}, SL: -$${this.state.defaultStopLoss}, TP: +$${this.state.defaultTakeProfit})...`);
        this.send({
            proposal: 1,
            req_id: reqId,
            amount: this.state.defaultStake,
            basis: "stake",
            contract_type: contractType,
            currency: "USD",
            underlying_symbol: symbol,
            multiplier,
            limit_order: {
                stop_loss: this.state.defaultStopLoss,
                take_profit: this.state.defaultTakeProfit
            }
        });
    }
    handleProposalResponse(data) {
        const reqId = data.echo_req?.req_id;
        const meta = this.pendingProposals.get(reqId);
        if (!meta)
            return;
        if (data.error) {
            console.error("[DERIV MULTIPLIER] Error en propuesta de Deriv:", data.error.message || data.error);
            this.pendingProposals.delete(reqId);
            return;
        }
        const proposal = data.proposal;
        if (!proposal || !proposal.id) {
            console.error("[DERIV MULTIPLIER] Propuesta inválida (sin ID):", data);
            this.pendingProposals.delete(reqId);
            return;
        }
        console.log(`[DERIV MULTIPLIER] Cotización recibida (ID: ${proposal.id}). Ejecutando compra...`);
        this.send({
            buy: proposal.id,
            price: proposal.ask_price || this.state.defaultStake,
            req_id: reqId
        });
    }
    handleBuyResponse(data) {
        const reqId = data.echo_req?.req_id;
        const meta = this.pendingProposals.get(reqId);
        if (meta)
            this.pendingProposals.delete(reqId);
        if (data.error) {
            console.error("[DERIV MULTIPLIER] Error comprando contrato en Deriv:", data.error.message || data.error);
            return;
        }
        const buy = data.buy;
        if (!buy || !buy.contract_id) {
            console.error("[DERIV MULTIPLIER] Error comprando contrato (sin contract_id):", data);
            return;
        }
        const contractId = String(buy.contract_id);
        const symbol = meta?.symbol || "UNKNOWN";
        const contractType = meta?.contractType || "MULTUP";
        const multiplier = meta?.multiplier || 100;
        const rationale = meta?.rationale || "Señal de tendencia cuantitativa";
        const newPos = {
            contractId,
            symbol,
            contractType,
            stake: this.state.defaultStake,
            multiplier,
            entrySpot: (buy.entry_spot || buy.entry_tick) ? parseFloat(buy.entry_spot || buy.entry_tick) : 0,
            currentSpot: 0,
            entryTime: Date.now(),
            currentProfit: 0,
            peakProfit: 0,
            stopLossAmount: this.state.defaultStopLoss,
            takeProfitAmount: this.state.defaultTakeProfit,
            trailingActivated: false,
            status: "open",
            rationale
        };
        this.positions = [newPos]; // Solo 1 contrato a la vez
        this.savePositions();
        this.state.lastTradeTime = Date.now();
        this.saveState();
        // Suscribirse a actualizaciones en tiempo real del contrato
        this.send({
            proposal_open_contract: 1,
            contract_id: buy.contract_id,
            subscribe: 1
        });
        console.log(`[DERIV MULTIPLIER] 🚀 Contrato abierto exitosamente: ${symbol} (${contractType} x${multiplier}) ID: ${contractId}`);
        const dirIcon = contractType === "MULTUP" ? "🟢 ALZA (MULTUP)" : "🔴 BAJA (MULTDOWN)";
        const isReal = !this.state.isSimulated;
        if (isReal) {
            this.notifier.send(`🚨🔥 <b>¡ATENCIÓN: OPERACIÓN CON DINERO REAL EN EJECUCIÓN!</b> 🔥🚨\n\n` +
                `• <b>Entorno:</b> <b>DINERO REAL</b> (Cuenta: <code>${this.accountId}</code>)\n` +
                `• <b>Saldo Real Actual:</b> <b>$${this.state.balanceUsdt.toFixed(2)} USD</b>\n` +
                `• <b>Índice:</b> <code>${symbol}</code>\n` +
                `• <b>Dirección:</b> ${dirIcon}\n` +
                `• <b>Multiplicador:</b> <b>x${multiplier}</b>\n` +
                `• <b>Monto en Riesgo:</b> <b>$${this.state.defaultStake.toFixed(2)} USD</b>\n` +
                `• <b>Stop-Loss Garantizado:</b> <b>-$${this.state.defaultStopLoss.toFixed(2)} USD</b>\n` +
                `• <b>Take-Profit Objetivo:</b> +$${this.state.defaultTakeProfit.toFixed(2)} USD\n` +
                `• <b>Trailing TP:</b> Activa en +$${this.state.trailingTriggerProfit.toFixed(2)} USD\n\n` +
                `• <b>Estrategia:</b> <i>${rationale}</i>\n` +
                `🛡️ <i>Tu capital está protegido con Stop-Loss automático garantizado sin deslizamiento.</i>`).catch(() => { });
        }
        else {
            this.notifier.send(`🎯 <b>DERIV MULTIPLICADOR: OPERACIÓN EN EJECUCIÓN</b> 🚀\n\n` +
                `• <b>Índice:</b> <code>${symbol}</code>\n` +
                `• <b>Dirección:</b> ${dirIcon}\n` +
                `• <b>Multiplicador:</b> <b>x${multiplier}</b>\n` +
                `• <b>Monto Arriesgado:</b> $${this.state.defaultStake.toFixed(2)} USD\n` +
                `• <b>Stop-Loss Garantizado:</b> -$${this.state.defaultStopLoss.toFixed(2)} USD\n` +
                `• <b>Take-Profit Objetivo:</b> +$${this.state.defaultTakeProfit.toFixed(2)} USD\n` +
                `• <b>Trailing TP:</b> Activa en +$${this.state.trailingTriggerProfit.toFixed(2)} USD (callback: $${this.state.trailingCallback.toFixed(2)})\n\n` +
                `• <b>Estrategia:</b> <i>${rationale}</i>\n` +
                `💼 <b>Entorno:</b> 🧪 DEMO OFICIAL (Cuenta: <code>${this.accountId}</code>)`).catch(() => { });
        }
    }
    handleContractUpdate(poc) {
        if (!poc || !poc.contract_id)
            return;
        const contractId = String(poc.contract_id);
        const posIndex = this.positions.findIndex((p) => p.contractId === contractId);
        const isSold = poc.is_sold === 1 || poc.status === "sold" || poc.status === "won" || poc.status === "lost";
        const profit = typeof poc.profit === "number" ? poc.profit : parseFloat(poc.profit || "0");
        const currentSpot = typeof poc.current_spot === "number" ? poc.current_spot : parseFloat(poc.current_spot || "0");
        const entrySpot = typeof poc.entry_spot === "number" ? poc.entry_spot : parseFloat(poc.entry_spot || "0");
        // CASO 1: CONTRATO CERRADO (Por Deriv SL/TP o por nuestro Trailing Sell)
        if (isSold) {
            console.log(`[DERIV MULTIPLIER] Contrato ${contractId} FINALIZADO. PnL: ${profit >= 0 ? "+" : ""}$${profit.toFixed(2)} USD`);
            const pos = posIndex >= 0 ? this.positions[posIndex] : null;
            const won = profit > 0;
            let exitReason = "MANUAL";
            if (pos?.trailingActivated && profit > 0) {
                exitReason = "TRAILING_TP";
            }
            else if (profit >= (this.state.defaultTakeProfit * 0.90)) {
                exitReason = "TAKE_PROFIT";
            }
            else if (profit <= (-this.state.defaultStopLoss * 0.90)) {
                exitReason = "STOP_LOSS";
            }
            const trade = {
                contractId,
                symbol: pos?.symbol || poc.underlying_symbol || "UNKNOWN",
                contractType: pos?.contractType || (poc.contract_type === "MULTDOWN" ? "MULTDOWN" : "MULTUP"),
                stake: pos?.stake || this.state.defaultStake,
                multiplier: pos?.multiplier || 100,
                profit,
                entrySpot: entrySpot || pos?.entrySpot || 0,
                exitSpot: currentSpot,
                entryTime: pos?.entryTime || (poc.date_start ? poc.date_start * 1000 : Date.now()),
                exitTime: Date.now(),
                durationSec: pos?.entryTime ? Math.max(1, Math.round((Date.now() - pos.entryTime) / 1000)) : 10,
                status: won ? "won" : "lost",
                exitReason,
                rationale: pos?.rationale || "Estrategia Multiplicadores"
            };
            this.trades.unshift(trade);
            if (this.trades.length > 50)
                this.trades.pop();
            this.saveTrades();
            // Actualizar métricas del motor
            if (won) {
                this.state.winsCount++;
                this.state.consecutiveLosses = 0;
            }
            else {
                this.state.lossesCount++;
                this.state.consecutiveLosses++;
                if (this.state.consecutiveLosses >= this.state.maxConsecutiveLosses) {
                    this.state.pauseUntil = Date.now() + this.state.cooldownMinutes * 60000;
                    console.warn(`[DERIV MULTIPLIER] ⚠️ ${this.state.consecutiveLosses} pérdidas consecutivas. Pausa de ${this.state.cooldownMinutes} min activada.`);
                }
            }
            this.state.totalProfitUsdt += profit;
            this.state.dailyRealizedPnl += profit;
            const totalTrades = this.state.winsCount + this.state.lossesCount;
            this.state.winRatePct = totalTrades > 0 ? (this.state.winsCount / totalTrades) * 100 : 0;
            this.state.lastTradeTime = Date.now();
            // Limpiar posición
            this.positions = [];
            this.savePositions();
            this.saveState();
            // Notificación enriquecida a Telegram
            const isReal = !this.state.isSimulated;
            const resultIcon = won ? "🏆 ¡OPERACIÓN GANADA!" : "🛑 OPERACIÓN CERRADA (STOP-LOSS)";
            const reasonText = exitReason === "TRAILING_TP"
                ? "🏹 Trailing Take Profit (Capturado en el pico)"
                : exitReason === "TAKE_PROFIT"
                    ? "🎯 Take-Profit Alcanzado (+80%)"
                    : exitReason === "STOP_LOSS"
                        ? "🛡️ Stop-Loss Ejecutado (Pérdida Cortada)"
                        : "Salida de mercado";
            const headerPrefix = isReal ? "🔥 [DINERO REAL] " : "";
            const envNotice = isReal
                ? `\n💼 <b>Entorno:</b> 🔥 <b>CUENTA REAL</b> (Saldo: $${this.state.balanceUsdt.toFixed(2)} USD)`
                : `\n💼 <b>Entorno:</b> 🧪 DEMO OFICIAL (DOT95084693)`;
            this.notifier.send(`${won ? "🎉" : "⚠️"} <b>${headerPrefix}DERIV MULTIPLICADOR: ${resultIcon}</b>\n\n` +
                `• <b>Índice:</b> <code>${trade.symbol}</code> (${trade.contractType} x${trade.multiplier})\n` +
                `• <b>Resultado:</b> <b>${profit >= 0 ? "+" : ""}$${profit.toFixed(2)} USD</b> (${trade.durationSec}s)\n` +
                `• <b>Tipo de Salida:</b> <i>${reasonText}</i>\n` +
                `• <b>PnL del Día:</b> <b>${this.state.dailyRealizedPnl >= 0 ? "+" : ""}$${this.state.dailyRealizedPnl.toFixed(2)} USD</b>\n` +
                `• <b>Récord:</b> <b>${this.state.winRatePct.toFixed(1)}%</b> (${this.state.winsCount}W / ${this.state.lossesCount}L)` +
                envNotice).catch(() => { });
            return;
        }
        // CASO 2: CONTRATO ABIERTO → RASTREO Y TRAILING TAKE PROFIT
        if (posIndex >= 0) {
            const pos = this.positions[posIndex];
            pos.currentProfit = profit;
            pos.currentSpot = currentSpot;
            if (entrySpot > 0)
                pos.entrySpot = entrySpot;
            // Actualizar pico máximo de ganancia
            if (profit > pos.peakProfit) {
                pos.peakProfit = profit;
            }
            // 🏹 LÓGICA DE TRAILING TAKE PROFIT INTELIGENTE
            if (pos.peakProfit >= this.state.trailingTriggerProfit) {
                if (!pos.trailingActivated) {
                    pos.trailingActivated = true;
                    console.log(`[DERIV MULTIPLIER] 🏹 Trailing Take Profit ACTIVADO en ${pos.symbol} (Ganancia: +$${profit.toFixed(2)} USD)`);
                }
                // Si la ganancia retrocede el callback desde su punto máximo, cobramos en el pico
                const retrace = pos.peakProfit - profit;
                if (poc.is_valid_to_sell && retrace >= this.state.trailingCallback && !this.isSellingContract) {
                    this.isSellingContract = true;
                    console.log(`[DERIV MULTIPLIER] 🏹 ¡DISPARO DE TRAILING SELL! Pico: +$${pos.peakProfit.toFixed(2)} | Actual: +$${profit.toFixed(2)} | Vendiendo...`);
                    this.send({
                        sell: poc.contract_id,
                        price: 0
                    });
                }
            }
            this.savePositions();
        }
    }
    // --- TELEMETRY & CONTROLS ---
    getOperationalStatus() {
        if (!this.isConnected) {
            return { status: "DISCONNECTED", message: "🔴 Desconectado de Deriv WebSocket (reconectando...)" };
        }
        if (!this.state.enabled) {
            return { status: "PAUSED", message: "⏸️ Pausado manualmente. Envía /deriv_reanudar para activar." };
        }
        if (this.state.dailyRealizedPnl >= this.state.dailyProfitTarget) {
            return { status: "PROFIT_TARGET", message: `🎉 Meta diaria alcanzada (+$${this.state.dailyRealizedPnl.toFixed(2)} USD). Modo reposo seguro.` };
        }
        if (this.state.dailyRealizedPnl <= -this.state.dailyStopLoss) {
            return { status: "STOP_LOSS", message: `🛑 Stop loss diario alcanzado (-$${Math.abs(this.state.dailyRealizedPnl).toFixed(2)} USD vs límite -$${this.state.dailyStopLoss.toFixed(2)} USD). Envía /deriv_reanudar para desbloquear nueva sesión.` };
        }
        if (Date.now() < (this.state.pauseUntil || 0)) {
            const restMin = Math.max(1, Math.ceil(((this.state.pauseUntil || 0) - Date.now()) / 60000));
            return { status: "COOLDOWN", message: `⏳ Enfriamiento por 3 pérdidas consecutivas (restan ~${restMin} min). Envía /deriv_reanudar para saltar.` };
        }
        if (this.positions.length > 0) {
            const p = this.positions[0];
            const sign = p.currentProfit >= 0 ? "+" : "";
            const trailTag = p.trailingActivated ? " | 🏹 Trailing Activo" : "";
            return { status: "ACTIVE", message: `📊 Trade en curso: ${p.symbol} (${p.contractType} x${p.multiplier}) PnL: ${sign}$${p.currentProfit.toFixed(2)} USD${trailTag}` };
        }
        return { status: "ACTIVE", message: `🟢 Vigilando Volatilidad 24/7 (Multiplicadores con Trailing TP & SL Garantizado)` };
    }
    getTelemetry() {
        const op = this.getOperationalStatus();
        const now = Date.now();
        const secSinceLastTick = this.lastTickReceived > 0 ? Math.round((now - this.lastTickReceived) / 1000) : null;
        const cooldownRemainingSec = Math.max(0, Math.round((45000 - (now - this.state.lastTradeTime)) / 1000));
        return {
            connected: this.isConnected,
            state: this.state,
            operationalStatus: op,
            radar: this.getRadar(),
            openPositions: this.positions,
            recentTrades: this.trades.slice(0, 20),
            lastTickReceived: this.lastTickReceived,
            secondsSinceLastTick: secSinceLastTick,
            cooldownRemainingSec,
            isReal: !this.state.isSimulated,
            environmentLabel: !this.state.isSimulated ? "REAL" : "DEMO",
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
    clearTrades() {
        this.trades = [];
        this.positions = [];
        this.state.winsCount = 0;
        this.state.lossesCount = 0;
        this.state.winRatePct = 0;
        this.state.totalProfitUsdt = 0;
        this.state.dailyRealizedPnl = 0;
        this.state.consecutiveLosses = 0;
        this.state.pauseUntil = 0;
        this.saveTrades();
        this.savePositions();
        this.saveState();
        console.log("[DERIV MULTIPLIER] 🧹 Historial de trades, posiciones y estadísticas reiniciados a cero.");
        return { success: true, message: "Historial de Deriv y posiciones reiniciados correctamente a 0." };
    }
    isEnabled() {
        return this.state.enabled;
    }
    getState() {
        return { ...this.state };
    }
    setEnabled(enabled) {
        this.state.enabled = enabled;
        if (enabled) {
            this.state.pauseUntil = 0;
            this.state.consecutiveLosses = 0;
            if (this.state.dailyRealizedPnl <= -this.state.dailyStopLoss) {
                this.state.dailyRealizedPnl = 0;
            }
        }
        this.saveState();
    }
    resetDailyPnl() {
        this.state.dailyRealizedPnl = 0;
        this.state.pauseUntil = 0;
        this.state.consecutiveLosses = 0;
        this.saveState();
    }
    setStake(stake) {
        if (stake >= 1.0 && stake <= 100) {
            this.state.defaultStake = stake;
            this.saveState();
        }
    }
    setDailyProfitTarget(target) {
        if (target > 0) {
            this.state.dailyProfitTarget = target;
            this.saveState();
        }
    }
    setDailyStopLoss(stopLoss) {
        if (stopLoss > 0) {
            this.state.dailyStopLoss = stopLoss;
            this.saveState();
        }
    }
    isRealEnvironment() {
        return !this.state.isSimulated;
    }
    async setEnvironment(isReal) {
        if (this.positions.length > 0) {
            console.warn("[DERIV MULTIPLIER] No se puede cambiar de entorno con contratos abiertos.");
            return { success: false, isSimulated: this.state.isSimulated, accountId: this.state.accountId };
        }
        const changed = this.state.isSimulated !== !isReal;
        if (changed) {
            this.state.dailyRealizedPnl = 0;
            this.state.totalProfitUsdt = 0;
            this.state.winsCount = 0;
            this.state.lossesCount = 0;
            this.state.winRatePct = 0;
            this.state.consecutiveLosses = 0;
            this.state.pauseUntil = 0;
            this.state.startingBalanceUsdt = 0;
            this.state.balanceUsdt = 0;
        }
        this.state.isSimulated = !isReal;
        this.accountId = isReal ? this.realAccountId : this.demoAccountId;
        this.state.accountId = this.accountId;
        this.saveState();
        console.log(`[DERIV MULTIPLIER] Entorno cambiado a: ${isReal ? "🔥 REAL (" + this.accountId + ")" : "🧪 DEMO (" + this.accountId + ")"}`);
        if (this.ws) {
            try {
                this.ws.removeAllListeners();
                this.ws.close();
            }
            catch (_) { }
            this.ws = null;
        }
        this.isConnected = false;
        this.isConnecting = false;
        await this.connectWebSocket();
        await this.notifier.send(`🎰 <b>DERIV MULTIPLICADORES: ENTORNO CAMBIADO</b> 🔄\n\n` +
            `• <b>Nuevo Modo:</b> ${isReal ? "🔥 <b>CUENTA REAL (DINERO REAL)</b>" : "🧪 <b>CUENTA DEMO OFICIAL</b>"}\n` +
            `• <b>Account ID:</b> <code>${this.accountId}</code>\n` +
            `• <b>Stake por Trade:</b> $${this.state.defaultStake.toFixed(2)} USD\n` +
            `• <b>Stop-Loss Garantizado:</b> -$${this.state.defaultStopLoss.toFixed(2)} USD\n` +
            `• <b>Take-Profit Inicial:</b> +$${this.state.defaultTakeProfit.toFixed(2)} USD`).catch(() => { });
        return { success: true, isSimulated: this.state.isSimulated, accountId: this.accountId };
    }
}
export const derivEngine = new DerivEngine();
