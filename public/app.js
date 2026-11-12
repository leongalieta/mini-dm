const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

let state = null;
let tokenInfo = null;
let logFilter = { q: "", status: "", rule: "", page: 1, pageSize: 50 };

const esc = (s) =>
  String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const timeAgo = (iso) => {
  if (!iso) return "";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 45) return "agora";
  if (diff < 3600) return `${Math.round(diff / 60)} min`;
  if (diff < 86400) return `${Math.round(diff / 3600)} h`;
  return new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) }
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* vazio */
  }
  if (!res.ok) throw new Error(data.error || `Falha (${res.status})`);
  return data;
}

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), 2600);
}

function setAccountChip() {
  const acc = state?.account || {};
  const name = acc.username || acc.error ? acc.username || "conta" : "conta";
  $("#account-name").textContent = acc.username ? `@${acc.username}` : "sem conta";
  $("#avatar").textContent = (acc.username || "?")[0]?.toUpperCase() || "?";
  const dot = $("#status-dot");
  dot.className = "dot";

  if (tokenInfo?.ok) {
    dot.classList.add("ok");
    $("#account-sub").textContent = `conectada · ${tokenInfo.followers ?? 0} seguidores`;
  } else if (tokenInfo?.expired) {
    dot.classList.add("err");
    $("#account-sub").textContent = "token expirado — reconectar";
  } else if (tokenInfo && !tokenInfo.ok) {
    dot.classList.add("err");
    $("#account-sub").textContent = "sem conexão com a Meta";
  } else if (acc.error) {
    dot.classList.add("err");
    $("#account-sub").textContent = "credenciais não encontradas";
  } else {
    dot.classList.add("ok");
    $("#account-sub").textContent = "verificando conexão…";
  }
}

function renderStats() {
  const rules = state.rules || [];
  const log = state.log || [];
  const liveNow = !state.settings.dryRun && state.poller.running;
  $("#stat-rules").textContent = rules.filter((r) => r.active).length;
  $("#stat-log").textContent = log.length;
  $("#stat-dm").textContent = log.filter((l) => l.status === "enviado" || l.status === "simulado").length;

  const mode = $("#stat-mode");
  const sub = $("#stat-mode-sub");
  mode.parentElement.classList.toggle("live", liveNow);
  if (state.settings.dryRun) {
    mode.textContent = "Simulação";
    sub.textContent = "nada é enviado de verdade";
  } else if (liveNow) {
    mode.textContent = "Ao vivo";
    sub.textContent = "lendo comentários e enviando DMs";
  } else {
    mode.textContent = "Manual";
    sub.textContent = "ao vivo desligado";
  }

  $("#poller-info").textContent = state.poller?.lastRun
    ? `Última leitura ${timeAgo(state.poller.lastRun)} atrás${state.poller.lastSummary ? " · " + state.poller.lastSummary : ""}`
    : "";
}

const channelLabel = (rule) => {
  const channel = rule.channel || "comment";
  if (channel === "dm") return "Direct";
  if (channel === "both") return "Comentário + Direct";
  return "Comentário";
};

function ruleTemplate(rule) {
  return `
    <article class="rule ${rule.active ? "" : "off"}" data-id="${esc(rule.id)}">
      <div class="rule-top">
        <span class="rule-name">${esc(rule.name)}</span>
        <span class="badge ${rule.active ? "on" : ""}">${rule.active ? "ativa" : "pausada"}</span>
      </div>
      <div class="chips">
        <span class="chip channel">${esc(channelLabel(rule))}</span>
        ${(rule.keywords || []).map((k) => `<span class="chip">${esc(k)}</span>`).join("")}
      </div>
      <div class="preview">${esc(rule.dmText)}</div>
      <div class="rule-actions">
        <button class="ghost" data-act="toggle">${rule.active ? "Pausar" : "Ativar"}</button>
        <button class="ghost" data-act="edit">Editar</button>
        <button class="ghost" data-act="del">Excluir</button>
      </div>
    </article>`;
}

