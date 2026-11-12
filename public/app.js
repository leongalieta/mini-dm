const $ = (sel) => document.querySelector(sel);
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
  const headers = { "content-type": "application/json", ...(options.headers || {}) };
  if (authToken) headers["Authorization"] = "Bearer " + authToken;
  const res = await fetch(path, {
    ...options,
    headers
  });
  let data = {};
  try { data = await res.json(); } catch { /* vazio */ }
  if (res.status === 401) {
    authToken = null;
    authUser = null;
    loginDisabled = false;
    $("#btn-auth-toggle")?.classList.remove("hidden");
    $("#btn-logout")?.classList.add("hidden");
    $("#account-name").textContent = "carregando…";
    $("#login-overlay")?.classList.remove("hidden");
    throw new Error("Sessão expirada. Faça login novamente.");
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

let state = null;
let tokenInfo = null;
let logFilter = { q: "", status: "", rule: "", page: 1, pageSize: 50 };
let authToken = null;
let authUser = null;
let loginDisabled = false;

// ---------- Navegação por views (menu) ----------
function showTab(tab) {
  document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
  document.querySelectorAll(".sidebar-item").forEach((b) => b.classList.remove("active"));
  const btn = $(`#menu-${tab}`);
  if (btn) btn.classList.add("active");
  const view = $(`#view-${tab}`);
  if (view) view.classList.remove("hidden");
  $("#menu-backdrop").hidden = true;
  $("#sidebar").classList.remove("open");

  // Carrega dados específicos de cada tab
  if (tab === "regras") { renderRules(); }
  if (tab === "historico") { refreshLogs(); }
  if (tab === "estatisticas") { loadStats(); }
  if (tab === "agendamentos") { loadSchedules(); }
  if (tab === "ia") { loadAiConfig(); }
  if (tab === "config") { loadSettingsForm(); }
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
}

function closeRule() { $("#rule-overlay").hidden = true; }

// ---------- Auth / conta ----------
function setAccountChip() {
  const acc = state?.account || {};
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

// ---------- Regras ----------
function renderStatusOptions() {
  const f = $("#fStatus");
  if (!f) return;
}

async function loadRules() {
  try {
    state = await api("/api/state");
    renderRules();
  } catch (e) { console.error(e); }
}

function renderRules() {
  const list = $("#rules-list");
  if (!list) return;
  const rules = state?.rules || [];
  list.innerHTML = rules.map(renderRule).join("");
  $("#rules-empty").hidden = rules.length > 0;
}

function renderRule(rule) {
  return `
    <article class="rule ${rule.active ? "" : "off"}" data-id="${esc(rule.id)}">
      <div class="rule-top">
        <span class="rule-name">${esc(rule.name)}</span>
        <span class="badge ${rule.active ? "on" : ""}">${rule.active ? "ativa" : "pausada"}</span>
      </div>
      <div class="chips">
        <span class="chip channel">${rule.channel === "dm" ? "Direct" : rule.channel === "both" ? "Comentário + Direct" : "Comentário"}</span>
        ${(rule.keywords || []).map((k) => `<span class="chip">${esc(k)}</span>`).join("")}
      </div>
      <div class="preview">${esc(rule.dmText)}</div>
      <div class="rule-actions">
        <button class="ghost" data-act="toggle">${rule.active ? "Pausar" : "Ativar"}</button>
        <button class="ghost" data-act="edit">Editar</button>
        <button class="ghost danger" data-act="del">Excluir</button>
      </div>
    </article>`;
}

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
      await loadRules();
      toast("Regra excluída.");
      return;
    }
    if (act === "toggle") {
      await api("/api/rules", { method: "POST", body: JSON.stringify({ ...rule, active: !rule.active }) });
      await loadRules();
    }
  } catch (err) { toast(err.message); }
});

$("#btn-new-rule").addEventListener("click", () => openRule(null));
$("#btn-close-rule").addEventListener("click", closeRule);
$("#btn-cancel-rule").addEventListener("click", closeRule);
$("#rule-overlay").addEventListener("click", (e) => { if (e.target === $("#rule-overlay")) closeRule(); });

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
    await loadRules();
    toast("Regra salva.");
  } catch (err) { toast(err.message); }
});

