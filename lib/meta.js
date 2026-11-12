import fs from "node:fs";
import path from "node:path";

const API_VERSION = process.env.META_API_VERSION || "v23.0";

export class MetaError extends Error {
  constructor(message, { code, subcode, type, status, fbtrace } = {}) {
    super(message);
    this.name = "MetaError";
    this.code = code;
    this.subcode = subcode;
    this.type = type;
    this.status = status;
    this.fbtrace = fbtrace;
  }
  get expired() {
    return this.code === 190;
  }
  get permission() {
    return this.code === 10 || this.code === 200 || this.code === 100;
  }
}

function readDotEnv(file) {
  try {
    const out = {};
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const clean = line.trim();
      if (!clean || clean.startsWith("#")) continue;
      const idx = clean.indexOf("=");
      if (idx < 0) continue;
      out[clean.slice(0, idx).trim()] = clean.slice(idx + 1).trim();
    }
    return out;
  } catch {
    return {};
  }
}

export function resolveAccount(settings = {}) {
  const localEnv = readDotEnv(path.join(process.cwd(), ".env"));

  if (settings.token && settings.token.trim()) {
    return {
      username: settings.accountUsername || "conta",
      igId: localEnv.INSTAGRAM_BUSINESS_ID || settings.igId || "",
      token: settings.token.trim(),
      source: "token salvo nas configuracoes"
    };
  }

  if (process.env.INSTAGRAM_ACCESS_TOKEN) {
    return {
      username: process.env.INSTAGRAM_ACCOUNT || settings.accountUsername || "conta",
      igId: process.env.INSTAGRAM_BUSINESS_ID || "",
      token: process.env.INSTAGRAM_ACCESS_TOKEN,
      source: "variavel de ambiente"
    };
  }

  if (localEnv.INSTAGRAM_ACCESS_TOKEN) {
    return {
      username: localEnv.INSTAGRAM_ACCOUNT || settings.accountUsername || "conta",
      igId: localEnv.INSTAGRAM_BUSINESS_ID || settings.igId || "",
      token: localEnv.INSTAGRAM_ACCESS_TOKEN,
      source: ".env do projeto"
    };
  }

  const file = settings.accountFile || "C:/Users/Leona/claude-instagram/accounts.json";
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const list = Array.isArray(data) ? data : data.accounts || [];
    const wanted = settings.accountUsername || (Array.isArray(data) ? "" : data.default);
    const account =
      list.find((a) => a.username === wanted) ||
      list.find((a) => a.instagram_business_id === settings.igId) ||
      list[0];
    if (!account) throw new Error("conta nao encontrada");
    return {
      username: account.username,
      igId: account.instagram_business_id,
      token: account.access_token,
      pageId: account.facebook_page_id,
      source: file
    };
  } catch (err) {
    throw new Error(`Nao consegui ler as credenciais (${file}): ${err.message}`);
  }
}

export class MetaClient {
  constructor(account) {
    this.account = account;
    this.igId = account.igId;
    this.token = account.token;
    this.version = API_VERSION;
  }

  async call(pathName, { method = "GET", query = {}, body } = {}) {
    const url = new URL(`https://graph.facebook.com/${this.version}/${String(pathName).replace(/^\/+/, "")}`);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    url.searchParams.set("access_token", this.token);
    const options = { method, headers: { "content-type": "application/json" } };
    if (body) options.body = JSON.stringify(body);
    let res;
    try {
      res = await fetch(url, options);
    } catch (err) {
      throw new MetaError(`Falha de rede ao falar com a Meta: ${err.message}`, { status: 0 });
    }
    let json = {};
    try {
      json = await res.json();
    } catch {
      /* resposta sem corpo */
    }
    if (!res.ok || json.error) {
      const e = json.error || {};
      throw new MetaError(e.message || `Erro HTTP ${res.status}`, {
        code: e.code,
        subcode: e.error_subcode,
        type: e.type,
        status: res.status,
        fbtrace: e.fbtrace_id
      });
    }
    return json;
  }

  async validate() {
    const data = await this.call(this.igId, {
      query: { fields: "username,followers_count,media_count" }
    });
    return {
      ok: true,
      username: data.username,
      followers: data.followers_count,
      media: data.media_count
    };
  }

  async recentMedia(limit = 3) {
    const data = await this.call(`${this.igId}/media`, {
      query: { fields: "id,caption,timestamp,permalink,comments_count", limit }
    });
    return data.data || [];
  }

  async comments(mediaId, limit = 50) {
    const data = await this.call(`${mediaId}/comments`, {
      query: { fields: "id,text,username,timestamp", limit }
    });
    return data.data || [];
  }

  async replyToComment(commentId, message) {
    return this.call(`${commentId}/replies`, { method: "POST", body: { message } });
  }

  async sendPrivateReply(igId, commentId, text) {
    return this.call(`${igId}/messages`, {
      method: "POST",
      body: { recipient: { comment_id: commentId }, message: { text } }
    });
  }

  async sendMessage(recipientId, text) {
    return this.call(`${this.igId}/messages`, {
      method: "POST",
      body: { recipient: { id: recipientId }, message: { text } }
    });
  }

  async userProfile(igsid) {
    return this.call(igsid, { query: { fields: "username,name" } });
  }
}

// Descobre o Instagram Business ID a partir do token, quando ele nao foi
// informado nas configuracoes. Tenta a rota de pagina e a de usuario.
export async function discoverIgId(token) {
  if (!token) return "";
  // Token de usuario: lista as paginas e procura o instagram_business_account.
  try {
    const res = await fetch(
      `https://graph.facebook.com/${API_VERSION}/me/accounts?fields=id,name,instagram_business_account&access_token=${token}`
    );
    const data = await res.json();
    for (const p of data?.data || []) {
      if (p.instagram_business_account) return String(p.instagram_business_account.id);
    }
  } catch {
    /* tenta a rota de pagina */
  }
  // Token de pagina: /me e a propria pagina.
  try {
    const res = await fetch(
      `https://graph.facebook.com/${API_VERSION}/me?fields=id,instagram_business_account&access_token=${token}`
    );
    const data = await res.json();
    if (data?.instagram_business_account) return String(data.instagram_business_account.id);
  } catch {
    /* sem igId */
  }
  return "";
}
