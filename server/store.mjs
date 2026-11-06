import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AppError } from './provider.mjs';

export const hash = text => createHash('sha256').update(text).digest('hex');
export const petNames = { nuomi: '糯米', xingmi: '星弥', yao: '曜' };
export const defaultSpace = () => ({ settings: { pet: 'nuomi', quiet: true, timezone: 'Asia/Shanghai', remindersEnabled: false, reminderHour: 19 }, memories: [], goals: [] });

export function localDay(now, timezone = 'Asia/Shanghai') {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}
export function addDays(date, days) { return new Date(Date.parse(date + 'T12:00:00Z') + days * 86400000).toISOString().slice(0, 10); }
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(id);
function text(value, max, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new AppError(400, `${name}不能为空，且不能超过 ${max} 字。`, 'INVALID_INPUT');
  return value.trim();
}

export function normalizeSpace(input, previous) {
  const settings = input.settings;
  if (!settings || typeof settings.pet !== 'string' || !Object.hasOwn(petNames, settings.pet) || typeof settings.quiet !== 'boolean' || typeof settings.remindersEnabled !== 'boolean'
    || typeof settings.timezone !== 'string' || settings.timezone.length > 80 || !settings.timezone
    || !Number.isInteger(settings.reminderHour) || settings.reminderHour < 8 || settings.reminderHour > 22) throw new AppError(400, '陪伴设置格式不正确。', 'INVALID_INPUT');
  try { new Intl.DateTimeFormat('en', { timeZone: settings.timezone }).format(); } catch { throw new AppError(400, '请选择有效的时区。', 'INVALID_INPUT'); }
  if (!Array.isArray(input.memories) || input.memories.length > 500 || !Array.isArray(input.goals) || input.goals.length > 30) throw new AppError(400, '记忆或目标数量超过本版本的容量。', 'CAPACITY_LIMIT');
  const ids = new Set();
  const day = localDay(new Date(), settings.timezone).date;
  const memories = input.memories.map(m => {
    if (!m || !validId(m.id) || ids.has(m.id) || !['偏好', '目标', '经历'].includes(m.category)) throw new AppError(400, '记忆格式不正确。', 'INVALID_INPUT');
    ids.add(m.id);
    const old = previous.memories.find(item => item.id === m.id);
    const changed = old && (old.title !== m.title || old.content !== m.content || old.category !== m.category);
    return { id: m.id, key: old?.key || `manual_${m.id.replaceAll('-', '_')}`, category: m.category,
      title: text(m.title, 45, '记忆标题'), content: text(m.content, 600, '记忆内容'),
      source: changed ? '你更新的记忆' : old?.source || '你亲自告诉我', date: old?.date || day,
      quote: changed ? '' : old?.quote || '', updatedAt: Date.now() };
  });
  const goals = input.goals.map(g => {
    if (!g || !validId(g.id) || ids.has(g.id) || !Array.isArray(g.tasks) || g.tasks.length < 1 || g.tasks.length > 100) throw new AppError(400, '目标格式不正确。', 'INVALID_INPUT');
    ids.add(g.id);
    const old = previous.goals.find(item => item.id === g.id);
    return { id: g.id, title: text(g.title, 70, '目标标题'), description: text(g.description, 600, '目标说明'), icon: ['book', 'leaf', 'growth'].includes(g.icon) ? g.icon : 'leaf',
      reviewDate: old?.reviewDate || addDays(day, 7),
      tasks: g.tasks.map(t => {
        if (!t || !validId(t.id) || ids.has(t.id) || typeof t.done !== 'boolean' || !Number.isInteger(t.minutes) || t.minutes < 1 || t.minutes > 120) throw new AppError(400, '目标步骤格式不正确。', 'INVALID_INPUT');
        ids.add(t.id);
        const prior = old?.tasks.find(item => item.id === t.id);
        return { id: t.id, title: text(t.title, 90, '步骤标题'), minutes: t.minutes, done: t.done, dueDate: prior?.dueDate || day };
      }) };
  });
  return { settings: { pet: settings.pet, quiet: settings.quiet, timezone: settings.timezone, remindersEnabled: settings.remindersEnabled, reminderHour: settings.reminderHour }, memories, goals };
}

