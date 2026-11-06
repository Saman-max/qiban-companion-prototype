'use strict';
// The real service serves this UI and /api on the SAME origin. No model key ever enters the browser.
const Cloud = window.QibanCloud = {
  enabled: false, user: null, config: null, revision: 0, epoch: 0, proposals: [], checkins: [],
  settings: { timezone: 'Asia/Shanghai', remindersEnabled: false, reminderHour: 19 },
  dirty: false, savePromise: null, timer: null, lastSaved: '', conflict: null, turn: 0,
  queueSave() {
    if (!this.user) return;
    this.dirty = JSON.stringify(this.payload()) !== this.lastSaved;
    clearTimeout(this.timer);
    if (this.dirty && !this.conflict) this.timer = setTimeout(() => this.flush().catch(showCloudError), 350);
    updateCloudHeader();
  },
  payload() {
    return { settings: { ...this.settings, pet: state.pet, quiet: state.quiet }, memories: state.memories, goals: state.goals };
  },
  async flush() {
    clearTimeout(this.timer);
    if (this.conflict) throw new Error('请先处理另一台设备的更新，再继续。');
    if (this.savePromise) { await this.savePromise; if (this.dirty) return this.flush(); return; }
    if (!this.user || !this.dirty) return;
    const payload = this.payload(), serialized = JSON.stringify(payload), userId = this.user.id;
    this.dirty = false;
    this.savePromise = (async () => {
      try {
        const result = await cloudRequest('/api/space', 'PUT', { revision: this.revision, ...payload });
        if (this.user?.id !== userId) return;
        this.revision = result.revision;
        if (JSON.stringify(this.payload()) === serialized) {
          applyCloudSpace(result, { keepMessages: true });
          renderMain();
          if (result.contextCleared) { renderChat(); toast('记忆已更新，并清理旧对话上下文，避免再次引用旧内容。'); }
        } else { this.lastSaved = JSON.stringify({ settings: result.settings, memories: result.memories, goals: result.goals }); this.dirty = true; }
      } catch (error) {
        if (this.user?.id !== userId) return;
        this.dirty = true;
        if (error.code === 'REVISION_CONFLICT') {
          this.conflict = payload;
          openConflict();
        }
        throw error;
      } finally { this.savePromise = null; }
    })();
    await this.savePromise;
    if (this.dirty && !this.conflict) return this.flush();
  },
};

async function cloudRequest(path, method = 'GET', data) {
  let response;
  try {
    response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store',
      headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Qiban-Request': '1' },
      body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(60000) });
  } catch { throw new Error('暂时连接不到陪伴空间。请检查网络后重试，更改还保留在当前页面。'); }
  let result;
  try { result = await response.json(); } catch { throw new Error('这个地址暂时没有可用的陪伴服务。'); }
  if (!response.ok) { const error = new Error(result.error || '这次操作没有完成，请稍后重试。'); error.code = result.code; error.status = response.status; throw error; }
  return result;
}
function showCloudError(error) {
  if (error.status === 401) {
    clearCloudSession();
    openCloudAuth();
  }
  toast(error.message);
}
function clearCloudSession() {
  Cloud.turn++; Cloud.user = null; Cloud.dirty = false; Cloud.conflict = null; Cloud.proposals = []; Cloud.checkins = [];
  clearTimeout(Cloud.timer); replyPending = false;
  state = { ...initialState(), memories: [], goals: [], messages: [] };
  $('#floating-pet').hidden = true;
  render();
}
function applyCloudSpace(space, { keepMessages = false } = {}) {
  const visibleMessages = state.messages;
  const ephemeral = space.contextCleared ? [] : state.messages.filter(m => m.ephemeral);
  Cloud.revision = space.revision;
  Cloud.epoch = space.epoch;
  Cloud.settings = { ...space.settings };
  Cloud.proposals = space.proposals || [];
  Cloud.checkins = space.checkins || [];
  state.pet = space.settings.pet; state.quiet = space.settings.quiet;
  state.memories = space.memories; state.goals = space.goals;
  state.messages = keepMessages && !space.contextCleared ? visibleMessages : [...space.messages, ...ephemeral];
  Cloud.lastSaved = JSON.stringify(Cloud.payload());
  Cloud.dirty = false;
}
function providerLabel() { return Cloud.config?.provider === 'aliyun' ? '阿里云百炼' : 'OpenAI'; }
function updateCloudHeader() {
  const label = $('#cloud-button');
  if (!label) return;
  label.textContent = Cloud.enabled ? Cloud.user ? `${Cloud.user.displayName}的空间` : '登录空间' : '连接 AI';
  $('.demo-badge').textContent = Cloud.enabled ? Cloud.dirty ? '更改待保存' : Cloud.config.aiReady ? 'AI 已配置' : 'AI 待配置' : '交互原型';
  if (Cloud.user) {
    const profile = $('#settings-button');
    profile.querySelector('strong').textContent = Cloud.user.displayName;
    profile.querySelector('small').textContent = '记忆与目标 · 账号保存';
  } else {
    $('#settings-button strong').textContent = '我的空间';
    $('#settings-button small').textContent = Cloud.enabled ? '登录后跨设备继续' : '个人陪伴空间';
  }
}

