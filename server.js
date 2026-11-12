import path from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { loadStore, saveStore, addLog, markSeen, addSchedule, getDueSchedules, updateScheduleStatus, removeSchedule, exportLogs, filterLogs, getRulesList, exportStats } from "./lib/store.js";
import { matchRule, render } from "./lib/engine.js";
import { MetaClient, MetaError, resolveAccount } from "./lib/meta.js";
import { resolveAiSettings, generateReply, aiHistoryFromLog, AiError } from "./lib/ai.js";

const POLL_TICK_MS = 5000;
let poller = { timer: null, running: false, lastRun: null, lastError: null, lastSummary: null };

// ---------- Rate limiting simples ----------
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minuto
const RATE_LIMIT_MAX = 60; // 60 requisições por minuto por IP
const rateLimitMap = new Map(); // ip -> { count, resetAt }

function rateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true, remaining: RATE_LIMIT_MAX - 1 };
  }
  if (entry.count >= RATE_LIMIT_MAX) {
    return { allowed: false, remaining: 0, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  }
  entry.count += 1;
  return { allowed: true, remaining: RATE_LIMIT_MAX - entry.count };
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  const socket = req.socket;
  return socket ? (socket.remoteAddress || 'unknown') : 'unknown';
}

function publicState() {
  const store = loadStore();
  let account = null;
  try {
    const a = resolveAccount(store.settings);
    account = { username: a.username, igId: a.igId, source: a.source, hasToken: Boolean(a.token) };
  } catch (err) {
    account = { error: err.message };
  }
  return {
    settings: { ...store.settings, token: store.settings.token ? "***" : "" },
    rules: store.rules,
    log: store.log.slice(0, 80),
    account,
    poller: {
      running: Boolean(poller.timer),
      lastRun: poller.lastRun,
      lastError: poller.lastError,
      lastSummary: poller.lastSummary
    }
  };
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) reject(new Error("Corpo muito grande"));
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("JSON invalido"));
      }
    });
    req.on("error", reject);
  });
}

function uid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

function cleanRule(input, existing) {
  const keywords = (Array.isArray(input.keywords) ? input.keywords : String(input.keywords || "").split(","))
    .map((k) => String(k).trim())
    .filter(Boolean);
  const channel = ["comment", "dm", "both"].includes(input.channel)
    ? input.channel
    : existing?.channel || "comment";
  return {
    id: existing?.id || uid("r"),
    name: String(input.name || existing?.name || "Nova regra").trim() || "Nova regra",
    channel,
    keywords: [...new Set(keywords)].slice(0, 30),
    active: input.active === undefined ? existing?.active ?? true : Boolean(input.active),
    publicReply: String(input.publicReply ?? existing?.publicReply ?? "Te chamei no direct, {{username}}!"),
    dmText:
      String(input.dmText ?? existing?.dmText ?? "") ||
      "Oi, {{username}}! Vi seu comentario e te respondo por aqui."
  };
}

