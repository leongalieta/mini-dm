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

  const envToken = process.env.INSTAGRAM_ACCESS_TOKEN || localEnv.INSTAGRAM_ACCESS_TOKEN;
  if (envToken) {
    return {
      username: process.env.INSTAGRAM_ACCOUNT || localEnv.INSTAGRAM_ACCOUNT || settings.accountUsername || "conta",
      igId: process.env.INSTAGRAM_BUSINESS_ID || localEnv.INSTAGRAM_BUSINESS_ID || settings.igId || "",
      token: envToken,
      source: process.env.INSTAGRAM_ACCESS_TOKEN ? "variavel de ambiente" : ".env do projeto"
    };
  }

  if (settings.token && settings.token.trim()) {
    return {
      username: settings.accountUsername || "conta",
      igId: localEnv.INSTAGRAM_BUSINESS_ID || settings.igId || "",
      token: settings.token.trim(),
      source: "token salvo nas configuracoes"
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

  // Lista os posts com curtidas/comentarios. Insights (alcance, impressoes,
  // salvamentos) exigem a permissao instagram_manage_insights e nao entram aqui.
  async listMedia({ limit = 50 } = {}) {
    const fields = "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count";
    const posts = [];
    let page = await this.call(`${this.igId}/media`, { query: { fields, limit } });
    for (let i = 0; i < 4; i++) {
      posts.push(...(page.data || []));
      const next = page.paging && page.paging.next;
      if (!next) break;
      const res = await fetch(next);
      page = await res.json().catch(() => ({}));
      if (!res.ok || page.error) break;
    }
    return posts;
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

// IDs de conta do Instagram têm 17 dígitos e passam de Number.MAX_SAFE_INTEGER.
// Lemos o JSON como texto para não perder o último dígito na conversão para número.
export function extractIgAccounts(json) {
  const re = /"instagram_business_account"\s*:\s*\{\s*"id"\s*:\s*"?(\d+)"?(?:\s*,\s*"username"\s*:\s*"([^"]+)")?/g;
  const out = [];
  let m;
  while ((m = re.exec(String(json)))) out.push({ id: m[1], username: m[2] || "" });
  return out;
}

// Descobre o Instagram Business ID a partir do token, quando ele nao foi
// informado nas configuracoes. Tenta a rota de pagina e a de usuario.
export async function discoverIgId(token, wantedUsername = "") {
  if (!token) return "";
  const wanted = String(wantedUsername || "").replace(/^@/, "").trim().toLowerCase();

  const pick = (list) => {
    if (wanted) {
      const match = list.find((a) => a.username.toLowerCase() === wanted);
      if (match) return match.id;
    }
    return list.length ? list[0].id : "";
  };

  // Token de usuario: lista as paginas e procura o instagram_business_account.
  try {
    const res = await fetch(
      `https://graph.facebook.com/${API_VERSION}/me/accounts?fields=id,name,instagram_business_account{id,username}&access_token=${encodeURIComponent(token)}`
    );
    const found = pick(extractIgAccounts(await res.text()));
    if (found) return found;
  } catch {
    /* tenta a rota de pagina */
  }
  // Token de pagina: /me e a propria pagina.
  try {
    const res = await fetch(
      `https://graph.facebook.com/${API_VERSION}/me?fields=id,instagram_business_account&access_token=${encodeURIComponent(token)}`
    );
    const found = pick(extractIgAccounts(await res.text()));
    if (found) return found;
  } catch {
    /* sem igId */
  }
  return "";
}