function openCloudAuth(register = false) {
  openModal(register ? '开始一段，记得你的陪伴。' : '欢迎回来，我一直在。', `
    <p>登录同一个陪伴空间，三款桌宠共享你的偏好、目标与进度。</p>
    <form id="cloud-auth-form">
      <label class="field">用户名<input name="username" required pattern="[a-zA-Z0-9_-]{3,32}" minlength="3" maxlength="32" autocomplete="username" placeholder="3–32 位字母、数字或下划线"></label>
      ${register ? '<label class="field">想让我怎么称呼你？<input name="displayName" required maxlength="30" autocomplete="nickname" placeholder="你喜欢的称呼"></label>' : ''}
      <label class="field">密码<input name="password" type="password" required minlength="${register ? '12' : '1'}" maxlength="128" autocomplete="${register ? 'new-password' : 'current-password'}" placeholder="${register ? '至少 12 位，请妥善保管' : '输入你的密码'}"></label>
      ${register && Cloud.config.registrationRequiresCode ? '<label class="field">空间邀请码<input name="code" type="password" required autocomplete="off" placeholder="由空间管理员提供"></label>' : ''}
      <p class="form-error" id="auth-error" role="alert"></p>
      <div class="modal-actions"><button type="button" class="button" data-cloud="${register ? 'login' : 'register'}">${register ? '已有账号，去登录' : '创建账号'}</button><button class="button primary" type="submit">${register ? '创建我的空间' : '回到我的空间'} ${icon('arrow')}</button></div>
    </form>
    <div class="privacy-note">${icon('shield')}<span>模型密钥仅保存在后端。登录后，对话与确认的记忆会保存在本服务数据库；聊天时相关内容会发送给${providerLabel()}生成回复。</span></div>`, 'YOUR OWN COMPANION SPACE');
  $('#cloud-auth-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.target.querySelector('[type="submit"]'); button.disabled = true;
    const data = Object.fromEntries(new FormData(event.target));
    try {
      const result = await cloudRequest(register ? '/api/register' : '/api/login', 'POST', data);
      Cloud.user = result.user;
      state = { ...initialState(), memories: [], goals: [], messages: [] };
      applyCloudSpace(result.space); closeModal(); render();
      toast(`${Cloud.user.displayName}，欢迎回到你的陪伴空间。`);
    } catch (error) { $('#auth-error') && ($('#auth-error').textContent = error.message); }
    finally { button.disabled = false; }
  });
}

