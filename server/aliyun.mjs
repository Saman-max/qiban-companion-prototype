import { AppError, turnSchema } from './provider.mjs';

function endpoint(baseURL) {
  const url = new URL(baseURL);
  const official = ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com', 'dashscope-us.aliyuncs.com', 'cn-hongkong.dashscope.aliyuncs.com'].includes(url.hostname)
    || /^[a-zA-Z0-9-]+\.(cn-beijing|ap-southeast-1|cn-hongkong|eu-central-1|ap-northeast-1|us-east-1)\.maas\.aliyuncs\.com$/.test(url.hostname);
  if (url.protocol !== 'https:' || !official || url.username || url.password || url.search || url.hash || url.port) throw new Error('Aliyun credentials may only be sent to an official HTTPS Model Studio endpoint.');
  return baseURL.replace(/\/$/, '') + '/chat/completions';
}

export function createAliyunTransport({ apiKey, baseURL, ledger, fetchImpl = fetch, timeoutMs = 45000 }) {
  const url = endpoint(baseURL);
  return async function call(payload) {
    if (!apiKey) throw new AppError(503, '后端尚未配置阿里云百炼密钥。', 'AI_NOT_CONFIGURED');
    if (!ledger) throw new AppError(503, '本轮真实调用必须启用持久化预算控制。', 'BUDGET_REQUIRED');
    if (payload.enable_thinking !== false || payload.enable_search || payload.tools || payload.stream) throw new AppError(400, '本轮仅测试限额内的非思考、无联网工具调用。', 'BUDGET_REQUEST_LIMIT');
    const body = JSON.stringify(payload);
    const reservation = ledger.reserve(payload.model, Buffer.byteLength(body), payload.max_tokens);
    let response;
    try {
      response = await fetchImpl(url, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    } catch {
      ledger.finish(reservation, { status: 'uncertain', errorCode: 'NETWORK_OR_TIMEOUT' });
      throw new AppError(504, '暂时连接不到阿里云服务，已保留本次预算，不自动重试。', 'AI_UNAVAILABLE');
    }
    let result;
    try { result = await response.json(); } catch {
      ledger.finish(reservation, { status: 'uncertain', errorCode: 'INVALID_UPSTREAM_JSON' });
      throw new AppError(502, '阿里云响应无法解析，本次预算已保留。', 'INVALID_MODEL_OUTPUT');
    }
    const requestId = result.id || result.request_id || response.headers.get('x-request-id') || '';
    if (!response.ok) {
      const code = String(result.error?.code || result.code || `HTTP_${response.status}`).replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 100);
      ledger.finish(reservation, { status: 'rejected', requestId, errorCode: code, usage: result.usage });
      const error = new AppError(response.status === 429 ? 429 : 502, `阿里云未接受请求（HTTP ${response.status}，${code}）。请检查密钥地域、模型权限和账号状态。`, 'AI_UPSTREAM_ERROR');
      error.upstreamStatus = response.status; error.upstreamCode = code; throw error;
    }
    ledger.finish(reservation, { usage: result.usage, requestId });
    if (result.choices?.[0]?.finish_reason === 'length') throw new AppError(502, '本次输出达到 token 限额，回复未写入对话。', 'INCOMPLETE_RESPONSE');
    return result;
  };
}

export function createAliyunProvider({ apiKey, model = 'qwen3.8-flash', baseURL = 'https://dashscope.aliyuncs.com/compatible-mode/v1', ledger, fetchImpl, timeoutMs }) {
  const call = createAliyunTransport({ apiKey, baseURL, ledger, fetchImpl, timeoutMs });
  return async input => {
    const result = await call({ model, messages: input.map(m => ({ ...m, role: m.role === 'developer' ? 'system' : m.role })),
      enable_thinking: false, stream: false, max_tokens: 2048,
      response_format: { type: 'json_schema', json_schema: { name: 'qiban_companion_turn', strict: true, schema: turnSchema } } });
    const message = result.choices?.[0]?.message;
    if (message?.refusal) return { reply: message.refusal, memories: [], plan: null };
    try { return JSON.parse(message.content); }
    catch { throw new AppError(502, '模型未返回有效的结构化回复，没有写入记忆或计划。', 'INVALID_MODEL_OUTPUT'); }
  };
}
