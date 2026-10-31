/**
 * SUITE DE PRUEBAS DE SEGURIDAD CRÍTICA - BOT TRADING SPOT CAZADOR
 *
 * Valida de forma rigurosa e independiente los 4 pilares de blindaje:
 * 1. Verificador de costo real contra Binance (LIFO real / sin ventas en pérdida)
 * 2. Invariante supremo en el core (executeTrailingSell y executePartialSell)
 * 3. Comandos de Telegram (/vender, /forzar_venta_perdida, /aprobar)
 * 4. Blindaje de lotes huérfanos y persistencia de posiciones en memoria
 */

process.env.BOT_NO_AUTOSTART = "1";

import { TrailingMasterBot } from "../src/multi-engine-bot.js";
import { supabaseDb } from "../src/supabase-db.js";

// Mock Supabase methods during unit tests so test runs don't mutate production DB
supabaseDb.saveActivePositions = async () => true;
supabaseDb.deleteActivePosition = async () => true;
supabaseDb.recordClosedTrade = async () => true;

interface TestStats {
  total: number;
  passed: number;
  failed: number;
  failures: string[];
}

const stats: TestStats = { total: 0, passed: 0, failed: 0, failures: [] };

function assert(condition: boolean, testName: string, details?: string) {
  stats.total++;
  if (condition) {
    stats.passed++;
    console.log(`  \x1b[32m✔ PASS\x1b[0m: ${testName}`);
  } else {
    stats.failed++;
    const msg = details ? `${testName} -> ${details}` : testName;
    stats.failures.push(msg);
    console.log(`  \x1b[31m✖ FAIL\x1b[0m: ${msg}`);
  }
}

// Helper para crear trades simulados de Binance
let tradeIdSeq = 1;
function mockTrade(orderId: number, isBuyer: boolean, qty: number, price: number, time: number) {
  return {
    id: tradeIdSeq++,
    orderId,
    isBuyer,
    qty: String(qty),
    price: String(price),
    quoteQty: String(qty * price),
    commission: "0.001",
    commissionAsset: "BNB",
    time
  };
}