function openCloudConnection() {
  if (Cloud.enabled) {
    if (!Cloud.user) { openCloudAuth(); return; }
    openModal('你的真实陪伴空间', `<div class="connection-status">${icon(Cloud.config.aiReady ? 'sparkles' : 'settings')}<div><h3>${Cloud.config.aiReady ? providerLabel() + '已配置' : '还差后端模型配置'}</h3><p>${Cloud.config.aiReady ? '对话会读取你确认的记忆与当前目标。' : '管理员需要在后端配置所选服务的 API Key 和模型名，重启后即可使用。'}</p></div></div><p>确认的偏好与目标保存在本服务数据库。同一服务地址、同一账号可以在其他设备继续。摄像头和语音仍为流程演示。</p><div class="modal-actions"><button class="button" data-cloud="logout">退出账号</button><button class="button primary" data-action="close-modal">了解了</button></div>`, 'CONNECTED, WITH MEMORY');
    return;
  }
  let saved = ''; try { saved = localStorage.getItem('qiban-backend-origin') || ''; } catch {}
  openModal('让陪伴，真正开始。', `<p>当前是 GitHub Pages 展示站。真实 AI 与长期记忆需要一个运行后端的陪伴空间。</p><form id="backend-form"><label class="field">陪伴空间地址<input name="origin" type="url" value="${escapeHTML(saved)}" required placeholder="https://你的陪伴服务地址"></label><p class="form-error" id="backend-error" role="alert"></p><div class="modal-actions"><button class="button" type="button" data-action="close-modal">先体验原型</button><button class="button primary" type="submit">打开真实陪伴空间 ${icon('arrow')}</button></div></form><div class="privacy-note">${icon('shield')}<span>请只使用你信任的服务地址。这里不收集模型密钥；真实聊天将在该服务页面登录后进行。</span></div>`, 'A COMPANION THAT REMEMBERS');
  $('#backend-form').addEventListener('submit', event => {
    event.preventDefault();
    try {
      const url = new URL(new FormData(event.target).get('origin'));
      if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error();
      try { localStorage.setItem('qiban-backend-origin', url.origin); } catch {}
      location.assign(url.origin + '/');
    } catch { $('#backend-error').textContent = '请填写 HTTPS 服务根地址；本地测试可以使用 http://localhost:4173。'; }
  });
}

async function openConflict() {
  if (!Cloud.conflict || !Cloud.user) return;
  let latest;
  try { latest = await cloudRequest('/api/space'); } catch (error) { showCloudError(error); return; }
  openModal('另一台设备，更新了这个空间。', `<p>为避免覆盖更新，请选择要保留的版本。当前设备还有 ${Cloud.conflict.memories.length} 段记忆、${Cloud.conflict.goals.length} 个目标待保存；服务端有 ${latest.memories.length} 段记忆、${latest.goals.length} 个目标。</p><div class="modal-actions"><button class="button" id="conflict-server">加载服务端版本</button><button class="button primary" id="conflict-local">用本机内容替换</button></div>`, 'KEEP THE VERSION YOU CHOOSE');
  $('#conflict-server').onclick = () => { Cloud.conflict = null; applyCloudSpace(latest); closeModal(); render(); toast('已加载服务端最新内容。'); };
  $('#conflict-local').onclick = async () => {
    Cloud.revision = latest.revision; Cloud.conflict = null; Cloud.dirty = true; closeModal();
    try { await Cloud.flush(); toast('本机内容已保存。'); } catch (error) { showCloudError(error); }
  };
}

const demoSendMessage = sendMessage;
sendMessage = async function realSendMessage(text) {
  if (!Cloud.enabled) { demoSendMessage(text); return; }
  if (!Cloud.user) { openCloudAuth(); return; }
  text = text.trim(); if (!text) return;
  if (replyPending) { toast('伙伴正在认真回复这一句，请稍等一下。'); return; }
  if (!Cloud.config.aiReady) { openCloudConnection(); return; }
  const privateMode = state.noMemory, pet = state.pet, name = currentPet().name, userId = Cloud.user.id, turn = ++Cloud.turn;
  const history = state.messages.filter(m => ['user', 'assistant'].includes(m.role)).slice(-12).map(m => ({ role: m.role, text: m.text.slice(0, 4000), pet: m.pet || Object.keys(window.PETS || {}).find(id => window.PETS[id].name === m.name) || null }));
  const pendingId = crypto.randomUUID();
  $('#chat-input').value = '';
  state.messages.push({ id: pendingId, role: 'user', text, name: '你', ephemeral: true });
  replyPending = true; renderChat();
  try {
    await Cloud.flush();
    const result = await cloudRequest('/api/chat', 'POST', { requestId: pendingId, text, pet, privateMode, history: privateMode ? history : [] });
    if (Cloud.user?.id !== userId || turn !== Cloud.turn) return;
    if (privateMode) state.messages.push({ role: 'assistant', text: result.reply, name, pet, ephemeral: true });
    else {
      state.messages = state.messages.filter(m => m.id !== pendingId);
      if (Cloud.dirty || Cloud.savePromise || result.revision < Cloud.revision) {
        // A reply must not replace edits made while the model was working.
        if (result.epoch >= Cloud.epoch) {
          state.messages = [...result.messages, ...state.messages.filter(m => m.ephemeral)];
          Cloud.proposals = result.proposals; Cloud.checkins = result.checkins;
        }
      } else applyCloudSpace(result);
    }
    renderMain();
  } catch (error) {
    if (Cloud.user?.id !== userId || turn !== Cloud.turn) return;
    state.messages = state.messages.filter(m => m.id !== pendingId);
    state.messages.push({ role: 'system', name: '连接提示', text: error.message + ' 你可以重新发送，系统不会用演示回复替代。', ephemeral: true });
    if (error.status === 401) { clearCloudSession(); openCloudAuth(); }
  } finally {
    if (turn === Cloud.turn) { replyPending = false; renderChat(); }
  }
};

