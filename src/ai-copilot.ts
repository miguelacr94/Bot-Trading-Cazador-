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
      benchDropPct: number;
      drop24hPct: number;
      fibPosition24h?: number;
      rsi15m: number;
      lowerWick15mPct: number;
      cvd5mPct: number;
      qualifiesToBuy: boolean;
    }>;
  }): Promise<{
    verdictHtml: string;
    aiDecision?: {
      action: "BUY_NOW" | "ARM_TRAILING_BUY" | "LOCK_PROFIT_FLOOR" | "WIDEN_EXPANSION_TP" | "HOLD_AND_WAIT";
      targetSymbol?: string;
      confidence: number;
      lockedFloorPct?: number;
      customCallbackPct?: number;
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
            `- ${c.symbol}: Ref.Viernes $${c.exitPrice} -> Actual $${c.curPrice} (${c.benchDropPct >= 0 ? "+" : ""}${c.benchDropPct.toFixed(2)}% vs viernes | -${c.drop24hPct.toFixed(2)}% vs techo 24h | Ubicación Canal 24h: ${((c.fibPosition24h ?? 0.5) * 100).toFixed(0)}% | RSI 15m: ${c.rsi15m.toFixed(1)} | Mecha Inf 15m: ${c.lowerWick15mPct.toFixed(0)}% | CVD Comprador 5m: ${c.cvd5mPct.toFixed(0)}%)`
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
        `Reglas de decisión como Trader Experto:\n` +
        `1. JAMÁS comprar en techo (Ubicación Canal 24h > 48% o RSI > 45). Solo comprar ("BUY_NOW") o armar cacería ("ARM_TRAILING_BUY") cuando hay un descuento claro (en fin de semana >= -4.5% vs viernes o caída 24h >= 4%; entre semana Lunes post-barrido CME, Miércoles de sacudón macro o pullback de Martes/Jueves con caída 24h >= 2.2%, Ubicación Canal <= 38%, RSI <= 42 y mecha de absorción >= 25% con CVD >= 52%).\n` +
        `2. Si hay una posición abierta en ganancia (>= +0.85%) y ves agotamiento o estamos en Hora Techo, puedes elegir "LOCK_PROFIT_FLOOR" indicando lockedFloorPct (ej. 0.70 a 2.50). Si estamos en Martes o Jueves de Expansión y CVD >= 56%, puedes elegir "WIDEN_EXPANSION_TP" (customCallbackPct: 0.42) para dejar correr la ganancia al pico máximo.\n` +
        `3. Si el mercado está arriba o sin setup limpio, elige "HOLD_AND_WAIT".\n\n` +
        `Responde ÚNICAMENTE con un objeto JSON válido con esta estructura exacta:\n` +
        `{"action":"BUY_NOW"|"ARM_TRAILING_BUY"|"LOCK_PROFIT_FLOOR"|"WIDEN_EXPANSION_TP"|"HOLD_AND_WAIT","targetSymbol":"SOLUSDT","confidence":85,"lockedFloorPct":1.2,"customCallbackPct":0.40,"verdict":"Explicación táctica de 2-3 líneas en HTML simple con <b> y <i> de cómo ves el mercado hoy (${params.dayStr}), cuánto han bajado vs cierre viernes / techo 24h y tu decisión."}`;

      const candidateModels = ["gemini-2.5-flash", "gemini-flash-latest", "gemini-2.5-flash-lite"];
      for (const model of candidateModels) {
        try {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ role: "user", parts: [{ text: prompt }] }],
              generationConfig: { temperature: 0.2, maxOutputTokens: 1200 }
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
                  targetSymbol: parsed.targetSymbol,
                  confidence: Number(parsed.confidence || 0),
                  lockedFloorPct: parsed.lockedFloorPct ? Number(parsed.lockedFloorPct) : undefined,
                  customCallbackPct: parsed.customCallbackPct ? Number(parsed.customCallbackPct) : undefined
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