async function pollOnce(reason = "agendado") {
  const store = loadStore();
  if (store.settings.dryRun) {
    poller.lastRun = new Date().toISOString();
    poller.lastSummary = "Simulacao ligada: nada e enviado de verdade.";
    return { ok: true, simulated: true, summary: poller.lastSummary };
  }

  let account;
  try {
    account = resolveAccount(store.settings);
  } catch (err) {
    poller.lastError = err.message;
    return { ok: false, error: err.message };
  }

  const client = new MetaClient(account);
  const summary = { scanned: 0, matched: 0, dmSent: 0, publicReplied: 0, errors: 0 };

  // ---------- Processar agendamentos vencidos ----------
  const due = getDueSchedules(store);
  for (const sched of due) {
    try {
      const ctx = { username: sched.username || "amigo", keyword: sched.keyword };
      const dmText = render(sched.comment, ctx);
      if (sched.channel === "dm" || sched.channel === "both") {
        await client.sendMessage(client.igId, dmText);
      }
      if (sched.channel === "comment" || sched.channel === "both") {
        // sem comentário alvo para agendamento simples; registra apenas
      }
      updateScheduleStatus(store, sched.id, "sent", dmText);
      addLog(store, {
        mode: "agendado",
        username: sched.username,
        comment: sched.comment,
        keyword: sched.keyword,
        ruleName: sched.ruleName,
        status: "enviado",
        detail: dmText
      });
      summary.dmSent += 1;
    } catch (err) {
      updateScheduleStatus(store, sched.id, "error", err.message);
      addLog(store, {
        mode: "agendado",
        username: sched.username,
        comment: sched.comment,
        keyword: sched.keyword,
        ruleName: sched.ruleName,
        status: "erro",
        detail: err.message
      });
      summary.errors += 1;
    }
  }
  saveStore(store);

  try {
    const targetPostIds = Array.isArray(store.settings.targetPostIds)
      ? store.settings.targetPostIds.filter(String)
      : [];

    let media;
    if (targetPostIds.length > 0) {
      media = targetPostIds.map((id) => ({ id }));
    } else {
      media = await client.recentMedia(Number(store.settings.maxMediaPerPoll) || 3);
    }
    const cutoff = Date.now() - (Number(store.settings.maxPostAgeDays) || 7) * 24 * 3600 * 1000;

    for (const post of media) {
      const postTime = post.timestamp ? new Date(post.timestamp).getTime() : Date.now();
      if (postTime < cutoff) continue;

      let comments = [];
      try {
        comments = await client.comments(post.id, 50);
      } catch (err) {
        summary.errors += 1;
        addLog(store, {
          mode: "ao vivo",
          status: "erro",
          detail: `Nao consegui ler comentarios: ${err.message}`
        });
        continue;
      }

      for (const comment of comments) {
        if (store.seen[comment.id]) continue;
        summary.scanned += 1;
        const found = matchRule(comment.text, store.rules);
        if (!found) {
          markSeen(store, comment.id);
          continue;
        }
        summary.matched += 1;
        markSeen(store, comment.id);
        const ctx = { username: comment.username || "amigo", keyword: found.keyword };
        const dmText = render(found.rule.dmText, ctx);
        const publicText = render(found.rule.publicReply, ctx);

        try {
          if (store.settings.replyPublic && publicText.trim()) {
            await client.replyToComment(comment.id, publicText);
            summary.publicReplied += 1;
          }
          await client.sendPrivateReply(client.igId, comment.id, dmText);
          summary.dmSent += 1;
          addLog(store, {
            mode: "ao vivo",
            username: comment.username,
            comment: comment.text,
            keyword: found.keyword,
            ruleName: found.rule.name,
            status: "enviado",
            detail: dmText
          });
        } catch (err) {
          summary.errors += 1;
          if (err instanceof MetaError && err.expired) {
            poller.lastError = "Token expirado: reconecte a conta Meta para voltar ao vivo.";
            store.settings.live = false;
            stopPoller();
          }
          addLog(store, {
            mode: "ao vivo",
            username: comment.username,
            comment: comment.text,
            keyword: found.keyword,
            ruleName: found.rule.name,
            status: "erro",
            detail: err.message
          });
        }
        await new Promise((r) => setTimeout(r, 1200));
      }
    }

    poller.lastRun = new Date().toISOString();
    poller.lastError = poller.lastError && poller.lastError.startsWith("Token") ? poller.lastError : null;
    poller.lastSummary = `${reason}: ${summary.scanned} comentarios novos, ${summary.dmSent} DMs, ${summary.errors} erros.`;
    saveStore(store);
    return { ok: true, summary: summary };
  } catch (err) {
    summary.errors += 1;
    poller.lastError = err.message;
    if (err instanceof MetaError && err.expired) {
      poller.lastError = "Token expirado: reconecte a conta Meta para voltar ao vivo.";
      store.settings.live = false;
      stopPoller();
    }
    addLog(store, { mode: "ao vivo", status: "erro", detail: err.message });
    saveStore(store);
    return { ok: false, error: err.message };
  }
}

function startPoller() {
  stopPoller();
  const store = loadStore();
  const seconds = Math.max(20, Number(store.settings.pollSeconds) || 60);
  poller.timer = setInterval(() => {
    pollOnce("agendado").catch(() => {});
  }, seconds * 1000);
  pollOnce("inicio").catch(() => {});
}

function stopPoller() {
  if (poller.timer) clearInterval(poller.timer);
  poller.timer = null;
}