const originalRenderChat = renderChat;
renderChat = function cloudRenderChat() {
  const draft = Cloud.enabled ? $('#chat-input')?.value || '' : '';
  originalRenderChat();
  if (!Cloud.enabled) return;
  if (draft) $('#chat-input').value = draft;
  const disclaimer = $('.chat-disclaimer');
  disclaimer.textContent = !Cloud.user ? '登录后，继续有记忆的陪伴。' : !Cloud.config.aiReady ? 'AI 尚未配置 · 记忆与目标可以先使用' : state.noMemory ? '临时对话不写入栖伴数据库；本次输入仍由模型服务处理。' : 'AI 回复 · 记忆与计划经你确认后保存';
  const composer = $('#chat-input');
  composer.placeholder = Cloud.user ? '聊聊近况、偏好，或想实现的目标…' : '先登录，让伙伴真正认识你…';
  if (replyPending) { $('.send-button').disabled = true; $('.send-button').setAttribute('aria-label', 'AI 正在回复'); }
  if (Cloud.checkins.length) {
    const box = document.createElement('div'); box.className = 'cloud-checkins';
    box.innerHTML = Cloud.checkins.map(c => `<div class="checkin-card"><span>${icon('leaf')}伙伴的跟进</span><p>${escapeHTML(c.text)}</p><button class="text-button" data-cloud-seen="${c.id}">收到，按我的节奏来 ${icon('check')}</button></div>`).join('');
    $('#chat-messages').append(box);
  }
  if (Cloud.proposals.length) {
    const box = document.createElement('div'); box.className = 'cloud-proposals'; box.setAttribute('aria-label', 'AI 建议，等待你确认');
    box.innerHTML = Cloud.proposals.slice(0, 4).map(p => `<div class="proposal-card"><div class="proposal-caption">${icon(p.type === 'memory' ? 'memory' : 'growth')}${p.type === 'memory' ? '这件事，值得记住吗？' : '一个可以一起试试的计划'}</div><strong>${escapeHTML(p.title)}</strong><p>${escapeHTML(p.type === 'memory' ? p.content : p.description)}</p><div class="proposal-actions"><button class="text-button" data-cloud-dismiss="${p.id}">暂时不用</button><button class="button" data-cloud-proposal="${p.id}">${p.type === 'memory' ? '看看这段记忆' : '查看计划'} ${icon('arrow')}</button></div></div>`).join('');
    $('#chat-messages').append(box);
  }
  scrollChat();
};

const originalRenderMain = renderMain;
renderMain = function cloudRenderMain() {
  originalRenderMain(); updateCloudHeader();
  if (!Cloud.enabled) return;
  if (page === 'memory') {
    const note = $('.privacy-note span', $('#main'));
    if (note) note.textContent = '已确认的记忆保存在你的账号中。修改或忘记记忆时，会同步清理旧对话上下文和待确认建议，避免再次引用旧信息。';
  }
  if (page === 'growth' && Cloud.user) {
    const note = $('.weekly-note');
    const button = document.createElement('button'); button.className = 'button'; button.dataset.cloud = 'replan'; button.innerHTML = `${icon('sparkles')}让伙伴根据进度调整计划`;
    note?.prepend(button);
    state.goals.forEach(goal => goal.tasks.forEach(task => {
      const row = document.querySelector(`[data-task="${task.id}"]`)?.closest('.task-row');
      const time = row?.querySelector('.task-time'); if (time && task.dueDate) time.textContent = `${task.dueDate.slice(5)} · ${task.minutes} 分钟`;
    }));
  }
};