function renderRules() {
  const list = $("#rules-list");
  list.innerHTML = (state.rules || []).map(ruleTemplate).join("");
  $("#rules-empty").hidden = (state.rules || []).length > 0;
}

async function loadLogs() {
  try {
    const q = new URLSearchParams();
    if (logFilter.q) q.set("q", logFilter.q);
    if (logFilter.status) q.set("status", logFilter.status);
    if (logFilter.rule) q.set("rule", logFilter.rule);
    q.set("page", logFilter.page);
    q.set("pageSize", logFilter.pageSize);
    const result = await api("/api/log/filter?" + q);
    return result;
  } catch (e) {
    console.error(e);
    return { items: [], total: 0, page: 1, pageSize: 50, totalPages: 1 };
  }
}

function renderLog(items) {
  const list = $("#log-list");
  if (!items || !items.length) {
    list.innerHTML = "";
    $("#log-empty").hidden = false;
    return;
  }
  list.innerHTML = items
    .map((item) => {
      const initials = (item.username || "?").replace("@", "")[0]?.toUpperCase() || "?";
      return `
        <div class="log-item">
          <div class="log-avatar">${esc(initials)}</div>
          <div class="log-body">
            <div class="log-line">${item.username ? "@" + esc(item.username) + " · " : ""}${esc(item.comment || item.detail || "—")}</div>
            <div class="log-meta">
              <span class="pill ${esc(item.status)}">${esc(item.status)}</span>
              ${item.ruleName ? " " + esc(item.ruleName) : ""}
              ${item.keyword ? " · " + esc(item.keyword) : ""}
              · ${timeAgo(item.at)}
            </div>
          </div>
        </div>`;
    })
    .join("");
  $("#log-empty").hidden = true;
}

function renderLogControls(total) {
  const wrap = $("#log-controls");
  if (!wrap) return;
  const totalPages = Math.ceil(total / logFilter.pageSize);
  wrap.innerHTML = `
    <div class="log-pagination">
      <span>Página <strong>${logFilter.page}</strong> de <strong>${Math.max(1, totalPages)}</strong> · ${total} registro(s)</span>
      <div class="log-pages">
        <button class="ghost small" ${logFilter.page <= 1 ? "disabled" : ""} onclick="prevPage()">◀ Anterior</button>
        <button class="ghost small" ${logFilter.page >= totalPages || totalPages <= 1 ? "disabled" : ""} onclick="nextPage()">Próximo ▶</button>
      </div>
    </div>
  <div class="log-filters" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px">
    <input type="text" id="log-search" placeholder="Buscar..." value="${esc(logFilter.q || "")}">
    <select id="log-status-filter"><option value="">Todos os status</option><option value="enviado" ${logFilter.status === "enviado" ? "selected" : ""}>Enviado</option><option value="simulado" ${logFilter.status === "simulado" ? "selected" : ""}>Simulado</option><option value="erro" ${logFilter.status === "erro" ? "selected" : ""}>Erro</option></select>
    <select id="log-rule-filter"><option value="">Todas as regras</option></select>
  </div>
`;
  $("#log-search")?.addEventListener("input", (e) => { logFilter.q = e.target.value; logFilter.page = 1; refreshLogs(); });
  $("#log-status-filter")?.addEventListener("change", (e) => { logFilter.status = e.target.value; logFilter.page = 1; refreshLogs(); });
  $("#log-rule-filter")?.addEventListener("change", (e) => { logFilter.rule = e.target.value; logFilter.page = 1; refreshLogs(); });
}

async function refreshLogs() {
  renderLogHeader();
  const result = await loadLogs();
  renderLog(result.items);
  renderLogControls(result.total);
}

window.prevPage = async () => { if (logFilter.page > 1) { logFilter.page--; await refreshLogs(); } };
window.nextPage = async () => { logFilter.page++; await refreshLogs(); };

function renderLogHeader() {
  const wrap = $("#log-list");
  if (!wrap) return;
  const existing = wrap.querySelector(".log-controls-wrap");
  if (existing) return;
  const div = document.createElement("div");
  div.className = "log-controls-wrap";
  div.innerHTML = `<div id="log-filters"></div><div id="log-controls"></div>`;
  wrap.parentNode.insertBefore(div, wrap.nextSibling);
}

