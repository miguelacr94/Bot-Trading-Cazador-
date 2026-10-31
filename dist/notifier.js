export class TelegramNotifier {
    botToken;
    chatId;
    constructor() {
        this.botToken = process.env.TELEGRAM_BOT_TOKEN || '';
        this.chatId = process.env.TELEGRAM_CHAT_ID || '';
    }
    async send(message, buttons) {
        if (!this.botToken || !this.chatId) {
            return;
        }
        try {
            const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
            const payload = {
                chat_id: this.chatId,
                text: message,
                parse_mode: 'HTML',
            };
            if (buttons && buttons.length > 0) {
                payload.reply_markup = {
                    inline_keyboard: buttons,
                };
            }
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const data = await res.json();
            if (!data.ok) {
                // Fallback si falla HTML parse
                const plain = message.replace(/<[^>]*>/g, '');
                const fallbackPayload = {
                    chat_id: this.chatId,
                    text: plain,
                };
                if (buttons && buttons.length > 0) {
                    fallbackPayload.reply_markup = {
                        inline_keyboard: buttons,
                    };
                }
                await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(fallbackPayload),
                });
            }
        }
        catch (error) {
            console.error('⚠️ Error enviando notificación a Telegram:', error.message);
        }
    }
    async sendPhoto(photoUrl, caption) {
        if (!this.botToken || !this.chatId)
            return;
        try {
            const url = `https://api.telegram.org/bot${this.botToken}/sendPhoto`;
            await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: this.chatId,
                    photo: photoUrl,
                    caption: caption || '',
                    parse_mode: 'HTML',
                }),
            });
        }
        catch (error) {
            console.error('⚠️ Error enviando foto a Telegram:', error.message);
        }
    }
}