// ---------- Logs (filtro + paginação) ----------
async function loadLogs() {
  try {
    const q = new URLSearchParams();
    if (logFilter.q) q.set("q", logFilter.q);
    if (logFilter.status) q.set("status", logFilter.status);
    if (logFilter.rule) q.set("rule", logFilter.rule);
    q.set("page", logFilter.page);
    q.set("pageSize", logFilter.pageSize);
    return await api("/api/log/filter?" + q);
  } catch (e) {
    console.error(e);
    return { items: [], total: 0, page: 1, pageSize: 50, totalPages: 1 };
  }
}

function renderLog(items) {
  const list = $("#log-list");
  if (!list) return;
  if (!items || !items.length) {
    list.innerHTML = "";
    $("#log-empty").hidden = false;
    return;
  }
  list.innerHTML = items.map((item) => {
    const initials = (item.username || "?").replace("@", "")[0]?.toUpperCase() || "?";
    return `
      <div class="log-item">
        <div class="log-avatar">${esc(initials)}</div>
        <div class="log-body">
          <div class="log-line">${item.username ? "@" + esc(item.username) + " · " : ""}${esc(item.comment || item.detail || "—")}</div>
          <div class="log-meta"><span class="pill ${esc(item.status)}">${esc(item.status)}</span>${item.ruleName ? " " + esc(item.ruleName) : ""}${item.keyword ? " · " + esc(item.keyword) : ""} · ${timeAgo(item.at)}</div>
        </div>
      </div>`;
  }).join("");
  $("#log-empty").hidden = true;
}

function renderLogControls(total) {
  const wrap = $("#log-controls");
  if (!wrap) return;
  const totalPages = Math.max(1, Math.ceil(total / logFilter.pageSize));
  wrap.innerHTML = `
    <div class="log-pagination"><span>Página <strong>${logFilter.page}</strong> de <strong>${totalPages}</strong> · ${total} registro(s)</span>
      <div class="log-pages">
        <button class="ghost small" ${logFilter.page <= 1 ? "disabled" : ""} onclick="prevPage()">◀ Anterior</button>
        <button class="ghost small" ${logFilter.page >= totalPages || totalPages <= 1 ? "disabled" : ""} onclick="nextPage()">Próximo ▶</button>
      </div></div>
    <div class="log-filters" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px">
      <input type="text" id="log-search" placeholder="Buscar..." value="${esc(logFilter.q || "")}">
      <select id="log-status-filter"><option value="">Todos os status</option><option value="enviado" ${logFilter.status === "enviado" ? "selected" : ""}>Enviado</option><option value="simulado" ${logFilter.status === "simulado" ? "selected" : ""}>Simulado</option><option value="erro" ${logFilter.status === "erro" ? "selected" : ""}>Erro</option></select>
      <select id="log-rule-filter"><option value="">Todas as regras</option></select>
    </div>`;
  $("#log-search")?.addEventListener("input", (e) => { logFilter.q = e.target.value; logFilter.page = 1; refreshLogs(); });
  $("#log-status-filter")?.addEventListener("change", (e) => { logFilter.status = e.target.value; logFilter.page = 1; refreshLogs(); });
  $("#log-rule-filter")?.addEventListener("change", (e) => { logFilter.rule = e.target.value; logFilter.page = 1; refreshLogs(); });
}

async function refreshLogs() {
  const result = await loadLogs();
  renderLog(result.items);
  renderLogControls(result.total);
}

window.prevPage = async () => { if (logFilter.page > 1) { logFilter.page--; await refreshLogs(); } };
window.nextPage = async () => { logFilter.page++; await refreshLogs(); };

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

async function exportLogs() {
  try {
    const res = await fetch("/api/log/export");
    if (!res.ok) throw new Error("Falha ao exportar");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "mini-dm-logs.csv"; a.click();
    URL.revokeObjectURL(url);
    toast("Logs exportados.");
  } catch (err) { toast(err.message); }
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
    $("#stat-pending-schedules-modal").textContent = s.pendingSchedules;
    $("#stat-sent-schedules").textContent = s.sentSchedules;

    $("#stats-by-rule").innerHTML = Object.entries(s.byRule || {})
      .map(([name, d]) => `<tr><td>${esc(name)}</td><td>${d.total}</td><td>${d.enviado}</td><td>${d.simulado}</td><td>${d.erro}</td></tr>`).join("");
    $("#stats-by-day").innerHTML = s.days
      .map(([day, count]) => `<tr><td>${day}</td><td>${count}</td></tr>`).join("");
  } catch (e) { console.error(e); }
}

async function exportStats() {
  try {
    const res = await fetch("/api/stats/export");
    if (!res.ok) throw new Error("Falha ao exportar estatísticas");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "mini-dm-estatisticas.csv"; a.click();
    URL.revokeObjectURL(url);
    toast("Estatísticas exportadas.");
  } catch (err) { toast(err.message); }
}