async function render() {
  if (!state) return;
  setAccountChip();
  renderStats();
  renderRules();
  await refreshLogs();
  updateLiveButton();
}

async function loadRulesForFilter() {
  try {
    const res = await api("/api/rules-list");
    const rules = res.rules || [];
    const sel = $("#log-rule-filter");
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">Todas as regras</option>' + rules.map((r) => `<option value="${esc(r)}" ${r === logFilter.rule ? "selected" : ""}>${esc(r)}</option>`).join("");
    sel.value = cur || "";
  } catch (e) { console.error(e); }
}

function updateLiveButton() {
  const s = state.settings || {};
  const live = !s.dryRun && state.poller?.running;
  const btn = $("#btn-live");
  if (!btn) return;
  btn.textContent = live ? "Desligar" : "Ligar";
  btn.classList.toggle("on", live);
  $("#live-sub").textContent = s.dryRun
    ? "Desligue a simulação para poder ligar"
    : live
      ? "Ligado: lendo comentários novos"
      : "Lê comentários novos e envia as DMs";
}

function fillSettings() {
  const s = state.settings || {};
  $("#set-account").value = s.accountUsername || "";
  $("#set-poll").value = s.pollSeconds || 60;
  $("#set-media").value = s.maxMediaPerPoll || 3;
  $("#set-public").checked = Boolean(s.replyPublic);
  $("#set-dry").checked = Boolean(s.dryRun);
  updateLiveButton();
}

async function refresh(showError = false) {
  try {
    state = await api("/api/state");
    render();
  } catch (err) {
    if (showError) toast(err.message);
  }
}

async function checkConnection() {
  try {
    tokenInfo = await api("/api/check", { method: "POST" });
  } catch (err) {
    tokenInfo = { ok: false, message: err.message };
  }
  setAccountChip();
  if (tokenInfo?.expired) {
    toast("Token expirado: reconecte a conta Meta para o modo ao vivo funcionar.");
  }
}

function openRule(rule) {
  $("#rule-title").textContent = rule ? "Editar regra" : "Nova regra";
  $("#rule-id").value = rule?.id || "";
  $("#rule-name").value = rule?.name || "";
  $("#rule-channel").value = rule?.channel || "comment";
  $("#rule-keywords").value = (rule?.keywords || []).join(", ");
  $("#rule-public").value = rule?.publicReply || "Te chamei no direct, {{username}}!";
  $("#rule-dm").value = rule?.dmText || "";
  $("#rule-active").checked = rule ? Boolean(rule.active) : true;
  $("#rule-overlay").hidden = false;
  setTimeout(() => $("#rule-name").focus(), 30);
}

function closeRule() {
  $("#rule-overlay").hidden = true;
}

$("#btn-new-rule").addEventListener("click", () => openRule(null));
$("#btn-close-rule").addEventListener("click", closeRule);
$("#btn-cancel-rule").addEventListener("click", closeRule);
$("#rule-overlay").addEventListener("click", (e) => {
  if (e.target === $("#rule-overlay")) closeRule();
});

$("#rule-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = {
    id: $("#rule-id").value || undefined,
    name: $("#rule-name").value,
    channel: $("#rule-channel").value,
    keywords: $("#rule-keywords").value,
    publicReply: $("#rule-public").value,
    dmText: $("#rule-dm").value,
    active: $("#rule-active").checked
  };
  try {
    await api("/api/rules", { method: "POST", body: JSON.stringify(payload) });
    closeRule();
    await refresh(true);
    toast("Regra salva.");
  } catch (err) {
    toast(err.message);
  }
});

