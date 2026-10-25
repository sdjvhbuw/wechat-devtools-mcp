#!/usr/bin/env node
/**
 * CLI and recovery integration suite.
 *
 * This suite quits and restarts the IDE. Provide a real mini program project
 * through `WECHAT_DEVTOOLS_TEST_USER_PROJECT` (or argv[4]) to exercise
 * open/preview/build/quit/recovery; otherwise those cases are marked SKIP.
 *
 * Usage:
 *   WECHAT_DEVTOOLS_TEST_USER_PROJECT=C:/path/to/app node scripts/cli-e2e.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const fixture = path.resolve(path.join(process.cwd(), 'test-fixtures', 'miniprogram'));
const userProjectInput =
  process.env.WECHAT_DEVTOOLS_TEST_USER_PROJECT || process.argv[4] || '';
const userProject = userProjectInput ? path.resolve(userProjectInput) : '';
const hasUserProject = Boolean(
  userProject && fs.existsSync(path.join(userProject, 'project.config.json'))
);
const skipUser = !hasUserProject;
const skipReason =
  '未设置 WECHAT_DEVTOOLS_TEST_USER_PROJECT（需要真实 AppID 的小程序项目）';

const env = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => typeof value === 'string')
);
env.WECHAT_DEVTOOLS_PROJECT = fixture;
env.WECHAT_DEVTOOLS_AUTOMATION_PORT = '9421';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(process.cwd(), 'src', 'server.js')],
  cwd: process.cwd(),
  env,
  stderr: 'pipe',
});

const client = new Client({ name: 'wechat-devtools-cli-e2e', version: '0.1.0' });
const results = [];

const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text || '';
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  if (result.isError) {
    const error = new Error(text);
    error.toolResult = parsed;
    throw error;
  }
  return parsed;
};

async function test(name, fn, options = {}) {
  if (options.skip) {
    results.push({
      name,
      ok: true,
      skipped: true,
      detail: options.skipReason || 'SKIP',
    });
    return null;
  }
  const expectError = Boolean(options.expectError);
  try {
    const value = await fn();
    if (expectError) {
      results.push({ name, ok: false, detail: '预期失败但成功了' });
      return null;
    }
    if (options.check && !options.check(value)) {
      results.push({
        name,
        ok: false,
        detail: `断言失败: ${JSON.stringify(value).slice(0, 600)}`,
      });
      return value;
    }
    results.push({ name, ok: true });
    return value;
  } catch (error) {
    if (expectError) {
      results.push({
        name,
        ok: true,
        detail: `按预期失败: ${error.message.slice(0, 160)}`,
      });
      return null;
    }
    results.push({ name, ok: false, detail: error.message.slice(0, 800) });
    return null;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  await client.connect(transport);

  await test('is_login', () => call('wdt_is_login'), {
    check: (v) => typeof v.login === 'boolean',
  });

  await test(
    'open: touristappid 项目应返回 AppID 提示',
    () => call('wdt_open', { projectPath: fixture }),
    {
      check: (v) => v.ok === false && /AppID/.test(v.hint || ''),
    }
  );

  await test('open: 用户项目', () => call('wdt_open', { projectPath: userProject }), {
    check: (v) => v.ok === true,
    skip: skipUser,
    skipReason,
  });

  await test(
    'open 后 IDE 端口在线',
    async () => {
      await sleep(3000);
      return await call('wdt_status');
    },
    { check: (v) => v.ide?.portOpen === true, skip: skipUser, skipReason }
  );

  await test(
    'close_project: 测试项目',
    () => call('wdt_close_project', { projectPath: fixture }),
    {
      check: (v) => v.ok === true,
    }
  );

  await test(
    'build_npm: 用户项目失败可读',
    () => call('wdt_build_npm', { projectPath: userProject }),
    {
      check: (v) => v.ok === false && typeof v.hint === 'string' && v.hint.length > 0,
      skip: skipUser,
      skipReason,
    }
  );

  const qrPath = path.join(process.cwd(), 'output', 'preview-cli.png');
  const infoPath = path.join(process.cwd(), 'output', 'preview-cli.json');
  await test(
    'preview: 用户项目生成二维码',
    async () => {
      const value = await call('wdt_preview', {
        projectPath: userProject,
        qrFormat: 'image',
        qrOutput: qrPath,
        infoOutput: infoPath,
      });
      return {
        ...value,
        qrExists: fs.existsSync(qrPath),
        qrBytes: fs.existsSync(qrPath) ? fs.statSync(qrPath).size : 0,
        infoExists: fs.existsSync(infoPath),
      };
    },
    {
      check: (v) => v.ok === true && v.qrExists === true && v.qrBytes > 0,
      skip: skipUser,
      skipReason,
    }
  );

  await test('quit: 退出 IDE', () => call('wdt_quit'), {
    check: (v) => v.ok === true && v.servicePortClosed === true,
    skip: skipUser,
    skipReason,
  });

  await test(
    'quit 后状态可读',
    async () => {
      await sleep(5000);
      return await call('wdt_status');
    },
    { check: (v) => v.automation.connected === false, skip: skipUser, skipReason }
  );

  await test('open: 恢复用户项目', () => call('wdt_open', { projectPath: userProject }), {
    check: (v) => v.ok === true,
    skip: skipUser,
    skipReason,
  });

  await test(
    '恢复后 IDE 端口在线',
    async () => {
      await sleep(4000);
      return await call('wdt_status');
    },
    { check: (v) => v.ide?.portOpen === true, skip: skipUser, skipReason }
  );

  await test(
    '恢复后自动化可用',
    async () => {
      return await call('wdt_auto_start', {
        projectPath: userProject,
        port: 9420,
        timeoutMs: 45_000,
      });
    },
    { check: (v) => v.connected === true, skip: skipUser, skipReason }
  );

  await test('恢复后断开', () => call('wdt_disconnect'), {
    check: (v) => v.connected === false,
    skip: skipUser,
    skipReason,
  });
} finally {
  try {
    await client.close();
  } catch {}
}

const failed = results.filter((item) => !item.ok);
const skipped = results.filter((item) => item.skipped);
for (const item of results) {
  const status = item.skipped ? 'SKIP' : item.ok ? 'PASS' : 'FAIL';
  console.log(`${status}  ${item.name}${item.detail ? `  — ${item.detail}` : ''}`);
}
console.log(
  `\n${results.length - failed.length - skipped.length}/${
    results.length - skipped.length
  } passed, ${skipped.length} skipped`
);
process.exitCode = failed.length === 0 ? 0 : 1;
