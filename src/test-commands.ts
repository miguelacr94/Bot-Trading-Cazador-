process.env.BOT_NO_AUTOSTART = "1";
const { TrailingMasterBot } = await import("./multi-engine-bot.js");
const bot: any = new TrailingMasterBot();
for (const c of ["/menu", "/informe", "/cazando", "/reporte", "/estado", "/radar", "/balance", "/motores", "/modo", "/comprar", "/vender", "/xyz"]) {
  const r = await bot.handleTelegramCommand(c);
  console.log(`\n===== ${c} =====\n` + r.replace(/<[^>]*>/g, ""));
}
process.exit(0);
