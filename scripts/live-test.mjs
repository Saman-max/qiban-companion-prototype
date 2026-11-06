// Explicit opt-in only. CI never runs this script. It uses synthetic test data.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { request as localRequest, Agent } from 'node:http';
import { createApp } from '../server/index.mjs';
import { localDay } from '../server/store.mjs';
import { createAliyunTransport } from '../server/aliyun.mjs';

if (process.env.QIBAN_RUN_LIVE_TESTS !== '1' || process.env.AI_PROVIDER !== 'aliyun' || !process.env.DASHSCOPE_API_KEY) {
  throw new Error('Explicit live-test opt-in and an Aliyun key are required.');
}
process.umask(0o077);
const report = { date: localDay(new Date()).date, startedAt: new Date().toISOString(), provider: '阿里云百炼', model: 'qwen3.8-flash', baseURL: process.env.DASHSCOPE_BASE_URL, budgetLimitCny: 10, data: '全部为合成测试数据；不包含真实用户资料', cases: [] };
const prior = process.env.QIBAN_RETRY_FAILED === '1' ? JSON.parse(await readFile(`reports/${report.date}-aliyun-live.json`, 'utf8')) : null;
const retryNames = prior ? new Set(prior.cases.filter(c => c.status === 'FAIL').map(c => c.name)) : null;
if (prior) { report.lastRetestStartedAt = report.startedAt; report.startedAt = prior.startedAt; report.retestNote = '首次完整测试触发本地每分钟6次限流，使用新合成账号和预置合成上下文，只补测被拦截的6项；模型费总账包含所有尝试。'; }
const environment = { ...process.env, NODE_ENV: 'development', PUBLIC_ORIGIN: '', REGISTRATION_CODE: '',
  DATABASE_PATH: resolve('.local/aliyun-live-test.sqlite'), AI_BUDGET_PATH: resolve(process.env.AI_BUDGET_PATH || '.local/aliyun-budget.sqlite'),
  AI_USER_DAILY_LIMIT: '60', AI_GLOBAL_DAILY_LIMIT: '60', DASHSCOPE_MODEL: 'qwen3.8-flash' };
