import * as fs from 'fs';
const token = process.argv[2];
if (!token) {
    console.log('Uso: npm run telegram:setup <TOKEN_DE_BOTFATHER>');
    process.exit(1);
}
const api = (m) => `https://api.telegram.org/bot${token}/${m}`;
const me = await (await fetch(api('getMe'))).json();
if (!me.ok) {
    console.log('❌ Token inválido:', me.description);
    process.exit(1);
}
const upd = await (await fetch(api('getUpdates'))).json();
const msg = [...(upd.result ?? [])].reverse().find((u) => u.message?.chat?.id);
if (!msg) {
    console.log(`❌ No encontré mensajes. Abre Telegram, busca @${me.result.username}, pulsa START y vuelve a correr este comando.`);
    process.exit(1);
}
const chatId = String(msg.message.chat.id);
let env = fs.readFileSync('.env', 'utf8')
    .split('\n').filter(l => !l.startsWith('TELEGRAM_BOT_TOKEN=') && !l.startsWith('TELEGRAM_CHAT_ID=')).join('\n').trimEnd();
env += `\n\nTELEGRAM_BOT_TOKEN=${token}\nTELEGRAM_CHAT_ID=${chatId}\n`;
fs.writeFileSync('.env', env);
await fetch(api('sendMessage'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: '✅ Notificaciones del bot de Binance configuradas.' }),
});
console.log(`✅ Listo. Chat ID ${chatId} guardado en .env y mensaje de prueba enviado.`);
