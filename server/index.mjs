import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Store, hash, petNames, localDay } from './store.mjs';
import { AppError, createOpenAIProvider, makeInput, validateTurn } from './provider.mjs';
import { createAliyunProvider } from './aliyun.mjs';
import { BudgetLedger } from './budget.mjs';

const scrypt = promisify(scryptCallback);
const root = fileURLToPath(new URL('../', import.meta.url));
const assets = new Set(['index.html', 'app.js', 'pets.js', 'cloud.js', 'style.css', 'assets/mark.svg']);
const mime = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml' };
const tokenHash = token => hash(token);
const safeEqual = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

async function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${(await scrypt(password, salt, 64)).toString('hex')}`;
}
async function passwordMatches(password, encoded) {
  const [salt, expected] = encoded.split(':');
  return safeEqual((await scrypt(password, salt, 64)).toString('hex'), expected);
}
async function jsonBody(req, maxBytes = 65536) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new AppError(415, '请使用 JSON 请求。', 'INVALID_CONTENT_TYPE');
  const chunks = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > maxBytes) throw new AppError(413, '内容超出这次请求的容量。', 'PAYLOAD_TOO_LARGE'); chunks.push(chunk); }
  try { const result = JSON.parse(Buffer.concat(chunks).toString()); if (!result || typeof result !== 'object' || Array.isArray(result)) throw Error(); return result; }
  catch { throw new AppError(400, '请求内容格式不正确。', 'INVALID_JSON'); }
}
function authInput(body, registration = false) {
  if (typeof body.username !== 'string' || !/^[a-zA-Z0-9_-]{3,32}$/.test(body.username)
    || typeof body.password !== 'string' || body.password.length < (registration ? 12 : 1) || body.password.length > 128) {
    throw new AppError(400, registration ? '用户名需为 3–32 位字母、数字或下划线；密码需为 12–128 位。' : '请填写正确的用户名和密码。', 'INVALID_CREDENTIALS');
  }
}

export function createApp(options = {}) {
  const env = options.env || process.env;
  const production = env.NODE_ENV === 'production';
  const publicOrigin = env.PUBLIC_ORIGIN ? new URL(env.PUBLIC_ORIGIN).origin : null;
  if (production && (!publicOrigin?.startsWith('https://') || !env.REGISTRATION_CODE)) throw new Error('Production requires HTTPS PUBLIC_ORIGIN and REGISTRATION_CODE.');
  const store = options.store || new Store(env.DATABASE_PATH || './data/qiban.sqlite');
  const providerName = env.AI_PROVIDER || 'openai';
  if (!['openai', 'aliyun'].includes(providerName)) throw new Error('AI_PROVIDER must be openai or aliyun.');
  const model = providerName === 'aliyun' ? env.DASHSCOPE_MODEL || 'qwen3.8-flash' : env.OPENAI_MODEL;
  const budget = !options.provider && providerName === 'aliyun' ? new BudgetLedger(env.AI_BUDGET_PATH || './data/aliyun-budget.sqlite', { limitCny: Number(env.AI_BUDGET_CNY || 10), maxCalls: Number(env.AI_BUDGET_MAX_CALLS || 24) }) : null;
  const provider = options.provider || (providerName === 'aliyun'
    ? createAliyunProvider({ apiKey: env.DASHSCOPE_API_KEY, model, baseURL: env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1', ledger: budget })
    : createOpenAIProvider({ apiKey: env.OPENAI_API_KEY, model }));
  const aiReady = Boolean(options.provider || (providerName === 'aliyun' ? env.DASHSCOPE_API_KEY : env.OPENAI_API_KEY) && model);
  const inFlight = new Set();
  const configuredLimit = (value, fallback) => Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
  const userLimit = configuredLimit(env.AI_USER_DAILY_LIMIT, 60), globalLimit = configuredLimit(env.AI_GLOBAL_DAILY_LIMIT, 300);

  function send(res, status, data, headers = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }); res.end(JSON.stringify(data));
  }
  function session(req) {
    const token = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('qiban_session='))?.slice(14);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    const row = store.db.prepare('SELECT u.id,u.username,u.display_name FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires>?').get(tokenHash(token), Date.now());
    return row ? { id: row.id, username: row.username, displayName: row.display_name } : null;
  }
  function requireUser(req) { const user = session(req); if (!user) throw new AppError(401, '请先登录你的陪伴空间。', 'UNAUTHENTICATED'); return user; }
  function sessionCookie(userId) {
    const token = randomBytes(32).toString('hex');
    store.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(tokenHash(token), userId, Date.now() + 30 * 86400000);
    return `qiban_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${production ? '; Secure' : ''}`;
  }
  function verifyOrigin(req) {
    if (req.headers['x-qiban-request'] !== '1') throw new AppError(403, '请求缺少来源校验。', 'INVALID_ORIGIN');
    const expected = publicOrigin || `http://${req.headers.host}`;
    if (req.headers.origin && req.headers.origin !== expected) throw new AppError(403, '请从这个陪伴空间的页面发起操作。', 'INVALID_ORIGIN');
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new AppError(403, '不接受其他网站发起的操作。', 'INVALID_ORIGIN');
  }
  function authRate(req, username) {
    const now = Date.now(), bucket = Math.floor(now / 3600000);
    store.reserveLimits([
      { key: `auth-ip:${req.socket.remoteAddress}:${bucket}`, limit: 60, expires: now + 3600000 },
      { key: `auth-user:${username}:${bucket}`, limit: 20, expires: now + 3600000 },
    ], now);
  }

  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (!path.startsWith('/api/')) {
        const file = path === '/' ? 'index.html' : decodeURIComponent(path.slice(1));
        if (!assets.has(file) || !['GET', 'HEAD'].includes(req.method)) throw new AppError(404, '找不到这个页面。', 'NOT_FOUND');
        const body = await readFile(resolve(root, file));
        res.writeHead(200, { 'Content-Type': mime[file.split('.').at(-1)], 'Cache-Control': 'no-cache' });
        res.end(req.method === 'HEAD' ? undefined : body); return;
      }
      if (!['GET', 'HEAD'].includes(req.method)) verifyOrigin(req);
      if (req.method === 'GET' && path === '/api/config') return send(res, 200, { backend: true, aiReady, provider: providerName, model: model || null, registrationRequiresCode: Boolean(env.REGISTRATION_CODE) });
      if (req.method === 'GET' && path === '/api/session') return send(res, 200, { user: session(req) });
      if (req.method === 'POST' && ['/api/register', '/api/login'].includes(path)) {
        const body = await jsonBody(req), registration = path === '/api/register';
        authInput(body, registration); const username = body.username.toLowerCase(); authRate(req, username);
        let user;
        if (registration) {
          if (env.REGISTRATION_CODE && !safeEqual(String(body.code || ''), env.REGISTRATION_CODE)) throw new AppError(403, '邀请码不正确，请联系空间管理员。', 'INVALID_INVITATION');
          if (store.db.prepare('SELECT id FROM users WHERE username=?').get(username)) throw new AppError(409, '这个用户名不可用，请换一个。', 'USERNAME_TAKEN');
          if (typeof body.displayName !== 'string' || !body.displayName.trim() || body.displayName.length > 30) throw new AppError(400, '请填写 1–30 字的称呼。', 'INVALID_INPUT');
          user = store.createUser(username, body.displayName.trim(), await passwordHash(body.password));
        } else {
          const row = store.db.prepare('SELECT * FROM users WHERE username=?').get(username);
          const matched = await passwordMatches(body.password, row?.password || '00000000000000000000000000000000:' + '0'.repeat(128));
          if (!row || !matched) throw new AppError(401, '用户名或密码不正确。', 'INVALID_CREDENTIALS');
          user = { id: row.id, username: row.username, displayName: row.display_name };
        }
        return send(res, 200, { user, space: store.snapshot(user.id) }, { 'Set-Cookie': sessionCookie(user.id) });
      }
      const user = requireUser(req);
      if (path === '/api/logout' && req.method === 'POST') {
        const token = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('qiban_session='))?.slice(14);
        if (token) store.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash(token));
        return send(res, 200, { ok: true }, { 'Set-Cookie': `qiban_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${production ? '; Secure' : ''}` });
      }
      if (path === '/api/space' && req.method === 'GET') { store.followups(); return send(res, 200, store.snapshot(user.id)); }
      if (path === '/api/space' && req.method === 'PUT') {
        const body = await jsonBody(req, 5000000);
        if (!Number.isInteger(body.revision)) throw new AppError(400, '缺少空间版本号。', 'INVALID_INPUT');
        return send(res, 200, store.update(user.id, body, body.revision));
      }
      if (path === '/api/space/reset' && req.method === 'POST') return send(res, 200, store.reset(user.id));
      if (path === '/api/export' && req.method === 'GET') return send(res, 200, { version: 2, exportedAt: new Date().toISOString(), ...store.snapshot(user.id) });
      if (path === '/api/checkins/seen' && req.method === 'POST') {
        const body = await jsonBody(req);
        if (!Array.isArray(body.ids) || body.ids.length > 20 || body.ids.some(id => typeof id !== 'string')) throw new AppError(400, '提醒格式不正确。', 'INVALID_INPUT');
        for (const id of body.ids) store.db.prepare('UPDATE checkins SET seen=1 WHERE id=? AND user_id=?').run(id, user.id);
        return send(res, 200, { ok: true });
      }
      const proposal = path.match(/^\/api\/proposals\/([a-zA-Z0-9_-]+)\/(accept|dismiss)$/);
      if (proposal && req.method === 'POST') {
        if (proposal[2] === 'accept') {
          const body = await jsonBody(req);
          if (!Number.isInteger(body.revision)) throw new AppError(400, '请带上建议预览时的空间版本。', 'INVALID_INPUT');
          return send(res, 200, store.acceptProposal(user.id, proposal[1], body.revision));
        }
        store.db.prepare('DELETE FROM proposals WHERE id=? AND user_id=?').run(proposal[1], user.id);
        return send(res, 200, store.snapshot(user.id));
      }
      if (path === '/api/chat' && req.method === 'POST') {
        const body = await jsonBody(req);
        if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 1500 || typeof body.pet !== 'string' || !Object.hasOwn(petNames, body.pet)
          || typeof body.privateMode !== 'boolean' || !/^[a-zA-Z0-9_-]{12,80}$/.test(body.requestId || '')) throw new AppError(400, '消息格式不正确，最多可发送 1500 字。', 'INVALID_INPUT');
        const fingerprint = hash(JSON.stringify([body.text, body.pet, body.privateMode]));
        const cached = store.db.prepare('SELECT * FROM requests WHERE user_id=? AND id=?').get(user.id, body.requestId);
        if (cached) {
          if (cached.fingerprint !== fingerprint) throw new AppError(409, '请求编号已被另一条消息使用。', 'REQUEST_ID_CONFLICT');
          return send(res, 200, { ...JSON.parse(cached.result), ...store.snapshot(user.id) });
        }
        if (!aiReady) throw new AppError(503, '空间管理员还需要配置所选模型服务的 API Key 和模型。', 'AI_NOT_CONFIGURED');
        if (inFlight.has(user.id)) throw new AppError(409, '伙伴正在回复另一条消息，请稍后再发。', 'CHAT_BUSY');
        inFlight.add(user.id);
        try {
          const now = Date.now(), day = new Date(now).toISOString().slice(0, 10);
          store.reserveLimits([
            { key: `ai-user:${user.id}:${day}`, limit: userLimit, expires: now + 86400000 },
            { key: `ai-global:${day}`, limit: globalLimit, expires: now + 86400000 },
            { key: `ai-minute:${user.id}:${Math.floor(now / 60000)}`, limit: 6, expires: now + 60000 },
          ], now);
          const context = store.row(user.id);
          let history = store.messages(user.id);
          if (body.privateMode) {
            if (!Array.isArray(body.history) || body.history.length > 12 || body.history.some(m => !m || !['user', 'assistant'].includes(m.role) || typeof m.text !== 'string' || m.text.length > 4000)) throw new AppError(400, '临时对话上下文格式不正确。', 'INVALID_INPUT');
            history = body.history;
          }
          const turn = validateTurn(await provider(makeInput({ pet: body.pet, text: body.text, memories: context.memories, goals: context.goals, history, privateMode: body.privateMode, date: localDay(new Date(), context.settings.timezone).date, timezone: context.settings.timezone })), body.text, context.goals, body.privateMode);
          if (store.row(user.id).epoch !== context.epoch) throw new AppError(409, '记忆或对话已经变化，请重新发送。', 'CONTEXT_CHANGED');
          if (body.privateMode) return send(res, 200, { reply: turn.reply, privateMode: true });
          return send(res, 200, store.completeTurn(user.id, { requestId: body.requestId, fingerprint, text: body.text, pet: body.pet, turn, epoch: context.epoch, goals: context.goals }));
        } finally { inFlight.delete(user.id); }
      }
      throw new AppError(404, '找不到这个接口。', 'NOT_FOUND');
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      if (!(error instanceof AppError)) console.error('Qiban request failed:', error.code || error.name);
      send(res, error.status || 500, { error: error instanceof AppError ? error.message : '服务暂时无法完成操作，请稍后重试。', code: error.code && error instanceof AppError ? error.code : 'INTERNAL_ERROR' });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  const interval = options.scheduler === false ? null : setInterval(() => { try { store.followups(); } catch { console.error('Qiban follow-up scan failed.'); } }, 60000);
  interval?.unref();
  return { server, store, budget, close: async () => { if (interval) clearInterval(interval); server.closeIdleConnections(); await new Promise(resolve => server.close(resolve)); store.close(); budget?.close(); } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  const app = createApp();
  const host = process.env.HOST || '127.0.0.1', port = Number(process.env.PORT || 4173);
  app.server.listen(port, host, () => console.log(`Qiban: http://${host}:${port} · provider ${process.env.AI_PROVIDER || 'openai'}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