function checkAuth(req, res) {
  const pass = process.env.PANEL_PASSWORD;
  if (!pass) return true;
  const user = process.env.PANEL_USER || "leo";
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme === "Basic" && encoded) {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const sep = decoded.indexOf(":");
    if (sep > -1 && decoded.slice(0, sep) === user && decoded.slice(sep + 1) === pass) return true;
  }
  res.writeHead(401, {
    "www-authenticate": 'Basic realm="Mini DM", charset="UTF-8"',
    "content-type": "text/plain; charset=utf-8"
  });
  res.end("Acesso restrito");
  return false;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathName = url.pathname;

  if (pathName !== "/api/webhook" && !checkAuth(req, res)) return;

  // Rate limiting (isenta webhook da Meta)
  if (pathName !== "/api/webhook") {
    const limit = rateLimit(clientIp(req));
    if (!limit.allowed) {
      res.writeHead(429, {
        "content-type": "application/json; charset=utf-8",
        "retry-after": String(limit.retryAfter || 60),
        "cache-control": "no-store"
      });
      return res.end(JSON.stringify({ error: "Muitas requisições. Tente novamente em " + (limit.retryAfter || 60) + " segundos." }));
    }
    res.setHeader("X-RateLimit-Remaining", String(limit.remaining));
  }

  try {
    if (pathName === "/api/state" && req.method === "GET") {
      return json(res, 200, publicState());
    }

    if (pathName === "/api/check" && req.method === "POST") {
      const store = loadStore();
      try {
        const account = resolveAccount(store.settings);
        const client = new MetaClient(account);
        const info = await client.validate();
        return json(res, 200, { ok: true, ...info, source: account.source });
      } catch (err) {
        return json(res, 200, {
          ok: false,
          expired: err instanceof MetaError && err.expired,
          message: err.message
        });
      }
    }

    if (pathName === "/api/rules" && req.method === "POST") {
      const body = await readBody(req);
      const store = loadStore();
      const existing = store.rules.find((r) => r.id === body.id);
      const rule = cleanRule(body, existing);
      if (!rule.keywords.length) return json(res, 400, { error: "Informe pelo menos uma palavra-chave." });
      if (existing) {
        store.rules = store.rules.map((r) => (r.id === rule.id ? rule : r));
      } else {
        store.rules.push(rule);
      }
      saveStore(store);
      return json(res, 200, { ok: true, rule });
    }

    if (pathName.startsWith("/api/rules/") && req.method === "DELETE") {
      const id = decodeURIComponent(pathName.slice("/api/rules/".length));
      const store = loadStore();
      store.rules = store.rules.filter((r) => r.id !== id);
      saveStore(store);
      return json(res, 200, { ok: true });
    }

    if (pathName === "/api/settings" && req.method === "POST") {
      const body = await readBody(req);
      const store = loadStore();
      const allowed = ["accountUsername", "accountFile", "dryRun", "pollSeconds", "replyPublic", "maxPostAgeDays", "maxMediaPerPoll", "targetPostIds", "token"];
      let tokenChanged = false;
      for (const key of allowed) {
        if (body[key] !== undefined) {
          if (key === "token") {
            if (body.token && String(body.token).trim()) {
              store.settings.token = String(body.token).trim();
              tokenChanged = true;
            }
            continue;
          }
          store.settings[key] = body[key];
        }
      }
      saveStore(store);

      let reactivated = false;
      let validateInfo = null;
      if (tokenChanged && !store.settings.dryRun) {
        try {
          const account = resolveAccount(store.settings);
          const client = new MetaClient(account);
          validateInfo = await client.validate();
          if (!store.settings.live) {
            store.settings.live = true;
            saveStore(store);
            startPoller();
            reactivated = true;
          }
        } catch (err) {
          validateInfo = {
            ok: false,
            expired: err instanceof MetaError && err.expired,
            message: err.message
          };
        }
      }

      return json(res, 200, {
        ok: true,
        reactivated,
        validate: validateInfo,
        settings: { ...store.settings, token: store.settings.token ? "***" : "" }
      });
    }

    if (pathName === "/api/live" && req.method === "POST") {
      const body = await readBody(req);
      const store = loadStore();
      const enabled = Boolean(body.enabled);
      if (enabled) {
        if (store.settings.dryRun) {
          return json(res, 400, { error: "Desligue a simulacao antes de ativar o modo ao vivo." });
        }
        store.settings.live = true;
        saveStore(store);
        startPoller();
      } else {
        store.settings.live = false;
        saveStore(store);
        stopPoller();
      }
      return json(res, 200, { ok: true, live: Boolean(poller.timer) });
    }

    if (pathName === "/api/test" && req.method === "POST") {
      const body = await readBody(req);
      const store = loadStore();
      const text = String(body.text || "");
      const channel = body.channel === "dm" ? "dm" : "comment";
      const username = String(body.username || "").replace(/^@/, "") || "cliente";
      const found = matchRule(text, store.rules, channel);
      if (!found) {
        addLog(store, { mode: "teste", username, comment: text, status: "sem regra" });
        saveStore(store);
        return json(res, 200, { matched: false, channel });
      }
      const ctx = { username, keyword: found.keyword };
      const result = {
        matched: true,
        channel,
        rule: { id: found.rule.id, name: found.rule.name },
        keyword: found.keyword,
        dmText: render(found.rule.dmText, ctx)
      };
      if (channel === "comment") result.publicReply = render(found.rule.publicReply, ctx);
      addLog(store, {
        mode: channel === "dm" ? "teste direct" : "teste",
        username,
        comment: text,
        keyword: found.keyword,
        ruleName: found.rule.name,
        status: "simulado",
        detail: result.dmText
      });
      saveStore(store);
      return json(res, 200, result);
    }

    if (pathName === "/api/log" && req.method === "DELETE") {
      const store = loadStore();
      store.log = [];
      saveStore(store);
      return json(res, 200, { ok: true });
    }

    if (pathName === "/api/poll" && req.method === "POST") {
      const result = await pollOnce("manual");
      return json(res, 200, result);
    }

    // ---------- Exportar logs ----------
    if (pathName === "/api/log/export" && req.method === "GET") {
      const store = loadStore();
      const csv = exportLogs(store);
      res.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="mini-dm-logs.csv"',
        "cache-control": "no-store"
      });
      return res.end(csv);
    }

    // ---------- Logs filtrados/paginados ----------
    if (pathName === "/api/log/filter" && req.method === "GET") {
      const store = loadStore();
      const q = url.searchParams;
      const result = filterLogs(store, {
        query: q.get("q") || "",
        status: q.get("status") || "",
        rule: q.get("rule") || "",
        page: Number(q.get("page")) || 1,
        pageSize: Number(q.get("pageSize")) || 50
      });
      return json(res, 200, result);
    }

    // ---------- Estatísticas ----------
    if (pathName === "/api/stats" && req.method === "GET") {
      const store = loadStore();
      const rules = store.rules || [];
      const log = store.log || [];
      const schedules = store.schedules || [];

      const totalRules = rules.length;
      const activeRules = rules.filter((r) => r.active).length;
      const totalLog = log.length;
      const sentLog = log.filter((l) => l.status === "enviado").length;
      const simulatedLog = log.filter((l) => l.status === "simulado").length;
      const errorLog = log.filter((l) => l.status === "erro").length;

      const byRule = {};
      for (const entry of log) {
        const key = entry.ruleName || "sem regra";
        if (!byRule[key]) byRule[key] = { total: 0, enviado: 0, simulado: 0, erro: 0 };
        byRule[key].total += 1;
        if (entry.status === "enviado") byRule[key].enviado += 1;
        if (entry.status === "simulado") byRule[key].simulado += 1;
        if (entry.status === "erro") byRule[key].erro += 1;
      }

      const byDay = {};
      for (const entry of log) {
        const day = entry.at ? entry.at.slice(0, 10) : "sem data";
        if (!byDay[day]) byDay[day] = 0;
        byDay[day] += 1;
      }
      const days = Object.entries(byDay).sort((a, b) => a[0].localeCompare(b[0]));

      const pendingSchedules = schedules.filter((s) => s.status === "pending").length;
      const sentSchedules = schedules.filter((s) => s.status === "sent").length;

      return json(res, 200, {
        totalRules,
        activeRules,
        totalLog,
        sentLog,
        simulatedLog,
        errorLog,
        byRule,
        days,
        pendingSchedules,
        sentSchedules,
        totalSchedules: schedules.length
      });
    }

    // ---------- Health check ----------
    if (pathName === "/api/health" && req.method === "GET") {
      const store = loadStore();
      return json(res, 200, {
        ok: true,
        service: "mini-dm",
        version: "1.0.0",
        uptime: process.uptime(),
        memory: process.memoryUsage().rss,
        rules: store.rules ? store.rules.length : 0,
        logs: store.log ? store.log.length : 0
      });
    }

    // ---------- Exportar estatísticas ----------
    if (pathName === "/api/stats/export" && req.method === "GET") {
      const store = loadStore();
      const csv = exportStats(store);
      res.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="mini-dm-estatisticas.csv"',
        "cache-control": "no-store"
      });
      return res.end(csv);
    }

    // ---------- Lista de regras (para filtro) ----------
    if (pathName === "/api/rules-list" && req.method === "GET") {
      const store = loadStore();
      return json(res, 200, { rules: getRulesList(store) });
    }

    // ---------- Agente de IA ----------
    if (pathName === "/api/ai/config" && req.method === "GET") {
      const store = loadStore();
      const ai = resolveAiSettings(store.settings);
      return json(res, 200, {
        enabled: ai.enabled,
        provider: ai.provider,
        model: ai.model,
        systemPrompt: ai.systemPrompt,
        autoSend: ai.autoSend,
        temperature: ai.temperature,
        hasKey: Boolean(ai.key)
      });
    }

    if (pathName === "/api/ai/config" && req.method === "POST") {
      const body = await readBody(req);
      const store = loadStore();
      const allowed = ["aiEnabled", "aiProvider", "aiApiKey", "aiModel", "aiSystemPrompt", "aiAutoSend", "aiTemperature"];
      for (const key of allowed) {
        if (body[key] !== undefined) {
          store.settings[key] = key === "aiApiKey" && !body[key] ? store.settings.aiApiKey : body[key];
        }
      }
      saveStore(store);
      const ai = resolveAiSettings(store.settings);
      return json(res, 200, {
        ok: true,
        enabled: ai.enabled,
        provider: ai.provider,
        model: ai.model,
        autoSend: ai.autoSend,
        temperature: ai.temperature,
        hasKey: Boolean(ai.key)
      });
    }

    if (pathName === "/api/ai/test" && req.method === "POST") {
      const body = await readBody(req);
      const store = loadStore();
      const history = aiHistoryFromLog(store.log, 12);
      const text = await generateReply([{ direction: "recebida", body: body.text || "Oi" }], store.settings);
      addLog(store, {
        mode: "teste ia",
        username: "sistema",
        comment: body.text || "",
        ruleName: "agente de ia",
        status: "simulado",
        detail: text
      });
      saveStore(store);
      return json(res, 200, { ok: true, reply: text });
    }

    if (pathName === "/api/ai/reply" && req.method === "POST") {
      const body = await readBody(req);
      const store = loadStore();
      const history = aiHistoryFromLog(store.log, 12);
      history.push({ direction: "recebida", body: body.text || "" });
      const text = await generateReply(history, store.settings);
      return json(res, 200, { ok: true, reply: text, autoSend: aiHistoryFromLog(store.settings).length > 0 && false });
    }

    // ---------- Agendamentos ----------
    if (pathName === "/api/schedules" && req.method === "GET") {
      const store = loadStore();
      return json(res, 200, { schedules: store.schedules || [] });
    }

    if (pathName === "/api/schedules" && req.method === "POST") {
      const body = await readBody(req);
      const store = loadStore();
      const schedule = addSchedule(store, {
        username: body.username,
        comment: body.comment,
        channel: body.channel || "dm",
        runAt: body.runAt,
        ruleName: body.ruleName || "",
        keyword: body.keyword || ""
      });
      saveStore(store);
      return json(res, 200, { ok: true, schedule });
    }

    if (pathName.startsWith("/api/schedules/") && req.method === "PUT") {
      const id = decodeURIComponent(pathName.slice("/api/schedules/".length));
      const body = await readBody(req);
      const store = loadStore();
      const schedule = store.schedules.find((s) => s.id === id);
      if (!schedule) return json(res, 404, { error: "Agendamento não encontrado" });
      if (body.username !== undefined) schedule.username = String(body.username).trim();
      if (body.comment !== undefined) schedule.comment = String(body.comment).trim();
      if (body.channel !== undefined) schedule.channel = body.channel;
      if (body.runAt !== undefined) schedule.runAt = body.runAt;
      if (body.ruleName !== undefined) schedule.ruleName = String(body.ruleName || "").trim();
      if (body.keyword !== undefined) schedule.keyword = String(body.keyword || "").trim();
      saveStore(store);
      return json(res, 200, { ok: true, schedule });
    }

    if (pathName.startsWith("/api/schedules/") && req.method === "DELETE") {
      const id = decodeURIComponent(pathName.slice("/api/schedules/".length));
      const store = loadStore();
      const ok = removeSchedule(store, id);
      saveStore(store);
      return json(res, 200, { ok });
    }

    if (pathName.startsWith("/api/schedules/") && pathName.endsWith("/cancel") && req.method === "POST") {
      const id = decodeURIComponent(pathName.slice("/api/schedules/".length, -"/cancel".length));
      const store = loadStore();
      const schedule = updateScheduleStatus(store, id, "cancelled");
      saveStore(store);
      return json(res, 200, { ok: !!schedule, schedule });
    }

    if (pathName === "/api/webhook" && req.method === "GET") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
      if (mode === "subscribe" && token && token === process.env.VERIFY_TOKEN) {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        return res.end(challenge || "ok");
      }
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      return res.end("verificacao falhou");
    }

    if (pathName === "/api/webhook" && req.method === "POST") {
      const body = await readBody(req);
      const store = loadStore();
      const comments = [];
      const messages = [];

      for (const entry of body?.entry || []) {
        for (const change of entry.changes || []) {
          if (change.field !== "comments") continue;
          const v = change.value || {};
          comments.push({
            commentId: v.id,
            text: v.text || "",
            username: v.from?.username || "",
            fromId: v.from?.id || ""
          });
        }
        for (const event of entry.messaging || []) {
          const message = event.message || {};
          if (!message.text || message.is_echo || message.is_deleted) continue;
          const senderId = event.sender?.id || "";
          if (!senderId || senderId === process.env.IG_USER_ID) continue;
          messages.push({
            mid: message.mid || "",
            text: message.text,
            senderId,
            username: event.sender?.username || ""
          });
        }
      }

      const results = [];

      for (const ev of comments) {
        if (!ev.commentId) continue;
        if (ev.fromId && ev.fromId === process.env.IG_USER_ID) continue;
        const found = matchRule(ev.text, store.rules, "comment");
        if (!found) {
          results.push({ platform: "comment", id: ev.commentId, matched: false });
          continue;
        }
        const ctx = { username: ev.username || "amigo", keyword: found.keyword };
        const dmText = render(found.rule.dmText, ctx);
        const publicText = render(found.rule.publicReply, ctx);
        const item = { platform: "comment", id: ev.commentId, matched: true, rule: found.rule.name };

        if (body.test) {
          results.push({ ...item, dmText, publicReply: publicText });
          continue;
        }
        if (store.seen[ev.commentId]) {
          results.push({ ...item, skipped: "duplicado" });
          continue;
        }
        markSeen(store, ev.commentId);

        if (store.settings.dryRun) {
          addLog(store, {
            mode: "teste",
            username: ev.username,
            comment: ev.text,
            keyword: found.keyword,
            ruleName: found.rule.name,
            status: "simulado",
            detail: dmText
          });
          results.push({ ...item, simulated: true, dmText });
          continue;
        }

        try {
          const account = resolveAccount(store.settings);
          const client = new MetaClient(account);
          if (store.settings.replyPublic && publicText.trim()) {
            await client.replyToComment(ev.commentId, publicText);
            item.publicReply = true;
          }
          await client.sendPrivateReply(client.igId, ev.commentId, dmText);
          item.dmSent = true;
          addLog(store, {
            mode: "ao vivo",
            username: ev.username,
            comment: ev.text,
            keyword: found.keyword,
            ruleName: found.rule.name,
            status: "enviado",
            detail: dmText
          });
        } catch (err) {
          item.error = err.message;
          addLog(store, {
            mode: "ao vivo",
            username: ev.username,
            comment: ev.text,
            keyword: found.keyword,
            ruleName: found.rule.name,
            status: "erro",
            detail: err.message
          });
        }
        results.push(item);
      }

      for (const ev of messages) {
        const found = matchRule(ev.text, store.rules, "dm");
        const item = { platform: "dm", mid: ev.mid, sender: ev.senderId };
        if (!found) {
          results.push({ ...item, matched: false });
          continue;
        }
        const rule = found.rule;
        const buildDm = () =>
          render(rule.dmText, { username: ev.username || "amigo", keyword: found.keyword });
        item.matched = true;
        item.rule = rule.name;
        item.keyword = found.keyword;

        if (body.test) {
          results.push({ ...item, dmText: buildDm() });
          continue;
        }
        if (store.seen[`dm:${ev.mid}`]) {
          results.push({ ...item, skipped: "duplicado" });
          continue;
        }
        markSeen(store, `dm:${ev.mid}`);

        if (store.settings.dryRun) {
          addLog(store, {
            mode: "teste direct",
            username: ev.username,
            comment: ev.text,
            keyword: found.keyword,
            ruleName: rule.name,
            status: "simulado",
            detail: buildDm()
          });
          results.push({ ...item, simulated: true, dmText: buildDm() });
          continue;
        }

        try {
          const account = resolveAccount(store.settings);
          const client = new MetaClient(account);
          if (!ev.username) {
            try {
              const profile = await client.userProfile(ev.senderId);
              ev.username = profile.username || profile.name || "";
            } catch {
              /* perfil indisponivel: usa saudacao neutra */
            }
          }
          const dmText = buildDm();
          await client.sendMessage(ev.senderId, dmText);
          item.dmSent = true;
          addLog(store, {
            mode: "direct",
            username: ev.username,
            comment: ev.text,
            keyword: found.keyword,
            ruleName: rule.name,
            status: "enviado",
            detail: dmText
          });
        } catch (err) {
          item.error = err.message;
          addLog(store, {
            mode: "direct",
            username: ev.username,
            comment: ev.text,
            keyword: found.keyword,
            ruleName: rule.name,
            status: "erro",
            detail: err.message
          });
        }
        results.push(item);
      }

      saveStore(store);
      return json(res, 200, {
        received: true,
        events: comments.length + messages.length,
        comments: comments.length,
        messages: messages.length,
        results
      });
    }

    const pub = path.join(process.cwd(), "public");
    let file = pathName === "/" ? "index.html" : pathName.replace(/^\/+/, "");
    if (file.includes("..")) return json(res, 400, { error: "caminho invalido" });
    const target = path.join(pub, file);
    const { createReadStream, existsSync, statSync } = await import("node:fs");
    if (!existsSync(target) || !statSync(target).isFile()) {
      return json(res, 404, { error: "nao encontrado" });
    }
    const ext = path.extname(target).toLowerCase();
    const types = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".svg": "image/svg+xml",
      ".json": "application/json; charset=utf-8"
    };
    res.writeHead(200, {
      "content-type": types[ext] || "application/octet-stream",
      "cache-control": "no-cache"
    });
    createReadStream(target).pipe(res);
  } catch (err) {
    console.error(err);
    json(res, 500, { error: err.message || "erro interno" });
  }
});

const port = Number(process.env.PORT) || 3777;
const host = process.env.HOST || (process.env.PORT ? "0.0.0.0" : "127.0.0.1");

function openBrowser(url) {
  try {
    const command =
      process.platform === "win32"
        ? `start "" "${url}"`
        : process.platform === "darwin"
          ? `open "${url}"`
          : `xdg-open "${url}"`;
    spawn(command, { shell: true, detached: true, stdio: "ignore" }).unref();
  } catch {
    /* se nao abrir, o endereco fica no console */
  }
}

server.listen(port, host, () => {
  console.log(`Mini DM no ar em http://localhost:${port}`);
  const store = loadStore();
  if (store.settings.live) startPoller();
  if (process.env.MINI_DM_NO_OPEN !== "1") openBrowser(`http://localhost:${port}`);
});
