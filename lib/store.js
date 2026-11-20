import fs from "node:fs";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
export const profileContext = new AsyncLocalStorage();
import path from "node:path";
import { createRequire } from "node:module";
import { tokenFingerprint } from "./token-renewal.js";

// O projeto é ESM ("type": "module"), então require() não existe no escopo.
const require = createRequire(import.meta.url);

const DATA_DIR = process.env.MINI_DM_DATA || path.join(process.cwd(), "data");
const STORE_FILE = path.join(DATA_DIR, "store.json");
const LOG_LIMIT = 300;
const SEEN_LIMIT = 5000;

const DEFAULTS = {
  settings: {
    accountUsername: "leoogiro",
    accountFile: "C:/Users/Leona/claude-instagram/accounts.json",
    token: "",
    dryRun: true,
    live: false,
    pollSeconds: 60,
    replyPublic: true,
    maxPostAgeDays: 7,
    maxMediaPerPoll: 3,
    // Post(s) específico(s) para automação. Se vazio, usa posts recentes.
    targetPostIds: [],
    // Agente de IA
    aiEnabled: false,
    aiProvider: "gemini",
    aiApiKey: "",
    aiModel: "gemini-2.5-flash",
    aiSystemPrompt: "Você é um assistente de atendimento atencioso e profissional. Responda de forma educada e objetiva, em português. Se não souber algo, diga que vai verificar e retornar em breve.",
    aiAutoSend: false,
    aiTemperature: 0.7
  },
  rules: [
    {
      id: "r_exemplo",
      name: "Pedido de preço",
      channel: "comment",
      keywords: ["preço", "valor", "quanto custa", "quanto é", "orçamento"],
      active: true,
      publicReply: "Te chamei no direct, {{username}}!",
      dmText: "Oi, {{username}}! Vi seu comentário aqui. Te mando os valores e as opções agora mesmo. Se quiser adiantar, me conta rapidinho o que você precisa."
    }
  ],
  seen: {},
  log: [],
  schedules: []
};

function normalizeSchedule(s) {
  return {
    id: s.id || Math.random().toString(36).slice(2, 10),
    username: String(s.username || "").trim(),
    comment: String(s.comment || "").trim(),
    channel: ["comment", "dm", "both"].includes(s.channel) ? s.channel : "dm",
    runAt: s.runAt || new Date().toISOString(),
    status: s.status || "pending",
    ruleName: String(s.ruleName || "").trim(),
    keyword: String(s.keyword || "").trim(),
    detail: String(s.detail || "").trim(),
    createdAt: s.createdAt || new Date().toISOString()
  };
}

function normalizeRule(r) {
  return {
    id: r.id || Math.random().toString(36).slice(2, 10),
    name: String(r.name || "Nova regra").trim() || "Nova regra",
    channel: ["comment", "dm", "both"].includes(r.channel) ? r.channel : "comment",
    keywords: Array.isArray(r.keywords) ? r.keywords.map((k) => String(k).trim()).filter(Boolean) : [],
    active: r.active === undefined ? true : Boolean(r.active),
    publicReply: String(r.publicReply ?? ""),
    dmText: String(r.dmText ?? ""),
    dmButton: r.dmButton ?? null,
    postId: String(r.postId ?? "")
  };
}

// ---------- Modo PostgreSQL (quando DATABASE_URL está definido) ----------
let pgPool = null;

function getPgPool() {
  if (pgPool) return pgPool;
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  const { Pool } = require("pg");
  pgPool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  return pgPool;
}

function usePg() {
  return Boolean(process.env.DATABASE_URL);
}

