import { Spot } from '@binance/connector';
import * as dotenv from 'dotenv';
import { TelegramNotifier } from './notifier.js';

dotenv.config();

const client = new Spot(process.env.BINANCE_API_KEY, process.env.BINANCE_API_SECRET);
const notifier = new TelegramNotifier();

// Lista de pares top a vigilar
const WATCHLIST = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'AVAXUSDT', 'XRPUSDT', 'ADAUSDT'];
const alertedPairs = new Map<string, number>(); // Control anti-spam (máximo 1 alerta cada 2 horas por par)

function calculateRSI(closes: number[], period: number = 14): number {
  if (closes.length <= period) return 50;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) {
      avgGain = (avgGain * (period - 1) + diff) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.abs(diff)) / period;
    }
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

export async function scanMarketOpportunities(): Promise<void> {
  for (const symbol of WATCHLIST) {
    try {
      // 1. Obtener velas de 1 hora para RSI y tendencia
      const klinesRes = await client.klines(symbol, '1h', { limit: 50 });
      const closes: number[] = klinesRes.data.map((k: any) => parseFloat(k[4]));
      const rsi = calculateRSI(closes, 14);

      // 2. Obtener estadísticas de 24h
      const tickerRes = await client.ticker24hr(symbol);
      const high = parseFloat(tickerRes.data.highPrice);
      const low = parseFloat(tickerRes.data.lowPrice);
      const current = parseFloat(tickerRes.data.lastPrice);
      const change24h = parseFloat(tickerRes.data.priceChangePercent);
      const rangePos = ((current - low) / (high - low)) * 100;

      // CONDICIÓN DE OPORTUNIDAD:
      // - RSI en 1h < 35 (sobreventa/descuento técnico)
      // O bien:
      // - El precio está en el 15% inferior de su rango diario (soporte del día)
      const isOversold = rsi <= 35;
      const isNearDailySupport = rangePos <= 18;

      if (isOversold || isNearDailySupport) {
        const lastAlert = alertedPairs.get(symbol) || 0;
        const now = Date.now();

        // Evitar repetir la misma alerta en menos de 2 horas
        if (now - lastAlert > 2 * 60 * 60 * 1000) {
          alertedPairs.set(symbol, now);

          const reason = isOversold 
            ? `RSI sobrevendido (${rsi.toFixed(1)} en 1h)` 
            : `Soporte diario (al ${rangePos.toFixed(1)}% del mínimo)`;

          const msg = `⚡ <b>OPORTUNIDAD DE TRADING DETECTADA</b> ⚡\n\n` +
            `• <b>Par:</b> ${symbol}\n` +
            `• <b>Precio actual:</b> $${current.toLocaleString('en-US', { minimumFractionDigits: 2 })} USDT\n` +
            `• <b>Cambio 24h:</b> ${change24h >= 0 ? '+' : ''}${change24h.toFixed(2)}%\n` +
            `• <b>RSI (1h):</b> ${rsi.toFixed(1)}\n` +
            `• <b>Señal:</b> ${reason}\n\n` +
            `💡 <i>Esta es solo una alerta informativa. El bot no ejecutará ninguna compra sin tu autorización.</i>`;

          console.log(`[SCANNER] Oportunidad encontrada en ${symbol}! Enviando alerta a Telegram...`);
          await notifier.send(msg);
        }
      }
    } catch (e: any) {
      console.error(`Error escaneando ${symbol}:`, e.message);
    }
  }
}

scanMarketOpportunities().then(() => console.log('Escaneo de oportunidades completado con éxito.'));
