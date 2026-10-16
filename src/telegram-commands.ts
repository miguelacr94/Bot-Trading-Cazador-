type Handler = (cmd: string) => Promise<string>;

/**
 * Escucha mensajes de Telegram (long polling) y responde comandos.
 * SOLO responde al TELEGRAM_CHAT_ID configurado; ignora a cualquier otra persona.
 */
export class TelegramCommands {
  private token = process.env.TELEGRAM_BOT_TOKEN || '';
  private chatId = process.env.TELEGRAM_CHAT_ID || '';
  private offset = 0;

  constructor(private handler: Handler) {}

  private api(m: string) {
    return `https://api.telegram.org/bot${this.token}/${m}`;
  }

  async start() {
    if (!this.token || !this.chatId) return;
    // Descartar mensajes viejos pendientes
    const old = await (await fetch(this.api('getUpdates?offset=-1'))).json();
    if (old.result?.length) this.offset = old.result[0].update_id + 1;
    this.loop();
  }

  private async loop() {
    while (true) {
      try {
        const res = await fetch(this.api(`getUpdates?timeout=30&offset=${this.offset}`));
        const data = await res.json();
        for (const u of data.result ?? []) {
          this.offset = u.update_id + 1;
          const msg = u.message;
          if (!msg?.text || String(msg.chat.id) !== this.chatId) continue;
          const reply = await this.handler(msg.text.trim().toLowerCase().split('@')[0]);
          await fetch(this.api('sendMessage'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: this.chatId, text: reply, parse_mode: 'HTML' }),
          });
        }
      } catch {
        await new Promise((r) => setTimeout(r, 5000)); // sin internet: reintenta
      }
    }
  }
}
