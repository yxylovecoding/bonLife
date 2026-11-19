import type { VercelRequest, VercelResponse } from '@vercel/node';
import { ORCHE_HOST } from '../src/utils/apps.js';
import {
  allowLoginAttempt, authenticateAccount, clearSessionCookie, createSession,
  deleteSession, keyMatches, readOwnerAccount, readSession, registerAccount, sameOrigin, type Session,
} from './_auth.js';

function sessionResponse(req: VercelRequest, session: Session) {
  return { authenticated: true, username: session.username, accountId: session.accountId,
    ...(req.headers.host === ORCHE_HOST && session.orcheJobId ? { orcheJobId: session.orcheJobId } : {}) };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Vary', 'Cookie');
  if (!['GET', 'POST', 'DELETE'].includes(req.method || '')) {
    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: '请求方式不支持' });
  }
  if (!sameOrigin(req)) return res.status(403).json({ error: '请求来源无效' });

  try {
    if (req.method === 'DELETE') {
      await deleteSession(req);
      clearSessionCookie(req, res);
      return res.status(200).json({ authenticated: false });
    }
    if (req.method === 'GET') {
      const session = await readSession(req);
      return res.status(200).json(session
        ? sessionResponse(req, session)
        : { authenticated: false });
    }
    if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) {
      return res.status(415).json({ error: '请求格式无效' });
    }
    let body: unknown;
    try {
      body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch {
      return res.status(400).json({ error: '请求格式无效' });
    }
    const { username, password, confirmPassword, key, action } = (body || {}) as Record<string, unknown>;
    if (action !== undefined && action !== 'register') return res.status(400).json({ error: '请求无效' });
    const registering = action === 'register';
    const usesKey = key !== undefined && !registering;
    const validKey = typeof key === 'string' && Boolean(key.trim()) && key.length <= 1024;
    const validCredentials = typeof username === 'string' && Boolean(username.trim()) && username.length <= 100
      && typeof password === 'string' && Boolean(password) && password.length <= 1024;
    if (usesKey ? !validKey : !validCredentials) {
      return res.status(400).json({ error: '请输入账号和密码' });
    }
    if (registering && (password as string).length < 6) return res.status(400).json({ error: '密码至少 6 位' });
    if (registering && (typeof confirmPassword !== 'string' || password !== confirmPassword)) {
      return res.status(400).json({ error: '两次输入的密码不一致' });
    }
    if (!await allowLoginAttempt(req)) {
      res.setHeader('Retry-After', '900');
      return res.status(429).json({ error: '尝试次数过多，请稍后再试' });
    }
    if (registering) {
      const account = await registerAccount((username as string).trim(), password as string);
      if (!account) return res.status(409).json({ error: '账号已存在，请登录' });
      const session = await createSession(req, res, account);
      return res.status(200).json(sessionResponse(req, session));
    }
    if (usesKey) {
      if (!keyMatches((key as string).trim())) return res.status(401).json({ error: 'Key 错误' });
      const session = await createSession(req, res, await readOwnerAccount() ?? undefined);
      return res.status(200).json(sessionResponse(req, session));
    }
    const account = await authenticateAccount((username as string).trim(), password as string);
    if (!account) return res.status(401).json({ error: '账号或密码错误' });
    const session = await createSession(req, res, account);
    return res.status(200).json(sessionResponse(req, session));
  } catch {
    return res.status(503).json({ error: '登录服务暂不可用，请稍后重试' });
  }
}
