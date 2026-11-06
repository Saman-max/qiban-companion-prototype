// Six paid calls maximum: two identical scenarios for each of three companions.
// Reuses the existing cumulative ledger. Never runs in CI and never retries.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { BudgetLedger } from '../server/budget.mjs';
import { createAliyunProvider } from '../server/aliyun.mjs';
import { makeInput, validateTurn } from '../server/provider.mjs';
import { PERSONAS } from '../server/personas.mjs';
import { localDay } from '../server/store.mjs';

if (process.env.QIBAN_RUN_PERSONA_COMPARE !== '1' || process.env.AI_PROVIDER !== 'aliyun' || !process.env.DASHSCOPE_API_KEY) throw new Error('Explicit opt-in and an Aliyun key are required.');
process.umask(0o077);
const ledger = new BudgetLedger(process.env.AI_BUDGET_PATH, { limitCny: Number(process.env.AI_BUDGET_CNY), maxCalls: Number(process.env.AI_BUDGET_MAX_CALLS) });
const before = ledger.summary(), date = localDay(new Date()).date;
if (before.maxCalls - before.attempts < 6 || before.limitCny - before.reservedCny < 1.5) { ledger.close(); throw new Error('Not enough remaining cumulative reservations for six calls.'); }
const previous = JSON.parse(await readFile(`reports/${date}-aliyun-live.json`, 'utf8'));
const baseline = Object.keys(PERSONAS).map(pet => ({ pet, reply: previous.cases.find(c => c.name === `三款伙伴真实对话：${PERSONAS[pet].name}`).evidence.reply }));
const history = [
  { role: 'user', text: '今天我有点累，想轻松一点，不希望被责备。' },
  { role: 'assistant', pet: 'nuomi', text: baseline[0].reply },
];
const memories = [
  { key: 'daily_english_minutes', title: '学习时长', category: '偏好', content: '每天学英语最多十分钟。' },
  { key: 'reminder_tone', title: '提醒偏好', category: '偏好', content: '提醒要温柔，不希望被责备。' },
];
const scenarios = [
  { id: 'tired', name: '疲惫时的陪伴（与旧轮问题相同）', text: '请先告诉我你的名字，再用两句话回应：今天我有点累，想轻松一点，不希望被责备。' },
  { id: 'planning', name: '相同时间约束下的三天计划', text: '我总是拖着不开始学英语。请结合你记住的偏好，给我一份三天的小计划，每天一个步骤，每天总共不超过十分钟，并说清每天怎样算完成。先给我看建议，不要声称已经保存。' },
];
const normalize = text => text.replace(/糯米|星弥|曜/g, '').toLowerCase().replace(/[\p{P}\p{Z}\p{S}\s]/gu, '');
const grams = text => { const chars = [...normalize(text)], result = new Set(); for (let i = 0; i < chars.length - 1; i++) result.add(chars[i] + chars[i + 1]); return result; };
function similarity(a, b) { const x = grams(a), y = grams(b); return x.size + y.size ? [...x].filter(g => y.has(g)).length * 2 / (x.size + y.size) : 1; }
function pairs(rows) {
  const result = [];
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) result.push({ a: rows[i].pet, b: rows[j].pet, diceSimilarity: Number(similarity(rows[i].reply, rows[j].reply).toFixed(4)) });
  return result;
}
const generate = createAliyunProvider({ apiKey: process.env.DASHSCOPE_API_KEY, model: 'qwen3.8-flash', baseURL: process.env.DASHSCOPE_BASE_URL, ledger });
const report = { date, startedAt: new Date().toISOString(), model: 'qwen3.8-flash', provider: '阿里云百炼',
  implementationHashes: Object.fromEntries(await Promise.all(['server/personas.mjs', 'server/provider.mjs', 'server/aliyun.mjs'].map(async path => [path, createHash('sha256').update(await readFile(path)).digest('hex')]))),
  protocol: { plannedCalls: 6, automaticRetry: false, sameSourceContextWithinScenario: true, historyPolicy: '同一份原始历史；发送时只保留用户消息和当前角色自己的回复。确认记忆、目标共享。', allSyntheticData: true,
    similarity: '移除角色名、标点与空白后，计算字符二元组集合的 Dice 相似度；用于发现复读，不代表人格质量评分。', duplicateThreshold: .65,
    manualRubric: ['糯米：情绪承接、轻柔选择、朴素的小动作', '星弥：一个贴切意象、共同探索、具体行动仍清楚', '曜：重点与优先级清楚、可执行动作和完成条件、克制修饰'],
    limits: '每个角色每题仅一次；旧轮样例只作参考，不是统计显著性评估或长期真人体验。' },
  baseline, baselinePairs: pairs(baseline), rows: [], scenarios: [], cumulativeBefore: before };