export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL, password TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS spaces(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, revision INTEGER NOT NULL DEFAULT 0, context_epoch INTEGER NOT NULL DEFAULT 0, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL, pet TEXT NOT NULL, text TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_user ON messages(user_id, created);
      CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE, type TEXT NOT NULL, payload TEXT NOT NULL, goal_fingerprint TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS requests(user_id TEXT REFERENCES users(id) ON DELETE CASCADE, id TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(user_id,id));
      CREATE TABLE IF NOT EXISTS limits(key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS checkins(id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE, day TEXT NOT NULL, text TEXT NOT NULL, pet TEXT NOT NULL, created INTEGER NOT NULL, seen INTEGER NOT NULL DEFAULT 0, UNIQUE(user_id, day));`);
  }
  transaction(callback) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = callback(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  row(userId) {
    const row = this.db.prepare('SELECT * FROM spaces WHERE user_id=?').get(userId);
    if (!row) throw new AppError(401, '请重新登录你的陪伴空间。', 'UNAUTHENTICATED');
    return { revision: row.revision, epoch: row.context_epoch, ...JSON.parse(row.document) };
  }
  snapshot(userId) {
    return { ...this.row(userId), messages: this.messages(userId, 80),
      proposals: this.db.prepare('SELECT id,type,payload FROM proposals WHERE user_id=? ORDER BY created DESC LIMIT 12').all(userId).map(p => ({ id: p.id, type: p.type, ...JSON.parse(p.payload) })),
      checkins: this.db.prepare('SELECT id,text,pet,created FROM checkins WHERE user_id=? AND seen=0 ORDER BY created DESC LIMIT 3').all(userId) };
  }
  messages(userId, limit = 16) {
    return this.db.prepare('SELECT id,role,pet,text,created FROM messages WHERE user_id=? ORDER BY created DESC,rowid DESC LIMIT ?').all(userId, limit).reverse().map(m => ({ ...m, name: petNames[m.pet] }));
  }
  createUser(username, displayName, password) {
    const id = randomUUID();
    this.transaction(() => {
      this.db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(id, username, displayName, password);
      this.db.prepare('INSERT INTO spaces(user_id,document) VALUES(?,?)').run(id, JSON.stringify(defaultSpace()));
    });
    return { id, username, displayName };
  }
  clearContext(userId) {
    for (const table of ['messages', 'proposals', 'requests', 'checkins']) this.db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(userId);
  }
  update(userId, input, expectedRevision) {
    return this.transaction(() => {
      const current = this.row(userId);
      if (current.revision !== expectedRevision) throw new AppError(409, '另一台设备更新了空间，请先处理版本冲突。', 'REVISION_CONFLICT');
      const normalized = normalizeSpace(input, current);
      const contextCleared = current.memories.some(old => {
        const next = normalized.memories.find(m => m.id === old.id);
        return !next || next.content !== old.content || next.title !== old.title || next.category !== old.category;
      });
      if (contextCleared) this.clearContext(userId);
      this.db.prepare('UPDATE spaces SET document=?,revision=revision+1,context_epoch=context_epoch+? WHERE user_id=?').run(JSON.stringify(normalized), contextCleared ? 1 : 0, userId);
      return { ...this.snapshot(userId), contextCleared };
    });
  }
  reset(userId) {
    return this.transaction(() => {
      this.clearContext(userId);
      this.db.prepare('UPDATE spaces SET document=?,revision=revision+1,context_epoch=context_epoch+1 WHERE user_id=?').run(JSON.stringify(defaultSpace()), userId);
      return { ...this.snapshot(userId), contextCleared: true };
    });
  }
  reserveLimits(keys, now = Date.now()) {
    this.transaction(() => {
      this.db.prepare('DELETE FROM limits WHERE expires<?').run(now);
      for (const { key, limit, expires } of keys) {
        const row = this.db.prepare('SELECT count FROM limits WHERE key=?').get(key);
        if ((row?.count || 0) >= limit) throw new AppError(429, '这段时间的使用次数已达到上限，请稍后再试。', 'RATE_LIMIT');
        this.db.prepare('INSERT INTO limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1').run(key, expires);
      }
    });
  }
  completeTurn(userId, { requestId, fingerprint, text, pet, turn, epoch, goals }) {
    return this.transaction(() => {
      if (this.row(userId).epoch !== epoch) throw new AppError(409, '记忆或对话刚刚更新，这次回复已取消，请重新发送。', 'CONTEXT_CHANGED');
      const created = Date.now();
      const insert = this.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)');
      insert.run(randomUUID(), userId, 'user', pet, text, created);
      insert.run(randomUUID(), userId, 'assistant', pet, turn.reply, created + 1);
      this.db.prepare('DELETE FROM proposals WHERE user_id=? AND created<?').run(userId, created - 7 * 86400000);
      for (const memory of turn.memories) this.db.prepare('INSERT INTO proposals VALUES(?,?,?,?,?,?)').run(randomUUID(), userId, 'memory', JSON.stringify(memory), '', created);
      if (turn.plan) this.db.prepare('INSERT INTO proposals VALUES(?,?,?,?,?,?)').run(randomUUID(), userId, 'plan', JSON.stringify(turn.plan), hash(JSON.stringify(goals)), created);
      // Bound raw history. Confirmed preferences and goals are stored separately.
      this.db.prepare('DELETE FROM messages WHERE user_id=? AND id NOT IN(SELECT id FROM messages WHERE user_id=? ORDER BY created DESC,rowid DESC LIMIT 200)').run(userId, userId);
      const result = { reply: turn.reply, ...this.snapshot(userId) };
      this.db.prepare('INSERT INTO requests VALUES(?,?,?,?,?)').run(userId, requestId, fingerprint, JSON.stringify({ reply: turn.reply }), created);
      this.db.prepare('DELETE FROM requests WHERE created<?').run(created - 86400000);
      return result;
    });
  }
  acceptProposal(userId, id, expectedRevision) {
    return this.transaction(() => {
      const proposal = this.db.prepare('SELECT * FROM proposals WHERE id=? AND user_id=?').get(id, userId);
      if (!proposal) throw new AppError(404, '这条建议已处理或已过期。', 'NOT_FOUND');
      if (proposal.created < Date.now() - 7 * 86400000) throw new AppError(409, '这条建议已过期，请重新和伙伴聊聊。', 'STALE_PROPOSAL');
      const value = JSON.parse(proposal.payload), current = this.row(userId);
      if (current.revision !== expectedRevision) throw new AppError(409, '空间已被另一台设备更新，请刷新后重新确认这条建议。', 'REVISION_CONFLICT');
      let clear = false;
      if (proposal.type === 'memory') {
        const old = current.memories.find(m => m.key === value.key);
        if (!old && current.memories.length >= 500) throw new AppError(400, '记忆已满，请整理后再保存。', 'CAPACITY_LIMIT');
        const memory = { ...value, id: old?.id || randomUUID(), source: '你确认的对话记忆', date: localDay(new Date(), current.settings.timezone).date, updatedAt: Date.now() };
        clear = Boolean(old && old.content !== value.content);
        current.memories = [memory, ...current.memories.filter(m => m.key !== value.key)];
      } else {
        if (hash(JSON.stringify(current.goals)) !== proposal.goal_fingerprint) throw new AppError(409, '目标进度已经变化，请让伙伴根据最新进度重新规划。', 'STALE_PLAN');
        const today = localDay(new Date(), current.settings.timezone).date;
        const old = current.goals.find(g => g.id === value.goalId);
        if (value.goalId && !old) throw new AppError(409, '原目标已移除，请重新规划。', 'STALE_PLAN');
        if (!old && current.goals.length >= 30) throw new AppError(400, '目标数量已满，先完成一些小目标吧。', 'CAPACITY_LIMIT');
        const goal = { id: old?.id || randomUUID(), title: value.title, description: value.description, icon: old?.icon || 'leaf', reviewDate: addDays(today, value.reviewAfterDays),
          tasks: [...(old?.tasks.filter(t => t.done) || []), ...value.steps.map(s => ({ id: randomUUID(), title: s.title, minutes: s.minutes, dueDate: addDays(today, s.dayOffset), done: false }))] };
        if (goal.tasks.length > 100) throw new AppError(400, '这个目标的步骤太多，请先整理已完成的步骤。', 'CAPACITY_LIMIT');
        current.goals = [goal, ...current.goals.filter(g => g.id !== goal.id)];
      }
      this.db.prepare('DELETE FROM proposals WHERE user_id=? AND id=?').run(userId, id);
      if (clear) this.clearContext(userId);
      this.db.prepare('UPDATE spaces SET document=?,revision=revision+1,context_epoch=context_epoch+? WHERE user_id=?').run(JSON.stringify({ settings: current.settings, memories: current.memories, goals: current.goals }), clear ? 1 : 0, userId);
      return { ...this.snapshot(userId), contextCleared: clear };
    });
  }
  followups(now = new Date()) {
    const rows = this.db.prepare('SELECT user_id,document FROM spaces').all();
    for (const row of rows) {
      const { settings, goals } = JSON.parse(row.document);
      if (!settings.remindersEnabled) continue;
      const { date, hour } = localDay(now, settings.timezone);
      if (hour < settings.reminderHour || hour >= 23 || hour < 8) continue;
      const due = goals.flatMap(g => g.tasks.filter(t => !t.done && t.dueDate <= date).map(t => ({ ...t, goal: g.title })));
      const review = goals.find(g => g.reviewDate <= date);
      if (!due.length && !review) continue;
      const message = due.length
        ? `今天想陪你完成「${due[0].title}」，先留 ${due[0].minutes} 分钟就好。如果今天不合适，我们也可以调整计划。`
        : `「${review.title}」到了约定的回顾时间。想一起看看哪些步骤有效、哪些可以调整吗？`;
      this.db.prepare('INSERT OR IGNORE INTO checkins VALUES(?,?,?,?,?,?,0)').run(randomUUID(), row.user_id, date, message, settings.pet, now.getTime());
    }
    this.db.prepare('DELETE FROM sessions WHERE expires<?').run(now.getTime());
    this.db.prepare('DELETE FROM checkins WHERE seen=1 AND created<?').run(now.getTime() - 30 * 86400000);
  }
  close() { this.db.close(); }
}
