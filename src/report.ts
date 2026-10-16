import { Spot } from '@binance/connector';
import * as dotenv from 'dotenv';

dotenv.config();

const client = new Spot(process.env.BINANCE_API_KEY, process.env.BINANCE_API_SECRET, {
  recvWindow: 60000,
});

async function generateReport(days: number = 7) {
  const symbol = process.env.BOT_SYMBOL || 'SOLUSDT';
  const startTime = Date.now() - days * 24 * 60 * 60 * 1000;

  console.log(`\n======================================================`);
  console.log(`📊 REPORTE DE PnL Y OPERACIONES SPOT (${symbol})`);
  console.log(`📅 Rango evaluado: Últimos ${days} días`);
  console.log(`======================================================\n`);

  try {
    const res = await client.myTrades(symbol, { startTime, recvWindow: 60000 });
    const trades = res.data;

    if (!trades || trades.length === 0) {
      console.log(`No se encontraron operaciones en ${symbol} en los últimos ${days} días.`);
      return;
    }

    let totalBoughtUSDT = 0;
    let totalBoughtQty = 0;
    let totalSoldUSDT = 0;
    let totalSoldQty = 0;
    let totalFeesUSDT = 0;

    console.log(`Historial de ejecuciones:`);
    for (const t of trades) {
      const date = new Date(t.time).toLocaleString();
      const type = t.isBuyer ? '🟢 COMPRA' : '🔴 VENTA';
      const quote = parseFloat(t.quoteQty);
      const qty = parseFloat(t.qty);
      const fee = parseFloat(t.commission);

      if (t.isBuyer) {
        totalBoughtUSDT += quote;
        totalBoughtQty += qty;
      } else {
        totalSoldUSDT += quote;
        totalSoldQty += qty;
      }

      if (t.commissionAsset === 'USDT') {
        totalFeesUSDT += fee;
      } else if (t.commissionAsset === 'SOL') {
        totalFeesUSDT += fee * parseFloat(t.price);
      }

      console.log(`[${date}] ${type} | Cantidad: ${qty.toFixed(4)} | Precio: $${parseFloat(t.price).toFixed(2)} | Total: $${quote.toFixed(2)} USDT`);
    }

    // Calcular precio actual de mercado para posiciones no cerradas
    const ticker = await client.tickerPrice(symbol);
    const currentPrice = parseFloat(ticker.data.price);

    const openQty = totalBoughtQty - totalSoldQty;
    const currentHoldingValue = openQty > 0 ? openQty * currentPrice : 0;

    // Ganancia Realizada (cerrada) vs No Realizada (flotante)
    const realizedCost = totalSoldQty > 0 && totalBoughtQty > 0 ? (totalBoughtUSDT / totalBoughtQty) * totalSoldQty : 0;
    const realizedPnL = totalSoldUSDT > 0 ? totalSoldUSDT - realizedCost - totalFeesUSDT : 0;
    const unrealizedCost = openQty > 0 ? totalBoughtUSDT - realizedCost : 0;
    const unrealizedPnL = openQty > 0 ? currentHoldingValue - unrealizedCost : 0;
    const netTotalPnL = realizedPnL + unrealizedPnL;

    console.log(`\n------------------------------------------------------`);
    console.log(`📈 RESUMEN FINANCIERO:`);
    console.log(`------------------------------------------------------`);
    console.log(`• Total invertido en compras: $${totalBoughtUSDT.toFixed(2)} USDT`);
    console.log(`• Total recibido en ventas:   $${totalSoldUSDT.toFixed(2)} USDT`);
    console.log(`• Posición abierta actual:    ${openQty.toFixed(4)} ${symbol.replace('USDT', '')} (~$${currentHoldingValue.toFixed(2)} USDT)`);
    console.log(`• Comisiones pagadas:         -$${totalFeesUSDT.toFixed(4)} USDT`);
    console.log(`• Ganancia Realizada (Cerrada): ${realizedPnL >= 0 ? '+' : ''}$${realizedPnL.toFixed(3)} USDT`);
    console.log(`• Ganancia Flotante (Abierta):  ${unrealizedPnL >= 0 ? '+' : ''}$${unrealizedPnL.toFixed(3)} USDT`);
    console.log(`• PnL Neto Total del período:   ${netTotalPnL >= 0 ? '🟢 +' : '🔴 '}$${netTotalPnL.toFixed(3)} USDT`);
    console.log(`======================================================\n`);

  } catch (error: any) {
    console.error('❌ Error generando el reporte:', error.response?.data || error.message);
  }
}

const daysArg = process.argv[2] ? parseInt(process.argv[2], 10) : 7;
generateReport(daysArg);
