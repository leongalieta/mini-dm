import { test } from "node:test";
import assert from "node:assert";
import { resolveAccount } from "../lib/meta.js";
import { resolveAiSettings } from "../lib/ai.js";

// Garante que as variáveis de ambiente são a fonte da verdade quando definidas,
// e que o que está salvo no painel continua valendo quando elas não existem.

function withEnv(vars, fn) {
  const before = {};
  for (const [k, v] of Object.entries(vars)) {
    before[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("token do Instagram: ambiente tem prioridade sobre o token salvo", () => {
  withEnv({ INSTAGRAM_ACCESS_TOKEN: "env-token", INSTAGRAM_ACCOUNT: "env-conta" }, () => {
    const acc = resolveAccount({ token: "token-do-painel", accountUsername: "painel" });
    assert.strictEqual(acc.token, "env-token");
    assert.strictEqual(acc.username, "env-conta");
    assert.strictEqual(acc.source, "variavel de ambiente");
  });
});

test("token do Instagram: sem ambiente, usa o token salvo no painel", () => {
  withEnv({ INSTAGRAM_ACCESS_TOKEN: undefined, INSTAGRAM_ACCOUNT: undefined }, () => {
    const acc = resolveAccount({ token: "token-do-painel", accountUsername: "painel" });
    assert.strictEqual(acc.token, "token-do-painel");
    assert.strictEqual(acc.source, "token salvo nas configuracoes");
  });
});

test("IA: AI_API_KEY do ambiente tem prioridade sobre a chave do painel", () => {
  withEnv({ AI_API_KEY: "env-key", AI_PROVIDER: "openai", AI_MODEL: "gpt-4o-mini" }, () => {
    const cfg = resolveAiSettings({ aiApiKey: "chave-do-painel", aiProvider: "gemini", aiModel: "gemini-1.5-flash" });
    assert.strictEqual(cfg.key, "env-key");
    assert.strictEqual(cfg.provider, "openai");
    assert.strictEqual(cfg.model, "gpt-4o-mini");
  });
});

test("IA: sem ambiente, usa a configuração salva no painel", () => {
  withEnv({ AI_API_KEY: undefined, AI_PROVIDER: undefined, AI_MODEL: undefined, AI_ENABLED: undefined }, () => {
    const cfg = resolveAiSettings({ aiApiKey: "chave-do-painel", aiProvider: "gemini", aiModel: "gemini-1.5-flash", aiEnabled: true });
    assert.strictEqual(cfg.key, "chave-do-painel");
    assert.strictEqual(cfg.provider, "gemini");
    assert.strictEqual(cfg.enabled, true);
  });
});

test("IA: AI_ENABLED=false no ambiente desliga mesmo com o painel ligado", () => {
  withEnv({ AI_ENABLED: "false" }, () => {
    const cfg = resolveAiSettings({ aiEnabled: true });
    assert.strictEqual(cfg.enabled, false);
  });
});
