#!/usr/bin/env node
/**
 * Automation integration suite.
 *
 * Requires a running WeChat DevTools with the service port enabled. The script
 * spawns its own MCP server, starts the fixture project on port 9421 by default,
 * and exercises input, taps, switches, sliders, scrolling, navigation, evaluate,
 * wx APIs, screenshots, and error paths.
 *
 * Usage: node scripts/e2e.js [projectPath] [port]
 */
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const projectPath = path.resolve(
  process.argv[2] || path.join(process.cwd(), 'test-fixtures', 'miniprogram')
);
const port = Number(process.argv[3] || 9421);

const env = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => typeof value === 'string')
);
env.WECHAT_DEVTOOLS_PROJECT = projectPath;
env.WECHAT_DEVTOOLS_AUTOMATION_PORT = String(port);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(process.cwd(), 'src', 'server.js')],
  cwd: process.cwd(),
  env,
  stderr: 'pipe',
});

const client = new Client({ name: 'wechat-devtools-e2e', version: '0.1.0' });
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
        detail: `断言失败: ${JSON.stringify(value).slice(0, 500)}`,
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

const pageData = async () => (await call('wdt_page_data', { action: 'get' })).result;

try {
  await client.connect(transport);

  await test('status: 初始状态', () => call('wdt_status'), {
    check: (v) => v.devtools.electronExists && v.servicePort.ok === true,
  });

  await test(
    'auto_start: 启动测试项目',
    () => call('wdt_auto_start', { projectPath, port, timeoutMs: 90_000 }),
    {
      check: (v) => v.connected === true && v.currentPage?.path === 'pages/index/index',
    }
  );

  await test('current_page', () => call('wdt_current_page'), {
    check: (v) => v.current?.path === 'pages/index/index',
  });

  await test('query: input', () => call('wdt_query', { selector: '.name-input' }), {
    check: (v) => v.count === 1 && v.elements[0].tagName === 'input',
  });

  await test(
    'element: input 输入',
    () =>
      call('wdt_element', { selector: '.name-input', action: 'input', value: 'hello' }),
    {
      check: () => true,
    }
  );

  await test(
    'page_data: 输入生效',
    async () => {
      await call('wdt_wait', { target: 300 });
      return { value: (await pageData()).name };
    },
    { check: (v) => v.value === 'hello' }
  );

  await test(
    'element: text 回显',
    () => call('wdt_element', { selector: '.name-echo', action: 'text' }),
    {
      check: (v) => v.result === 'hello',
    }
  );

  await test(
    'element: tap 计数 +1',
    async () => {
      const before = (await pageData()).tapCount;
      await call('wdt_element', { selector: '.tap-btn', action: 'tap' });
      await call('wdt_wait', { target: 300 });
      const after = (await pageData()).tapCount;
      return { before, after };
    },
    { check: (v) => v.after === v.before + 1 }
  );

  await test(
    'element: switch 切换',
    async () => {
      const before = (await pageData()).switchOn;
      await call('wdt_element', { selector: '.switch', action: 'tap' });
      await call('wdt_wait', { target: 300 });
      return { before, after: (await pageData()).switchOn };
    },
    { check: (v) => v.after === !v.before }
  );

  await test(
    'element: slider slideTo',
    async () => {
      await call('wdt_element', { selector: '.slider', action: 'slideTo', value: 70 });
      await call('wdt_wait', { target: 300 });
      return await pageData();
    },
    { check: (v) => Number(v.slider) === 70 }
  );

  await test(
    'element: scrollHeight',
    () => call('wdt_element', { selector: '.scroll', action: 'scrollHeight' }),
    {
      check: (v) => Number(v.result) > 0,
    }
  );

  await test('element: scrollTo', () =>
    call('wdt_element', { selector: '.scroll', action: 'scrollTo', x: 0, y: 80 }));

  await test('element: swiper swipeTo', () =>
    call('wdt_element', { selector: '.swiper', action: 'swipeTo', value: 2 }));

  await test(
    'navigate: navigateTo detail',
    () =>
      call('wdt_navigate', { mode: 'navigateTo', url: '/pages/detail/detail?from=e2e' }),
    {
      check: (v) =>
        v.page?.path === 'pages/detail/detail' && v.page?.query?.from === 'e2e',
    }
  );

  await test(
    'navigate: back 到首页',
    async () => {
      const page = await call('wdt_navigate', { mode: 'navigateBack' });
      return page;
    },
    { check: (v) => v.page?.path === 'pages/index/index' }
  );

  await test(
    'navigate: switchTab 到 tab 页',
    () => call('wdt_navigate', { mode: 'switchTab', url: '/pages/tab/tab' }),
    {
      check: (v) => v.page?.path === 'pages/tab/tab',
    }
  );

  await test(
    'navigate: switchTab 回首页',
    () => call('wdt_navigate', { mode: 'switchTab', url: '/pages/index/index' }),
    {
      check: (v) => v.page?.path === 'pages/index/index',
    }
  );

  await test(
    'navigate: 非 tabBar 页 switchTab 应失败',
    () => call('wdt_navigate', { mode: 'switchTab', url: '/pages/detail/detail' }),
    {
      expectError: true,
    }
  );

  await test(
    'navigate: 未声明页面应失败',
    () => call('wdt_navigate', { mode: 'navigateTo', url: '/pages/nope/nope' }),
    {
      expectError: true,
    }
  );

  await test(
    'evaluate: 表达式 1+1',
    () => call('wdt_evaluate', { expression: '1 + 1' }),
    {
      check: (v) => v.result === 2,
    }
  );

  await test(
    'evaluate: 对象字面量',
    () => call('wdt_evaluate', { expression: '({ a: 1, b: "x" })' }),
    {
      check: (v) => v.result?.a === 1 && v.result?.b === 'x',
    }
  );

  await test(
    'evaluate: $args',
    () => call('wdt_evaluate', { expression: '$args[0] + $args[1]', args: [2, 3] }),
    {
      check: (v) => v.result === 5,
    }
  );

  await test(
    'evaluate: statements',
    () =>
      call('wdt_evaluate', {
        expression: 'const x = $args[0] * 2; return x;',
        args: [4],
      }),
    {
      check: (v) => v.result === 8,
    }
  );

  await test(
    'evaluate: function',
    () =>
      call('wdt_evaluate', {
        expression: 'function(a, b) { return a * b; }',
        args: [3, 4],
        mode: 'function',
      }),
    {
      check: (v) => v.result === 12,
    }
  );

  await test(
    'page_data: callMethod 回退',
    async () => {
      const before = (await pageData()).tapCount;
      const value = await call('wdt_page_data', {
        action: 'call',
        method: 'addBy',
        args: [5],
      });
      return { before, value };
    },
    { check: (v) => v.value?.fallback === true && v.value.result === v.before + 5 }
  );

  await test(
    'wx: storage 读写',
    async () => {
      await call('wdt_wx_method', {
        method: 'setStorageSync',
        args: ['mcp-e2e', 'ok'],
      });
      return await call('wdt_wx_method', {
        method: 'getStorageSync',
        args: ['mcp-e2e'],
      });
    },
    { check: (v) => v.result === 'ok' }
  );

  await test('native: goHome', () => call('wdt_native', { action: 'goHome' }));

  await test('screenshot', () => call('wdt_screenshot'), {
    check: (v) => v.bytes > 0 && fs.existsSync(v.path),
  });

  await test('is_login', () => call('wdt_is_login'), {
    check: (v) => typeof v.login === 'boolean',
  });

  await test('build_npm: 失败应返回 ok=false 与可读 hint', () => call('wdt_build_npm'), {
    check: (v) => v.ok === false && typeof v.hint === 'string' && v.hint.length > 0,
  });

  await test(
    'upload: 默认禁用',
    () => call('wdt_upload', { version: '0.0.1', desc: 'e2e', confirm: true }),
    {
      expectError: true,
    }
  );

  await test(
    'auto_start: 复用已有连接',
    () => call('wdt_auto_start', { projectPath, port, timeoutMs: 15_000 }),
    {
      check: (v) => v.reused === true && v.connected === true,
    }
  );

  await test('status: 连接存活', () => call('wdt_status'), {
    check: (v) => v.automation.alive === true,
  });

  await test('query: 未命中返回 0', () => call('wdt_query', { selector: '.not-there' }), {
    check: (v) => v.count === 0,
  });

  await test(
    'element: 未命中应失败',
    () => call('wdt_element', { selector: '.not-there', action: 'tap' }),
    {
      expectError: true,
    }
  );

  await test(
    'element: 非输入框 input 应失败',
    () => call('wdt_element', { selector: '.tap-btn', action: 'input', value: 'x' }),
    {
      expectError: true,
    }
  );

  await test(
    'element: attribute 缺 name 应失败',
    () => call('wdt_element', { selector: '.tap-btn', action: 'attribute' }),
    {
      expectError: true,
    }
  );

  await test(
    'element: index 越界应失败',
    () => call('wdt_element', { selector: '.tap-btn', index: 9, action: 'tap' }),
    {
      expectError: true,
    }
  );

  await test(
    'page_data: get path',
    () => call('wdt_page_data', { action: 'get', path: 'name' }),
    {
      check: (v) => typeof v.result === 'string',
    }
  );

  await test(
    'page_data: set 后读回',
    async () => {
      await call('wdt_page_data', { action: 'set', data: { name: 'E2E' } });
      await call('wdt_wait', { target: 200 });
      return await call('wdt_page_data', { action: 'get', path: 'name' });
    },
    { check: (v) => v.result === 'E2E' }
  );

  await test(
    'evaluate: 抛错应返回源码',
    async () => {
      try {
        await call('wdt_evaluate', { expression: 'throw new Error("boom")' });
        return { failed: false };
      } catch (error) {
        return { failed: true, message: error.message };
      }
    },
    { check: (v) => v.failed === true && v.message.includes('执行源码') }
  );

  await test(
    'wx_method: 不存在的方法应失败',
    () => call('wdt_wx_method', { method: 'notARealWxMethod' }),
    {
      expectError: true,
    }
  );

  await test('system_info', () => call('wdt_system_info'), {
    check: (v) => v.platform === 'devtools',
  });

  await test(
    'native: confirmModal 空调用安全',
    () => call('wdt_native', { action: 'confirmModal' }),
    {
      check: (v) => v.action === 'confirmModal',
    }
  );

  await test(
    'screenshot: 自定义路径',
    async () => {
      const target = path.join(process.cwd(), 'output', 'custom-e2e.png');
      const value = await call('wdt_screenshot', { path: target });
      return { value, exists: fs.existsSync(target), target };
    },
    { check: (v) => v.exists && v.value.path === v.target }
  );

  await test(
    'auto_start: 非法项目应失败',
    () =>
      call('wdt_auto_start', {
        projectPath: path.join(process.cwd(), 'no-such-project'),
      }),
    {
      expectError: true,
    }
  );

  await test(
    'open: 非法项目应失败',
    () => call('wdt_open', { projectPath: path.join(process.cwd(), 'no-such-project') }),
    {
      expectError: true,
    }
  );

  await test('disconnect', () => call('wdt_disconnect'), {
    check: (v) => v.connected === false,
  });

  await test('disconnect: 重复调用安全', () => call('wdt_disconnect'), {
    check: (v) => v.connected === false,
  });

  await test('current_page: 断开后应失败', () => call('wdt_current_page'), {
    expectError: true,
  });

  await test(
    'auto_connect: 错误端口应失败',
    () =>
      call('wdt_auto_connect', {
        wsEndpoint: 'ws://127.0.0.1:9999',
        timeoutMs: 2000,
      }),
    {
      expectError: true,
    }
  );

  await test('status: 错误连接后未崩溃', () => call('wdt_status'), {
    check: (v) => v.automation.connected === false,
  });
} finally {
  try {
    await client.close();
  } catch {}
}

const failed = results.filter((item) => !item.ok);
for (const item of results) {
  console.log(
    `${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.detail ? `  — ${item.detail}` : ''}`
  );
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length === 0 ? 0 : 1;