// ---------- Agendamentos ----------
async function loadSchedules() {
  try {
    const d = await api("/api/schedules");
    const list = $("#schedules-list");
    const schedules = d.schedules || [];
    list.innerHTML = schedules.map((s) => {
      const statusClass = s.status === "pending" ? "pending" : s.status === "sent" ? "sent" : s.status === "cancelled" ? "cancelled" : "error";
      return `
        <div class="schedule-item" onclick="openEditSchedule('${esc(s.id)}')">
          <div class="schedule-info">
            <div class="schedule-user">@${esc(s.username || "—")}</div>
            <div class="schedule-msg">${esc(s.comment || "")}</div>
            <div class="schedule-meta"><span class="pill ${statusClass}">${esc(s.status)}</span><span>${new Date(s.runAt).toLocaleString("pt-BR")}</span><span>${esc(s.channel)}</span></div>
          </div>
          <div class="schedule-actions">
            <button class="ghost small" onclick="event.stopPropagation(); cancelSchedule('${esc(s.id)}')">Cancelar</button>
            ${s.status === "pending" ? `<button class="ghost small" onclick="event.stopPropagation(); openEditSchedule('${esc(s.id)}')">Editar</button>` : ""}
          </div>
        </div>`;
    }).join("");
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
    await api("/api/schedules", { method: "POST", body: JSON.stringify({ username, comment, channel, runAt }) });
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
    await api(`/api/schedules/${id}`, { method: "PUT", body: JSON.stringify({ username, comment, channel, runAt }) });
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

$("#sched-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  await saveSchedule();
});
$("#btn-cancel-schedule").addEventListener("click", () => $("#sched-form").reset());

$("#btn-close-edit-schedule").addEventListener("click", () => {
  $("#edit-schedule-overlay").hidden = true;
});
$("#btn-close-edit-schedule2").addEventListener("click", () => {
  $("#edit-schedule-overlay").hidden = true;
});
$("#btn-delete-sched").addEventListener("click", deleteSchedule);
$("#edit-sched-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  await saveEditSchedule();
});
$("#edit-schedule-overlay").addEventListener("click", (e) => {
  if (e.target === $("#edit-schedule-overlay")) $("#edit-schedule-overlay").hidden = true;
});

// ---------- Configurações ----------
async function loadSettingsForm() {
  try {
    const s = await api("/api/state");
    $("#set-account").value = s.settings.accountUsername || "";
    $("#set-poll").value = s.settings.pollSeconds || 60;
    $("#set-media").value = s.settings.maxMediaPerPoll || 3;
    $("#set-public").checked = Boolean(s.settings.replyPublic);
    $("#set-dry").checked = Boolean(s.settings.dryRun);
    $("#set-target-posts").value = Array.isArray(s.settings.targetPostIds) ? s.settings.targetPostIds.join(", ") : "";
    $("#btn-live").textContent = (!s.settings.dryRun && s.poller?.running) ? "Desligar" : "Ligar";
    $("#btn-live").classList.toggle("on", !s.settings.dryRun && s.poller?.running);
    $("#live-sub").textContent = s.settings.dryRun ? "Desligue a simulação para poder ligar" : (!s.settings.dryRun && s.poller?.running ? "Ligado: lendo comentários novos" : "Lê comentários novos e envia as DMs");
  } catch (e) { console.error(e); }
}

$("#menu-config").addEventListener("click", () => { showTab("config"); loadSettingsForm(); });
$("#btn-live").addEventListener("click", async () => {
  const s = state?.settings || {};
  const isLive = !s.dryRun && state?.poller?.running;
  try {
    const result = await api("/api/live", { method: "POST", body: JSON.stringify({ enabled: !isLive }) });
    await loadSettingsForm();
    toast(result.live ? "Modo ao vivo ligado." : "Modo ao vivo desligado.");
  } catch (err) { toast(err.message); }
});

