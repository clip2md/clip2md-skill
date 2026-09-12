#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const BASE_URL = (process.env.CLIP2MD_API_BASE || 'https://api.clip2md.cn/api/v1').replace(/\/+$/, '');
const APP_URL = (process.env.CLIP2MD_APP_URL || 'https://clip2.md').replace(/\/+$/, '');
const CONFIG_DIR = path.join(os.homedir(), '.clip2md');
const CREDENTIALS_FILE = path.join(CONFIG_DIR, 'credentials.json');
const LEGACY_CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const PENDING_CLAIM_FILE = path.join(CONFIG_DIR, 'pending-binding-claim.json');
const DEFAULT_TIMEOUT = 120;
const DEFAULT_INTERVAL = 5;
const WAITING = new Set(['PENDING', 'PROCESSING', 'WAITING_SERVICE']);
const FAILURE = new Set(['FAILED', 'FAILED_AUTH_EXPIRED', 'FAILED_SERVICE_UNAVAILABLE', 'MANUAL_REVIEW']);
let warnedInsecurePermissions = false;
let warnedCredentialExpiry = false;
let jsonOutput = false;

class ApiError extends Error {
  constructor(status, detail, retryAfter = 0, code = '', detailPayload = null) {
    super(detail || `请求失败 (${status})`);
    this.status = status;
    this.detail = detail || '';
    this.retryAfter = Number(retryAfter) || 0;
    this.code = code || '';
    this.detailPayload = detailPayload && typeof detailPayload === 'object' ? detailPayload : null;
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function ensureDirectory() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(CONFIG_DIR, 0o700); } catch (_) { /* Windows ACLs are managed by the OS. */ }
}

function writeJson(file, value) {
  ensureDirectory();
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(temporary, 0o600); } catch (_) { /* Windows ACLs are managed by the OS. */ }
  fs.renameSync(temporary, file);
  try { fs.chmodSync(file, 0o600); } catch (_) { /* Windows ACLs are managed by the OS. */ }
}

function removeFile(file) {
  try { fs.unlinkSync(file); } catch (_) { /* already absent */ }
}

function loadCredentials() {
  const value = readJson(CREDENTIALS_FILE);
  if (!warnedInsecurePermissions) {
    try {
      const mode = fs.statSync(CREDENTIALS_FILE).mode & 0o777;
      if ((mode & 0o077) !== 0) {
        console.error('警告：~/.clip2md/credentials.json 权限过宽，建议设置为 0600。');
        warnedInsecurePermissions = true;
      }
    } catch (_) { /* Missing or unreadable files are handled below. */ }
  }
  if (!value || typeof value.api_key !== 'string' || !value.api_key) return null;
  return value;
}

function warnCredentialExpiry(credentials) {
  if (warnedCredentialExpiry || !credentials?.credential_expires_at) return;
  const expiresAt = new Date(credentials.credential_expires_at).getTime();
  const remaining = expiresAt - Date.now();
  const sevenDays = 7 * 24 * 60 * 60 * 1000;
  if (Number.isFinite(remaining) && remaining > 0 && remaining <= sevenDays) {
    const days = Math.max(1, Math.ceil(remaining / (24 * 60 * 60 * 1000)));
    console.error(`⚠ Skill 凭证将在 ${days} 天后到期，请运行 clip2md connect。`);
    warnedCredentialExpiry = true;
  }
}

function loadLegacyToken() {
  const value = readJson(LEGACY_CONFIG_FILE);
  return value && typeof value.token === 'string' && value.token ? value.token : null;
}

function requireCredential() {
  const credentials = loadCredentials();
  if (!credentials) throw new Error('未连接 Clip2MD AI 助手。请先运行: clip2md connect');
  warnCredentialExpiry(credentials);
  return credentials;
}

function detailText(detail) {
  if (typeof detail === 'string') return detail;
  if (detail && typeof detail === 'object') return detail.message || detail.msg || JSON.stringify(detail);
  return '';
}

