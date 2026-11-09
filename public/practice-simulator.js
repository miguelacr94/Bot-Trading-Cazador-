/**
 * 🎯 ACADEMIA & LABORATORIO DE VELAS EN TIEMPO REAL
 * Simulador interactivo con WebSockets oficiales de Binance,
 * herramientas de dibujo de Pisos/Techos, detector de mechas y
 * evaluador pedagógico instantáneo de decisiones de trading.
 */

(function () {
  class PracticeSimulator {
    constructor() {
      this.symbol = "SOLUSDT";
      this.interval = "1m";
      this.ws = null;
      this.chart = null;
      this.candleSeries = null;
      this.volumeSeries = null;

      // Líneas de dibujo y plan
      this.pisoPrice = null;
      this.techoPrice = null;
      this.buyTargetPrice = null;
      this.sellTargetPrice = null;
      this.slTargetPrice = null;
      this.buyLine = null;
      this.sellLine = null;
      this.slLine = null;

      this.currentPrice = 0;
      this.currentCandle = null;
      this.klines = [];
      this.markers = [];
      this.balance = 1000.0;
      this.fees = 0.0;
      this.realizedPnl = 0.0;
      this.activePosition = null;
      this.history = [];
      this.stats = { totalTrades: 0, wins: 0, losses: 0, winRate: 0, averageScore: 0 };
      this.initialized = false;
      this.reconnectTimer = null;
    }

    async init() {
      if (this.initialized) return;
      this.initialized = true;

      await this.loadStateFromBackend();
      this.initChart();
      await this.fetchKlinesAndConnect();
      this.updateUI();
    }

    onTabActivated() {
      if (!this.initialized) {
        this.init();
      } else {
        setTimeout(() => {
          if (this.chart) {
            const container = document.getElementById("practice-chart-container");
            if (container) {
              this.chart.applyOptions({
                width: container.clientWidth,
                height: 480
              });
              this.chart.timeScale().fitContent();
            }
          }
        }, 150);
      }
    }

    async loadStateFromBackend() {
      try {
        const res = await fetch("/api/practice/state");
        if (res.ok) {
          const data = await res.json();
          this.balance = data.balance ?? 1000.0;
          this.fees = data.fees ?? 0.0;
          this.realizedPnl = data.realizedPnl ?? 0.0;
          this.history = data.history ?? [];
          this.stats = data.stats ?? this.stats;
          if (data.positions && data.positions.length > 0) {
            this.activePosition = data.positions[0];
          }
          if (data.drawnLines && data.drawnLines[this.symbol]) {
            this.pisoPrice = data.drawnLines[this.symbol].piso ?? null;
            this.techoPrice = data.drawnLines[this.symbol].techo ?? null;
          }
        }
      } catch (e) {
        console.warn("No se pudo cargar estado previo del simulador:", e);
      }
    }

    initChart() {
      const container = document.getElementById("practice-chart-container");
      if (!container || !window.LightweightCharts) {
        console.warn("Contenedor o LightweightCharts no disponible.");
        return;
      }

      container.innerHTML = "";

      this.chart = window.LightweightCharts.createChart(container, {
        width: container.clientWidth || 800,
        height: 480,
        layout: {
          background: { type: "solid", color: "#0d111a" },
          textColor: "#94a3b8",
          fontSize: 12,
          fontFamily: "'JetBrains Mono', monospace"
        },
        grid: {
          vertLines: { color: "rgba(255, 255, 255, 0.04)" },
          horzLines: { color: "rgba(255, 255, 255, 0.04)" }
        },
        crosshair: {
          mode: window.LightweightCharts.CrosshairMode.Normal,
          vertLine: { color: "rgba(56, 189, 248, 0.4)", width: 1, style: 3 },
          horzLine: { color: "rgba(56, 189, 248, 0.4)", width: 1, style: 3 }
        },
        rightPriceScale: {
          borderColor: "rgba(255, 255, 255, 0.1)",
          scaleMargins: { top: 0.12, bottom: 0.2 }
        },
        timeScale: {
          borderColor: "rgba(255, 255, 255, 0.1)",
          timeVisible: true,
          secondsVisible: false
        }
      });

      this.candleSeries = this.chart.addCandlestickSeries({
        upColor: "#10b981",
        downColor: "#ef4444",
        borderVisible: false,
        wickUpColor: "#10b981",
        wickDownColor: "#ef4444"
      });

      this.volumeSeries = this.chart.addHistogramSeries({
        color: "rgba(56, 189, 248, 0.25)",
        priceFormat: { type: "volume" },
        priceScaleId: "",
        scaleMargins: { top: 0.82, bottom: 0 }
      });

      window.addEventListener("resize", () => {
        if (this.chart && container) {
          this.chart.applyOptions({ width: container.clientWidth });
        }
      });
    }

    // ---------- CÁLCULO Y TRAZADO DEL PLAN DE ACCIÓN EXACTO ----------
    updateActionPlanAndLines() {
      if (!this.candleSeries) return;

      // Limpiar líneas previas
      if (this.buyLine) {
        try { this.candleSeries.removePriceLine(this.buyLine); } catch (e) {}
        this.buyLine = null;
      }
      if (this.sellLine) {
        try { this.candleSeries.removePriceLine(this.sellLine); } catch (e) {}
        this.sellLine = null;
      }
      if (this.slLine) {
        try { this.candleSeries.removePriceLine(this.slLine); } catch (e) {}
        this.slLine = null;
      }

      if (this.klines && this.klines.length > 0) {
        const recent = this.klines.slice(-40);
        let minLow = Infinity;
        let maxHigh = -Infinity;
        recent.forEach(c => {
          if (c.low < minLow) minLow = c.low;
          if (c.high > maxHigh) maxHigh = c.high;
        });

        const buyPrice = typeof this.pisoPrice === "number" && !isNaN(this.pisoPrice)
          ? this.pisoPrice
          : parseFloat(minLow.toFixed(2));
        this.buyTargetPrice = buyPrice;

        const sellPrice = typeof this.techoPrice === "number" && !isNaN(this.techoPrice)
          ? this.techoPrice
          : parseFloat(maxHigh.toFixed(2));
        this.sellTargetPrice = sellPrice;

        // Stop loss: 1.2% por debajo del piso
        const slPrice = parseFloat((buyPrice - (buyPrice * 0.012)).toFixed(2));
        this.slTargetPrice = slPrice;

        // Actualizar tarjetas de texto del plan
        const elBuy = document.getElementById("prac-plan-buy-price");
        const elSell = document.getElementById("prac-plan-sell-price");
        const elSl = document.getElementById("prac-plan-sl-price");
        const elRr = document.getElementById("prac-plan-rr");

        if (elBuy) elBuy.textContent = `$${buyPrice.toFixed(2)}`;
        if (elSell) elSell.textContent = `$${sellPrice.toFixed(2)}`;
        if (elSl) elSl.textContent = `$${slPrice.toFixed(2)}`;

        const risk = buyPrice - slPrice;
        const reward = sellPrice - buyPrice;
        if (elRr && risk > 0 && reward > 0) {
          const ratio = (reward / risk).toFixed(1);
          elRr.textContent = `1 : ${ratio}`;
        }

        // Trazar las 3 líneas visibles en la gráfica
        this.buyLine = this.candleSeries.createPriceLine({
          price: buyPrice,
          color: "#10b981",
          lineWidth: 2,
          lineStyle: window.LightweightCharts.LineStyle.Solid,
          axisLabelVisible: true,
          title: `🟢 COMPRAR AQUÍ ($${buyPrice.toFixed(2)})`
        });

        this.sellLine = this.candleSeries.createPriceLine({
          price: sellPrice,
          color: "#ef4444",
          lineWidth: 2,
          lineStyle: window.LightweightCharts.LineStyle.Solid,
          axisLabelVisible: true,
          title: `🔴 VENDER AQUÍ ($${sellPrice.toFixed(2)})`
        });

        this.slLine = this.candleSeries.createPriceLine({
          price: slPrice,
          color: "#f43f5e",
          lineWidth: 2,
          lineStyle: window.LightweightCharts.LineStyle.Dashed,
          axisLabelVisible: true,
          title: `🛑 STOP LOSS ($${slPrice.toFixed(2)})`
        });

        // Sincronizar inputs
        const inpPiso = document.getElementById("prac-input-piso");
        const inpTecho = document.getElementById("prac-input-techo");
        if (inpPiso && (!inpPiso.value || inpPiso.value === "")) inpPiso.value = buyPrice.toFixed(2);
        if (inpTecho && (!inpTecho.value || inpTecho.value === "")) inpTecho.value = sellPrice.toFixed(2);
      }
    }

    async fetchKlinesAndConnect() {
      try {
        const res = await fetch(`/api/practice/klines?symbol=${this.symbol}&interval=${this.interval}&limit=120`);
        if (res.ok) {
          const raw = await res.json();
          if (Array.isArray(raw)) {
            const candles = [];
            const volumes = [];
            raw.forEach(k => {
              const time = Math.floor(k[0] / 1000);
              const open = parseFloat(k[1]);
              const high = parseFloat(k[2]);
              const low = parseFloat(k[3]);
              const close = parseFloat(k[4]);
              const volume = parseFloat(k[5]);
              candles.push({ time, open, high, low, close });
              volumes.push({
                time,
                value: volume,
                color: close >= open ? "rgba(16, 185, 129, 0.3)" : "rgba(239, 68, 68, 0.3)"
              });
            });

            this.klines = candles;
            this.candleSeries.setData(candles);
            this.volumeSeries.setData(volumes);
            this.chart.timeScale().fitContent();

            if (candles.length > 0) {
              const last = candles[candles.length - 1];
              this.currentCandle = { ...last };
              this.currentPrice = last.close;
              this.updatePriceDisplay();
              this.updateActionPlanAndLines();
              this.updateLiveDiagnostic();
              this.updateSemaforo();
            }
          }
        }
      } catch (e) {
        console.error("Error cargando klines iniciales:", e);
      }

      this.connectWebSocket();
    }

    connectWebSocket() {
      if (this.ws) {
        try { this.ws.close(); } catch (e) {}
        this.ws = null;
      }

      const streamName = `${this.symbol.toLowerCase()}@kline_${this.interval}`;
      const wsUrl = `wss://stream.binance.com:9443/ws/${streamName}`;

      const statusEl = document.getElementById("prac-ws-status");
      if (statusEl) {
        statusEl.innerHTML = `<span style="display:inline-block; width:8px; height:8px; background:#f59e0b; border-radius:50%;"></span> Conectando Binance...`;
        statusEl.style.color = "#f59e0b";
      }

      try {
        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => {
          if (statusEl) {
            statusEl.innerHTML = `<span style="display:inline-block; width:8px; height:8px; background:#10b981; border-radius:50%; box-shadow:0 0 8px #10b981;"></span> Conectado Binance WS`;
            statusEl.style.color = "#34d399";
          }
        };

        this.ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data);
            if (msg.k) {
              const k = msg.k;
              const candle = {
                time: Math.floor(k.t / 1000),
                open: parseFloat(k.o),
                high: parseFloat(k.h),
                low: parseFloat(k.l),
                close: parseFloat(k.c)
              };
              const vol = {
                time: candle.time,
                value: parseFloat(k.v),
                color: candle.close >= candle.open ? "rgba(16, 185, 129, 0.4)" : "rgba(239, 68, 68, 0.4)"
              };

              this.currentCandle = candle;
              this.currentPrice = candle.close;
              this.candleSeries.update(candle);
              this.volumeSeries.update(vol);

              this.updatePriceDisplay();
              this.updateLiveDiagnostic();
              this.updateSemaforo();
              this.updateFloatingPosition();
            }
          } catch (err) {}
        };

        this.ws.onerror = () => {
          if (statusEl) {
            statusEl.innerHTML = `<span style="display:inline-block; width:8px; height:8px; background:#ef4444; border-radius:50%;"></span> Reconectando...`;
            statusEl.style.color = "#ef4444";
          }
        };

        this.ws.onclose = () => {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = setTimeout(() => {
            if (document.getElementById("tab-practice")?.classList.contains("active")) {
              this.connectWebSocket();
            }
          }, 3000);
        };
      } catch (e) {
        console.error("Error abriendo websocket:", e);
      }
    }

    changeSymbol(newSymbol) {
      this.symbol = newSymbol;
      this.pisoPrice = null;
      this.techoPrice = null;
      const ip = document.getElementById("prac-input-piso");
      const it = document.getElementById("prac-input-techo");
      if (ip) ip.value = "";
      if (it) it.value = "";
      this.fetchKlinesAndConnect();
    }

    changeTimeframe(newTf) {
      this.interval = newTf;
      document.querySelectorAll(".prac-tf-btn").forEach(btn => {
        if (btn.getAttribute("data-tf") === newTf) {
          btn.classList.add("active");
          btn.style.background = "rgba(16,185,129,0.25)";
          btn.style.borderColor = "#10b981";
          btn.style.color = "#34d399";
        } else {
          btn.classList.remove("active");
          btn.style.background = "transparent";
          btn.style.borderColor = "transparent";
          btn.style.color = "#94a3b8";
        }
      });
      this.fetchKlinesAndConnect();
    }

    tracePisoAtCurrent() {
      if (!this.currentPrice) return;
      this.pisoPrice = parseFloat(this.currentPrice.toFixed(2));
      const ip = document.getElementById("prac-input-piso");
      if (ip) ip.value = this.pisoPrice.toFixed(2);
      this.updateActionPlanAndLines();
      this.saveLinesToBackend();
      this.updateLiveDiagnostic();
      this.updateSemaforo();
    }

    traceTechoAtCurrent() {
      if (!this.currentPrice) return;
      this.techoPrice = parseFloat(this.currentPrice.toFixed(2));
      const it = document.getElementById("prac-input-techo");
      if (it) it.value = this.techoPrice.toFixed(2);
      this.updateActionPlanAndLines();
      this.saveLinesToBackend();
      this.updateLiveDiagnostic();
      this.updateSemaforo();
    }

    autoDetectPisoTecho() {
      if (!this.klines || this.klines.length === 0) return;
      const recent = this.klines.slice(-40);
      let minLow = Infinity;
      let maxHigh = -Infinity;
      recent.forEach(c => {
        if (c.low < minLow) minLow = c.low;
        if (c.high > maxHigh) maxHigh = c.high;
      });

      this.pisoPrice = parseFloat(minLow.toFixed(2));
      this.techoPrice = parseFloat(maxHigh.toFixed(2));
      const ip = document.getElementById("prac-input-piso");
      const it = document.getElementById("prac-input-techo");
      if (ip) ip.value = this.pisoPrice.toFixed(2);
      if (it) it.value = this.techoPrice.toFixed(2);

      this.updateActionPlanAndLines();
      this.saveLinesToBackend();
      this.updateLiveDiagnostic();
      this.updateSemaforo();
    }

    clearLines() {
      this.pisoPrice = null;
      this.techoPrice = null;
      const ip = document.getElementById("prac-input-piso");
      const it = document.getElementById("prac-input-techo");
      if (ip) ip.value = "";
      if (it) it.value = "";
      this.updateActionPlanAndLines();
      this.saveLinesToBackend();
      this.updateLiveDiagnostic();
      this.updateSemaforo();
    }

    setManualLine(type, val) {
      const num = parseFloat(val);
      if (!isNaN(num) && num > 0) {
        if (type === "piso") this.pisoPrice = num;
        if (type === "techo") this.techoPrice = num;
      } else {
        if (type === "piso") this.pisoPrice = null;
        if (type === "techo") this.techoPrice = null;
      }
      this.updateActionPlanAndLines();
      this.saveLinesToBackend();
      this.updateLiveDiagnostic();
      this.updateSemaforo();
    }

    async saveLinesToBackend() {
      try {
        await fetch("/api/practice/lines", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            symbol: this.symbol,
            piso: this.pisoPrice,
            techo: this.techoPrice
          })
        });
      } catch (e) {}
    }

    updatePriceDisplay() {
      const el = document.getElementById("prac-live-price");
      if (el) el.textContent = `$${this.currentPrice.toFixed(2)}`;
    }

    // ---------- SEMÁFORO EN TIEMPO REAL: ¿QUÉ HAGO AHORA? ----------
    updateSemaforo() {
      if (!this.currentPrice || !this.buyTargetPrice || !this.sellTargetPrice) return;

      const p = this.currentPrice;
      const buyT = this.buyTargetPrice;
      const sellT = this.sellTargetPrice;
      const slT = this.slTargetPrice || (buyT * 0.988);

      const badge = document.getElementById("prac-semaforo-badge");
      const title = document.getElementById("prac-semaforo-title");
      const instr = document.getElementById("prac-semaforo-instruction");
      const btnBuy = document.getElementById("btn-prac-buy");
      const btnSell = document.getElementById("btn-prac-sell");

      if (!badge || !title || !instr) return;

      // Margen de tolerancia para zona de compra: hasta 0.8% por encima del piso
      const inBuyZone = p <= (buyT * 1.008) && p >= slT;
      // Margen de tolerancia para zona de venta: hasta 0.8% por debajo del techo
      const inSellZone = p >= (sellT * 0.992);
      const isBrokenSL = p < slT;

      if (inBuyZone) {
        badge.innerHTML = `<span>🟢</span> ¡GATILLO ACTIVO! COMPRA AHORA`;
        badge.style.background = "rgba(16, 185, 129, 0.25)";
        badge.style.borderColor = "#10b981";
        badge.style.color = "#34d399";

        title.textContent = `¡El precio ($${p.toFixed(2)}) está en el PUNTO DE COMPRA!`;
        title.style.color = "#34d399";
        instr.textContent = `Estás en la Zona del Piso ($${buyT.toFixed(2)}). La probabilidad matemática de rebote es máxima. ¡Pulsa el botón verde COMPRAR (LONG) abajo!`;

        if (btnBuy) btnBuy.classList.add("pulse-green-btn");
        if (btnSell) btnSell.classList.remove("pulse-red-btn");
      } else if (inSellZone) {
        badge.innerHTML = `<span>🔴</span> ¡GATILLO ACTIVO! VENDE AHORA`;
        badge.style.background = "rgba(239, 68, 68, 0.25)";
        badge.style.borderColor = "#ef4444";
        badge.style.color = "#f87171";

        title.textContent = `¡El precio ($${p.toFixed(2)}) llegó al PUNTO DE VENTA!`;
        title.style.color = "#f87171";
        instr.textContent = `Estás en la Zona del Techo ($${sellT.toFixed(2)}). Es momento de asegurar ganancias o abrir VENTA (SHORT).`;

        if (btnSell) btnSell.classList.add("pulse-red-btn");
        if (btnBuy) btnBuy.classList.remove("pulse-green-btn");
      } else if (isBrokenSL) {
        badge.innerHTML = `<span>🛑</span> ALERTA: STOP LOSS PERFORADO`;
        badge.style.background = "rgba(244, 63, 94, 0.25)";
        badge.style.borderColor = "#f43f5e";
        badge.style.color = "#fb7185";

        title.textContent = `El precio cayó por debajo del Stop Loss ($${slT.toFixed(2)}).`;
        title.style.color = "#fb7185";
        instr.textContent = `Peligro de caída libre. NO compres contra esta caída; espera a que se forme un nuevo piso con mecha abajo.`;

        if (btnBuy) btnBuy.classList.remove("pulse-green-btn");
        if (btnSell) btnSell.classList.remove("pulse-red-btn");
      } else {
        badge.innerHTML = `<span>⏳</span> ACCIÓN ACTUAL: ESPERAR`;
        badge.style.background = "rgba(245, 158, 11, 0.2)";
        badge.style.borderColor = "#f59e0b";
        badge.style.color = "#fbbf24";

        title.textContent = `El precio está a mitad de camino ($${p.toFixed(2)}).`;
        title.style.color = "#f1f5f9";
        instr.textContent = `NO compres ni vendas aquí. Espera que caiga a $${buyT.toFixed(2)} para comprar o que suba a $${sellT.toFixed(2)} para vender.`;

        if (btnBuy) btnBuy.classList.remove("pulse-green-btn");
        if (btnSell) btnSell.classList.remove("pulse-red-btn");
      }
    }

    // ---------- RADAR EN VIVO & EVALUADOR DE MECHAS ----------
    updateLiveDiagnostic() {
      if (!this.currentCandle) return;

      const c = this.currentCandle;
      const range = c.high - c.low || 0.0001;
      const body = Math.abs(c.close - c.open);
      const upperWick = c.high - Math.max(c.open, c.close);
      const lowerWick = Math.min(c.open, c.close) - c.low;

      const upperWickPct = (upperWick / range) * 100;
      const lowerWickPct = (lowerWick / range) * 100;
      const bodyPct = (body / range) * 100;
      const isGreen = c.close >= c.open;

      const elWickTop = document.getElementById("prac-wick-top");
      const elBody = document.getElementById("prac-candle-body");
      const elWickBottom = document.getElementById("prac-wick-bottom");
      const elDistPiso = document.getElementById("prac-dist-piso");
      const elDistTecho = document.getElementById("prac-dist-techo");

      if (elWickTop) elWickTop.textContent = `${upperWickPct.toFixed(1)}%`;
      if (elBody) {
        elBody.textContent = `${bodyPct.toFixed(1)}% (${isGreen ? "🟢 Verde" : "🔴 Roja"})`;
        elBody.style.color = isGreen ? "#34d399" : "#f87171";
      }
      if (elWickBottom) elWickBottom.textContent = `${lowerWickPct.toFixed(1)}%`;

      let distPiso = null;
      let distTecho = null;

      const refBuy = this.buyTargetPrice;
      const refSell = this.sellTargetPrice;

      if (refBuy) {
        distPiso = ((this.currentPrice - refBuy) / refBuy) * 100;
        if (elDistPiso) {
          elDistPiso.textContent = `${distPiso >= 0 ? "+" : ""}${distPiso.toFixed(2)}%`;
          elDistPiso.style.color = Math.abs(distPiso) < 0.8 ? "#34d399" : "#38bdf8";
        }
      }

      if (refSell) {
        distTecho = ((this.currentPrice - refSell) / refSell) * 100;
        if (elDistTecho) {
          elDistTecho.textContent = `${distTecho >= 0 ? "+" : ""}${distTecho.toFixed(2)}%`;
          elDistTecho.style.color = Math.abs(distTecho) < 0.8 ? "#ef4444" : "#fbbf24";
        }
      }

      // Alerta dinámica
      const alertBox = document.getElementById("prac-pattern-alert");
      const alertIcon = document.getElementById("prac-pattern-icon");
      const alertTitle = document.getElementById("prac-pattern-title");
      const alertDesc = document.getElementById("prac-pattern-desc");

      if (!alertBox || !alertTitle || !alertDesc) return;

      if (lowerWickPct >= 42) {
        if (distPiso !== null && Math.abs(distPiso) < 1.0) {
          alertBox.style.background = "rgba(16, 185, 129, 0.18)";
          alertBox.style.borderColor = "#10b981";
          alertIcon.textContent = "🟢";
          alertTitle.textContent = `¡MARTILLO DE ORO EN PISO DETECTADO! (${lowerWickPct.toFixed(0)}% Mecha Abajo)`;
          alertTitle.style.color = "#34d399";
          alertDesc.textContent = `Los compradores defendieron el Punto de Compra de $${refBuy.toFixed(2)}. ALTA PROBABILIDAD DE SUBIDA. Excelente momento para COMPRAR (LONG).`;
        } else {
          alertBox.style.background = "rgba(16, 185, 129, 0.1)";
          alertBox.style.borderColor = "rgba(16, 185, 129, 0.3)";
          alertIcon.textContent = "🟢";
          alertTitle.textContent = `Fuerza Compradora: Rechazo Inferior (${lowerWickPct.toFixed(0)}% mecha)`;
          alertTitle.style.color = "#34d399";
          alertDesc.textContent = `La vela cayó pero los compradores la rescataron antes del cierre. Favorable para compra si estás cerca de un soporte.`;
        }
      } else if (upperWickPct >= 42) {
        if (distTecho !== null && Math.abs(distTecho) < 1.0) {
          alertBox.style.background = "rgba(239, 68, 68, 0.18)";
          alertBox.style.borderColor = "#ef4444";
          alertIcon.textContent = "🔴";
          alertTitle.textContent = `¡RECHAZO BRUTAL EN TECHO DETECTADO! (${upperWickPct.toFixed(0)}% Mecha Arriba)`;
          alertTitle.style.color = "#f87171";
          alertDesc.textContent = `Los vendedores expulsaron el precio del Punto de Venta de $${refSell.toFixed(2)}. ALTA PROBABILIDAD DE CAÍDA. Momento para VENDER / SHORT.`;
        } else {
          alertBox.style.background = "rgba(239, 68, 68, 0.1)";
          alertBox.style.borderColor = "rgba(239, 68, 68, 0.3)";
          alertIcon.textContent = "🔴";
          alertTitle.textContent = `Presión Vendedora: Rechazo Superior (${upperWickPct.toFixed(0)}% mecha)`;
          alertTitle.style.color = "#f87171";
          alertDesc.textContent = `Los compradores intentaron subir pero los vendedores estamparon el precio hacia abajo. Cuidado con comprar aquí.`;
        }
      } else if (bodyPct <= 22) {
        alertBox.style.background = "rgba(245, 158, 11, 0.1)";
        alertBox.style.borderColor = "rgba(245, 158, 11, 0.3)";
        alertIcon.textContent = "🟡";
        alertTitle.textContent = `Vela de Compresión / Agotamiento (${bodyPct.toFixed(0)}% cuerpo)`;
        alertTitle.style.color = "#fbbf24";
        alertDesc.textContent = `Cuerpo diminuto: los vendedores ya no tienen fuerza para tirar el precio. Si estás en piso, anticipa rebote.`;
      } else if (!isGreen && bodyPct >= 70) {
        alertBox.style.background = "rgba(239, 68, 68, 0.1)";
        alertBox.style.borderColor = "rgba(239, 68, 68, 0.3)";
        alertIcon.textContent = "⚠️";
        alertTitle.textContent = `Vela Roja Sólida en Caída (${bodyPct.toFixed(0)}% Cuerpo)`;
        alertTitle.style.color = "#f87171";
        alertDesc.textContent = `Fuerza bajista agresiva en desarrollo. NO compres contra esta vela; espera una mecha de rechazo abajo.`;
      } else {
        alertBox.style.background = "rgba(255, 255, 255, 0.03)";
        alertBox.style.borderColor = "rgba(255, 255, 255, 0.08)";
        alertIcon.textContent = "⚖️";
        alertTitle.textContent = `Vela en Formación (Zona Neutra)`;
        alertTitle.style.color = "#cbd5e1";
        alertDesc.textContent = `El precio oscila sin rechazo extremo. Es mejor esperar a que llegue a un Punto de Compra o Venta.`;
      }
    }

    // ---------- ALGORITMO DE EVALUACIÓN PEDAGÓGICA (EL PROFESOR) ----------
    evaluateDecision(side) {
      if (!this.currentCandle) return null;

      const c = this.currentCandle;
      const range = c.high - c.low || 0.0001;
      const body = Math.abs(c.close - c.open);
      const upperWick = c.high - Math.max(c.open, c.close);
      const lowerWick = Math.min(c.open, c.close) - c.low;
      const upperWickPct = (upperWick / range) * 100;
      const lowerWickPct = (lowerWick / range) * 100;
      const bodyPct = (body / range) * 100;
      const isGreen = c.close >= c.open;

      let score = 5.0;
      const pros = [];
      const cons = [];

      const refBuy = this.buyTargetPrice;
      const refSell = this.sellTargetPrice;

      let distPiso = refBuy ? ((this.currentPrice - refBuy) / refBuy) * 100 : null;
      let distTecho = refSell ? ((this.currentPrice - refSell) / refSell) * 100 : null;

      if (side === "BUY") {
        if (distPiso !== null) {
          if (distPiso >= -0.6 && distPiso <= 1.0) {
            score += 2.5;
            pros.push(`🎯 Ubicación perfecta: Compraste pegado a tu Punto de Compra ($${refBuy.toFixed(2)}).`);
          } else if (distPiso > 1.0 && distPiso <= 2.2) {
            score += 1.0;
            pros.push(`Ubicación aceptable: A ${distPiso.toFixed(1)}% de tu piso de soporte.`);
          } else if (distPiso > 2.2) {
            score -= 1.5;
            cons.push(`⚠️ Entrada lejana: Estás persiguiendo el precio a +${distPiso.toFixed(1)}% por encima de tu punto de compra.`);
          } else if (distPiso < -1.5) {
            score -= 2.0;
            cons.push(`❌ Piso roto: El precio perforó el piso; cuidado con caídas continuadas.`);
          }
        }

        if (distTecho !== null && distTecho > -1.2) {
          score -= 3.0;
          cons.push(`🛑 ¡Peligro de Techo! Estás comprando a solo ${Math.abs(distTecho).toFixed(1)}% del techo ($${refSell.toFixed(2)}). El techo es para vender.`);
        }

        if (lowerWickPct >= 42) {
          score += 2.5;
          pros.push(`🟢 Mecha de rechazo abajo (${lowerWickPct.toFixed(0)}%): Los compradores absorbieron la venta.`);
        } else if (upperWickPct >= 45) {
          score -= 1.8;
          cons.push(`🔴 Mecha superior larga (${upperWickPct.toFixed(0)}%): Hubo rechazo vendedor arriba.`);
        }

        if (bodyPct <= 22) {
          score += 1.5;
          pros.push(`🟡 Agotamiento vendedor: Velas enanas muestran que la caída perdió fuerza.`);
        } else if (!isGreen && bodyPct >= 65 && lowerWickPct < 20) {
          score -= 2.5;
          cons.push(`❌ Cuchillo cayendo: Vela roja sólida sin mecha de rechazo abajo.`);
        }
      } else {
        if (distTecho !== null) {
          if (Math.abs(distTecho) <= 1.0) {
            score += 2.5;
            pros.push(`🎯 Ubicación ideal: Vendiste en el Techo ($${refSell.toFixed(2)}).`);
          } else if (distTecho < -2.2) {
            score -= 1.5;
            cons.push(`⚠️ Venta lejana al techo: Estás vendiendo a ${Math.abs(distTecho).toFixed(1)}% por debajo de la resistencia.`);
          }
        }

        if (distPiso !== null && Math.abs(distPiso) <= 1.0) {
          score -= 3.0;
          cons.push(`🛑 ¡Peligro! No vendas en pleno piso de soporte ($${refBuy.toFixed(2)}).`);
        }

        if (upperWickPct >= 42) {
          score += 2.5;
          pros.push(`🔴 Mecha de rechazo arriba (${upperWickPct.toFixed(0)}%): Los vendedores dominaron la cima.`);
        }
      }

      score = Math.max(1.0, Math.min(10.0, score));
      score = parseFloat(score.toFixed(1));

      let verdict = "";
      if (score >= 8.5) {
        verdict = `🌟 ¡OPERACIÓN MAESTRA (${score}/10)! Entendiste perfectamente la lectura de pisos, techos y mechas.`;
      } else if (score >= 7.0) {
        verdict = `✅ BUENA OPERACIÓN (${score}/10). La probabilidad matemática está a tu favor.`;
      } else if (score >= 5.0) {
        verdict = `⚠️ OPERACIÓN REGULAR (${score}/10). Entrada arriesgada o fuera de zona óptima de rechazo.`;
      } else {
        verdict = `❌ ENTRADA PELIGROSA (${score}/10). Caíste en una trampa clásica de novato (comprar en techo o en vela roja sin mecha).`;
      }

      return {
        score,
        side,
        price: this.currentPrice,
        verdict,
        pros,
        cons,
        timestamp: new Date().toLocaleTimeString()
      };
    }

    renderEvaluation(evalData) {
      const box = document.getElementById("prac-eval-box");
      if (!box || !evalData) return;

      const scoreColor = evalData.score >= 8.0 ? "#10b981" : evalData.score >= 6.0 ? "#f59e0b" : "#ef4444";
      let prosHtml = evalData.pros.map(p => `<li style="margin-bottom:4px; color:#a7f3d0;">${p}</li>`).join("");
      let consHtml = evalData.cons.map(c => `<li style="margin-bottom:4px; color:#fca5a5;">${c}</li>`).join("");

      box.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid rgba(255,255,255,0.08); padding-bottom:10px; margin-bottom:12px;">
          <div>
            <span style="font-size:11px; color:#94a3b8; text-transform:uppercase; font-weight:700;">Acción:</span>
            <b style="color:${evalData.side === "BUY" ? "#34d399" : "#f87171"}; font-size:14px; margin-left:6px;">${evalData.side === "BUY" ? "🟢 COMPRA (LONG)" : "🔴 VENTA (SHORT)"}</b>
            <span style="color:#94a3b8; font-size:12px; margin-left:8px;">a $${evalData.price.toFixed(2)}</span>
          </div>
          <div style="display:flex; align-items:center; gap:6px; background:rgba(0,0,0,0.4); border:1px solid ${scoreColor}; padding:4px 10px; border-radius:20px;">
            <span style="color:#fbbf24; font-size:14px;">⭐</span>
            <span style="font-size:16px; font-weight:800; color:${scoreColor};">${evalData.score} <span style="font-size:11px; color:#94a3b8;">/ 10</span></span>
          </div>
        </div>

        <div style="font-size:13px; font-weight:700; color:#f1f5f9; margin-bottom:10px;">${evalData.verdict}</div>

        ${evalData.pros.length > 0 ? `<ul style="margin:0 0 8px 18px; padding:0; font-size:12px;">${prosHtml}</ul>` : ""}
        ${evalData.cons.length > 0 ? `<ul style="margin:0 0 8px 18px; padding:0; font-size:12px;">${consHtml}</ul>` : ""}

        <div style="font-size:11px; color:#94a3b8; text-align:right; margin-top:8px;">
          🕒 Evaluado a las ${evalData.timestamp}
        </div>
      `;
    }

    evaluateCurrentPointOnly() {
      const evalData = this.evaluateDecision("BUY");
      if (evalData) {
        this.renderEvaluation(evalData);
      }
    }

    setOrderAmount(amt) {
      const inp = document.getElementById("prac-order-amount");
      if (inp) inp.value = amt;
    }

    setOrderAmountPercent(pct) {
      const amt = Math.max(5, Math.floor(this.balance * pct));
      this.setOrderAmount(amt);
    }

    async executeTrade(side) {
      if (this.activePosition) {
        alert("Ya tienes una posición abierta. Ciérrala primero antes de abrir otra.");
        return;
      }

      const inp = document.getElementById("prac-order-amount");
      const amount = parseFloat(inp?.value || "50");

      if (isNaN(amount) || amount <= 0) {
        alert("Ingresa un monto válido en USDT.");
        return;
      }

      if (amount > this.balance) {
        alert(`Saldo insuficiente. Tu balance simulado es de $${this.balance.toFixed(2)} USDT.`);
        return;
      }

      const evalData = this.evaluateDecision(side);
      const entryFee = parseFloat((amount * 0.00075).toFixed(4));

      const trade = {
        id: "prac_" + Date.now(),
        symbol: this.symbol,
        side,
        entryPrice: this.currentPrice,
        amount,
        entryFee,
        entryTime: Date.now(),
        evaluation: evalData
      };

      this.activePosition = trade;
      this.balance = Math.max(0, this.balance - amount);
      this.fees += entryFee;

      if (this.candleSeries && this.currentCandle) {
        const marker = {
          time: this.currentCandle.time,
          position: side === "BUY" ? "belowBar" : "aboveBar",
          color: side === "BUY" ? "#10b981" : "#ef4444",
          shape: side === "BUY" ? "arrowUp" : "arrowDown",
          text: `${side === "BUY" ? "COMPRA" : "VENTA"} $${this.currentPrice.toFixed(2)}`
        };
        this.markers.push(marker);
        this.candleSeries.setMarkers(this.markers);
      }

      this.renderEvaluation(evalData);
      this.updateUI();

      try {
        await fetch("/api/practice/trade", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "OPEN", trade })
        });
      } catch (e) {}
    }

    updateFloatingPosition() {
      if (!this.activePosition) {
        const card = document.getElementById("prac-open-pos-card");
        if (card) card.style.display = "none";
        return;
      }

      const card = document.getElementById("prac-open-pos-card");
      if (card) card.style.display = "block";

      const pos = this.activePosition;
      const elSide = document.getElementById("prac-pos-side");
      const elAmount = document.getElementById("prac-pos-amount");
      const elEntry = document.getElementById("prac-pos-entry");
      const elPnl = document.getElementById("prac-pos-floating-pnl");

      if (elSide) {
        elSide.textContent = pos.side === "BUY" ? "LONG 🟢" : "SHORT 🔴";
        elSide.style.background = pos.side === "BUY" ? "#10b981" : "#ef4444";
      }
      if (elAmount) elAmount.textContent = pos.amount.toFixed(2);
      if (elEntry) elEntry.textContent = `$${pos.entryPrice.toFixed(2)}`;

      let pct = 0;
      if (pos.side === "BUY") {
        pct = ((this.currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
      } else {
        pct = ((pos.entryPrice - this.currentPrice) / pos.entryPrice) * 100;
      }

      const pnlDollars = (pct / 100) * pos.amount;

      if (elPnl) {
        elPnl.textContent = `${pnlDollars >= 0 ? "+" : ""}$${pnlDollars.toFixed(2)} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)`;
        elPnl.style.color = pnlDollars >= 0 ? "#34d399" : "#f87171";
      }
    }

    async closeCurrentPosition() {
      if (!this.activePosition) return;

      const pos = this.activePosition;
      const exitPrice = this.currentPrice;
      const exitFee = parseFloat((pos.amount * 0.00075).toFixed(4));

      let pct = 0;
      if (pos.side === "BUY") {
        pct = ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100;
      } else {
        pct = ((pos.entryPrice - exitPrice) / pos.entryPrice) * 100;
      }

      const grossPnl = parseFloat(((pct / 100) * pos.amount).toFixed(2));
      const netPnl = parseFloat((grossPnl - (pos.entryFee + exitFee)).toFixed(2));
      const returnedAmount = Math.max(0, pos.amount + netPnl);

      const closedTrade = {
        id: pos.id,
        symbol: pos.symbol,
        side: pos.side,
        entryPrice: pos.entryPrice,
        exitPrice,
        amount: pos.amount,
        grossPnl,
        pnl: netPnl,
        entryFee: pos.entryFee,
        exitFee,
        returnedAmount,
        closeTime: Date.now(),
        evaluation: pos.evaluation
      };

      this.balance += returnedAmount;
      this.realizedPnl += netPnl;
      this.fees += exitFee;
      this.history.unshift(closedTrade);
      this.activePosition = null;

      const total = this.history.length;
      const wins = this.history.filter(h => h.pnl > 0).length;
      const losses = this.history.filter(h => h.pnl < 0).length;
      const winRate = total > 0 ? parseFloat(((wins / total) * 100).toFixed(1)) : 0;
      const scores = this.history.filter(h => typeof h.evaluation?.score === "number").map(h => h.evaluation.score);
      const avgScore = scores.length > 0 ? parseFloat((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1)) : 0;
      this.stats = { totalTrades: total, wins, losses, winRate, averageScore: avgScore };

      this.updateUI();

      try {
        await fetch("/api/practice/trade", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "CLOSE", trade: closedTrade })
        });
      } catch (e) {}
    }

    async resetBalancePrompt() {
      const str = prompt("¿Con cuántos USDT virtuales deseas reiniciar tu cuenta de práctica?", "1000");
      if (!str) return;
      const val = parseFloat(str);
      if (isNaN(val) || val <= 0) return;

      this.balance = val;
      this.realizedPnl = 0.0;
      this.fees = 0.0;
      this.history = [];
      this.activePosition = null;
      this.markers = [];
      if (this.candleSeries) this.candleSeries.setMarkers([]);
      this.stats = { totalTrades: 0, wins: 0, losses: 0, winRate: 0, averageScore: 0 };

      try {
        await fetch("/api/practice/reset", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ initialBalance: val })
        });
      } catch (e) {}

      this.updateUI();
    }

    updateUI() {
      const elBal = document.getElementById("prac-balance-val");
      const elPnl = document.getElementById("prac-pnl-val");
      const elTrades = document.getElementById("prac-trades-count");
      const elWinRate = document.getElementById("prac-winrate-val");
      const elFees = document.getElementById("prac-fees-val");
      const elAvgScore = document.getElementById("prac-avg-score");

      if (elBal) elBal.textContent = this.balance.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      if (elPnl) {
        const pnlPct = this.balance > 0 ? (this.realizedPnl / 1000) * 100 : 0;
        elPnl.innerHTML = `${this.realizedPnl >= 0 ? "+" : ""}$${this.realizedPnl.toFixed(2)} <span style="font-size:11px; font-weight:600;">(${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%)</span>`;
        elPnl.style.color = this.realizedPnl >= 0 ? "#34d399" : "#f87171";
      }
      if (elTrades) elTrades.textContent = this.stats.totalTrades;
      if (elWinRate) elWinRate.textContent = `${this.stats.winRate}%`;
      if (elFees) elFees.textContent = this.fees.toFixed(2);
      if (elAvgScore) elAvgScore.textContent = this.stats.averageScore > 0 ? this.stats.averageScore : "--";

      this.updateFloatingPosition();
      this.renderHistoryTable();
    }

    renderHistoryTable() {
      const tbody = document.getElementById("prac-history-table-body");
      if (!tbody) return;

      if (!this.history || this.history.length === 0) {
        tbody.innerHTML = `
          <tr>
            <td colspan="10" style="padding:20px; text-align:center; color:#64748b;">
              No hay operaciones registradas aún. ¡Haz tu primer trade simulado arriba!
            </td>
          </tr>
        `;
        return;
      }

      tbody.innerHTML = this.history.map(h => {
        const dateStr = new Date(h.closeTime).toLocaleTimeString();
        const pnlColor = h.pnl >= 0 ? "#34d399" : "#f87171";
        const score = h.evaluation?.score ?? "--";
        const scoreColor = typeof score === "number" ? (score >= 8.0 ? "#10b981" : score >= 6.0 ? "#f59e0b" : "#ef4444") : "#94a3b8";

        return `
          <tr style="border-bottom:1px solid rgba(255,255,255,0.04);">
            <td style="padding:8px 10px; color:#cbd5e1;">${dateStr}</td>
            <td style="padding:8px 10px; font-weight:700; color:#f1f5f9;">${h.symbol}</td>
            <td style="padding:8px 10px;"><span style="background:${h.side === "BUY" ? "rgba(16,185,129,0.15)" : "rgba(239,68,68,0.15)"}; color:${h.side === "BUY" ? "#34d399" : "#f87171"}; padding:2px 6px; border-radius:4px; font-weight:700; font-size:11px;">${h.side}</span></td>
            <td style="padding:8px 10px;">$${h.entryPrice.toFixed(2)}</td>
            <td style="padding:8px 10px;">$${h.exitPrice.toFixed(2)}</td>
            <td style="padding:8px 10px; color:${h.grossPnl >= 0 ? "#34d399" : "#f87171"}; font-weight:700;">${h.grossPnl >= 0 ? "+" : ""}$${h.grossPnl.toFixed(2)}</td>
            <td style="padding:8px 10px; color:#94a3b8;">-$${((h.entryFee || 0) + (h.exitFee || 0)).toFixed(3)}</td>
            <td style="padding:8px 10px; color:${pnlColor}; font-weight:800;">${h.pnl >= 0 ? "+" : ""}$${h.pnl.toFixed(2)}</td>
            <td style="padding:8px 10px;"><b style="color:${scoreColor}; font-weight:800;">⭐ ${score}</b></td>
            <td style="padding:8px 10px; color:#cbd5e1; font-size:11px; max-width:260px;">${h.evaluation?.verdict || "Completado"}</td>
          </tr>
        `;
      }).join("");
    }
  }

  window.practiceSim = new PracticeSimulator();

  document.addEventListener("DOMContentLoaded", () => {
    const savedTab = localStorage.getItem("cazador_active_tab");
    if (savedTab === "tab-practice") {
      window.practiceSim.init();
    }
  });
})();