$("#settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const token = $("#set-token").value.trim();
  try {
    const targetPostsRaw = $("#set-target-posts").value.trim();
    const targetPostIds = targetPostsRaw ? targetPostsRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];
    const result = await api("/api/settings", {
      method: "POST",
      body: JSON.stringify({
        accountUsername: $("#set-account").value.trim(),
        pollSeconds: Number($("#set-poll").value) || 60,
        maxMediaPerPoll: Number($("#set-media").value) || 3,
        replyPublic: $("#set-public").checked,
        dryRun: $("#set-dry").checked,
        targetPostIds: targetPostIds,
        token: token || undefined
      })
    });
    await loadSettingsForm();
    await checkConnection();
    if (result.reactivated) {
      toast("Token válido! Modo ao vivo reativado automaticamente.");
    } else if (token && result.validate && !result.validate.ok) {
      toast("Token salvo, mas inválido: " + (result.validate.message || ""));
    } else {
      toast("Configurações salvas.");
    }
  } catch (err) { toast(err.message); }
});

// ---------- Agente de IA ----------
async function loadAiConfig() {
  try {
    const c = await api("/api/ai/config");
    $("#ai-enabled").checked = Boolean(c.enabled);
    $("#ai-provider").value = c.provider || "gemini";
    $("#ai-model").value = c.model || "";
    $("#ai-temperature").value = c.temperature !== undefined ? c.temperature : 0.7;
    $("#ai-auto-send").checked = Boolean(c.autoSend);
    $("#ai-prompt").value = c.systemPrompt || "";
    $("#ai-key").placeholder = c.hasKey ? "●●●●●●●● (já configurada)" : "Cole sua chave da API";
  } catch (e) { console.error(e); }
}

async function saveAiConfig() {
  try {
    const res = await api("/api/ai/config", {
      method: "POST",
      body: JSON.stringify({
        aiEnabled: $("#ai-enabled").checked,
        aiProvider: $("#ai-provider").value,
        aiApiKey: $("#ai-key").value.trim() || undefined,
        aiModel: $("#ai-model").value.trim(),
        aiSystemPrompt: $("#ai-prompt").value.trim(),
        aiAutoSend: $("#ai-auto-send").checked,
        aiTemperature: Number($("#ai-temperature").value) || 0.7
      })
    });
    toast(res.ok ? "Agente de IA salvo." : "Erro ao salvar agente de IA.");
  } catch (err) { toast(err.message); }
}

async function testAi() {
  const text = $("#ai-test-text").value || "Oi, tudo bem?";
  try {
    const res = await api("/api/ai/test", { method: "POST", body: JSON.stringify({ text }) });
    $("#ai-test-result").textContent = "Resposta: " + (res.reply || "");
    $("#ai-test-result").style.color = "var(--ok)";
  } catch (err) {
    $("#ai-test-result").textContent = "Erro: " + err.message;
    $("#ai-test-result").style.color = "var(--err)";
  }
}

$("#menu-ia").addEventListener("click", () => { showTab("ia"); loadAiConfig(); });
$("#ai-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  await saveAiConfig();
});
$("#btn-ai-test").addEventListener("click", testAi);

// ---------- Teste ----------
$("#test-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("#test-text").value.trim();
  const channel = $("#test-channel").value === "dm" ? "dm" : "comment";
  if (!text) return toast(channel === "dm" ? "Escreva uma mensagem para testar." : "Escreva um comentário para testar.");
  const box = $("#test-result");
  try {
    const result = await api("/api/test", { method: "POST", body: JSON.stringify({ text, channel, username: $("#test-user").value.trim() }) });
    box.hidden = false;
    if (!result.matched) {
      box.innerHTML = `<h3>Nenhuma regra bateu</h3><p class="preview">${channel === "dm" ? "Nenhuma regra de direct tem essa palavra-chave ativa." : "Esse comentário não tem nenhuma palavra-chave ativa de comentário."}</p>`;
    } else if (channel === "dm") {
      box.innerHTML = `<h3>Regra: ${esc(result.rule.name)} · palavra “${esc(result.keyword)}”</h3><div class="bubble dm"><small>Resposta automática no direct</small>${esc(result.dmText)}</div>`;
    } else {
      box.innerHTML = `<h3>Regra: ${esc(result.rule.name)} · palavra “${esc(result.keyword)}”</h3><div class="bubble public"><small>Resposta pública no comentário</small>${esc(result.publicReply)}</div><div class="bubble dm"><small>Mensagem no direct</small>${esc(result.dmText)}</div>`;
    }
    await loadRules();
  } catch (err) { toast(err.message); }
});

$("#btn-clear-log").addEventListener("click", async () => {
  if (!confirm("Limpar todo o histórico?")) return;
  try {
    await api("/api/log", { method: "DELETE" });
    $("#test-result").hidden = true;
    await refreshLogs();
    await loadStats();
    toast("Histórico limpo.");
  } catch (err) { toast(err.message); }
});

