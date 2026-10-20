import { Spot } from "@binance/connector";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { TelegramNotifier } from "./notifier.js";

dotenv.config();

const client = new Spot(process.env.BINANCE_API_KEY, process.env.BINANCE_API_SECRET, { recvWindow: 60000 });
const notifier = new TelegramNotifier();

async function run() {
  console.log("🚀 Iniciando migración de órdenes fijas a Trailing Take Profit Dinámico (+0.8%)...");

  // 1. Cancelar orden fija de ETH
  try {
    console.log("Cancelling ETH order 50644617589...");
    await client.cancelOrder("ETHUSDT", { orderId: 50644617589, recvWindow: 60000 });
    console.log("✅ Orden fija de ETH cancelada con éxito.");
  } catch(e: any) {
    console.log("ETH cancel result:", e.message);
  }

  // 2. Cancelar órdenes fijas de SOL
  try {
    console.log("Cancelling SOL orders...");
    await client.cancelOrder("SOLUSDT", { orderId: 18001722448, recvWindow: 60000 });
    await client.cancelOrder("SOLUSDT", { orderId: 18001443127, recvWindow: 60000 });
    console.log("✅ Órdenes fijas de SOL canceladas con éxito.");
  } catch(e: any) {
    console.log("SOL cancel result:", e.message);
  }

  // 3. Consultar balances libres reales
  const acc = await client.account({ recvWindow: 60000 });
  const ethFree = parseFloat(acc.data.balances.find((b: any) => b.asset === "ETH")?.free || "0");
  const solFree = parseFloat(acc.data.balances.find((b: any) => b.asset === "SOL")?.free || "0");
  console.log(`Balances libres: ETH = ${ethFree}, SOL = ${solFree}`);

  // 4. Preparar posiciones de Trailing
  const positions: [string, any][] = [
    [
      "ETHUSDT",
      {
        symbol: "ETHUSDT",
        buyPrice: 2395.76,
        qty: ethFree > 0 ? ethFree : 0.0078,
        investedUsdt: 18.687,
        highestPrice: 2395.76,
        activated: false,
        buyTime: Date.now()
      }
    ],
    [
      "SOLUSDT",
      {
        symbol: "SOLUSDT",
        buyPrice: 104.90,
        qty: solFree > 0 ? solFree : 0.24,
        investedUsdt: 25.176,
        highestPrice: 104.90,
        activated: false,
        buyTime: Date.now()
      }
    ]
  ];

  // 5. Guardar en .trailing-positions.json
  const filePath = path.resolve(process.cwd(), ".trailing-positions.json");
  fs.writeFileSync(filePath, JSON.stringify(positions, null, 2));
  console.log(`✅ Archivo ${filePath} creado con éxito.`);

  // 6. Notificar por Telegram
  const msg = `🏹 <b>¡MIGRACIÓN A TRAILING TAKE PROFIT COMPLETADA!</b> 🚀\n\n` +
    `Se eliminaron las órdenes fijas lejanas y ahora el bot persigue el precio en tiempo real:\n\n` +
    `• <b>ETH:</b> Entrada: $2,395.76 | Cantidad: ${ethFree.toFixed(4)} ETH\n` +
    `  🎯 <i>Gatillo Trailing (+0.8%):</i> <b>$2,414.92</b>\n\n` +
    `• <b>SOL:</b> Entrada: $104.90 | Cantidad: ${solFree.toFixed(3)} SOL\n` +
    `  🎯 <i>Gatillo Trailing (+0.8%):</i> <b>$105.74</b>\n\n` +
    `🛡️ <i>En cuanto toquen su meta, el bot amarra la ganancia, persigue el pico y vende en la cima para liberar liquidez de inmediato.</i>`;

  await notifier.send(msg);
  console.log("✅ Notificación enviada a Telegram.");
}

run();
