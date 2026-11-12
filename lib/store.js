import fs from "node:fs";
import path from "node:path";

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
    maxMediaPerPoll: 3
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

export function storePath() {
  return STORE_FILE;
}

function normalizeRule(rule) {
  return {
    ...rule,
    channel: ["comment", "dm", "both"].includes(rule.channel) ? rule.channel : "comment"
  };
}

function normalizeSchedule(s) {
  return {
    id: s.id || Math.random().toString(36).slice(2, 10),
    username: String(s.username || "").trim(),
    comment: String(s.comment || "").trim(),
    channel: ["comment", "dm", "both"].includes(s.channel) ? s.channel : "dm",
    runAt: s.runAt || new Date().toISOString(),
    status: s.status || "pending", // pending | sent | cancelled | error
    ruleName: String(s.ruleName || "").trim(),
    keyword: String(s.keyword || "").trim(),
    detail: String(s.detail || "").trim(),
    createdAt: s.createdAt || new Date().toISOString()
  };
}

export function loadStore() {
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

export function saveStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = STORE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
  fs.renameSync(tmp, STORE_FILE);
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
