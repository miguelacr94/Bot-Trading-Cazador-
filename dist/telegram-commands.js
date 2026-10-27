/**
 * Escucha mensajes de Telegram (long polling) y responde comandos.
 * SOLO responde al TELEGRAM_CHAT_ID configurado; ignora a cualquier otra persona.
 */
export class TelegramCommands {
    handler;
    token = process.env.TELEGRAM_BOT_TOKEN || "";
    chatId = process.env.TELEGRAM_CHAT_ID || "";
    offset = 0;
    constructor(handler) {
        this.handler = handler;
    }
    api(m) {
        return `https://api.telegram.org/bot${this.token}/${m}`;
    }
    async start() {
        if (!this.token || !this.chatId)
            return;
        try {
            // Registrar menú de comandos en Telegram
            // Registrar menú completo de 29 comandos en Telegram
            const commands = [
                // Menú y Estrategias
                { command: "menu", description: "📋 Centro de comandos completo" },
                { command: "estrategias", description: "⚙️ Panel y switches de estrategias" },
                { command: "presupuesto", description: "💼 Presupuesto auto-graduado y saldos" },
                { command: "asignar", description: "🎯 Configurar % (ej: /asignar 40 25 0 35)" },
                { command: "regimen", description: "🧭 Diagnóstico volatilidad y Día Quieto" },
                { command: "weekend", description: "🏖️ Diagnóstico Cazador Weekend" },
                { command: "informe", description: "📑 Diagnóstico en tiempo real y PnL" },
                { command: "trailing", description: "🏹 Posiciones rastreando el pico más alto" },
                { command: "cazando", description: "🔻 Monedas cazando piso (Trailing Buy)" },
                { command: "reporte", description: "📈 Ganancias reales acumuladas (Binance)" },
                { command: "estado", description: "📊 Órdenes vivas y precios en Binance" },
                { command: "radar", description: "📡 Escáner de suelos y RSI en vivo" },
                { command: "balance", description: "💼 Consultar saldos en Binance Spot" },
                { command: "motores", description: "⚙️ Parámetros técnicos de los motores" },
                // Interruptores (Switches)
                { command: "toggle_trailing", description: "🏹 Activar / Pausar Cazador Trailing" },
                { command: "toggle_dca", description: "🛡️ Activar / Pausar Smart DCA" },
                { command: "toggle_grid", description: "🌐 Activar / Pausar Micro-Grid" },
                { command: "toggle_weekend", description: "🏖️ Activar / Pausar Cazador Weekend" },
                { command: "toggle_ia", description: "🤖 Activar / Silenciar Gemini Copilot" },
                { command: "stoploss", description: "🛡️ Ver estado y límite de Stop-Loss" },
                { command: "toggle_stoploss", description: "🛡️ Activar / Desactivar Stop-Loss" },
                { command: "set_stoploss", description: "🛡️ Fijar % Stop-Loss (ej: /set_stoploss 4.0)" },
                { command: "timeframe", description: "⏱️ Ver o cambiar temporalidad (15m, 1h, 4h)" },
                // Aprobaciones interactivas
                { command: "aprobar", description: "✅ Aprobar oportunidad recomendada" },
                { command: "ignorar", description: "❌ Descartar oportunidad de compra" },
                { command: "aprobar_grid", description: "🌐 Activar Micro-Grid en Día Quieto" },
                { command: "ignorar_grid", description: "❌ Descartar activación Micro-Grid" },
                // Modos y Control
                { command: "modo", description: "🤖 Ver o cambiar modo (/modo auto | manual)" },
                { command: "pausa", description: "⏸️ Pausar compras automáticas" },
                { command: "reanudar", description: "▶️ Reanudar compras automáticas" },
                // Operaciones manuales e IA
                { command: "comprar", description: "🛒 Compra manual (ej: /comprar eth)" },
                { command: "vender", description: "💰 Venta manual a mercado (ej: /vender sol)" },
                { command: "ai", description: "🧠 Consultar a Gemini AI (ej: /ai mercado)" }
            ];
            await fetch(this.api("setMyCommands"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ commands })
            });
            // Descartar mensajes viejos pendientes
            const old = await (await fetch(this.api("getUpdates?offset=-1"))).json();
            if (old.result?.length)
                this.offset = old.result[0].update_id + 1;
            this.loop();
        }
        catch (e) {
            console.error("Error iniciando TelegramCommands:", e.message);
        }
    }
    async loop() {
        while (true) {
            try {
                const res = await fetch(this.api(`getUpdates?timeout=25&offset=${this.offset}`));
                const data = await res.json();
                for (const u of data.result ?? []) {
                    this.offset = u.update_id + 1;
                    const msg = u.message;
                    if (!msg?.text || String(msg.chat.id) !== this.chatId)
                        continue;
                    const cmd = msg.text.trim().toLowerCase().split("@")[0];
                    console.log(`📱 Telegram comando recibido: ${cmd}`);
                    const reply = await this.handler(cmd);
                    const sendRes = await fetch(this.api("sendMessage"), {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ chat_id: this.chatId, text: reply, parse_mode: "HTML" }),
                    });
                    const sendData = await sendRes.json();
                    if (!sendData.ok) {
                        // Reintentar sin formato HTML por si contiene caracteres especiales
                        await fetch(this.api("sendMessage"), {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ chat_id: this.chatId, text: reply.replace(/<[^>]*>/g, "") }),
                        });
                    }
                }
            }
            catch {
                await new Promise((r) => setTimeout(r, 4000));
            }
        }
    }
}
