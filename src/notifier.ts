export class TelegramNotifier {
  private botToken: string;
  private chatId: string;

  constructor() {
    this.botToken = process.env.TELEGRAM_BOT_TOKEN || '';
    this.chatId = process.env.TELEGRAM_CHAT_ID || '';
  }

  async send(message: string): Promise<void> {
    if (!this.botToken || !this.chatId) {
      return; // Si no están configuradas las credenciales de Telegram, solo continúa
    }

    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text: message,
          parse_mode: 'HTML',
        }),
      });
    } catch (error: any) {
      console.error('⚠️ Error enviando notificación a Telegram:', error.message);
    }
  }
}
