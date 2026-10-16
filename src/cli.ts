import { Spot } from '@binance/connector';
import * as dotenv from 'dotenv';

dotenv.config();

const apiKey = process.env.BINANCE_API_KEY || '';
const apiSecret = process.env.BINANCE_API_SECRET || '';

if (!apiKey || !apiSecret || apiKey === 'tu_api_key_aqui') {
  console.error('\n❌ ERROR: Las credenciales BINANCE_API_KEY o BINANCE_API_SECRET no están configuradas en .env\n');
  process.exit(1);
}

const client = new Spot(apiKey, apiSecret, { recvWindow: 60000 });
const action = process.argv[2];
const param = process.argv[3];

async function checkBalance() {
  console.log('\n🔍 Consultando balances en tu cuenta de Binance Spot...');
  try {
    const res = await client.account();
    const balances = res.data.balances.filter((b: any) => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0);
    
    console.log('\n======================================================');
    console.log('💼 BALANCES ACTIVOS EN SPOT');
    console.log('======================================================');
    if (balances.length === 0) {
      console.log('No se encontraron activos con saldo mayor a cero.');
    } else {
      balances.forEach((b: any) => {
        console.log(`• ${b.asset.padEnd(8)}: Disponible = ${b.free.padEnd(12)} | Bloqueado = ${b.locked}`);
      });
    }
    console.log('======================================================\n');
  } catch (error: any) {
    console.error('❌ Error al consultar balances:', error.response?.data || error.message);
  }
}

async function checkPrice(symbol: string) {
  const sym = (symbol || process.env.BOT_SYMBOL || 'BTCUSDT').toUpperCase();
  console.log(`\n🔍 Consultando precio actual de ${sym}...`);
  try {
    const res = await client.tickerPrice(sym);
    console.log(`\n📊 Precio actual de ${sym}: $${parseFloat(res.data.price).toLocaleString('en-US', { minimumFractionDigits: 2 })} USDT\n`);
  } catch (error: any) {
    console.error(`❌ Error al consultar precio de ${sym}:`, error.response?.data || error.message);
  }
}

async function checkOpenOrders(symbol: string) {
  const sym = (symbol || process.env.BOT_SYMBOL || 'BTCUSDT').toUpperCase();
  console.log(`\n🔍 Consultando órdenes abiertas para ${sym}...`);
  try {
    const res = await client.openOrders({ symbol: sym });
    console.log('\n======================================================');
    console.log(`📋 ÓRDENES ABIERTAS EN SPOT (${sym})`);
    console.log('======================================================');
    if (res.data.length === 0) {
      console.log('No tienes órdenes abiertas en este par.');
    } else {
      res.data.forEach((o: any) => {
        console.log(`• ID: ${o.orderId} | Tipo: ${o.type} | Lado: ${o.side} | Cantidad: ${o.origQty} | Precio: ${o.price}`);
      });
    }
    console.log('======================================================\n');
  } catch (error: any) {
    console.error('❌ Error al consultar órdenes abiertas:', error.response?.data || error.message);
  }
}

async function manualBuy(amountUSDT: string) {
  const sym = (process.env.BOT_SYMBOL || 'BTCUSDT').toUpperCase();
  const amount = parseFloat(amountUSDT || process.env.BOT_ORDER_AMOUNT_USDT || '15');
  console.log(`\n⚠️  EJECUTANDO ORDEN MANUAL DE COMPRA EN SPOT:`);
  console.log(`Par: ${sym} | Monto: $${amount} USDT`);
  try {
    const res = await client.newOrder(sym, 'BUY', 'MARKET', {
      quoteOrderQty: amount,
    });
    console.log(`✅ COMPRA EXITOSA! Order ID: ${res.data.orderId}`);
  } catch (error: any) {
    console.error('❌ Error ejecutando compra manual:', error.response?.data || error.message);
  }
}

async function manualSell(percentage: string) {
  const sym = (process.env.BOT_SYMBOL || 'BTCUSDT').toUpperCase();
  const quote = 'USDT';
  const base = sym.replace(quote, '');
  const pct = parseFloat(percentage || '100'); // Por defecto vende el 100% del activo base
  
  console.log(`\n⚠️  EJECUTANDO ORDEN MANUAL DE VENTA EN SPOT:`);
  try {
    const acc = await client.account();
    const baseBal = acc.data.balances.find((b: any) => b.asset === base);
    const available = baseBal ? parseFloat(baseBal.free) : 0;
    
    if (available <= 0) {
      console.log(`❌ No tienes balance disponible de ${base} para vender.`);
      return;
    }

    const qtyToSell = (available * (pct / 100)).toFixed(5);
    console.log(`Vendiendo ${qtyToSell} ${base} (${pct}% del balance disponible)...`);
    
    const res = await client.newOrder(sym, 'SELL', 'MARKET', {
      quantity: qtyToSell,
    });
    console.log(`✅ VENTA EXITOSA! Order ID: ${res.data.orderId}`);
  } catch (error: any) {
    console.error('❌ Error ejecutando venta manual:', error.response?.data || error.message);
  }
}

function showHelp() {
  console.log(`
Comandos disponibles para operar bajo demanda:
  npm run balance               -> Consulta tus saldos activos en Binance Spot
  npm run price [PAR]           -> Consulta el precio actual (Ej: npm run price ETHUSDT)
  npm run orders [PAR]          -> Consulta órdenes abiertas pendientes
  npm run buy [MONTO_USDT]      -> Ejecuta una compra manual controlada (Ej: npm run buy 15)
  npm run sell [PORCENTAJE]     -> Ejecuta una venta manual controlada (Ej: npm run sell 100)
  npm run bot                   -> Inicia el bot automático continuo
`);
}

async function main() {
  switch (action) {
    case 'balance':
      await checkBalance();
      break;
    case 'price':
      await checkPrice(param);
      break;
    case 'orders':
      await checkOpenOrders(param);
      break;
    case 'buy':
      await manualBuy(param);
      break;
    case 'sell':
      await manualSell(param);
      break;
    default:
      showHelp();
      break;
  }
}

main();