const originalGoal = openGoal;
actions['new-goal'] = function cloudGoal() {
  if (!Cloud.enabled) { originalGoal(); return; }
  if (!Cloud.user) { openCloudAuth(); return; }
  openModal('把愿望，变成适合你的计划。', `<p>伙伴会结合已确认的偏好和当前进度，先拟一个计划给你看。</p><form id="ai-goal-form"><label class="field">我想实现…<input name="goal" required maxlength="300" placeholder="例如：一个月后能用英语做简单的自我介绍"></label><label class="field">每天愿意留多少时间？<select name="minutes"><option>10 分钟</option><option selected>25 分钟</option><option>45 分钟</option></select></label><label class="field">还有什么需要考虑？<textarea name="constraints" maxlength="600" placeholder="例如：周末更有时间，晚上太累，希望温柔跟进。"></textarea></label><div class="modal-actions"><button type="button" class="button" data-cloud="manual-goal">手动创建一步</button><button type="submit" class="button primary">让伙伴想一想 ${icon('sparkles')}</button></div></form>`, 'A PLAN THAT FITS YOUR LIFE');
  $('#ai-goal-form').addEventListener('submit', event => {
    event.preventDefault(); const data = new FormData(event.target);
    const prompt = `请帮我制定一个可确认的成长计划。我的目标：${data.get('goal')}。每天可用时间：${data.get('minutes')}。补充条件：${data.get('constraints') || '暂无'}。请结合你已记住的偏好和当前目标，给出具体的小步骤，并说明何时回顾。`;
    closeModal(); navigate('growth'); sendMessage(prompt);
  });
};

async function showProposal(id) {
  const proposal = Cloud.proposals.find(p => p.id === id); if (!proposal) return;
  let content;
  if (proposal.type === 'memory') {
    const old = state.memories.find(m => m.key === proposal.key);
    content = `<p>从你本次明确说过的话里提炼。确认后，三款伙伴都会记得。</p><blockquote class="source-quote">${escapeHTML(proposal.quote)}</blockquote><div class="camera-permission"><h3>${escapeHTML(proposal.title)}</h3><p>${escapeHTML(proposal.content)}</p></div>${old ? `<div class="privacy-note">${icon('memory')}<span>将替换原记忆：${escapeHTML(old.content)}。更新时会清理旧对话上下文。</span></div>` : ''}`;
  } else {
    content = `<p>${escapeHTML(proposal.description)}</p><div class="plan-preview">${proposal.steps.map((step, index) => `<div><span class="plan-number">${index + 1}</span><span><strong>${escapeHTML(step.title)}</strong><small>${step.dayOffset === 0 ? '今天' : `${step.dayOffset} 天后`} · ${step.minutes} 分钟</small></span></div>`).join('')}</div><div class="privacy-note">${icon('focus')}<span>${proposal.reviewAfterDays} 天后一起回顾。${proposal.goalId ? '更新待做步骤，保留已完成的步骤。' : '确认后添加为一个新目标。'} 到期跟进可以在设置中开启。</span></div>`;
  }
  openModal(proposal.type === 'memory' ? '只记住，你愿意留下的事。' : '这份计划，适合你吗？', `${content}<div class="modal-actions"><button class="button" data-action="close-modal">再想一想</button><button class="button primary" id="accept-proposal">${proposal.type === 'memory' ? '确认记住' : '采用这份计划'} ${icon('check')}</button></div>`, 'YOU ALWAYS HAVE THE FINAL SAY');
  $('#accept-proposal').onclick = async event => {
    event.currentTarget.disabled = true;
    try {
      await Cloud.flush(); const result = await cloudRequest(`/api/proposals/${id}/accept`, 'POST', { revision: Cloud.revision });
      applyCloudSpace(result); closeModal(); render(); toast(proposal.type === 'memory' ? '这件事，已经好好记住。' : '计划已保存，我们一起慢慢开始。');
    } catch (error) { showCloudError(error); if ($('#accept-proposal')) $('#accept-proposal').disabled = false; }
  };
}

