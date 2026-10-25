#!/usr/bin/env node
/**
 * MCP server entry point.
 *
 * Tool groups:
 * - `wdt_*` CLI tools: project lifecycle, login, preview, build npm, upload.
 * - `wdt_auto_*` / simulator tools: WebSocket session, pages, elements,
 *   screenshots, evaluate, wx APIs, native dialogs.
 *
 * All tool handlers return JSON text. Errors are returned as `isError` with a
 * readable message; the process writes logs to stderr only because stdout is
 * reserved for JSON-RPC.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  allowUpload,
  clearStaleIdeState,
  cliErrorSummary,
  cliLooksErrored,
  cliScript,
  defaultPort,
  defaultProject,
  electronExe,
  ensureIdeRunning,
  ensureOutputDir,
  isPortOpen,
  outputDir,
  readAppPages,
  readIdeState,
  readServicePortSetting,
  resolveProject,
  runCli,
  tail,
} from './runtime.js';
import {
  connectAutomation,
  disconnectAutomation,
  getSessionState,
  probeSession,
  requireMiniProgram,
  startAutomation,
} from './session.js';

const server = new McpServer({
  name: 'wechat-devtools',
  version: '0.1.0',
});

/**
 * Wrap a successful value as MCP text content.
 *
 * @param {unknown} data
 * @returns {{ content: Array<{ type: 'text', text: string }> }}
 */
const textResult = (data) => ({
  content: [
    {
      type: 'text',
      text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
    },
  ],
});

/**
 * Wrap an error as an MCP `isError` result.
 *
 * @param {unknown} error
 * @returns {{ content: Array<{ type: 'text', text: string }>, isError: true }}
 */
