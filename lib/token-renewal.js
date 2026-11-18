import { createHash } from "node:crypto";

export const tokenFingerprint = (token) => createHash("sha256").update(token).digest("hex");

const RENEWAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export async function inspectAndRenewToken({ appId, appSecret, token, version, now = Date.now(), request = fetch }) {
  async function graph(path, params, authorization) {
    const url = new URL(`https://graph.facebook.com/${version}/${path}`);
    url.search = new URLSearchParams(params);
    const response = await request(url, {
      headers: authorization ? { Authorization: `Bearer ${authorization}` } : {},
      signal: AbortSignal.timeout(15000),
      redirect: "error"
    });
    const data = await response.json();
    if (!response.ok || data.error) throw new Error("A Meta rejeitou a operação de renovação.");
    return data;
  }

  const inspect = async (value) =>
    (await graph("debug_token", { input_token: value }, `${appId}|${appSecret}`)).data;

  const current = await inspect(token);
  const expiresAt = Number(current?.expires_at) * 1000;
  if (!current?.is_valid) return { status: "invalid", expiresAt: expiresAt || null };
  if (current.type !== "SYSTEM_USER" || String(current.app_id) !== appId) {
    return { status: "unsupported", expiresAt: expiresAt || null };
  }
  if (expiresAt === 0) return { status: "nonexpiring", expiresAt: null };
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return { status: "invalid", expiresAt: expiresAt || null };
  if (expiresAt - now > RENEWAL_WINDOW_MS) return { status: "scheduled", expiresAt };

  const exchanged = await graph("oauth/access_token", {
    grant_type: "fb_exchange_token",
    client_id: appId,
    client_secret: appSecret,
    set_token_expires_in_60_days: "true",
    fb_exchange_token: token
  });
  if (typeof exchanged.access_token !== "string" || !exchanged.access_token) {
    throw new Error("A Meta não retornou um token renovado.");
  }
  const renewed = await inspect(exchanged.access_token);
  const renewedExpiry = Number(renewed?.expires_at) * 1000;
  if (!renewed?.is_valid || renewed.type !== "SYSTEM_USER" || String(renewed.app_id) !== appId ||
      renewed.user_id !== current.user_id || !Number.isFinite(renewedExpiry) || renewedExpiry <= expiresAt) {
    throw new Error("Não foi possível confirmar o token renovado.");
  }
  return { status: "renewed", expiresAt: renewedExpiry, token: exchanged.access_token };
}
