import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError } from './provider.mjs';

// A fixed, conservative reservation per network attempt. Failed/unknown attempts
// retain their reservation. Restarting a process never resets this ledger.
// qwen3.8-flash only; <=40 KB request, <=2048 output tokens, no tools/thinking.
export class BudgetLedger {
  constructor(path, { limitCny = 10, maxCalls = 24 } = {}) {
    if (!Number.isFinite(limitCny) || limitCny <= 0 || limitCny > 10 || !Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 36) throw new Error('Live trial limit must be <= CNY 10 and <=36 attempts.');
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY, created TEXT NOT NULL, reserved_micros INTEGER NOT NULL, status TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER, request_id TEXT, estimated_micros INTEGER, error_code TEXT)');
    this.limitMicros = Math.floor(limitCny * 1e6); this.maxCalls = maxCalls;
  }
  reserve(model, bytes, maxTokens) {
    if (model !== 'qwen3.8-flash' || bytes > 40000 || !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 2048) throw new AppError(400, '本轮测试只允许指定模型、短上下文和最多 2048 输出 token。', 'BUDGET_REQUEST_LIMIT');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const { calls, reserved } = this.db.prepare('SELECT count(*) AS calls,coalesce(sum(reserved_micros),0) AS reserved FROM attempts').get();
      if (calls >= this.maxCalls || reserved + 250000 > this.limitMicros) throw new AppError(429, '已达到本轮测试预算或调用次数上限，停止真实请求。', 'BUDGET_EXHAUSTED');
      const id = randomUUID(); this.db.prepare('INSERT INTO attempts(id,created,reserved_micros,status) VALUES(?,?,250000,?)').run(id, new Date().toISOString(), 'reserved');
      this.db.exec('COMMIT'); return id;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  finish(id, { usage, requestId = '', status = 'completed', errorCode = '' }) {
    const input = usage?.prompt_tokens, output = usage?.completion_tokens;
    const valid = Number.isInteger(input) && input >= 0 && Number.isInteger(output) && output >= 0;
    // Conservative all-region estimate: CNY2 / 1M input, CNY5 / 1M output.
    const estimate = valid ? Math.ceil(input * 2 + output * 5) : null;
    this.db.prepare('UPDATE attempts SET status=?,input_tokens=?,output_tokens=?,request_id=?,estimated_micros=?,error_code=? WHERE id=?').run(status, valid ? input : null, valid ? output : null, String(requestId).slice(0, 180), estimate, errorCode, id);
  }
  summary() {
    const rows = this.db.prepare('SELECT * FROM attempts ORDER BY created').all();
    const input = rows.reduce((n, r) => n + (r.input_tokens || 0), 0), output = rows.reduce((n, r) => n + (r.output_tokens || 0), 0);
    return { limitCny: this.limitMicros / 1e6, maxCalls: this.maxCalls, attempts: rows.length,
      reservedCny: rows.reduce((n, r) => n + r.reserved_micros, 0) / 1e6,
      conservativeEstimatedCny: rows.reduce((n, r) => n + (r.estimated_micros || 0), 0) / 1e6,
      beijingListPriceEstimateCny: (input * .8 + output * 2.7) / 1e6,
      inputTokens: input, outputTokens: output, calls: rows };
  }
  close() { this.db.close(); }
}
