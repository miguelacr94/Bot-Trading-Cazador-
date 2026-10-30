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
    card.dataset.id = p.id || p.symbol;
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
      <div class="pos-lock-floor-box" data-f="lockfloorbox" style="margin-top:10px; padding:8px; border-radius:8px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.06); display:none; align-items:center; justify-content:space-between;">
        <div>
          <div style="font-size:11px; font-weight:700; color:var(--text-dim); text-transform:uppercase; letter-spacing:0.5px;">🔒 Asegurar Piso</div>
          <div style="font-size:11px; color:var(--text-muted);" data-f="lockfloordesc">Sin piso amarrado</div>
        </div>
        <button class="btn-lock-floor" data-f="btnlockfloor" style="background:linear-gradient(135deg, #10b981, #059669); color:#fff; border:none; padding:5px 10px; border-radius:6px; font-size:11px; font-weight:700; cursor:pointer; display:flex; align-items:center; gap:4px;">
          🔒 Asegurar Ganancia
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

    const stratName = p.strategy === "centinela_alpha" ? "🤖 Alpha (20%)" : (p.lotIndex > 1 ? `🛡️ Lote #${p.lotIndex}` : "🏹 Lote 1");
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
    const lockBox = f("lockfloorbox");
    const isPositiveGain = (p.gainPct || 0) > 0.05;

    if (lockBox) {
      if (!isPositiveGain) {
        // En negativo o breakeven: OCULTAR COMPLETAMENTE EL BOTÓN
        lockBox.style.display = "none";
      } else {
        // En positivo: MOSTRAR EL BOTÓN
        lockBox.style.display = "flex";

        const curG = p.gainPct || 0;
        const curGStr = "+" + curG.toFixed(2) + "%";
        const hasFloor = p.lockedFloorGainPct && p.lockedFloorGainPct > 0;

        if (hasFloor) {
          setText(f("lockfloordesc"), `🛡️ Piso actual: +${p.lockedFloorGainPct.toFixed(2)}%`);
          setStyle(f("lockfloordesc"), "color", "var(--accent-green)");
          if (f("btnlockfloor")) {
            setText(f("btnlockfloor"), `🔒 Elevar Piso (${curGStr})`);
            setStyle(f("btnlockfloor"), "background", "linear-gradient(135deg, #059669, #047857)");
            setStyle(f("btnlockfloor"), "border", "1px solid var(--accent-green)");
            setStyle(f("btnlockfloor"), "color", "#fff");
          }
        } else {
          setText(f("lockfloordesc"), `Ganancia en vivo: ${curGStr}`);
          setStyle(f("lockfloordesc"), "color", "var(--accent-green)");
          if (f("btnlockfloor")) {
            setText(f("btnlockfloor"), `🔒 Asegurar ${curGStr}`);
            setStyle(f("btnlockfloor"), "background", "linear-gradient(135deg, #10b981, #059669)");
            setStyle(f("btnlockfloor"), "border", "none");
            setStyle(f("btnlockfloor"), "color", "#fff");
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

    const existing = new Map();
    box.querySelectorAll(".position-card").forEach((c) => existing.set(c.dataset.id || c.dataset.symbol, c));

    list.forEach((p) => {
      const cardKey = p.id || p.symbol;
      let card = existing.get(cardKey);
      if (!card) { card = createPositionCard(p); box.appendChild(card); }
      updatePositionCard(card, p);
      existing.delete(cardKey);
    });
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
        if (badgeSl) badgeSl.textContent = `🛑 SL -${parseFloat(s.stopLossPct).toFixed(1)}%`;
      }
      if (s.stopLossEnabled !== undefined && toggleSl) {
        toggleSl.checked = s.stopLossEnabled;
        if (badgeSl) {
          badgeSl.style.opacity = s.stopLossEnabled ? "1" : "0.4";
          if (!s.stopLossEnabled) badgeSl.textContent = "🛑 SL OFF";
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
      const tFutures = document.getElementById("toggle-futures");
      const cardFutures = document.getElementById("card-strat-futures");
      if (tFutures && s.futures !== undefined) {
        tFutures.checked = !!s.futures;
        if (cardFutures) {
          if (s.futures) cardFutures.classList.add("active-strat");
          else cardFutures.classList.remove("active-strat");
        }
      }
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

    document.getElementById("toggle-trailing")?.addEventListener("change", () => toggleStrategy("trailing_rebound"));
    document.getElementById("toggle-dca")?.addEventListener("change", () => toggleStrategy("smart_dca"));
    document.getElementById("toggle-grid")?.addEventListener("change", () => toggleStrategy("micro_grid"));
    document.getElementById("toggle-weekend")?.addEventListener("change", () => toggleStrategy("cazador_weekend"));
    document.getElementById("toggle-futures")?.addEventListener("change", () => toggleStrategy("futures"));

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
          btn.innerHTML = "ℹ️ Info ▾";
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
          btn.innerHTML = "ℹ️ Ocultar ▴";
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
          cardBtn.innerHTML = isOpen ? "ℹ️ Ocultar ▴" : "ℹ️ Info ▾";
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

  // Controladores del Laboratorio de Futuros (lab-...)
  const labModeSim = document.getElementById("lab-fut-mode-sim");
  const labModeReal = document.getElementById("lab-fut-mode-real");
  const labCapital = document.getElementById("lab-fut-capital");
  const labMargin = document.getElementById("lab-fut-margin");
  const labLev = document.getElementById("lab-fut-lev");
  const labSaveBtn = document.getElementById("lab-btn-save-cfg");
  const labResetBtn = document.getElementById("lab-btn-reset-100");

  async function executeFuturesConfigChange(isSim, margin, capital, levMode) {
    try {
      const payload = {
        isSimulated: isSim,
        marginPerTrade: margin,
        startingBalance: capital,
        leverageMode: levMode,
        enabled: enabled !== undefined ? enabled : (document.getElementById("toggle-futures")?.checked ?? true)
      };
      const res = await fetch("/api/futures/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.success) {
        if (labSaveBtn) {
          labSaveBtn.textContent = "✅ ¡Cambios Guardados!";
          setTimeout(() => labSaveBtn.textContent = "💾 Guardar Cambios", 2000);
        }
        // Actualizar visualmente capital inicial y balance de inmediato
        const initEl = document.getElementById("fut-dev-init-capital");
        const curEl = document.getElementById("fut-dev-cur-balance");
        if (initEl) initEl.textContent = "$" + capital.toFixed(2) + " USDT";
        if (curEl && isSim) curEl.textContent = "$" + capital.toFixed(2) + " USDT";
      }
    } catch(e) {
      console.error("Error guardando:", e);
    }
  }

  if (labModeSim && labModeReal) {
    labModeSim.addEventListener("click", () => {
      labModeSim.style.background = "#8b5cf6";
      labModeSim.style.color = "#fff";
      labModeReal.style.background = "transparent";
      labModeReal.style.color = "#94a3b8";
      executeFuturesConfigChange(true, parseFloat(labMargin?.value || "15"), parseFloat(labCapital?.value || "100"), labLev?.value || "dynamic");
    });

    labModeReal.addEventListener("click", () => {
      const ok = confirm("⚠️ ATENCIÓN: Vas a activar el modo REAL de Futuros en Binance.\n\nEl bot operará con dinero real a 2x-4x ISOLATED con margen de " + (labMargin?.value || "15") + " USDT.\n\n¿Deseas activar el modo REAL?");
      if (ok) {
        labModeReal.style.background = "#f59e0b";
        labModeReal.style.color = "#000";
        labModeSim.style.background = "transparent";
        labModeSim.style.color = "#94a3b8";
        executeFuturesConfigChange(false, parseFloat(labMargin?.value || "15"), parseFloat(labCapital?.value || "100"), labLev?.value || "dynamic");
      }
    });
  }

  if (labSaveBtn) {
    labSaveBtn.addEventListener("click", () => {
      const isSim = labModeSim && labModeSim.style.background === "rgb(139, 92, 246)";
      executeFuturesConfigChange(isSim, parseFloat(labMargin?.value || "15"), parseFloat(labCapital?.value || "100"), labLev?.value || "dynamic");
    });
  }

  if (labResetBtn) {
    labResetBtn.addEventListener("click", async () => {
      const ok = confirm("¿Deseas reiniciar la simulación con $100.00 USDT limpios y margen estándar de $15 USDT?");
      if (ok) {
        try {
          await fetch("/api/futures/config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reset: true, startingBalance: 100, marginPerTrade: 15, leverageMode: "dynamic" })
          });
          if (labCapital) labCapital.value = "100";
          if (labMargin) labMargin.value = "15";
          const initEl = document.getElementById("fut-dev-init-capital");
          const curEl = document.getElementById("fut-dev-cur-balance");
          if (initEl) initEl.textContent = "$100.00 USDT";
          if (curEl) curEl.textContent = "$100.00 USDT";
          labResetBtn.textContent = "✅ ¡Iniciado en $100!";
          setTimeout(() => labResetBtn.textContent = "🔄 Iniciar con $100 USDT", 2000);
        } catch(e) {}
      }
    });
  }


  const btnReset100 = document.getElementById("btn-reset-fut-100");
  if (btnReset100) {
    btnReset100.addEventListener("click", async () => {
      const ok = confirm("¿Deseas reiniciar la simulación de Futuros con $100.00 USDT limpios y margen estándar de $15 USDT?");
      if (ok) {
        try {
          await fetch("/api/futures/config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reset: true, startingBalance: 100, marginPerTrade: 15, leverageMode: "dynamic" })
          });
          btnReset100.textContent = "✅ ¡Iniciado en $100!";
          setTimeout(() => btnReset100.textContent = "🔄 Iniciar con $100 USDT", 2000);
        } catch(e) {}
      }
    });
  }


  // Control de Modo Simulado vs Real y Margen de Futuros
  const btnModeSim = document.getElementById("btn-fut-mode-sim");
  const btnModeReal = document.getElementById("btn-fut-mode-real");
  const inputFutCapital = document.getElementById("input-fut-capital");
  const inputFutMargin = document.getElementById("input-fut-margin");
  const selectFutLev = document.getElementById("select-fut-lev");
  const btnSaveFutCfg = document.getElementById("btn-save-fut-config");

  async function updateFuturesConfig(isSim, margin, capital, levMode, enabled) {
    try {
      const payload = {
        isSimulated: isSim,
        marginPerTrade: margin,
        startingBalance: capital,
        leverageMode: levMode
      };
      const res = await fetch("/api/futures/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.success) {
        if (btnSaveFutCfg) {
          btnSaveFutCfg.textContent = "✅ ¡Parámetros Aplicados!";
          btnSaveFutCfg.style.background = "rgba(16,185,129,0.5)";
          setTimeout(() => {
            btnSaveFutCfg.textContent = "💾 Aplicar Cambios";
            btnSaveFutCfg.style.background = "rgba(16,185,129,0.25)";
          }, 2500);
        }
      }
    } catch (e) {
      console.error("Error guardando config de futuros:", e);
    }
  }

  if (btnModeSim && btnModeReal) {
    btnModeSim.addEventListener("click", () => {
      btnModeSim.style.background = "#8b5cf6";
      btnModeSim.style.color = "#fff";
      btnModeReal.style.background = "transparent";
      btnModeReal.style.color = "#94a3b8";
      updateFuturesConfig(true, parseFloat(inputFutMargin?.value || "15"), parseFloat(inputFutCapital?.value || "100"), selectFutLev?.value || "dynamic");
    });

    btnModeReal.addEventListener("click", () => {
      const ok = confirm("⚠️ ATENCIÓN: Vas a activar el modo REAL de Futuros en Binance.\n\nEl bot operará con dinero real de tu billetera de Futuros a 2x ISOLATED con margen estándar de " + (inputFutMargin?.value || "10") + " USDT.\n\n¿Deseas activar el modo REAL?");
      if (ok) {
        btnModeReal.style.background = "#f59e0b";
        btnModeReal.style.color = "#000";
        btnModeSim.style.background = "transparent";
        btnModeSim.style.color = "#94a3b8";
        updateFuturesConfig(false, parseFloat(inputFutMargin?.value || "15"), parseFloat(inputFutCapital?.value || "100"), selectFutLev?.value || "dynamic");
      }
    });
  }

  if (btnSaveFutCfg) {
    btnSaveFutCfg.addEventListener("click", () => {
      const isSim = btnModeSim && btnModeSim.style.background === "rgb(139, 92, 246)";
      const isEnabled = document.getElementById("toggle-futures") ? document.getElementById("toggle-futures").checked : true;
      updateFuturesConfig(isSim, parseFloat(inputFutMargin?.value || "15"), parseFloat(inputFutCapital?.value || "100"), selectFutLev?.value || "dynamic", isEnabled);
    });
  }

  }, 1000);

  // Renderizar Telemetría del Laboratorio de Futuros (Modo Dev)
  function renderFuturesTelemetry(fut) {
    if (!fut) return;

    // A. Estadísticas Globales
    const stats = fut.stats || {};
    const initEl = document.getElementById("fut-dev-init-capital");
    if (initEl) initEl.textContent = "$" + (stats.startingBalanceUsdt || 100).toFixed(2) + " USDT";

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

    // Actualizar barra de recuperación Centinela Alpha
    const tracker = d.recoveryTracker || { targetUsdt: 100.00, recoveredUsdt: 6.11, tradesCount: 8 };
    const target = tracker.targetUsdt || 100.00;
    const recovered = tracker.recoveredUsdt || 0;
    const pct = Math.min(100, Math.max(0, (recovered / target) * 100));
    const remaining = Math.max(0, target - recovered);

    const barEl = $("recovery-progress-bar");
    const statsEl = $("recovery-stats-text");
    const remEl = $("recovery-remaining-text");

    if (barEl) barEl.style.width = pct.toFixed(1) + "%";
    if (statsEl) statsEl.innerHTML = `+${recovered.toFixed(2)} / ${target.toFixed(2)} USDT (${pct.toFixed(0)}%)`;
    if (remEl) {
      if (remaining <= 0) {
        remEl.innerHTML = `<span style="color:#10b981; font-weight:700;">✅ ¡DEUDA 100% SALDADA!</span>`;
      } else {
        remEl.textContent = `Faltan ${remaining.toFixed(2)} USDT para saldar (${tracker.tradesCount || 0} operaciones cerradas)`;
      }
    }

      
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
        futBadge.textContent = isSim ? "🧪 SIM" : "⚡ REAL";
        futBadge.style.background = isSim ? "rgba(139, 92, 246, 0.2)" : "rgba(16, 185, 129, 0.2)";
        futBadge.style.color = isSim ? "#c4b5fd" : "#34d399";
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
  initTabNavigation();
  tick();
})();