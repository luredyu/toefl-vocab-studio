import { chmod, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import crypto from "node:crypto";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function createPersistence(root) {
  const supabaseUrl = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
  const isVercel = Boolean(process.env.VERCEL);

  if (supabaseUrl && serviceRoleKey) {
    const secret = requireAppSecret();
    return createSupabasePersistence(supabaseUrl, serviceRoleKey, secret);
  }

  if (isVercel) {
    throw new Error(
      "Vercel 部署缺少 SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY 或 APP_SECRET 环境变量"
    );
  }

  return createLocalPersistence(root);
}

function requireAppSecret() {
  const secret = String(process.env.APP_SECRET || "").trim();
  if (secret.length < 32) {
    throw new Error("APP_SECRET 至少需要 32 个字符");
  }
  return secret;
}

async function createLocalPersistence(root) {
  const dataDir = join(root, "data");
  const usersFile = join(dataDir, "users.json");
  const sessionsFile = join(dataDir, "sessions.json");
  const statesDir = join(dataDir, "states");
  const secretFile = join(dataDir, ".secret");

  await mkdir(statesDir, { recursive: true });

  let users = await readJsonFile(usersFile, {});
  let sessions = await readJsonFile(sessionsFile, {});
  const dailyUsage = new Map();
  const now = Date.now();
  sessions = Object.fromEntries(
    Object.entries(sessions).filter(([, session]) => session.expires_at >= now)
  );

  let secret = "";
  try {
    secret = (await readFile(secretFile, "utf8")).trim();
  } catch {
    secret = crypto.randomBytes(32).toString("hex");
    await writeFile(secretFile, secret, { mode: 0o600 });
  }

  for (const sensitiveFile of [secretFile, usersFile, sessionsFile]) {
    try { await chmod(sensitiveFile, 0o600); } catch {}
  }
  try {
    const stateFiles = await readdir(statesDir);
    await Promise.all(
      stateFiles
        .filter((filename) => filename.endsWith(".json"))
        .map((filename) => chmod(join(statesDir, filename), 0o600))
    );
  } catch {}

  const saveUsers = () => writeFile(usersFile, JSON.stringify(users, null, 2), { mode: 0o600 });
  const saveSessions = () => writeFile(sessionsFile, JSON.stringify(sessions, null, 2), { mode: 0o600 });

  return {
    kind: "local",
    secret,

    async findUserByEmail(email) {
      const entry = Object.entries(users).find(([, user]) => user.email === email);
      return entry ? { id: entry[0], ...entry[1] } : null;
    },

    async getUserById(id) {
      return users[id] ? { id, ...users[id] } : null;
    },

    async createUser(user) {
      if (Object.values(users).some((item) => item.email === user.email)) {
        throw duplicateEmailError();
      }
      users[user.id] = {
        email: user.email,
        password_hash: user.password_hash,
        salt: user.salt,
        created_at: user.created_at,
      };
      await saveUsers();
      return user;
    },

    async createSession(token, userId) {
      sessions[token] = { user_id: userId, expires_at: Date.now() + SESSION_TTL_MS };
      await saveSessions();
    },

    async getSession(token) {
      const session = sessions[token];
      if (!session) return null;
      if (session.expires_at < Date.now()) {
        delete sessions[token];
        await saveSessions();
        return null;
      }
      return session;
    },

    async deleteSession(token) {
      if (!sessions[token]) return;
      delete sessions[token];
      await saveSessions();
    },

    async readState(userId) {
      return readJsonFile(join(statesDir, `${userId}.json`), null);
    },

    async writeState(userId, state) {
      const filePath = join(statesDir, `${userId}.json`);
      const tmpPath = `${filePath}.tmp`;
      await writeFile(tmpPath, JSON.stringify(state), { mode: 0o600 });
      await rename(tmpPath, filePath);
      await chmod(filePath, 0o600);
    },

    async consumeAiQuota(userId, limit) {
      const key = `${userId}:${new Date().toISOString().slice(0, 10)}`;
      const count = dailyUsage.get(key) || 0;
      if (count >= limit) return false;
      dailyUsage.set(key, count + 1);
      return true;
    },
  };
}

function createSupabasePersistence(baseUrl, serviceRoleKey, secret) {
  const rest = async (path, options = {}) => {
    const response = await fetch(`${baseUrl}/rest/v1/${path}`, {
      ...options,
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    const raw = await response.text();
    const payload = raw ? safeJson(raw) : null;
    if (!response.ok) {
      const error = new Error(payload?.message || payload?.hint || `Supabase ${response.status}`);
      error.status = response.status;
      error.code = payload?.code;
      throw error;
    }
    return payload;
  };

  const hashToken = (token) =>
    crypto.createHash("sha256").update(token).digest("hex");

  return {
    kind: "supabase",
    secret,

    async findUserByEmail(email) {
      const rows = await rest(
        `app_users?email=eq.${encodeURIComponent(email)}&select=id,email,password_hash,salt,created_at&limit=1`
      );
      return rows?.[0] || null;
    },

    async getUserById(id) {
      const rows = await rest(
        `app_users?id=eq.${encodeURIComponent(id)}&select=id,email,password_hash,salt,created_at&limit=1`
      );
      return rows?.[0] || null;
    },

    async createUser(user) {
      try {
        const rows = await rest("app_users", {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify(user),
        });
        return rows?.[0] || user;
      } catch (error) {
        if (error.code === "23505") throw duplicateEmailError();
        throw error;
      }
    },

    async createSession(token, userId) {
      await rest("app_sessions", {
        method: "POST",
        body: JSON.stringify({
          token_hash: hashToken(token),
          user_id: userId,
          expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
        }),
      });
    },

    async getSession(token) {
      const tokenHash = hashToken(token);
      const rows = await rest(
        `app_sessions?token_hash=eq.${tokenHash}&select=user_id,expires_at&limit=1`
      );
      const session = rows?.[0];
      if (!session) return null;
      if (Date.parse(session.expires_at) < Date.now()) {
        await this.deleteSession(token);
        return null;
      }
      return { user_id: session.user_id, expires_at: Date.parse(session.expires_at) };
    },

    async deleteSession(token) {
      await rest(`app_sessions?token_hash=eq.${hashToken(token)}`, { method: "DELETE" });
    },

    async readState(userId) {
      const rows = await rest(
        `user_states?user_id=eq.${encodeURIComponent(userId)}&select=state&limit=1`
      );
      return rows?.[0]?.state || null;
    },

    async writeState(userId, state) {
      await rest("user_states?on_conflict=user_id", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({
          user_id: userId,
          state,
          updated_at: new Date().toISOString(),
        }),
      });
    },

    async consumeAiQuota(userId, limit) {
      const result = await rest("rpc/consume_ai_quota", {
        method: "POST",
        body: JSON.stringify({ p_user_id: userId, p_limit: limit }),
      });
      return result === true;
    },
  };
}

async function readJsonFile(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function duplicateEmailError() {
  const error = new Error("该邮箱已注册");
  error.code = "DUPLICATE_EMAIL";
  return error;
}
