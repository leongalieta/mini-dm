import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectAndRenewToken } from "../lib/token-renewal.js";

const day = 86400;
const now = 1_800_000_000_000;
const seconds = now / 1000;
const credentials = { appId: "123", appSecret: "secret", token: "current", version: "v23.0", now };
const tokenInfo = (expires_at, extra = {}) => ({
  data: { app_id: "123", type: "SYSTEM_USER", user_id: "456", is_valid: true, expires_at, ...extra }
});
const reply = (body) => ({ ok: true, json: async () => body });

test("renova um token de sistema na última semana e valida a nova validade", async () => {
  const calls = [];
  const request = async (url, options) => {
    calls.push(url.pathname);
    if (url.pathname.endsWith("/oauth/access_token")) {
      assert.equal(url.searchParams.get("set_token_expires_in_60_days"), "true");
      assert.equal(url.searchParams.get("fb_exchange_token"), "current");
      return reply({ access_token: "renewed" });
    }
    assert.equal(options.headers.Authorization, "Bearer 123|secret");
    const expires = url.searchParams.get("input_token") === "current" ? seconds + day : seconds + 60 * day;
    return reply(tokenInfo(expires));
  };
  assert.deepEqual(await inspectAndRenewToken({ ...credentials, request }), {
    status: "renewed", expiresAt: (seconds + 60 * day) * 1000, token: "renewed"
  });
  assert.deepEqual(calls, ["/v23.0/debug_token", "/v23.0/oauth/access_token", "/v23.0/debug_token"]);
});

test("não troca um token fora da janela, expirado, sem vencimento ou de outro tipo", async () => {
  for (const [info, status] of [
    [tokenInfo(seconds + 30 * day), "scheduled"],
    [tokenInfo(seconds - day), "invalid"],
    [tokenInfo(0), "nonexpiring"],
    [tokenInfo(seconds + day, { type: "PAGE" }), "unsupported"]
  ]) {
    const request = async (url) => {
      assert.ok(url.pathname.endsWith("/debug_token"));
      return reply(info);
    };
    assert.equal((await inspectAndRenewToken({ ...credentials, request })).status, status);
  }
});
