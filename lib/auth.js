import crypto from "node:crypto";

// ---------- Sistema de login do Mini DM ----------
// Armazena usuários e sessões no PostgreSQL (mesmo banco do app).
// Se LOGIN_DISABLED estiver definido como "true", o login fica desligado
// e o app se comporta como antes (sem autenticação).
//
// A senha é hasheada com scrypt (built-in do Node.js), sem dependências
// nativas, funcionando em qualquer plataforma (Windows, Linux, Docker).

let pgPool = null;

async function getPgPool() {
  if (pgPool) return pgPool;
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  const { Pool } = (await import("pg"));
  pgPool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  return pgPool;
}

function usePg() {
  return Boolean(process.env.DATABASE_URL);
}

function loginDisabled() {
  return process.env.LOGIN_DISABLED === "true";
}

// Sessões ativas em memória (token -> { userId, username, expiresAt })
// Em produção com múltiplos instâncias, isso deveria ir para o banco/Redis.
const sessions = new Map();

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(password, salt, 64);
  return salt + ":" + derived.toString("hex");
}

function verifyPassword(password, hash) {
  const [salt, key] = hash.split(":");
  const derived = crypto.scryptSync(password, salt, 64);
  return derived.toString("hex") === key;
}

export function isLoginDisabled() {
  return loginDisabled();
}

export async function initAuthTables() {
  if (loginDisabled()) return;
  if (!usePg()) return; // sem banco, sem auth persistente
  const pool = await getPgPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      username TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    );
  `);

  // Cria usuário admin padrão se não existir nenhum
  const { rows } = await pool.query(`SELECT id FROM users LIMIT 1`);
  if (!rows.length) {
    const adminId = "admin_" + Math.random().toString(36).slice(2, 10);
    const hash = hashPassword("admin123");
    await pool.query(
      `INSERT INTO users(id, username, password_hash, role) VALUES($1,$2,$3,'admin')`,
      [adminId, "admin", hash]
    );
    console.log("[AUTH] Usuário admin padrão criado: admin / admin123");
  }
}

export async function authenticate(username, password) {
  if (loginDisabled()) return { ok: true, disabled: true };
  if (!usePg()) return { ok: false, error: "Banco não configurado" };

  const pool = await getPgPool();
  const { rows } = await pool.query(
    `SELECT id, username, password_hash, role FROM users WHERE username = $1`,
    [username]
  );
  if (!rows.length) return { ok: false, error: "Usuário ou senha inválidos" };

  const user = rows[0];
  const match = verifyPassword(password, user.password_hash);
  if (!match) return { ok: false, error: "Usuário ou senha inválidos" };

  return {
    ok: true,
    user: { id: user.id, username: user.username, role: user.role }
  };
}

export function createSession(userId, username, ttlMinutes = 120) {
  const token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();
  sessions.set(token, { userId, username, expiresAt });
  return { token, username, expiresAt };
}

export function validateSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (new Date(s.expiresAt) <= new Date()) {
    sessions.delete(token);
    return null;
  }
  // renova um pouco
  s.expiresAt = new Date(Date.now() + 120 * 60 * 1000).toISOString();
  return s;
}

export function destroySession(token) {
  if (token) sessions.delete(token);
}

export async function poolSessionSave(token, userId, username, expiresAt) {
  if (!usePg()) return;
  const pool = await getPgPool();
  await pool.query(
    `INSERT INTO sessions(token, user_id, username, expires_at) VALUES($1,$2,$3,$4)
     ON CONFLICT (token) DO UPDATE SET user_id=EXCLUDED.user_id, username=EXCLUDED.username, expires_at=EXCLUDED.expires_at`,
    [token, userId, username, expiresAt]
  );
}

export async function poolSessionDelete(token) {
  if (!usePg()) return;
  const pool = await getPgPool();
  await pool.query(`DELETE FROM sessions WHERE token = $1`, [token]);
}

export function requireAuth(req, res, next) {
  if (loginDisabled()) return next();
  const auth = req.headers.authorization || "";
  const [scheme, token] = auth.split(" ");
  if (scheme !== "Bearer" || !token) {
    res.writeHead(401, {
      "content-type": "application/json; charset=utf-8",
      "www-authenticate": 'Bearer realm="Mini DM"'
    });
    res.end(JSON.stringify({ error: "Autenticação necessária" }));
    return false;
  }
  const session = validateSession(token);
  if (!session) {
    res.writeHead(401, {
      "content-type": "application/json; charset=utf-8",
      "www-authenticate": 'Bearer realm="Mini DM", error="invalid_token"'
    });
    res.end(JSON.stringify({ error: "Sessão inválida ou expirada" }));
    return false;
  }
  req.user = session;
  return true;
}
