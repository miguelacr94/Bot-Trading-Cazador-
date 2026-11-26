import * as dotenv from "dotenv";
dotenv.config();

/**
 * Copiloto Conversacional de Trading con Gemini AI
 * Se comunica directamente con Miguel en Telegram con contexto 100% en vivo.
 */
export interface BotContextSnapshot {
  positions: Array<{
    symbol: string;
    qty: number;
    investedUsdt: number;
    buyPrice: number;
    curPrice: number;
    targetPrice: number;
    gainPct: number;
    pnlUsdt: number;
  }>;
  freeUsdt: number;
  earnUsdt: number;
  totalEstimatedUsdt: number;
  allocations: {
    trailing_rebound: number;
    smart_dca: number;
    micro_grid: number;
    cazador_weekend?: number;
  };
  autoPilot: boolean;
  marketSentiment: { value: number; classification: string };
  performance: {
    wins: number;
    losses: number;
    totalPnlUsdt: number;
    winRate: number;
  };
  radar: Array<{
    symbol: string;
    curPrice: number;
    rsi: number;
    dropPct: number;
    isHunting: boolean;
  }>;
}

export class AiCopilot {
  private apiKey: string = "";
  private history: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> = [];

  constructor() {
    this.apiKey = process.env.GEMINI_KEY || process.env.GEMINI_API_KEY || "";
  }

  getApiKey(): string {
    if (!this.apiKey || this.apiKey.length <= 10) {
      dotenv.config();
      this.apiKey = process.env.GEMINI_KEY || process.env.GEMINI_API_KEY || "";
    }
    return this.apiKey;
  }

  isAvailable(): boolean {
    return Boolean(this.getApiKey() && this.getApiKey().length > 10);
  }

