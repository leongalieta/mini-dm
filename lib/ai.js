import fs from "node:fs";
import path from "node:path";

// ---------- Agente de IA para o Mini DM ----------
// Suporta Gemini (Google) e qualquer endpoint compatível com OpenAI.
// Configurado nas Configurações do app (provedor, chave, modelo, prompt).

const PROVIDERS = {
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    chatPath: "/models/{model}:generateContent",
    buildBody: (model, systemPrompt, history, key) => ({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: history,
      generationConfig: { temperature: 0.7, maxOutputTokens: 500 }
    }),
    buildUrl: (base, model, key) => `${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
    extractText: (data) => data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || null
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    chatPath: "/chat/completions",
    buildBody: (model, systemPrompt, history, key) => ({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        ...history.map((h) => ({ role: h.role, content: h.parts.map((p) => p.text).join("") }))
      ],
      temperature: 0.7,
      max_tokens: 500
    }),
    buildUrl: (base, model, key) => `${base}/chat/completions`,
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
    extractText: (data) => data.choices?.[0]?.message?.content || null
  }
};

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

export function resolveAiSettings(settings = {}) {
  const localEnv = readDotEnv(path.join(process.cwd(), ".env"));

  const provider = settings.aiProvider || localEnv.AI_PROVIDER || "gemini";
  const key = settings.aiApiKey || localEnv.AI_API_KEY || "";
  const model = settings.aiModel || localEnv.AI_MODEL || (provider === "gemini" ? "gemini-1.5-flash" : "gpt-3.5-turbo");
  const systemPrompt = settings.aiSystemPrompt || localEnv.AI_SYSTEM_PROMPT || "Você é um assistente de atendimento atencioso e profissional. Responda de forma educada e objetiva, em português.";
  const enabled = settings.aiEnabled === true || localEnv.AI_ENABLED === "true";
  const autoSend = settings.aiAutoSend === true || localEnv.AI_AUTO_SEND === "true";

  return { provider, key, model, systemPrompt, enabled, autoSend };
}

export class AiError extends Error {
  constructor(message, { status, provider } = {}) {
    super(message);
    this.name = "AiError";
    this.status = status;
    this.provider = provider;
  }
}

async function callGemini({ provider, key, model, systemPrompt, history }) {
  const p = PROVIDERS.gemini;
  const url = p.buildUrl(p.baseUrl, model, key);
  const body = p.buildBody(model, systemPrompt, history, key);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  let json = {};
  try { json = await res.json(); } catch { /* vazio */ }
  if (!res.ok) {
    throw new AiError(json.error?.message || `Erro HTTP ${res.status}`, { status: res.status, provider: "gemini" });
  }
  return p.extractText(json);
}

async function callOpenai({ provider, key, model, systemPrompt, history }) {
  const p = PROVIDERS.openai;
  const url = p.buildUrl(p.baseUrl, model, key);
  const body = p.buildBody(model, systemPrompt, history, key);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...p.headers(key) },
    body: JSON.stringify(body)
  });
  let json = {};
  try { json = await res.json(); } catch { /* vazio */ }
  if (!res.ok) {
    throw new AiError(json.error?.message || `Erro HTTP ${res.status}`, { status: res.status, provider: "openai" });
  }
  return p.extractText(json);
}

export async function generateReply(history, settingsOverride = {}) {
  const { provider, key, model, systemPrompt, enabled } = resolveAiSettings(settingsOverride);
  if (!enabled) throw new AiError("Agente de IA desativado.");
  if (!key || !key.trim()) throw new AiError("Chave da API não configurada.");

  const contents = history.map((h) => ({
    role: h.direction === "enviada" ? "model" : "user",
    parts: [{ text: h.body }]
  }));

  try {
    if (provider === "gemini") {
      return await callGemini({ provider, key, model, systemPrompt, history: contents });
    }
    if (provider === "openai") {
      return await callOpenai({ provider, key, model, systemPrompt, history: contents });
    }
    throw new AiError(`Provedor não suportado: ${provider}`);
  } catch (err) {
    if (err instanceof AiError) throw err;
    throw new AiError(err.message || "Erro desconhecido ao gerar resposta.", { provider });
  }
}

export function aiHistoryFromLog(log, limit = 12) {
  return (log || [])
    .slice(-limit)
    .map((entry) => ({
      direction: entry.status === "enviada" ? "enviada" : "recebida",
      body: entry.comment || entry.detail || ""
    }));
}