// Inicializa tabelas no PostgreSQL
async function pgInitTables() {
  const pool = getPgPool();
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta_token_rotation (
      slot BOOLEAN PRIMARY KEY DEFAULT true CHECK (slot),
      fingerprint TEXT NOT NULL,
      token TEXT NOT NULL,
      expires_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'comment',
      keywords JSONB NOT NULL DEFAULT '[]',
      active BOOLEAN NOT NULL DEFAULT true,
      public_reply TEXT NOT NULL DEFAULT '',
      dm_text TEXT NOT NULL DEFAULT ''
    );
    ALTER TABLE rules ADD COLUMN IF NOT EXISTS dm_button JSONB;
    ALTER TABLE rules ADD COLUMN IF NOT EXISTS post_id TEXT NOT NULL DEFAULT '';
    CREATE TABLE IF NOT EXISTS log (
      id TEXT PRIMARY KEY,
      at TIMESTAMPTZ NOT NULL DEFAULT now(),
      mode TEXT NOT NULL DEFAULT 'teste',
      username TEXT NOT NULL DEFAULT '',
      comment TEXT NOT NULL DEFAULT '',
      keyword TEXT NOT NULL DEFAULT '',
      rule_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'ok',
      detail TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS seen (
      comment_id TEXT PRIMARY KEY,
      timestamp BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL DEFAULT '',
      comment TEXT NOT NULL DEFAULT '',
      channel TEXT NOT NULL DEFAULT 'dm',
      run_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      rule_name TEXT NOT NULL DEFAULT '',
      keyword TEXT NOT NULL DEFAULT '',
      detail TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

// Carrega tudo do PostgreSQL
async function pgLoadStore() {
  await pgInitTables();
  const pool = getPgPool();

  // Settings
  const settingsRes = await pool.query(`SELECT key, value FROM settings`);
  const settingsRaw = {};
  for (const r of settingsRes.rows) settingsRaw[r.key] = r.value;
  const settings = { ...DEFAULTS.settings, ...settingsRaw };

  // Regras
  const rulesRes = await pool.query(`SELECT id, name, channel, keywords, active, public_reply, dm_text, dm_button, post_id FROM rules`);
  const rules = rulesRes.rows.map((r) => ({
    id: r.id,
    name: r.name,
    channel: r.channel,
    keywords: Array.isArray(r.keywords) ? r.keywords : (r.keywords ? JSON.parse(r.keywords) : []),
    active: r.active,
    publicReply: r.public_reply,
    dmText: r.dm_text,
    dmButton: r.dm_button,
    postId: r.post_id
  }));

  // Log
  const logRes = await pool.query(`SELECT id, at, mode, username, comment, keyword, rule_name, status, detail FROM log ORDER BY at DESC LIMIT $1`, [LOG_LIMIT]);
  const log = logRes.rows.map((r) => ({
    id: r.id,
    at: r.at,
    mode: r.mode,
    username: r.username,
    comment: r.comment,
    keyword: r.keyword,
    ruleName: r.rule_name,
    status: r.status,
    detail: r.detail
  }));

  // Seen
  const seenRes = await pool.query(`SELECT comment_id, timestamp FROM seen`);
  const seen = {};
  for (const r of seenRes.rows) seen[r.comment_id] = r.timestamp;

  // Schedules
  const schedRes = await pool.query(`SELECT id, username, comment, channel, run_at, status, rule_name, keyword, detail, created_at FROM schedules`);
  const schedules = schedRes.rows.map((r) => ({
    id: r.id,
    username: r.username,
    comment: r.comment,
    channel: r.channel,
    runAt: r.run_at,
    status: r.status,
    ruleName: r.rule_name,
    keyword: r.keyword,
    detail: r.detail,
    createdAt: r.created_at
  }));

  return { settings, rules, seen, log, schedules };
}

// Salva tudo no PostgreSQL (substitui tabelas)
async function pgSaveStore(store) {
  await pgInitTables();
  const pool = getPgPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Settings
    await client.query(`DELETE FROM settings`);
    for (const [key, value] of Object.entries(store.settings || {})) {
      await client.query(`INSERT INTO settings(key, value) VALUES($1, $2)`, [key, JSON.stringify(value)]);
    }

    // Regras
    await client.query(`DELETE FROM rules`);
    for (const r of store.rules || []) {
      await client.query(
        `INSERT INTO rules(id, name, channel, keywords, active, public_reply, dm_text, dm_button, post_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [r.id, r.name, r.channel, JSON.stringify(r.keywords || []), r.active, r.publicReply || "", r.dmText || "", r.dmButton ?? null, r.postId || ""]
      );
    }

    // Log (mantém só os últimos LOG_LIMIT)
    await client.query(`DELETE FROM log`);
    const logToSave = (store.log || []).slice(0, LOG_LIMIT);
    for (const e of logToSave) {
      await client.query(
        `INSERT INTO log(id, at, mode, username, comment, keyword, rule_name, status, detail) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [e.id, e.at, e.mode, e.username, e.comment, e.keyword, e.ruleName || "", e.status, e.detail || ""]
      );
    }

    // Seen
    await client.query(`DELETE FROM seen`);
    for (const [commentId, timestamp] of Object.entries(store.seen || {})) {
      await client.query(`INSERT INTO seen(comment_id, timestamp) VALUES($1, $2)`, [commentId, Number(timestamp)]);
    }

    // Schedules
    await client.query(`DELETE FROM schedules`);
    for (const s of store.schedules || []) {
      await client.query(
        `INSERT INTO schedules(id, username, comment, channel, run_at, status, rule_name, keyword, detail, created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [s.id, s.username, s.comment, s.channel, s.runAt, s.status, s.ruleName || "", s.keyword || "", s.detail || "", s.createdAt]
      );
    }

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// ---------- Fallback JSON local ----------
function loadStoreJson() {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    return {
      settings: { ...DEFAULTS.settings, ...(raw.settings || {}) },
      rules: (Array.isArray(raw.rules) ? raw.rules : DEFAULTS.rules).map(normalizeRule),
      seen: raw.seen && typeof raw.seen === "object" ? raw.seen : {},
      log: Array.isArray(raw.log) ? raw.log : [],
      schedules: (Array.isArray(raw.schedules) ? raw.schedules : []).map(normalizeSchedule)
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

function saveStoreJson(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = STORE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
  fs.renameSync(tmp, STORE_FILE);
}

// ---------- API unificada ----------
export function storePath() {
  return STORE_FILE;
}

const ROTATION_FILE = path.join(DATA_DIR, ".meta-token-rotation.json");

export async function loadStore() {
  const profile = profileContext.getStore();
  if (profile && profile !== "default") return loadProfile(profile);
  const store = usePg() ? await pgLoadStore() : loadStoreJson();
  if (store.settings.token) {
    let rotation;
    if (usePg()) {
      const { rows } = await getPgPool().query(
        "SELECT fingerprint, token, expires_at FROM meta_token_rotation WHERE slot = true"
      );
      rotation = rows[0];
    } else if (fs.existsSync(ROTATION_FILE)) {
      rotation = JSON.parse(fs.readFileSync(ROTATION_FILE, "utf8"));
    }
    if (rotation?.fingerprint === tokenFingerprint(store.settings.token.trim())) {
      Object.defineProperty(store.settings, "rotatedMetaToken", { value: rotation.token });
    }
  }
  return store;
}

export async function saveRotatedMetaToken(fingerprint, token, expiresAt) {
  const profile = profileContext.getStore();
  if (profile && profile !== "default") {
    const store = await loadProfile(profile);
    if (tokenFingerprint(store.settings.token) !== fingerprint) return;
    store.settings.token = token;
    await writeProfile(profile, store);
    return;
  }
  if (usePg()) {
    await getPgPool().query(
      `INSERT INTO meta_token_rotation (slot, fingerprint, token, expires_at) VALUES (true, $1, $2, $3)
       ON CONFLICT (slot) DO UPDATE SET fingerprint = EXCLUDED.fingerprint, token = EXCLUDED.token, expires_at = EXCLUDED.expires_at
       WHERE meta_token_rotation.fingerprint <> EXCLUDED.fingerprint OR meta_token_rotation.expires_at < EXCLUDED.expires_at`,
      [fingerprint, token, expiresAt]
    );
  } else {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const temp = ROTATION_FILE + "." + process.pid + ".tmp";
    fs.writeFileSync(temp, JSON.stringify({ fingerprint, token, expires_at: expiresAt }), { mode: 0o600 });
    fs.renameSync(temp, ROTATION_FILE);
  }
}

export async function saveStore(store) {
  const profile = profileContext.getStore();
  if (profile && profile !== "default") return writeProfile(profile, store);
  if (usePg()) {
    return await pgSaveStore(store);
  }
  return saveStoreJson(store);
}

export function addLog(store, entry) {
  store.log.unshift({
    id: Math.random().toString(36).slice(2, 10),
    at: new Date().toISOString(),
    mode: entry.mode || "teste",
    username: entry.username || "",
    comment: entry.comment || "",
    keyword: entry.keyword || "",
    ruleName: entry.ruleName || "",
    status: entry.status || "ok",
    detail: entry.detail || ""
  });
  store.log = store.log.slice(0, LOG_LIMIT);
}

export function markSeen(store, commentId) {
  if (!commentId) return;
  store.seen[commentId] = Date.now();
  const ids = Object.keys(store.seen);
  if (ids.length > SEEN_LIMIT) {
    ids.sort((a, b) => store.seen[a] - store.seen[b]);
    for (const id of ids.slice(0, ids.length - SEEN_LIMIT)) delete store.seen[id];
  }
}

// ---------- Filtros e paginação de logs ----------
export function filterLogs(store, { query = "", status = "", rule = "", page = 1, pageSize = 50 } = {}) {
  let rows = (store.log || []).slice();

  const q = String(query || "").toLowerCase();
  if (q) {
    rows = rows.filter((e) => {
      const haystack = String(e.username + " " + e.comment + " " + e.ruleName + " " + e.keyword + " " + e.detail).toLowerCase();
      return haystack.includes(q);
    });
  }
  if (status) rows = rows.filter((e) => e.status === status);
  if (rule) rows = rows.filter((e) => e.ruleName === rule);

  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const p = Math.max(1, Math.min(page, totalPages));
  const start = (p - 1) * pageSize;
  const items = rows.slice(start, start + pageSize);

  return { items, total, page: p, pageSize, totalPages };
}

export function getRulesList(store) {
  return (store.rules || []).map((r) => r.name);
}

export function exportStats(store) {
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
    const day = entry.at && !Number.isNaN(new Date(entry.at).getTime()) ? new Date(entry.at).toISOString().slice(0, 10) : "sem data";
    if (!byDay[day]) byDay[day] = 0;
    byDay[day] += 1;
  }
  const days = Object.entries(byDay).sort((a, b) => a[0].localeCompare(b[0]));

  const pendingSchedules = schedules.filter((s) => s.status === "pending").length;
  const sentSchedules = schedules.filter((s) => s.status === "sent").length;

  const lines = [
    ["métrica", "valor"],
    ["regras_totais", totalRules],
    ["regras_ativas", activeRules],
    ["logs_total", totalLog],
    ["logs_enviados", sentLog],
    ["logs_simulados", simulatedLog],
    ["logs_erros", errorLog],
    ["agendados_pendentes", pendingSchedules],
    ["agendados_enviados", sentSchedules],
    ["", ""],
    ["regra", "total", "enviado", "simulado", "erro"],
  ];

  for (const [name, d] of Object.entries(byRule)) {
    lines.push([name, d.total, d.enviado, d.simulado, d.erro]);
  }

  lines.push(["", ""]);
  lines.push(["data", "acoes"]);
  for (const [day, count] of days) {
    lines.push([day, count]);
  }

  const escapeCsv = (v) => {
    const s = String(v ?? "");
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };
  return lines.map((r) => r.map(escapeCsv).join(",")).join("\n");
}

export function addSchedule(store, payload) {
  const schedule = normalizeSchedule({
    ...payload,
    id: payload.id || Math.random().toString(36).slice(2, 10),
    createdAt: new Date().toISOString(),
    status: "pending"
  });
  store.schedules.push(schedule);
  return schedule;
}

export function getDueSchedules(store) {
  const now = new Date().toISOString();
  return store.schedules.filter((s) => s.status === "pending" && s.runAt <= now);
}

export function updateScheduleStatus(store, id, status, detail = "") {
  const schedule = store.schedules.find((s) => s.id === id);
  if (!schedule) return null;
  schedule.status = status;
  if (detail) schedule.detail = detail;
  return schedule;
}

export function removeSchedule(store, id) {
  const index = store.schedules.findIndex((s) => s.id === id);
  if (index === -1) return false;
  store.schedules.splice(index, 1);
  return true;
}

export function exportLogs(store) {
  const rows = store.log.map((entry) => [
    entry.at,
    entry.mode,
    entry.username,
    entry.comment,
    entry.keyword,
    entry.ruleName,
    entry.status,
    entry.detail
  ]);
  const header = ["at", "mode", "username", "comment", "keyword", "rule", "status", "detail"];
  const escapeCsv = (v) => {
    const s = String(v ?? "");
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };
  const lines = [header.map(escapeCsv).join(","), ...rows.map((r) => r.map(escapeCsv).join(","))];
  return lines.join("\n");
}

async function profilePool() {
  await pgInitTables();
  const pool = getPgPool();
  await pool.query("CREATE TABLE IF NOT EXISTS instagram_profiles (id TEXT PRIMARY KEY, data JSONB NOT NULL)");
  return pool;
}
function profileFile(id) {
  if (!/^profile_[a-z0-9]+$/.test(id)) throw new Error("Perfil inválido");
  return path.join(DATA_DIR, "profiles", id + ".json");
}
export async function loadProfile(id) {
  let data;
  if (usePg()) {
    const pool = await profilePool();
    data = (await pool.query("SELECT data FROM instagram_profiles WHERE id=$1", [id])).rows[0]?.data;
  } else {
    const file = profileFile(id);
    if (fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, "utf8"));
  }
  if (!data) throw new Error("Perfil não encontrado");
  return data;
}
async function writeProfile(id, data, create = false) {
  if (usePg()) {
    const pool = await profilePool();
    if (create) await pool.query("INSERT INTO instagram_profiles(id,data) VALUES($1,$2)", [id, JSON.stringify(data)]);
    else await pool.query("UPDATE instagram_profiles SET data=$2 WHERE id=$1", [id, JSON.stringify(data)]);
  } else {
    const file = profileFile(id);
    fs.mkdirSync(path.dirname(file), {recursive:true});
    fs.writeFileSync(file + ".tmp", JSON.stringify(data), {mode:0o600});
    fs.renameSync(file + ".tmp", file);
  }
}
export async function listProfiles() {
  const original = await profileContext.run("default", loadStore);
  let profiles;
  if (usePg()) {
    const pool = await profilePool();
    profiles = (await pool.query("SELECT id,data FROM instagram_profiles ORDER BY id")).rows;
  } else {
    const dir = path.join(DATA_DIR, "profiles");
    profiles = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^profile_[a-z0-9]+\.json$/.test(f)).map(f => ({
      id:f.slice(0,-5), data:JSON.parse(fs.readFileSync(path.join(dir,f),"utf8"))
    })) : [];
  }
  return [{id:"default",settings:original.settings}, ...profiles.map(p=>({id:p.id,settings:p.data.settings}))];
}
export async function createProfile(username, igId, token) {
  const id = "profile_" + crypto.randomUUID().replaceAll("-","");
  const data = structuredClone(DEFAULTS);
  data.settings = {...data.settings, accountUsername:username, igId, token, accountFile:"", explicitProfile:true};
  data.rules = [];
  await writeProfile(id, data, true);
  return id;
}