  async chat(
    userMessage: string,
    context: BotContextSnapshot,
    actionHandlers: {
      setAllocations?: (t: number, d: number, g: number, w?: number) => Promise<string>;
      setAutoPilot?: (auto: boolean) => Promise<string>;
      pauseTrading?: (paused: boolean) => Promise<string>;
    }
  ): Promise<string> {
    const apiKey = this.getApiKey();
    if (!this.isAvailable()) {
      return "⚠️ <i>Gemini AI no está configurado en .env (GEMINI_KEY).</i>";
    }

    try {
      // 1. Construir System Instructions enriquecido con desglose detallado
      const positionsText = context.positions.length > 0
        ? context.positions.map(p => {
            const diffPct = (((p.targetPrice - p.curPrice) / p.curPrice) * 100);
            return `  • 🪙 <b>${p.symbol}</b>:\n` +
                   `    - Invertido: $${p.investedUsdt.toFixed(2)} USDT (${p.qty} monedas)\n` +
                   `    - Precio Compra: $${p.buyPrice} | Precio Actual: $${p.curPrice} (${p.gainPct >= 0 ? "+" : ""}${p.gainPct.toFixed(2)}%)\n` +
                   `    - Meta de Venta (+0.8%): $${p.targetPrice} (falta +${diffPct.toFixed(2)}% para vender en verde)`;
          }).join("\n\n")
        : "  <i>Actualmente no hay posiciones abiertas. Todo el capital está libre en USDT.</i>";

      const systemInstruction = `
Eres "Cazador AI", el copiloto cuantitativo de trading algorítmico y asesor personal de Miguel en Binance Spot.
Te comunicas directamente con Miguel a través de su bot privado de Telegram.

=== FILOSOFÍA Y REGLAS DEL BOT ===
1. Operamos EXCLUSIVAMENTE en Binance Spot (al contado). CERO apalancamiento, CERO futuros, CERO riesgo de liquidación.
2. REGLA SAGRADA: JAMÁS vender una moneda en pérdida (100% Win Rate, 13 de 13 ganadas). La paciencia en Spot garantiza salir siempre en ganancia.
3. ESTRATEGIAS ACTIVAS:
   • Trailing Rebound: Compra con +0.25% de rebote confirmado desde el piso. Vende al +0.80% asegurado o persigue el pico con callback de 0.30%.
   • Smart DCA: Si una moneda cae -2.5% con RSI bajo, promedia matemáticamente para acercar la salida en verde. Límite: 2 inyecciones y enfriamiento de 2 horas.
   • Cazador Weekend: Se activa los fines de semana (viernes 17:00 a domingo 18:00 COT). Caza la mejor sobreventa con Trailing Buy en el piso exacto (+0.35% rebote) y persigue el rebote máximo de domingo noche, lunes o el día que suba más con Trailing Take Profit (+0.80% a +3.5%) para vender en la cima sin pérdida.
   • Bóveda Simple Earn: 25% de las ganancias se envían a ganar interés pasivo flexible en Binance Earn.

=== ESTADO FINANCIERO EN VIVO DE MIGUEL ===
• Patrimonio Total Estimado: $${context.totalEstimatedUsdt.toFixed(2)} USDT (~$${(context.totalEstimatedUsdt * 4200).toLocaleString("es-CO")} COP)
• USDT Libre en Spot: $${context.freeUsdt.toFixed(2)} USDT
• USDT en Bóveda Simple Earn: $${context.earnUsdt.toFixed(2)} USDT
• Récord Histórico: ${context.performance.wins} victorias / ${context.performance.losses} derrotas (Win Rate: ${context.performance.winRate}%). Ganancia neta acumulada en caja: +$${context.performance.totalPnlUsdt.toFixed(2)} USDT (~$${(context.performance.totalPnlUsdt * 4200).toLocaleString("es-CO")} COP).
• Piloto Automático: ${context.autoPilot ? "🟢 ACTIVO (Auto-ejecuta recomendaciones si no respondes en 3 min)" : "🟡 MANUAL (Solo compra bajo tu confirmación explícita)"}
• Presupuesto actual: Trailing ${context.allocations.trailing_rebound}% | Smart DCA ${context.allocations.smart_dca}% | Micro-Grid ${context.allocations.micro_grid}% | Cazador Weekend ${context.allocations.cazador_weekend ?? 20}%
• Sentimiento de Mercado (Fear & Greed): ${context.marketSentiment.value}/100 (${context.marketSentiment.classification})

=== DESGLOSE DETALLADO DE POSICIONES ABIERTAS ===
${positionsText}

=== RADAR DE MONEDAS EN VIGILANCIA (SOBREVENTA) ===
${context.radar.map(r => `• 📡 ${r.symbol}: $${r.curPrice} (RSI: ${r.rsi.toFixed(1)}${r.isHunting ? " | 🏹 CAZANDO PISO TICK A TICK" : ""})`).join("\n")}

=== DIRECTRICES DE RESPUESTA ===
1. Si Miguel pregunta por posiciones abiertas, ventas activas o cómo vamos:
   - Dale un saludo cálido.
   - MUESTRA SIEMPRE el desglose completo de CADA una de las monedas activas con su nombre, cuánto tiene invertido, el precio actual, y exactamente cuánto le falta en porcentaje (%) para tocar la meta de venta en verde.
   - Da un comentario técnico tranquilizador y estratégico (recordando que en Spot no hay apalancamiento y esperamos el rebote natural).
2. Usa viñetas limpias, emojis de trading y formato ordenado para Telegram.
3. NUNCA cortes la respuesta a medias. Termina siempre tus oraciones y ofrece tu ayuda para cualquier acción.
`;

      // 2. Preparar historial con límite de 8 turnos
      if (this.history.length > 8) {
        this.history = this.history.slice(-8);
      }

      const contents = [
        ...this.history,
        { role: "user" as const, parts: [{ text: userMessage }] }
      ];

      const payload = {
        system_instruction: {
          parts: [{ text: systemInstruction }]
        },
        contents,
        generationConfig: {
          temperature: 0.35,
          maxOutputTokens: 1500 // Ampliado para reportes ricos y completos sin cortes
        }
      };

      const candidateModels = ["gemini-2.5-flash", "gemini-flash-latest", "gemini-2.5-flash-lite"];
      let reply: string | undefined;

      for (const model of candidateModels) {
        try {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });
          const data = await res.json();
          if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
            reply = data.candidates[0].content.parts[0].text;
            break;
          } else if (data.error?.code === 503 || data.error?.code === 429) {
            console.log(`Modelo ${model} ocupado (${data.error.code}). Probando modelo de respaldo...`);
            continue;
          }
        } catch (e: any) {
          console.error(`Error llamando a ${model}:`, e.message);
        }
      }

      if (!reply) {
        console.error("Gemini no devolvió respuesta en ningún modelo.");
        return "🤖 <i>Tuve un inconveniente al procesar tu mensaje. Intenta de nuevo en unos segundos.</i>";
      }

      // Guardar en historial
      this.history.push({ role: "user", parts: [{ text: userMessage }] });
      this.history.push({ role: "model", parts: [{ text: reply }] });

      return reply;
    } catch(err: any) {
      console.error("Error en AiCopilot.chat:", err.message);
      return `⚠️ <i>Error consultando a Gemini AI: ${err.message}</i>`;
    }
  }

  /**
   * 🧠 AGENTE IA TRADER AUTÓNOMO 24/7 (LUNES A DOMINGO — DECISIONES DE COMPRA, RASTREO Y COSECHA):
   * Actúa como un trader institucional discrecional todos los días de la semana (no solo fines de semana
   * ni solo con reglas estáticas): evalúa la acción del precio, mechas, flujo de órdenes CVD, posiciones abiertas,
   * cierre del viernes / máximo de 24h y el Calendario de 5.5 Años, devolviendo una decisión ejecutable en JSON.
   */
  async evaluateAutonomousBenchmarkCycle(params: {
    benchmarkDateStr: string;
    dayStr: string;
    calendarLabel: string;
    regimeKey: string;
    sessionTitle: string;
    spendableUsdt: number;
    btcAnchorOk: boolean;
    executedSymbol?: string;
    executedAmountUsdt?: number;
    openPositions?: Array<{
      symbol: string;
      buyPrice: number;
      curPrice: number;
      highestPrice: number;
      gainPct: number;
      lockedFloorGainPct?: number;
    }>;
    coins: Array<{
      symbol: string;
      exitPrice: number;
      curPrice: number;
      low24h?: number;
      structuralFloor4d?: number;
      fibPosition4d?: number;
      downsideTo4dFloorPct?: number;
      sma24h?: number;
      distFromSma24hPct?: number;
      downsideToFloorPct?: number;
      isBullTrapFakeout?: boolean;
      benchDropPct: number;
      drop24hPct: number;
      fibPosition24h?: number;
      rsi15m: number;
      rsi1h?: number;
      lowerWick15mPct: number;
      cvd5mPct: number;
      qualifiesToBuy: boolean;
    }>;
  }): Promise<{
    verdictHtml: string;
    aiDecision?: {
      action: "BUY_NOW" | "ARM_TRAILING_BUY" | "LOCK_PROFIT_FLOOR" | "WIDEN_EXPANSION_TP" | "HOLD_AND_WAIT";
      regimeOverride?: "NONE" | "CRASH_HUNTER" | "RALLY_HARVESTER" | "RANGE_SCALPER";
      targetSymbol?: string;
      confidence: number;
      lockedFloorPct?: number;
      customCallbackPct?: number;
      coinCalibrations?: Record<string, {
        minGainPct: number;
        callbackPct: number;
        bounceBuyPct?: number;
        maxEntryRsi?: number;
        maxEntryFib?: number;
        targetFloorPrice?: number;
        trapDetected?: boolean;
        strategyMode?: "SWING_REBOUND" | "RALLY_EXPANSION" | "SCALP_RANGE" | "ACCUMULATION" | "AVOID_BULL_TRAP";
      }>;
    };
  }> {
    const isWeekend = params.dayStr === "Sat" || params.dayStr === "Sun" || params.dayStr === "Fri";
    const bestDrop = [...params.coins].sort((a, b) => (isWeekend ? a.benchDropPct - b.benchDropPct : b.drop24hPct - a.drop24hPct))[0];
    const fallbackVerdict = params.executedSymbol
      ? `✅ <b>Dictamen Trader IA:</b> Piso institucional confirmado en <b>${params.executedSymbol}</b> con absorción en 15m/5m y flujo comprador CVD. Compra ejecutada automáticamente ($${(params.executedAmountUsdt || 0).toFixed(2)} USDT).`
      : (bestDrop && (bestDrop.benchDropPct <= -4.5 || bestDrop.drop24hPct >= 3.2)
        ? `🎯 <b>Dictamen Trader IA:</b> <b>${bestDrop.symbol.replace("USDT", "")}</b> está en zona de descuento atractivo (<b>${bestDrop.benchDropPct.toFixed(2)}%</b> vs ref. viernes | <b>-${bestDrop.drop24hPct.toFixed(2)}%</b> desde techo 24h, RSI ${bestDrop.rsi15m.toFixed(0)}). Rastreando freno y giro CVD >= 52% para entrar en el suelo exacto.`
        : `⏳ <b>Dictamen Trader IA (${params.dayStr}):</b> Mercado sin descuento profundo aún (mayor retroceso: <b>${bestDrop ? bestDrop.symbol.replace("USDT", "") : "N/A"} -${bestDrop ? bestDrop.drop24hPct.toFixed(2) : "0.00"}%</b> vs techo 24h | <b>${bestDrop ? (bestDrop.benchDropPct >= 0 ? "+" : "") + bestDrop.benchDropPct.toFixed(2) : "0.00"}%</b> vs cierre viernes). Evitando compras en techo; capital ($${params.spendableUsdt.toFixed(2)} USDT) listo para el próximo pullback a soporte.`);

    if (!this.isAvailable()) {
      return { verdictHtml: fallbackVerdict };
    }

    try {
      const apiKey = this.getApiKey();
      const coinsSummary = params.coins
        .map(
          (c) =>
            `- ${c.symbol}: Actual $${c.curPrice} | PisoRecurrente4D $${(c.structuralFloor4d ?? c.low24h ?? c.curPrice).toFixed(4)} (Ubicación Canal 4D: ${((c.fibPosition4d ?? 0.5) * 100).toFixed(0)}% | Vacío a Piso4D: -${(c.downsideTo4dFloorPct ?? 0).toFixed(2)}%) | Piso24h $${c.low24h ?? c.curPrice} (Vacío a Piso24h: -${(c.downsideToFloorPct ?? 0).toFixed(2)}%) | Desv. vs Media24h: ${(c.distFromSma24hPct ?? 0) >= 0 ? "+" : ""}${(c.distFromSma24hPct ?? 0).toFixed(2)}% | ${c.benchDropPct >= 0 ? "+" : ""}${c.benchDropPct.toFixed(2)}% vs Vie | Canal24h: ${((c.fibPosition24h ?? 0.5) * 100).toFixed(0)}% | RSI 15m: ${c.rsi15m.toFixed(1)} | RSI 1H: ${(c.rsi1h ?? c.rsi15m).toFixed(1)} | CVD 5m: ${c.cvd5mPct.toFixed(0)}% | Trampa: ${c.isBullTrapFakeout ? "⚠️ BULL-TRAP / ARRIBA DEL PISO 4D" : "OK"}`
        )
        .join("\n");

      const openPosSummary = (params.openPositions && params.openPositions.length > 0)
        ? params.openPositions.map(p => `- ${p.symbol}: Compra $${p.buyPrice} -> Actual $${p.curPrice} (${p.gainPct >= 0 ? "+" : ""}${p.gainPct.toFixed(2)}% | Pico $${p.highestPrice} | Piso asegurado: ${p.lockedFloorGainPct ? "+" + p.lockedFloorGainPct.toFixed(2) + "%" : "ninguno"})`).join("\n")
        : "Ninguna posición abierta actualmente.";

      const prompt =
        `Eres el Trader Institucional IA Autónomo 24/7 del bot Binance Spot de Miguel. Operas tanto de Lunes a Viernes como Fines de Semana tomando decisiones dinámicas como un trader experto.\n` +
        `Día actual: ${params.dayStr} | Régimen 5.5 Años: ${params.calendarLabel} (${params.regimeKey})\n` +
        `Sesión Horaria Actual: ${params.sessionTitle}\n` +
        `Ancla Bitcoin 15m estable/girando: ${params.btcAnchorOk ? "SÍ" : "NO (BTC aún débil)"}\n` +
        `Capital disponible en el bot: $${params.spendableUsdt.toFixed(2)} USDT\n` +
        `Posiciones abiertas:\n${openPosSummary}\n\n` +
        `Telemetría en vivo de la Watchlist (Precios vs Cierre Viernes ${params.benchmarkDateStr} y Canal 24h):\n${coinsSummary}\n\n` +
        `Reglas de decisión como Trader Institucional (PROHIBIDO COMPRAR POR COMPRAR):\n` +
        `1. CICLO SEMANAL DE 5.5 AÑOS:\n` +
        `   • LUNES (DÍA CLAVE DE ACUMULACIÓN PARA EL MARTES): Los martes son estadísticamente el día de mayor expansión y alza (+5.87% histórico). Para cosechar y vender en verde el Martes, ES OBLIGATORIO acumular inventario hoy Lunes durante retrocesos técnicos a soporte intradía (caída >= 1.6% en core / >= 2.2% en memes, canal 24h <= 38%, RSI <= 46). Si no compramos el Lunes en soporte, el Martes NO tendremos nada que vender.\n` +
        `   • MIÉRCOLES (ACUMULACIÓN MACRO PARA EL JUEVES): Caída >= 2.5% a 3.5% en soporte para vender en el rally del Jueves (+5.51% hist.).\n` +
        `   • FIN DE SEMANA: Cacería de capitulación vs cierre de viernes (caída >= -4.8% a -10%).\n` +
        `   • DÍAS DE VENTA Y COSECHA EN ALZA: Martes (+5.87% hist.), Jueves (+5.51% hist.) y Viernes Mañana son días para VENDER EN EL PUNTO MÁS ALTO lo acumulado en la caída previa. En Martes, Jueves y Viernes NO se compra salvo un crash extremo atípico (caída >= -5.2%, Ubicación Canal <= 15% y RSI <= 30).\n` +
        `1. LEY DE POLARIDAD SEMANAL E IMÁN DEL GAP CME (POR QUÉ LOS DÍAS DE LA SEMANA NO SON FIJOS):\n` +
        `   • ¡NUNCA apliques un día de la semana a ciegas sin mirar qué pasó el fin de semana vs el Cierre del Viernes (Gap CME)!\n` +
        `   • CASO NORMAL (Fin de Semana Bajista, precio <= -2.5% vs Viernes): El Gap CME quedó ARRIBA. Entonces Lunes es piso de acumulación y Martes sube fuerte (+5.87%) a cerrar el Gap arriba.\n` +
        `   • CASO INVERTIDO (Fin de Semana Alcista, precio > +1.5% vs Viernes): Si Sábado y Domingo la moneda SUBIÓ en vez de caer, el Gap CME del viernes quedó abierto ABAJO. En ese escenario, Lunes y Martes SE INVIERTEN: Wall Street vende para bajar a cerrar el Gap del viernes y regresar al PisoRecurrente4D. ¡PROHIBIDO comprar arriba del cierre del viernes o arriba del PisoRecurrente4D cuando el fin de semana fue alcista!\n` +
        `   • DÍAS DE COSECHA: Cuando tenemos posiciones abiertas en BTC/ETH, la prioridad es venderlas en GANANCIA REAL con Trailing Take Profit cuando el rebote post-cierre de Gap CME las lleve por encima del precio de compra.\n` +
        `2. CONDICIONES ESTRICTAS ANTI-CAÍDA POST-COMPRA (CERO TOLERANCIA A CAÍDAS DE -3% TRAS COMPRAR):\n` +
        `   • PROHIBIDO comprar a mitad de canal (Canal > 18%) o con RSI tibio (RSI > 34), porque si la moneda baja al piso del canal (0%) sufriríamos un -3% de caída flotante.\n` +
        `   • Solo autoriza "ARM_TRAILING_BUY" cuando la moneda esté en el FONDO REAL DEL CANAL (Ubicación Canal 24h <= 18%, RSI 15m <= 34, caída >= 2.8% en altcoins / >= 3.5% en BTC / >= 3.8% en memes).\n` +
        `   • Prioriza siempre "ARM_TRAILING_BUY" sobre "BUY_NOW" para que el motor Trailing Buy persiga el precio hacia abajo hasta que deje de caer y solo compre en el giro confirmado (+0.25% a +0.35% desde el mínimo).\n` +
        `3. Si hay una posición abierta en ganancia (>= +0.85%) en Martes, Jueves o Domingo, usa "WIDEN_EXPANSION_TP" (customCallbackPct: 0.42) mientras CVD >= 56% para exprimir toda la subida, o "LOCK_PROFIT_FLOOR" (lockedFloorPct) cuando detectes agotamiento en la cima.\n` +
        `4. DETECCIÓN DE COMPORTAMIENTOS ATÍPICOS Y CAMBIO DE ESTRATEGIA ("regimeOverride"):\n` +
        `   • Si es Martes o Jueves (día de venta) pero el mercado sufre un desplome atípico fuerte (caídas >= 4.5% con sobreventa), activa "regimeOverride": "CRASH_HUNTER" para cambiar de modo venta a modo cacería de suelo.\n` +
        `   • Si es Sábado, Lunes o Miércoles (día de caída) pero el mercado hace un rally alcista explosivo atípico, activa "regimeOverride": "RALLY_HARVESTER" para cosechar ganancias arriba y bloquear compras en techo.\n` +
        `   • Si el mercado lleva horas estancado en rango lateral estrecho (< 2.2% en 24h), activa "regimeOverride": "RANGE_SCALPER" para encender Micro-Grid.\n` +
        `   • Si el mercado sigue el patrón normal, usa "regimeOverride": "NONE".\n` +
        `5. ESTUDIO CUANTITATIVO ANTI-ENGAÑO Y CALIBRACIÓN DINÁMICA POR MONEDA ("coinCalibrations"):\n` +
        `   • Tu deber principal es NO DEJARTE ENGAÑAR por falsos retrocesos tras un mechazo alcista (Pump & Dump / Bull Trap).\n` +
        `   • Si una moneda tiene "Desv. vs Media24h" > -1.0% (sigue cara respecto a su promedio de 24h), o "Vacío hasta piso" > 1.25% (todavía puede caer -2% o -3% hasta su Piso24h), o "RSI 1H" > 42, o "Detector Trampa: BULL-TRAP", márcala con "trapDetected": true y "strategyMode": "AVOID_BULL_TRAP" para prohibir compras prematuras.\n` +
        `   • Ajusta dinámicamente los parámetros de entrada y salida de cada moneda según su estudio en vivo:\n` +
        `     - "maxEntryRsi": RSI 15m máximo permitido para comprar esa moneda (ej. 30 a 32 en BTC/ETH, 33 a 34 en Altcoins/Memes).\n` +
        `     - "maxEntryFib": Ubicación máxima en el canal 24h para entrar (ej. 0.14 a 0.18, garantizando que esté pegada al soporte).\n` +
        `     - "targetFloorPrice": Precio exacto donde estimas su piso estructural seguro (cerca de Piso24h).\n` +
        `     - "bounceBuyPct": Rebote exigido en Trailing Buy desde el suelo antes de disparar (0.28% a 0.45%; súbelo si cae con fuerza para evitar rebotes falsos de gato muerto).\n` +
        `     - Memecoins (PEPEUSDT, DOGEUSDT): "minGainPct" 1.80 a 2.50%, "callbackPct" 0.42 a 0.50%, "bounceBuyPct": 0.38.\n` +
        `     - Monedas Volátiles (SOLUSDT, SUIUSDT, AVAXUSDT, NEARUSDT): "minGainPct" 0.95 a 1.30%, "callbackPct" 0.30 a 0.36%, "bounceBuyPct": 0.30.\n` +
        `     - Monedas Clásicas (BTCUSDT, ETHUSDT, BNBUSDT): "minGainPct" 0.80 a 1.15%, "callbackPct" 0.22 a 0.28%, "bounceBuyPct": 0.25.\n\n` +
        `Responde ÚNICAMENTE con un objeto JSON válido con esta estructura exacta:\n` +
        `{"action":"BUY_NOW"|"ARM_TRAILING_BUY"|"LOCK_PROFIT_FLOOR"|"WIDEN_EXPANSION_TP"|"HOLD_AND_WAIT","regimeOverride":"NONE"|"CRASH_HUNTER"|"RALLY_HARVESTER"|"RANGE_SCALPER","targetSymbol":"SOLUSDT","confidence":85,"lockedFloorPct":1.2,"customCallbackPct":0.40,"coinCalibrations":{"BTCUSDT":{"minGainPct":1.15,"callbackPct":0.28,"bounceBuyPct":0.28,"maxEntryRsi":32,"maxEntryFib":0.15,"targetFloorPrice":59500,"trapDetected":false,"strategyMode":"SWING_REBOUND"},"PEPEUSDT":{"minGainPct":1.85,"callbackPct":0.45,"bounceBuyPct":0.38,"maxEntryRsi":33,"maxEntryFib":0.16,"targetFloorPrice":0.00000340,"trapDetected":false,"strategyMode":"RALLY_EXPANSION"}},"verdict":"Explicación táctica de 2-3 líneas en HTML simple con <b> y <i> de tu estudio del mercado hoy (${params.dayStr}), qué trampas descartaste y tu ajuste de parámetros."}`;

      const candidateModels = ["gemini-2.5-flash", "gemini-flash-latest", "gemini-2.5-flash-lite"];
      for (const model of candidateModels) {
        try {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ role: "user", parts: [{ text: prompt }] }],
              generationConfig: {
                temperature: 0.2,
                maxOutputTokens: 1200,
                responseMimeType: "application/json",
                thinkingConfig: { thinkingBudget: 0 }
              }
            })
          });
          const data = await res.json();
          const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (rawText && rawText.trim().length > 15) {
            const jsonMatch = rawText.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]);
              return {
                verdictHtml: `🤖 <b>Dictamen Trader IA (${params.dayStr}):</b> ${(parsed.verdict || "").trim()}`,
                aiDecision: {
                  action: parsed.action || "HOLD_AND_WAIT",
                  regimeOverride: parsed.regimeOverride || "NONE",
                  targetSymbol: parsed.targetSymbol,
                  confidence: Number(parsed.confidence || 0),
                  lockedFloorPct: parsed.lockedFloorPct ? Number(parsed.lockedFloorPct) : undefined,
                  customCallbackPct: parsed.customCallbackPct ? Number(parsed.customCallbackPct) : undefined,
                  coinCalibrations: (parsed.coinCalibrations && typeof parsed.coinCalibrations === "object") ? parsed.coinCalibrations : undefined
                }
              };
            }
            return {
              verdictHtml: `🤖 <b>Dictamen Trader IA (${params.dayStr}):</b> ${rawText.trim().replace(/```html|```json|```/g, "")}`
            };
          }
        } catch {}
      }
      return { verdictHtml: fallbackVerdict };
    } catch {
      return { verdictHtml: fallbackVerdict };
    }
  }
}