$("#rules-list").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const card = btn.closest(".rule");
  const rule = state.rules.find((r) => r.id === card.dataset.id);
  if (!rule) return;
  const act = btn.dataset.act;
  try {
    if (act === "edit") return openRule(rule);
    if (act === "del") {
      if (!confirm(`Excluir a regra "${rule.name}"?`)) return;
      await api(`/api/rules/${encodeURIComponent(rule.id)}`, { method: "DELETE" });
      await refresh(true);
      toast("Regra excluída.");
      return;
    }
    if (act === "toggle") {
      await api("/api/rules", {
        method: "POST",
        body: JSON.stringify({ ...rule, active: !rule.active })
      });
      await refresh(true);
    }
  } catch (err) {
    toast(err.message);
  }
});

$("#test-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("#test-text").value.trim();
  const channel = $("#test-channel").value === "dm" ? "dm" : "comment";
  if (!text) return toast(channel === "dm" ? "Escreva uma mensagem para testar." : "Escreva um comentário para testar.");
  const box = $("#test-result");
  try {
    const result = await api("/api/test", {
      method: "POST",
      body: JSON.stringify({ text, channel, username: $("#test-user").value.trim() })
    });
    box.hidden = false;
    if (!result.matched) {
      box.innerHTML = `<h3>Nenhuma regra bateu</h3><p class="preview">${
        channel === "dm"
          ? "Nenhuma regra de direct tem essa palavra-chave ativa. Ajuste as palavras ou crie uma regra com “Onde a regra responde” em Direct."
          : "Esse comentário não tem nenhuma palavra-chave ativa de comentário. Ajuste as palavras ou crie uma regra nova."
      }</p>`;
    } else if (channel === "dm") {
      box.innerHTML = `
        <h3>Regra: ${esc(result.rule.name)} · palavra “${esc(result.keyword)}”</h3>
        <div class="bubble dm"><small>Resposta automática no direct</small>${esc(result.dmText)}</div>`;
    } else {
      box.innerHTML = `
        <h3>Regra: ${esc(result.rule.name)} · palavra “${esc(result.keyword)}”</h3>
        <div class="bubble public"><small>Resposta pública no comentário</small>${esc(result.publicReply)}</div>
        <div class="bubble dm"><small>Mensagem no direct</small>${esc(result.dmText)}</div>`;
    }
    await refresh();
  } catch (err) {
    toast(err.message);
  }
});

// ---------- Exportar logs ----------
async function exportLogs() {
  try {
    const res = await fetch("/api/log/export");
    if (!res.ok) throw new Error("Falha ao exportar");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "mini-dm-logs.csv";
    a.click();
    URL.revokeObjectURL(url);
    toast("Logs exportados.");
  } catch (err) {
    toast(err.message);
  }
}

async function exportStats() {
  try {
    const res = await fetch("/api/stats/export");
    if (!res.ok) throw new Error("Falha ao exportar estatísticas");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "mini-dm-estatisticas.csv";
    a.click();
    URL.revokeObjectURL(url);
    toast("Estatísticas exportadas.");
  } catch (err) {
    toast(err.message);
  }
}

// ---------- Estatísticas ----------
async function loadStats() {
  try {
    const s = await api("/api/stats");
    $("#stat-total-rules").textContent = s.totalRules;
    $("#stat-active-rules").textContent = s.activeRules;
    $("#stat-total-log").textContent = s.totalLog;
    $("#stat-sent").textContent = s.sentLog;
    $("#stat-simulated").textContent = s.simulatedLog;
    $("#stat-error").textContent = s.errorLog;

    const rulesList = $("#stats-by-rule");
    rulesList.innerHTML = Object.entries(s.byRule || {})
      .map(([name, d]) => `<tr><td>${esc(name)}</td><td>${d.total}</td><td>${d.enviado}</td><td>${d.simulado}</td><td>${d.erro}</td></tr>`)
      .join("");

    const daysList = $("#stats-by-day");
    daysList.innerHTML = s.days
      .map(([day, count]) => `<tr><td>${day}</td><td>${count}</td></tr>`)
      .join("");

    $("#stat-pending-schedules").textContent = s.pendingSchedules;
    $("#stat-sent-schedules").textContent = s.sentSchedules;
  } catch (e) { console.error(e); }
}

