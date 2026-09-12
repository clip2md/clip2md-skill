const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { test } = require('node:test');

const CLI = path.resolve(__dirname, '../scripts/clip2md.js');

function respond(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function createHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clip2md-skill-test-'));
}

function writeCredentials(home, expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()) {
  const credentialsDir = path.join(home, '.clip2md');
  const credentialsFile = path.join(credentialsDir, 'credentials.json');
  fs.mkdirSync(credentialsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(credentialsFile, `${JSON.stringify({ api_key: 'skill-test-secret', credential_expires_at: expiresAt })}\n`, { mode: 0o600 });
  fs.chmodSync(credentialsFile, 0o600);
}

function writeLegacyToken(home) {
  const configDir = path.join(home, '.clip2md');
  const configFile = path.join(configDir, 'config.json');
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(configFile, `${JSON.stringify({ token: 'legacy-test-token' })}\n`, { mode: 0o600 });
  fs.chmodSync(configFile, 0o600);
}

function handleRequest(req, res, requestState = {}) {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.headers.authorization) requestState.authorization = req.headers.authorization;
    if (url.pathname === '/api/v1/skill/eligibility') {
      if (requestState.ineligible) {
        respond(res, 403, { detail: {
          code: 'skill_pro_yearly_required',
          reason: 'pro_monthly',
          required_plan: 'pro_yearly',
          message: '您当前为 Pro 月卡会员，AI 助手 Skill 仅限 Pro 年卡会员使用，请升级至 Pro 年卡。',
          upgrade_url: '/app/membership/plans?plan_code=pro_yearly',
          miniapp_upgrade_path: '/pages/membership/membership?plan_code=pro_yearly',
          retryable: false,
        } });
        return;
      }
      respond(res, 200, {
        eligible: true,
        reason: 'pro_yearly_active',
        required_plan: 'pro_yearly',
        message: 'Pro 年卡会员权益有效，AI 助手 Skill 可以使用。',
        upgrade_url: '/app/membership/plans?plan_code=pro_yearly',
        miniapp_upgrade_path: '/pages/membership/membership?plan_code=pro_yearly',
        retryable: false,
      });
      return;
    }
    if (url.pathname === '/api/v1/skill/binding-invitations/claim' && req.method === 'POST') {
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        requestState.claimBody = JSON.parse(raw);
        respond(res, 200, { device_code: 'invitation-device-code', status: 'claimed', expires_in: 600, interval: 5 });
      });
      return;
    }
    if (url.pathname === '/api/v1/skill/device/poll' && req.method === 'POST') {
      respond(res, 200, {
        status: 'awaiting_ack',
        api_key: 'clip2md_skill_invitation_secret',
        credential_expires_at: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
      });
      return;
    }
    if (url.pathname === '/api/v1/skill/device/ack' && req.method === 'POST') {
      respond(res, 200, {
        status: 'active',
        credential_expires_at: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
      });
      return;
    }
    if (url.pathname === '/api/v1/skill/quota') {
      respond(res, 200, { daily_quota: 4, daily_quota_limit: 20, permanent_quota: 2, skill_usage: { daily: 1, daily_limit: 20, monthly: 3, monthly_limit: 300 } });
      return;
    }
    if (url.pathname === '/api/v1/skill/tasks' && req.method === 'POST') {
      if (requestState.ineligible) {
        respond(res, 403, { detail: {
          code: 'skill_pro_yearly_required',
          reason: 'pro_monthly',
          required_plan: 'pro_yearly',
          message: '您当前为 Pro 月卡会员，AI 助手 Skill 仅限 Pro 年卡会员使用，请升级至 Pro 年卡。',
          upgrade_url: '/app/membership/plans?plan_code=pro_yearly',
          miniapp_upgrade_path: '/pages/membership/membership?plan_code=pro_yearly',
          retryable: false,
        } });
        return;
      }
      requestState.taskRequests = (requestState.taskRequests || 0) + 1;
      respond(res, 200, { id: 7, status: 'PENDING', title: '待处理页面' });
      return;
    }
    if (url.pathname === '/api/v1/skill/me') {
      respond(res, 200, {
        api_version: 'v1',
        device: { id: 1, name: '测试助手', status: 'active', key_prefix: 'test' },
        credential_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        preferences: { auto_wait: false, wait_timeout_seconds: 120, markdown_content: 'source' },
        usage: { daily: 1, daily_limit: 20, monthly: 3, monthly_limit: 300 },
        eligibility: {
          eligible: true,
          reason: 'pro_yearly_active',
          required_plan: 'pro_yearly',
          message: 'Pro 年卡会员权益有效，AI 助手 Skill 可以使用。',
          upgrade_url: '/app/membership/plans?plan_code=pro_yearly',
          miniapp_upgrade_path: '/pages/membership/membership?plan_code=pro_yearly',
          retryable: false,
        },
      });
      return;
    }
    if (url.pathname === '/api/v1/skill/tasks/7/markdown') {
      respond(res, 200, { task_id: 7, kind: url.searchParams.get('kind'), note_markdown: null, source_markdown: '# 原文' });
      return;
    }
    if (url.pathname === '/api/v1/skill/tasks/7') {
      respond(res, 200, { id: 7, status: 'PAUSED_BY_POLICY', title: '未知状态' });
      return;
    }
    if (url.pathname === '/api/v1/skill/tasks/8') {
      respond(res, 200, { id: 8, status: 'SUCCESS', title: '已完成', note_markdown_content: '# 完成' });
      return;
    }
    if (url.pathname === '/api/v1/skill/tasks/9') {
      respond(res, 200, { id: 9, status: 'FAILED_SERVICE_UNAVAILABLE', title: '处理失败', error_msg: '服务暂时不可用' });
      return;
    }
    if (url.pathname === '/api/v1/tasks' && req.method === 'POST') {
      respond(res, 200, { id: 10, status: 'PENDING', title: '旧 token 任务' });
      return;
    }
    if (url.pathname === '/api/v1/tasks/10' && req.method === 'GET') {
      respond(res, 200, {
        id: 10,
        status: 'SUCCESS',
        title: '旧 token 结果',
        note_markdown_content: '# 旧 token 笔记',
        source_markdown_content: '# 旧 token 原文',
      });
      return;
    }
    respond(res, 404, { detail: 'not found' });
}