async function runTestSuite() {
  console.log("\n============================================================");
  console.log("🛡️  INICIANDO SUITE DE AUDITORÍA Y TESTEO DE SEGURIDAD SPOT");
  console.log("============================================================\n");

  const verifyRealCost = TrailingMasterBot.prototype["verifyRealCostWithBinance"];

  // =========================================================================
  // SUITE 1: Verificador de Costo Real contra Binance (LIFO Audit)
  // =========================================================================
  console.log("📦 SUITE 1: Verificador de Costo Real contra Historial de Binance");

  // Escenario XRP real: 15.88 XRP comprados a $1.3329 + 81.82 XRP recomprados a ~$1.2400
  const xrpTradesHistory = [
    mockTrade(101, true, 15.88, 1.3329, 1000), // Lote 1 viejo caro
    mockTrade(102, true, 11.89, 1.2400, 2000), // Recompra DCA 1
    mockTrade(103, true, 11.99, 1.2400, 3000), // Recompra DCA 2
    mockTrade(104, true, 11.20, 1.2400, 4000), // Recompra DCA 3
    mockTrade(105, true, 7.90, 1.2400, 5000),  // Recompra DCA 4
    mockTrade(106, true, 7.90, 1.2400, 6000),  // Recompra DCA 5
    mockTrade(107, true, 30.94, 1.2442, 7000)  // Recompra DCA 6
  ];

  const mockCtx = {
    client: {
      myTrades: async () => ({ data: xrpTradesHistory })
    }
  };

  // Test 1.1: Vender toda la bolsa (97.7 XRP) a $1.2490
  // DEBE BLOQUEAR porque consume los 15.88 XRP comprados a $1.3329 y genera pérdida neta (~ -$0.85 USDT)
  {
    const res = await verifyRealCost.call(mockCtx, "XRPUSDT", 97.7, 1.2490);
    assert(!res.ok, "1.1 Bloquea venta de toda la bolsa a 1.2490 cuando hay compras caras a 1.3329", `res.ok=${res.ok}, PnL=${res.estPnl}`);
    assert(res.estPnl < 0, "1.1 Calcula correctamente PnL negativo para la bolsa completa", `PnL=${res.estPnl}`);
  }

  // Test 1.2: Vender ÚNICAMENTE el lote DCA aislado (81.82 XRP) a $1.2490
  // DEBE PERMITIR porque solo consume las recompras hechas a $1.2400-$1.2442 -> ganancia real (~ +$0.50 USDT)
  {
    const res = await verifyRealCost.call(mockCtx, "XRPUSDT", 81.82, 1.2490);
    assert(res.ok, "1.2 Permite venta del lote DCA aislado a 1.2490 con ganancia real", `res.ok=${res.ok}, PnL=${res.estPnl}`);
    assert(res.estPnl > 0.3, "1.2 PnL estimado es netamente positivo para el lote DCA", `PnL=${res.estPnl}`);
  }

  // Test 1.3: Vender lote DCA a $1.2410 (sin margen para comisiones)
  // DEBE BLOQUEAR porque no supera el umbral de ganancia neta tras comisiones
  {
    const res = await verifyRealCost.call(mockCtx, "XRPUSDT", 81.82, 1.2410);
    assert(!res.ok, "1.3 Bloquea venta de lote DCA si el precio de salida no cubre comisiones (1.2410)", `res.ok=${res.ok}, PnL=${res.estPnl}`);
  }

  // Test 1.4: Vender toda la bolsa cuando el precio supera todas las compras ($1.3500)
  // DEBE PERMITIR porque todos los lotes, incluso el caro de 1.3329, están en ganancia
  {
    const res = await verifyRealCost.call(mockCtx, "XRPUSDT", 97.7, 1.3500);
    assert(res.ok, "1.4 Permite venta de toda la bolsa cuando el precio (1.3500) supera la compra más cara (1.3329)", `res.ok=${res.ok}, PnL=${res.estPnl}`);
    assert(res.estPnl > 8.0, "1.4 Ganancia calculada es sustancial (+8.52 USDT aprox)", `PnL=${res.estPnl}`);
  }

  // Test 1.5: Venta que excede la cantidad comprada en el historial (150 XRP cuando solo hay 97.7)
  // DEBE BLOQUEAR por falta de costo verificable (fail-closed)
  {
    const res = await verifyRealCost.call(mockCtx, "XRPUSDT", 150.0, 1.4000);
    assert(!res.ok, "1.5 Bloquea venta si la cantidad excede el historial de compras verificable", `res.ok=${res.ok}`);
    assert(typeof res.reason === "string" && res.reason.includes("sin costo verificable"), "1.5 Razón explica falta de costo verificable", res.reason);
  }

  // Test 1.6: Fallo en la API de Binance (Timeout / Network Error)
  // DEBE BLOQUEAR (Fail-closed de seguridad absoluta)
  {
    const mockCtxFail = {
      client: {
        myTrades: async () => { throw new Error("Binance API 504 Gateway Timeout"); }
      }
    };
    const res = await verifyRealCost.call(mockCtxFail, "XRPUSDT", 10.0, 2.0000);
    assert(!res.ok, "1.6 Fail-closed: Bloquea venta si la API de Binance arroja error o timeout", `res.ok=${res.ok}`);
    assert(typeof res.reason === "string" && res.reason.includes("No se pudo consultar"), "1.6 Informa fallo de conexión en motivo", res.reason);
  }

  // =========================================================================
  // SUITE 2: Invariante del Core en Ventas (`executeTrailingSell`)
  // =========================================================================
  console.log("\n⚔️  SUITE 2: Invariante Supremo del Core (`executeTrailingSell`)");

  // Instanciar bot con mocks completos para inspección
  const bot: any = new TrailingMasterBot();

  // Mock de órdenes para registrar si se intentó enviar una orden a Binance
  let ordersSentToBinance: any[] = [];
  bot.client = {
    newOrder: async (symbol: string, side: string, type: string, opts: any) => {
      ordersSentToBinance.push({ symbol, side, type, opts });
      return {
        data: {
          orderId: 999001,
          cummulativeQuoteQty: "100.00",
          executedQty: opts.quantity || "10",
          fills: []
        }
      };
    },
    tickerPrice: async (sym: string) => ({ data: { price: "1.2400" } }),
    exchangeInfo: async () => ({
      data: {
        symbols: [{
          filters: [
            { filterType: "LOT_SIZE", stepSize: "0.1" },
            { filterType: "NOTIONAL", minNotional: "10.0" }
          ]
        }]
      }
    }),
    account: async () => ({
      data: {
        balances: [
          { asset: "XRP", free: "100.0", locked: "0.0" },
          { asset: "SOL", free: "10.0", locked: "0.0" }
        ]
      }
    }),
    myTrades: async () => ({ data: xrpTradesHistory }),
    openOrders: async () => ({ data: [] }),
    cancelOrder: async () => ({ data: {} }),
    getFlexibleProductPosition: async () => ({ data: { rows: [] } })
  };

  // Mock de notifier para silenciar envíos de red
  bot.notifier = { send: async () => {} };

  // Test 2.1: Venta automática rechazada si curPrice <= pos.buyPrice
  {
    ordersSentToBinance = [];
    const testPos = {
      symbol: "XRPUSDT",
      buyPrice: 1.3329,
      qty: 50.0,
      investedUsdt: 66.64,
      highestPrice: 1.3329,
      activated: true
    };
    const res = await bot.executeTrailingSell(testPos, 1.2490, false, false, undefined, false, false);
    assert(!res, "2.1 Venta automática rechazada si curPrice (1.2490) <= buyPrice (1.3329)");
    assert(ordersSentToBinance.length === 0, "2.1 NINGUNA orden enviada a Binance cuando curPrice <= buyPrice");
  }

  // Test 2.2: Venta automática rechazada si estGainPct < minNetFloor (+0.10%)
  {
    ordersSentToBinance = [];
    const testPos = {
      symbol: "XRPUSDT",
      buyPrice: 1.2400,
      qty: 50.0,
      investedUsdt: 62.00,
      highestPrice: 1.2450,
      activated: true
    };
    // Salida a 1.2415 (+0.12% de ganancia, menor al piso mínimo de 0.45%)
    const res = await bot.executeTrailingSell(testPos, 1.2415, false, false, undefined, false, false);
    assert(!res, "2.2 Venta automática rechazada si ganancia estimada (+0.12%) < piso mínimo (+0.45%)");
    assert(ordersSentToBinance.length === 0, "2.2 Binance no tocado cuando la ganancia es insuficiente");
  }

  // Test 2.3: Venta automática rechazada por segunda llave (historial de Binance reporta pérdida real)
  {
    ordersSentToBinance = [];
    // En memoria simula haber comprado a 1.2393, pero intenta vender 97.7 XRP
    // La segunda llave consulta Binance y detecta que 15.88 XRP costaron 1.3329 -> PnL real negativo
    const testPos = {
      symbol: "XRPUSDT",
      buyPrice: 1.2393, // Precio corrupto en memoria
      qty: 97.7,
      investedUsdt: 121.08,
      highestPrice: 1.2490,
      activated: true
    };
    const res = await bot.executeTrailingSell(testPos, 1.2490, false, false, undefined, false, false);
    assert(!res, "2.3 Venta automática rechazada por la segunda llave aunque en memoria parezca ganancia");
    assert(ordersSentToBinance.length === 0, "2.3 Bloqueo de orden en Binance gracias a la verificación de costo real");
  }

  // Test 2.4: Salida manual en pérdida rechazada si allowLoss = false
  {
    ordersSentToBinance = [];
    const testPos = {
      symbol: "XRPUSDT",
      buyPrice: 1.3329,
      qty: 50.0,
      investedUsdt: 66.64,
      highestPrice: 1.3329,
      activated: false
    };
    const res = await bot.executeTrailingSell(testPos, 1.2490, false, false, "MANUAL", true, false);
    assert(!res, "2.4 Salida manual en pérdida rechazada si allowLoss es false");
    assert(ordersSentToBinance.length === 0, "2.4 Binance no tocado si falta confirmación explícita de pérdida");
  }

  // Test 2.5: Salida manual en pérdida permitida ÚNICAMENTE con allowLoss = true (Doble confirmación)
  {
    ordersSentToBinance = [];
    const testPos = {
      symbol: "XRPUSDT",
      buyPrice: 1.3329,
      qty: 20.0,
      investedUsdt: 26.65,
      highestPrice: 1.3329,
      activated: false
    };
    const res = await bot.executeTrailingSell(testPos, 1.2490, false, false, "MANUAL", true, true);
    assert(res === true, "2.5 Salida manual en pérdida autorizada únicamente cuando allowLoss=true");
    assert(ordersSentToBinance.length === 1, "2.5 Orden ejecutada en Binance tras confirmación manual explícita");
  }

  // =========================================================================
  // SUITE 3: Blindaje de Comandos en Telegram
  // =========================================================================
  console.log("\n📱 SUITE 3: Blindaje de Comandos en Telegram");

  // Preparar posiciones activas en el bot
  bot.activeTrailingPositions.clear();
  bot.activeTrailingPositions.set("XRPUSDT", {
    symbol: "XRPUSDT",
    buyPrice: 1.3329,
    qty: 50.0,
    investedUsdt: 66.64,
    highestPrice: 1.3329,
    activated: false
  });
  bot.activeTrailingPositions.set("SOLUSDT", {
    symbol: "SOLUSDT",
    buyPrice: 90.00,
    qty: 1.0,
    investedUsdt: 90.00,
    highestPrice: 95.00,
    activated: true
  });

  // Mock de ticker prices
  bot.client.tickerPrice = async (sym: string) => {
    if (sym === "XRPUSDT") return { data: { price: "1.2400" } }; // -6.97% pérdida
    if (sym === "SOLUSDT") return { data: { price: "95.00" } };  // +5.55% ganancia
    return { data: { price: "1.0000" } };
  };

  // Mock de cuenta con balances para XRP y SOL
  bot.client.account = async () => ({
    data: {
      balances: [
        { asset: "XRP", free: "50.0", locked: "0.0" },
        { asset: "SOL", free: "1.0", locked: "0.0" }
      ]
    }
  });

  // Test 3.1: Comando /vender en posición con pérdida
  // DEBE BLOQUEAR sin vender nada y explicar por qué
  {
    ordersSentToBinance = [];
    const resp = await bot.handleTelegramCommand("/vender xrp");
    assert(resp.includes("VENTA A PÉRDIDA BLOQUEADA EN EL CORE"), "3.1 /vender bloquea posición en pérdida", resp);
    assert(resp.includes("PROHIBIDO vender en pérdida"), "3.1 Mensaje explica prohibición en el core", resp);
    assert(ordersSentToBinance.length === 0, "3.1 Cero órdenes a Binance en /vender de posición en rojo");
  }

  // Test 3.2: Comando /vender en posición con ganancia neta (+5.55% en SOL)
  // DEBE PERMITIR la venta en ganancia
  {
    ordersSentToBinance = [];
    const solTrades = [mockTrade(201, true, 1.0, 90.0, 1000)];
    bot.client.myTrades = async () => ({ data: solTrades });

    const resp = await bot.handleTelegramCommand("/vender sol");
    assert(resp.includes("Venta en Ganancia Ejecutada"), "3.2 /vender ejecuta venta cuando hay ganancia neta", resp);
    assert(ordersSentToBinance.length === 1, "3.2 Orden de venta enviada a Binance para posición ganadora");
  }

  // Test 3.3: Comando /forzar_venta_perdida sin "CONFIRMAR"
  // DEBE RECHAZAR y exigir la palabra clave
  {
    ordersSentToBinance = [];
    const resp = await bot.handleTelegramCommand("/forzar_venta_perdida xrp");
    assert(resp.includes("CONFIRMACIÓN REQUERIDA"), "3.3 /forzar_venta_perdida rechaza si falta CONFIRMAR", resp);
    assert(ordersSentToBinance.length === 0, "3.3 Cero órdenes a Binance si no se escribe CONFIRMAR");
  }

  // Test 3.4: Comando /forzar_venta_perdida con "CONFIRMAR"
  // DEBE PERMITIR la salida manual forzada
  {
    ordersSentToBinance = [];
    bot.activeTrailingPositions.set("XRPUSDT", {
      symbol: "XRPUSDT",
      buyPrice: 1.3329,
      qty: 50.0,
      investedUsdt: 66.64,
      highestPrice: 1.3329,
      activated: false
    });
    const resp = await bot.handleTelegramCommand("/forzar_venta_perdida xrp CONFIRMAR");
    assert(resp.includes("Venta en pérdida autorizada y ejecutada"), "3.4 /forzar_venta_perdida ejecuta con confirmación", resp);
    assert(ordersSentToBinance.length === 1, "3.4 Orden enviada a Binance tras confirmación manual por chat");
  }

  // Test 3.5: Comando /aprobar valida que la oportunidad pendiente sea de compra
  {
    bot.pendingOpportunity = {
      symbol: "ETHUSDT",
      strategy: "smart_dca",
      strategyName: "Smart DCA",
      amount: 15.0,
      reason: "Soporte de 4H",
      curPrice: 2200.0,
      createdAt: Date.now(),
      expiresAt: Date.now() + 180000
    };
    bot.activeTrailingPositions.set("ETHUSDT", {
      symbol: "ETHUSDT",
      buyPrice: 2400.0,
      qty: 0.05,
      investedUsdt: 120.0,
      highestPrice: 2400.0,
      activated: false
    });

    const resp = await bot.handleTelegramCommand("/aprobar");
    assert(resp.includes("Blindaje del Core Activo"), "3.5 /aprobar afirma blindaje de lote independiente", resp);
    assert(resp.includes("NUNCA se venderá en negativo"), "3.5 /aprobar reitera regla inmutable del core", resp);
  }

  // =========================================================================
  // SUITE 4: Sincronización de Huérfanos y Blindaje de Memoria
  // =========================================================================
  console.log("\n🧬 SUITE 4: Sincronización de Huérfanos y Blindaje de Memoria");

  // Test 4.1: syncOrphanPositions con compras a precios dispares asigna buyPrice = Math.max(avg, highestPrice)
  {
    bot.activeTrailingPositions.clear();
    bot.client.account = async () => ({
      data: {
        balances: [{ asset: "XRP", free: "97.7", locked: "0.0" }]
      }
    });
    bot.client.tickerPrice = async () => ({ data: { price: "1.2400" } });
    bot.client.myTrades = async () => ({ data: xrpTradesHistory });

    await bot.syncOrphanPositions();
    const syncedPos = bot.activeTrailingPositions.get("XRPUSDT");

    assert(!!syncedPos, "4.1 Posición huérfana de XRP detectada e incorporada");
    if (syncedPos) {
      assert(
        syncedPos.buyPrice >= 1.3329,
        "4.1 buyPrice asignado (1.3329) es igual al precio más alto pagado, impidiendo ventas a pérdida por promedio",
        `buyPrice asignado: ${syncedPos.buyPrice}`
      );
    }
  }

  // Test 4.2: checkTrailingPositions NO borra posiciones en pérdida si existen tokens en Spot o Earn
  {
    bot.activeTrailingPositions.clear();
    bot.activeTrailingPositions.set("DOGEUSDT", {
      symbol: "DOGEUSDT",
      buyPrice: 0.1000,
      qty: 500.0,
      investedUsdt: 50.0,
      highestPrice: 0.1000,
      activated: false
    });

    // Simular que el balance libre es 0 pero está en Spot locked (o en Earn)
    bot.client.account = async () => ({
      data: {
        balances: [{ asset: "DOGE", free: "0.0", locked: "500.0" }]
      }
    });
    bot.client.tickerPrice = async () => ({ data: { price: "0.0750" } }); // -25% en pérdida
    bot.getFreeBalance = async () => 0;

    await bot.checkTrailingPositions();
    const stillAlive = bot.activeTrailingPositions.has("DOGEUSDT");
    assert(stillAlive, "4.2 Posición en pérdida NO es eliminada de la memoria mientras existan tokens en la cuenta");
  }

  // =========================================================================
  // SUITE 5: Gestión Dinámica de Monedas en DB (Supabase Watchlist)
  // =========================================================================
  console.log("\n🪙  SUITE 5: Gestión Dinámica de Monedas en DB (Supabase Watchlist)");
  {
    const bot = new TrailingMasterBot();
    bot.client.tickerPrice = async (sym: string) => {
      if (sym === "ADAUSDT" || sym === "FLOKIUSDT" || sym === "ETHUSDT") {
        return { data: { symbol: sym, price: "0.55" } };
      }
      throw new Error("Invalid symbol");
    };

    // 5.1 Getters dinámicos
    const initialCore = bot.coreWatchlist;
    const initialMeme = bot.memeWatchlist;
    const initialTotal = bot.watchlist;
    assert(initialCore.includes("ETHUSDT"), "5.1 coreWatchlist contiene ETHUSDT");
    assert(initialMeme.includes("PEPEUSDT"), "5.1 memeWatchlist contiene PEPEUSDT");
    assert(initialTotal.length === initialCore.length + initialMeme.length, "5.1 watchlist consolida ambas categorías sin duplicados");

    // 5.2 Agregar moneda válida (ADA)
    const addRes = await bot.addCoinToWatchlist("ADA", "core");
    assert(addRes.success, "5.2 addCoinToWatchlist agrega ADA con éxito");
    assert(bot.coreWatchlist.includes("ADAUSDT"), "5.2 ADAUSDT está presente en coreWatchlist");
    assert(bot.watchlist.includes("ADAUSDT"), "5.2 ADAUSDT está presente en watchlist total");

    // 5.3 Rechazar duplicado
    const dupRes = await bot.addCoinToWatchlist("ADAUSDT", "core");
    assert(!dupRes.success, "5.3 addCoinToWatchlist rechaza moneda duplicada");

    // 5.4 Eliminar moneda (ADA)
    const delRes = await bot.removeCoinFromWatchlist("ADA");
    assert(delRes.success, "5.4 removeCoinFromWatchlist elimina ADA con éxito");
    assert(!bot.coreWatchlist.includes("ADAUSDT"), "5.4 ADAUSDT ya no está en coreWatchlist");
    assert(!bot.watchlist.includes("ADAUSDT"), "5.4 ADAUSDT ya no está en watchlist total");

    // 5.5 Comando Telegram /monedas
    const listMsg = await bot.handleTelegramCommand("/monedas");
    assert(listMsg.includes("LISTA DE MONEDAS ACTIVAS"), "5.5 /monedas genera cabecera informativa");
    assert(listMsg.includes("ETHUSDT"), "5.5 /monedas lista monedas Core");
    assert(listMsg.includes("PEPEUSDT"), "5.5 /monedas lista monedas Memecoin");

    // 5.6 Comando Telegram /agregar_moneda FLOKI meme
    const tgAddMsg = await bot.handleTelegramCommand("/agregar_moneda FLOKI meme");
    assert(tgAddMsg.includes("agregada exitosamente"), "5.6 /agregar_moneda confirma adición");
    assert(bot.memeWatchlist.includes("FLOKIUSDT"), "5.6 FLOKIUSDT registrado en memeWatchlist");

    // 5.7 Comando Telegram /quitar_moneda FLOKI
    const tgDelMsg = await bot.handleTelegramCommand("/quitar_moneda FLOKI");
    assert(tgDelMsg.includes("retirada de la lista"), "5.7 /quitar_moneda confirma retiro");
    assert(!bot.memeWatchlist.includes("FLOKIUSDT"), "5.7 FLOKIUSDT retirado de memeWatchlist");
  }

  // =========================================================================
  // RESUMEN FINAL
  // =========================================================================
  console.log("\n============================================================");
  console.log(`📊 RESULTADO DE LA AUDITORÍA DE SEGURIDAD:`);
  console.log(`   Total pruebas:   ${stats.total}`);
  console.log(`   \x1b[32mSuperadas (PASS):\x1b[0m ${stats.passed}`);
  console.log(`   \x1b[31mFalladas (FAIL):\x1b[0m  ${stats.failed}`);
  console.log("============================================================\n");

  if (stats.failed > 0) {
    console.error("❌ FALLOS ENCONTRADOS:");
    for (const f of stats.failures) {
      console.error(`  - ${f}`);
    }
    process.exit(1);
  } else {
    console.log("✅ TODOS LOS PROCESOS DELICADOS ESTÁN 100% BLINDADOS Y COMPROBADOS.");
    process.exit(0);
  }
}

runTestSuite().catch((err) => {
  console.error("Error fatal ejecutando la suite de auditoría:", err);
  process.exit(1);
});
