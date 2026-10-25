/**
 * Runtime helpers shared by the MCP server and the regression scripts.
 *
 * Responsibilities:
 * - resolve WeChat DevTools paths and environment variables;
 * - run the official CLI in the exact way its `cli.bat` does;
 * - detect and recover the stale `Default/.ide` port file left after a quit;
 * - start the IDE as a normal GUI process before handing control to the CLI;
 * - classify CLI output that exits 0 while printing an error object.
 *
 * The CLI must run with the DevTools install directory as process cwd. It
 * starts `./微信开发者工具.exe` using a relative path internally; the selected
 * mini program project is passed through `env.cwd`, mirroring `cli.bat`.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const devtoolsDir =
  process.env.WECHAT_DEVTOOLS_DIR ||
  'C:\\Program Files (x86)\\Tencent\\微信web开发者工具';

export const electronExe =
  process.env.WECHAT_DEVTOOLS_ELECTRON || path.join(devtoolsDir, '微信开发者工具.exe');

export const cliScript =
  process.env.WECHAT_DEVTOOLS_CLI_JS ||
  path.join(
    devtoolsDir,
    'resources',
    'app.asar.unpacked',
    'js',
    'common',
    'cli',
    'index.js'
  );

export const defaultProject = process.env.WECHAT_DEVTOOLS_PROJECT || '';

export const defaultPort = Number(process.env.WECHAT_DEVTOOLS_AUTOMATION_PORT || 9420);

export const outputDir =
  process.env.WECHAT_DEVTOOLS_MCP_OUTPUT_DIR || path.join(__dirname, '..', 'output');

export const allowUpload = process.env.WECHAT_DEVTOOLS_MCP_ALLOW_UPLOAD === '1';

export const allowSkipPortCheck =
  process.env.WECHAT_DEVTOOLS_SKIP_SERVICE_PORT_CHECK === '1';

/**
 * Validate and describe a mini program project directory.
 *
 * @param {string} [projectPath] Absolute or relative project path. Falls back
 *   to `WECHAT_DEVTOOLS_PROJECT`.
 * @returns {{
 *   projectPath: string,
 *   configPath: string,
 *   appid: string|null,
 *   projectname: string|null,
 *   compileType: string|null
 * }}
 * @throws {Error} When the path is missing or has no `project.config.json`.
 */
export function resolveProject(projectPath) {
  const selected = projectPath || defaultProject;
  if (!selected) {
    throw new Error(
      '缺少 projectPath：请传入小程序项目目录，或设置 WECHAT_DEVTOOLS_PROJECT 环境变量。'
    );
  }
  const resolved = path.resolve(selected);
  if (!fs.existsSync(resolved)) {
    throw new Error(`项目目录不存在：${resolved}`);
  }
  const configPath = path.join(resolved, 'project.config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(`不是小程序项目（缺少 project.config.json）：${resolved}`);
  }
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    // 继续，配置解析失败不影响打开项目
  }
  return {
    projectPath: resolved,
    configPath,
    appid: config.appid || null,
    projectname: config.projectname || null,
    compileType: config.compileType || null,
  };
}

function appendLimited(current, chunk, limit = 2 * 1024 * 1024) {
  if (current.length >= limit) return current;
  return (current + chunk.toString('utf8')).slice(0, limit);
}

/**
 * 通过 Electron 的 node 模式直接运行官方 CLI，避免 .bat 在 Node 24 下的
 * EINVAL 问题，也避免 cmd.exe 的引号注入。
 */
/**
 * Run the official DevTools CLI through its Electron executable in Node mode.
 *
 * Why not `cli.bat`?
 * - Node 24 rejects direct `.bat` spawn with EINVAL.
 * - `cmd.exe /c` would expose project paths to cmd quoting/injection rules.
 *
 * @param {string[]} args CLI arguments, e.g. `['open', '--project', path]`.
 * @param {{ cwd?: string, timeoutMs?: number }} [options] Project cwd and
 *   timeout. The process cwd is always the DevTools install directory.
 * @returns {Promise<{
 *   code: number,
 *   stdout: string,
 *   stderr: string,
 *   timedOut: boolean,
 *   timeoutMs: number
 * }>}
 */