const errorResult = (error) => ({
  content: [
    {
      type: 'text',
      text: `ERROR: ${error instanceof Error ? error.message : String(error)}`,
    },
  ],
  isError: true,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Register a tool with a uniform success/error envelope.
 *
 * @param {string} name
 * @param {object} config MCP tool metadata (`title`, `description`, `inputSchema`).
 * @param {(args: object) => Promise<unknown>} handler
 */
function expose(name, config, handler) {
  server.registerTool(name, config, async (args) => {
    try {
      return textResult(await handler(args || {}));
    } catch (error) {
      return errorResult(error);
    }
  });
}

const projectArg = z
  .string()
  .optional()
  .describe('小程序项目目录；省略时使用 WECHAT_DEVTOOLS_PROJECT');

/**
 * Normalize a CLI result for tool output.
 *
 * The DevTools CLI sometimes exits 0 while printing `[error]`; `ok` and `hint`
 * make that visible to the agent without forcing it to parse stdout.
 *
 * @param {Awaited<ReturnType<typeof runCli>>} result
 * @returns {object}
 */
function cliSummary(result) {
  const errored = cliLooksErrored(result);
  return {
    ok: !errored,
    code: result.code,
    timedOut: result.timedOut,
    hint: errored ? cliErrorSummary(result) : null,
    stdout: tail(result.stdout, 12_000),
    stderr: tail(result.stderr, 6_000),
  };
}

expose(
  'wdt_status',
  {
    title: '微信开发者工具环境状态',
    description:
      '检查开发者工具路径、服务端口开关、自动化连接状态与端口占用。开始任何操作前可先调用。',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    let project = null;
    let projectError = null;
    try {
      if (defaultProject) project = resolveProject(defaultProject);
    } catch (error) {
      projectError = error.message;
    }
    const servicePort = readServicePortSetting();
    const ideState = readIdeState();
    const idePortOpen = ideState?.port ? await isPortOpen(ideState.port) : false;
    const state = getSessionState();
    const probe = await probeSession();
    return {
      devtools: {
        dir: path.dirname(electronExe),
        electronExists: fs.existsSync(electronExe),
        cliExists: fs.existsSync(cliScript),
      },
      node: process.version,
      defaultProject: project,
      defaultProjectError: projectError,
      automation: {
        ...state,
        alive: probe.alive,
        currentPage: probe.currentPage ?? null,
        lastError: probe.error ?? null,
        portOpen: await isPortOpen(state.port),
      },
      servicePort: servicePort
        ? {
            ...servicePort,
            configured: servicePort.enabled,
            ok: servicePort.enabled && idePortOpen,
          }
        : { ok: false, configured: false, reason: '未找到安全设置文件' },
      ide: ideState ? { ...ideState, portOpen: idePortOpen } : null,
      uploadEnabled: allowUpload,
      outputDir,
    };
  }
);

expose(
  'wdt_open',
  {
    title: '在开发者工具中打开项目',
    description:
      '调用官方 CLI 打开（或聚焦）一个小程序项目。需要服务端口开启；登录状态由 IDE 决定。',
    inputSchema: {
      projectPath: projectArg,
      port: z
        .number()
        .int()
        .optional()
        .describe('可选的 IDE HTTP 服务端口；一般无需传入'),
    },
    annotations: { openWorldHint: false },
  },
  async ({ projectPath, port }) => {
    const project = resolveProject(projectPath);
    const ide = await ensureIdeRunning({ timeoutMs: 30_000 });
    const args = ['open', '--project', project.projectPath];
    if (port) args.push('--port', String(port));
    let result = await runCli(args, {
      cwd: project.projectPath,
      timeoutMs: 120_000,
    });
    let attempts = 1;
    // IDE 刚退出时 CLI 可能短暂看到旧端口；等待后重试一次。
    if (
      cliLooksErrored(result) &&
      /already started at port|EADDRINUSE|already running/i.test(
        `${result.stdout}${result.stderr}`
      )
    ) {
      await sleep(3000);
      result = await runCli(args, {
        cwd: project.projectPath,
        timeoutMs: 120_000,
      });
      attempts = 2;
    }
    return {
      project,
      attempts,
      ideStarted: ide.started,
      idePort: ide.port,
      ...cliSummary(result),
    };
  }
);

expose(
  'wdt_close_project',
  {
    title: '关闭项目窗口',
    description: '关闭指定项目窗口，不退出整个开发者工具。',
    inputSchema: { projectPath: projectArg },
    annotations: { destructiveHint: true },
  },
  async ({ projectPath }) => {
    const project = resolveProject(projectPath);
    const result = await runCli(['close', '--project', project.projectPath], {
      cwd: project.projectPath,
      timeoutMs: 60_000,
    });
    return { project, ...cliSummary(result) };
  }
);

expose(
  'wdt_quit',
  {
    title: '退出开发者工具',
    description: '退出整个微信开发者工具。会关闭所有项目窗口。',
    inputSchema: {},
    annotations: { destructiveHint: true },
  },
  async () => {
    await disconnectAutomation({ closeProject: false });
    const setting = readServicePortSetting();
    const ideState = readIdeState();
    const observedPort = ideState?.port || setting?.port || null;
    const result = await runCli(['quit'], { timeoutMs: 60_000 });

    let servicePortClosed = !observedPort;
    const deadline = Date.now() + 40_000;
    while (!servicePortClosed && Date.now() < deadline) {
      if (!(await isPortOpen(observedPort))) {
        servicePortClosed = true;
        break;
      }
      await sleep(500);
    }

    const staleCleanup = servicePortClosed
      ? await clearStaleIdeState({ force: true })
      : null;

    return {
      ...cliSummary(result),
      servicePortClosed,
      servicePort: observedPort,
      staleCleanup,
    };
  }
);

expose(
  'wdt_login',
  {
    title: '登录开发者工具',
    description:
      '触发官方 CLI 登录，stdout 中通常包含二维码（终端字符画）。需要用户用微信扫码。',
    inputSchema: {},
    annotations: { openWorldHint: true },
  },
  async () => {
    await ensureIdeRunning({ timeoutMs: 30_000 });
    const result = await runCli(['login'], { timeoutMs: 180_000 });
    return cliSummary(result);
  }
);

expose(
  'wdt_is_login',
  {
    title: '检查开发者工具登录状态',
    description: '调用官方 CLI islogin，返回当前是否已登录。预览和上传前建议先检查。',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async () => {
    await ensureIdeRunning({ timeoutMs: 30_000 });
    const result = await runCli(['islogin'], { timeoutMs: 60_000 });
    const stdout = result.stdout || '';
    const start = stdout.indexOf('{');
    let parsed = null;
    if (start >= 0) {
      try {
        parsed = JSON.parse(stdout.slice(start).trim());
      } catch {}
    }
    return {
      login: parsed?.login ?? null,
      ...cliSummary(result),
    };
  }
);

expose(
  'wdt_preview',
  {
    title: '生成小程序预览二维码',
    description:
      '调用官方 CLI 生成预览。qrFormat=image/base64 时可把二维码写入 qrOutput。需要已登录。',
    inputSchema: {
      projectPath: projectArg,
      qrFormat: z.enum(['terminal', 'image', 'base64']).optional(),
      qrOutput: z
        .string()
        .optional()
        .describe('二维码图片输出路径（qrFormat 为 image/base64 时建议填写）'),
      infoOutput: z.string().optional().describe('预览信息 JSON 输出路径'),
    },
    annotations: { openWorldHint: true },
  },
  async ({ projectPath, qrFormat, qrOutput, infoOutput }) => {
    const project = resolveProject(projectPath);
    await ensureIdeRunning({ timeoutMs: 30_000 });
    const format = qrFormat || 'terminal';
    const args = ['preview', '--project', project.projectPath, '--qr-format', format];

    let resolvedQrOutput = qrOutput ? path.resolve(qrOutput) : null;
    if (!resolvedQrOutput && (format === 'image' || format === 'base64')) {
      ensureOutputDir();
      const stamp = new Date()
        .toISOString()
        .replace(/[:.]/g, '-')
        .replace('T', '_')
        .replace('Z', '');
      resolvedQrOutput = path.join(
        outputDir,
        `preview-${stamp}.${format === 'image' ? 'png' : 'txt'}`
      );
    }
    if (resolvedQrOutput) {
      fs.mkdirSync(path.dirname(resolvedQrOutput), { recursive: true });
      args.push('--qr-output', resolvedQrOutput);
    }
    if (infoOutput) {
      const target = path.resolve(infoOutput);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      args.push('--info-output', target);
    }
    const result = await runCli(args, {
      cwd: project.projectPath,
      timeoutMs: 240_000,
    });
    const summary = cliSummary(result);
    const loginHint =
      !summary.ok && /login|登录|not logged/i.test(`${result.stdout}${result.stderr}`)
        ? '预览需要先在开发者工具中登录；可调用 wdt_login 触发扫码。'
        : null;
    return {
      project,
      qrFormat: format,
      qrOutput: resolvedQrOutput,
      infoOutput: infoOutput ? path.resolve(infoOutput) : null,
      loginHint,
      ...summary,
    };
  }
);

expose(
  'wdt_build_npm',
  {
    title: '构建小程序 npm',
    description: '调用官方 CLI 执行 build-npm，构建项目依赖。',
    inputSchema: { projectPath: projectArg },
  },
  async ({ projectPath }) => {
    const project = resolveProject(projectPath);
    await ensureIdeRunning({ timeoutMs: 30_000 });
    const result = await runCli(['build-npm', '--project', project.projectPath], {
      cwd: project.projectPath,
      timeoutMs: 240_000,
    });
    const summary = cliSummary(result);
    if (/__NO_NODE_MODULES__|NO_NODE_MODULES/.test(`${result.stdout}${result.stderr}`)) {
      return {
        project,
        ok: false,
        code: result.code,
        hint: '项目里没有可构建的 npm 依赖（未找到 node_modules）。',
        stdout: '',
        stderr: '',
      };
    }
    return { project, ...summary };
  }
);

expose(
  'wdt_upload',
  {
    title: '上传小程序版本（默认禁用）',
    description:
      '调用官方 CLI 上传版本到微信后台。默认禁用；仅在 WECHAT_DEVTOOLS_MCP_ALLOW_UPLOAD=1 且 confirm=true 时执行。此操作会发布版本，不可撤销。',
    inputSchema: {
      projectPath: projectArg,
      version: z.string().describe('版本号，如 1.0.0'),
      desc: z.string().describe('版本描述'),
      confirm: z.boolean().optional().describe('必须显式传 true 才会执行上传'),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  async ({ projectPath, version, desc, confirm }) => {
    if (!allowUpload) {
      throw new Error(
        '上传功能默认禁用。请设置 WECHAT_DEVTOOLS_MCP_ALLOW_UPLOAD=1 后重启 MCP，并显式传 confirm=true。'
      );
    }
    if (confirm !== true) {
      throw new Error('上传会发布版本，必须显式传 confirm=true。');
    }
    const project = resolveProject(projectPath);
    const result = await runCli(
      ['upload', '--project', project.projectPath, '--version', version, '--desc', desc],
      { cwd: project.projectPath, timeoutMs: 300_000 }
    );
    return { project, version, desc, ...cliSummary(result) };
  }
);

expose(
  'wdt_auto_start',
  {
    title: '启动自动化并连接模拟器',
    description:
      '通过 CLI auto 打开项目并开启自动化端口，然后建立 WebSocket 连接。需要服务端口开启。后续 wdt_current_page / wdt_query / wdt_element / wdt_screenshot 等工具依赖此连接。',
    inputSchema: {
      projectPath: projectArg,
      port: z.number().int().optional().describe('自动化端口，默认 9420'),
      timeoutMs: z
        .number()
        .int()
        .optional()
        .describe('等待端口与连接的总预算，默认 45000，最大 45000'),
      restart: z
        .boolean()
        .optional()
        .describe('强制重启自动化；默认复用已连接会话，避免打断现有窗口'),
    },
    annotations: { openWorldHint: false },
  },
  async ({ projectPath, port, timeoutMs, restart }) =>
    startAutomation({ projectPath, port, timeoutMs, restart: Boolean(restart) })
);

expose(
  'wdt_auto_connect',
  {
    title: '连接已开启的自动化端口',
    description: '不启动 IDE，直接连接一个已经用 auto 模式打开的自动化端口。',
    inputSchema: {
      wsEndpoint: z.string().optional().describe('默认 ws://127.0.0.1:9420'),
      timeoutMs: z.number().int().optional().describe('连接超时，默认 30000'),
    },
  },
  async ({ wsEndpoint, timeoutMs }) => connectAutomation({ wsEndpoint, timeoutMs })
);

expose(
  'wdt_disconnect',
  {
    title: '断开自动化连接',
    description:
      '关闭 WebSocket 自动化连接；closeProject=true 时同时关闭项目窗口。不会退出开发者工具。',
    inputSchema: {
      closeProject: z.boolean().optional().describe('是否同时关闭项目窗口'),
    },
  },
  async ({ closeProject }) => {
    const previous = await disconnectAutomation({
      closeProject: Boolean(closeProject),
    });
    return { disconnected: previous, ...getSessionState() };
  }
);

expose(
  'wdt_current_page',
  {
    title: '获取当前页面与页面栈',
    description: '返回当前小程序页面的路径、query，以及页面栈路径。',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    const mp = requireMiniProgram();
    const page = await mp.currentPage();
    let size = null;
    if (page) {
      try {
        size = await page.size();
      } catch {
        // 页面切换中可能取不到尺寸
      }
    }
    let stack = [];
    try {
      const pages = await mp.pageStack();
      stack = pages.map((item) => ({ path: item.path, query: item.query }));
    } catch {
      // 保留当前页信息
    }
    return {
      current: page ? { path: page.path, query: page.query, size } : null,
      stack,
    };
  }
);

expose(
  'wdt_navigate',
  {
    title: '页面跳转',
    description:
      '在当前小程序中跳转：navigateTo / redirectTo / reLaunch / switchTab / navigateBack。',
    inputSchema: {
      mode: z.enum(['navigateTo', 'redirectTo', 'reLaunch', 'switchTab', 'navigateBack']),
      url: z.string().optional().describe('目标路径，如 /pages/index/index'),
      validate: z
        .boolean()
        .optional()
        .describe('是否按 app.json 校验目标页面，默认 true；动态页面可设 false'),
    },
  },
  async ({ mode, url, validate }) => {
    const mp = requireMiniProgram();
    if (mode !== 'navigateBack' && !url) {
      throw new Error(`${mode} 需要 url`);
    }

    const target = url ? String(url).replace(/^\/+/, '').split(/[?#]/)[0] : null;
    const projectPath = getSessionState().projectPath || defaultProject;
    const appPages = readAppPages(projectPath);

    if (validate !== false && appPages && target) {
      if (mode === 'switchTab') {
        if (appPages.tabBar.length === 0) {
          throw new Error(
            '当前项目没有 tabBar，switchTab 不可用。请改用 navigateTo / reLaunch。'
          );
        }
        if (!appPages.tabBar.includes(target)) {
          throw new Error(
            `switchTab 只能跳转 tabBar 页面。可用：${appPages.tabBar.join(', ')}；收到：${target}`
          );
        }
      } else if (appPages.all.length) {
        if (!appPages.all.includes(target)) {
          const tabHint = appPages.tabBar.includes(target)
            ? '该页面在 tabBar 中，请改用 switchTab。'
            : `已声明页面：${appPages.all.join(', ')}`;
          throw new Error(
            `${mode} 目标页面 ${target} 不在 app.json 的 pages/subPackages 中。${tabHint}\n如果这是动态页面，可传 validate=false 跳过检查。`
          );
        }
        // reLaunch 可以进入 tabBar 页面；navigateTo / redirectTo 不可以。
        if (mode !== 'reLaunch' && appPages.tabBar.includes(target)) {
          throw new Error(
            `${mode} 不能跳转 tabBar 页面（${target}），请改用 switchTab 或 reLaunch。`
          );
        }
      }
    }

    let page;
    try {
      if (mode === 'navigateBack') {
        page = await mp.navigateBack();
      } else {
        page = await mp[mode](url);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${mode} 失败${url ? `（${url}）` : ''}：${message}` +
          (message.includes('[object Object]')
            ? '\n底层自动化协议只返回了对象错误；请检查页面是否声明、是否为 tabBar 页面，以及项目是否已编译通过。'
            : '')
      );
    }

    return {
      mode,
      url: url || null,
      page: page ? { path: page.path, query: page.query } : null,
    };
  }
);

expose(
  'wdt_query',
  {
    title: '查询页面元素',
    description:
      '用 CSS 选择器查询当前页面元素，返回 tagName、文本、id/class、value 等摘要。',
    inputSchema: {
      selector: z.string().describe('CSS 选择器，如 .btn 或 #title'),
      all: z.boolean().optional().describe('是否返回全部匹配项，默认只返回第一个'),
      max: z.number().int().optional().describe('最多返回数量，默认 20'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ selector, all, max }) => {
    const mp = requireMiniProgram();
    const page = await mp.currentPage();
    if (!page) throw new Error('当前没有页面');
    const elements = await page.$$(selector);
    const limit = Math.max(1, Math.min(all ? (max ?? 20) : 1, 50));
    const selected = elements.slice(0, limit);
    const results = [];
    for (const element of selected) {
      const item = {
        tagName: element.tagName,
        text: null,
        value: null,
        id: null,
        className: null,
      };
      try {
        item.text = (await element.text()).slice(0, 300);
      } catch {}
      try {
        item.value = await element.value();
      } catch {}
      try {
        item.id = await element.attribute('id');
      } catch {}
      try {
        item.className = await element.attribute('class');
      } catch {}
      results.push(item);
    }
    return { selector, count: elements.length, elements: results };
  }
);

expose(
  'wdt_element',
  {
    title: '操作或读取页面元素',
    description:
      '对匹配 selector 的第 index 个元素执行动作：tap/longpress/input/text/value/attribute/property/style/wxml/outerWxml/size/offset/trigger/scrollTo/scrollWidth/scrollHeight/swipeTo/slideTo/callMethod/callContextMethod/setData/data。slideTo 会补发 change 事件；swipeTo 只改视觉索引。',
    inputSchema: {
      selector: z.string(),
      index: z.number().int().optional().describe('匹配项下标，默认 0'),
      action: z.enum([
        'tap',
        'longpress',
        'input',
        'text',
        'value',
        'attribute',
        'property',
        'style',
        'wxml',
        'outerWxml',
        'size',
        'offset',
        'trigger',
        'scrollTo',
        'scrollWidth',
        'scrollHeight',
        'swipeTo',
        'slideTo',
        'callMethod',
        'callContextMethod',
        'setData',
        'data',
      ]),
      name: z.string().optional().describe('attribute/property/style/data 的名称'),
      value: z.any().optional().describe('input/slideTo/swipeTo/data 的值'),
      type: z.string().optional().describe('trigger 的事件名'),
      detail: z.any().optional().describe('trigger 的 detail'),
      x: z.number().optional().describe('scrollTo 的 x'),
      y: z.number().optional().describe('scrollTo 的 y'),
      method: z.string().optional().describe('callMethod 的方法名'),
      args: z.array(z.any()).optional().describe('callMethod 的参数'),
      data: z.any().optional().describe('setData 的数据'),
      path: z.string().optional().describe('data 的路径'),
    },
  },
  async (args) => {
    const mp = requireMiniProgram();
    const page = await mp.currentPage();
    if (!page) throw new Error('当前没有页面');
    const elements = await page.$$(args.selector);
    const index = args.index ?? 0;
    const element = elements[index];
    if (!element) {
      throw new Error(
        `未找到元素：${args.selector}（index=${index}，共 ${elements.length} 个）`
      );
    }
    const action = args.action;
    let result = null;

    switch (action) {
      case 'tap':
        await element.tap();
        break;
      case 'longpress':
        await element.longpress();
        break;
      case 'input':
        if (typeof element.input !== 'function') {
          throw new Error('该元素不支持 input（不是 input/textarea）');
        }
        await element.input(String(args.value ?? ''));
        break;
      case 'text':
        result = await element.text();
        break;
      case 'value':
        result = await element.value();
        break;
      case 'attribute':
        if (!args.name) throw new Error('attribute 需要 name');
        result = await element.attribute(args.name);
        break;
      case 'property':
        if (!args.name) throw new Error('property 需要 name');
        result = await element.property(args.name);
        break;
      case 'style':
        if (!args.name) throw new Error('style 需要 name');
        result = await element.style(args.name);
        break;
      case 'wxml':
        result = await element.wxml();
        break;
      case 'outerWxml':
        result = await element.outerWxml();
        break;
      case 'size':
        result = await element.size();
        break;
      case 'offset':
        result = await element.offset();
        break;
      case 'trigger':
        if (!args.type) throw new Error('trigger 需要 type');
        await element.trigger(args.type, args.detail);
        break;
      case 'scrollTo':
        await element.scrollTo(args.x ?? 0, args.y ?? 0);
        break;
      case 'scrollWidth':
        result = await element.scrollWidth();
        break;
      case 'scrollHeight':
        result = await element.scrollHeight();
        break;
      case 'swipeTo':
        await element.swipeTo(Number(args.value ?? 0));
        break;
      case 'slideTo': {
        const sliderValue = Number(args.value ?? 0);
        await element.slideTo(sliderValue);
        let changeTriggered = false;
        try {
          await element.trigger('change', { value: sliderValue });
          changeTriggered = true;
        } catch {
          // 某些版本 slideTo 已自带 change，不重复报错
        }
        result = { value: sliderValue, changeTriggered };
        break;
      }
      case 'callMethod':
        if (!args.method) throw new Error('callMethod 需要 method');
        result = await element.callMethod(args.method, ...(args.args || []));
        break;
      case 'callContextMethod':
        if (!args.method) throw new Error('callContextMethod 需要 method');
        result = await element.callContextMethod(args.method, ...(args.args || []));
        break;
      case 'setData':
        await element.setData(args.data ?? {});
        break;
      case 'data':
        result = await element.data(args.path);
        break;
      default:
        throw new Error(`不支持的动作：${action}`);
    }

    return { selector: args.selector, index, action, result: result ?? null };
  }
);

expose(
  'wdt_wait',
  {
    title: '等待页面条件',
    description:
      '等待 CSS 选择器出现（传字符串）或等待固定毫秒数（传数字），最长 60 秒。',
    inputSchema: {
      target: z.union([z.string(), z.number()]),
      timeoutMs: z.number().int().optional().describe('MCP 层超时，默认 60000'),
    },
  },
  async ({ target, timeoutMs }) => {
    const mp = requireMiniProgram();
    const page = await mp.currentPage();
    if (!page) throw new Error('当前没有页面');
    const timeout = Math.min(timeoutMs ?? 60_000, 60_000);
    let timer;
    try {
      await Promise.race([
        typeof target === 'number'
          ? page.waitFor(Math.min(target, timeout))
          : page.waitFor(target),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`等待超时：${target}`)), timeout);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    return { ok: true, target };
  }
);

expose(
  'wdt_page_data',
  {
    title: '读取/修改页面数据或调用页面方法',
    description:
      'action=get 读取 data（可选 path）；action=set 调用 setData；action=call 调用页面方法。',
    inputSchema: {
      action: z.enum(['get', 'set', 'call']),
      path: z.string().optional(),
      data: z.any().optional(),
      method: z.string().optional(),
      args: z.array(z.any()).optional(),
    },
  },
  async ({ action, path: dataPath, data, method, args }) => {
    const mp = requireMiniProgram();
    const page = await mp.currentPage();
    if (!page) throw new Error('当前没有页面');
    if (action === 'get') {
      return { action, result: await page.data(dataPath) };
    }
    if (action === 'set') {
      await page.setData(data ?? {});
      return { action, ok: true };
    }
    if (!method) throw new Error('call 需要 method');
    const callArgs = args || [];
    try {
      return {
        action,
        result: (await page.callMethod(method, ...callArgs)) ?? null,
        fallback: false,
      };
    } catch (error) {
      const primary = error instanceof Error ? error.message : String(error);
      try {
        const result = await mp.evaluate(
          `function(method, args) {
            const pages = getCurrentPages();
            const page = pages[pages.length - 1];
            if (!page || typeof page[method] !== 'function') {
              throw new Error('页面方法不存在: ' + method);
            }
            return page[method].apply(page, args);
          }`,
          method,
          callArgs
        );
        return { action, result: result ?? null, fallback: true, primaryError: primary };
      } catch (fallbackError) {
        const secondary =
          fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        throw new Error(
          `页面方法 ${method} 调用失败：${primary}；evaluate 回退也失败：${secondary}`
        );
      }
    }
  }
);

expose(
  'wdt_screenshot',
  {
    title: '截取模拟器画面',
    description:
      '截取当前小程序模拟器画面为 PNG。path 省略时写入 MCP output 目录并返回文件路径。',
    inputSchema: {
      path: z.string().optional().describe('PNG 输出路径'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ path: targetPath }) => {
    const mp = requireMiniProgram();
    let target;
    if (targetPath) {
      target = path.resolve(targetPath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
    } else {
      ensureOutputDir();
      const stamp = new Date()
        .toISOString()
        .replace(/[:.]/g, '-')
        .replace('T', '_')
        .replace('Z', '');
      target = path.join(outputDir, `wdt-${stamp}.png`);
    }
    await mp.screenshot({ path: target });
    const stat = fs.statSync(target);
    return { path: target, bytes: stat.size };
  }
);

expose(
  'wdt_evaluate',
  {
    title: '在小程序 App 上下文执行表达式',
    description:
      '在 miniProgram.evaluate 中执行表达式或函数体，返回可序列化结果。默认把输入当表达式自动包成函数；mode=function 时原样传入函数声明。可通过 $args 访问 args 参数。仅用于本地调试，注意副作用。',
    inputSchema: {
      expression: z.string().describe('表达式（如 getCurrentPages().length）或函数源码'),
      args: z
        .array(z.any())
        .optional()
        .describe('传给函数的参数，可在表达式里用 $args 访问'),
      mode: z
        .enum(['auto', 'expression', 'statements', 'function'])
        .optional()
        .describe(
          'auto 默认；expression 强制按表达式；statements 按语句块；function 原样传入'
        ),
    },
  },
  async ({ expression, args, mode }) => {
    const mp = requireMiniProgram();
    const trimmed = String(expression).trim();
    const selectedMode = mode || 'auto';
    const looksFunction =
      /^(async\s+)?function\b/.test(trimmed) ||
      /^(async\s*)?(\([^)]*\)|[\w$]+)\s*=>/.test(trimmed);

    let source;
    if (selectedMode === 'function' || (selectedMode === 'auto' && looksFunction)) {
      source = trimmed;
    } else if (
      selectedMode === 'statements' ||
      (selectedMode === 'auto' &&
        (/\breturn\b|\bthrow\b/.test(trimmed) || /[;\n]/.test(trimmed)))
    ) {
      source = `function(){ const $args = Array.from(arguments); ${trimmed} }`;
    } else {
      source = `function(){ const $args = Array.from(arguments); return (${trimmed}); }`;
    }

    let result;
    try {
      result = await mp.evaluate(source, ...(args || []));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`evaluate 失败：${message}\n执行源码：${source.slice(0, 500)}`);
    }
    return {
      mode: selectedMode,
      source,
      result: result ?? null,
    };
  }
);

expose(
  'wdt_wx_method',
  {
    title: '调用 wx API',
    description:
      '通过 miniProgram.callWxMethod 调用 wx 方法，并返回结果。例如 getSystemInfoSync、getStorageSync。',
    inputSchema: {
      method: z.string().describe('wx 方法名，如 getSystemInfoSync'),
      args: z.array(z.any()).optional(),
    },
  },
  async ({ method, args }) => {
    const mp = requireMiniProgram();
    const result = await mp.callWxMethod(method, ...(args || []));
    return { method, result: result ?? null };
  }
);

expose(
  'wdt_native',
  {
    title: '模拟器原生交互',
    description:
      '执行原生层动作：goHome / navigateLeft / confirmModal / cancelModal / authorizeAllow / authorizeCancel / closePaymentDialog / shareCancel / shareConfirm / switchTab。',
    inputSchema: {
      action: z.enum([
        'goHome',
        'navigateLeft',
        'confirmModal',
        'cancelModal',
        'authorizeAllow',
        'authorizeCancel',
        'closePaymentDialog',
        'shareCancel',
        'shareConfirm',
        'switchTab',
      ]),
      url: z.string().optional().describe('switchTab 需要的 tabBar 路径'),
    },
  },
  async ({ action, url }) => {
    const mp = requireMiniProgram();
    const native = mp.native();
    if (action === 'switchTab') {
      if (!url) throw new Error('switchTab 需要 url');
      const target = String(url).replace(/^\/+/, '').split(/[?#]/)[0];
      const appPages = readAppPages(getSessionState().projectPath || defaultProject);
      if (appPages && appPages.tabBar.length === 0) {
        throw new Error('当前项目没有 tabBar，native switchTab 不可用。');
      }
      if (appPages && !appPages.tabBar.includes(target)) {
        throw new Error(
          `native switchTab 只能跳转 tabBar 页面。可用：${appPages.tabBar.join(', ')}`
        );
      }
    }
    try {
      if (action === 'switchTab') {
        return { action, result: await native.switchTab({ url }) };
      }
      return { action, result: (await native[action]()) ?? null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `native ${action} 失败：${message}` +
          (message.includes('[object Object]')
            ? '\n该动作可能要求页面上存在对应弹窗/授权框；先用 wdt_current_page 检查当前状态。'
            : '')
      );
    }
  }
);

expose(
  'wdt_system_info',
  {
    title: '获取小程序系统信息',
    description: '返回 miniProgram.systemInfo()。',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    const mp = requireMiniProgram();
    return await mp.systemInfo();
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `[wechat-devtools-mcp] ready (devtools=${path.dirname(electronExe)}, defaultPort=${defaultPort})`
);
