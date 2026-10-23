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
            const commands = [
                { command: "menu", description: "📋 Lista completa de comandos" },
                { command: "estrategias", description: "⚙️ Ver y alternar motores activos (Trailing, DCA, Grid)" },
                { command: "presupuesto", description: "💼 Ver y modificar presupuesto por estrategia (% y $)" },
                { command: "aprobar", description: "✅ Aprobar oportunidad recomendada pendiente" },
                { command: "ignorar", description: "❌ Descartar oportunidad pendiente" },
                { command: "informe", description: "📑 Diagnóstico completo en tiempo real" },
                { command: "trailing", description: "🏹 Posiciones activas rastreando el pico" },
                { command: "cazando", description: "🔻 Trailing Buy: monedas cazando el piso" },
                { command: "reporte", description: "📈 Ganancias reales acumuladas (Binance)" },
                { command: "estado", description: "📊 Órdenes activas y precios en Binance" },
                { command: "radar", description: "📡 Escáner de suelos y RSI en tiempo real" },
                { command: "balance", description: "💼 Consultar saldos en Binance Spot" },
                { command: "modo", description: "🤖 Ver o cambiar modo (/modo auto | manual)" },
                { command: "pausa", description: "⏸️ Pausar compras automáticas" },
                { command: "reanudar", description: "▶️ Reanudar compras automáticas" }
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
