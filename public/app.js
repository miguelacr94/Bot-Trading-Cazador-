(() => {
  let COP_PER_USDT = 3103;
  let pnlChart = null;
  let historySignature = "";
  let crossoverChart = null;
  let crossoverCurrency = localStorage.getItem("crossover_currency") || "COP";
  let latestStatusData = null;
  let latestWalletSplit = { manualUsdt: 25.0, botUsdt: 0, totalFreeUsdt: 0, copRate: 3103, manualCop: 77575, botCop: 0 };
  let latestRadarList = [];

  const LIFETIME_BINANCE_DEPOSITS = [
    { id: 1, date: "30 Oct 2025", cop: 50000, usdt: 15.71, note: "Depósito inicial Binance (PSE)" },
    { id: 2, date: "20 Nov 2025", cop: 50000, usdt: 15.71, note: "Depósito PSE Bancolombia" },
    { id: 3, date: "09 Dic 2025", cop: 50000, usdt: 15.71, note: "Depósito PSE Bancolombia" },
    { id: 4, date: "26 Ene 2026", cop: 100000, usdt: 31.42, note: "Recarga capital PSE" },
    { id: 5, date: "31 Ene 2026", cop: 50000, usdt: 15.71, note: "Recarga PSE Binance" },
    { id: 6, date: "31 Ene 2026", cop: 50000, usdt: 15.71, note: "Recarga PSE Binance" },
    { id: 7, date: "16 Oct 2026", cop: 50000, usdt: 15.72, note: "Inicio ciclo Spot Bot (PSE)" },
    { id: 8, date: "19 Oct 2026", cop: 50000, usdt: 15.71, note: "Ampliación Spot Bot (PSE)" },
    { id: 9, date: "22 Oct 2026", cop: 50000, usdt: 15.71, note: "Aprovechar caídas (Bre-B)" },
    { id: 10, date: "29 Oct 2026", cop: 50000, usdt: 16.11, note: "Capital oportunidad PEPE" }
  ];

  const BOT_CYCLE_DEPOSITS = [
    { id: 7, date: "16 Oct 2026", cop: 50000, usdt: 15.72, note: "Inicio ciclo Spot Bot (PSE)" },
    { id: 8, date: "19 Oct 2026", cop: 50000, usdt: 15.71, note: "Ampliación Spot Bot (PSE)" },
    { id: 9, date: "22 Oct 2026", cop: 50000, usdt: 15.71, note: "Aprovechar caídas (Bre-B)" },
    { id: 10, date: "29 Oct 2026", cop: 50000, usdt: 16.11, note: "Capital oportunidad PEPE" }
  ];

  let savedDeposits = JSON.parse(localStorage.getItem("bot_custom_deposits") || "null");
  if (!savedDeposits || savedDeposits.length <= 4) {
    savedDeposits = LIFETIME_BINANCE_DEPOSITS;
    localStorage.setItem("bot_custom_deposits", JSON.stringify(savedDeposits));
  }
  let customDeposits = savedDeposits;

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


  // ---------- SISTEMA MODULAR DE PESTAÑAS (TABS NAVIGATION) ----------
  function initTabNavigation() {
    const tabBtns = document.querySelectorAll(".main-tab-btn");
    const tabContents = document.querySelectorAll(".tab-content");

    const savedTab = localStorage.getItem("cazador_active_tab") || "tab-spot";

    function switchTab(targetId) {
      tabBtns.forEach(btn => {
        if (btn.getAttribute("data-tab") === targetId) {
          btn.classList.add("active");
        } else {
          btn.classList.remove("active");
        }
      });
      tabContents.forEach(content => {
        if (content.id === targetId) {
          content.classList.add("active");
        } else {
          content.classList.remove("active");
        }
      });
      localStorage.setItem("cazador_active_tab", targetId);

      if (targetId === "tab-spot" && pnlChart) {
        try { pnlChart.resize(); } catch(e) {}
      }
      if (targetId === "tab-practice") {
        try { window.practiceSim?.onTabActivated?.(); } catch(e) {}
      }
    }

    tabBtns.forEach(btn => {
      btn.addEventListener("click", () => {
        const target = btn.getAttribute("data-tab");
        if (target) switchTab(target);
      });
    });

    switchTab(savedTab);
  }

  // ---------- ORQUESTADOR DE SESIONES & LIQUIDEZ ----------
  function renderSessionOrchestrator(d) {
    const sp = d.sessionPlan;
    const banner = $("session-orchestrator-banner");
    const pill = $("session-pill");
    if (!sp) {
      if (banner) banner.style.display = "none";
      if (pill) pill.style.display = "none";
      return;
    }

    if (banner) {
      banner.style.display = "block";
      const icon = sp.sessionKey === "NOCTURNO_DRENAJE" ? "🌙" : (sp.sessionKey === "LONDRES_REBOTE" ? "🏰" : (sp.sessionKey === "NY_IMPULSO" ? "🗽" : (sp.sessionKey === "COSECHA_PRENOCTURNA" ? "🌆" : "🔄")));
      setText($("session-icon"), icon);
      setText($("session-banner-title"), sp.sessionTitle);
      setText($("session-banner-reason"), sp.reason);
      setText($("session-reserved-val"), `${sp.reservedUsdt.toFixed(2)} USDT`);
      setText($("session-spendable-val"), `${sp.spendableUsdt.toFixed(2)} USDT`);
      setText($("session-banner-rec"), sp.recommendation);
    }

    if (pill) {
      pill.style.display = "inline-flex";
      const resText = sp.reservedUsdt > 0 ? `<b style="color:#fbbf24;margin-left:5px;">🔒 ${sp.reservedUsdt.toFixed(2)}</b>` : `<b style="color:#34d399;margin-left:5px;">🟢 100% Libre</b>`;
      pill.innerHTML = `<span>${sp.sessionTitle.split(" ")[0]} ${sp.sessionTitle.split(" ")[1] || ""}</span> ${resText}`;
      pill.title = `${sp.sessionTitle}\nReserva: ${sp.reservedUsdt.toFixed(2)} USDT | Disponible: ${sp.spendableUsdt.toFixed(2)} USDT\nFundamento: ${sp.reason}\nRecomendación: ${sp.recommendation}`;
    }
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
    if (d.recoveryTracker) {
      const pill = $("recovery-pill");
      if (pill) {
        const pct = Math.min(100, (d.recoveryTracker.recoveredUsdt / d.recoveryTracker.targetUsdt) * 100);
        pill.innerHTML = `🛡️ Recuperación: <b>${d.recoveryTracker.recoveredUsdt.toFixed(2)} / ${d.recoveryTracker.targetUsdt.toFixed(2)} USDT</b> (${pct.toFixed(0)}%)`;
      }
    }
    const pf = d.portfolio;
    if (pf.copRate || pf.copPerUsdt) {
      COP_PER_USDT = pf.copRate || pf.copPerUsdt;
    }
    setText($("kpi-total-usdt-num"), `${fmt(pf.totalEstimatedUsdt)}`);
    setText($("kpi-total-cop"), `≈ ${cop(pf.totalEstimatedCop)} COP (@ ${Math.round(COP_PER_USDT)} Binance)`);

    if (d.accountAvailable) {
      const spotFree = (pf.usdtFree || 0) + (pf.usdtEarn || 0);
      const isFutReal = d.futuresTelemetry?.state?.isSimulated === false;
      const futFree = d.futuresTelemetry?.futuresBalance || pf.usdtFutures || (isFutReal ? (d.futuresTelemetry?.stats?.virtualBalanceUsdt || 14.57) : 0);
      const totalLiquidCash = spotFree + (isFutReal ? futFree : 0);

      setText($("kpi-free-usdt-num"), `$${fmt(totalLiquidCash)}`);
      const breakdownEl = $("kpi-cash-breakdown");
      if (breakdownEl) {
        if (isFutReal) {
          breakdownEl.innerHTML = `Spot: <b>$${fmt(spotFree)}</b> | Futuros (Real): <b style="color:#34d399">$${fmt(futFree)} USDT</b>`;
        } else {
          breakdownEl.innerHTML = `Spot: <b>$${fmt(spotFree)} USDT</b> | Futuros: (Simulado)`;
        }
      }
    }
    const totalLots = pf.totalLotsCount || pf.openPositionsCount || 0;
    setText($("kpi-slots"), `Monedas: ${pf.openPositionsCount} / ${pf.maxSlots || 7} (${totalLots} lotes)`);

    const perf = d.performance;
    if (perf) {
      const s = perf.totalPnlUsdt >= 0 ? "+" : "";
      setText($("kpi-realized-pnl-num"), `${s}${fmt(perf.totalPnlUsdt, 3)}`);
      if (typeof perf.grossWinsUsdt === "number") {
        setText($("kpi-realized-cop"), `Bruto: +$${fmt(perf.grossWinsUsdt, 2)} | Ant: -$${fmt(Math.abs(perf.grossLossesUsdt || 0), 2)} (≈ ${s}$${cop(perf.totalPnlCop)} COP)`);
      } else {
        setText($("kpi-realized-cop"), `≈ ${s}$${cop(perf.totalPnlCop)} COP acumulados`);
      }
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
    const cardKey = p.id || (p.symbol + (p.lotIndex && p.lotIndex > 1 ? "_lot_" + p.lotIndex : ""));
    card.dataset.id = cardKey;
    card.dataset.symbol = p.symbol;
    card.innerHTML = `
      <div class="pos-head">
        <div class="coin-badge">
          <div class="coin-avatar">${p.base.substring(0, 4)}</div>
          <div>
            <div class="coin-name">${p.symbol} <span class="strat-pill logic" style="font-size:9px;margin-left:4px;" data-f="stratbadge"></span></div>
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

      <!-- Control de Marco de Velas (Timeframe) Dinámico -->
      <div class="pos-timeframe-box">
        <div class="pos-tf-header">
          <span class="pos-tf-title">⏱️ Marco de Velas</span>
          <span class="pos-tf-val" data-f="tfval">--</span>
        </div>
        <div class="pos-tf-sugg" data-f="tfsuggbox">
          <span data-f="tfsuggtext">💡 Viable ahora: --</span>
          <button class="btn-apply-tf-sugg" data-f="btnapplytf">⚡ Usar Sugerido</button>
        </div>
        <div class="pos-tf-pills" data-f="tfpills">
          <button class="tf-pill-btn" data-v="15m">15m</button>
          <button class="tf-pill-btn" data-v="1h">1H</button>
          <button class="tf-pill-btn" data-v="4h">4H</button>
        </div>
      </div>

      <!-- Control de Respiro Trailing (Callback) Dinámico -->
      <div class="pos-callback-box">
        <div class="pos-callback-header">
          <span class="pos-callback-title">🎯 Respiro Trailing (Callback Salida)</span>
          <span class="pos-callback-val" data-f="cbval">--%</span>
        </div>
        <div class="pos-callback-sugg" data-f="cbsuggbox">
          <span data-f="cbsuggtext">💡 Viable ahora: --%</span>
          <button class="btn-apply-cb-sugg" data-f="btnapplycb">⚡ Usar Sugerido</button>
        </div>
        <div class="pos-callback-pills" data-f="cbpills">
          <button class="cb-pill-btn" data-v="0.25">0.25%</button>
          <button class="cb-pill-btn" data-v="0.35">0.35%</button>
          <button class="cb-pill-btn" data-v="0.45">0.45%</button>
          <button class="cb-pill-btn" data-v="0.55">0.55%</button>
        </div>
      </div>

      <!-- Botón Asegurar Piso en Pico -->
      <div class="pos-lock-floor-box" data-f="lockfloorbox">
        <div>
          <div style="font-size:11px; font-weight:700; color:var(--accent-green); text-transform:uppercase; letter-spacing:0.5px;">🔒 Asegurar Pico</div>
          <div style="font-size:11px; color:var(--text-muted);" data-f="lockfloordesc">Sin piso amarrado</div>
        </div>
        <button class="btn-lock-floor" data-f="btnlockfloor">
          🔒 Asegurar Pico
        </button>
      </div>

      <!-- Botón Salida Manual (Vender Ahora) -->
      <div class="pos-manual-sell-box" style="margin-top:10px; display:flex; justify-content:space-between; align-items:center; padding:6px 12px; background:rgba(239, 68, 68, 0.06); border:1px solid rgba(239, 68, 68, 0.2); border-radius:8px;">
        <span style="font-size:11px; color:var(--text-muted);">Salida manual</span>
        <button class="btn-manual-sell" data-f="btnmanualsell" style="background:#ef4444; color:#fff; border:none; padding:5px 10px; border-radius:6px; font-size:11px; font-weight:700; cursor:pointer;">
          🛑 Vender Ahora
        </button>
      </div>

      <div class="pos-footer">
        <span class="pnl-label">Ganancia flotante</span>
        <div style="text-align:right">
          <div class="pnl-value" data-f="pnl"></div>
          <div class="pnl-cop" data-f="pnlcop"></div>
        </div>
      </div>`;
    card.addEventListener("click", async (e) => {
      const currentP = card._currentPos || p;

      // Click en botones de Timeframe
      const tfPillBtn = e.target.closest(".tf-pill-btn");
      const tfApplyBtn = e.target.closest(".btn-apply-tf-sugg");
      if (tfPillBtn || tfApplyBtn) {
        const targetTf = tfPillBtn ? tfPillBtn.dataset.v : currentP.suggestedTimeframe;
        if (!targetTf) return;
        try {
          const res = await fetch("/api/strategies/timeframe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ symbol: currentP.symbol, timeframe: targetTf })
          });
          const d = await res.json();
          if (d.success) {
            currentP.timeframe = targetTf;
            updatePositionCard(card, currentP);
            if (typeof showToast === "function") showToast(`⏱️ Marco de ${currentP.symbol} fijado en ${targetTf.toUpperCase()}`);
          }
        } catch(err) {
          console.error("Error setting timeframe:", err);
        }
        return;
      }

      // Click en botón Vender Ahora (Salida Manual con Alerta Estricta si está en pérdida)
      const manualSellBtn = e.target.closest(".btn-manual-sell");
      if (manualSellBtn) {
        const id = currentP.id || currentP.lotId || currentP.symbol;
        const currentGain = currentP.gainPct || 0;
        const pnlVal = currentP.pnlUsdt || 0;

        if (currentGain < 0 || pnlVal < 0) {
          // ALERTA DE SEGURIDAD ESTRICTA: VENTA EN PÉRDIDA
          const alertLossMsg = "⚠️ ALERTA DE SEGURIDAD - VENTA EN PÉRDIDA ⚠️\n\n" +
            "• Moneda: " + currentP.symbol + "\n" +
            "• Pérdida flotante: " + pnlVal.toFixed(2) + " USDT (" + currentGain.toFixed(2) + "%)\n\n" +
            "🛑 El bot tiene estrictamente PROHIBIDO vender a pérdida de forma automática para proteger tu capital.\n\n" +
            "¿Estás absolutamente seguro de que deseas forzar el cierre manual y asumir esta pérdida ahora?";
          
          if (!confirm(alertLossMsg)) return;
          if (!confirm("🚨 ÚLTIMA CONFIRMACIÓN:\n¿Confirmas que deseas ejecutar la venta en PÉRDIDA de " + currentP.symbol + "?")) return;

          try {
            const res = await fetch("/api/positions/manual-sell", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id, allowLoss: true })
            });
            const d = await res.json();
            if (d.success && typeof showToast === "function") {
              showToast("🛑 Venta en pérdida autorizada para " + currentP.symbol);
            }
          } catch(err) {
            console.error("Error ejecutando venta manual:", err);
          }
        } else {
          // Venta en ganancia
          const ok = confirm("🎯 ¿Deseas cerrar la posición de " + currentP.symbol + " en GANANCIA (+" + currentGain.toFixed(2) + "% / +" + pnlVal.toFixed(2) + " USDT) ahora mismo?");
          if (ok) {
            try {
              const res = await fetch("/api/positions/manual-sell", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id, allowLoss: false })
              });
              const d = await res.json();
              if (d.success && typeof showToast === "function") {
                showToast("🚀 Venta de " + currentP.symbol + " enviada.");
              }
            } catch(err) {
              console.error("Error ejecutando venta manual:", err);
            }
          }
        }
        return;
      }

      // Click en botón Asegurar Piso (Acción Rápida en Ganancia)
      const lockFloorBtn = e.target.closest(".btn-lock-floor");
      if (lockFloorBtn) {
        const id = currentP.id || currentP.lotId || currentP.symbol;
        const currentGain = currentP.gainPct || 0;
        const peakGain = currentP.peakGainPct || currentGain;
        // Si ya está en ganancia, sugerir exactamente la ganancia actual en vivo (mínimo 0.30% para cubrir comisiones)
        const suggestedLock = Math.max(0.30, Math.floor(currentGain * 100) / 100);

        const ok = confirm(`🔒 ¿Deseas asegurar la ganancia en +${suggestedLock.toFixed(2)}% para ${currentP.symbol}?\n\n• Ganancia actual en vivo: +${currentGain.toFixed(2)}%\n• Pico alcanzado: +${peakGain.toFixed(2)}%\n\n👉 Si el precio retrocede, venderá asegurando este +${suggestedLock.toFixed(2)}% neto en tu bolsillo.\n👉 Si sigue subiendo, ¡seguirá persiguiendo la cima con Trailing Take Profit!`);

        if (ok) {
          try {
            const res = await fetch("/api/positions/lock-profit", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id, symbol: currentP.symbol, targetGainPct: suggestedLock })
            });
            const d = await res.json();
            if (d.success) {
              currentP.lockedFloorGainPct = suggestedLock;
              updatePositionCard(card, currentP);
              if (typeof showToast === "function") showToast(`🔒 Piso de ${currentP.symbol} asegurado en +${suggestedLock.toFixed(2)}%`);
            }
          } catch(err) {
            console.error("Error locking profit floor:", err);
          }
        }
        return;
      }

      // Click en botones de Callback
      const pillBtn = e.target.closest(".cb-pill-btn");
      const applyBtn = e.target.closest(".btn-apply-cb-sugg");
      if (!pillBtn && !applyBtn) return;

      const targetVal = pillBtn ? parseFloat(pillBtn.dataset.v) : currentP.suggestedCallback;
      if (!targetVal) return;

      try {
        const res = await fetch("/api/strategies/callback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ symbol: currentP.symbol, callbackPct: targetVal })
        });
        const d = await res.json();
        if (d.success) {
          currentP.callbackPct = targetVal;
          currentP.isCustomCallback = true;
          updatePositionCard(card, currentP);
          if (typeof showToast === "function") showToast(`🎯 Callback de ${currentP.symbol} fijado en ${targetVal.toFixed(2)}%`);
        }
      } catch(err) {
        console.error("Error setting callback:", err);
      }
    });

    return card;
  }

  function updatePositionCard(card, p) {
    card._currentPos = p;
    const f = (k) => card.querySelector(`[data-f="${k}"]`);
    
    // Regla estricta de color:
    // Si pnlUsdt < -0.00001 o gainPct < -0.01 -> ES PÉRDIDA (ROJO)
    // Si pnlUsdt > 0.00001 o gainPct > 0.01 -> ES GANANCIA (VERDE)
    // De lo contrario -> NEUTRAL
    const isLoss = (p.pnlUsdt < -0.00001) || (p.gainPct < -0.01);
    const isGain = (p.pnlUsdt > 0.00001) || (p.gainPct > 0.01);

    const stratName = (p.isManual || p.strategy === "manual") ? "👤 Manual" : (p.strategy === "centinela_alpha" ? "🤖 Alpha (20%)" : (p.lotIndex > 1 ? `🛡️ Lote #${p.lotIndex}` : "🏹 Lote 1"));
    setText(f("stratbadge"), stratName);
    setText(f("qty"), `${fmt(p.qty)} ${p.base} • Invertido: ${fmt(p.investedUsdt)} USDT`);
    setText(f("buy"), `${fmt(p.buyPrice)}`);
    setText(f("cur"), `${fmt(p.curPrice)}`);
    setStyle(f("cur"), "color", isGain ? "var(--accent-green)" : (isLoss ? "var(--accent-rose)" : "var(--text-main)"));
    setText(f("target"), `${fmt(p.target08)}`);

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
      setText(f("proginfo"), `Pico ${fmt(p.highestPrice)} (+${p.peakGainPct.toFixed(2)}%) • Salida ${fmt(p.stopPrice)}`);
    } else {
      const falta = ((p.target08 - p.curPrice) / p.curPrice) * 100;
      setText(f("proginfo"), falta > 0 ? `Falta +${falta.toFixed(2)}%` : "Meta alcanzada");
    }

    // Formateo limpio blindado contra '+-'
    let pnlStr = fmt(p.pnlUsdt);
    if (isGain && !pnlStr.startsWith("+")) pnlStr = "+" + pnlStr;
    pnlStr = pnlStr.replace("+-", "-").replace("-+", "-");

    let pctStr = p.gainPct.toFixed(2);
    if (isGain && !pctStr.startsWith("+")) pctStr = "+" + pctStr;
    pctStr = pctStr.replace("+-", "-").replace("-+", "-");

    const pnl = f("pnl");
    setClass(pnl, "pnl-value " + (isGain ? "pos-profit" : (isLoss ? "pos-loss" : "")));
    setText(pnl, `${pnlStr} USDT (${pctStr}%)`);

    let copStr = cop(p.pnlCop);
    if (isGain) copStr = "+" + copStr;
    else if (isLoss && !copStr.startsWith("-")) copStr = "-" + copStr;
    copStr = copStr.replace("+-", "-").replace("-+", "-");
    setText(f("pnlcop"), `≈ ${copStr} COP`);

    // Regla de Visibilidad del Botón Asegurar Piso:
    // "si esta en negativo el boton no debe salir, es visible si es positivo"
    const lockBox = card.querySelector(".pos-lock-floor-box") || f("lockfloorbox");
    const gPct = typeof p.gainPct === "number" ? p.gainPct : 0;
    const pUsdt = typeof p.pnlUsdt === "number" ? p.pnlUsdt : 0;
    
    // POSITIVO: solo si la ganancia es mayor a +0.05% o PnL > $0.005
    const isStrictlyPositive = (gPct > 0.05) || (pUsdt > 0.005);

    if (lockBox) {
      if (!isStrictlyPositive) {
        // En negativo o breakeven: OCULTAR TOTALMENTE
        lockBox.classList.remove("is-positive");
        lockBox.style.setProperty("display", "none", "important");
      } else {
        // En positivo: MOSTRAR SIEMPRE
        lockBox.classList.add("is-positive");
        lockBox.style.setProperty("display", "flex", "important");

        const curGStr = "+" + gPct.toFixed(2) + "%";
        const hasFloor = p.lockedFloorGainPct && p.lockedFloorGainPct > 0;

        const descEl = f("lockfloordesc");
        const btnEl = f("btnlockfloor");

        if (hasFloor) {
          if (descEl) {
            descEl.textContent = "🛡️ Piso asegurado: +" + p.lockedFloorGainPct.toFixed(2) + "%";
            descEl.style.color = "var(--accent-green)";
          }
          if (btnEl) {
            if (gPct > p.lockedFloorGainPct) {
              btnEl.textContent = "🚀 Elevar Piso a " + curGStr;
              btnEl.title = "Piso actual +" + p.lockedFloorGainPct.toFixed(2) + "%. Pulsa para elevarlo a " + curGStr;
            } else {
              btnEl.textContent = "🔒 Modificar (+" + p.lockedFloorGainPct.toFixed(2) + "%)";
              btnEl.title = "Pulsa para ajustar el piso asegurado";
            }
            btnEl.style.background = "linear-gradient(135deg, #059669, #047857)";
          }
        } else {
          if (descEl) {
            descEl.textContent = "Ganancia actual: " + curGStr + " (Sin piso amarrado)";
            descEl.style.color = "var(--accent-green)";
          }
          if (btnEl) {
            btnEl.textContent = "🔒 Asegurar Pico (" + curGStr + ")";
            btnEl.title = "Pulsa para asegurar inmediatamente esta ganancia de " + curGStr + " sin esperar";
            btnEl.style.background = "linear-gradient(135deg, #10b981, #059669)";
          }
        }
      }
    }

    // Timeframe Dinámico y Sugerencia Centinela
    const tfVal = (p.timeframe || "1h").toLowerCase();
    const suggTf = (p.suggestedTimeframe || "1h").toLowerCase();
    const suggTfReason = p.suggestedTimeframeReason || "Velocidad analizada";

    setText(f("tfval"), `${tfVal.toUpperCase()} ${p.isTimeframeOptimal ? "(Óptimo)" : "(Personalizado)"}`);
    const tfSuggEl = f("tfsuggtext");
    if (tfSuggEl) {
      tfSuggEl.innerHTML = `💡 Viable ahora: <b>${suggTf.toUpperCase()}</b> <span style="opacity:0.8;font-size:10px;">(${suggTfReason})</span>`;
    }

    const btnApplyTf = f("btnapplytf");
    if (btnApplyTf) {
      if (tfVal === suggTf) {
        btnApplyTf.textContent = "✓ Óptimo";
        btnApplyTf.style.opacity = "0.5";
        btnApplyTf.style.pointerEvents = "none";
      } else {
        btnApplyTf.textContent = `⚡ Usar ${suggTf.toUpperCase()}`;
        btnApplyTf.style.opacity = "1";
        btnApplyTf.style.pointerEvents = "auto";
      }
    }

    card.querySelectorAll(".tf-pill-btn").forEach((btn) => {
      const v = btn.dataset.v.toLowerCase();
      if (v === tfVal) {
        btn.classList.add("active");
      } else {
        btn.classList.remove("active");
      }
    });

    // Callback Dinámico y Sugerencia Centinela
    const cbVal = p.callbackPct || 0.35;
    setText(f("cbval"), `${cbVal.toFixed(2)}% ${p.isCustomCallback ? "(Manual)" : "(Auto)"}`);

    const sugg = p.suggestedCallback || 0.35;
    const reason = p.suggestedReason || "Volatilidad analizada";
    const suggEl = f("cbsuggtext");
    if (suggEl) {
      suggEl.innerHTML = `💡 Viable ahora: <b>${sugg.toFixed(2)}%</b> <span style="opacity:0.8;font-size:10px;">(${reason})</span>`;
    }

    const btnApply = f("btnapplycb");
    if (btnApply) {
      if (Math.abs(cbVal - sugg) < 0.01) {
        btnApply.textContent = "✓ Calibrado";
        btnApply.style.opacity = "0.5";
        btnApply.style.pointerEvents = "none";
      } else {
        btnApply.textContent = `⚡ Usar ${sugg.toFixed(2)}%`;
        btnApply.style.opacity = "1";
        btnApply.style.pointerEvents = "auto";
      }
    }

    card.querySelectorAll(".cb-pill-btn").forEach((btn) => {
      const v = parseFloat(btn.dataset.v);
      if (Math.abs(v - cbVal) < 0.02) {
        btn.classList.add("active");
      } else {
        btn.classList.remove("active");
      }
    });
  }

  function renderPositions(list) {
    const box = $("positions-container");
    const empty = $("positions-empty");
    setText($("active-positions-count"), `${list.length} lote(s) activo(s)`);

    if (!list || list.length === 0) {
      box.innerHTML = "";
      setStyle(empty, "display", "block");
      return;
    }

    const existing = new Map();
    box.querySelectorAll(".position-card").forEach((c) => {
      const key = c.dataset.id;
      if (key && !existing.has(key)) {
        existing.set(key, c);
      } else {
        c.remove(); // Eliminar de inmediato tarjetas duplicadas de ciclos anteriores
      }
    });

    list.forEach((p) => {
      const cardKey = p.id || (p.symbol + (p.lotIndex && p.lotIndex > 1 ? "_lot_" + p.lotIndex : ""));
      let card = existing.get(cardKey);
      if (!card) {
        card = createPositionCard(p);
        box.appendChild(card);
      }
      updatePositionCard(card, p);
      existing.delete(cardKey);
    });

    existing.forEach((card) => card.remove());
    setStyle(empty, "display", "none");
  }

  // ---------- radar (reconciliación por símbolo + semáforo en vivo) ----------
  function renderRadar(list) {
    const tbody = $("radar-tbody");
    const existing = new Map();
    tbody.querySelectorAll("tr").forEach((r) => existing.set(r.dataset.symbol, r));

    const huntingCoins = (list || []).filter((r) => r.isHunting && r.huntingData);
    const liveBox = $("caceria-live-box");
    const liveCards = $("caceria-live-cards");
    const liveBadge = $("caceria-live-badge");

    if (liveBox && liveCards) {
      liveBox.style.display = "block";
      if (huntingCoins.length > 0) {
        if (liveBadge) {
          liveBadge.textContent = `🎯 ${huntingCoins.length} cazando piso`;
          liveBadge.style.color = "#34d399";
          liveBadge.style.borderColor = "rgba(16,185,129,0.3)";
          liveBadge.style.background = "rgba(16,185,129,0.18)";
        }
        liveCards.innerHTML = huntingCoins.map((r) => {
          const h = r.huntingData;
          const scoreColor = h.score >= 5 ? "#10b981" : (h.score >= 3 ? "#fbbf24" : "#f87171");
          const pctProgress = (h.score / 5) * 100;
          
          // Detect missing requirements for tactical label
          const missing = [];
          if (h.bounceStatus !== "green") missing.push(`Rebote (${(h.bouncePct || 0).toFixed(2)}% / +${(h.reqBouncePct || 0.35).toFixed(2)}%)`);
          if (h.candleStatus !== "green") missing.push("Vela 5m verde");
          if (h.cvdStatus !== "green") missing.push(`CVD ballenas (${(h.cvdRatio || 50).toFixed(0)}% / 50%)`);
          if (h.obiStatus !== "green") missing.push(`Libro Depth (${(h.obiRatio || 50).toFixed(0)}% / 42%)`);
          if (h.btcStatus !== "green") missing.push(`BTC ${h.btcDesc}`);

          return `<div style="background:rgba(15,23,42,0.92); border:1px solid ${h.score === 5 ? 'rgba(16,185,129,0.5)' : 'rgba(255,255,255,0.1)'}; border-radius:10px; padding:14px; display:flex; flex-direction:column; gap:10px; box-shadow:0 4px 14px rgba(0,0,0,0.35);">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <div style="display:flex; align-items:center; gap:8px;">
                <span style="font-size:18px;">🎯</span>
                <strong style="font-size:15px; color:#f8fafc; letter-spacing:0.02em;">${r.symbol.replace("USDT", "")} <span style="font-size:11px; color:#94a3b8; font-weight:normal;">/USDT</span></strong>
              </div>
              <span style="font-size:11px; font-weight:800; color:${scoreColor}; background:rgba(0,0,0,0.45); padding:3px 8px; border-radius:6px; border:1px solid ${scoreColor}55;">
                ${h.score}/5 Listo ${h.score === 5 ? '⚡ DISPARO' : ''}
              </span>
            </div>

            <!-- Barra de progreso visual -->
            <div style="height:6px; background:rgba(255,255,255,0.08); border-radius:3px; overflow:hidden;">
              <div style="width:${pctProgress}%; height:100%; background:linear-gradient(90deg, #f87171, #fbbf24, #34d399); transition:width 0.4s ease;"></div>
            </div>

            <!-- Precios clave -->
            <div style="display:grid; grid-template-columns: repeat(3, 1fr); gap:6px; font-size:11px; background:rgba(0,0,0,0.35); padding:8px 10px; border-radius:8px; border:1px solid rgba(255,255,255,0.05);">
              <div><span style="color:#64748b; display:block; font-size:10px;">PISO MÍN</span><b style="color:#e2e8f0;">$${fmt(r.lowestPrice)}</b></div>
              <div><span style="color:#64748b; display:block; font-size:10px;">ACTUAL</span><b style="color:#38bdf8;">$${fmt(r.curPrice)}</b></div>
              <div><span style="color:#64748b; display:block; font-size:10px;">DISPARO</span><b style="color:#34d399;">$${fmt(h.triggerPrice)}</b></div>
            </div>

            <!-- Semáforo de 5 Requisitos Institucionales -->
            <div style="display:flex; flex-direction:column; gap:5px;">
              <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(255,255,255,0.02); padding:4px 8px; border-radius:5px;">
                <span style="font-size:11px; color:#cbd5e1;">1. Rebote Suelo (+${(h.reqBouncePct || 0.35).toFixed(2)}%)</span>
                <span class="semaforo-pill ${h.bounceStatus}">
                  ${h.bounceStatus === 'green' ? '🟢 Cumplido' : (h.bounceStatus === 'orange' ? '🟠 En camino' : '🔴 En el suelo')} (+${(h.bouncePct || 0).toFixed(2)}%)
                </span>
              </div>
              <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(255,255,255,0.02); padding:4px 8px; border-radius:5px;">
                <span style="font-size:11px; color:#cbd5e1;">2. Vela 5m (Absorción)</span>
                <span class="semaforo-pill ${h.candleStatus}">
                  ${h.candleStatus === 'green' ? '🟢 Verde ▲' : (h.candleStatus === 'orange' ? '🟠 Doji ▬' : '🔴 Roja ▼')}
                </span>
              </div>
              <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(255,255,255,0.02); padding:4px 8px; border-radius:5px;">
                <span style="font-size:11px; color:#cbd5e1;">3. CVD Ballenas (≥ 50%)</span>
                <span class="semaforo-pill ${h.cvdStatus}">
                  ${h.cvdStatus === 'green' ? '🟢 Compras' : (h.cvdStatus === 'orange' ? '🟠 Neutral' : '🔴 Ventas')} ${(h.cvdRatio || 50).toFixed(0)}%
                </span>
              </div>
              <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(255,255,255,0.02); padding:4px 8px; border-radius:5px;">
                <span style="font-size:11px; color:#cbd5e1;">4. Libro Profundidad (≥ 42%)</span>
                <span class="semaforo-pill ${h.obiStatus}">
                  ${h.obiStatus === 'green' ? '🟢 Camino Libre' : (h.obiStatus === 'orange' ? '🟠 Equilibrado' : '🔴 Muro Venta')} ${(h.obiRatio || 50).toFixed(0)}%
                </span>
              </div>
              <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(255,255,255,0.02); padding:4px 8px; border-radius:5px;">
                <span style="font-size:11px; color:#cbd5e1;">5. Filtro Bitcoin</span>
                <span class="semaforo-pill ${h.btcStatus}">
                  ${h.btcStatus === 'green' ? '🟢 Estable' : (h.btcStatus === 'orange' ? '🟠 Corrección' : '🔴 En caída')} (${h.btcDesc})
                </span>
              </div>
            </div>

            <!-- Resumen táctico -->
            <div style="font-size:10px; color:${missing.length === 0 ? '#34d399' : '#94a3b8'}; background:rgba(0,0,0,0.25); padding:6px 8px; border-radius:6px; border-left:3px solid ${scoreColor};">
              ${missing.length === 0 
                ? '⚡ <b>¡TODOS LOS REQUISITOS LISTOS!</b> Disparando orden Spot...' 
                : `⏳ <b>Falta confirmar:</b> ${missing.join(', ')}.`}
            </div>
          </div>`;
        }).join("");
      } else {
        if (liveBadge) {
          liveBadge.textContent = "📡 0 cazando (Vigilancia 24/7)";
          liveBadge.style.color = "#94a3b8";
          liveBadge.style.borderColor = "rgba(255,255,255,0.12)";
          liveBadge.style.background = "rgba(255,255,255,0.05)";
        }
        liveCards.innerHTML = `<div style="grid-column:1 / -1; padding:18px 20px; background:rgba(15,23,42,0.65); border:1px dashed rgba(255,255,255,0.12); border-radius:8px; text-align:center;">
          <div style="font-size:13px; font-weight:700; color:#f1f5f9; margin-bottom:5px;">
            🎯 Modo Cacería Institucional en Espera de Oportunidad
          </div>
          <div style="font-size:11px; color:#94a3b8; max-width:680px; margin:0 auto; line-height:1.5;">
            El bot está escaneando las monedas del radar esperando una caída institucional. En el momento en que una moneda comience a perseguir el piso, aquí se activará en vivo su tarjeta con el <b>Semáforo de 5 Requisitos</b> (🟢 Cumplido, 🟠 Casi listo, 🔴 Bloqueado) y solo comprará cuando los 5 se tornen verdes.
          </div>
        </div>`;
      }
    }

    list.forEach((r) => {
      let row = existing.get(r.symbol);
      if (!row) {
        row = document.createElement("tr");
        row.dataset.symbol = r.symbol;
        row.innerHTML = `<td><strong>${r.symbol.replace("USDT", "")}</strong></td>
          <td data-f="price"></td><td data-f="drop"></td>
          <td><span data-f="rsi" class="rsi-pill rsi-neutral"></span></td><td data-f="status"></td>
          <td data-f="action" style="text-align: right;"></td>`;
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

      const statEl = f("status");
      if (r.isHunting && r.huntingData) {
        const h = r.huntingData;
        const scoreColor = h.score >= 4 ? "#34d399" : (h.score >= 2 ? "#fbbf24" : "#f87171");
        statEl.innerHTML = `<div style="display:flex; align-items:center; gap:5px; flex-wrap:wrap;">
          <span style="color:var(--accent-green); font-weight:700; font-size:0.75rem;">🎯 Cazando ($${fmt(r.lowestPrice)})</span>
          <span style="font-size:0.65rem; font-weight:700; color:${scoreColor}; background:rgba(0,0,0,0.3); padding:1px 5px; border-radius:3px;">${h.score}/5</span>
          <span class="semaforo-pill ${h.bounceStatus}">${h.bounceStatus === 'green' ? '🟢' : (h.bounceStatus === 'orange' ? '🟠' : '🔴')} Rebote</span>
          <span class="semaforo-pill ${h.candleStatus}">${h.candleStatus === 'green' ? '🟢' : (h.candleStatus === 'orange' ? '🟠' : '🔴')} Vela</span>
          <span class="semaforo-pill ${h.cvdStatus}">${h.cvdStatus === 'green' ? '🟢' : (h.cvdStatus === 'orange' ? '🟠' : '🔴')} CVD</span>
        </div>`;
      } else if (r.isHunting) {
        statEl.innerHTML = `<span style="color:var(--accent-green); font-weight:700;">🎯 Cazando piso ($${fmt(r.lowestPrice)})</span>`;
      } else if (r.dropPct != null && r.dropPct >= 1.5) {
        statEl.innerHTML = `<span style="color:var(--accent-blue);">🔻 Caída detectada</span>`;
      } else {
        statEl.innerHTML = `<span style="color:var(--text-dim);">📡 Escaneando</span>`;
      }

      const actEl = f("action");
      if (actEl) {
        actEl.innerHTML = `<button type="button" class="btn-radar-manual" onclick="window.openManualBuyModal('${r.symbol}', ${r.curPrice || 0}, ${r.rsi || 50}, ${r.dropPct || 0})" style="background: linear-gradient(135deg, #3b82f6, #1d4ed8); color: #fff; border: 1px solid rgba(255,255,255,0.2); padding: 5px 11px; border-radius: 6px; font-size: 0.72rem; font-weight: 700; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; box-shadow: 0 2px 6px rgba(37,99,235,0.3); transition: transform 0.15s;"><span>⚡ Operar</span></button>`;
      }
    });
    latestRadarList = list || [];
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
      const isWin = (c.pnlUsdt || 0) > 0.0001;
      const isLoss = (c.pnlUsdt || 0) < -0.0001;
      let pnlStr = fmt(c.pnlUsdt, 3);
      if (isWin && !pnlStr.startsWith("+")) pnlStr = "+" + pnlStr;
      pnlStr = pnlStr.replace("+-", "-").replace("-+", "-");
      let pctStr = (c.pnlPct || 0).toFixed(2);
      if (isWin && !pctStr.startsWith("+")) pctStr = "+" + pctStr;
      pctStr = pctStr.replace("+-", "-").replace("-+", "-");
      const cls = isWin ? "pos-profit" : (isLoss ? "pos-loss" : "");
      return `<tr>
        <td style="color:var(--text-dim)">${i + 1}</td>
        <td><strong>${c.symbol.replace("USDT", "")}</strong></td>
        <td style="color:var(--text-dim)">${d}</td>
        <td>${fmt(c.avgBuy)}</td><td>${fmt(c.avgSell)}</td>
        <td class="${cls}"><strong>${pnlStr} USDT</strong></td>
        <td class="${cls}">${pctStr}%</td>
        <td><span class="win-tag">${isWin ? "GANADO" : (isLoss ? "PÉRDIDA" : "BREAKEVEN")}</span></td></tr>`;
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
    const sF = parseInt(document.getElementById("slider-futures")?.value || "0", 10);

    const sum = sT + sD + sG + sW + sF;
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

  async function saveAllocations(t, d, g, w, f) {
    try {
      if (f === undefined) f = parseInt(document.getElementById("slider-futures")?.value || "0", 10);
      const payload = { trailing: t, dca: d, grid: g, weekend: w, futures: f };
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
          if (badgeSl) badgeSl.textContent = `🛡️ Rescate DCA -${parseFloat(sliderSl.value).toFixed(1)}%`;
        });

        sliderSl.addEventListener("change", async () => {
          await updateModuleSettings(strat, { stopLossPct: parseFloat(sliderSl.value) });
        });
      }

      if (toggleSl) {
        toggleSl.addEventListener("change", async () => {
          if (badgeSl) {
            badgeSl.style.opacity = toggleSl.checked ? "1" : "0.4";
            badgeSl.textContent = toggleSl.checked ? `🛡️ Rescate DCA -${parseFloat(sliderSl.value).toFixed(1)}%` : "🛡️ 0% Venta en Rojo";
          }
          await updateModuleSettings(strat, { stopLossEnabled: toggleSl.checked });
        });
      }

      // 3. Bot Suggestion Buttons per strategy (Apply, Reject, Undo)
      const btnApply = document.getElementById(`btn-apply-${short}`);
      if (btnApply) {
        btnApply.addEventListener("click", async () => {
          await applyBotSuggestion(strat, btnApply);
        });
      }

      const btnReject = document.getElementById(`btn-reject-${short}`);
      if (btnReject) {
        btnReject.addEventListener("click", async () => {
          await rejectBotSuggestion(strat, btnReject);
        });
      }

      const btnUndo = document.querySelector(`.btn-undo-sugg[data-strat="${strat}"]`);
      if (btnUndo) {
        btnUndo.addEventListener("click", async () => {
          await undoRejectBotSuggestion(strat);
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
          btn.textContent = "✅ ¡Sincronizado!";
          btn.classList.add("applied");
        }
        fetchStrategies();
      }
    } catch(e) {
      if (btn) btn.textContent = "⚠️ Error";
    }
  }

  async function rejectBotSuggestion(strategy, btn) {
    try {
      if (btn) btn.textContent = "⏳ Descartando…";
      const res = await fetch("/api/strategies/reject-suggestion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ strategy })
      });
      if (res.ok) {
        fetchStrategies();
      }
    } catch(e) {
      if (btn) btn.textContent = "⚠️ Error";
    }
  }

  async function undoRejectBotSuggestion(strategy) {
    try {
      const res = await fetch("/api/strategies/undo-reject-suggestion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ strategy })
      });
      if (res.ok) {
        fetchStrategies();
      }
    } catch(e) {}
  }

  function syncModularStrategyControls(controls) {
    if (!controls) return;
    const settings = controls.strategySettings || {};
    const suggestions = controls.suggestions || {};
    const rejectedSuggestions = controls.rejectedSuggestions || {};

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
        if (badgeSl) badgeSl.textContent = `🛡️ Rescate DCA -${parseFloat(s.stopLossPct).toFixed(1)}%`;
      }
      if (s.stopLossEnabled !== undefined && toggleSl) {
        toggleSl.checked = s.stopLossEnabled;
        if (badgeSl) {
          badgeSl.style.opacity = s.stopLossEnabled ? "1" : "0.4";
          if (!s.stopLossEnabled) badgeSl.textContent = "🛡️ 0% Venta en Rojo";
        }
      }

      // Sync Suggestion Lifecycle (Dynamic: Synchronized / Actionable / Rejected)
      const isRejected = !!(rejectedSuggestions[strat] && rejectedSuggestions[strat] > Date.now());
      const suggBox = document.getElementById(`sugg-box-${short}`);
      const textSugg = document.getElementById(`sugg-text-${short}`);
      const critBox = document.getElementById(`sugg-criteria-${short}`);
      const whyBox = document.getElementById(`sugg-why-${short}`);
      const actionsBox = document.getElementById(`sugg-actions-${short}`);
      const rejectedMsg = document.getElementById(`sugg-rejected-${short}`);
      const tagBadge = document.getElementById(`sugg-tag-${short}`);
      const btnApply = document.getElementById(`btn-apply-${short}`);
      const btnReject = document.getElementById(`btn-reject-${short}`);

      if (isRejected) {
        if (rejectedMsg) rejectedMsg.style.display = "flex";
        if (actionsBox) actionsBox.style.display = "none";
        if (critBox) critBox.style.display = "none";
        if (whyBox) whyBox.style.display = "none";
        if (textSugg) textSugg.textContent = "Sugerencia descartada por el usuario (silenciada).";
        if (tagBadge) {
          tagBadge.textContent = "⚪ Rechazada";
          tagBadge.className = "sugg-status-tag rejected";
        }
        if (suggBox) suggBox.classList.remove("is-synced");
      } else if (sugg) {
        if (rejectedMsg) rejectedMsg.style.display = "none";
        if (critBox) critBox.style.display = "flex";
        if (whyBox) whyBox.style.display = "block";
        if (actionsBox) actionsBox.style.display = "flex";

        if (textSugg && sugg.reason) {
          textSugg.textContent = sugg.reason;
        }
        if (critBox && sugg.criterios && sugg.criterios.length) {
          critBox.innerHTML = sugg.criterios.map(c => `<div class="sugg-criteria-item">🔹 ${c}</div>`).join("");
        }
        if (whyBox && sugg.porQue) {
          whyBox.innerHTML = `<strong>¿Por qué?:</strong> ${sugg.porQue}`;
        }

        const isCurrent = (s.timeframe === sugg.timeframe);
        if (isCurrent) {
          // Estrategia ya está sintonizada y en su estado óptimo para el régimen de mercado actual
          if (suggBox) suggBox.classList.add("is-synced");
          if (tagBadge) {
            tagBadge.textContent = "🟢 Óptima";
            tagBadge.className = "sugg-status-tag synced";
          }
          if (btnApply) {
            btnApply.disabled = true;
            btnApply.textContent = `✅ Parámetros Óptimos (${s.timeframe.toUpperCase()})`;
            btnApply.classList.add("applied");
          }
          if (btnReject) {
            btnReject.style.display = "none";
          }
        } else {
          // Hay una recomendación de cambio pendiente
          if (suggBox) suggBox.classList.remove("is-synced");
          if (tagBadge) {
            tagBadge.textContent = "⚡ Cambio Sugerido";
            tagBadge.className = "sugg-status-tag pending";
          }
          if (btnApply) {
            btnApply.disabled = false;
            btnApply.textContent = `⚡ Aplicar Cambio a ${sugg.timeframe.toUpperCase()}`;
            btnApply.classList.remove("applied");
          }
          if (btnReject) {
            btnReject.style.display = "inline-flex";
            btnReject.textContent = "❌ Rechazar";
          }
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
    badgeStatus.className = "risk-badge-active";
    badgeStatus.textContent = `🛡️ Escudo Cero Pérdidas Activo (Umbral DCA -${parseFloat(pct).toFixed(1)}%)`;
    badgeStatus.style.background = "rgba(16, 185, 129, 0.15)";
    badgeStatus.style.color = "#34D399";
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
      const tFutures = document.getElementById("toggle-futures");
      const tWideGap = document.getElementById("toggle-widegap") || document.getElementById("toggle-wide-gap");
      const tAuto = document.getElementById("toggle-autopilot");
      const modeLabel = document.getElementById("mode-label");

      const cardTrailing = document.getElementById("card-strat-trailing");
      const cardDca = document.getElementById("card-strat-dca");
      const cardGrid = document.getElementById("card-strat-grid");
      const cardWeekend = document.getElementById("card-strat-weekend");
      const cardWideGap = document.getElementById("card-strat-widegap");
      const cardFutures = document.getElementById("card-strat-futures");

      if (tTrailing && !tTrailing.matches(":focus")) tTrailing.checked = !!s.trailing_rebound;
      if (tDca && !tDca.matches(":focus")) tDca.checked = !!s.smart_dca;
      if (tGrid && !tGrid.matches(":focus")) tGrid.checked = !!s.micro_grid;
      if (tWeekend && !tWeekend.matches(":focus")) tWeekend.checked = !!s.cazador_weekend;
      if (tFutures && !tFutures.matches(":focus")) tFutures.checked = !!s.futures;
      if (tWideGap && !tWideGap.matches(":focus")) tWideGap.checked = s.wide_gap_sniper !== false;

      if (cardTrailing) cardTrailing.classList.toggle("active-strat", !!s.trailing_rebound);
      if (cardDca) cardDca.classList.toggle("active-strat", !!s.smart_dca);
      if (cardGrid) cardGrid.classList.toggle("active-strat", !!s.micro_grid);
      if (cardWeekend) cardWeekend.classList.toggle("active-strat", !!s.cazador_weekend);
      if (cardWideGap) cardWideGap.classList.toggle("active-strat", s.wide_gap_sniper !== false);
      if (cardFutures) cardFutures.classList.toggle("active-strat", !!s.futures);

      const wideAmountInput = document.getElementById("input-widegap-amount");
      if (wideAmountInput && !wideAmountInput.matches(":focus")) {
        wideAmountInput.value = c.wideGapLotSize || 50;
      }
      const wideAllocLabel = document.getElementById("alloc-widegap-amount");
      if (wideAllocLabel) {
        wideAllocLabel.textContent = (c.wideGapLotSize || 50) + ".00 USDT / trade";
      }
      const wideStatusLabel = document.getElementById("lbl-widegap-status");
      if (wideStatusLabel) {
        wideStatusLabel.textContent = s.wide_gap_sniper !== false ? `Activo ($${c.wideGapLotSize || 50})` : "Desactivado";
      }

      const isWeekendMode = !!data.weekendMode;

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
        const sF = document.getElementById("slider-futures");
        const baseF = base.futures ?? a.futures ?? 0;
        if (sF) { sF.value = baseF; const fVal = document.getElementById("slider-futures-val"); if (fVal) fVal.textContent = baseF + "%"; }
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
  async function toggleStrategy(key, isAutoPilot = false, explicitState = null) {
    try {
      let payload;
      if (isAutoPilot) {
        payload = { autoPilot: document.getElementById("toggle-autopilot").checked };
      } else {
        payload = { strategy: key };
        if (typeof explicitState === "boolean") {
          payload.enabled = explicitState;
        }
      }
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
      const t = parseInt(sT?.value || "0", 10);
      const d = parseInt(sD?.value || "0", 10);
      const g = parseInt(sG?.value || "0", 10);
      const w = parseInt(sW?.value || "0", 10);
      const f = parseInt(document.getElementById("slider-futures")?.value || "0", 10);
      saveAllocations(t, d, g, w, f);
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

    document.getElementById("toggle-trailing")?.addEventListener("change", (e) => toggleStrategy("trailing_rebound", false, e.target.checked));
    document.getElementById("toggle-dca")?.addEventListener("change", (e) => toggleStrategy("smart_dca", false, e.target.checked));
    document.getElementById("toggle-grid")?.addEventListener("change", (e) => toggleStrategy("micro_grid", false, e.target.checked));
    document.getElementById("toggle-weekend")?.addEventListener("change", (e) => toggleStrategy("cazador_weekend", false, e.target.checked));
    document.getElementById("toggle-wide-gap")?.addEventListener("change", (e) => toggleStrategy("wide_gap_sniper", false, e.target.checked));
    document.getElementById("toggle-widegap")?.addEventListener("change", (e) => toggleStrategy("wide_gap_sniper", false, e.target.checked));
    document.getElementById("toggle-futures")?.addEventListener("change", (e) => toggleStrategy("futures", false, e.target.checked));

    document.getElementById("btn-save-widegap-amount")?.addEventListener("click", async () => {
      const val = parseInt(document.getElementById("input-widegap-amount")?.value || "50", 10);
      try {
        await fetch("/api/strategies/toggle", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ wideGapLotSize: val })
        });
        alert(`✅ Presupuesto de Cazador de Brechas actualizado a $${val} USDT.`);
      } catch (err) {
        alert("Error guardando presupuesto: " + err.message);
      }
    });

    const sF = document.getElementById("slider-futures");
    if (sF) {
      sF.addEventListener("input", () => {
        userHasUnsavedBudgetChanges = true;
        document.getElementById("slider-futures-val").textContent = sF.value + "%";
        updateBudgetSum();
      });
    }
    document.getElementById("toggle-autopilot")?.addEventListener("change", () => toggleStrategy(null, true));

    document.getElementById("btn-opp-approve")?.addEventListener("click", () => handleOpportunityAction("approve"));
    document.getElementById("btn-opp-ignore")?.addEventListener("click", () => handleOpportunityAction("ignore"));

  // ---------- Control de Modo Compacto & Acordeones ----------
  function initCompactUI() {
    const compactBtn = document.getElementById("btn-toggle-compact-view");
    const container = document.body;

    // Cargar preferencia guardada (por defecto modo compacto = true para máxima limpieza visual)
    const savedCompact = localStorage.getItem("dashboard_compact_mode");
    const isCompact = savedCompact !== "false";
    if (isCompact) {
      container.classList.add("compact-mode");
      if (compactBtn) {
        compactBtn.classList.add("active");
        compactBtn.innerHTML = "📦 Modo Compacto: <b>ACTIVO</b>";
      }
    } else {
      container.classList.remove("compact-mode");
      if (compactBtn) {
        compactBtn.classList.remove("active");
        compactBtn.innerHTML = "📖 Vista Detallada";
      }
    }

    compactBtn?.addEventListener("click", () => {
      const active = container.classList.toggle("compact-mode");
      localStorage.setItem("dashboard_compact_mode", active ? "true" : "false");
      if (active) {
        compactBtn.classList.add("active");
        compactBtn.innerHTML = "📦 Modo Compacto: <b>ACTIVO</b>";
        document.querySelectorAll(".strategy-details-section.open").forEach(el => el.classList.remove("open"));
        document.querySelectorAll(".btn-card-toggle.open").forEach(btn => {
          btn.classList.remove("open");
          btn.innerHTML = "👁️ Info ▾";
        });
        document.querySelectorAll(".sugg-expandable.open").forEach(el => el.classList.remove("open"));
        document.querySelectorAll(".btn-toggle-sugg.open").forEach(btn => {
          btn.classList.remove("open");
          btn.innerHTML = "🔍 Fundamentos ▾";
        });
      } else {
        compactBtn.classList.remove("active");
        compactBtn.innerHTML = "📖 Vista Detallada";
        document.querySelectorAll(".strategy-details-section").forEach(el => el.classList.add("open"));
        document.querySelectorAll(".btn-card-toggle").forEach(btn => {
          btn.classList.add("open");
          btn.innerHTML = "👁️ Ocultar ▴";
        });
      }
    });

    document.addEventListener("click", (e) => {
      const cardBtn = e.target.closest(".btn-card-toggle");
      if (cardBtn) {
        const card = cardBtn.closest(".strategy-item");
        const details = card?.querySelector(".strategy-details-section");
        if (details) {
          const isOpen = details.classList.toggle("open");
          cardBtn.classList.toggle("open", isOpen);
          cardBtn.innerHTML = isOpen ? "👁️ Ocultar ▴" : "👁️ Info ▾";
        }
        return;
      }

      const suggBtn = e.target.closest(".btn-toggle-sugg");
      if (suggBtn) {
        const suggBox = suggBtn.closest(".strat-sugg-box");
        const expandable = suggBox?.querySelector(".sugg-expandable");
        if (expandable) {
          const isOpen = expandable.classList.toggle("open");
          suggBtn.classList.toggle("open", isOpen);
          suggBtn.innerHTML = isOpen ? "🔍 Fundamentos ▴" : "🔍 Fundamentos ▾";
        }
        return;
      }
    });
  }

    initCompactUI();
    initAutonomousStrategyControls();

  // Controladores Sincronizados de Futuros (Card en Pestaña 1 y Laboratorio en Pestaña 3)
  const labModeSim = document.getElementById("lab-fut-mode-sim");
  const labModeReal = document.getElementById("lab-fut-mode-real");
  const labCapital = document.getElementById("lab-fut-capital");
  const labMargin = document.getElementById("lab-fut-margin");
  const labLev = document.getElementById("lab-fut-lev");
  const labSl = document.getElementById("lab-fut-sl");
  const labTp = document.getElementById("lab-fut-tp");
  const labSaveBtn = document.getElementById("lab-btn-save-cfg");
  const labResetBtn = document.getElementById("lab-btn-reset-custom") || document.getElementById("lab-btn-reset-100");

  const btnModeSim = document.getElementById("btn-fut-mode-sim");
  const btnModeReal = document.getElementById("btn-fut-mode-real");
  const inputFutCapital = document.getElementById("input-fut-capital");
  const inputFutMargin = document.getElementById("input-fut-margin");
  const selectFutLev = document.getElementById("select-fut-lev");
  const inputFutSl = document.getElementById("input-fut-sl");
  const inputFutTp = document.getElementById("input-fut-tp");
  const btnSaveFutCfg = document.getElementById("btn-save-fut-config");
  const btnResetFutCustom = document.getElementById("btn-reset-fut-custom") || document.getElementById("btn-reset-fut-100");

  function syncFuturesInputs(source) {
    if (source === "card") {
      if (labCapital && inputFutCapital) labCapital.value = inputFutCapital.value;
      if (labMargin && inputFutMargin) labMargin.value = inputFutMargin.value;
      if (labLev && selectFutLev) labLev.value = selectFutLev.value;
      if (labSl && inputFutSl) labSl.value = inputFutSl.value;
      if (labTp && inputFutTp) labTp.value = inputFutTp.value;
    } else if (source === "lab") {
      if (inputFutCapital && labCapital) inputFutCapital.value = labCapital.value;
      if (inputFutMargin && labMargin) inputFutMargin.value = labMargin.value;
      if (selectFutLev && labLev) selectFutLev.value = labLev.value;
      if (inputFutSl && labSl) inputFutSl.value = labSl.value;
      if (inputFutTp && labTp) inputFutTp.value = labTp.value;
    }
  }

  function setFuturesModeUI(isSim) {
    // UI Card
    if (btnModeSim && btnModeReal) {
      if (isSim) {
        btnModeSim.style.background = "#8b5cf6";
        btnModeSim.style.color = "#fff";
        btnModeReal.style.background = "transparent";
        btnModeReal.style.color = "#94a3b8";
      } else {
        btnModeReal.style.background = "#f59e0b";
        btnModeReal.style.color = "#000";
        btnModeSim.style.background = "transparent";
        btnModeSim.style.color = "#94a3b8";
      }
    }
    // UI Lab
    if (labModeSim && labModeReal) {
      if (isSim) {
        labModeSim.style.background = "#8b5cf6";
        labModeSim.style.color = "#fff";
        labModeReal.style.background = "transparent";
        labModeReal.style.color = "#94a3b8";
      } else {
        labModeReal.style.background = "#f59e0b";
        labModeReal.style.color = "#000";
        labModeSim.style.background = "transparent";
        labModeSim.style.color = "#94a3b8";
      }
    }
  }

  async function executeFuturesConfigChange(isSim, margin, capital, levMode, sl, tp, isReset = false) {
    try {
      const isEnabled = document.getElementById("toggle-futures")?.checked ?? true;
      const payload = {
        isSimulated: isSim,
        marginPerTrade: margin,
        startingBalance: capital,
        leverageMode: levMode,
        stopLossPct: sl,
        trailingTriggerPct: tp,
        reset: isReset,
        enabled: isEnabled
      };
      const res = await fetch("/api/futures/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.success) {
        setFuturesModeUI(isSim);
        if (!isReset) {
          if (labSaveBtn) {
            labSaveBtn.textContent = "✅ ¡Parámetros Guardados!";
            setTimeout(() => labSaveBtn.textContent = "💾 Guardar Parámetros", 2000);
          }
          if (btnSaveFutCfg) {
            btnSaveFutCfg.textContent = "✅ ¡Guardado!";
            setTimeout(() => btnSaveFutCfg.textContent = "💾 Guardar Parámetros", 2000);
          }
        }
        // Actualizar visualmente capital inicial y balance de inmediato
        const initEl = document.getElementById("fut-dev-init-capital");
        const curEl = document.getElementById("fut-dev-cur-balance");
        const realPnlEl = document.getElementById("fut-dev-realized-pnl");
        const floatPnlEl = document.getElementById("fut-dev-floating-pnl");
        const wrEl = document.getElementById("fut-dev-winrate");
        if (initEl) initEl.textContent = "$" + capital.toFixed(2) + " USDT";
        if (curEl && isSim) curEl.textContent = "$" + capital.toFixed(2) + " USDT";
        if (isReset) {
          if (realPnlEl) { realPnlEl.textContent = "+0.000 USDT"; realPnlEl.style.color = "#34d399"; }
          if (floatPnlEl) { floatPnlEl.textContent = "$0.00 USDT"; floatPnlEl.style.color = "#c4b5fd"; }
          if (wrEl) wrEl.textContent = "0.0% (0W / 0L)";
          const liveStat = document.getElementById("futures-live-status");
          if (liveStat) {
            liveStat.innerHTML = `💼 Balance: <b>$${capital.toFixed(2)} USDT</b> | PnL Hoy: <b>+0.000 USDT</b> | Win Rate: <b>0.0% (0W / 0L)</b> | Posiciones: <b>0 / 3</b>`;
          }
          const posTb = document.getElementById("fut-dev-positions-tbody");
          if (posTb) posTb.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:18px; color:var(--text-muted);">Sin posiciones abiertas. El escáner está buscando el siguiente piso/techo…</td></tr>';
          const tradeTb = document.getElementById("fut-dev-trades-tbody");
          if (tradeTb) tradeTb.innerHTML = '<tr><td colspan="10" style="text-align:center; padding:18px; color:var(--text-muted);">Aún no hay operaciones cerradas. Las posiciones vivas están persiguiendo el pico de ganancia.</td></tr>';
        }
      }
    } catch(e) {
      console.error("Error guardando futuros:", e);
    }
  }

  function handleModeChange(targetSim) {
    if (targetSim) {
      setFuturesModeUI(true);
      const cap = parseFloat(inputFutCapital?.value || labCapital?.value || "10");
      const marg = parseFloat(inputFutMargin?.value || labMargin?.value || "2.5");
      const lev = selectFutLev?.value || labLev?.value || "fixed_3";
      const sl = parseFloat(inputFutSl?.value || labSl?.value || "1.5");
      const tp = parseFloat(inputFutTp?.value || labTp?.value || "1.8");
      executeFuturesConfigChange(true, marg, cap, lev, sl, tp);
    } else {
      const margVal = inputFutMargin?.value || labMargin?.value || "2.5";
      const ok = confirm("⚠️ ATENCIÓN: Vas a activar el modo REAL de Futuros en Binance.\n\nEl bot operará con dinero real a través de tu cuenta con margen de " + margVal + " USDT por orden.\n\n¿Deseas activar el modo REAL?");
      if (ok) {
        setFuturesModeUI(false);
        const cap = parseFloat(inputFutCapital?.value || labCapital?.value || "10");
        const marg = parseFloat(inputFutMargin?.value || labMargin?.value || "2.5");
        const lev = selectFutLev?.value || labLev?.value || "fixed_3";
        const sl = parseFloat(inputFutSl?.value || labSl?.value || "1.5");
        const tp = parseFloat(inputFutTp?.value || labTp?.value || "1.8");
        executeFuturesConfigChange(false, marg, cap, lev, sl, tp);
      }
    }
  }

  // Eventos Modo Simulado / Real (Card y Lab)
  btnModeSim?.addEventListener("click", () => handleModeChange(true));
  labModeSim?.addEventListener("click", () => handleModeChange(true));
  btnModeReal?.addEventListener("click", () => handleModeChange(false));
  labModeReal?.addEventListener("click", () => handleModeChange(false));

  // Eventos Guardar Parámetros (Card y Lab)
  btnSaveFutCfg?.addEventListener("click", () => {
    syncFuturesInputs("card");
    const isSim = btnModeReal ? btnModeReal.style.background !== "rgb(245, 158, 11)" : true;
    executeFuturesConfigChange(
      isSim,
      parseFloat(inputFutMargin?.value || "2.5"),
      parseFloat(inputFutCapital?.value || "10"),
      selectFutLev?.value || "fixed_3",
      parseFloat(inputFutSl?.value || "1.5"),
      parseFloat(inputFutTp?.value || "1.8")
    );
  });

  labSaveBtn?.addEventListener("click", () => {
    syncFuturesInputs("lab");
    const isSim = labModeReal ? labModeReal.style.background !== "rgb(245, 158, 11)" : true;
    executeFuturesConfigChange(
      isSim,
      parseFloat(labMargin?.value || "2.5"),
      parseFloat(labCapital?.value || "10"),
      labLev?.value || "fixed_3",
      parseFloat(labSl?.value || "1.5"),
      parseFloat(labTp?.value || "1.8")
    );
  });

  // Evento Reset (Card y Lab)
  async function handleResetAction(source) {
    syncFuturesInputs(source);
    const curCap = parseFloat((source === "card" ? inputFutCapital?.value : labCapital?.value) || "10");
    const curMarg = parseFloat((source === "card" ? inputFutMargin?.value : labMargin?.value) || "2.5");
    const curLev = (source === "card" ? selectFutLev?.value : labLev?.value) || "fixed_3";
    const curSl = parseFloat((source === "card" ? inputFutSl?.value : labSl?.value) || "1.5");
    const curTp = parseFloat((source === "card" ? inputFutTp?.value : labTp?.value) || "1.8");
    const ok = confirm(`¿Deseas BORRAR todo el historial de trades y reiniciar la simulación con $${curCap.toFixed(2)} USDT limpios y margen de $${curMarg.toFixed(2)} USDT por trade?`);
    if (ok) {
      if (btnResetFutCustom) btnResetFutCustom.textContent = "⏳ Reiniciando...";
      if (labResetBtn) labResetBtn.textContent = "⏳ Reiniciando...";
      await executeFuturesConfigChange(true, curMarg, curCap, curLev, curSl, curTp, true);
      if (btnResetFutCustom) {
        btnResetFutCustom.textContent = `✅ ¡Iniciado en $${curCap}!`;
        setTimeout(() => btnResetFutCustom.textContent = "🧹 Reiniciar Registros & Balance", 2500);
      }
      if (labResetBtn) {
        labResetBtn.textContent = `✅ ¡Iniciado en $${curCap}!`;
        setTimeout(() => labResetBtn.textContent = "🧹 Reiniciar Registros & Balance", 2500);
      }
    }
  }

  btnResetFutCustom?.addEventListener("click", () => handleResetAction("card"));
  labResetBtn?.addEventListener("click", () => handleResetAction("lab"));

  }, 1000);

  // Renderizar Telemetría del Laboratorio de Futuros (Modo Dev)
  function renderFuturesTelemetry(fut) {
    if (!fut) return;

    // A. Estadísticas Globales
    const stats = fut.stats || {};
    const st = fut.state || {};

    // Sincronizar botones de modo (Simulado vs Real)
    setFuturesModeUI(st.isSimulated !== false);

    const isRealMode = st.isSimulated === false;
    const modeBadge = document.getElementById("fut-dev-mode-badge");
    if (modeBadge) {
      if (isRealMode) {
        modeBadge.textContent = "🔥 DINERO REAL (FONDOS EN BINANCE)";
        modeBadge.style.background = "rgba(16, 185, 129, 0.25)";
        modeBadge.style.color = "#34d399";
        modeBadge.style.borderColor = "rgba(16, 185, 129, 0.5)";
      } else {
        modeBadge.textContent = "🧪 MODO DEV / SIMULACIÓN";
        modeBadge.style.background = "rgba(139, 92, 246, 0.25)";
        modeBadge.style.color = "#c4b5fd";
        modeBadge.style.borderColor = "rgba(139, 92, 246, 0.4)";
      }
    }

    const titleEl = document.getElementById("fut-dev-cur-balance-title");
    if (titleEl) {
      titleEl.textContent = isRealMode ? "Saldo Real en Binance" : "Balance Simulado";
    }

    // Inputs en Laboratorio (Pestaña 3)
    if (labCapital && !labCapital.matches(":focus") && !labCapital.dataset.userEdited && st.startingBalanceUsdt) {
      labCapital.value = st.startingBalanceUsdt;
    }
    if (labMargin && !labMargin.matches(":focus") && !labMargin.dataset.userEdited && st.defaultMarginPerTrade) {
      labMargin.value = st.defaultMarginPerTrade;
    }
    if (labSl && !labSl.matches(":focus") && !labSl.dataset.userEdited && st.stopLossPct) {
      labSl.value = st.stopLossPct;
    }
    if (labTp && !labTp.matches(":focus") && !labTp.dataset.userEdited && st.trailingTriggerPct) {
      labTp.value = st.trailingTriggerPct;
    }
    if (labLev && !labLev.matches(":focus") && !labLev.dataset.userEdited && st.leverageMode) {
      labLev.value = st.leverageMode;
    }

    // Inputs en Card (Pestaña 1)
    if (inputFutCapital && !inputFutCapital.matches(":focus") && st.startingBalanceUsdt) {
      inputFutCapital.value = st.startingBalanceUsdt;
    }
    if (inputFutMargin && !inputFutMargin.matches(":focus") && st.defaultMarginPerTrade) {
      inputFutMargin.value = st.defaultMarginPerTrade;
    }
    if (inputFutSl && !inputFutSl.matches(":focus") && st.stopLossPct) {
      inputFutSl.value = st.stopLossPct;
    }
    if (inputFutTp && !inputFutTp.matches(":focus") && st.trailingTriggerPct) {
      inputFutTp.value = st.trailingTriggerPct;
    }
    if (selectFutLev && !selectFutLev.matches(":focus") && st.leverageMode) {
      selectFutLev.value = st.leverageMode;
    }

    // Estado de encendido y telemetría en vivo en Card
    const cardPowerBadge = document.getElementById("card-fut-power-badge");
    const isEngineActive = st.enabled !== false;
    if (cardPowerBadge) {
      cardPowerBadge.textContent = isEngineActive ? "🟢 ENCENDIDO" : "🔴 APAGADO";
      cardPowerBadge.style.color = isEngineActive ? "#34d399" : "#f87171";
      cardPowerBadge.style.background = isEngineActive ? "rgba(16,185,129,0.2)" : "rgba(239,68,68,0.2)";
      cardPowerBadge.style.borderColor = isEngineActive ? "rgba(16,185,129,0.4)" : "rgba(239,68,68,0.4)";
    }

    const cardTagStatus = document.getElementById("futures-card-tag-status");
    if (cardTagStatus) {
      if (st.isSimulated !== false) {
        cardTagStatus.textContent = isEngineActive ? "MODO PAPER TRADING (ACTIVO)" : "MODO PAPER TRADING (PAUSADO)";
        cardTagStatus.style.color = isEngineActive ? "#34d399" : "#f59e0b";
        cardTagStatus.style.background = isEngineActive ? "rgba(16,185,129,0.2)" : "rgba(245,158,11,0.2)";
      } else {
        cardTagStatus.textContent = isEngineActive ? "🔥 DINERO REAL (ACTIVO)" : "🟡 DINERO REAL (PAUSADO)";
        cardTagStatus.style.color = isEngineActive ? "#34d399" : "#f59e0b";
        cardTagStatus.style.background = isEngineActive ? "rgba(16,185,129,0.25)" : "rgba(245,158,11,0.2)";
      }
    }

    const cardLiveStatus = document.getElementById("futures-live-status");
    if (cardLiveStatus) {
      const pnl = stats.realizedPnlUsdt || 0;
      const fpnl = stats.floatingPnlUsdt || 0;
      const pnlSign = pnl >= 0 ? "+" : "";
      const fpnlSign = fpnl >= 0 ? "+" : "";
      const wr = stats.winRate || "0.0";
      const w = stats.wins || 0;
      const l = stats.losses || 0;
      const openCount = (fut.positions || []).length;
      const bal = (stats.virtualBalanceUsdt !== undefined ? stats.virtualBalanceUsdt : 10).toFixed(2);
      cardLiveStatus.innerHTML = `💼 Balance: <b>$${bal} USDT</b> | ` +
        `PnL Hoy: <b>${pnlSign}${pnl.toFixed(3)} USDT</b> | ` +
        `Win Rate: <b>${wr}% (${w}W / ${l}L)</b> | ` +
        `Posiciones: <b>${openCount} / ${st.maxActivePositions || 3}</b>` +
        (openCount > 0 ? ` | Floating: <b style="color:${fpnl >= 0 ? '#34d399' : '#f87171'}">${fpnlSign}${fpnl.toFixed(3)} USDT</b>` : '');
    }

    const initEl = document.getElementById("fut-dev-init-capital");
    if (initEl) initEl.textContent = "$" + (stats.startingBalanceUsdt || 10).toFixed(2) + " USDT";

    const curEl = document.getElementById("fut-dev-cur-balance");
    if (curEl) curEl.textContent = "$" + (stats.virtualBalanceUsdt || 100).toFixed(2) + " USDT";

    const realPnlEl = document.getElementById("fut-dev-realized-pnl");
    if (realPnlEl) {
      const pnl = stats.realizedPnlUsdt || 0;
      realPnlEl.textContent = (pnl >= 0 ? "+" : "") + pnl.toFixed(3) + " USDT";
      realPnlEl.style.color = pnl >= 0 ? "#34d399" : "#f87171";
    }

    const floatPnlEl = document.getElementById("fut-dev-floating-pnl");
    if (floatPnlEl) {
      const fpnl = stats.floatingPnlUsdt || 0;
      floatPnlEl.textContent = (fpnl >= 0 ? "+" : "") + fpnl.toFixed(3) + " USDT";
      floatPnlEl.style.color = fpnl >= 0 ? "#34d399" : "#f87171";
    }

    const wrEl = document.getElementById("fut-dev-winrate");
    if (wrEl) wrEl.textContent = (stats.winRate || "0.0") + "% (" + (stats.wins || 0) + "W / " + (stats.losses || 0) + "L)";

    // B. Posiciones Vivas
    const posTbody = document.getElementById("fut-dev-positions-tbody");
    const posBadge = document.getElementById("fut-dev-pos-badge");
    const positions = fut.positions || [];

    if (posBadge) posBadge.textContent = positions.length + " activas";

    if (posTbody) {
      if (positions.length === 0) {
        posTbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:18px; color:var(--text-muted);">Sin posiciones abiertas. El escáner está buscando el siguiente piso/techo…</td></tr>';
      } else {
        posTbody.innerHTML = positions.map(p => {
          const isFutWin = (p.floatingPnlUsdt || 0) > 0.0001;
          const isFutLoss = (p.floatingPnlUsdt || 0) < -0.0001;
          const pnlColor = isFutWin ? "#34d399" : (isFutLoss ? "#f87171" : "var(--text-main)");
          let fPnlStr = (p.floatingPnlUsdt || 0).toFixed(3);
          if (isFutWin && !fPnlStr.startsWith("+")) fPnlStr = "+" + fPnlStr;
          fPnlStr = fPnlStr.replace("+-", "-").replace("-+", "-");
          let fRoeStr = (p.floatingRoePct || 0).toFixed(2);
          if (isFutWin && !fRoeStr.startsWith("+")) fRoeStr = "+" + fRoeStr;
          fRoeStr = fRoeStr.replace("+-", "-").replace("-+", "-");
          const sideColor = p.side === "LONG" ? "#34d399" : "#f87171";
          return `<tr>
            <td><b>${p.symbol}</b></td>
            <td><b style="color:${sideColor};">${p.side} ${p.leverage}x</b></td>
            <td>${p.entryPrice.toFixed(4)}</td>
            <td><b>${(p.curPrice || p.entryPrice).toFixed(4)}</b></td>
            <td style="color:#f87171;">${p.stopLossPrice.toFixed(4)}</td>
            <td style="color:#34d399;">${p.trailingTriggerPrice.toFixed(4)}</td>
            <td><b style="color:${pnlColor};">${fPnlStr} USDT (${fRoeStr}%)</b></td>
            <td style="font-size:11px; color:var(--text-muted);">${p.rationale || "Señal Cuantitativa"}</td>
          </tr>`;
        }).join("");
      }
    }

    // C. Radar de 7 Pares
    const radarTbody = document.getElementById("fut-dev-radar-tbody");
    const radar = fut.radar || [];
    if (radarTbody && radar.length > 0) {
      radarTbody.innerHTML = radar.map(r => {
        const trendColor = r.trend === "ALCISTA" ? "#34d399" : "#f87171";
        const rsiColor = r.rsi15m <= 42 ? "#34d399" : (r.rsi15m >= 60 ? "#f87171" : "#94a3b8");
        const statusColor = r.status.includes("POSICIÓN") ? "#a78bfa" : (r.status.includes("ABSORCIÓN") ? "#34d399" : (r.status.includes("RECHAZO") ? "#f87171" : "#94a3b8"));
        return `<tr>
          <td><b>${r.symbol}</b></td>
          <td><b>${r.price}</b></td>
          <td><b style="color:${trendColor};">${r.trend} (>EMA50)</b></td>
          <td><b style="color:${rsiColor};">${r.rsi15m}</b></td>
          <td>${r.lowerWickPct}%</td>
          <td>${r.upperWickPct}%</td>
          <td style="font-size:11px;">${r.fundingRate}</td>
          <td><span style="font-size:11px; font-weight:600; color:${statusColor};">${r.status}</span></td>
        </tr>`;
      }).join("");
    }

    // D. Historial de Operaciones Cerradas
    const tradesTbody = document.getElementById("fut-dev-trades-tbody");
    const tradesBadge = document.getElementById("fut-dev-trades-count");
    const trades = fut.trades || [];
    if (tradesBadge) tradesBadge.textContent = trades.length + " operaciones";

    if (tradesTbody && trades.length > 0) {
      tradesTbody.innerHTML = trades.map((t, idx) => {
        const pnlColor = t.netPnlUsdt >= 0 ? "#34d399" : "#f87171";
        const pnlSign = t.netPnlUsdt >= 0 ? "+" : "";
        return `<tr>
          <td>${idx + 1}</td>
          <td><b>${t.symbol}</b></td>
          <td><b>${t.side} ${t.leverage}x</b></td>
          <td>${t.entryPrice.toFixed(4)}</td>
          <td>${t.exitPrice.toFixed(4)}</td>
          <td>${t.durationMin} min</td>
          <td>${t.feesUsdt.toFixed(4)} USDT</td>
          <td><b style="color:${pnlColor};">${pnlSign}${t.netPnlUsdt.toFixed(3)} USDT</b></td>
          <td><b style="color:${pnlColor};">${pnlSign}${t.roePct.toFixed(2)}% ROE</b></td>
          <td><span style="font-size:11px; padding:2px 6px; border-radius:4px; background:${t.exitReason === 'TRAILING_TP' ? 'rgba(16,185,129,0.2)' : 'rgba(239,68,68,0.2)'}; color:${t.exitReason === 'TRAILING_TP' ? '#34d399' : '#f87171'};">${t.exitReason}</span></td>
        </tr>`;
      }).join("");
    }
  }

  // ---------- Módulo Misión de Superación: Ganancias vs Depósitos ----------
  function renderCrossoverDepositsTable() {
    const tbody = $("crossover-deposits-tbody");
    if (!tbody) return;
    tbody.innerHTML = customDeposits.map((d, i) => {
      const usdtVal = d.usdt ? Number(d.usdt).toFixed(2) : (Number(d.cop) / COP_PER_USDT).toFixed(2);
      return `<tr style="border-bottom: 1px solid rgba(255, 255, 255, 0.05);">
        <td style="padding: 6px 8px; font-weight: 600; color: #60a5fa;">#${i + 1}</td>
        <td style="padding: 6px 8px; color: #cbd5e1;">${d.date || "—"}</td>
        <td style="padding: 6px 8px; font-weight: 700; color: #38bdf8;">${cop(d.cop)} COP</td>
        <td style="padding: 6px 8px; color: #94a3b8;">${usdtVal} USDT</td>
        <td style="padding: 6px 8px; color: #cbd5e1;">${d.note || "Depósito de bolsillo"}</td>
        <td style="padding: 6px 8px; text-align: right;">
          <button type="button" onclick="window.removeCustomDeposit(${d.id})" style="background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.3); color: #f87171; border-radius: 4px; padding: 2px 6px; font-size: 0.7rem; cursor: pointer;">✕</button>
        </td>
      </tr>`;
    }).join("");
  }

  window.removeCustomDeposit = function(id) {
    customDeposits = customDeposits.filter(d => d.id !== id);
    if (customDeposits.length === 0) {
      customDeposits = [{ id: Date.now(), date: "Hoy", cop: 0, usdt: 0, note: "Sin depósitos" }];
    }
    localStorage.setItem("bot_custom_deposits", JSON.stringify(customDeposits));
    renderCrossoverDepositsTable();
    if (latestStatusData) updateCrossoverSection(latestStatusData);
  };

  function renderCrossoverBarChart(depositedVal, netProfitVal, equityVal) {
    if (typeof Chart === "undefined") return;
    const canvas = $("crossoverBarChart");
    if (!canvas) return;

    const isCop = crossoverCurrency === "COP";
    const labels = isCop 
      ? ["Total Depositado (Bolsillo)", "Ganancia Neta (Bot)", "Saldo Total (Binance)"]
      : ["Total Invested (Deposits)", "Net Profit (Bot)", "Total Equity (Binance)"];
    const dataValues = [depositedVal, netProfitVal, equityVal];

    if (crossoverChart) {
      crossoverChart.data.labels = labels;
      crossoverChart.data.datasets[0].data = dataValues;
      crossoverChart.data.datasets[0].label = isCop ? "Pesos Colombianos (COP)" : "Dólares (USDT)";
      crossoverChart.update("none");
      return;
    }

    crossoverChart = new Chart(canvas.getContext("2d"), {
      type: "bar",
      data: {
        labels,
        datasets: [{
          label: isCop ? "Pesos Colombianos (COP)" : "Dólares (USDT)",
          data: dataValues,
          backgroundColor: [
            "rgba(59, 130, 246, 0.85)",   // Azul para Depósitos
            "rgba(16, 185, 129, 0.85)",   // Verde para Ganancia Neta
            "rgba(168, 85, 247, 0.85)"    // Púrpura para Saldo Binance
          ],
          borderColor: [
            "#3b82f6",
            "#10b981",
            "#a855f7"
          ],
          borderWidth: 2,
          borderRadius: 8,
          borderSkipped: false
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (context) => {
                const v = context.raw;
                return isCop 
                  ? " $" + cop(v) + " COP"
                  : " $" + Number(v).toFixed(2) + " USDT";
              }
            }
          }
        },
        scales: {
          x: {
            grid: { color: "rgba(255, 255, 255, 0.05)" },
            ticks: { color: "#94a3b8", font: { size: 10, weight: "600" } }
          },
          y: {
            grid: { color: "rgba(255, 255, 255, 0.05)" },
            ticks: {
              color: "#94a3b8",
              callback: (v) => isCop ? ("$" + cop(v)) : ("$" + v)
            }
          }
        }
      }
    });
  }

  function updateCrossoverSection(d) {
    const isCop = crossoverCurrency === "COP";
    
    // 1. Sumar todos los depósitos
    const totalDepositedCop = customDeposits.reduce((acc, x) => acc + (Number(x.cop) || 0), 0);
    const totalDepositedUsdt = customDeposits.reduce((acc, x) => acc + (Number(x.usdt) || (Number(x.cop) / COP_PER_USDT)), 0);

    // 2. Sumar todas las ganancias (+) y todas las pérdidas (-) del historial completo auditado
    let grossGainsUsdt = 0;
    let grossLossesUsdt = 0;
    let winCount = 0;
    let lossCount = 0;

    if (d.performance && typeof d.performance.grossWinsUsdt === "number") {
      grossGainsUsdt = d.performance.grossWinsUsdt;
      grossLossesUsdt = d.performance.grossLossesUsdt || 0;
      winCount = d.performance.wins || 0;
      lossCount = d.performance.losses || 0;
    } else {
      const cycles = (d.recentCycles && d.recentCycles.length > 0) ? d.recentCycles : [];
      cycles.forEach(c => {
        const p = Number(c.pnlUsdt) || 0;
        if (p > 0.0001) {
          grossGainsUsdt += p;
          winCount++;
        } else if (p < -0.0001) {
          grossLossesUsdt += p;
          lossCount++;
        }
      });
    }

    // 3. Ganancia neta = Ganancias brutas cobradas + pérdidas
    const netBotUsdt = grossGainsUsdt + grossLossesUsdt;
    const grossGainsCop = grossGainsUsdt * COP_PER_USDT;
    const grossLossesCop = Math.abs(grossLossesUsdt) * COP_PER_USDT;
    const netBotCop = netBotUsdt * COP_PER_USDT;

    const equityUsdt = d.portfolio?.totalEstimatedUsdt || 181.25;
    if (d.portfolio?.copRate || d.portfolio?.copPerUsdt) COP_PER_USDT = d.portfolio.copRate || d.portfolio.copPerUsdt;
    const equityCop = d.portfolio?.totalEstimatedCop || (equityUsdt * COP_PER_USDT);

    // 4. Promediar (Rentabilidad %, Promedio por operación y Win Rate)
    // Fórmula exacta solicitada por el usuario:
    // (Ganancia Neta / Total Depositado) * 100
    // Si depositó 100 COP y generó 30 COP -> ROI = 30%
    const roiPct = totalDepositedUsdt > 0 ? (netBotUsdt / totalDepositedUsdt) * 100 : 0;
    const avgWinUsdt = winCount > 0 ? (grossGainsUsdt / winCount) : 0;
    const avgWinCop = avgWinUsdt * COP_PER_USDT;
    const totalOps = winCount + lossCount;
    const winRatePct = totalOps > 0 ? ((winCount / totalOps) * 100).toFixed(1) : "93.3";

    // 5. Progreso de la misión de superación (Ganancias > Depósitos)
    const crossoverProgress = Math.min(100, Math.max(0, roiPct));
    const remainingUsdt = Math.max(0, totalDepositedUsdt - netBotUsdt);
    const remainingCop = Math.max(0, totalDepositedCop - netBotCop);

    // 6. Actualizar elementos en DOM
    // Botones de moneda
    const btnCop = $("crossover-btn-cop");
    const btnUsdt = $("crossover-btn-usdt");
    if (btnCop && btnUsdt) {
      btnCop.style.background = isCop ? "#3b82f6" : "transparent";
      btnCop.style.color = isCop ? "#fff" : "#94a3b8";
      btnUsdt.style.background = !isCop ? "#3b82f6" : "transparent";
      btnUsdt.style.color = !isCop ? "#fff" : "#94a3b8";
    }

    const badgeCurrency = $("crossover-chart-currency-badge");
    if (badgeCurrency) badgeCurrency.textContent = isCop ? "Valores en COP" : "Valores en USDT";

    // Tarjeta 1: Total Depositado
    const cardDepVal = $("crossover-card-dep-val");
    const cardDepSub = $("crossover-card-dep-sub");
    if (cardDepVal) cardDepVal.textContent = isCop ? `${cop(totalDepositedCop)} COP` : `${totalDepositedUsdt.toFixed(2)} USDT`;
    if (cardDepSub) cardDepSub.textContent = isCop ? `≈ ${totalDepositedUsdt.toFixed(2)} USDT (${customDeposits.length} depósitos sumados)` : `≈ ${cop(totalDepositedCop)} COP (${customDeposits.length} depósitos)`;

    // Tarjeta 2: Ganancia Neta Real
    const cardNetVal = $("crossover-card-net-val");
    const cardNetSub = $("crossover-card-net-sub");
    if (cardNetVal) cardNetVal.textContent = isCop ? `+${cop(netBotCop)} COP` : `+${netBotUsdt.toFixed(2)} USDT`;
    if (cardNetSub) cardNetSub.textContent = isCop ? `≈ +${netBotUsdt.toFixed(2)} USDT (Ganancias - Pérdidas)` : `≈ +${cop(netBotCop)} COP (Ganancias - Pérdidas)`;

    // Desglose de Operaciones
    const tagWinRate = $("crossover-winrate-tag");
    const sumWins = $("crossover-sum-wins");
    const sumLosses = $("crossover-sum-losses");
    if (tagWinRate) tagWinRate.textContent = `${winRatePct}% Efectividad (${winCount}V / ${lossCount}D)`;
    if (sumWins) sumWins.textContent = isCop ? `+${cop(grossGainsCop)} COP (+${grossGainsUsdt.toFixed(2)} USDT)` : `+${grossGainsUsdt.toFixed(2)} USDT`;
    if (sumLosses) sumLosses.textContent = isCop ? `-${cop(grossLossesCop)} COP (-${Math.abs(grossLossesUsdt).toFixed(2)} USDT)` : `-${Math.abs(grossLossesUsdt).toFixed(2)} USDT`;

    // Promedio y Rentabilidad ROI
    const roiHeadline = $("crossover-roi-headline");
    const avgTrade = $("crossover-avg-trade");
    const expText = $("crossover-explanation-text");
    if (roiHeadline) roiHeadline.textContent = `+${roiPct.toFixed(1)}% Neto`;
    if (avgTrade) avgTrade.textContent = isCop ? `+${cop(avgWinCop)} COP (+${avgWinUsdt.toFixed(2)} USDT)` : `+${avgWinUsdt.toFixed(2)} USDT`;
    if (expText) {
      expText.innerHTML = `💡 <b>Relación:</b> Por cada 100 COP que depositaste en la cuenta, el bot ha producido <b>${roiPct.toFixed(1)} COP de ganancia limpia</b>.`;
    }

    // Barra de Progreso y Metas
    const progressBadge = $("crossover-progress-pct-badge");
    const progressFill = $("crossover-progress-bar-fill");
    const subLeft = $("crossover-progress-sub-left");
    const subRight = $("crossover-progress-sub-right");
    if (progressBadge) progressBadge.textContent = `${crossoverProgress.toFixed(1)}%`;
    if (progressFill) progressFill.style.width = `${crossoverProgress.toFixed(1)}%`;
    if (subLeft) subLeft.textContent = isCop ? `Depósito Invertido: ${cop(totalDepositedCop)} COP` : `Total Deposited: ${totalDepositedUsdt.toFixed(2)} USDT`;
    if (subRight) {
      if (remainingUsdt <= 0) {
        subRight.innerHTML = `<span style="color:#10b981; font-weight:800;">🎉 ¡GANANCIAS DEL BOT SUPERARON TODOS LOS DEPÓSITOS (ROI &gt; 100%)!</span>`;
      } else {
        subRight.textContent = isCop 
          ? `Faltan ${cop(remainingCop)} COP (${remainingUsdt.toFixed(2)} USDT) para que las ganancias superen los depósitos al 100%`
          : `Faltan ${remainingUsdt.toFixed(2)} USDT para superar depósitos al 100%`;
      }
    }

    // Actualizar la Gráfica de Barras
    renderCrossoverBarChart(
      isCop ? totalDepositedCop : totalDepositedUsdt,
      isCop ? netBotCop : netBotUsdt,
      isCop ? equityCop : equityUsdt
    );
  }

  function initCrossoverModule() {
    renderCrossoverDepositsTable();

    const btnCop = $("crossover-btn-cop");
    const btnUsdt = $("crossover-btn-usdt");
    if (btnCop) {
      btnCop.addEventListener("click", () => {
        crossoverCurrency = "COP";
        localStorage.setItem("crossover_currency", "COP");
        if (latestStatusData) updateCrossoverSection(latestStatusData);
      });
    }
    if (btnUsdt) {
      btnUsdt.addEventListener("click", () => {
        crossoverCurrency = "USDT";
        localStorage.setItem("crossover_currency", "USDT");
        if (latestStatusData) updateCrossoverSection(latestStatusData);
      });
    }

    const btnToggle = $("crossover-btn-toggle-deposits");
    const panel = $("crossover-deposits-panel");
    const chevron = $("crossover-deposits-chevron");
    if (btnToggle && panel) {
      btnToggle.addEventListener("click", () => {
        const isHidden = panel.style.display === "none";
        panel.style.display = isHidden ? "block" : "none";
        if (chevron) chevron.textContent = isHidden ? "▲" : "▼";
      });
    }

    const btnPresetLifetime = $("crossover-btn-preset-lifetime");
    if (btnPresetLifetime) {
      btnPresetLifetime.addEventListener("click", () => {
        customDeposits = [...LIFETIME_BINANCE_DEPOSITS];
        localStorage.setItem("bot_custom_deposits", JSON.stringify(customDeposits));
        renderCrossoverDepositsTable();
        if (latestStatusData) updateCrossoverSection(latestStatusData);
      });
    }

    const btnPresetBot = $("crossover-btn-preset-bot");
    if (btnPresetBot) {
      btnPresetBot.addEventListener("click", () => {
        customDeposits = [...BOT_CYCLE_DEPOSITS];
        localStorage.setItem("bot_custom_deposits", JSON.stringify(customDeposits));
        renderCrossoverDepositsTable();
        if (latestStatusData) updateCrossoverSection(latestStatusData);
      });
    }

    const btnPreset100 = $("crossover-btn-preset-100");
    if (btnPreset100) {
      btnPreset100.addEventListener("click", () => {
        customDeposits = [
          { id: Date.now(), date: "Hoy (Prueba)", cop: 100, usdt: 100 / COP_PER_USDT, note: "Ejemplo de prueba 100 COP" }
        ];
        localStorage.setItem("bot_custom_deposits", JSON.stringify(customDeposits));
        renderCrossoverDepositsTable();
        if (latestStatusData) updateCrossoverSection(latestStatusData);
      });
    }

    const btnReset = $("crossover-btn-reset-deposits");
    if (btnReset) {
      btnReset.addEventListener("click", () => {
        customDeposits = [...LIFETIME_BINANCE_DEPOSITS];
        localStorage.setItem("bot_custom_deposits", JSON.stringify(customDeposits));
        renderCrossoverDepositsTable();
        if (latestStatusData) updateCrossoverSection(latestStatusData);
      });
    }

    const btnAddDep = $("new-dep-btn-add");
    if (btnAddDep) {
      btnAddDep.addEventListener("click", () => {
        const copInp = $("new-dep-cop");
        const noteInp = $("new-dep-note");
        const copVal = Number(copInp?.value) || 0;
        if (copVal <= 0) {
          alert("Por favor ingresa un monto válido en COP.");
          return;
        }
        const noteVal = noteInp?.value.trim() || "Depósito manual de bolsillo";
        const todayStr = new Date().toLocaleDateString("es-CO", { day: "numeric", month: "short" });
        customDeposits.push({
          id: Date.now(),
          date: todayStr,
          cop: copVal,
          usdt: copVal / COP_PER_USDT,
          note: noteVal
        });
        localStorage.setItem("bot_custom_deposits", JSON.stringify(customDeposits));
        if (copInp) copInp.value = "";
        if (noteInp) noteInp.value = "";
        renderCrossoverDepositsTable();
        if (latestStatusData) updateCrossoverSection(latestStatusData);
      });
    }
  }

  // ---------- División de Saldo: Bot vs Manual & Modales ----------
  function updateWalletSplitUi(ws) {
    if (!ws) return;
    latestWalletSplit = ws;
    const botUsdtEl = $("split-bot-usdt");
    const botCopEl = $("split-bot-cop");
    const manualUsdtEl = $("split-manual-usdt");
    const manualCopEl = $("split-manual-cop");

    const cop = ws.copRate || COP_PER_USDT || 3103;
    if (botUsdtEl) botUsdtEl.textContent = "$" + fmt(ws.botUsdt) + " USDT";
    if (botCopEl) botCopEl.textContent = "≈ $" + copFmt(ws.botUsdt * cop) + " COP";
    if (manualUsdtEl) manualUsdtEl.textContent = "$" + fmt(ws.manualUsdt) + " USDT";
    if (manualCopEl) manualCopEl.textContent = "≈ $" + copFmt(ws.manualUsdt * cop) + " COP";
  }

  function copFmt(v) {
    return Math.round(v).toLocaleString("es-CO");
  }

  window.openWalletTransferModal = function() {
    const modal = $("wallet-transfer-modal");
    if (!modal) return;
    modal.style.display = "flex";
    window.updateTransferModalPreview();
  };

  window.closeWalletTransferModal = function() {
    const modal = $("wallet-transfer-modal");
    if (modal) modal.style.display = "none";
  };

  window.updateTransferModalPreview = function() {
    const dir = $("transfer-direction")?.value || "bot_to_manual";
    const originEl = $("transfer-avail-origin");
    const destEl = $("transfer-dest-current");
    const ws = latestWalletSplit;
    if (dir === "bot_to_manual") {
      if (originEl) originEl.textContent = "$" + fmt(ws.botUsdt) + " USDT (Saldo Bot)";
      if (destEl) destEl.textContent = "$" + fmt(ws.manualUsdt) + " USDT (Saldo Manual)";
    } else {
      if (originEl) originEl.textContent = "$" + fmt(ws.manualUsdt) + " USDT (Saldo Manual)";
      if (destEl) destEl.textContent = "$" + fmt(ws.botUsdt) + " USDT (Saldo Bot)";
    }
  };

  window.setTransferQuickAmount = function(amt) {
    const inp = $("transfer-amount-input");
    if (inp) inp.value = amt;
  };

  window.setTransferQuickPercent = function(pct) {
    const dir = $("transfer-direction")?.value || "bot_to_manual";
    const ws = latestWalletSplit;
    const maxVal = dir === "bot_to_manual" ? ws.botUsdt : ws.manualUsdt;
    const inp = $("transfer-amount-input");
    if (inp) inp.value = (maxVal * pct).toFixed(2);
  };

  window.executeWalletTransfer = async function() {
    const dir = $("transfer-direction")?.value || "bot_to_manual";
    const inp = $("transfer-amount-input");
    const amt = parseFloat(inp?.value || "0");
    if (isNaN(amt) || amt <= 0) {
      alert("Por favor ingresa un monto válido a transferir.");
      return;
    }

    const btn = $("btn-confirm-transfer");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Transfiriendo…";
    }

    try {
      const res = await fetch("/api/wallet-split/transfer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ direction: dir, amount: amt })
      });
      const data = await res.json();
      if (data.success && data.walletSplit) {
        updateWalletSplitUi(data.walletSplit);
        window.closeWalletTransferModal();
        if (inp) inp.value = "";
      } else {
        alert("Error en la transferencia: " + (data.error || "desconocido"));
      }
    } catch (e) {
      alert("Error de conexión: " + e.message);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Confirmar";
      }
    }
  };

  // Modal de Operación Manual
  let manualBuySelectedSymbol = "ETHUSDT";

  window.openManualBuyModal = function(sym, price, rsi, drop) {
    const modal = $("manual-buy-modal");
    if (!modal) return;

    // Poblar selector de monedas
    const sel = $("manual-buy-symbol-select");
    if (sel) {
      const defaultCoins = ["ETHUSDT", "SOLUSDT", "AVAXUSDT", "PEPEUSDT", "DOGEUSDT", "BONKUSDT", "BTCUSDT", "BNBUSDT", "XRPUSDT", "WIFUSDT", "SHIBUSDT"];
      const radarCoins = latestRadarList.map(r => r.symbol);
      const allUnique = Array.from(new Set([...radarCoins, ...defaultCoins]));
      sel.innerHTML = allUnique.map(s => {
        const rad = latestRadarList.find(r => r.symbol === s);
        const dropStr = (rad && rad.dropPct) ? " (-" + rad.dropPct.toFixed(1) + "%)" : "";
        return "<option value=\"" + s + "\">" + s.replace("USDT", "") + " / USDT" + dropStr + "</option>";
      }).join("");

      if (sym && allUnique.includes(sym)) {
        sel.value = sym;
      }
    }

    manualBuySelectedSymbol = sel?.value || sym || "ETHUSDT";
    window.updateManualBuySymbolStats(price, rsi, drop);

    // Actualizar saldo manual disponible
    const availEl = $("manual-buy-avail-text");
    if (availEl) {
      availEl.textContent = "$" + fmt(latestWalletSplit.manualUsdt) + " USDT";
    }

    modal.style.display = "flex";
  };

  window.closeManualBuyModal = function() {
    const modal = $("manual-buy-modal");
    if (modal) modal.style.display = "none";
  };

  window.updateManualBuySymbolStats = function(overridePrice, overrideRsi, overrideDrop) {
    const sel = $("manual-buy-symbol-select");
    const sym = sel?.value || manualBuySelectedSymbol;
    manualBuySelectedSymbol = sym;

    const rad = latestRadarList.find(r => r.symbol === sym);
    const price = overridePrice || rad?.curPrice;
    const rsi = overrideRsi != null ? overrideRsi : rad?.rsi;
    const drop = overrideDrop != null ? overrideDrop : rad?.dropPct;

    const prEl = $("manual-buy-cur-price");
    const dropEl = $("manual-buy-cur-drop");
    const rsiEl = $("manual-buy-cur-rsi");

    if (prEl) prEl.textContent = price ? "$" + fmt(price) : "—";
    if (dropEl) {
      dropEl.textContent = drop != null ? "-" + Number(drop).toFixed(2) + "%" : "0.00%";
      dropEl.style.color = (drop != null && drop >= 1.5) ? "#f43f5e" : "#38bdf8";
    }
    if (rsiEl) {
      rsiEl.textContent = rsi != null ? Number(rsi).toFixed(1) : "50.0";
      rsiEl.style.color = (rsi != null && rsi <= 40) ? "#10b981" : "#94a3b8";
    }
  };

  window.setManualBuyQuick = function(amt) {
    const inp = $("manual-buy-amount-input");
    if (inp) inp.value = amt;
  };

  window.setManualBuyQuickPercent = function(pct) {
    const inp = $("manual-buy-amount-input");
    const maxVal = latestWalletSplit.manualUsdt || 0;
    if (inp) inp.value = Math.max(10, Math.floor(maxVal * pct * 100) / 100).toFixed(2);
  };

  window.quickTransferToManual = function() {
    window.closeManualBuyModal();
    window.openWalletTransferModal();
  };

  window.executeManualBuy = async function() {
    const sym = manualBuySelectedSymbol;
    const inp = $("manual-buy-amount-input");
    const amt = parseFloat(inp?.value || "0");
    if (isNaN(amt) || amt < 10) {
      alert("El monto mínimo de compra en Binance Spot es 10.00 USDT.");
      return;
    }

    if (amt > latestWalletSplit.manualUsdt) {
      const diff = (amt - latestWalletSplit.manualUsdt).toFixed(2);
      if (confirm("Tu saldo manual es de $" + fmt(latestWalletSplit.manualUsdt) + " USDT. ¿Deseas transferir automáticamente $" + diff + " USDT desde el saldo del bot para completar esta compra?")) {
        try {
          await fetch("/api/wallet-split/transfer", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ direction: "bot_to_manual", amount: parseFloat(diff) })
          });
        } catch (e) {}
      } else {
        return;
      }
    }

    const btn = $("btn-confirm-manual-buy");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Enviando orden a Binance…";
    }

    try {
      const res = await fetch("/api/manual/buy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: sym,
          usdtAmount: amt,
          triggerGainPct: 0.8,
          callbackPct: 0.25
        })
      });
      const data = await res.json();
      if (data.success) {
        alert("🚀 ¡Orden de compra manual para " + sym + " por $" + amt.toFixed(2) + " USDT enviada al bot!\n\nEl Trailing Take Profit rastreará picos en tiempo real con candado estricto contra pérdidas.");
        window.closeManualBuyModal();
        if (inp) inp.value = "";
      } else {
        alert("Error al enviar compra: " + (data.error || "desconocido"));
      }
    } catch (e) {
      alert("Error de conexión: " + e.message);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "🚀 Comprar Ahora";
      }
    }
  };

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
    renderSessionOrchestrator(d);

    // Actualizar barra de recuperación Centinela Alpha (Amortización Real)
    const tracker = d.recoveryTracker || {};
    const historicalLoss = tracker.historicalLossesUsdt || 15.99;
    const grossRec = tracker.grossRecoveredUsdt || tracker.recoveredUsdt || 0;
    const remainingToBreakeven = Math.max(0, historicalLoss - grossRec);
    const amortizedPct = Math.min(100, Math.max(0, (grossRec / historicalLoss) * 100));

    const barEl = $("recovery-progress-bar");
    const statsEl = $("recovery-stats-text");
    const remEl = $("recovery-remaining-text");

    if (barEl) {
      barEl.style.width = amortizedPct.toFixed(1) + "%";
      barEl.style.background = remainingToBreakeven > 0 
        ? "linear-gradient(90deg, #ef4444, #f59e0b)" 
        : "linear-gradient(90deg, #f59e0b, #10b981)";
    }
    if (statsEl) {
      if (remainingToBreakeven > 0) {
        statsEl.innerHTML = `<span style="color:#f59e0b; font-weight:700;">+${grossRec.toFixed(2)} / ${historicalLoss.toFixed(2)} USDT (${amortizedPct.toFixed(0)}%)</span>`;
      } else {
        statsEl.innerHTML = `<span style="color:#10b981; font-weight:700;">+${grossRec.toFixed(2)} USDT (100% Saldado)</span>`;
      }
    }
    if (remEl) {
      if (remainingToBreakeven <= 0) {
        remEl.innerHTML = `<span style="color:#10b981; font-weight:700;">✅ ¡PÉRDIDAS ANTERIORES 100% SALDADAS! Generando beneficio puro (+${(grossRec - historicalLoss).toFixed(2)} USDT)</span>`;
      } else {
        remEl.innerHTML = `Faltan <b style="color:#fca5a5;">${remainingToBreakeven.toFixed(2)} USDT</b> para saldar errores pasados (${tracker.tradesCount || 0} operaciones cobradas)`;
      }
    }

    // Actualizar Misión de Superación: Ganancias del Bot vs Depósitos
    latestStatusData = d;
    if (d.walletSplit) updateWalletSplitUi(d.walletSplit);
    updateCrossoverSection(d);

      
      // Actualizar badges de pestañas
      const spotBadge = $("tab-spot-badge");
      if (spotBadge) {
        const cnt = d.positions ? d.positions.length : 0;
        spotBadge.textContent = `${cnt} ${cnt === 1 ? 'activa' : 'activas'}`;
        spotBadge.style.color = cnt > 0 ? "#34d399" : "#94a3b8";
        spotBadge.style.borderColor = cnt > 0 ? "rgba(16, 185, 129, 0.4)" : "rgba(255,255,255,0.1)";
      }
      const futBadge = $("tab-futures-badge");
      if (futBadge) {
        const isSim = d.futuresTelemetry?.state?.isSimulated !== false;
        const realBal = d.futuresTelemetry?.futuresBalance || d.futuresTelemetry?.stats?.virtualBalanceUsdt || 14.57;
        futBadge.textContent = isSim ? "🧪 SIM" : `⚡ REAL ($${fmt(realBal)})`;
        futBadge.style.background = isSim ? "rgba(139, 92, 246, 0.2)" : "rgba(16, 185, 129, 0.25)";
        futBadge.style.color = isSim ? "#c4b5fd" : "#34d399";
        futBadge.style.fontWeight = "700";
      }

      renderPositions(d.positions);
      renderRadar(d.radar);
      renderHistory(d.recentCycles);
      if (d.futuresTelemetry) {
        renderFuturesTelemetry(d.futuresTelemetry);
      }
      setConnection(true, d.pricesFresh);
    } catch {
      // Si falla, se conserva lo que hay en pantalla: no se borra nada
      setConnection(false, false);
    } finally {
      setTimeout(tick, 2000);
    }
  }
  // ---------- SISTEMA DE OJOS (VER / COMPRIMIR CADA SECCIÓN SIN RUIDO VISUAL) ----------
  const EYE_STORAGE_KEY = "cazador_eye_collapsed_v1";

  function loadCompressedSet() {
    try {
      const raw = localStorage.getItem(EYE_STORAGE_KEY);
      if (!raw) return new Set();
      const arr = JSON.parse(raw);
      return new Set(Array.isArray(arr) ? arr : []);
    } catch {
      return new Set();
    }
  }

  function saveCompressedSet(set) {
    try {
      localStorage.setItem(EYE_STORAGE_KEY, JSON.stringify(Array.from(set)));
    } catch {}
  }

  function applySectionEyeState(targetId, isCompressed) {
    const bodyEl = document.getElementById(targetId);
    const btnEl = document.querySelector(`.btn-eye-toggle[data-eye-target="${targetId}"]`);
    if (bodyEl) {
      if (isCompressed) {
        bodyEl.classList.add("is-compressed");
      } else {
        bodyEl.classList.remove("is-compressed");
      }
    }
    if (btnEl) {
      if (isCompressed) {
        btnEl.classList.add("is-compressed");
        btnEl.innerHTML = "👁️ Ver";
      } else {
        btnEl.classList.remove("is-compressed");
        btnEl.innerHTML = "👁️ Comprimir";
      }
    }
    if (!isCompressed && targetId === "sec-body-spot-chart" && pnlChart) {
      setTimeout(() => { try { pnlChart.resize(); } catch {} }, 60);
    }
    if (!isCompressed && targetId === "sec-body-crossover" && crossoverChart) {
      setTimeout(() => { try { crossoverChart.resize(); } catch {} }, 60);
    }
  }

  function syncMasterEyeButton(compressedSet) {
    const masterBtn = document.getElementById("btn-master-eye-clean");
    if (!masterBtn) return;
    const noiseTargets = [
      "sec-body-session",
      "sec-body-wallet",
      "sec-body-recovery",
      "sec-body-crossover",
      "sec-body-spot-chart",
      "sec-body-strat-guide"
    ];
    const allCompressed = noiseTargets.every(id => compressedSet.has(id));
    if (allCompressed) {
      masterBtn.classList.add("is-compressed");
      masterBtn.innerHTML = "👁️ Expandir Todo";
    } else {
      masterBtn.classList.remove("is-compressed");
      masterBtn.innerHTML = "👁️ Modo Sin Ruido";
    }
  }

  function initEyeCollapsibleSections() {
    const compressedSet = loadCompressedSet();
    const eyeBtns = document.querySelectorAll(".btn-eye-toggle[data-eye-target]");

    eyeBtns.forEach(btn => {
      const targetId = btn.getAttribute("data-eye-target");
      if (!targetId) return;
      applySectionEyeState(targetId, compressedSet.has(targetId));

      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const currentSet = loadCompressedSet();
        const willCompress = !currentSet.has(targetId);
        if (willCompress) {
          currentSet.add(targetId);
        } else {
          currentSet.delete(targetId);
        }
        saveCompressedSet(currentSet);
        applySectionEyeState(targetId, willCompress);
        syncMasterEyeButton(currentSet);
      });
    });

    syncMasterEyeButton(compressedSet);
  }

  window.toggleMasterCleanView = function () {
    const currentSet = loadCompressedSet();
    const noiseTargets = [
      "sec-body-session",
      "sec-body-wallet",
      "sec-body-recovery",
      "sec-body-crossover",
      "sec-body-spot-chart",
      "sec-body-strat-guide"
    ];
    const allCompressed = noiseTargets.every(id => currentSet.has(id));

    if (allCompressed) {
      // Expandir todo
      const allButtons = document.querySelectorAll(".btn-eye-toggle[data-eye-target]");
      allButtons.forEach(btn => {
        const id = btn.getAttribute("data-eye-target");
        if (id) {
          currentSet.delete(id);
          applySectionEyeState(id, false);
        }
      });
    } else {
      // Comprimir paneles secundarios para dejar vista limpia
      noiseTargets.forEach(id => {
        currentSet.add(id);
        applySectionEyeState(id, true);
      });
    }
    saveCompressedSet(currentSet);
    syncMasterEyeButton(currentSet);
  };

  initEyeCollapsibleSections();
  initTabNavigation();
  initCrossoverModule();
  tick();
})();