const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

let state = null;
let tokenInfo = null;

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

function renderLog() {
  const list = $("#log-list");
  const entries = state.log || [];
  list.innerHTML = entries
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
  $("#log-empty").hidden = entries.length > 0;
}

function render() {
  if (!state) return;
  setAccountChip();
  renderStats();
  renderRules();
  renderLog();
  updateLiveButton();
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

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeRule();
    $("#settings-overlay").hidden = true;
  }
});

(async function init() {
  await refresh(true);
  await checkConnection();
  setInterval(refresh, 8000);
})();
