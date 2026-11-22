import * as dotenv from "dotenv";
dotenv.config();
export class AiCopilot {
    apiKey = "";
    history = [];
    constructor() {
        this.apiKey = process.env.GEMINI_KEY || process.env.GEMINI_API_KEY || "";
    }
    getApiKey() {
        if (!this.apiKey || this.apiKey.length <= 10) {
            dotenv.config();
            this.apiKey = process.env.GEMINI_KEY || process.env.GEMINI_API_KEY || "";
        }
        return this.apiKey;
    }
    isAvailable() {
        return Boolean(this.getApiKey() && this.getApiKey().length > 10);
    }
    async chat(userMessage, context, actionHandlers) {
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
                { role: "user", parts: [{ text: userMessage }] }
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
            let reply;
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
                    }
                    else if (data.error?.code === 503 || data.error?.code === 429) {
                        console.log(`Modelo ${model} ocupado (${data.error.code}). Probando modelo de respaldo...`);
                        continue;
                    }
                }
                catch (e) {
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
        }
        catch (err) {
            console.error("Error en AiCopilot.chat:", err.message);
            return `⚠️ <i>Error consultando a Gemini AI: ${err.message}</i>`;
        }
    }
    /**
     * 🧠 AGENTE IA AUTÓNOMO DE BENCHMARK Y EJECUCIÓN (CICLO PERIÓDICO EN SERVIDOR 24/7):
     * Analiza periódicamente qué tanto han caído las monedas respecto al cierre del viernes
     * y al techo de 24h, evalúa el Calendario de 5.5 Años y emite el dictamen ejecutivo para Telegram.
     */
    async evaluateAutonomousBenchmarkCycle(params) {
        const bestDrop = [...params.coins].sort((a, b) => a.benchDropPct - b.benchDropPct)[0];
        const fallbackVerdict = params.executedSymbol
            ? `✅ <b>Dictamen IA:</b> Descuento objetivo alcanzado en <b>${params.executedSymbol}</b> con absorción institucional confirmada en 15m/5m. Compra disparada automáticamente ($${(params.executedAmountUsdt || 0).toFixed(2)} USDT).`
            : (bestDrop && bestDrop.benchDropPct <= -4.8
                ? `🎯 <b>Dictamen IA:</b> <b>${bestDrop.symbol.replace("USDT", "")}</b> ya está en zona de descuento profundo (<b>${bestDrop.benchDropPct.toFixed(2)}%</b> vs cierre viernes). Esperando mecha de freno 15m y giro CVD >= 52% para disparar compra sin atrapar cuchillo cayendo.`
                : `⏳ <b>Dictamen IA:</b> La mayor caída vs el cierre del viernes es <b>${bestDrop ? bestDrop.symbol.replace("USDT", "") : "N/A"} (${bestDrop ? (bestDrop.benchDropPct >= 0 ? "+" : "") + bestDrop.benchDropPct.toFixed(2) : "0.00"}%)</b>. Aún no alcanza el descuento objetivo (-4.8% a -10%). Manteniendo $${params.spendableUsdt.toFixed(2)} USDT protegidos y vigilando cada 15 min.`);
        if (!this.isAvailable()) {
            return fallbackVerdict;
        }
        try {
            const apiKey = this.getApiKey();
            const coinsSummary = params.coins
                .map((c) => `- ${c.symbol}: Cierre Viernes $${c.exitPrice} -> Actual $${c.curPrice} (${c.benchDropPct >= 0 ? "+" : ""}${c.benchDropPct.toFixed(2)}% vs viernes | -${c.drop24hPct.toFixed(2)}% desde máximo 24h | RSI 15m: ${c.rsi15m.toFixed(1)} | Mecha 15m: ${c.lowerWick15mPct.toFixed(0)}% | CVD 5m: ${c.cvd5mPct.toFixed(0)}% | Gatillo Compra: ${c.qualifiesToBuy ? "LISTO" : "ESPERANDO"})`)
                .join("\n");
            const prompt = `Eres el Agente IA Autónomo del bot de trading Binance Spot de Miguel. Estás haciendo tu auditoría automática periódica en el servidor.\n` +
                `Régimen Calendario 5.5 Años: ${params.calendarLabel}\n` +
                `Sesión Horaria Actual: ${params.sessionTitle}\n` +
                `Capital disponible en el bot: $${params.spendableUsdt.toFixed(2)} USDT\n` +
                `Fecha de referencia Cierre Viernes: ${params.benchmarkDateStr}\n` +
                `${params.executedSymbol ? `ACCIÓN EJECUTADA AHORA MISMO: Se acaba de COMPRAR automáticamente ${params.executedSymbol} con $${(params.executedAmountUsdt || 0).toFixed(2)} USDT.` : "ACCIÓN ACTUAL: Ninguna compra disparada en este ciclo."}\n\n` +
                `Comparativa en vivo de las monedas vs Cierre del Viernes:\n${coinsSummary}\n\n` +
                `Redacta un dictamen táctico breve (máximo 3 líneas en HTML simple con <b> y <i>, sin bloques markdown \`\`\`) explicando:\n` +
                `1. Qué tanto han bajado o subido respecto al cierre del viernes.\n` +
                `2. Por qué compraste ahora mismo o cuánto falta (% y condiciones de RSI/mecha) para disparar la compra automática.`;
            const candidateModels = ["gemini-2.5-flash", "gemini-flash-latest", "gemini-2.5-flash-lite"];
            for (const model of candidateModels) {
                try {
                    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
                    const res = await fetch(url, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            contents: [{ role: "user", parts: [{ text: prompt }] }],
                            generationConfig: { temperature: 0.25, maxOutputTokens: 1200 }
                        })
                    });
                    const data = await res.json();
                    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
                    if (text && text.trim().length > 15) {
                        return `🤖 <b>Dictamen Agente IA:</b> ${text.trim().replace(/```html|```/g, "")}`;
                    }
                }
                catch { }
            }
            return fallbackVerdict;
        }
        catch {
            return fallbackVerdict;
        }
    }
}
