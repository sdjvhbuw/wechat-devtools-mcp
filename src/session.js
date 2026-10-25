/**
 * Automation session lifecycle.
 *
 * Owns the singleton `miniprogram-automator` WebSocket connection, the CLI
 * `auto` child process, and the project/port metadata exposed by `wdt_status`.
 *
 * Two invariants matter:
 * 1. Reusing a live session is safer than starting a second `cli auto`; the
 *    second start can tear down the first WebSocket.
 * 2. The automation port may stay occupied after a disconnect. A forced
 *    restart must close the project window and wait for the port to be freed.
 */
import { spawn } from 'node:child_process';
import automator from 'miniprogram-automator';
import {
  allowSkipPortCheck,
  clearStaleIdeState,
  cliScript,
  defaultPort,
  devtoolsDir,
  electronExe,
  ensureIdeRunning,
  isPortOpen,
  readServicePortSetting,
  resolveProject,
  runCli,
  tail,
  waitForPort,
} from './runtime.js';

let miniProgram = null;
let autoChild = null;
let autoLog = '';
let currentProject = null;
let currentPort = defaultPort;
let connectedAt = null;

function portHint() {
  const setting = readServicePortSetting();
  const lines = [
    '开发者工具的服务端口（CLI/HTTP 调用）没有开启，自动化无法启动。',
    '请在微信开发者工具中打开：设置 → 安全设置 → 服务端口（CLI/HTTP 调用），然后重试。',
  ];
  if (setting) {
    lines.push(
      `当前检测值：enableServicePort=${setting.enabled}，配置文件：${setting.file}`
    );
  }
  lines.push(
    '如确认已开启但仍报错，可设置 WECHAT_DEVTOOLS_SKIP_SERVICE_PORT_CHECK=1 跳过此预检查。'
  );
  return lines.join('\n');
}

function assertServicePort() {
  if (allowSkipPortCheck) return;
  const setting = readServicePortSetting();
  if (setting && !setting.enabled) {
    throw new Error(portHint());
  }
}