let app, base, alice, bob, memorySpace, planSpace;
const suffix = randomUUID().slice(0, 8), password = randomUUID() + randomUUID();
const names = { nuomi: '糯米', xingmi: '星弥', yao: '曜' };
const localAgent = new Agent({ keepAlive: false });
const chatWindows = new Map();
async function paceChat(cookie) {
  const starts = chatWindows.get(cookie) || [];
  for (;;) {
    const now = Date.now(); while (starts.length && starts[0] <= now - 61000) starts.shift();
    if (starts.length < 6) { starts.push(now); chatWindows.set(cookie, starts); return; }
    console.log('Waiting for the local per-user rate window; no model request is sent while waiting.');
    await new Promise(resolve => setTimeout(resolve, Math.min(60000, Math.max(1, 61000 - (now - starts[0])))));
  }
}
const evidence = value => String(value).slice(0, 700);
async function start() {
  app = createApp({ env: environment, scheduler: false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
}
async function api(path, { method = 'GET', cookie, body } = {}) {
  // A dedicated direct HTTP agent keeps loopback traffic out of OS proxy settings.
  return new Promise((resolve, reject) => {
    const req = localRequest(new URL(path, base), { method, agent: localAgent, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(method === 'GET' ? {} : { Origin: base, 'Content-Type': 'application/json', 'X-Qiban-Request': '1' }) } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString());
          if (response.statusCode >= 400) { const error = new Error(`${response.statusCode} ${result.code}: ${result.error}`); error.code = result.code; reject(error); return; }
          resolve({ data: result, cookie: response.headers['set-cookie']?.[0]?.split(';')[0] });
        } catch { reject(new Error('Local API returned invalid JSON')); }
      });
    });
    req.on('error', error => reject(new Error('Local API connection failed: ' + error.code)));
    req.setTimeout(60000, () => req.destroy(new Error('Local API timeout')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function chat(text, pet = 'nuomi', options = {}) {
  const cookie = options.cookie || alice.cookie;
  await paceChat(cookie);
  const result = await api('/api/chat', { method: 'POST', cookie,
    body: { text, pet, requestId: options.requestId || randomUUID(), privateMode: options.privateMode || false, history: options.history || [] } });
  return result.data;
}
const space = async cookie => (await api('/api/space', { cookie: cookie || alice.cookie })).data;
const save = async value => (await api('/api/space', { method: 'PUT', cookie: alice.cookie, body: value })).data;
async function accept(id) {
  const current = await space();
  return (await api(`/api/proposals/${id}/accept`, { method: 'POST', cookie: alice.cookie, body: { revision: current.revision } })).data;
}
async function run(name, fn, category = '真实模型+后端') {
  if (retryNames && name !== '账号创建与真实服务配置' && !retryNames.has(name)) return;
  const before = app?.budget?.summary().attempts || 0, started = Date.now();
  try {
    const detail = await fn(); report.cases.push({ name, category, status: 'PASS', elapsedMs: Date.now() - started, modelCalls: (app?.budget?.summary().attempts || before) - before, evidence: detail });
    console.log('PASS:', name);
  } catch (error) {
    report.cases.push({ name, category, status: 'FAIL', elapsedMs: Date.now() - started, modelCalls: (app?.budget?.summary().attempts || before) - before, evidence: evidence(error.message) });
    console.log('FAIL:', name, evidence(error.message));
    if (name === '账号创建与真实服务配置' || /401|403|BUDGET_EXHAUSTED/.test(error.message)) throw error;
  }
}
function redPNG() {
  const crc = bytes => { let c = -1; for (const b of bytes) { c ^= b; for (let k = 0; k < 8; k++) c = c >>> 1 ^ (c & 1 ? 0xedb88320 : 0); } return (c ^ -1) >>> 0; };
  const chunk = (type, data) => { const t = Buffer.from(type), length = Buffer.alloc(4), checksum = Buffer.alloc(4); length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([length, t, data, checksum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(64, 0); header.writeUInt32BE(64, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(64 * (1 + 64 * 3));
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) pixels[y * 193 + 1 + x * 3] = 255;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

try {
  await start();
  await run('账号创建与真实服务配置', async () => {
    const config = (await api('/api/config')).data; assert.equal(config.provider, 'aliyun'); assert.equal(config.aiReady, true);
    alice = await api('/api/register', { method: 'POST', body: { username: 'live_a_' + suffix, displayName: '合成测试甲', password } });
    bob = await api('/api/register', { method: 'POST', body: { username: 'live_b_' + suffix, displayName: '合成测试乙', password } });
    assert.ok(alice.cookie && bob.cookie); return { provider: config.provider, emptyMemory: alice.data.space.memories.length === 0 };
  }, '真实后端，无模型费用');
  if (prior) {
    const originalMemories = prior.cases.find(c => c.name === '偏好提取与原文证据、确认后保存')?.evidence?.memories || [];
    const originalPlan = prior.cases.find(c => c.name === '根据偏好生成可确认的目标计划')?.evidence;
    assert.ok(originalMemories.length && originalPlan?.steps?.length, '补测缺少前一轮已通过的合成上下文');
    const current = await space();
    current.memories = originalMemories.map(m => ({ id: randomUUID(), title: '已确认的学习偏好', category: '偏好', content: m.content }));
    current.goals = [{ id: randomUUID(), title: originalPlan.plan, description: '使用上一轮已验证的三天合成计划补测后续流程。', icon: 'leaf', tasks: originalPlan.steps.map(step => ({ id: randomUUID(), title: step.title, minutes: step.minutes, done: false })) }];
    await save(current);
  }
  for (const pet of ['nuomi', 'xingmi', 'yao']) await run(`三款伙伴真实对话：${names[pet]}`, async () => {
    const result = await chat('请先告诉我你的名字，再用两句话回应：今天我有点累，想轻松一点，不希望被责备。', pet);
    assert.ok(result.reply.includes(names[pet]), '回复应包含所选伙伴名字'); assert.ok(result.reply.length > 10);
    return { reply: evidence(result.reply) };
  });
  await run('偏好提取与原文证据、确认后保存', async () => {
    const text = '请记住：我每天只想用十分钟学英语，喜欢温柔的提醒。';
    const result = await chat(text);
    const candidates = result.proposals.filter(p => p.type === 'memory' && text.includes(p.quote));
    assert.ok(candidates.length > 0, '没有生成有原文证据的记忆建议');
    for (const candidate of candidates) { const current = await space(); if (current.proposals.some(p => p.id === candidate.id)) await accept(candidate.id); }
    memorySpace = await space(); assert.ok(memorySpace.memories.length > 0);
    return { memories: memorySpace.memories.map(m => ({ key: m.key, content: m.content, quote: m.quote })) };
  });
  await run('换伙伴后的长期偏好召回', async () => {
    const result = await chat('我之前告诉过你的学习时长和提醒偏好是什么？不确定时请直说。', 'yao');
    assert.match(result.reply, /十|10/); assert.match(result.reply, /温柔|轻柔/); return { reply: evidence(result.reply) };
  });
  await run('根据偏好生成可确认的目标计划', async () => {
    const result = await chat('请根据你已确认的偏好，为我制定一个三天的英语练习计划，每天一个步骤，每天总时长不超过十分钟。请生成可确认的计划建议。', 'xingmi');
    const plan = result.proposals.find(p => p.type === 'plan'); assert.ok(plan, '没有生成计划建议');
    const perDay = new Map(); for (const step of plan.steps) perDay.set(step.dayOffset, (perDay.get(step.dayOffset) || 0) + step.minutes);
    assert.ok([...perDay.values()].every(n => n <= 10), '计划超出每天十分钟的用户偏好');
    planSpace = await accept(plan.id); assert.ok(planSpace.goals.length > 0);
    return { plan: plan.title, steps: planSpace.goals[0].tasks };
  });
  await run('服务重启、同账号第二会话恢复记忆与目标', async () => {
    const before = await space(); const userId = alice.data.user.id; await app.close(); await start();
    const second = await api('/api/login', { method: 'POST', body: { username: 'live_a_' + suffix, password } });
    assert.equal(second.data.user.id, userId); assert.notEqual(second.cookie, alice.cookie);
    const recovered = await space(second.cookie); assert.deepEqual(recovered.memories, before.memories); assert.deepEqual(recovered.goals, before.goals);
    return { memoryCount: recovered.memories.length, goalCount: recovered.goals.length, separateSession: true };
  }, '真实后端，无模型费用');
  await run('进度更新、AI 调整计划并保留已完成项', async () => {
    let current = await space(); assert.ok(current.goals[0]); current.goals[0].tasks[0].done = true; const completedId = current.goals[0].tasks[0].id;
    await save(current);
    const result = await chat('我已经完成了目标中的第一个步骤。请结合最新进度调整这个已有目标的待做计划，每天仍不超过十分钟，保留已完成部分。');
    const proposal = result.proposals.find(p => p.type === 'plan' && p.goalId === current.goals[0].id); assert.ok(proposal, '没有引用已有目标生成调整建议');
    const adopted = await accept(proposal.id); assert.equal(adopted.goals[0].tasks.find(t => t.id === completedId)?.done, true);
    return { completedStepPreserved: true, pendingSteps: adopted.goals[0].tasks.filter(t => !t.done).length };
  });
  await run('到期跟进、安静时段与当日去重', async () => {
    let current = await space(); current.settings.remindersEnabled = true; current = await save(current);
    const dueDay = current.goals.flatMap(g => g.tasks.filter(t => !t.done).map(t => t.dueDate)).sort()[0]; assert.ok(dueDay);
    app.store.followups(new Date(dueDay + 'T01:00:00Z')); const early = app.store.snapshot(alice.data.user.id).checkins.length;
    app.store.followups(new Date(dueDay + 'T12:00:00Z')); app.store.followups(new Date(dueDay + 'T12:00:00Z'));
    const records = app.store.snapshot(alice.data.user.id).checkins; assert.equal(early, 0); assert.equal(records.length, 1);
    return { mode: '程序模拟到期时钟，不是系统推送', text: records[0].text, countAfterTwoScans: records.length };
  }, '真实后端，无模型费用');
  await run('偏好纠正使用相同记忆 key', async () => {
    const current = await space(); const old = current.memories.find(m => /十|10/.test(m.content)); assert.ok(old);
    const result = await chat('请更新我之前的学习时长偏好：我现在每天能用十五分钟学英语，不再是十分钟；提醒方式仍然要温柔。');
    const update = result.proposals.find(p => p.type === 'memory' && p.key === old.key && /十五|15/.test(p.content));
    assert.ok(update, '纠正没有沿用原记忆 key 或没有保存新时长'); const adopted = await accept(update.id);
    assert.match(adopted.memories.find(m => m.key === old.key).content, /十五|15/); return { key: old.key, updated: adopted.memories.find(m => m.key === old.key).content };
  });
  await run('临时对话调用真实 AI，但不写入对话或建议', async () => {
    const before = await space(); const result = await chat('这是临时测试暗号：海边蓝鲸七号。请确认收到，不要记录成长期记忆。', 'nuomi', { privateMode: true });
    assert.ok(result.reply); const after = await space(); assert.deepEqual(after.messages, before.messages); assert.deepEqual(after.memories, before.memories); assert.deepEqual(after.proposals, before.proposals);
    return { reply: evidence(result.reply), databaseUnchanged: true };
  });
  await run('不同账号的模型上下文隔离', async () => {
    const result = await chat('你记得我之前的学习时长和提醒方式吗？没有记录时请直说，不要猜。', 'yao', { cookie: bob.cookie });
    assert.ok(!/十分钟|十五分钟|10分钟|15分钟/.test(result.reply), '其他账号的学习偏好不应出现'); return { reply: evidence(result.reply) };
  });
  await run('手动记忆能被真实模型召回', async () => {
    const current = await space(); current.memories.unshift({ id: randomUUID(), title: '饮品偏好', category: '偏好', content: '我最喜欢无糖柠檬茶。' }); await save(current);
    const result = await chat('你记得我最喜欢喝什么吗？请只根据已确认的记忆回答。'); assert.match(result.reply, /无糖柠檬茶/);
    return { reply: evidence(result.reply) };
  });
  await run('忘记记忆后真实模型不再引用已删饮品偏好', async () => {
    const current = await space(); current.memories = []; const deleted = await save(current); assert.equal(deleted.contextCleared, true); assert.equal(deleted.messages.length, 0);
    const result = await chat('你记得我最喜欢喝什么吗？没有已确认记录时请直说，不要猜。'); assert.ok(!result.reply.includes('柠檬茶'));
    return { reply: evidence(result.reply), oldHistoryCleared: true };
  });
  await run('同请求编号重放不增加模型费用或重复消息', async () => {
    const requestId = randomUUID(), text = '请用一句话和我说晚安。';
    const first = await chat(text, 'nuomi', { requestId }), before = app.budget.summary().attempts;
    const second = await chat(text, 'nuomi', { requestId }); assert.equal(second.reply, first.reply); assert.equal(app.budget.summary().attempts, before);
    return { sameReply: true, extraModelCallsForReplay: 0 };
  });
  await run('视觉理解 API：识别合成红色图片', async () => {
    const call = createAliyunTransport({ apiKey: environment.DASHSCOPE_API_KEY, baseURL: environment.DASHSCOPE_BASE_URL, ledger: app.budget });
    const result = await call({ model: 'qwen3.8-flash', max_tokens: 64, enable_thinking: false, stream: false,
      messages: [{ role: 'user', content: [{ type: 'text', text: '这张图片主要是什么颜色？只回答颜色。' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + redPNG() } }] }] });
    const reply = result.choices[0].message.content; assert.match(reply, /红|red/i);
    return { reply, fixture: '程序生成的 64×64 红色图片，不含摄像头画面', scope: '仅验证模型视觉 API；设备摄像头共享仍未接入' };
  }, '真实模型能力探测');
  await run('导出与退出登录', async () => {
    const exported = (await api('/api/export', { cookie: alice.cookie })).data; assert.ok(Array.isArray(exported.goals));
    await api('/api/logout', { method: 'POST', cookie: alice.cookie, body: {} }); const result = await api('/api/session', { cookie: alice.cookie }); assert.equal(result.data.user, null);
    return { exportReadable: true, loggedOutSessionInvalid: true };
  }, '真实后端，无模型费用');
} catch (error) {
  report.stoppedBecause = evidence(error.message);
} finally {
  if (prior) {
    const merged = new Map(prior.cases.map(c => [c.name, c]));
    for (const c of report.cases) {
      const old = merged.get(c.name);
      if (old?.status === 'FAIL') c.previousAttempt = { status: 'BLOCKED_BY_RATE_LIMIT', evidence: old.evidence };
      merged.set(c.name, c);
    }
    report.cases = [...merged.values()].filter(c => c.status !== 'NOT_IMPLEMENTED');
    report.cases.push({ name: '每用户每分钟速率保护', status: 'PASS', category: '真实后端保护验证', modelCalls: 0, evidence: '首次完整测试的第7次同分钟请求返回429；被拒绝的请求没有增加模型调用记录。原始记录保留在 reports/history。' });
  }
  for (const [name, why] of [
    ['真实设备摄像头授权与跨设备视频共享', '现有产品只有交互演示，尚未实现真实连接；视觉 API 成功不代表摄像头共享已实现。'],
    ['真实麦克风、语音识别和语音合成', '现有产品尚未接入语音 API，本次未产生语音服务调用。'],
    ['手机/浏览器系统推送', '当前仅持久化站内跟进记录，未实现系统推送。'],
    ['四端原生安装包与系统级悬浮桌宠', '当前为浏览器应用，未生成原生安装包。'],
    ['公网真实后端部署', '后端部署位置尚未确定；GitHub Pages 不能运行该后端。'],
  ]) report.cases.push({ name, status: 'NOT_IMPLEMENTED', category: '能力边界', evidence: why, modelCalls: 0 });
  report.finishedAt = new Date().toISOString(); report.budget = app?.budget?.summary();
  report.summary = Object.fromEntries(['PASS','FAIL','NOT_IMPLEMENTED'].map(status => [status, report.cases.filter(c => c.status === status).length]));
  await mkdir('reports', { recursive: true });
  const filename = `reports/${report.date}-aliyun-live`;
  await writeFile(filename + '.json', JSON.stringify(report, null, 2));
  const escape = value => typeof value === 'string' ? value.replaceAll('|', '／').replaceAll('\n', ' ') : JSON.stringify(value).replaceAll('|', '／');
  const budget = report.budget;
  const markdown = `# 栖伴阿里云真实调用测试报告\n\n日期：${report.date}（Asia/Shanghai）\n\n模型：qwen3.8-flash；北京官方接口。所有输入均为合成测试数据。\n\n## 结果\n\n通过 ${report.summary.PASS} 项，失败 ${report.summary.FAIL} 项，未实现 ${report.summary.NOT_IMPLEMENTED} 项。${report.stoppedBecause ? '\n\n停止原因：' + report.stoppedBecause : ''}\n\n| 测试 | 状态 | 类型 | 模型请求数 | 结果证据 |\n| --- | --- | --- | ---: | --- |\n${report.cases.map(c => `| ${c.name} | ${c.status} | ${c.category} | ${c.modelCalls} | ${escape(c.evidence)} |`).join('\n')}\n\n## 费用记录\n\n- 用户授权上限：10 元人民币，仅限本轮程序发起的调用。\n- 累计尝试：${budget?.attempts ?? 0} 次（包含正式测试前的最小连通性探测）。\n- 输入 token：${budget?.inputTokens ?? 0}；输出 token：${budget?.outputTokens ?? 0}。\n- 按北京公开原价估算：${budget?.beijingListPriceEstimateCny.toFixed(6) ?? '未知'} 元（输入0.8元／百万token，输出2.7元／百万token）。\n- 更保守的跨地域费率估算：${budget?.conservativeEstimatedCny.toFixed(6) ?? '未知'} 元（输入2元／百万token，输出5元／百万token）。\n- 为每次请求预留0.25元，累计预留 ${budget?.reservedCny ?? 0} 元；预留额不等于实际收费。失败或不确定的调用不退回预留。\n- 本轮最多24次，单次请求正文不超过40KB、输出最多2048 token、关闭深度思考和联网工具，无自动重试，账本跨重启保留。\n- 以上为模型返回用量与公开原价的计算值，尚未读取阿里云账单，不声称是已核销的实际扣款。\n\n## 独立程序测试\n\n仓库中的 npm test 覆盖账号隔离、来源检查、持久化、版本冲突、偏好删除、临时对话、计划变更、跟进去重、请求重放、前端并发和预算停止机制；这些测试使用模型替身，不产生真实模型费用。\n\n## 官方依据\n\n- [模型能力与原价](https://help.aliyun.com/zh/model-studio/qwen3-8-flash)\n- [结构化输出](https://help.aliyun.com/zh/model-studio/qwen-structured-output)\n- [官方接入地址与地域限制](https://help.aliyun.com/zh/model-studio/base-url)\n\n原始 token、请求编号、耗时与分项证据见同名 JSON 文件。不包含密钥、密码或会话 cookie。\n`;
  await writeFile(filename + '.md', markdown);
  if (app) await app.close();
  localAgent.destroy();
  console.log(JSON.stringify({ report: filename + '.md', summary: report.summary, budget: budget && { attempts: budget.attempts, reservedCny: budget.reservedCny, estimatedCny: budget.beijingListPriceEstimateCny } }));
  if (report.summary.FAIL || report.stoppedBecause) process.exitCode = 1;
}
