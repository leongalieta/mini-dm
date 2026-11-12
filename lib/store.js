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
  log: []
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

export function loadStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    return {
      settings: { ...DEFAULTS.settings, ...(raw.settings || {}) },
      rules: (Array.isArray(raw.rules) ? raw.rules : DEFAULTS.rules).map(normalizeRule),
      seen: raw.seen && typeof raw.seen === "object" ? raw.seen : {},
      log: Array.isArray(raw.log) ? raw.log : []
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
