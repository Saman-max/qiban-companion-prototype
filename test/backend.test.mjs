import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/index.mjs';
import { createOpenAIProvider, validateTurn, AppError } from '../server/provider.mjs';
import { localDay } from '../server/store.mjs';

const emptyTurn = reply => ({ reply, memories: [], plan: null });
const preference = text => ({ reply: '我想记住你的提醒偏好，确认后再保存。', memories: [{ key: 'reminder_style', title: '喜欢温柔的提醒', content: text, category: '偏好', quote: text }], plan: null });
const planTurn = goalId => ({ reply: '这里有一份可确认的计划。', memories: [], plan: { goalId, title: '慢慢提高英语', description: '每天用一点时间，练习有用的表达。', reviewAfterDays: 3, steps: [{ title: '听一小段英文', minutes: 10, dayOffset: 0 }, { title: '用自己的话复述', minutes: 10, dayOffset: 1 }] } });

async function fixture(t, provider = async () => emptyTurn('我在。'), extra = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'qiban-test-'));
  const app = createApp({ env: { DATABASE_PATH: join(directory, 'test.sqlite'), ...extra }, provider, scheduler: false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  async function call(path, { method = 'GET', body, cookie = '', origin = base, marker = true } = {}) {
    const response = await fetch(base + path, { method, headers: { ...(method !== 'GET' ? { 'Content-Type': 'application/json', Origin: origin, ...(marker ? { 'X-Qiban-Request': '1' } : {}) } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  async function register(username = 'alice') {
    const result = await call('/api/register', { method: 'POST', body: { username, displayName: username, password: 'a-long-test-password' } });
    assert.equal(result.status, 200, JSON.stringify(result.body)); return result;
  }
  const chat = (cookie, text = '你好', additions = {}) => call('/api/chat', { method: 'POST', cookie, body: { text, pet: 'nuomi', privateMode: false, requestId: randomUUID(), ...additions } });
  return { app, call, register, chat, directory };
}

test('account ownership, CSRF checks, secrets and server files stay private', async t => {
  const f = await fixture(t), alice = await f.register(), bob = await f.register('bob');
  assert.equal((await f.call('/api/space')).status, 401);
  const payload = { ...alice.body.space, memories: [{ id: randomUUID(), category: '偏好', title: '喜欢茶', content: '更喜欢喝茶' }] };
  const saved = await f.call('/api/space', { method: 'PUT', cookie: alice.cookie, body: payload });
  assert.equal(saved.status, 200); assert.equal(saved.body.memories.length, 1);
  assert.equal(saved.body.memories[0].date, localDay(new Date()).date);
  assert.equal((await f.call('/api/space', { cookie: bob.cookie })).body.memories.length, 0);
  assert.equal((await f.call('/api/space/reset', { method: 'POST', cookie: alice.cookie, body: {}, origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.call('/api/space/reset', { method: 'POST', cookie: alice.cookie, body: {}, marker: false })).status, 403);
  for (const path of ['/.env', '/server/index.mjs', '/data/qiban.sqlite', '/.git/config']) assert.equal((await f.call(path)).status, 404);
  const config = await f.call('/api/config'); assert.equal('apiKey' in config.body, false);
  const badLogin = await f.call('/api/login', { method: 'POST', body: { username: 'alice', password: 'wrong' } }); assert.equal(badLogin.status, 401);
  const logout = await f.call('/api/logout', { method: 'POST', cookie: alice.cookie, body: {} }); assert.equal(logout.status, 200);
  assert.equal((await f.call('/api/space', { cookie: alice.cookie })).status, 401);
});

test('preference extraction requires confirmation, is shared across pets and survives restart', async t => {
  const inputs = [];
  const f = await fixture(t, async input => { inputs.push(input); return inputs.length === 1 ? preference('我喜欢温柔的提醒') : emptyTurn('会按你喜欢的方式提醒。'); });
  const alice = await f.register();
  const chat = await f.chat(alice.cookie, '我喜欢温柔的提醒');
  assert.equal(chat.status, 200); assert.equal(chat.body.memories.length, 0); assert.equal(chat.body.proposals.length, 1);
  const accepted = await f.call(`/api/proposals/${chat.body.proposals[0].id}/accept`, { method: 'POST', cookie: alice.cookie, body: { revision: chat.body.revision } });
  assert.equal(accepted.status, 200); assert.equal(accepted.body.memories[0].quote, '我喜欢温柔的提醒');
  await f.chat(alice.cookie, '你还记得我喜欢什么提醒吗？', { pet: 'yao' });
  assert.match(inputs[1][0].content, /你叫曜/);
  assert.equal(JSON.parse(inputs[1][1].content).context.memories[0].content, '我喜欢温柔的提醒');
  // Open a second process-equivalent DB connection to prove disk persistence, not localStorage.
  const second = createApp({ env: { DATABASE_PATH: join(f.directory, 'test.sqlite') }, provider: async () => emptyTurn('在'), scheduler: false });
  await new Promise(resolve => second.server.listen(0, '127.0.0.1', resolve));
  try { assert.equal(second.store.snapshot(alice.body.user.id).memories.length, 1); }
  finally { await second.close(); }
});

test('forgetting a preference clears old conversation and prevents its next retrieval', async t => {
  const inputs = [];
  const f = await fixture(t, async input => { inputs.push(input); return inputs.length === 1 ? preference('我喜欢温柔的提醒') : emptyTurn('重新告诉我你的偏好吧。'); });
  const alice = await f.register(), first = await f.chat(alice.cookie, '我喜欢温柔的提醒');
  const accepted = await f.call(`/api/proposals/${first.body.proposals[0].id}/accept`, { method: 'POST', cookie: alice.cookie, body: { revision: first.body.revision } });
  const removed = await f.call('/api/space', { method: 'PUT', cookie: alice.cookie, body: { ...accepted.body, memories: [] } });
  assert.equal(removed.body.contextCleared, true); assert.equal(removed.body.messages.length, 0);
  assert.equal(f.app.store.db.prepare('SELECT count(*) AS n FROM requests WHERE user_id=?').get(alice.body.user.id).n, 0);
  await f.chat(alice.cookie, '我想重新设置提醒偏好');
  const context = JSON.parse(inputs[1][1].content).context;
  assert.equal(context.memories.length, 0); assert.equal(context.recentConversation.length, 0);
});

test('private conversation never writes messages, proposals, or request replies', async t => {
  const f = await fixture(t, async () => ({ ...planTurn(null), memories: preference('临时秘密').memories })), alice = await f.register();
  const result = await f.chat(alice.cookie, '临时秘密', { privateMode: true, history: [{ role: 'user', text: '只在这一页聊聊' }] });
  assert.equal(result.status, 200); assert.equal(result.body.privateMode, true);
  const snapshot = f.app.store.snapshot(alice.body.user.id);
  assert.equal(snapshot.messages.length, 0); assert.equal(snapshot.proposals.length, 0); assert.equal(snapshot.memories.length, 0);
  assert.equal(f.app.store.db.prepare('SELECT count(*) AS n FROM requests').get().n, 0);
});

test('plans require approval, stale progress is rejected and completed steps are preserved', async t => {
  let goalId = null;
  const f = await fixture(t, async () => planTurn(goalId)), alice = await f.register();
  const first = await f.chat(alice.cookie, '帮我规划英语'); assert.equal(first.body.goals.length, 0);
  const adopted = await f.call(`/api/proposals/${first.body.proposals[0].id}/accept`, { method: 'POST', cookie: alice.cookie, body: { revision: first.body.revision } });
  assert.equal(adopted.body.goals[0].tasks.length, 2); goalId = adopted.body.goals[0].id;
  const stale = await f.chat(alice.cookie, '调整这个计划');
  const changed = structuredClone(adopted.body); changed.goals[0].tasks[0].done = true;
  const update = await f.call('/api/space', { method: 'PUT', cookie: alice.cookie, body: changed }); assert.equal(update.status, 200);
  assert.equal((await f.call(`/api/proposals/${stale.body.proposals[0].id}/accept`, { method: 'POST', cookie: alice.cookie, body: { revision: update.body.revision } })).status, 409);
  const fresh = await f.chat(alice.cookie, '请根据最新进度调整');
  const freshId = fresh.body.proposals.find(p => p.type === 'plan' && p.id !== stale.body.proposals[0].id).id;
  const accepted = await f.call(`/api/proposals/${freshId}/accept`, { method: 'POST', cookie: alice.cookie, body: { revision: fresh.body.revision } });
  assert.equal(accepted.status, 200); assert.equal(accepted.body.goals[0].tasks.filter(t => t.done).length, 1); assert.equal(accepted.body.goals[0].tasks.length, 3);
});

test('optimistic revision checks stop one device from silently overwriting another', async t => {
  const f = await fixture(t), alice = await f.register(), initial = alice.body.space;
  assert.equal((await f.call('/api/space', { method: 'PUT', cookie: alice.cookie, body: { ...initial, settings: { ...initial.settings, pet: 'yao' } } })).status, 200);
  const stale = await f.call('/api/space', { method: 'PUT', cookie: alice.cookie, body: { ...initial, settings: { ...initial.settings, pet: 'xingmi' } } });
  assert.equal(stale.status, 409); assert.equal(stale.body.code, 'REVISION_CONFLICT');
  assert.equal((await f.call('/api/space', { cookie: alice.cookie })).body.settings.pet, 'yao');
});

test('a repeated request ID does not generate twice; reuse with different text is rejected', async t => {
  let calls = 0; const f = await fixture(t, async () => { calls++; return emptyTurn('收到'); }), alice = await f.register(), requestId = randomUUID();
  assert.equal((await f.chat(alice.cookie, '你好', { requestId })).status, 200);
  assert.equal((await f.chat(alice.cookie, '你好', { requestId })).status, 200);
  assert.equal(calls, 1); assert.equal(f.app.store.messages(alice.body.user.id).length, 2);
  assert.equal((await f.chat(alice.cookie, '不同的消息', { requestId })).status, 409);
});

test('in-flight answers are discarded after a space reset', async t => {
  let release, entered; const started = new Promise(resolve => { entered = resolve; });
  const provider = async () => { entered(); await new Promise(resolve => { release = resolve; }); return emptyTurn('旧上下文的回复'); };
  const f = await fixture(t, provider), alice = await f.register();
  const pending = f.chat(alice.cookie); await started;
  const reset = await f.call('/api/space/reset', { method: 'POST', cookie: alice.cookie, body: {} }); assert.equal(reset.status, 200);
  release(); const response = await pending; assert.equal(response.status, 409); assert.equal(response.body.code, 'CONTEXT_CHANGED');
  assert.equal(f.app.store.messages(alice.body.user.id).length, 0);
});

test('daily check-ins respect opt-in, local time and persistent deduplication', async t => {
  const f = await fixture(t, async () => planTurn(null)), alice = await f.register();
  const turn = await f.chat(alice.cookie, '制定计划');
  const adopted = await f.call(`/api/proposals/${turn.body.proposals[0].id}/accept`, { method: 'POST', cookie: alice.cookie, body: { revision: turn.body.revision } });
  const day = localDay(new Date()).date;
  const evening = new Date(day + 'T12:00:00Z'); // 20:00 Shanghai.
  f.app.store.followups(evening); assert.equal(f.app.store.snapshot(alice.body.user.id).checkins.length, 0);
  await f.call('/api/space', { method: 'PUT', cookie: alice.cookie, body: { ...adopted.body, settings: { ...adopted.body.settings, remindersEnabled: true } } });
  f.app.store.followups(new Date(day + 'T01:00:00Z')); assert.equal(f.app.store.snapshot(alice.body.user.id).checkins.length, 0);
  f.app.store.followups(evening); f.app.store.followups(evening);
  const checkins = f.app.store.snapshot(alice.body.user.id).checkins; assert.equal(checkins.length, 1); assert.match(checkins[0].text, /听一小段英文/);
  await f.call('/api/checkins/seen', { method: 'POST', cookie: alice.cookie, body: { ids: [checkins[0].id] } });
  f.app.store.followups(evening); assert.equal(f.app.store.snapshot(alice.body.user.id).checkins.length, 0);
});

test('upstream failures do not produce fake responses or store unfinished conversations; usage is bounded', async t => {
  const f = await fixture(t, async () => { throw new AppError(502, '模型未完成回复。', 'AI_UPSTREAM_ERROR'); }, { AI_USER_DAILY_LIMIT: '1' }), alice = await f.register();
  assert.equal((await f.chat(alice.cookie)).status, 502);
  assert.equal(f.app.store.messages(alice.body.user.id).length, 0);
  assert.equal((await f.chat(alice.cookie)).status, 429);
});

test('OpenAI request uses server credentials, strict Responses schema and store:false', async () => {
  let request;
  const provider = createOpenAIProvider({ apiKey: 'test-only-key', model: 'test-model', fetchImpl: async (url, options) => {
    request = { url, ...options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(emptyTurn('你好')) }] }] }));
  } });
  assert.equal((await provider([{ role: 'user', content: '你好' }])).reply, '你好');
  assert.equal(request.url, 'https://api.openai.com/v1/responses'); assert.equal(request.headers.Authorization, 'Bearer test-only-key');
  assert.equal(request.body.store, false); assert.equal(request.body.text.format.strict, true); assert.equal(request.body.text.format.type, 'json_schema');
  const refusal = createOpenAIProvider({ apiKey: 'test', model: 'test', fetchImpl: async () => new Response(JSON.stringify({ output: [{ content: [{ type: 'refusal', refusal: '可以换一种方式帮助你。' }] }] })) });
  assert.equal((await refusal([])).memories.length, 0);
  await assert.rejects(createOpenAIProvider({ apiKey: 'test', model: 'test', fetchImpl: async () => { throw Error('network'); } })([]), { code: 'AI_UNAVAILABLE' });
  assert.throws(() => validateTurn({ ...planTurn(null), plan: { ...planTurn(null).plan, steps: [{ title: '坏步骤', minutes: -1, dayOffset: 0 }] } }, '计划', [], false), { code: 'INVALID_PLAN' });
  assert.equal(validateTurn(preference('不存在的原文'), '我没有这么说', [], false).memories.length, 0);
});

test('an unconfigured real backend reports its status and never falls back to mock AI', async t => {
  const f = await fixture(t, null), alice = await f.register();
  const config = await f.call('/api/config'); assert.equal(config.body.aiReady, false);
  const response = await f.chat(alice.cookie, '请和我真正聊天');
  assert.equal(response.status, 503); assert.equal(response.body.code, 'AI_NOT_CONFIGURED');
  assert.equal(f.app.store.messages(alice.body.user.id).length, 0);
});

test('memory suggestions are owner-scoped and require the version the user reviewed', async t => {
  const f = await fixture(t, async () => preference('我喜欢温柔的提醒')), alice = await f.register(), bob = await f.register('bob');
  const turn = await f.chat(alice.cookie, '我喜欢温柔的提醒');
  const id = turn.body.proposals[0].id;
  assert.equal((await f.call(`/api/proposals/${id}/accept`, { method: 'POST', cookie: bob.cookie, body: { revision: 0 } })).status, 404);
  await f.call('/api/space', { method: 'PUT', cookie: alice.cookie, body: { ...turn.body, settings: { ...turn.body.settings, quiet: false } } });
  const stale = await f.call(`/api/proposals/${id}/accept`, { method: 'POST', cookie: alice.cookie, body: { revision: turn.body.revision } });
  assert.equal(stale.status, 409); assert.equal(stale.body.code, 'REVISION_CONFLICT');
  assert.equal(f.app.store.snapshot(alice.body.user.id).memories.length, 0);
});

test('invalid settings and inherited property names cannot become pets or user preferences', async t => {
  const f = await fixture(t), alice = await f.register();
  assert.equal((await f.chat(alice.cookie, '你好', { pet: '__proto__' })).status, 400);
  assert.equal((await f.chat(alice.cookie, '你好', { pet: ['nuomi'] })).status, 400);
  const input = { ...alice.body.space, settings: { ...alice.body.space.settings } }; delete input.settings.timezone;
  assert.equal((await f.call('/api/space', { method: 'PUT', cookie: alice.cookie, body: input })).status, 400);
});