async function runCli(command, args, home, requestState = {}, stdin = null) {
  const testServer = http.createServer((req, res) => handleRequest(req, res, requestState));
  await new Promise(resolve => testServer.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${testServer.address().port}/api/v1`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, command, ...args], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, HOME: home, USERPROFILE: home, CLIP2MD_API_BASE: baseUrl },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    if (stdin !== null) child.stdin.end(stdin);
    const finish = (result, error) => {
      clearTimeout(timer);
      testServer.close(() => error ? reject(error) : resolve(result));
    };
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.on('error', error => finish(null, error));
    child.on('close', code => finish({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

test('connect --authorization-code-stdin claims without exposing the authorization code', async () => {
  const home = createHome();
  const requestState = {};
  try {
    const result = await runCli('connect', ['--authorization-code-stdin'], home, requestState, 'one-time-test-code\n');
    assert.equal(result.code, 0);
    assert.equal(requestState.claimBody.authorization_code, 'one-time-test-code');
    assert.equal(typeof requestState.claimBody.claim_id, 'string');
    assert.equal(result.stdout.includes('one-time-test-code'), false);
    assert.equal(result.stderr.includes('one-time-test-code'), false);
    const credentials = JSON.parse(fs.readFileSync(path.join(home, '.clip2md', 'credentials.json'), 'utf8'));
    assert.equal(credentials.api_key, 'clip2md_skill_invitation_secret');
    assert.equal(fs.statSync(path.join(home, '.clip2md', 'credentials.json')).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(path.join(home, '.clip2md', 'pending-binding-claim.json')), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('quota --json emits one structured response without credentials', async () => {
  const home = createHome();
  try {
    writeCredentials(home);
    const result = await runCli('quota', ['--json'], home);
    assert.equal(result.code, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.daily_quota, 4);
    assert.equal(result.stdout.includes('skill-test-secret'), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('clip --json returns status_kind and reads the cloud preference profile', async () => {
  const home = createHome();
  try {
    writeCredentials(home);
    const result = await runCli('clip', ['https://example.com/article', '--json'], home);
    assert.equal(result.code, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.id, 7);
    assert.equal(payload.status_kind, 'pending');
    assert.equal(payload.auto_wait, false);
    assert.equal(result.stdout.includes('任务已提交'), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('status --json reports unknown task states with exit code 4', async () => {
  const home = createHome();
  try {
    writeCredentials(home);
    const result = await runCli('status', ['7', '--json'], home);
    assert.equal(result.code, 4);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status_kind, 'unknown');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('status --json reports FAILED_* task states with exit code 2', async () => {
  const home = createHome();
  try {
    writeCredentials(home);
    const result = await runCli('status', ['9', '--json'], home);
    assert.equal(result.code, 2);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status_kind, 'failed');
    assert.equal(payload.status, 'FAILED_SERVICE_UNAVAILABLE');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('wait --json returns the terminal task and suppresses progress text', async () => {
  const home = createHome();
  try {
    writeCredentials(home);
    const result = await runCli('wait', ['8', '--timeout', '1', '--interval', '1', '--json'], home);
    assert.equal(result.code, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status_kind, 'success');
    assert.equal(payload.timed_out, false);
    assert.equal(result.stdout.includes('等待中'), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('result reads markdown_content when kind is omitted', async () => {
  const home = createHome();
  try {
    writeCredentials(home);
    const result = await runCli('result', ['7', '--json'], home);
    assert.equal(result.code, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.kind, 'source');
    assert.equal(payload.source_markdown, '# 原文');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('config show --json returns a stable safe connection shape', async () => {
  const home = createHome();
  try {
    writeCredentials(home);
    const result = await runCli('config', ['show', '--json'], home);
    assert.equal(result.code, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.connected, true);
    assert.equal(payload.status, 'active');
    assert.equal(payload.device.name, '测试助手');
    assert.equal(payload.preferences.markdown_content, 'source');
    assert.equal(Object.prototype.hasOwnProperty.call(payload, 'api_key'), false);
    assert.equal(result.stdout.includes('skill-test-secret'), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('legacy token fallback works for cmdClip and cmdResult', async () => {
  const home = createHome();
  const requestState = {};
  try {
    writeLegacyToken(home);
    const clip = await runCli('clip', ['https://example.com/legacy', '--json'], home, requestState);
    assert.equal(clip.code, 0);
    assert.equal(JSON.parse(clip.stdout).id, 10);
    assert.equal(JSON.parse(clip.stdout).status_kind, 'pending');
    assert.match(clip.stderr, /旧 token/);
    assert.equal(requestState.authorization, 'Bearer legacy-test-token');

    const result = await runCli('result', ['10', '--json'], home, requestState);
    assert.equal(result.code, 0);
    const resultPayload = JSON.parse(result.stdout);
    assert.equal(resultPayload.kind, 'note');
    assert.equal(resultPayload.note_markdown, '# 旧 token 笔记');
    assert.match(result.stderr, /旧 token/);
    assert.equal(requestState.authorization, 'Bearer legacy-test-token');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('ineligible Skill credentials return a structured upgrade error without creating a task', async () => {
  const home = createHome();
  const requestState = { ineligible: true };
  try {
    writeCredentials(home);
    const result = await runCli('clip', ['https://example.com/ineligible', '--json'], home, requestState);
    assert.equal(result.code, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.error.code, 'skill_pro_yearly_required');
    assert.equal(payload.error.required_plan, 'pro_yearly');
    assert.match(payload.error.message, /Pro 月卡/);
    assert.equal(requestState.taskRequests || 0, 0);
    assert.match(result.stdout, /https:\/\/clip2\.md\/app\/membership\/plans\?plan_code=pro_yearly/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('commands warn when the local credential expires within seven days', async () => {
  const home = createHome();
  try {
    writeCredentials(home, new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString());
    const result = await runCli('quota', ['--json'], home);
    assert.equal(result.code, 0);
    assert.match(result.stderr, /Skill 凭证将在 \d+ 天后到期/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
