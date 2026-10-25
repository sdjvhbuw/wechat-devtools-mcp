#!/usr/bin/env node
/**
 * Minimal end-to-end smoke test: status → auto start → current page → query →
 * screenshot → disconnect. Useful when setting up a new machine.
 *
 * Usage: node scripts/smoke.js "C:/path/to/your-miniprogram"
 */
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const projectPath = process.argv[2] || process.env.WECHAT_DEVTOOLS_PROJECT || '';
const port = Number(process.env.WECHAT_DEVTOOLS_AUTOMATION_PORT || 9420);

if (!projectPath) {
  console.error('用法: node scripts/smoke.js <小程序项目目录>');
  process.exit(2);
}

const env = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => typeof value === 'string')
);
env.WECHAT_DEVTOOLS_PROJECT = path.resolve(projectPath);
env.WECHAT_DEVTOOLS_AUTOMATION_PORT = String(port);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(process.cwd(), 'src', 'server.js')],
  cwd: process.cwd(),
  env,
  stderr: 'inherit',
});

const client = new Client({ name: 'wechat-devtools-smoke', version: '0.1.0' });

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
    throw new Error(`${name} failed: ${text}`);
  }
  return parsed;
};

try {
  await client.connect(transport);
  const tools = await client.listTools();
  console.log(`tools: ${tools.tools.length}`);

  const status = await call('wdt_status');
  console.log('status:', JSON.stringify(status, null, 2));

  const started = await call('wdt_auto_start', {
    projectPath: path.resolve(projectPath),
    port,
    timeoutMs: 90_000,
  });
  console.log('auto_start:', JSON.stringify(started, null, 2));

  const page = await call('wdt_current_page');
  console.log('current_page:', JSON.stringify(page, null, 2));

  const query = await call('wdt_query', {
    selector: 'view',
    all: true,
    max: 5,
  });
  console.log('query:', JSON.stringify(query, null, 2));

  const shot = await call('wdt_screenshot');
  console.log('screenshot:', JSON.stringify(shot, null, 2));

  await call('wdt_disconnect');
  console.log('SMOKE_OK');
} catch (error) {
  console.error('SMOKE_FAILED:', error.message);
  try {
    await call('wdt_disconnect');
  } catch {}
  process.exitCode = 1;
} finally {
  await client.close();
}