const originalSettings = openSettings;
openSettings = function cloudSettings() {
  originalSettings();
  const body = $('.modal-body');
  const account = document.createElement('div');
  account.className = 'setting-row';
  account.innerHTML = `<span><strong>${Cloud.user ? escapeHTML(Cloud.user.displayName) + '的陪伴空间' : '真实 AI 与长期记忆'}</strong><small>${Cloud.enabled ? Cloud.user ? '已登录 · 同账号跨设备保存' : '登录后开始真正的陪伴' : '连接后端空间后使用'}</small></span><button class="button" data-cloud="connect">${Cloud.user ? '账号' : '连接'}</button>`;
  body.prepend(account);
  if (!Cloud.enabled) return;
  const privacy = body.querySelector('.privacy-note span');
  if (privacy) privacy.textContent = '偏好与目标保存于本服务数据库；对话会发送给所选模型服务。“本次不记忆”不写入栖伴对话库，模型提供方仍会处理本次输入。';
  const resetRow = body.querySelector('[data-action="reset"]')?.closest('.setting-row');
  if (resetRow) {
    resetRow.querySelector('strong').textContent = '清空我的空间';
    resetRow.querySelector('small').textContent = '清除账号中的记忆、目标与对话。';
    resetRow.querySelector('button').setAttribute('aria-label', '清空我的空间');
  }
  if (Cloud.user) {
    const reminder = document.createElement('div'); reminder.className = 'setting-row';
    reminder.innerHTML = `<span><strong>到期时，轻轻跟进</strong><small>后台每天最多一条；回来时可见，尚无系统推送。</small></span><button class="toggle ${Cloud.settings.remindersEnabled ? 'on' : ''}" role="switch" aria-checked="${Cloud.settings.remindersEnabled}" aria-label="到期跟进" data-cloud="reminders"></button>`;
    account.after(reminder);
    const schedule = document.createElement('label'); schedule.className = 'field cloud-schedule';
    schedule.innerHTML = `跟进时间（${escapeHTML(Cloud.settings.timezone)}）<select id="reminder-hour">${Array.from({ length: 15 }, (_, i) => i + 8).map(hour => `<option value="${hour}" ${Cloud.settings.reminderHour === hour ? 'selected' : ''}>${String(hour).padStart(2, '0')}:00 后</option>`).join('')}</select>`;
    reminder.after(schedule);
    $('#reminder-hour').onchange = event => { Cloud.settings.reminderHour = Number(event.target.value); persist(); };
  }
};
actions['settings-theme'] = () => { state.theme = state.theme === 'dark' ? 'light' : 'dark'; render(); openSettings(); };
actions['settings-quiet'] = () => { state.quiet = !state.quiet; persist(); render(); openSettings(); };
const originalPrivate = actions['private-chat'];
actions['private-chat'] = () => { if (Cloud.enabled && replyPending) { toast('等这次回复完成后，再切换记忆模式。'); return; } originalPrivate(); };
actions['settings-private'] = () => { actions['private-chat'](); openSettings(); };
const originalExport = actions.export;
actions.export = async () => {
  if (!Cloud.enabled) { originalExport(); return; } if (!Cloud.user) { openCloudAuth(); return; }
  try {
    await Cloud.flush(); const data = await cloudRequest('/api/export');
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'qiban-my-space.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast('空间数据已导出。');
  } catch (error) { showCloudError(error); }
};
const originalReset = actions.reset;
actions.reset = () => {
  if (!Cloud.enabled) { originalReset(); return; } if (!Cloud.user) { openCloudAuth(); return; }
  openModal('重新开始这个陪伴空间？', '<p>这会清除当前账号在服务端的记忆、对话、目标、建议与跟进记录。所有设备都会看到空白空间，无法撤销。</p><div class="modal-actions"><button class="button" data-action="close-modal">保留空间</button><button class="button primary" id="cloud-reset-confirm">确认清除我的空间</button></div>', 'YOUR SPACE, YOUR CHOICE');
  $('#cloud-reset-confirm').onclick = async () => {
    try { await Cloud.flush(); Cloud.turn++; replyPending = false; applyCloudSpace(await cloudRequest('/api/space/reset', 'POST', {})); state.focus = initialState().focus; state.noMemory = false; closeModal(); render(); toast('空间已清空。我们可以重新开始。'); }
    catch (error) { showCloudError(error); }
  };
};