function startCliAuto(projectPath, port) {
  const args = [
    'auto',
    '--project',
    projectPath,
    '--auto-port',
    String(port),
    '--trust-project',
  ];
  const child = spawn(electronExe, [cliScript, ...args], {
    // 与 cli.bat 一致：进程 cwd 是安装目录，项目目录放在 env.cwd。
    cwd: devtoolsDir,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      cwd: projectPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  autoLog = '';
  const append = (chunk) => {
    autoLog = (autoLog + chunk.toString('utf8')).slice(-16_000);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.on('error', (error) => {
    autoLog += `\n[spawn error] ${error.message}`;
  });
  return child;
}

async function connectWithRetry(wsEndpoint, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const mp = await automator.connect({ wsEndpoint });
      await mp.checkVersion();
      return mp;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw lastError || new Error(`连接自动化端口超时：${wsEndpoint}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pageInfo(page) {
  return page ? { path: page.path, query: page.query } : null;
}

async function pollCurrentPage(mp, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const page = await mp.currentPage();
      if (page) return pageInfo(page);
    } catch {
      // 页面尚未准备好
    }
    await sleep(400);
  }
  return null;
}

/**
 * Check whether the current WebSocket still answers a page query.
 *
 * @returns {Promise<{
 *   connected: boolean,
 *   alive: boolean,
 *   currentPage?: { path: string, query: object }|null,
 *   error?: string
 * }>}
 */
export async function probeSession() {
  if (!miniProgram) {
    return { connected: false, alive: false };
  }
  try {
    const page = await miniProgram.currentPage();
    return { connected: true, alive: true, currentPage: pageInfo(page) };
  } catch (error) {
    return {
      connected: true,
      alive: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Snapshot of the process-local automation session.
 *
 * @returns {{
 *   connected: boolean,
 *   projectPath: string|null,
 *   port: number,
 *   connectedAt: string|null,
 *   autoCliRunning: boolean,
 *   autoLogTail: string
 * }}
 */
export function getSessionState() {
  return {
    connected: Boolean(miniProgram),
    projectPath: currentProject,
    port: currentPort,
    connectedAt,
    autoCliRunning: Boolean(autoChild && autoChild.exitCode === null),
    autoLogTail: tail(autoLog, 2000),
  };
}

/**
 * Return the connected MiniProgram instance or throw a user-facing error.
 *
 * @returns {import('miniprogram-automator/out/MiniProgram').default}
 */
export function requireMiniProgram() {
  if (!miniProgram) {
    throw new Error(
      '尚未连接小程序自动化。请先调用 wdt_auto_start，或 wdt_auto_connect。'
    );
  }
  return miniProgram;
}

/**
 * Start or reuse automation for a project.
 *
 * Default behavior reuses a live session (and a live port) to avoid tearing
 * down an existing debugger. `restart` closes the previous project window,
 * waits for its automation port to close, then starts a fresh `cli auto`.
 *
 * @param {{
 *   projectPath?: string,
 *   port?: number,
 *   timeoutMs?: number,
 *   restart?: boolean
 * }} [options]
 * @returns {Promise<object>} Session state plus project/currentPage metadata.
 */
export async function startAutomation({
  projectPath,
  port,
  timeoutMs,
  restart = false,
} = {}) {
  const project = resolveProject(projectPath);
  const selectedPort = Number(port || defaultPort);
  const requestedPath = project.projectPath;
  const budget = Math.min(Number(timeoutMs) || 45_000, 45_000);
  const startedAt = Date.now();

  if (!restart) {
    if (miniProgram) {
      const probe = await probeSession();
      if (probe.alive) {
        if (currentProject && currentProject !== requestedPath) {
          throw new Error(
            `当前已连接到另一个项目：${currentProject}。要切换项目请传 restart=true，或换一个自动化端口。`
          );
        }
        return {
          ...getSessionState(),
          reused: true,
          project,
          currentPage: probe.currentPage,
          warning: currentProject ? undefined : '复用了已有自动化连接；实际项目未记录。',
        };
      }
      await disconnectAutomation({ closeProject: false });
    }

    if (await isPortOpen(selectedPort)) {
      try {
        miniProgram = await connectWithRetry(
          `ws://127.0.0.1:${selectedPort}`,
          Math.min(timeoutMs || 10_000, 10_000)
        );
        currentPort = selectedPort;
        if (currentProject && currentProject !== requestedPath) {
          try {
            await miniProgram.disconnect();
          } catch {}
          miniProgram = null;
          throw new Error(
            `端口 ${selectedPort} 上的自动化连接属于另一个项目：${currentProject}。请换端口或先关闭该项目。`
          );
        }
        if (!currentProject) currentProject = requestedPath;
        connectedAt = new Date().toISOString();
        const page = await pollCurrentPage(miniProgram, 8000);
        return {
          ...getSessionState(),
          reused: true,
          project,
          currentPage: page,
          warning: '端口已开启，复用了现有自动化连接，未重复启动 IDE。',
        };
      } catch (error) {
        if (/另一个项目|属于另一个项目/.test(error.message)) throw error;
        try {
          if (miniProgram) await miniProgram.disconnect();
        } catch {}
        miniProgram = null;
      }
    }
  }

  assertServicePort();
  const previousProject = currentProject;
  await disconnectAutomation({ closeProject: false });

  if (restart && (await isPortOpen(selectedPort))) {
    if (previousProject) {
      await runCli(['close', '--project', previousProject], {
        timeoutMs: 60_000,
      });
    }
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && (await isPortOpen(selectedPort))) {
      await sleep(400);
    }
    if (await isPortOpen(selectedPort)) {
      throw new Error(
        `端口 ${selectedPort} 仍被占用。请手动关闭对应的项目窗口，或改用其他自动化端口。`
      );
    }
  }

  currentProject = requestedPath;
  currentPort = selectedPort;
  await ensureIdeRunning({
    timeoutMs: Math.min(30_000, Math.max(10_000, budget - 5000)),
  });
  await clearStaleIdeState({ force: restart });
  autoChild = startCliAuto(requestedPath, selectedPort);

  // The budget covers IDE startup as well; do not restart the full clock here.
  const remainingForPort = Math.max(5000, budget - (Date.now() - startedAt));
  const opened = await waitForPort(selectedPort, remainingForPort);
  if (!opened) {
    const log = tail(autoLog, 4000);
    if (autoChild && autoChild.exitCode === null) autoChild.kill();
    autoChild = null;
    throw new Error(
      `自动化端口 ${selectedPort} 未启动。${
        log ? `\nCLI 输出：\n${log}` : '\nCLI 没有输出。'
      }\n\n${portHint()}`
    );
  }

  const remaining = Math.max(5000, budget - (Date.now() - startedAt));
  try {
    miniProgram = await connectWithRetry(`ws://127.0.0.1:${selectedPort}`, remaining);
  } catch (error) {
    if (autoChild && autoChild.exitCode === null) autoChild.kill();
    autoChild = null;
    throw new Error(
      `连接 ws://127.0.0.1:${selectedPort} 失败：${error.message}\n\n${
        autoLog ? `CLI 输出：\n${tail(autoLog, 4000)}` : ''
      }`
    );
  }

  connectedAt = new Date().toISOString();
  const page = await pollCurrentPage(miniProgram, 10_000);

  return {
    ...getSessionState(),
    reused: false,
    project,
    currentPage: page,
  };
}

/**
 * Connect to an already-running automation endpoint without launching the IDE.
 *
 * @param {{ wsEndpoint?: string, timeoutMs?: number }} [options]
 * @returns {Promise<object>} Session state plus `currentPage`.
 */
export async function connectAutomation({ wsEndpoint, timeoutMs } = {}) {
  const endpoint = wsEndpoint || `ws://127.0.0.1:${currentPort || defaultPort}`;
  await disconnectAutomation({ closeProject: false });
  miniProgram = await connectWithRetry(endpoint, timeoutMs || 30_000);
  currentProject = null;
  currentPort = Number(new URL(endpoint).port || defaultPort);
  connectedAt = new Date().toISOString();
  const page = await pollCurrentPage(miniProgram, 5000);
  return { ...getSessionState(), wsEndpoint: endpoint, currentPage: page };
}

/**
 * Disconnect the WebSocket and optionally close the project window.
 *
 * The IDE stays running either way. The CLI child is killed to avoid orphaning
 * a stale process; the automation port may remain open until the project
 * window closes.
 *
 * @param {{ closeProject?: boolean }} [options]
 * @returns {Promise<{
 *   projectPath: string|null,
 *   port: number,
 *   connected: boolean
 * }>} Previous session metadata.
 */
export async function disconnectAutomation({ closeProject = false } = {}) {
  const previous = {
    projectPath: currentProject,
    port: currentPort,
    connected: Boolean(miniProgram),
  };
  if (miniProgram) {
    try {
      if (closeProject) {
        await miniProgram.close();
      } else {
        await miniProgram.disconnect();
      }
    } catch {
      // 连接已断时忽略
    }
    miniProgram = null;
  }
  if (autoChild) {
    try {
      if (autoChild.exitCode === null) autoChild.kill();
    } catch {
      // 忽略
    }
    autoChild = null;
  }
  currentProject = null;
  connectedAt = null;
  return previous;
}