export async function runCli(args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const projectCwd = options.cwd || process.cwd();
  // CLI 内部会用相对路径启动 ./微信开发者工具.exe，必须从安装目录运行；
  // 项目目录通过 env.cwd 传给 CLI（与官方 cli.bat 的行为一致）。
  const spawnCwd = path.dirname(electronExe);

  const isHelp = args.some((arg) =>
    ['-h', '--help', '--version', '-v'].includes(String(arg))
  );
  if (!isHelp) {
    await clearStaleIdeState();
  }

  return new Promise((resolve, reject) => {
    if (!fs.existsSync(electronExe)) {
      reject(new Error(`找不到微信开发者工具：${electronExe}`));
      return;
    }
    if (!fs.existsSync(cliScript)) {
      reject(new Error(`找不到开发者工具 CLI：${cliScript}`));
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const child = spawn(electronExe, [cliScript, ...args], {
      cwd: spawnCwd,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        cwd: projectCwd,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    child.stdout.on('data', (chunk) => {
      stdout = appendLimited(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = appendLimited(stderr, chunk);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, timeoutMs });
    });
  });
}

/**
 * Probe whether a TCP port accepts connections.
 *
 * @param {number} port
 * @param {string} [host]
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
export function isPortOpen(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
    socket.setTimeout(timeoutMs);
  });
}

/**
 * Wait until a TCP port opens.
 *
 * @param {number} port
 * @param {number} [timeoutMs]
 * @param {number} [intervalMs]
 * @returns {Promise<boolean>} `true` if the port opened before the deadline.
 */
export async function waitForPort(port, timeoutMs = 60_000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortOpen(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

/**
 * 读取开发者工具“设置 → 安全设置”中的服务端口开关。
 * 只读，不修改任何配置文件。
 */
/**
 * Read WeChat DevTools security settings from its local storage mirror.
 *
 * `security.port` can lag behind the real IDE port; use {@link readIdeState}
 * when the actual port matters.
 *
 * @returns {{
 *   enabled: boolean,
 *   port: number|null,
 *   allowGetTicket: boolean,
 *   trustWhenAuto: boolean,
 *   file: string,
 *   defaultDir: string
 * }|null}
 */
export function readServicePortSetting() {
  const userDataRoot = path.join(
    process.env.LOCALAPPDATA || '',
    '微信开发者工具',
    'User Data'
  );
  if (!fs.existsSync(userDataRoot)) return null;

  let hashDirs = [];
  try {
    hashDirs = fs
      .readdirSync(userDataRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(userDataRoot, entry.name));
  } catch {
    return null;
  }

  for (const hashDir of hashDirs) {
    const localDataDir = path.join(hashDir, 'WeappLocalData');
    if (!fs.existsSync(localDataDir)) continue;
    let files = [];
    try {
      files = fs
        .readdirSync(localDataDir)
        .filter((name) => /^localstorage_.*\.json$/i.test(name));
    } catch {
      continue;
    }
    for (const name of files) {
      const file = path.join(localDataDir, name);
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (parsed && typeof parsed.security === 'object' && parsed.security) {
          return {
            enabled: Boolean(parsed.security.enableServicePort),
            port: parsed.security.port ?? null,
            allowGetTicket: Boolean(parsed.security.allowGetTicket),
            trustWhenAuto: Boolean(parsed.security.trustWhenAuto),
            file,
            defaultDir: path.join(hashDir, 'Default'),
          };
        }
      } catch {
        // 忽略损坏或非 JSON 的 localstorage 文件
      }
    }
  }
  return null;
}

/**
 * 读取 IDE 实际监听端口（Default/.ide）与状态（.ide-status）。
 * 注意：localstorage 里的 security.port 可能落后于实际端口。
 */
/**
 * Read the real IDE HTTP port from `Default/.ide` and its status file.
 *
 * @returns {{
 *   defaultDir: string,
 *   ideFile: string,
 *   statusFile: string,
 *   present: boolean,
 *   port: number|null,
 *   status: string|null
 * }|null}
 */
export function readIdeState() {
  const setting = readServicePortSetting();
  const defaultDir = setting?.defaultDir;
  if (!defaultDir) return null;
  const ideFile = path.join(defaultDir, '.ide');
  const statusFile = path.join(defaultDir, '.ide-status');
  let port = null;
  let status = null;
  try {
    if (fs.existsSync(ideFile)) {
      const value = fs.readFileSync(ideFile, 'utf8').trim();
      if (/^\d+$/.test(value)) port = Number(value);
    }
  } catch {}
  try {
    if (fs.existsSync(statusFile)) {
      status = fs.readFileSync(statusFile, 'utf8').trim();
    }
  } catch {}
  return {
    defaultDir,
    ideFile,
    statusFile,
    present: fs.existsSync(ideFile),
    port,
    status,
  };
}

/**
 * 微信开发者工具退出后有时会留下 .ide（HTTP 端口）和 .ide-status=On，
 * 下一次 CLI 会误以为 IDE 还在运行，等待旧端口直到超时。
 * 仅在端口确实关闭且状态文件已有一段时间时备份并清理。
 */
export async function clearStaleIdeState({ force = false } = {}) {
  if (process.env.WECHAT_DEVTOOLS_NO_STALE_CLEANUP === '1') return null;
  const setting = readServicePortSetting();
  const defaultDir = setting?.defaultDir;
  if (!defaultDir) return null;

  const ideFile = path.join(defaultDir, '.ide');
  const statusFile = path.join(defaultDir, '.ide-status');
  if (!fs.existsSync(ideFile)) return null;

  let idePort = null;
  try {
    const value = fs.readFileSync(ideFile, 'utf8').trim();
    if (/^\d+$/.test(value)) idePort = Number(value);
  } catch {
    return null;
  }
  if (!idePort) return null;
  if (await isPortOpen(idePort)) return null;

  if (!force) {
    try {
      const age = Date.now() - fs.statSync(ideFile).mtimeMs;
      if (age < 15_000) return null;
    } catch {
      return null;
    }
  }

  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .replace('Z', '');
  try {
    fs.copyFileSync(ideFile, `${ideFile}.stale-${stamp}`);
    fs.unlinkSync(ideFile);
    fs.writeFileSync(statusFile, 'Off');
    return { cleared: true, idePort, backup: `${ideFile}.stale-${stamp}` };
  } catch (error) {
    return { cleared: false, idePort, error: error.message };
  }
}

/**
 * Keep only the trailing part of a CLI log.
 *
 * @param {string} text
 * @param {number} [length]
 * @returns {string}
 */
export function tail(text, length = 4000) {
  if (!text) return '';
  return text.length > length ? text.slice(-length) : text;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Make sure the IDE is running as a normal GUI process.
 *
 * Starting the IDE through the CLI on a cold machine can race the security
 * setting load and produce “IDE service port disabled”. Starting the GUI first
 * and waiting for `Default/.ide` to accept connections avoids that race.
 *
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ started: boolean, port: number, status: string|null }>}
 * @throws {Error} When the IDE does not expose its HTTP port in time.
 */
export async function ensureIdeRunning({ timeoutMs = 40_000 } = {}) {
  const existing = readIdeState();
  if (existing?.port && (await isPortOpen(existing.port))) {
    return { started: false, ...existing };
  }

  // .ide 存在但端口暂时没起来：可能是 IDE 正在启动，先等一会再判定。
  if (existing?.present) {
    const probeDeadline = Date.now() + 10_000;
    while (Date.now() < probeDeadline) {
      const state = readIdeState();
      if (state?.port && (await isPortOpen(state.port))) {
        return { started: false, ...state };
      }
      await sleep(500);
    }
    await clearStaleIdeState({ force: true });
  }

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronExe, [], {
    cwd: path.dirname(electronExe),
    env,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = readIdeState();
    if (state?.port && (await isPortOpen(state.port))) {
      return { started: true, ...state };
    }
    await sleep(500);
  }
  throw new Error(
    `启动微信开发者工具超时（${timeoutMs} ms）。请手动打开开发者工具后再试。`
  );
}

function normalizePagePath(value) {
  return String(value || '')
    .trim()
    .replace(/^\/+/, '')
    .replace(/[?#].*$/, '');
}

/**
 * 读取 app.json 的页面声明，用于在跳转失败时给出可读提示。
 * 文件缺失或解析失败时返回 null，不阻塞调用。
 */
/**
 * Read page and tabBar declarations from `app.json`.
 *
 * Used only to turn opaque automation errors into actionable messages; a
 * missing or invalid app.json returns `null` and never blocks a call.
 *
 * @param {string|null} projectPath
 * @returns {{
 *   pages: string[],
 *   subPages: string[],
 *   tabBar: string[],
 *   all: string[]
 * }|null}
 */
export function readAppPages(projectPath) {
  if (!projectPath) return null;
  const appJson = path.join(projectPath, 'app.json');
  if (!fs.existsSync(appJson)) return null;
  try {
    const config = JSON.parse(fs.readFileSync(appJson, 'utf8'));
    const pages = (config.pages || []).map(normalizePagePath);
    const subPackages = config.subPackages || config.subpackages || [];
    const subPages = subPackages.flatMap((subPackage) => {
      const root = normalizePagePath(subPackage.root || '');
      return (subPackage.pages || []).map((page) =>
        normalizePagePath(root ? `${root}/${page}` : page)
      );
    });
    const tabBar = (config.tabBar?.list || []).map((item) =>
      normalizePagePath(item.pagePath)
    );
    return {
      pages,
      subPages,
      tabBar,
      all: [...new Set([...pages, ...subPages])],
    };
  } catch {
    return null;
  }
}

/**
 * Detect CLI failures that still exit with code 0.
 *
 * The DevTools CLI prints `[error] { code, message }` objects for several
 * AppID/npm/login failures while returning success.
 *
 * @param {{ code: number, stdout: string, stderr: string, timedOut: boolean }} result
 * @returns {boolean}
 */
export function cliLooksErrored(result) {
  const raw = `${result.stdout || ''}\n${result.stderr || ''}`;
  return (
    Boolean(result.timedOut) ||
    result.code !== 0 ||
    /\[error\]/i.test(raw) ||
    /__NO_NODE_MODULES__/.test(raw) ||
    /\bNO_NODE_MODULES\b/.test(raw)
  );
}

/**
 * Turn a DevTools CLI error dump into one readable line.
 *
 * Handles known classifications (npm, AppID, login) before falling back to the
 * first `message:` field or `[error]` line.
 *
 * @param {{ code: number, stdout: string, stderr: string, timedOut: boolean, timeoutMs?: number }} result
 * @returns {string|null}
 */
export function cliErrorSummary(result) {
  const raw = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (/__NO_NODE_MODULES__|NO_NODE_MODULES/.test(raw)) {
    return '项目里没有可供构建的 npm 依赖（未找到 node_modules）。';
  }
  if (/不存在此 ?AppID|invalid appid/i.test(raw)) {
    return 'AppID 无效或未注册（touristappid 不能用于构建/上传），请改用真实 AppID。';
  }
  if (/not\s*login|未登录|请先登录/i.test(raw)) {
    return '开发者工具未登录；请先调用 wdt_login 扫码。';
  }
  if (result.timedOut) {
    return `CLI 执行超时（${result.timeoutMs || '未知'} ms）。`;
  }
  const messageMatch = raw.match(/message:\s*(['"])([\s\S]*?)\1/);
  if (messageMatch) {
    const message = messageMatch[2]
      .replace(/\\n['"]?\s*\+?/g, ' ')
      .replace(/\\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (message) return message.slice(0, 500);
  }
  if (/\[error\]/i.test(raw)) {
    const line = raw
      .split(/\r?\n/)
      .find((item) => /\[error\]|Error:|错误/.test(item) && item.trim() !== '[error] {');
    return (line || '')
      .replace(/^\[error\]\s*/i, '')
      .replace(/\s+/g, ' ')
      .slice(0, 500);
  }
  return result.code === 0 ? null : `CLI 退出码 ${result.code}`;
}

/**
 * Create the screenshot/preview output directory if needed.
 *
 * @returns {string} Absolute output directory.
 */
export function ensureOutputDir() {
  fs.mkdirSync(outputDir, { recursive: true });
  return outputDir;
}