// ---------- Agendamentos ----------
async function loadSchedules() {
  try {
    const d = await api("/api/schedules");
    const list = $("#schedules-list");
    const schedules = d.schedules || [];
    list.innerHTML = schedules
      .map((s) => {
        const statusClass = s.status === "pending" ? "pending" : s.status === "sent" ? "sent" : s.status === "cancelled" ? "cancelled" : "error";
        return `
          <div class="schedule-item" onclick="openEditSchedule('${esc(s.id)}')">
            <div class="schedule-info">
              <div class="schedule-user">@${esc(s.username || "—")}</div>
              <div class="schedule-msg">${esc(s.comment || "")}</div>
              <div class="schedule-meta">
                <span class="pill ${statusClass}">${esc(s.status)}</span>
                <span>${new Date(s.runAt).toLocaleString("pt-BR")}</span>
                <span>${esc(s.channel)}</span>
              </div>
            </div>
            <div class="schedule-actions">
              <button class="ghost small" onclick="event.stopPropagation(); cancelSchedule('${esc(s.id)}')">Cancelar</button>
              ${s.status === "pending" ? `<button class="ghost small" onclick="event.stopPropagation(); openEditSchedule('${esc(s.id)}')">Editar</button>` : ""}
            </div>
          </div>`;
      })
      .join("");
    $("#schedules-empty").hidden = schedules.length > 0;
  } catch (e) { console.error(e); }
}

async function saveSchedule() {
  const username = $("#sched-user").value.trim();
  const comment = $("#sched-msg").value.trim();
  const channel = $("#sched-channel").value;
  const runAt = $("#sched-at").value;
  if (!username || !comment || !runAt) return toast("Preencha usuário, mensagem e data/hora.");
  try {
    await api("/api/schedules", {
      method: "POST",
      body: JSON.stringify({ username, comment, channel, runAt })
    });
    $("#schedule-overlay").hidden = true;
    $("#sched-form").reset();
    await loadSchedules();
    await loadStats();
    toast("Agendado.");
  } catch (err) { toast(err.message); }
}

async function cancelSchedule(id) {
  if (!confirm("Cancelar este agendamento?")) return;
  try {
    await api(`/api/schedules/${id}/cancel`, { method: "POST" });
    await loadSchedules();
    await loadStats();
    toast("Agendamento cancelado.");
  } catch (err) { toast(err.message); }
}

async function openEditSchedule(id) {
  try {
    const d = await api("/api/schedules");
    const s = (d.schedules || []).find((x) => x.id === id);
    if (!s) return;
    $("#edit-sched-id").value = s.id;
    $("#edit-sched-user").value = s.username || "";
    $("#edit-sched-msg").value = s.comment || "";
    $("#edit-sched-channel").value = s.channel || "dm";
    $("#edit-sched-at").value = s.runAt ? s.runAt.slice(0, 16) : "";
    $("#edit-schedule-overlay").hidden = false;
  } catch (err) { toast(err.message); }
}

async function saveEditSchedule() {
  const id = $("#edit-sched-id").value;
  const username = $("#edit-sched-user").value.trim();
  const comment = $("#edit-sched-msg").value.trim();
  const channel = $("#edit-sched-channel").value;
  const runAt = $("#edit-sched-at").value;
  if (!username || !comment || !runAt) return toast("Preencha usuário, mensagem e data/hora.");
  try {
    await api(`/api/schedules/${id}`, {
      method: "PUT",
      body: JSON.stringify({ username, comment, channel, runAt })
    });
    $("#edit-schedule-overlay").hidden = true;
    await loadSchedules();
    await loadStats();
    toast("Agendamento atualizado.");
  } catch (err) { toast(err.message); }
}

async function deleteSchedule() {
  const id = $("#edit-sched-id").value;
  if (!confirm("Excluir este agendamento?")) return;
  try {
    await api(`/api/schedules/${id}`, { method: "DELETE" });
    $("#edit-schedule-overlay").hidden = true;
    await loadSchedules();
    await loadStats();
    toast("Agendamento excluído.");
  } catch (err) { toast(err.message); }
}

function openSettings() {
  fillSettings();
  $("#settings-overlay").hidden = false;
}

