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
   • Bóveda Simple Earn: 25% de las ganancias se envían a ganar interés pasivo flexible en Binance Earn.

=== ESTADO FINANCIERO EN VIVO DE MIGUEL ===
• Patrimonio Total Estimado: $${context.totalEstimatedUsdt.toFixed(2)} USDT (~$${(context.totalEstimatedUsdt * 4200).toLocaleString("es-CO")} COP)
• USDT Libre en Spot: $${context.freeUsdt.toFixed(2)} USDT
• USDT en Bóveda Simple Earn: $${context.earnUsdt.toFixed(2)} USDT
• Récord Histórico: ${context.performance.wins} victorias / ${context.performance.losses} derrotas (Win Rate: ${context.performance.winRate}%). Ganancia neta acumulada en caja: +$${context.performance.totalPnlUsdt.toFixed(2)} USDT (~$${(context.performance.totalPnlUsdt * 4200).toLocaleString("es-CO")} COP).
• Piloto Automático: ${context.autoPilot ? "🟢 ACTIVO (Auto-ejecuta recomendaciones si no respondes en 3 min)" : "🟡 MANUAL (Solo compra bajo tu confirmación explícita)"}
• Presupuesto actual: Trailing ${context.allocations.trailing_rebound}% | Smart DCA ${context.allocations.smart_dca}% | Micro-Grid ${context.allocations.micro_grid}%
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
            const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
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
            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            const reply = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!reply) {
                console.error("Gemini no devolvió respuesta:", JSON.stringify(data));
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
}
