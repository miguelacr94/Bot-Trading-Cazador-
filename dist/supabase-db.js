import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import fs from "fs";
import path from "path";
dotenv.config();
try {
    const f = path.resolve(process.cwd(), ".env");
    if (fs.existsSync(f))
        dotenv.config({ path: f });
}
catch { }
const SUPABASE_URL = process.env.SUPABASE_URL || "https://wfpcvuzzopjfgdtdhobp.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || "";
export class SupabaseDbService {
    client = null;
    isConnected = false;
    constructor() {
        this.init();
    }
    init() {
        const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "https://wfpcvuzzopjfgdtdhobp.supabase.co";
        const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
        if (url && key) {
            try {
                this.client = createClient(url, key, {
                    auth: { persistSession: false }
                });
                this.isConnected = true;
            }
            catch (err) {
                console.error("⚠️ Error inicializando cliente Supabase:", err.message);
            }
        }
    }
    isAvailable() {
        if (!this.isConnected || !this.client) {
            this.init();
        }
        return this.isConnected && this.client !== null;
    }
    getClient() {
        return this.client;
    }
    // --- CONTROLES DE ESTRATEGIA (Reemplazo de .strategy-controls.json) ---
    async loadStrategyControls() {
        if (!this.client)
            return null;
        try {
            const { data, error } = await this.client
                .from("strategy_controls")
                .select("*")
                .eq("id", "current")
                .single();
            if (error) {
                if (error.code !== "PGRST116") { // No rows found
                    console.error("Error al cargar strategy_controls desde Supabase:", error.message);
                }
                return null;
            }
            if (!data)
                return null;
            const settings = data.strategy_settings || {};
            return {
                strategies: data.strategies,
                autoPilot: settings.autoPilot ?? data.auto_pilot ?? true,
                approvalTimeoutSec: data.approval_timeout_sec ?? 180,
                maxPositions: settings.maxPositions ?? 7,
                allocations: data.allocations,
                baseAllocations: data.base_allocations,
                strategySettings: settings,
                suggestions: data.suggestions,
                trailingCallbacks: data.trailing_callbacks,
                recoveryTracker: data.recovery_tracker,
                stopLossEnabled: false, // SPOT BLINDADO: Siempre desactivado en spot
                stopLossPct: data.stop_loss_pct ?? 4.0,
                timeframe: data.timeframe ?? "1h",
                cashReservePct: data.cash_reserve_pct ?? 25.0,
                maxPerCoinPct: settings.maxPerCoinPct ?? data.max_per_coin_pct ?? 30.0,
                aiEnabled: settings.aiEnabled ?? data.ai_enabled ?? false,
                updatedAt: data.updated_at ? new Date(data.updated_at).getTime() : Date.now()
            };
        }
        catch (err) {
            console.error("Excepción en loadStrategyControls:", err.message);
            return null;
        }
    }
    async saveStrategyControls(controls) {
        if (!this.client)
            return false;
        try {
            const strategySettingsPayload = {
                ...(controls.strategySettings || {}),
                maxPositions: controls.maxPositions ?? 7,
                maxPerCoinPct: controls.maxPerCoinPct ?? 30.0,
                autoPilot: controls.autoPilot !== false,
                aiEnabled: controls.aiEnabled === true
            };
            const record = {
                id: "current",
                strategies: controls.strategies,
                allocations: controls.allocations,
                base_allocations: controls.baseAllocations || controls.allocations,
                strategy_settings: strategySettingsPayload,
                suggestions: controls.suggestions,
                trailing_callbacks: controls.trailingCallbacks,
                recovery_tracker: controls.recoveryTracker,
                stop_loss_enabled: false, // Blindaje Spot: jamás habilitar stop-loss
                stop_loss_pct: controls.stopLossPct ?? 4.0,
                timeframe: controls.timeframe ?? "1h",
                cash_reserve_pct: controls.cashReservePct ?? 25.0,
                updated_at: new Date().toISOString()
            };
            const { error } = await this.client
                .from("strategy_controls")
                .upsert(record, { onConflict: "id" });
            if (error) {
                console.error("Error guardando strategy_controls en Supabase:", error.message);
                return false;
            }
            return true;
        }
        catch (err) {
            console.error("Excepción en saveStrategyControls:", err.message);
            return false;
        }
    }
    // --- POSICIONES ACTIVAS SPOT (Reemplazo de .trailing-positions.json) ---
    async loadActivePositions() {
        const map = new Map();
        if (!this.client)
            return map;
        try {
            const { data, error } = await this.client
                .from("active_positions")
                .select("*");
            if (error) {
                console.error("Error cargando active_positions desde Supabase:", error.message);
                return map;
            }
            for (const row of data || []) {
                const item = {
                    symbol: row.symbol.startsWith('PEPEUSDT_lot_') ? 'PEPEUSDT' : row.symbol,
                    lotId: row.symbol,
                    buyPrice: parseFloat(row.buy_price),
                    qty: parseFloat(row.qty),
                    investedUsdt: parseFloat(row.invested_usdt),
                    highestPrice: parseFloat(row.highest_price),
                    activated: row.activated === true,
                    buyTime: row.buy_time ? parseInt(row.buy_time) : Date.now(),
                    strategy: row.strategy,
                    customCallbackPct: row.custom_callback_pct ? parseFloat(row.custom_callback_pct) : undefined,
                    customTimeframe: row.custom_timeframe || undefined,
                    customMinGainPct: row.symbol.includes('_lot_') ? 10.0 : undefined,
                    partialProfitTaken: row.partial_profit_taken === true
                };
                map.set(row.symbol, item);
            }
            return map;
        }
        catch (err) {
            console.error("Excepción en loadActivePositions:", err.message);
            return map;
        }
    }
    async saveActivePosition(pos) {
        if (!this.client)
            return false;
        try {
            const row = {
                symbol: pos.symbol,
                buy_price: pos.buyPrice,
                qty: pos.qty,
                invested_usdt: pos.investedUsdt,
                highest_price: pos.highestPrice,
                activated: pos.activated === true,
                buy_time: pos.buyTime,
                strategy: pos.strategy || "trailing_rebound",
                custom_callback_pct: pos.customCallbackPct ?? null,
                custom_timeframe: pos.customTimeframe ?? null,
                partial_profit_taken: pos.partialProfitTaken === true,
                updated_at: new Date().toISOString()
            };
            const { error } = await this.client
                .from("active_positions")
                .upsert(row, { onConflict: "symbol" });
            if (error) {
                console.error(`Error guardando posición ${pos.symbol} en Supabase:`, error.message);
                return false;
            }
            return true;
        }
        catch (err) {
            console.error(`Excepción en saveActivePosition (${pos.symbol}):`, err.message);
            return false;
        }
    }
    async deleteActivePosition(symbol) {
        if (!this.client)
            return false;
        try {
            const { error } = await this.client
                .from("active_positions")
                .delete()
                .eq("symbol", symbol);
            if (error) {
                console.error(`Error eliminando posición ${symbol} de Supabase:`, error.message);
                return false;
            }
            return true;
        }
        catch (err) {
            console.error(`Excepción en deleteActivePosition (${symbol}):`, err.message);
            return false;
        }
    }
    // --- HISTORIAL DE TRADES CERRADOS (Reemplazo de .closed-trades.json) ---
    async recordClosedTrade(trade) {
        if (!this.client)
            return false;
        try {
            const row = {
                symbol: trade.symbol,
                order_id: trade.orderId ? parseInt(String(trade.orderId)) : null,
                time: trade.time || Date.now(),
                buy_price: trade.buyPrice,
                sell_price: trade.sellPrice,
                qty: trade.qty,
                cost_usdt: trade.costUsdt,
                proceeds_usdt: trade.proceedsUsdt,
                fees_usdt: trade.feesUsdt || 0,
                pnl_usdt: trade.pnlUsdt,
                pnl_pct: trade.pnlPct,
                strategy: trade.strategy || "trailing_rebound",
                source: trade.source || "bot_execution"
            };
            const { error } = await this.client
                .from("closed_trades")
                .insert(row);
            if (error) {
                console.error("Error registrando closed_trade en Supabase:", error.message);
                return false;
            }
            return true;
        }
        catch (err) {
            console.error("Excepción en recordClosedTrade:", err.message);
            return false;
        }
    }
    async loadClosedTrades(limit = 100) {
        if (!this.client)
            return [];
        try {
            const { data, error } = await this.client
                .from("closed_trades")
                .select("*")
                .order("time", { ascending: false })
                .limit(limit);
            if (error) {
                console.error("Error cargando closed_trades desde Supabase:", error.message);
                return [];
            }
            return (data || []).map((row) => ({
                symbol: row.symbol,
                orderId: row.order_id,
                time: parseInt(row.time),
                buyPrice: parseFloat(row.buy_price),
                sellPrice: parseFloat(row.sell_price),
                qty: parseFloat(row.qty),
                costUsdt: parseFloat(row.cost_usdt),
                proceedsUsdt: parseFloat(row.proceeds_usdt),
                feesUsdt: parseFloat(row.fees_usdt || "0"),
                pnlUsdt: parseFloat(row.pnl_usdt),
                pnlPct: parseFloat(row.pnl_pct),
                strategy: row.strategy,
                source: row.source
            }));
        }
        catch (err) {
            console.error("Excepción en loadClosedTrades:", err.message);
            return [];
        }
    }
    async recordFuturesTrade(trade) {
        if (!this.client)
            return false;
        try {
            const row = {
                symbol: trade.symbol,
                side: trade.side,
                entry_price: trade.entryPrice,
                exit_price: trade.exitPrice,
                leverage: trade.leverage,
                margin_usdt: trade.marginUsdt,
                notional_usdt: trade.notionalUsdt,
                net_pnl_usdt: trade.netPnlUsdt,
                roe_pct: trade.roePct,
                is_simulated: trade.isSimulated !== false,
                rationale: trade.rationale || null,
                time: trade.time || Date.now()
            };
            const { error } = await this.client
                .from("futures_trades")
                .insert(row);
            if (error) {
                console.error("Error registrando futures_trade en Supabase:", error.message);
                return false;
            }
            return true;
        }
        catch (err) {
            console.error("Excepción en recordFuturesTrade:", err.message);
            return false;
        }
    }
    // --- MIGRACIÓN INICIAL DESDE ARCHIVOS JSON LOCALES ---
    async migrateAllLocalData() {
        const res = { closedTrades: 0, positions: 0, controls: false };
        if (!this.client)
            return res;
        const baseDir = path.resolve(__dirname, "..");
        // 1. Migrar .strategy-controls.json
        try {
            const ctrlF = path.join(baseDir, ".strategy-controls.json");
            if (fs.existsSync(ctrlF)) {
                const controls = JSON.parse(fs.readFileSync(ctrlF, "utf-8"));
                if (controls.recoveryTracker) {
                    controls.recoveryTracker.targetUsdt = 100.00;
                    controls.recoveryTracker.remainingUsdt = parseFloat((100.00 - (controls.recoveryTracker.recoveredUsdt || 6.11)).toFixed(3));
                }
                res.controls = await this.saveStrategyControls(controls);
                console.log(`[Supabase Migration] Strategy controls migrados: ${res.controls ? "ÉXITO" : "FALLO"}`);
            }
        }
        catch (e) {
            console.error("[Supabase Migration] Error migrando controls:", e.message);
        }
        // 2. Migrar .closed-trades.json
        try {
            const tradesF = path.join(baseDir, ".closed-trades.json");
            if (fs.existsSync(tradesF)) {
                const trades = JSON.parse(fs.readFileSync(tradesF, "utf-8"));
                for (const t of trades) {
                    const ok = await this.recordClosedTrade(t);
                    if (ok)
                        res.closedTrades++;
                }
                console.log(`[Supabase Migration] Trades cerrados migrados: ${res.closedTrades} de ${trades.length}`);
            }
        }
        catch (e) {
            console.error("[Supabase Migration] Error migrando trades:", e.message);
        }
        // 3. Migrar .trailing-positions.json
        try {
            const posF = path.join(baseDir, ".trailing-positions.json");
            if (fs.existsSync(posF)) {
                const raw = JSON.parse(fs.readFileSync(posF, "utf-8"));
                const list = Array.isArray(raw) && raw.length && Array.isArray(raw[0]) ? raw.map((r) => r[1]) : raw;
                for (const p of list) {
                    const ok = await this.saveActivePosition(p);
                    if (ok)
                        res.positions++;
                }
                console.log(`[Supabase Migration] Posiciones activas migradas: ${res.positions} de ${list.length}`);
            }
        }
        catch (e) {
            console.error("[Supabase Migration] Error migrando positions:", e.message);
        }
        return res;
    }
}
export const supabaseDb = new SupabaseDbService();