function formatError(error) {
  if (!(error instanceof ApiError)) return error.message || String(error);
  if (error.status === 401 && error.code === 'credential_expired') return 'Skill 凭证已过期，请重新运行: clip2md connect';
  if (error.status === 401) return 'Skill 凭证无效或已撤销，请重新运行: clip2md connect';
  if (error.code === 'skill_pro_yearly_required') {
    const upgradePath = error.detailPayload?.upgrade_url;
    const upgradeUrl = upgradePath && /^https?:\/\//i.test(upgradePath)
      ? upgradePath
      : upgradePath ? `${APP_URL}${upgradePath.startsWith('/') ? '' : '/'}${upgradePath}` : `${APP_URL}/app/membership/plans?plan_code=pro_yearly`;
    return `${error.detail} 开通地址：${upgradeUrl}`.trim();
  }
  if (error.status === 403) return `额度或权限不足。${error.detail}`.trim();
  if (error.status === 409) return `任务冲突。${error.detail}`.trim();
  if (error.status === 429 && error.code === 'pending_queue_limit') return '当前任务队列已满，请稍后重试。';
  if (error.status === 429 && error.code === 'manual_retry_limit') return '该任务的手动重试次数已达上限。';
  if (error.status === 429) return `请求过于频繁或自动调用额度已达上限。${error.detail}`.trim();
  if (error.status === 503) return `Clip2MD 暂时不可用。${error.detail}`.trim();
  return `请求失败 (${error.status})：${error.detail || '未知错误'}`;
}

function statusKind(status) {
  const normalized = String(status || '').toUpperCase();
  if (normalized === 'SUCCESS') return 'success';
  if (FAILURE.has(normalized)) return 'failed';
  if (WAITING.has(normalized)) return 'pending';
  return 'unknown';
}

function taskPayload(task) {
  return { ...task, status_kind: statusKind(task.status) };
}

function printJson(value) {
  console.log(JSON.stringify(value));
}

async function request(method, endpoint, { auth = 'skill', body = null } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== null) headers['Content-Type'] = 'application/json';
  if (auth === 'skill') headers['X-Skill-Key'] = requireCredential().api_key;
  if (auth === 'legacy') headers.Authorization = `Bearer ${loadLegacyToken()}`;
  const response = await fetch(`${BASE_URL}${endpoint}`, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const rawDetail = data.detail || data.message;
    const bodyCode = typeof rawDetail === 'string' ? rawDetail : rawDetail?.code;
    throw new ApiError(
      response.status,
      detailText(rawDetail),
      response.headers.get('retry-after'),
      response.headers.get('x-error-code') || bodyCode || '',
      typeof rawDetail === 'object' ? rawDetail : null,
    );
  }
  return data;
}

function printTask(task) {
  console.log(`任务 ID: ${task.id}`);
  console.log(`状态: ${task.status}`);
  if (task.title || task.source_title) console.log(`标题: ${task.title || task.source_title}`);
  if (task.error_msg) console.log(`错误: ${task.error_msg}`);
  console.log(`Markdown: ${(task.note_markdown_content || task.source_markdown_content) ? '已生成' : '未生成'}`);
}

function ensureUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
    return value;
  } catch (_) { throw new Error('URL 必须是有效的 HTTP(S) 地址'); }
}

function parseWaitArgs(args) {
  const options = { timeout: DEFAULT_TIMEOUT, interval: DEFAULT_INTERVAL };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--timeout') options.timeout = Number.parseInt(args[++i], 10);
    else if (args[i] === '--interval') options.interval = Number.parseInt(args[++i], 10);
    else throw new Error(`未知参数: ${args[i]}`);
  }
  if (!Number.isFinite(options.timeout) || options.timeout <= 0 || !Number.isFinite(options.interval) || options.interval <= 0) throw new Error('等待参数必须是正整数');
  return options;
}

function parseResultArgs(args) {
  let kind = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--kind') {
      kind = args[++i] || null;
    } else {
      throw new Error(`未知参数: ${args[i]}`);
    }
  }
  if (kind !== null && !['note', 'source', 'both'].includes(kind)) throw new Error('--kind 只能是 note、source 或 both');
  return kind;
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function readAuthorizationCodeFromStdin() {
  if (process.stdin.isTTY) {
    throw new Error('请将网页生成的授权码通过标准输入传入，例如让助手直接调用 connect --authorization-code-stdin');
  }
  return new Promise((resolve, reject) => {
    let value = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      value += chunk;
      if (value.length > 256) reject(new Error('授权码输入过长'));
    });
    process.stdin.on('error', reject);
    process.stdin.on('end', () => {
      const code = value.trim();
      if (!code) reject(new Error('未从标准输入读取授权码'));
      else resolve(code);
    });
  });
}