$("#btn-settings").addEventListener("click", openSettings);
$("#btn-close-settings").addEventListener("click", () => ($("#settings-overlay").hidden = true));
$("#btn-cancel-settings").addEventListener("click", () => ($("#settings-overlay").hidden = true));
$("#settings-overlay").addEventListener("click", (e) => {
  if (e.target === $("#settings-overlay")) $("#settings-overlay").hidden = true;
});

$("#settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/api/settings", {
      method: "POST",
      body: JSON.stringify({
        accountUsername: $("#set-account").value.trim(),
        pollSeconds: Number($("#set-poll").value) || 60,
        maxMediaPerPoll: Number($("#set-media").value) || 3,
        replyPublic: $("#set-public").checked,
        dryRun: $("#set-dry").checked
      })
    });
    await refresh(true);
    await checkConnection();
    toast("Configurações salvas.");
  } catch (err) {
    toast(err.message);
  }
});

$("#btn-live").addEventListener("click", async () => {
  const isLive = !state.settings.dryRun && state.poller?.running;
  try {
    const result = await api("/api/live", {
      method: "POST",
      body: JSON.stringify({ enabled: !isLive })
    });
    await refresh(true);
    toast(result.live ? "Modo ao vivo ligado." : "Modo ao vivo desligado.");
  } catch (err) {
    toast(err.message);
  }
});

$("#btn-clear-log").addEventListener("click", async () => {
  try {
    await api("/api/log", { method: "DELETE" });
    await refresh(true);
    $("#test-result").hidden = true;
    toast("Histórico limpo.");
  } catch (err) {
    toast(err.message);
  }
});

$("#btn-refresh").addEventListener("click", async () => {
  await refresh(true);
  await checkConnection();
  toast("Atualizado.");
});

// ---------- Export ----------
$("#btn-export").addEventListener("click", exportLogs);
$("#btn-export-panel").addEventListener("click", exportLogs);

// ---------- Stats ----------
$("#btn-stats").addEventListener("click", () => {
  $("#stats-overlay").hidden = false;
  loadStats();
});
$("#btn-close-stats").addEventListener("click", () => ($("#stats-overlay").hidden = true));
$("#btn-export-stats").addEventListener("click", exportStats);
$("#stats-overlay").addEventListener("click", (e) => {
  if (e.target === $("#stats-overlay")) $("#stats-overlay").hidden = true;
});

// ---------- Schedules ----------
$("#btn-schedules").addEventListener("click", () => {
  $("#schedule-overlay").hidden = false;
  loadSchedules();
});
$("#btn-close-schedule").addEventListener("click", () => ($("#schedule-overlay").hidden = true));
$("#btn-cancel-schedule").addEventListener("click", () => ($("#schedule-overlay").hidden = true));
$("#schedule-overlay").addEventListener("click", (e) => {
  if (e.target === $("#schedule-overlay")) $("#schedule-overlay").hidden = true;
});
$("#sched-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  await saveSchedule();
});

$("#btn-close-edit-schedule").addEventListener("click", () => ($("#edit-schedule-overlay").hidden = true));
$("#btn-close-edit-schedule2").addEventListener("click", () => ($("#edit-schedule-overlay").hidden = true));
$("#edit-schedule-overlay").addEventListener("click", (e) => {
  if (e.target === $("#edit-schedule-overlay")) $("#edit-schedule-overlay").hidden = true;
});
$("#edit-sched-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  await saveEditSchedule();
});
$("#btn-delete-sched").addEventListener("click", deleteSchedule);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeRule();
    $("#settings-overlay").hidden = true;
    $("#schedule-overlay").hidden = true;
    $("#stats-overlay").hidden = true;
    $("#edit-schedule-overlay").hidden = true;
  }
});

(async function init() {
  await refresh(true);
  await checkConnection();
  await loadRulesForFilter();
  await refreshLogs();
  await loadStats();
  await loadSchedules();
  setInterval(refresh, 8000);
  setInterval(loadStats, 30000);
  setInterval(loadSchedules, 30000);
})();
