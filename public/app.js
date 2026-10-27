// Dashboard client: los componentes se crean UNA vez y solo se actualizan los textos.
// Nunca se borra ni se redibuja una tarjeta mientras la moneda siga activa.
(() => {
  const COP_PER_USDT = 4200;
  let pnlChart = null;
  let historySignature = "";

  // ---------- utilidades ----------
  const $ = (id) => document.getElementById(id);

  function fmt(val, dec = 2) {
    if (val === undefined || val === null || isNaN(val)) return "—";
    const n = Number(val);
    const a = Math.abs(n);
    if (a === 0) return "0.00";
    if (a < 0.0001) return n.toFixed(8);
    if (a < 0.01) return n.toFixed(6);
    if (a < 1) return n.toFixed(4);
    return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: dec });
  }
  const cop = (v) => Math.round(v).toLocaleString("es-CO");

  // Escriben en el DOM solo si el valor cambió
  function setText(el, txt) { if (el && el.textContent !== txt) el.textContent = txt; }
  function setHTML(el, html) { if (el && el.__html !== html) { el.innerHTML = html; el.__html = html; } }
  function setClass(el, cls) { if (el && el.className !== cls) el.className = cls; }
  function setStyle(el, prop, val) { if (el && el.style[prop] !== val) el.style[prop] = val; }

  // ---------- reloj ----------
  setInterval(() => setText($("live-clock"), new Date().toLocaleTimeString("es-CO")), 1000);

  // ---------- estado de conexión ----------
  function setConnection(ok, fresh) {
    const label = !ok ? "RECONECTANDO…" : fresh ? "MONITOREO EN VIVO" : "PRECIOS DEMORADOS";
    setText($("system-status"), label);
    setClass($("status-pill"), "status-pill" + (ok && fresh ? "" : " offline"));
  }

  // ---------- error de autenticación con Binance ----------
  function renderAuthBanner(err) {
    const el = $("auth-banner");
    if (!el) return;
    if (err) {
      setText($("auth-banner-msg"), err);
      setStyle(el, "display", "block");
    } else {
      setStyle(el, "display", "none");
    }
  }

  // ---------- KPIs ----------
  function renderKpis(d) {
    const pf = d.portfolio;
    setText($("kpi-total-usdt-num"), `$${fmt(pf.totalEstimatedUsdt)}`);
    setText($("kpi-total-cop"), `≈ $${cop(pf.totalEstimatedCop)} COP`);

    if (d.accountAvailable) {
      setText($("kpi-free-usdt-num"), `$${fmt((pf.usdtFree || 0) + (pf.usdtEarn || 0))}`);
    }
    setText($("kpi-slots"), `Slots en uso: ${pf.openPositionsCount} / ${pf.maxSlots}`);

    const perf = d.performance;
    if (perf) {
      const s = perf.totalPnlUsdt >= 0 ? "+" : "";
      setText($("kpi-realized-pnl-num"), `${s}${fmt(perf.totalPnlUsdt, 3)}`);
      setText($("kpi-realized-cop"), `≈ ${s}$${cop(perf.totalPnlCop)} COP acumulados`);
      setText($("kpi-winrate"), `${perf.winRate}% Win Rate`);
      setText($("kpi-cycles-num"), `${perf.wins}`);

    // Render Fear & Greed
    const fng = d.marketSentiment;
    if (fng) {
      const fngEl = $("fng-text");
      if (fngEl) fngEl.textContent = `${fng.value} ${fng.classification}`;
      const fngPill = $("fng-pill");
      if (fngPill) {
        fngPill.style.color = fng.value <= 30 ? "#F87171" : fng.value >= 70 ? "#34D399" : "#FBBF24";
      }
    }

    // Render Night Mode Pill
    const nightEl = $("night-pill");
    if (nightEl) nightEl.style.display = d.nightMode ? "inline-flex" : "none";

    // Render Vault Amount
    const vEl = $("vault-amount");
    if (vEl && pf) vEl.textContent = `${fmt(pf.usdtEarn || 0)} USDT`;

    // Render Compound Projections
    const proj = d.projections;
    if (proj) {
      setText($("compound-rate-tag"), `+${fmt(proj.dailyAvgUsdt)} USDT/día prom.`);
      setText($("proj-30d-usdt"), `+${fmt(proj.p30dUsdt)} USDT`);
      setText($("proj-30d-cop"), `≈ +${cop(proj.p30dCop)} COP`);
      setText($("proj-60d-usdt"), `+${fmt(proj.p60dUsdt)} USDT`);
      setText($("proj-60d-cop"), `≈ +${cop(proj.p60dCop)} COP`);
      setText($("proj-90d-usdt"), `+${fmt(proj.p90dUsdt)} USDT`);
      setText($("proj-90d-cop"), `≈ +${cop(proj.p90dCop)} COP`);
    }
      setText($("kpi-cycles-total"), `de ${perf.cyclesCount} ganados`);
      setText($("kpi-losses"), `${perf.losses} operaciones perdidas`);
    }
  }

  // ---------- posiciones (reconciliación por símbolo) ----------
  function createPositionCard(p) {
    const card = document.createElement("div");
    card.className = "position-card";
    card.dataset.symbol = p.symbol;
    card.innerHTML = `
      <div class="pos-head">
        <div class="coin-badge">
          <div class="coin-avatar">${p.base.substring(0, 4)}</div>
          <div>
            <div class="coin-name">${p.symbol}</div>
            <div class="coin-qty" data-f="qty"></div>
          </div>
        </div>
        <span data-f="badge" class="trailing-status-pill pill-waiting"></span>
      </div>
      <div class="price-row">
        <div class="price-col"><span>Entrada</span><strong data-f="buy"></strong></div>
        <div class="price-col"><span>Precio actual</span><strong data-f="cur"></strong></div>
        <div class="price-col"><span>Meta (+0.8%)</span><strong data-f="target"></strong></div>
      </div>
      <div class="progress-wrapper">
        <div class="progress-info">
          <span style="color:var(--text-muted)">Progreso hacia la meta</span>
          <span style="font-family:var(--font-mono)" data-f="proginfo"></span>
        </div>
        <div class="progress-track"><div class="progress-fill" data-f="fill" style="width:0%"></div></div>
      </div>
      <div class="pos-footer">
        <span class="pnl-label">Ganancia flotante</span>
        <div style="text-align:right">
          <div class="pnl-value" data-f="pnl"></div>
          <div class="pnl-cop" data-f="pnlcop"></div>
        </div>
      </div>`;
    return card;
  }

  function updatePositionCard(card, p) {
    const f = (k) => card.querySelector(`[data-f="${k}"]`);
    const gain = p.gainPct >= 0;
    const s = gain ? "+" : "";

    setText(f("qty"), `${fmt(p.qty)} ${p.base} • Invertido: $${fmt(p.investedUsdt)} USDT`);
    setText(f("buy"), `$${fmt(p.buyPrice)}`);
    setText(f("cur"), `$${fmt(p.curPrice)}`);
    setStyle(f("cur"), "color", gain ? "var(--accent-green)" : "var(--accent-rose)");
    setText(f("target"), `$${fmt(p.target08)}`);

    const badge = f("badge");
    if (p.activated) {
      setClass(badge, "trailing-status-pill pill-active");
      setText(badge, "🚀 Trailing activo");
    } else {
      setClass(badge, "trailing-status-pill pill-waiting");
      setText(badge, "⏳ Esperando +0.8%");
    }

    const fill = f("fill");
    setStyle(fill, "width", `${Math.max(2, Math.min(100, p.progressPct)).toFixed(1)}%`);
    setClass(fill, "progress-fill" + (p.activated ? " trailing-mode" : ""));

    if (p.activated) {
      setText(f("proginfo"), `Pico $${fmt(p.highestPrice)} (+${p.peakGainPct.toFixed(2)}%) • Salida $${fmt(p.stopPrice)}`);
    } else {
      const falta = ((p.target08 - p.curPrice) / p.curPrice) * 100;
      setText(f("proginfo"), falta > 0 ? `Falta +${falta.toFixed(2)}%` : "Meta alcanzada");
    }

    const pnl = f("pnl");
    setClass(pnl, "pnl-value " + (gain ? "pos-profit" : "pos-loss"));
    setText(pnl, `${s}${fmt(p.pnlUsdt)} USDT (${s}${p.gainPct.toFixed(2)}%)`);
    setText(f("pnlcop"), `≈ ${s}$${cop(p.pnlCop)} COP`);
  }

  function renderPositions(list) {
    const box = $("positions-container");
    const empty = $("positions-empty");
    setText($("active-positions-count"), `${list.length} activa(s)`);

    const existing = new Map();
    box.querySelectorAll(".position-card").forEach((c) => existing.set(c.dataset.symbol, c));

    list.forEach((p) => {
      let card = existing.get(p.symbol);
      if (!card) { card = createPositionCard(p); box.appendChild(card); }
      updatePositionCard(card, p);
      existing.delete(p.symbol);
    });
    // Solo se retira una tarjeta cuando la posición se cerró de verdad
    existing.forEach((card) => card.remove());

    setStyle(empty, "display", list.length === 0 ? "block" : "none");
  }

  // ---------- radar (reconciliación por símbolo) ----------
  function renderRadar(list) {
    const tbody = $("radar-tbody");
    const existing = new Map();
    tbody.querySelectorAll("tr").forEach((r) => existing.set(r.dataset.symbol, r));

    list.forEach((r) => {
      let row = existing.get(r.symbol);
      if (!row) {
        row = document.createElement("tr");
        row.dataset.symbol = r.symbol;
        row.innerHTML = `<td><strong>${r.symbol.replace("USDT", "")}</strong></td>
          <td data-f="price"></td><td data-f="drop"></td>
          <td><span data-f="rsi" class="rsi-pill rsi-neutral"></span></td><td data-f="status"></td>`;
        tbody.appendChild(row);
      }
      existing.delete(r.symbol);
      const f = (k) => row.querySelector(`[data-f="${k}"]`);

      setText(f("price"), r.curPrice != null ? `$${fmt(r.curPrice)}` : "—");
      if (r.dropPct != null) {
        setText(f("drop"), `-${r.dropPct.toFixed(2)}%`);
        setStyle(f("drop"), "color", r.dropPct >= 1.5 ? "var(--accent-rose)" : "var(--text-muted)");
      }
      if (r.rsi != null) {
        setText(f("rsi"), `RSI ${r.rsi.toFixed(1)}`);
        setClass(f("rsi"), "rsi-pill " + (r.rsi <= 45 ? "rsi-dip" : "rsi-neutral"));
      }
      let st, color;
      if (r.isHunting) { st = `🎯 Cazando piso ($${fmt(r.lowestPrice)})`; color = "var(--accent-green)"; }
      else if (r.dropPct != null && r.dropPct >= 1.5) { st = "🔻 Caída detectada"; color = "var(--accent-blue)"; }
      else { st = "📡 Escaneando"; color = "var(--text-dim)"; }
      setText(f("status"), st);
      setStyle(f("status"), "color", color);
    });
    existing.forEach((row) => row.remove());
  }

  // ---------- historial + gráfica (solo cuando hay ciclos nuevos) ----------
  function renderHistory(cycles) {
    if (!cycles) return;
    const sig = cycles.length + ":" + (cycles[0]?.orderId ?? "");
    if (sig === historySignature) return;
    historySignature = sig;

    $("history-tbody").innerHTML = cycles.map((c, i) => {
      const d = new Date(c.time).toLocaleString("es-CO", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
      const s = c.pnlUsdt >= 0 ? "+" : "";
      const cls = c.pnlUsdt >= 0 ? "pos-profit" : "pos-loss";
      return `<tr>
        <td style="color:var(--text-dim)">${i + 1}</td>
        <td><strong>${c.symbol.replace("USDT", "")}</strong></td>
        <td style="color:var(--text-dim)">${d}</td>
        <td>$${fmt(c.avgBuy)}</td><td>$${fmt(c.avgSell)}</td>
        <td class="${cls}"><strong>${s}${fmt(c.pnlUsdt, 3)} USDT</strong></td>
        <td class="${cls}">${s}${c.pnlPct.toFixed(2)}%</td>
        <td><span class="win-tag">${c.pnlUsdt >= 0 ? "GANADO" : "PÉRDIDA"}</span></td></tr>`;
    }).join("");

    renderChart(cycles);
  }

  function renderChart(cycles) {
    if (typeof Chart === "undefined" || !cycles.length) return;
    const ordered = [...cycles].reverse();
    let acc = 0;
    const labels = ordered.map((c, i) => `#${i + 1} ${c.symbol.replace("USDT", "")}`);
    const points = ordered.map((c) => +(acc += c.pnlUsdt).toFixed(3));

    if (pnlChart) {
      pnlChart.data.labels = labels;
      pnlChart.data.datasets[0].data = points;
      pnlChart.update("none");
      return;
    }
    pnlChart = new Chart($("pnlChart").getContext("2d"), {
      type: "line",
      data: { labels, datasets: [{
        data: points, borderColor: "#10B981", backgroundColor: "rgba(16,185,129,0.12)",
        fill: true, tension: 0.35, borderWidth: 2.5, pointBackgroundColor: "#10B981", pointRadius: 4
      }] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (c) => ` +${c.raw} USDT (≈ $${cop(c.raw * COP_PER_USDT)} COP)` } }
        },
        scales: {
          x: { grid: { color: "rgba(255,255,255,0.04)" }, ticks: { color: "#64748B", font: { size: 10 } } },
          y: { grid: { color: "rgba(255,255,255,0.04)" }, ticks: { color: "#64748B", callback: (v) => `+$${v}` } }
        }
      }
    });
  }

  // ---------- ciclo de refresco (sin solapamiento) ----------
  
  
  // ---------- Presupuesto por Estrategia (Allocations) ----------
  let latestFreeUsdt = 0;
  let userHasUnsavedBudgetChanges = false;

  function updateBudgetSum() {
    const sT = parseInt(document.getElementById("slider-trailing")?.value || "0", 10);
    const sD = parseInt(document.getElementById("slider-dca")?.value || "0", 10);
    const sG = parseInt(document.getElementById("slider-grid")?.value || "0", 10);
    const sW = parseInt(document.getElementById("slider-weekend")?.value || "0", 10);

    const sum = sT + sD + sG + sW;
    const badge = document.getElementById("budget-sum-badge");
    const saveBtn = document.getElementById("btn-save-alloc");

    if (badge) {
      badge.textContent = sum + "%";
      if (sum === 100) {
        badge.className = "";
        if (saveBtn) saveBtn.style.opacity = "1";
      } else {
        badge.className = "error";
        badge.textContent = sum + "% (debe sumar 100%)";
        if (saveBtn) saveBtn.style.opacity = "0.5";
      }
    }
  }

  async function saveAllocations(t, d, g, w) {
    try {
      const payload = { trailing: t, dca: d, grid: g, weekend: w };
      const res = await fetch("/api/strategies/allocation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        userHasUnsavedBudgetChanges = false;
        const btn = document.getElementById("btn-save-alloc");
        if (btn) {
          btn.textContent = "✅ ¡Guardado!";
          btn.style.boxShadow = "0 0 16px rgba(16, 185, 129, 0.6)";
          setTimeout(() => {
            btn.textContent = "💾 Guardar Porcentajes";
            btn.style.boxShadow = "none";
          }, 2000);
        }
        fetchStrategies();
      }
    } catch(e) {}
  }


  // ---------- Gestión de Riesgo (Stop-Loss) & Radar de Ondas ----------
  let selectedTimeframe = "1h";
  let userEditingRisk = false;

  
  // ---------- Módulos Autónomos: Stop-Loss, Timeframe & Sugerencias por Tarjeta ----------
  const strategyKeys = ["trailing_rebound", "smart_dca", "micro_grid", "cazador_weekend"];
  const stratShortMap = { trailing_rebound: "trailing", smart_dca: "dca", micro_grid: "grid", cazador_weekend: "weekend" };

  function initAutonomousStrategyControls() {
    strategyKeys.forEach(strat => {
      const short = stratShortMap[strat];

      // 1. Timeframe buttons per strategy
      const tfGroup = document.querySelector(`.mini-tf-group[data-strat="${strat}"]`);
      if (tfGroup) {
        tfGroup.querySelectorAll(".btn-mini-tf").forEach(btn => {
          btn.addEventListener("click", async () => {
            const tf = btn.getAttribute("data-tf");
            tfGroup.querySelectorAll(".btn-mini-tf").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            const badgeTf = document.getElementById(`badge-tf-${short}`);
            if (badgeTf) badgeTf.textContent = `⏱️ ${tf.toUpperCase()}`;
            const lblTf = document.getElementById(`lbl-tf-${short}`);
            if (lblTf) lblTf.textContent = tf.toUpperCase();

            await updateModuleSettings(strat, { timeframe: tf });
          });
        });
      }

      // 2. Stop-Loss slider & toggle per strategy
      const sliderSl = document.getElementById(`slider-sl-${short}`);
      const toggleSl = document.getElementById(`toggle-sl-${short}`);
      const lblSl = document.getElementById(`lbl-sl-${short}`);
      const badgeSl = document.getElementById(`badge-sl-${short}`);

      if (sliderSl && lblSl) {
        sliderSl.addEventListener("input", () => {
          lblSl.textContent = `-${parseFloat(sliderSl.value).toFixed(1)}%`;
          if (badgeSl) badgeSl.textContent = `🛑 SL -${parseFloat(sliderSl.value).toFixed(1)}%`;
        });

        sliderSl.addEventListener("change", async () => {
          await updateModuleSettings(strat, { stopLossPct: parseFloat(sliderSl.value) });
        });
      }

      if (toggleSl) {
        toggleSl.addEventListener("change", async () => {
          if (badgeSl) {
            badgeSl.style.opacity = toggleSl.checked ? "1" : "0.4";
            badgeSl.textContent = toggleSl.checked ? `🛑 SL -${parseFloat(sliderSl.value).toFixed(1)}%` : "🛑 SL OFF";
          }
          await updateModuleSettings(strat, { stopLossEnabled: toggleSl.checked });
        });
      }

      // 3. Bot Suggestion Button per strategy
      const btnApply = document.getElementById(`btn-apply-${short}`);
      if (btnApply) {
        btnApply.addEventListener("click", async () => {
          await applyBotSuggestion(strat, btnApply);
        });
      }
    });
  }

  async function updateModuleSettings(strategy, payload) {
    try {
      payload.strategy = strategy;
      await fetch("/api/strategies/module-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      fetchStrategies();
    } catch(e) {}
  }

  async function applyBotSuggestion(strategy, btn) {
    try {
      if (btn) btn.textContent = "⏳ Aplicando…";
      const res = await fetch("/api/strategies/apply-suggestion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ strategy })
      });
      if (res.ok) {
        if (btn) {
          btn.textContent = "✅ ¡Sugerencia Aplicada!";
          btn.classList.add("applied");
          setTimeout(() => {
            btn.textContent = "⚡ Aplicar Sugerencia";
            btn.classList.remove("applied");
          }, 2500);
        }
        fetchStrategies();
      }
    } catch(e) {
      if (btn) btn.textContent = "⚠️ Error";
    }
  }

  function syncModularStrategyControls(controls) {
    if (!controls) return;
    const settings = controls.strategySettings || {};
    const suggestions = controls.suggestions || {};

    strategyKeys.forEach(strat => {
      const short = stratShortMap[strat];
      const s = settings[strat] || {};
      const sugg = suggestions[strat];

      // Sync Timeframe
      if (s.timeframe) {
        const tfGroup = document.querySelector(`.mini-tf-group[data-strat="${strat}"]`);
        if (tfGroup) {
          tfGroup.querySelectorAll(".btn-mini-tf").forEach(b => {
            b.classList.toggle("active", b.getAttribute("data-tf") === s.timeframe);
          });
        }
        const badgeTf = document.getElementById(`badge-tf-${short}`);
        if (badgeTf) badgeTf.textContent = `⏱️ ${s.timeframe.toUpperCase()}`;
        const lblTf = document.getElementById(`lbl-tf-${short}`);
        if (lblTf) lblTf.textContent = s.timeframe.toUpperCase();
      }

      // Sync Stop-Loss
      const sliderSl = document.getElementById(`slider-sl-${short}`);
      const toggleSl = document.getElementById(`toggle-sl-${short}`);
      const lblSl = document.getElementById(`lbl-sl-${short}`);
      const badgeSl = document.getElementById(`badge-sl-${short}`);

      if (s.stopLossPct !== undefined && sliderSl && lblSl) {
        sliderSl.value = s.stopLossPct;
        lblSl.textContent = `-${parseFloat(s.stopLossPct).toFixed(1)}%`;
        if (badgeSl) badgeSl.textContent = `🛑 SL -${parseFloat(s.stopLossPct).toFixed(1)}%`;
      }
      if (s.stopLossEnabled !== undefined && toggleSl) {
        toggleSl.checked = s.stopLossEnabled;
        if (badgeSl) {
          badgeSl.style.opacity = s.stopLossEnabled ? "1" : "0.4";
          if (!s.stopLossEnabled) badgeSl.textContent = "🛑 SL OFF";
        }
      }

      // Sync Suggestion Text
      if (sugg && sugg.reason) {
        const textSugg = document.getElementById(`sugg-text-${short}`);
        if (textSugg) {
          textSugg.textContent = sugg.reason;
        }
      }
    });
  }