function claimIdForCode(authorizationCode) {
  const codeHash = crypto.createHash('sha256').update(authorizationCode).digest('hex');
  const current = readJson(PENDING_CLAIM_FILE);
  if (current && current.code_hash === codeHash && typeof current.claim_id === 'string' && current.claim_id) {
    return current.claim_id;
  }
  const claimId = crypto.randomBytes(24).toString('hex');
  writeJson(PENDING_CLAIM_FILE, { code_hash: codeHash, claim_id: claimId, created_at: new Date().toISOString() });
  return claimId;
}

async function readSkillProfile() {
  return request('GET', '/skill/me');
}

async function resolveMarkdownKind(explicitKind) {
  if (explicitKind) return explicitKind;
  try {
    const profile = await readSkillProfile();
    const configured = profile.preferences?.markdown_content;
    return ['note', 'source', 'both'].includes(configured) ? configured : 'note';
  } catch (error) {
    console.error(`⚠ 偏好读取失败，使用默认 Markdown 内容：${formatError(error)}`);
    return 'note';
  }
}

async function ackWithRetry(deviceCode) {
  const delays = [0, 5000, 10000, 20000];
  let lastError = null;
  for (const delay of delays) {
    if (delay) await sleep(delay);
    try { return await request('POST', '/skill/device/ack', { body: { device_code: deviceCode } }); }
    catch (error) {
      lastError = error;
      if (error instanceof ApiError && [400, 401, 403, 410].includes(error.status)) break;
    }
  }
  throw lastError || new Error('授权确认失败');
}

async function resumeAck() {
  const credentials = loadCredentials();
  if (!credentials || !credentials.pending_device_code) return false;
  try {
    const ack = await ackWithRetry(credentials.pending_device_code);
    credentials.credential_expires_at = ack.credential_expires_at || credentials.credential_expires_at || null;
    delete credentials.pending_device_code;
    writeJson(CREDENTIALS_FILE, credentials);
    return true;
  } catch (error) {
    if (error instanceof ApiError && [401, 410].includes(error.status)) throw error;
    throw new Error(`凭证已保存，但授权确认尚未完成：${formatError(error)}`);
  }
}

async function completeDeviceConnection(started, { invitation = false } = {}) {
  if (!invitation) {
    console.log(`请在 Web 或小程序确认绑定码: ${started.user_code}`);
    console.log(`授权页面: ${started.verification_uri_complete}`);
    console.log('等待用户确认…');
  } else {
    console.log('授权语句已领取，正在连接 Clip2MD…');
  }
  let interval = Number(started.interval) || DEFAULT_INTERVAL;
  const deadline = Date.now() + Number(started.expires_in || 600) * 1000;
  while (Date.now() < deadline) {
    let result;
    try { result = await request('POST', '/skill/device/poll', { auth: 'none', body: { device_code: started.device_code } }); }
    catch (error) {
      if (error instanceof ApiError && error.code === 'slow_down') { interval = Math.min(60, interval + 5); await sleep(interval * 1000); continue; }
      throw error;
    }
    if (result.status === 'pending') { await sleep(interval * 1000); continue; }
    if (result.status === 'denied' || result.status === 'expired' || result.status === 'revoked') throw new Error(`授权${result.status === 'denied' ? '被拒绝' : '已失效'}`);
    if (result.status === 'ack_grace') throw new Error('凭证领取窗口已结束，请重新运行 connect');
    if (result.status !== 'awaiting_ack' || !result.api_key) { await sleep(interval * 1000); continue; }
    writeJson(CREDENTIALS_FILE, { api_key: result.api_key, key_prefix: result.api_key.split('_')[2] || '', pending_device_code: started.device_code, connected_at: new Date().toISOString(), credential_expires_at: result.credential_expires_at || null });
    try {
      const ack = await ackWithRetry(started.device_code);
      const credentials = loadCredentials();
      credentials.credential_expires_at = ack.credential_expires_at || credentials.credential_expires_at || null;
      delete credentials.pending_device_code;
      writeJson(CREDENTIALS_FILE, credentials);
      const legacy = readJson(LEGACY_CONFIG_FILE);
      if (legacy && legacy.token) writeJson(LEGACY_CONFIG_FILE, { ...legacy, migrated_at: new Date().toISOString(), token: undefined });
      if (invitation) removeFile(PENDING_CLAIM_FILE);
      console.log('Clip2MD Skill 已连接，凭证已安全保存。');
      return;
    } catch (error) {
      throw new Error(`凭证已保存，但授权确认失败：${formatError(error)}`);
    }
  }
  throw new Error('授权等待超时，请重新运行 connect');
}

