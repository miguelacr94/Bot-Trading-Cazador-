import { BinanceSpotBot } from './spot-bot.js';
import * as dotenv from 'dotenv';
dotenv.config();
const apiKey = process.env.BINANCE_API_KEY || '';
const apiSecret = process.env.BINANCE_API_SECRET || '';
if (!apiKey || !apiSecret) {
    console.error('\n❌ ERROR: Faltan las variables BINANCE_API_KEY y BINANCE_API_SECRET en el archivo .env\n');
    process.exit(1);
}
const config = {
    apiKey,
    apiSecret,
    symbol: process.env.BOT_SYMBOL || 'BTCUSDT',
    orderAmountUSDT: parseFloat(process.env.BOT_ORDER_AMOUNT_USDT || '15'), // Mínimo de Binance son ~10 USDT
    profitTargetPercent: parseFloat(process.env.BOT_PROFIT_TARGET_PERCENT || '1.2'), // +1.2% por ciclo
    pollIntervalMs: parseInt(process.env.BOT_POLL_INTERVAL_MS || '10000', 10), // Chequeo cada 10 segs
};
const bot = new BinanceSpotBot(config);
bot.start();
// Detener limpiamente al presionar Ctrl+C
process.on('SIGINT', () => {
    bot.stop();
    process.exit(0);
});
