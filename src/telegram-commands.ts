type Handler = (cmd: string) => Promise<string>;

/**
 * Escucha mensajes de Telegram (long polling) y responde comandos.
 * SOLO responde al TELEGRAM_CHAT_ID configurado; ignora a cualquier otra persona.
 */
export class TelegramCommands {
  private token = process.env.TELEGRAM_BOT_TOKEN || "";
  private chatId = process.env.TELEGRAM_CHAT_ID || "";
  private offset = 0;

  constructor(private handler: Handler) {}

  private api(m: string) {
    return `https://api.telegram.org/bot${this.token}/${m}`;
  }

  async start() {
    if (!this.token || !this.chatId) return;
    try {
      // Registrar menú de comandos en Telegram
      const commands = [
        { command: "menu", description: "📋 Lista completa de comandos" },
        { command: "informe", description: "📑 Diagnóstico detallado en tiempo real" },
        { command: "trailing", description: "🏹 Monitoreo de picos y gatillos Trailing" },
        { command: "estado", description: "📊 Órdenes activas y precios en Binance" },
        { command: "radar", description: "📡 Escanear rebotes al +1.8%" },
        { command: "balance", description: "💼 Consultar saldos en Binance Spot" },
        { command: "reporte", description: "📈 Ver historial de ganancias y PnL" },
        { command: "motores", description: "⚙️ Ver estrategias y motores activos" },
        { command: "comprar", description: "🛒 Comprar cripto (ej: /comprar eth)" },
        { command: "vender", description: "🚨 Venta inmediata por mercado" },
        { command: "modo", description: "🤖 Alternar modo auto o manual" },
        { command: "pausa", description: "⏸️ Pausar el bot" },
        { command: "reanudar", description: "▶️ Reanudar el bot" }
      ];
      await fetch(this.api("setMyCommands"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commands })
      });

      // Descartar mensajes viejos pendientes
      const old = await (await fetch(this.api("getUpdates?offset=-1"))).json();
      if (old.result?.length) this.offset = old.result[0].update_id + 1;
      this.loop();
    } catch (e: any) {
      console.error("Error iniciando TelegramCommands:", e.message);
    }
  }

  private async loop() {
    while (true) {
      try {
        const res = await fetch(this.api(`getUpdates?timeout=25&offset=${this.offset}`));
        const data = await res.json();
        for (const u of data.result ?? []) {
          this.offset = u.update_id + 1;
          const msg = u.message;
          if (!msg?.text || String(msg.chat.id) !== this.chatId) continue;
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
      } catch {
        await new Promise((r) => setTimeout(r, 4000));
      }
    }
  }
}