async function cmdConnect(args) {
  const connectArgs = args.filter(arg => arg !== '--authorization-code-stdin');
  const nameIndex = connectArgs.indexOf('--name');
  const name = nameIndex >= 0 ? connectArgs[nameIndex + 1] : undefined;
  if (nameIndex >= 0 && !name) throw new Error('--name 需要设备名称');
  const invitationMode = args.includes('--authorization-code-stdin');
  const unknown = connectArgs.filter((arg, index) => nameIndex < 0 || (index !== nameIndex && index !== nameIndex + 1));
  if (unknown.length) throw new Error(`未知参数: ${unknown[0]}`);
  if (invitationMode) {
    const authorizationCode = await readAuthorizationCodeFromStdin();
    const claimId = claimIdForCode(authorizationCode);
    const claimed = await request('POST', '/skill/binding-invitations/claim', {
      auth: 'none',
      body: { authorization_code: authorizationCode, claim_id: claimId, ...(name ? { client_name: name } : {}) },
    });
    return completeDeviceConnection(claimed, { invitation: true });
  }
  const started = await request('POST', '/skill/device/start', { auth: 'none', body: name ? { client_name: name } : {} });
  return completeDeviceConnection(started);
}

async function cmdDisconnect() {
  await resumeAck();
  await request('DELETE', '/skill/connection');
  try { fs.unlinkSync(CREDENTIALS_FILE); } catch (_) { /* already disconnected */ }
  removeFile(PENDING_CLAIM_FILE);
  console.log('Clip2MD Skill 已断开。');
}

async function cmdConfig(args) {
  if (args[0] === 'show') {
    const credentials = loadCredentials();
    if (credentials) {
      const me = await readSkillProfile();
      const payload = {
        connected: true,
        status: me.device?.status || 'active',
        device: me.device || null,
        credential_expires_at: me.credential_expires_at || credentials.credential_expires_at || null,
        usage: me.usage || null,
        preferences: me.preferences || null,
        eligibility: me.eligibility || null,
      };
      if (jsonOutput) printJson(payload);
      else {
        console.log(`连接状态: ${payload.status}`);
        console.log(`设备: ${payload.device?.name || 'AI 助手'}`);
        console.log(`凭证到期: ${payload.credential_expires_at || '—'}`);
        if (payload.eligibility && !payload.eligibility.eligible) console.log(`Skill 资格: ${formatError(new ApiError(403, payload.eligibility.message, 0, 'skill_pro_yearly_required', payload.eligibility))}`);
        if (payload.usage) console.log(`自动剪藏: 今日 ${payload.usage.daily}/${payload.usage.daily_limit}，本月 ${payload.usage.monthly}/${payload.usage.monthly_limit}`);
      }
      return;
    }
    if (loadLegacyToken()) {
      if (jsonOutput) printJson({ connected: false, status: 'legacy', deprecated: true });
      else console.log('连接状态: 旧 token（已弃用）');
      return;
    }
    if (jsonOutput) printJson({ connected: false, status: 'disconnected', deprecated: false });
    else console.log('连接状态: 未连接');
    return;
  }
  const token = args[0];
  if (!token) throw new Error('用法: clip2md config show 或 clip2md config <legacy_token>');
  writeJson(LEGACY_CONFIG_FILE, { token });
  console.error('警告：旧 token 配置已弃用，请运行 clip2md connect 完成迁移。');
  if (jsonOutput) printJson({ configured: true, authentication: 'legacy_token', deprecated: true });
}

async function withLegacyFallback(skillAction, legacyAction) {
  if (loadCredentials()) {
    await resumeAck();
    return skillAction();
  }
  const token = loadLegacyToken();
  if (!token) throw new Error('未配置认证。请运行 clip2md connect');
  console.error('警告：当前使用已弃用的旧 token，请运行 clip2md connect 完成迁移。');
  await request('GET', '/skill/eligibility', { auth: 'legacy' });
  return legacyAction();
}