function initRiskControls() {
    const sliderSl = document.getElementById("slider-stoploss");
    const labelSl = document.getElementById("stoploss-val-label");
    const toggleSl = document.getElementById("toggle-stoploss");
    const badgeStatus = document.getElementById("risk-status-badge");
    const btnSaveRisk = document.getElementById("btn-save-risk");

    if (sliderSl && labelSl) {
      sliderSl.addEventListener("input", () => {
        userEditingRisk = true;
        labelSl.textContent = `-${parseFloat(sliderSl.value).toFixed(1)}%`;
      });
    }

    if (toggleSl && badgeStatus) {
      toggleSl.addEventListener("change", () => {
        userEditingRisk = true;
        updateRiskBadge(toggleSl.checked, sliderSl ? sliderSl.value : 4.0);
      });
    }

    // Timeframe buttons (15m, 1h, 4h)
    ["15m", "1h", "4h"].forEach(tf => {
      const btn = document.getElementById(`tf-${tf}`);
      if (btn) {
        btn.addEventListener("click", () => {
          userEditingRisk = true;
          selectedTimeframe = tf;
          document.querySelectorAll(".btn-tf").forEach(b => b.classList.remove("active"));
          btn.classList.add("active");
          const curBadge = document.getElementById("current-tf-badge");
          if (curBadge) {
            curBadge.textContent = tf === "1h" ? "1H (Base)" : tf.toUpperCase();
          }
        });
      }
    });

    if (btnSaveRisk) {
      btnSaveRisk.addEventListener("click", async () => {
        const slOn = toggleSl ? toggleSl.checked : true;
        const slPct = sliderSl ? parseFloat(sliderSl.value) : 4.0;
        await saveRiskSettings(slOn, slPct, selectedTimeframe);
      });
    }
  }

  function updateRiskBadge(enabled, pct) {
    const badgeStatus = document.getElementById("risk-status-badge");
    if (!badgeStatus) return;
    if (enabled) {
      badgeStatus.className = "risk-badge-active";
      badgeStatus.textContent = `🟢 Stop-Loss Activo (-${parseFloat(pct).toFixed(1)}%)`;
      badgeStatus.style.background = "rgba(16, 185, 129, 0.15)";
      badgeStatus.style.color = "#34D399";
    } else {
      badgeStatus.className = "risk-badge-active";
      badgeStatus.textContent = "🔴 Stop-Loss Desactivado";
      badgeStatus.style.background = "rgba(244, 63, 94, 0.15)";
      badgeStatus.style.color = "#F87171";
    }
  }

  async function saveRiskSettings(slOn, slPct, tf) {
    const btn = document.getElementById("btn-save-risk");
    try {
      if (btn) btn.textContent = "⏳ Guardando…";
      const res = await fetch("/api/strategies/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stopLossEnabled: slOn,
          stopLossPct: slPct,
          timeframe: tf,
          cashReservePct: 25,
          maxPerCoinPct: 30
        })
      });
      if (res.ok) {
        userEditingRisk = false;
        if (btn) {
          btn.textContent = "✅ ¡Ajustes Guardados!";
          btn.style.boxShadow = "0 0 16px rgba(16, 185, 129, 0.6)";
          setTimeout(() => {
            btn.textContent = "💾 Guardar Ajustes de Riesgo";
            btn.style.boxShadow = "none";
          }, 2500);
        }
        fetchStrategies();
      }
    } catch(e) {
      if (btn) btn.textContent = "⚠️ Error al guardar";
    }
  }

  // ---------- Orquestador Multi-Estrategia & Oportunidad Pendiente ----------
  let currentOpportunity = null;

  async function fetchStrategies() {
    // sync autonomous controls

    try {
      const res = await fetch("/api/strategies", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      if (!data || !data.controls) return;
      syncModularStrategyControls(data.controls);

      const c = data.controls;
      const s = c.strategies || {};


      // Actualizar Gestión de Riesgo (Stop-Loss & Timeframe) si el usuario no está editando
      if (!userEditingRisk) {
        const toggleSl = document.getElementById("toggle-stoploss");
        const sliderSl = document.getElementById("slider-stoploss");
        const labelSl = document.getElementById("stoploss-val-label");
        const curBadge = document.getElementById("current-tf-badge");

        const slOn = c.stopLossEnabled !== false;
        const slVal = c.stopLossPct ?? 4.0;
        const tfVal = c.timeframe || "1h";

        if (toggleSl) toggleSl.checked = slOn;
        if (sliderSl) sliderSl.value = slVal;
        if (labelSl) labelSl.textContent = `-${parseFloat(slVal).toFixed(1)}%`;
        updateRiskBadge(slOn, slVal);

        selectedTimeframe = tfVal;
        document.querySelectorAll(".btn-tf").forEach(b => {
          b.classList.toggle("active", b.getAttribute("data-tf") === tfVal);
        });
        if (curBadge) {
          curBadge.textContent = tfVal === "1h" ? "1H (Base)" : tfVal.toUpperCase();
        }
      }

      // Actualizar toggles sólo si el usuario no los está arrastrando en este milisegundo
      const tTrailing = document.getElementById("toggle-trailing");
      const tDca = document.getElementById("toggle-dca");
      const tGrid = document.getElementById("toggle-grid");
      const tWeekend = document.getElementById("toggle-weekend");
      const tAuto = document.getElementById("toggle-autopilot");
      const modeLabel = document.getElementById("mode-label");

      if (tTrailing && !tTrailing.matches(":focus")) tTrailing.checked = !!s.trailing_rebound;
      if (tDca && !tDca.matches(":focus")) tDca.checked = !!s.smart_dca;
      if (tGrid && !tGrid.matches(":focus")) tGrid.checked = !!s.micro_grid;
      const isWeekendMode = !!data.weekendMode;
      if (tWeekend && !tWeekend.matches(":focus")) {
        tWeekend.checked = !!s.cazador_weekend && isWeekendMode;
      }

      // Actualizar Presupuestos y Porcentajes
      const a = c.allocations || { trailing_rebound: 50, smart_dca: 30, micro_grid: 0, cazador_weekend: 20 };
      const base = c.baseAllocations || { trailing_rebound: 50, smart_dca: 30, micro_grid: 0, cazador_weekend: 20 };
      const aT = a.trailing_rebound ?? 50;
      const aD = a.smart_dca ?? 30;
      const aG = a.micro_grid ?? 0;
      const aW = a.cazador_weekend ?? 20;
      const baseT = base.trailing_rebound ?? 50;
      const baseW = base.cazador_weekend ?? 20;
      const baseD = base.smart_dca ?? 30;
      const baseG = base.micro_grid ?? 0;

      const tBadge = document.getElementById("alloc-trailing-badge");
      const dBadge = document.getElementById("alloc-dca-badge");
      const gBadge = document.getElementById("alloc-grid-badge");
      const wBadge = document.getElementById("alloc-weekend-badge");

      const tBar = document.getElementById("alloc-trailing-bar");
      const dBar = document.getElementById("alloc-dca-bar");
      const gBar = document.getElementById("alloc-grid-bar");
      const wBar = document.getElementById("alloc-weekend-bar");

      const tAmt = document.getElementById("alloc-trailing-amount");
      const dAmt = document.getElementById("alloc-dca-amount");
      const gAmt = document.getElementById("alloc-grid-amount");
      const wAmt = document.getElementById("alloc-weekend-amount");

      if (tBadge) {
        if (!isWeekendMode && baseW > 0) {
          tBadge.textContent = aT + "% Activo (" + baseT + "% base + " + baseW + "% auto-transferido)";
        } else {
          tBadge.textContent = aT + "% Asignado";
        }
      }
      if (dBadge) dBadge.textContent = aD + "% Asignado";
      if (gBadge) gBadge.textContent = aG + "% Asignado";
      if (wBadge) {
        if (isWeekendMode && s.cazador_weekend) {
          wBadge.textContent = aW + "% Asignado (🟢 En Ventana)";
          wBadge.style.color = "#EC4899";
          wBadge.style.background = "rgba(236,72,153,0.15)";
        } else if (!isWeekendMode) {
          wBadge.textContent = aW + "% Asignado (⚪ En Espera hasta Viernes)";
          wBadge.style.color = "#9CA3AF";
          wBadge.style.background = "rgba(156,163,175,0.15)";
        } else {
          wBadge.textContent = aW + "% Asignado (🔴 Pausado)";
          wBadge.style.color = "#EF4444";
          wBadge.style.background = "rgba(239,68,68,0.15)";
        }
      }

      if (tBar) tBar.style.width = aT + "%";
      if (dBar) dBar.style.width = aD + "%";
      if (gBar) gBar.style.width = aG + "%";
      if (wBar) wBar.style.width = aW + "%";

      if (tAmt) tAmt.textContent = "~$" + (latestFreeUsdt * (aT / 100)).toFixed(2) + " USDT libres";
      if (dAmt) dAmt.textContent = "~$" + (latestFreeUsdt * (aD / 100)).toFixed(2) + " USDT libres";
      if (gAmt) gAmt.textContent = "~$" + (latestFreeUsdt * (aG / 100)).toFixed(2) + " USDT libres";
      if (wAmt) wAmt.textContent = "~$" + (latestFreeUsdt * (aW / 100)).toFixed(2) + " USDT libres";

      if (!userHasUnsavedBudgetChanges) {
        const sT = document.getElementById("slider-trailing");
        const sD = document.getElementById("slider-dca");
        const sG = document.getElementById("slider-grid");
        const sW = document.getElementById("slider-weekend");

        if (sT) { sT.value = baseT; document.getElementById("slider-trailing-val").textContent = baseT + "%"; }
        if (sD) { sD.value = baseD; document.getElementById("slider-dca-val").textContent = baseD + "%"; }
        if (sG) { sG.value = baseG; document.getElementById("slider-grid-val").textContent = baseG + "%"; }
        if (sW) { sW.value = baseW; document.getElementById("slider-weekend-val").textContent = baseW + "%"; }
        updateBudgetSum();
      }
      if (tAuto && !tAuto.matches(":focus")) {
        tAuto.checked = !!c.autoPilot;
        if (modeLabel) modeLabel.textContent = c.autoPilot ? "🟢 Piloto Automático" : "🟡 Modo Manual";
      }

      // Oportunidad pendiente
      const oppCard = document.getElementById("opportunity-card");
      const opp = data.pendingOpportunity;
      currentOpportunity = opp;

      if (opp && oppCard) {
        oppCard.style.display = "block";
        const symEl = document.getElementById("opp-symbol");
        const stratEl = document.getElementById("opp-strategy");
        const reasonEl = document.getElementById("opp-reason");
        const timerEl = document.getElementById("opp-countdown");

        if (symEl) symEl.textContent = opp.symbol;
        if (stratEl) stratEl.textContent = opp.strategyName;
        if (reasonEl) reasonEl.textContent = opp.reason;

        const remMs = Math.max(0, opp.expiresAt - (data.serverTime || Date.now()));
        const remSec = Math.floor(remMs / 1000);
        const mins = Math.floor(remSec / 60);
        const secs = remSec % 60;
        if (timerEl) {
          timerEl.textContent = `⏱️ ${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')} restantes`;
        }
      } else if (oppCard) {
        oppCard.style.display = "none";
      }
    } catch (e) {}
  }

  // Enviar cambio de estrategia al backend
  async function toggleStrategy(key, isAutoPilot = false) {
    try {
      const payload = isAutoPilot ? { autoPilot: document.getElementById("toggle-autopilot").checked } : { strategy: key };
      await fetch("/api/strategies/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      fetchStrategies();
    } catch(e) {}
  }

  // Enviar acción sobre oportunidad pendiente
  async function handleOpportunityAction(action) {
    try {
      const oppCard = document.getElementById("opportunity-card");
      if (oppCard) oppCard.style.display = "none";
      await fetch("/api/opportunity/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action })
      });
      setTimeout(fetchStrategies, 500);
    } catch(e) {}
  }

  // Asignar eventos de botones una sola vez
  setTimeout(() => {

    const sT = document.getElementById("slider-trailing");
    const sD = document.getElementById("slider-dca");
    const sG = document.getElementById("slider-grid");
    const sW = document.getElementById("slider-weekend");

    const onSliderChange = () => {
      userHasUnsavedBudgetChanges = true;
      if (sT) document.getElementById("slider-trailing-val").textContent = sT.value + "%";
      if (sD) document.getElementById("slider-dca-val").textContent = sD.value + "%";
      if (sG) document.getElementById("slider-grid-val").textContent = sG.value + "%";
      if (sW) document.getElementById("slider-weekend-val").textContent = sW.value + "%";
      updateBudgetSum();
      const saveBtn = document.getElementById("btn-save-alloc");
      if (saveBtn) saveBtn.style.boxShadow = "0 0 14px rgba(245, 158, 11, 0.5)";
    };

    [sT, sD, sG, sW].forEach(s => {
      s?.addEventListener("input", onSliderChange);
      s?.addEventListener("change", onSliderChange);
    });

    document.getElementById("btn-save-alloc")?.addEventListener("click", () => {
      const t = parseInt(sT?.value || "50", 10);
      const d = parseInt(sD?.value || "30", 10);
      const g = parseInt(sG?.value || "0", 10);
      const w = parseInt(sW?.value || "20", 10);
      if (t + d + g + w === 100) {
        saveAllocations(t, d, g, w);
      } else {
        alert("La suma debe ser exactamente 100%. Actualmente suma " + (t + d + g + w) + "%");
      }
    });

    document.querySelectorAll(".btn-preset").forEach(btn => {
      btn.addEventListener("click", () => {
        const t = parseInt(btn.dataset.t, 10);
        const d = parseInt(btn.dataset.d, 10);
        const g = parseInt(btn.dataset.g, 10);
        const w = parseInt(btn.dataset.w || "0", 10);
        if (sT) { sT.value = t; document.getElementById("slider-trailing-val").textContent = t + "%"; }
        if (sD) { sD.value = d; document.getElementById("slider-dca-val").textContent = d + "%"; }
        if (sG) { sG.value = g; document.getElementById("slider-grid-val").textContent = g + "%"; }
        if (sW) { sW.value = w; document.getElementById("slider-weekend-val").textContent = w + "%"; }
        updateBudgetSum();
        saveAllocations(t, d, g, w);
      });
    });

    document.getElementById("toggle-trailing")?.addEventListener("change", () => toggleStrategy("trailing_rebound"));
    document.getElementById("toggle-dca")?.addEventListener("change", () => toggleStrategy("smart_dca"));
    document.getElementById("toggle-grid")?.addEventListener("change", () => toggleStrategy("micro_grid"));
    document.getElementById("toggle-weekend")?.addEventListener("change", () => toggleStrategy("cazador_weekend"));
    document.getElementById("toggle-autopilot")?.addEventListener("change", () => toggleStrategy(null, true));

    document.getElementById("btn-opp-approve")?.addEventListener("click", () => handleOpportunityAction("approve"));
    document.getElementById("btn-opp-ignore")?.addEventListener("click", () => handleOpportunityAction("ignore"));
  }, 1000);

  async function tick() {
    fetchStrategies();
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch("/api/status", { cache: "no-store", signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) throw new Error(res.status);
      const d = await res.json();
      latestFreeUsdt = (d.portfolio?.usdtFree ?? 0) + (d.portfolio?.usdtEarn ?? 0);
      renderAuthBanner(d.authError);
      renderKpis(d);
      renderPositions(d.positions);
      renderRadar(d.radar);
      renderHistory(d.recentCycles);
      setConnection(true, d.pricesFresh);
    } catch {
      // Si falla, se conserva lo que hay en pantalla: no se borra nada
      setConnection(false, false);
    } finally {
      setTimeout(tick, 2000);
    }
  }
  tick();
})();
