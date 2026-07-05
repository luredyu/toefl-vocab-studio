import { createPersistence } from "../persistence.mjs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

async function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

function getTokenFromHeader(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  return auth.slice(7);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  try {
    const persistence = await createPersistence(root);

    // ---------- session ----------
    if (pathname === '/api/auth/session' && req.method === 'GET') {
      const token = getTokenFromHeader(req);
      if (!token) {
        res.status(401).json({ error: '未授权' });
        return;
      }
      const session = await persistence.getSession(token);
      if (!session) {
        res.status(401).json({ error: '会话无效或已过期' });
        return;
      }
      const user = await persistence.getUserById(session.user_id);
      if (!user) {
        res.status(401).json({ error: '用户不存在' });
        return;
      }
      res.status(200).json({ userId: user.id, email: user.email, createdAt: user.created_at });
      return;
    }

    // ---------- 注册 ----------
    if (pathname === '/api/auth/register' && req.method === 'POST') {
      const { email, password } = await parseBody(req);
      if (!email || !password) {
        res.status(400).json({ error: '缺少邮箱或密码' });
        return;
      }
      const existing = await persistence.findUserByEmail(email);
      if (existing) {
        res.status(409).json({ error: '该邮箱已注册' });
        return;
      }
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = crypto.createHash('sha256').update(password + salt).digest('hex');
      const userId = crypto.randomUUID();
      await persistence.createUser({
        id: userId,
        email,
        password_hash: hash,
        salt,
        created_at: new Date().toISOString(),
      });
      res.status(201).json({ message: '注册成功', userId });
      return;
    }

    // ---------- 登录 ----------
    if (pathname === '/api/auth/login' && req.method === 'POST') {
      const { email, password } = await parseBody(req);
      if (!email || !password) {
        res.status(400).json({ error: '缺少邮箱或密码' });
        return;
      }
      const user = await persistence.findUserByEmail(email);
      if (!user) {
        res.status(401).json({ error: '邮箱或密码错误' });
        return;
      }
      const hash = crypto.createHash('sha256').update(password + user.salt).digest('hex');
      if (hash !== user.password_hash) {
        res.status(401).json({ error: '邮箱或密码错误' });
        return;
      }
      const token = crypto.randomBytes(32).toString('hex');
      await persistence.createSession(token, user.id);
      res.status(200).json({ message: '登录成功', token, userId: user.id });
      return;
    }

    // ---------- 获取状态 ----------
    if (pathname === '/api/state' && req.method === 'GET') {
      const token = getTokenFromHeader(req);
      if (!token) {
        res.status(401).json({ error: '未授权' });
        return;
      }
      const session = await persistence.getSession(token);
      if (!session) {
        res.status(401).json({ error: '会话无效或已过期' });
        return;
      }
      const state = await persistence.readState(session.user_id);
      res.status(200).json({ state: state || {} });
      return;
    }

    // ---------- 保存状态 ----------
    if (pathname === '/api/state' && req.method === 'POST') {
      const token = getTokenFromHeader(req);
      if (!token) {
        res.status(401).json({ error: '未授权' });
        return;
      }
      const session = await persistence.getSession(token);
      if (!session) {
        res.status(401).json({ error: '会话无效或已过期' });
        return;
      }
      const { state } = await parseBody(req);
      if (state === undefined) {
        res.status(400).json({ error: '缺少 state 字段' });
        return;
      }
      await persistence.writeState(session.user_id, state);
      res.status(200).json({ message: '保存成功' });
      return;
    }

    // ---------- 健康检查 ----------
    if (pathname === '/api/health' && req.method === 'GET') {
      res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
      return;
    }

    res.status(404).json({ error: 'API endpoint not found' });
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
}