document.addEventListener('click', async event => {
  const target = event.target.closest('[data-cloud],[data-cloud-proposal],[data-cloud-dismiss],[data-cloud-seen]'); if (!target) return;
  try {
    if (target.dataset.cloudProposal) { await showProposal(target.dataset.cloudProposal); return; }
    if (target.dataset.cloudDismiss) { await Cloud.flush(); applyCloudSpace(await cloudRequest(`/api/proposals/${target.dataset.cloudDismiss}/dismiss`, 'POST', {}), { keepMessages: true }); renderChat(); return; }
    if (target.dataset.cloudSeen) { await cloudRequest('/api/checkins/seen', 'POST', { ids: [target.dataset.cloudSeen] }); Cloud.checkins = Cloud.checkins.filter(c => c.id !== target.dataset.cloudSeen); renderChat(); return; }
    if (target.dataset.cloud === 'connect') openCloudConnection();
    if (target.dataset.cloud === 'register') openCloudAuth(true);
    if (target.dataset.cloud === 'login') openCloudAuth();
    if (target.dataset.cloud === 'manual-goal') originalGoal();
    if (target.dataset.cloud === 'replan') sendMessage('请根据我目前的目标、已完成的步骤和你记住的偏好，帮我回顾进度。必要时提出一个可确认的调整计划。');
    if (target.dataset.cloud === 'reminders') { Cloud.settings.remindersEnabled = !Cloud.settings.remindersEnabled; persist(); openSettings(); }
    if (target.dataset.cloud === 'logout') { await Cloud.flush(); await cloudRequest('/api/logout', 'POST', {}); clearCloudSession(); closeModal(); toast('已退出，当前页面不再保留账号内容。'); }
  } catch (error) { showCloudError(error); }
});
$('#cloud-button').addEventListener('click', openCloudConnection);
window.addEventListener('beforeunload', event => {
  if (Cloud.enabled && Cloud.user && (Cloud.dirty || Cloud.savePromise)) { event.preventDefault(); event.returnValue = ''; }
});

// Prevent signed-out backend users from editing an apparent demo account.
document.addEventListener('click', event => {
  if (!Cloud.enabled) return;
  if (replyPending && event.target.closest('[data-pet],[data-task],[data-delete-goal],[data-edit-memory],[data-delete-memory],[data-action="add-memory"],[data-action="new-goal"],[data-action="quiet"],[data-action="settings-quiet"],[data-cloud-proposal],[data-cloud="reminders"],[data-cloud="manual-goal"],[data-cloud="replan"],#reminder-hour,#save-review')) {
    event.stopImmediatePropagation(); event.preventDefault(); toast('等这次回复完成后，再更新记忆、伙伴或目标。'); return;
  }
  const mood = event.target.closest('[data-mood]');
  if (mood) {
    event.stopImmediatePropagation(); event.preventDefault();
    state.mood = mood.dataset.mood; renderMain(); sendMessage(`我此刻感觉${state.mood}，想让你陪我聊聊。`); return;
  }
  if (Cloud.user) return;
  const target = event.target.closest('[data-task],[data-delete-goal],[data-edit-memory],[data-delete-memory],[data-action="add-memory"],[data-action="focus"],[data-focus-task]');
  if (target) { event.stopImmediatePropagation(); event.preventDefault(); openCloudAuth(); }
}, true);
document.addEventListener('change', event => {
  if (Cloud.enabled && replyPending && event.target.id === 'reminder-hour') {
    event.stopImmediatePropagation(); event.target.value = String(Cloud.settings.reminderHour);
    toast('等这次回复完成后，再调整跟进时间。');
  }
}, true);

(async function initializeCloud() {
  try {
    const config = await cloudRequest('/api/config'); if (!config.backend) return;
    Cloud.enabled = true; Cloud.config = config;
    state = { ...initialState(), memories: [], goals: [], messages: [] };
    const result = await cloudRequest('/api/session'); Cloud.user = result.user;
    if (Cloud.user) applyCloudSpace(await cloudRequest('/api/space'));
    render(); if (!Cloud.user) openCloudAuth();
  } catch { updateCloudHeader(); }
})();
setInterval(async () => {
  if (!Cloud.enabled || !Cloud.user || document.hidden || replyPending || Cloud.dirty || Cloud.savePromise || Cloud.conflict || $('#modal').open || ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)) return;
  const userId = Cloud.user.id;
  try { const space = await cloudRequest('/api/space'); if (Cloud.user?.id !== userId || Cloud.dirty || Cloud.savePromise || replyPending) return; applyCloudSpace(space); renderMain(); renderChat(); }
  catch (error) { if (error.status === 401) showCloudError(error); }
}, 60000);