$("#btn-exportar").addEventListener("click", exportLogs);
$("#btn-export-panel").addEventListener("click", exportLogs);
$("#btn-export-stats").addEventListener("click", exportStats);

// ---------- Menu mobile ----------
$("#btn-menu-toggle").addEventListener("click", () => {
  const open = $("#sidebar").classList.toggle("open");
  $("#menu-backdrop").hidden = !open;
});
$("#menu-backdrop").addEventListener("click", () => {
  $("#sidebar").classList.remove("open");
  $("#menu-backdrop").hidden = true;
});

// Clique nos itens do menu
document.querySelectorAll(".sidebar-item[data-tab]").forEach((b) => {
  b.addEventListener("click", () => showTab(b.dataset.tab));
});

// ---------- Auth ----------
async function checkAuthStatus() {
  try {
    const res = await api("/api/auth/me");
    loginDisabled = Boolean(res.disabled);
    if (loginDisabled) {
      $("#btn-auth-toggle").classList.add("hidden");
      $("#btn-logout").classList.add("hidden");
      $("#login-overlay").classList.add("hidden");
      showTab("regras");
      return;
    }
    if (res.authenticated && res.user) {
      authToken = null; // token não persistido no frontend de exemplo; re-login necessário
      authUser = res.user;
      $("#btn-auth-toggle").classList.add("hidden");
      $("#btn-logout").classList.remove("hidden");
      $("#account-name").textContent = "@" + (authUser.username || "usuário");
      $("#login-overlay").classList.add("hidden");
      showTab("regras");
    } else {
      authToken = null;
      authUser = null;
      $("#btn-auth-toggle").classList.remove("hidden");
      $("#btn-logout").classList.add("hidden");
      $("#login-overlay").classList.remove("hidden");
    }
  } catch (e) {
    console.error("auth check error", e);
    $("#login-overlay").classList.remove("hidden");
  }
}

async function doLogin() {
  const user = $("#login-user").value.trim();
  const pass = $("#login-pass").value.trim();
  if (!user || !pass) return toast("Preencha usuário e senha");
  try {
    const res = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: user, password: pass })
    });
    if (res.disabled) {
      loginDisabled = true;
      $("#btn-auth-toggle").classList.add("hidden");
      $("#btn-logout").classList.add("hidden");
      showTab("regras");
      toast("Login desativado no servidor");
      return;
    }
    authToken = res.token;
    authUser = res.user;
    $("#login-error").classList.add("hidden");
    $("#btn-auth-toggle").classList.add("hidden");
    $("#btn-logout").classList.remove("hidden");
    $("#account-name").textContent = "@" + (authUser.username || "usuário");
    $("#login-overlay").classList.add("hidden");
    toast("Bem-vindo, " + (authUser.username || "usuário"));
    showTab("regras");
    await loadRules();
  } catch (err) {
    $("#login-error").classList.remove("hidden");
    $("#login-error").textContent = err.message || "Erro ao fazer login";
    toast(err.message);
  }
}

async function doLogout() {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch { /* ignora erro de rede */ }
  authToken = null;
  authUser = null;
  loginDisabled = false;
  $("#login-pass").value = "";
  $("#login-user").value = "";
  $("#btn-auth-toggle").classList.remove("hidden");
  $("#btn-logout").classList.add("hidden");
  $("#account-name").textContent = "carregando…";
  $("#login-overlay").classList.remove("hidden");
  toast("Sessão encerrada");
}

$("#btn-auth-toggle").addEventListener("click", () => {
  $("#login-overlay").classList.remove("hidden");
});
$("#btn-logout").addEventListener("click", doLogout);
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  await doLogin();
});

// ---------- Init ----------
(async function init() {
  await checkAuthStatus();
  if (loginDisabled) {
    await checkConnection();
    await loadRules();
    await loadRulesForFilter();
    await refreshLogs();
    await loadStats();
    await loadSchedules();
    await loadAiConfig();
    showTab("regras");
    setInterval(() => { checkConnection(); loadRules(); }, 8000);
    setInterval(loadStats, 30000);
    setInterval(loadSchedules, 30000);
    return;
  }
  await checkConnection();
  await loadRules();
  await loadRulesForFilter();
  await refreshLogs();
  await loadStats();
  await loadSchedules();
  await loadAiConfig();

  setInterval(() => { checkConnection(); loadRules(); }, 8000);
  setInterval(loadStats, 30000);
  setInterval(loadSchedules, 30000);
})();
