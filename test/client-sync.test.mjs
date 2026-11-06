import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const source = await readFile(new URL('../cloud.js', import.meta.url), 'utf8');
const snapshot = (overrides = {}) => ({ revision: 1, epoch: 0,
  settings: { pet: 'nuomi', quiet: true, timezone: 'Asia/Shanghai', remindersEnabled: false, reminderHour: 19 },
  memories: [], goals: [{ id: 'goal', title: '原计划', tasks: [] }], messages: [], proposals: [], checkins: [], ...overrides });

async function client(fetchImpl) {
  const elements = new Map();
  function element() {
    return { value: '', textContent: '', disabled: false, style: {}, addEventListener() {}, setAttribute() {},
      append() {}, appendChild() {}, prepend() {}, after() {}, querySelector() { return element(); } };
  }
  const sandbox = {
    window: { addEventListener() {} }, document: { addEventListener() {}, hidden: false, activeElement: null, createElement: element, querySelector() { return null; } },
    $: selector => { if (!elements.has(selector)) elements.set(selector, element()); return elements.get(selector); },
    state: { pet: 'nuomi', quiet: true, noMemory: false, memories: [], goals: [{ id: 'goal', title: '原计划', tasks: [] }], messages: [] },
    page: 'test', replyPending: false, initialState: () => ({ memories: [], goals: [], messages: [] }),
    renderMain() {}, renderChat() {}, sendMessage() {}, openGoal() {}, openSettings() {}, openModal() {}, closeModal() {},
    scrollChat() {}, navigate() {}, persist() {}, toast() {}, icon: () => '', escapeHTML: String,
    currentPet: () => ({ name: '糯米' }), actions: { 'private-chat'() {}, export() {}, reset() {} },
    crypto: webcrypto, AbortSignal, URL, Blob, FormData,
    setInterval: () => 0, setTimeout, clearTimeout,
    localStorage: { getItem() { return null; }, setItem() {} }, location: { assign() {} },
    fetch: (path, options) => path === '/api/config' ? Promise.resolve(new Response('{"backend":false}')) : fetchImpl(path, options),
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context);
  await new Promise(resolve => setImmediate(resolve));
  const cloud = sandbox.window.QibanCloud;
  cloud.enabled = true; cloud.user = { id: 'user', displayName: '测试' }; cloud.config = { aiReady: true };
  cloud.lastSaved = JSON.stringify(cloud.payload());
  return { sandbox, context, cloud, run: code => vm.runInContext(code, context) };
}

test('a completed AI reply cannot replace edits made while the request was pending', async () => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const c = await client(async path => {
    assert.equal(path, '/api/chat'); entered();
    return new Promise(resolve => { release = resolve; });
  });
  const pending = c.run("sendMessage('请陪我调整计划')");
  await started;
  c.sandbox.state.goals[0].title = '正在编辑的新计划'; c.cloud.dirty = true;
  release(new Response(JSON.stringify({ ...snapshot({ revision: 0 }), reply: '我在。', messages: [{ role: 'assistant', text: '我在。', name: '糯米' }] })));
  await pending;
  assert.equal(c.sandbox.state.goals[0].title, '正在编辑的新计划');
  assert.equal(c.cloud.dirty, true);
  assert.equal(c.sandbox.state.messages.at(-1).text, '我在。');
});

test('a slow space save cannot erase a newer reply already visible in the conversation', async () => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const c = await client(async path => {
    assert.equal(path, '/api/space'); entered(); return new Promise(resolve => { release = resolve; });
  });
  c.cloud.dirty = true;
  const saving = c.cloud.flush(); await started;
  c.sandbox.state.messages.push({ role: 'assistant', text: '刚刚完成的新回复' });
  release(new Response(JSON.stringify(snapshot({ messages: [{ role: 'assistant', text: '旧回复' }] }))));
  await saving;
  assert.equal(c.sandbox.state.messages.at(-1).text, '刚刚完成的新回复');
  assert.equal(c.cloud.dirty, false);
});

test('clearing context removes even ephemeral messages and supersedes keepMessages', async () => {
  const c = await client(async () => { throw Error('Unexpected network request'); });
  c.sandbox.state.messages.push({ role: 'user', text: '不应保留的临时内容', ephemeral: true });
  c.sandbox.nextSnapshot = snapshot({ contextCleared: true, epoch: 1 });
  c.run('applyCloudSpace(nextSnapshot, {keepMessages:true})');
  assert.equal(c.sandbox.state.messages.length, 0); assert.equal(c.cloud.epoch, 1);
});