async function cmdQuota() {
  return withLegacyFallback(() => request('GET', '/skill/quota').then(data => {
    if (jsonOutput) {
      printJson(data);
      return;
    }
    console.log(`每日额度: ${data.daily_quota} 次`);
    console.log(`永久额度: ${data.permanent_quota} 次`);
    if (data.skill_usage) console.log(`自动剪藏: 今日 ${data.skill_usage.daily}/${data.skill_usage.daily_limit}，本月 ${data.skill_usage.monthly}/${data.skill_usage.monthly_limit}`);
  }), () => request('GET', '/auth/me', { auth: 'legacy' }).then(data => {
    if (jsonOutput) {
      printJson(data);
      return;
    }
    console.log(`每日额度: ${data.daily_quota} 次`);
    console.log(`永久额度: ${data.permanent_quota} 次`);
  }));
}

async function fetchTask(id) {
  return withLegacyFallback(() => request('GET', `/skill/tasks/${encodeURIComponent(id)}`), () => request('GET', `/tasks/${encodeURIComponent(id)}`, { auth: 'legacy' }));
}

function applyTaskExitCode(task) {
  const kind = statusKind(task.status);
  if (kind === 'failed') process.exitCode = 2;
  else if (kind === 'unknown') process.exitCode = 4;
  return kind;
}

async function waitForTask(id, options, onPending) {
  const deadline = Date.now() + options.timeout * 1000;
  let task = null;
  while (Date.now() <= deadline) {
    task = await fetchTask(id);
    const kind = statusKind(task.status);
    if (kind === 'success' || kind === 'failed' || kind === 'unknown') return { task, timedOut: false };
    if (onPending) onPending(task);
    await sleep(options.interval * 1000);
  }
  return { task, timedOut: true };
}

async function cmdClip(url) {
  ensureUrl(url);
  return withLegacyFallback(async () => {
    const task = await request('POST', '/skill/tasks', { body: { url } });
    let autoWait = false;
    let waitOptions = { timeout: DEFAULT_TIMEOUT, interval: DEFAULT_INTERVAL };
    try {
      const profile = await readSkillProfile();
      autoWait = profile.preferences?.auto_wait === true;
      const timeout = Number(profile.preferences?.wait_timeout_seconds);
      if (Number.isFinite(timeout) && timeout > 0) waitOptions.timeout = timeout;
    } catch (error) {
      console.error(`⚠ 偏好读取失败，使用默认值继续：${formatError(error)}`);
    }
    if (!autoWait) {
      if (jsonOutput) printJson({ ...taskPayload(task), auto_wait: false });
      else console.log(`任务已提交 (ID: ${task.id}, 状态: ${task.status})`);
      applyTaskExitCode(task);
      return;
    }

    const outcome = await waitForTask(String(task.id), waitOptions, pending => {
      if (!jsonOutput) console.log(`等待中: 任务 ${pending.id} 状态 ${pending.status}`);
    });
    if (jsonOutput) {
      printJson({
        ...taskPayload(outcome.task || task),
        auto_wait: true,
        timed_out: outcome.timedOut,
      });
    } else {
      console.log(`任务已提交 (ID: ${task.id}, 状态: ${task.status})`);
      if (outcome.timedOut) {
        console.error(`等待超时：请运行 clip2md wait ${task.id}`);
        if (outcome.task) printTask(outcome.task);
      } else if (outcome.task) {
        printTask(outcome.task);
      }
    }
    if (outcome.timedOut) process.exitCode = 3;
    else if (outcome.task) applyTaskExitCode(outcome.task);
  }, async () => {
    const task = await request('POST', '/tasks', { auth: 'legacy', body: { url } });
    if (jsonOutput) printJson({ ...taskPayload(task), auto_wait: false });
    else console.log(`任务已提交 (ID: ${task.id}, 状态: ${task.status})`);
    applyTaskExitCode(task);
  });
}

async function cmdStatus(id) {
  if (!id) throw new Error('用法: clip2md status <task_id>');
  const task = await fetchTask(id);
  if (jsonOutput) printJson(taskPayload(task));
  else printTask(task);
  applyTaskExitCode(task);
}

