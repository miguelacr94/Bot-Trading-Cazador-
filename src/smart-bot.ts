import { Spot } from '@binance/connector';
import * as dotenv from 'dotenv';
import { TelegramNotifier } from './notifier.js';
import { scanMarketOpportunities } from './scanner.js';

dotenv.config();

export class SmartSpotBot {
  private client: any;
  private notifier: TelegramNotifier;
  private symbol = process.env.BOT_SYMBOL || 'SOLUSDT';

  constructor() {
    this.client = new Spot(process.env.BINANCE_API_KEY, process.env.BINANCE_API_SECRET, { recvWindow: 60000 });
    this.notifier = new TelegramNotifier();
  }

  async monitorLoop() {
    try {
      const p = await this.client.tickerPrice(this.symbol);
      const curPrice = parseFloat(p.data.price);
      
      const acc = await this.client.account({ recvWindow: 60000 });
      const usdt = acc.data.balances.find((b: any) => b.asset === 'USDT');
      const usdtFree = usdt ? parseFloat(usdt.free).toFixed(2) : '0.00';
      const sol = acc.data.balances.find((b: any) => b.asset === 'SOL');
      const solFree = sol ? parseFloat(sol.free).toFixed(4) : '0.0000';
      const solLocked = sol ? parseFloat(sol.locked).toFixed(4) : '0.0000';

      const openOrders = await this.client.openOrders({ symbol: this.symbol, recvWindow: 60000 });
      const time = new Date().toLocaleTimeString();

      if (openOrders.data.length === 0) {
        console.log(`[${time}] ${this.symbol} $${curPrice.toFixed(3)} | USDT libre: $${usdtFree} | SOL libre: ${solFree}`);
      } else {
        const targets = openOrders.data.map((o: any) => {
          const target = parseFloat(o.price);
          const diffPct = (((target - curPrice) / curPrice) * 100);
          return `Target: $${target.toFixed(2)} (Falta +${diffPct.toFixed(2)}%)`;
        }).join(' | ');

        console.log(`[${time}] ${this.symbol} $${curPrice.toFixed(3)} | USDT libre: $${usdtFree} | SOL en venta: ${solLocked} | [ ${targets} ]`);
      }
    } catch (e: any) {
      console.error('Error en monitorLoop:', e.message);
    }
  }

  async start() {
    console.log(`\n======================================================`);
    console.log(`🤖 MONITOR EN VIVO SPOT BINANCE`);
    console.log(`📈 Par: ${this.symbol} | Refresco cada 5 segundos`);
    console.log(`======================================================\n`);

    await this.monitorLoop();
    setInterval(() => this.monitorLoop(), 5000);
    setInterval(() => scanMarketOpportunities(), 15 * 60 * 1000);
  }
}

const bot = new SmartSpotBot();
bot.start();
