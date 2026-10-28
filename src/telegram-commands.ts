import fs from "fs";
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
      // Registrar menú completo de comandos en Telegram
      const commands = [
        // Menú y Diagnóstico
        { command: "menu", description: "📋 Centro de comandos completo" },
        { command: "informe", description: "📑 Diagnóstico en tiempo real y PnL" },
        { command: "balance", description: "💼 Consultar saldos en Binance Spot" },
        { command: "liquidez", description: "💧 Consultar saldo libre y meta de 50 USDT" },
        { command: "reporte", description: "📈 Ganancias reales acumuladas netas" },
        { command: "cierre", description: "🏁 Cierre de jornada diario consolidado" },
        { command: "balance_diario", description: "📅 Balance diario de todas las estrategias" },

        // Futuros USD-M
        { command: "futuros", description: "🧪 Estado del motor de Futuros" },
        { command: "futuros_real", description: "🚀 Activar Futuros en Modo Real" },
        { command: "futuros_sim", description: "🛡️ Activar Futuros en Simulación" },
        { command: "viabilidad_futuros", description: "🎯 Diagnóstico de viabilidad en vivo" },
        { command: "reporte_futuros", description: "📊 Informe cuantitativo de Futuros" },
        { command: "toggle_futuros", description: "⚡ Activar / Pausar motor de Futuros" },

        // Estrategias y Operación
        { command: "estrategias", description: "⚙️ Panel y switches de estrategias" },
        { command: "alpha", description: "🤖 Centinela Alpha (Recuperación autónoma)" },
        { command: "lotes", description: "📦 Registro de Lotes 100% aislados" },
        { command: "trailing", description: "🏹 Posiciones vivas con Trailing Take Profit" },
        { command: "cazando", description: "🔻 Monedas cazando piso (Trailing Buy)" },
        { command: "radar", description: "📡 Escáner de suelos y RSI en vivo" },
        { command: "memes", description: "🐕 Canasta y radar de Memecoins" },
        { command: "callback", description: "🎯 Ver y ajustar callback de salida (ej: /callback PEPE 0.45)" },
        { command: "presupuesto", description: "💼 Presupuesto auto-graduado y saldos" },
        { command: "asignar", description: "🎯 Configurar % (ej: /asignar 40 25 0 35)" },
        { command: "regimen", description: "🧭 Diagnóstico volatilidad y Día Quieto" },
        { command: "weekend", description: "🏖️ Diagnóstico Cazador Weekend" },
        { command: "estado", description: "📊 Órdenes vivas y precios en Binance" },
        { command: "motores", description: "⚙️ Parámetros técnicos de los motores" },

        // Switches y Parámetros
        { command: "toggle_trailing", description: "🏹 Activar / Pausar Cazador Trailing" },
        { command: "toggle_dca", description: "🛡️ Activar / Pausar Smart DCA" },
        { command: "toggle_grid", description: "🌐 Activar / Pausar Micro-Grid" },
        { command: "toggle_weekend", description: "🏖️ Activar / Pausar Cazador Weekend" },
        { command: "toggle_ia", description: "🤖 Activar / Silenciar Gemini Copilot" },
        { command: "stoploss", description: "🛡️ Ver estado y límite de Stop-Loss" },
        { command: "toggle_stoploss", description: "🛡️ Activar / Desactivar Stop-Loss" },
        { command: "set_stoploss", description: "🛡️ Fijar % Stop-Loss (ej: /set_stoploss 4.0)" },
        { command: "timeframe", description: "⏱️ Ver o cambiar temporalidad (15m, 1h, 4h)" },
        { command: "sugerencias", description: "🧠 Sugerencias Centinela (aplicar/rechazar)" },
        { command: "rechazar", description: "❌ Descartar sugerencia activa" },

        // Aprobaciones y Control
        { command: "aprobar", description: "✅ Aprobar oportunidad recomendada" },
        { command: "ignorar", description: "❌ Descartar oportunidad de compra" },
        { command: "aprobar_grid", description: "🌐 Activar Micro-Grid en Día Quieto" },
        { command: "ignorar_grid", description: "❌ Descartar activación Micro-Grid" },
        { command: "modo", description: "🤖 Ver o cambiar modo (/modo auto | manual)" },
        { command: "pausa", description: "⏸️ Pausar compras automáticas" },
        { command: "reanudar", description: "▶️ Reanudar compras automáticas" },
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
      if (old.result?.length) this.offset = old.result[0].update_id + 1;
      this.loop();
    } catch (e: any) {
      console.error("Error iniciando TelegramCommands:", e.message);
    }
  }

  private async sendMessageChunk(text: string): Promise<void> {
    if (!text || !text.trim()) return;
    try {
      const res = await fetch(this.api("sendMessage"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: this.chatId, text, parse_mode: "HTML" }),
      });
      const data = await res.json();
      if (!data.ok) {
        // Si falló el parseo HTML, reenviar texto plano
        const plain = text.replace(/<[^>]*>/g, "");
        await fetch(this.api("sendMessage"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: this.chatId, text: plain }),
        });
      }
    } catch (err: any) {
      console.error("Error enviando mensaje a Telegram:", err.message);
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

          // Limpiar mención al bot SOLO en el comando inicial (ej: "/comprar@MiBot eth" -> "/comprar eth")
          const rawText = msg.text.trim();
          const cleanedText = rawText.replace(/^(\/[a-zA-Z0-9_]+)@[a-zA-Z0-9_]+/i, "$1");
          console.log(`📱 Telegram comando recibido: ${cleanedText}`);

          let reply = "";
          try {
            const logLine = `[${new Date().toISOString()}] RECV: "${cleanedText}"\n`;
          try { fs.appendFileSync('.telegram-debug.log', logLine); } catch {}
          reply = await this.handler(cleanedText);
          try { fs.appendFileSync('.telegram-debug.log', `[${new Date().toISOString()}] REPLY: "${reply.slice(0, 100)}"\n`); } catch {}
          } catch (handlerErr: any) {
            console.error("Error en handler de Telegram:", handlerErr.message);
            reply = `⚠️ Error procesando comando: ${handlerErr.message}`;
          }

          if (!reply || !reply.trim()) {
            reply = "👍 Orden procesada.";
          }

          // Dividir mensajes si exceden el límite de 4000 caracteres de Telegram
          if (reply.length > 4000) {
            const chunks = [];
            let rem = reply;
            while (rem.length > 0) {
              chunks.push(rem.slice(0, 4000));
              rem = rem.slice(4000);
            }
            for (const chunk of chunks) {
              await this.sendMessageChunk(chunk);
            }
          } else {
            await this.sendMessageChunk(reply);
          }
        }
      } catch (loopErr: any) {
        console.error("Error en loop de TelegramCommands:", loopErr.message);
        await new Promise((r) => setTimeout(r, 4000));
      }
    }
  }
}