try {
  for (const scenario of scenarios) {
    const sharedContextHash = createHash('sha256').update(JSON.stringify({ text: scenario.text, memories, goals: [], history, date })).digest('hex');
    for (const pet of Object.keys(PERSONAS)) {
      const started = Date.now();
      let rawTurn;
      try {
        rawTurn = await generate(makeInput({ pet, text: scenario.text, memories, goals: [], history, privateMode: false, date, timezone: 'Asia/Shanghai' }));
        const turn = validateTurn(rawTurn, scenario.text, [], false);
        const checks = { validStructuredOutput: true, substantiveChineseReply: (turn.reply.match(/\p{Script=Han}/gu) || []).length >= 12 };
        if (scenario.id === 'tired') {
          checks.correctIdentity = turn.reply.includes(PERSONAS[pet].name);
          checks.noUnaskedPlan = turn.plan === null;
        } else {
          checks.planPresent = turn.plan !== null;
          if (turn.plan) {
            const totals = new Map();
            for (const step of turn.plan.steps) totals.set(step.dayOffset, (totals.get(step.dayOffset) || 0) + step.minutes);
            checks.threeDaysOneStepEach = turn.plan.steps.length === 3 && totals.size === 3 && [...totals.keys()].sort().join(',') === '0,1,2';
            checks.respectsTenMinuteLimit = [...totals.values()].every(total => total <= 10);
            checks.substantiveActions = turn.plan.steps.every(step => (step.title.match(/\p{Script=Han}/gu) || []).length >= 6);
          }
        }
        report.rows.push({ scenario: scenario.id, pet, name: PERSONAS[pet].name, style: PERSONAS[pet].label, sharedContextHash, reply: turn.reply, plan: turn.plan, checks, status: Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL', elapsedMs: Date.now() - started });
        console.log('Completed:', scenario.id, PERSONAS[pet].name);
      } catch (error) {
        report.rows.push({ scenario: scenario.id, pet, name: PERSONAS[pet].name, status: 'FAIL', error: error.message, ...(rawTurn ? { rejectedOutput: rawTurn } : {}), elapsedMs: Date.now() - started });
        console.log('Failed:', scenario.id, PERSONAS[pet].name, error.code || error.name);
      }
    }
    const rows = report.rows.filter(r => r.scenario === scenario.id && r.reply);
    const pairwise = pairs(rows);
    report.scenarios.push({ id: scenario.id, name: scenario.name, prompt: scenario.text, pairwise, noNearDuplicates: rows.length === 3 && pairwise.every(p => p.diceSimilarity < .65) });
  }
} finally {
  report.finishedAt = new Date().toISOString(); report.cumulativeAfter = ledger.summary();
  report.thisRound = { calls: report.cumulativeAfter.attempts - before.attempts, reservedCny: report.cumulativeAfter.reservedCny - before.reservedCny,
    inputTokens: report.cumulativeAfter.inputTokens - before.inputTokens, outputTokens: report.cumulativeAfter.outputTokens - before.outputTokens,
    estimatedCny: report.cumulativeAfter.beijingListPriceEstimateCny - before.beijingListPriceEstimateCny };
  report.automaticPass = report.rows.length === 6 && report.rows.every(r => r.status === 'PASS') && report.scenarios.every(s => s.noNearDuplicates);
  await mkdir('reports', { recursive: true });
  const filename = `reports/${date}-persona-comparison`;
  // Preserve existing paid evidence before replacing the current report.
  for (const extension of ['json', 'md']) {
    try {
      const old = await readFile(filename + '.' + extension);
      await mkdir('reports/history', { recursive: true });
      await writeFile(`reports/history/${date}-persona-${report.startedAt.replace(/[^0-9]/g, '')}.${extension}`, old);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await writeFile(filename + '.json', JSON.stringify(report, null, 2));
  let markdown = `# 三款桌宠性格与聊天风格对比\n\n日期：${date}（Asia/Shanghai）；模型：qwen3.8-flash。全部为合成测试数据。\n\n## 测试方法\n\n两道问题分别给三款伙伴，使用相同偏好、目标状态与历史记录。历史故意保留上一轮糯米的通用回复，检查换角色后是否只改名字复述。沿用原预算账本，没有清零或自动重试。\n\n自动检查结果：${report.automaticPass ? '通过' : '存在未通过项，详见JSON'}。自动检查覆盖角色身份、结构化输出、计划时间约束与复读检测；风格仍需结合原文审阅。\n\n## 原文对比\n`;
  for (const scenario of report.scenarios) {
    markdown += `\n### ${scenario.name}\n\n问题：${scenario.prompt}\n`;
    for (const row of report.rows.filter(r => r.scenario === scenario.id)) markdown += `\n**${row.name} · ${row.style || ''}**（${row.status}）\n\n${row.reply || row.error}\n${row.plan ? '\n计划：\n\n' + row.plan.steps.map(step => `- 第${step.dayOffset + 1}天：${step.title}，${step.minutes}分钟`).join('\n') + '\n' : ''}`;
    markdown += '\n两两去名字后的文本相似度（越高越相似）：\n\n' + scenario.pairwise.map(p => `- ${PERSONAS[p.a].name} / ${PERSONAS[p.b].name}：${p.diceSimilarity}`).join('\n') + '\n';
  }
  markdown += `\n## 费用与边界\n\n- 本轮真实请求：${report.thisRound.calls}次，输入${report.thisRound.inputTokens} token，输出${report.thisRound.outputTokens} token；北京公开原价估算${report.thisRound.estimatedCny.toFixed(6)}元。\n- 包含上一轮的累计请求：${report.cumulativeAfter.attempts}次，累计原价估算${report.cumulativeAfter.beijingListPriceEstimateCny.toFixed(6)}元。\n- 累计保守估算${report.cumulativeAfter.conservativeEstimatedCny.toFixed(6)}元；累计程序预留${report.cumulativeAfter.reservedCny}元，均低于10元。预留不等于收费，未核验实际账单。\n- 仅两题、每题每角色一条回复；文本差异不等于长期陪伴质量或情感能力已经达标。\n- [模型价格依据](https://help.aliyun.com/zh/model-studio/qwen3-8-flash)；原始用量、请求编号、自动检查与预算账本快照见同名JSON。\n`;
  await writeFile(filename + '.md', markdown);
  console.log(JSON.stringify({ report: filename + '.md', automaticPass: report.automaticPass, thisRound: report.thisRound, cumulative: { calls: report.cumulativeAfter.attempts, reservedCny: report.cumulativeAfter.reservedCny, estimatedCny: report.cumulativeAfter.beijingListPriceEstimateCny } }));
  ledger.close();
  if (!report.automaticPass) process.exitCode = 1;
}