async function cmdWait(id, args) {
  if (!id) throw new Error('用法: clip2md wait <task_id> [--timeout 120] [--interval 5]');
  const options = parseWaitArgs(args);
  const outcome = await waitForTask(id, options, task => {
    if (!jsonOutput) console.log(`等待中: 任务 ${task.id} 状态 ${task.status}`);
  });
  if (jsonOutput) {
    const payload = outcome.task ? taskPayload(outcome.task) : { id, status_kind: 'unknown' };
    printJson({
      ...payload,
      timed_out: outcome.timedOut,
      ...(outcome.timedOut ? { wait_command: `clip2md wait ${id}` } : {}),
    });
  } else if (outcome.timedOut) {
    console.error(`等待超时：请运行 clip2md wait ${id}`);
    if (outcome.task) printTask(outcome.task);
  } else if (outcome.task) {
    printTask(outcome.task);
  }
  if (outcome.timedOut) process.exitCode = 3;
  else if (outcome.task) applyTaskExitCode(outcome.task);
}

async function cmdResult(id, args) {
  if (!id) throw new Error('用法: clip2md result <task_id> [--kind note|source|both]');
  const explicitKind = parseResultArgs(args);
  return withLegacyFallback(
    async () => {
      const kind = await resolveMarkdownKind(explicitKind);
      const result = await request('GET', `/skill/tasks/${encodeURIComponent(id)}/markdown?kind=${kind}`);
      if (jsonOutput) {
        printJson({ ...result, kind });
        return;
      }
      if (result.note_markdown) console.log(result.note_markdown);
      if (result.source_markdown && kind === 'both') console.log(`\n--- 原文 ---\n${result.source_markdown}`);
    },
    async () => {
      const kind = explicitKind || 'note';
      const task = await request('GET', `/tasks/${encodeURIComponent(id)}`, { auth: 'legacy' });
      if (task.status !== 'SUCCESS') throw new Error(`任务尚未成功，当前状态: ${task.status}`);
      if (jsonOutput) {
        printJson({
          task_id: task.id,
          kind,
          note_markdown: kind === 'note' || kind === 'both' ? task.note_markdown_content || null : null,
          source_markdown: kind === 'source' || kind === 'both' ? task.source_markdown_content || null : null,
        });
        return;
      }
      if (kind === 'note' || kind === 'both') {
        if (task.note_markdown_content) console.log(task.note_markdown_content);
      }
      if (kind === 'source' || kind === 'both') {
        if (kind === 'both') console.log('\\n--- 原文 ---');
        if (task.source_markdown_content) console.log(task.source_markdown_content);
      }
    },
  );
}

function help() {
  console.log('clip2md connect [--name name] [--authorization-code-stdin] | disconnect | config show | quota [--json] | clip <url> [--json] | status <id> [--json] | wait <id> [--timeout seconds] [--json] | result <id> [--kind note|source|both] [--json]');
}

function stripJsonFlag(args) {
  const json = args.includes('--json');
  return { json, args: args.filter(arg => arg !== '--json') };
}

async function main() {
  const parsed = stripJsonFlag(process.argv.slice(2));
  jsonOutput = parsed.json;
  const args = parsed.args;
  const command = args.shift();
  if (command === 'connect') return cmdConnect(args);
  if (command === 'disconnect') return cmdDisconnect();
  if (command === 'config') return cmdConfig(args);
  if (command === 'quota') return cmdQuota();
  if (command === 'clip') return cmdClip(args[0]);
  if (command === 'status') return cmdStatus(args[0]);
  if (command === 'wait') return cmdWait(args[0], args.slice(1));
  if (command === 'result') return cmdResult(args[0], args.slice(1));
  help();
  process.exitCode = 1;
}

main().catch(error => {
  if (jsonOutput) {
    const payload = { error: { message: formatError(error) } };
    if (error instanceof ApiError) {
      payload.error.status = error.status;
      if (error.code) payload.error.code = error.code;
      if (error.retryAfter) payload.error.retry_after = error.retryAfter;
      if (error.detailPayload) {
        for (const key of ['reason', 'required_plan', 'upgrade_url', 'miniapp_upgrade_path', 'retryable', 'current_plan', 'membership_expires_at']) {
          if (Object.prototype.hasOwnProperty.call(error.detailPayload, key)) payload.error[key] = error.detailPayload[key];
        }
      }
    }
    printJson(payload);
  } else {
    console.error(formatError(error));
  }
  process.exitCode = 1;
});
