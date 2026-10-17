import { Spot } from '@binance/connector';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import { TelegramNotifier } from './notifier.js';
import { scanMarketOpportunities } from './scanner.js';
dotenv.config();
const STATE_FILE = '.bot-state.json';
export class LimitSpotBot {
    client;
    notifier;
    symbol = process.env.BOT_SYMBOL || 'SOLUSDT';
    orderAmountUSDT = parseFloat(process.env.BOT_ORDER_AMOUNT_USDT || '13');
    profitTargetPercent = parseFloat(process.env.BOT_PROFIT_TARGET_PERCENT || '1.5');
    stepSize = 0.001;
    tickSize = 0.01;
    activeSellOrderId = null;
    lastBuyPrice = null;
    positionQty = 0;
    paused = false;
    constructor() {
        this.client = new Spot(process.env.BINANCE_API_KEY, process.env.BINANCE_API_SECRET, { recvWindow: 60000 });
        this.notifier = new TelegramNotifier();
        this.loadState();
    }
    loadState() {
        if (fs.existsSync(STATE_FILE)) {
            const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            if (s.symbol === this.symbol) {
                this.lastBuyPrice = s.lastBuyPrice;
                this.positionQty = s.positionQty;
                this.activeSellOrderId = s.activeSellOrderId || null;
            }
        }
    }
    saveState() {
        fs.writeFileSync(STATE_FILE, JSON.stringify({
            symbol: this.symbol,
            lastBuyPrice: this.lastBuyPrice,
            positionQty: this.positionQty,
            activeSellOrderId: this.activeSellOrderId
        }, null, 2));
    }
    async loadExchangeInfo() {
        const res = await this.client.exchangeInfo({ symbol: this.symbol });
        const s = res.data.symbols[0];
        const lot = s.filters.find((f) => f.filterType === 'LOT_SIZE');
        const priceFilter = s.filters.find((f) => f.filterType === 'PRICE_FILTER');
        this.stepSize = parseFloat(lot.stepSize);
        this.tickSize = parseFloat(priceFilter.tickSize);
    }
    formatQty(qty) {
        const dec = Math.max(0, Math.round(-Math.log10(this.stepSize)));
        return (Math.floor(qty / this.stepSize) * this.stepSize).toFixed(dec);
    }
    formatPrice(price) {
        const dec = Math.max(0, Math.round(-Math.log10(this.tickSize)));
        return price.toFixed(dec);
    }
    /**
     * Sincroniza y coloca la orden LIMIT SELL en Binance de inmediato
     */
    async ensureLimitSellOrder() {
        if (!this.lastBuyPrice)
            return;
        // Verificar si ya hay una orden abierta en Binance
        const openOrders = await this.client.openOrders({ symbol: this.symbol, recvWindow: 60000 });
        const existing = openOrders.data.find((o) => o.side === 'SELL');
        if (existing) {
            this.activeSellOrderId = existing.orderId;
            this.saveState();
            console.log(`📌 Orden LIMIT SELL ya activa en Binance en $${existing.price} (Order ID: ${existing.orderId})`);
            return;
        }
        // Si no está puesta la orden, colocarla AHORA
        const acc = await this.client.account({ recvWindow: 60000 });
        const solBal = parseFloat(acc.data.balances.find((b) => b.asset === 'SOL')?.free || '0');
        const qtyToSell = this.formatQty(Math.min(this.positionQty, solBal));
        const targetPrice = this.formatPrice(this.lastBuyPrice * (1 + this.profitTargetPercent / 100));
        if (parseFloat(qtyToSell) * parseFloat(targetPrice) >= 10) {
            console.log(`🚀 Colocando orden LIMIT SELL permanente en Binance: ${qtyToSell} SOL @ $${targetPrice}...`);
            const res = await this.client.newOrder(this.symbol, 'SELL', 'LIMIT', {
                timeInForce: 'GTC',
                quantity: qtyToSell,
                price: targetPrice,
                recvWindow: 60000
            });
            this.activeSellOrderId = res.data.orderId;
            this.saveState();
            const msg = `🎯 <b>ORDEN DE VENTA (LIMIT SELL) COLOCADA EN BINANCE</b>\n\n` +
                `• <b>Par:</b> ${this.symbol}\n` +
                `• <b>Cantidad:</b> ${qtyToSell} SOL\n` +
                `• <b>Precio de venta fijado:</b> $${targetPrice} USDT (+${this.profitTargetPercent}%)\n` +
                `• 🛡️ <i>La orden está en el libro de Binance. Se ejecutará automáticamente incluso si la Mac se apaga.</i>`;
            console.log(msg.replace(/<\/?b>/g, '').replace(/<\/?i>/g, ''));
            await this.notifier.send(msg);
        }
    }
    async checkCycleStatus() {
        try {
            if (this.activeSellOrderId) {
                const order = await this.client.getOrder(this.symbol, { orderId: this.activeSellOrderId, recvWindow: 60000 });
                if (order.data.status === 'FILLED') {
                    const executedQuote = parseFloat(order.data.cummulativeQuoteQty);
                    const profit = (executedQuote - this.orderAmountUSDT).toFixed(2);
                    const msg = `🎉 <b>¡CICLO COMPLETADO Y VENDIDO CON GANANCIA!</b>\n\n` +
                        `• <b>Par:</b> ${this.symbol}\n` +
                        `• <b>Total cobrado:</b> $${executedQuote.toFixed(2)} USDT\n` +
                        `• 💵 <b>Ganancia neta:</b> +$${profit} USDT\n` +
                        `• 🔄 Reiniciando ciclo de compra...`;
                    console.log(msg.replace(/<\/?b>/g, ''));
                    await this.notifier.send(msg);
                    this.lastBuyPrice = null;
                    this.positionQty = 0;
                    this.activeSellOrderId = null;
                    this.saveState();
                }
            }
            // Si no tenemos posición abierta y no está pausado -> Comprar nuevo ciclo
            if (!this.lastBuyPrice && !this.paused) {
                const acc = await this.client.account({ recvWindow: 60000 });
                const usdt = parseFloat(acc.data.balances.find((b) => b.asset === 'USDT')?.free || '0');
                if (usdt >= this.orderAmountUSDT) {
                    console.log(`✨ Fondos listos ($${usdt.toFixed(2)} USDT). Ejecutando compra para nuevo ciclo...`);
                    const buyRes = await this.client.newOrder(this.symbol, 'BUY', 'MARKET', {
                        quoteOrderQty: this.orderAmountUSDT,
                        recvWindow: 60000
                    });
                    const spent = parseFloat(buyRes.data.cummulativeQuoteQty);
                    const qty = parseFloat(buyRes.data.executedQty);
                    this.lastBuyPrice = spent / qty;
                    this.positionQty = qty;
                    this.saveState();
                    await this.ensureLimitSellOrder();
                }
            }
        }
        catch (e) {
            console.error('Error en checkCycleStatus:', e.response?.data || e.message);
        }
    }
    async start() {
        await this.loadExchangeInfo();
        console.log(`\n======================================================`);
        console.log(`🤖 BOT INTELIGENTE SPOT (CON ÓRDENES LIMIT EN BINANCE)`);
        console.log(`📈 Par: ${this.symbol} | Inversión: $${this.orderAmountUSDT} USDT | Meta: +${this.profitTargetPercent}%`);
        console.log(`======================================================\n`);
        await this.ensureLimitSellOrder();
        setInterval(() => this.checkCycleStatus(), 15000);
        setInterval(() => scanMarketOpportunities(), 15 * 60 * 1000);
    }
}
const bot = new LimitSpotBot();
bot.start();
