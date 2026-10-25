# WeChat DevTools MCP

Local MCP server that lets an AI agent drive WeChat DevTools on Windows: the official CLI for project operations, and the official mini program automation SDK for simulator control.

把微信开发者工具接到 AI 的本地 MCP 服务。控制面分两层：

- **官方 CLI**：打开项目、关闭项目、退出 IDE、登录、预览、构建 npm、上传（默认禁用）。
- **官方自动化 SDK**：连接模拟器，做页面跳转、元素查询/点击/输入、截图、`evaluate`、调用 `wx` API、原生弹窗操作。

不使用改包、注入或私有协议。实现只依赖官方 CLI、`miniprogram-automator` 和本地进程管理。

## 环境要求

- Windows，已安装微信开发者工具。默认路径：
  `C:\Program Files (x86)\Tencent\微信web开发者工具`
- Node.js >= 20。
- 开发者工具里开启 **设置 → 安全设置 → 服务端口（CLI/HTTP 调用）**。自动化必需。
- 预览、上传需要开发者工具已登录。
- `touristappid` 只能用于本地模拟器自动化；CLI 的 open/build-npm/preview 需要真实 AppID。

## 安装

```bash
git clone https://github.com/sdjvhbuw/wechat-devtools-mcp.git
cd wechat-devtools-mcp
npm install
npm start
```

MCP 走 stdio，日志只写 stderr，不会污染协议输出。

## 项目结构

```text
src/runtime.js       路径、CLI 调用、IDE 端口检测、残留状态清理
src/session.js       自动化连接生命周期、复用/重启、页面轮询
src/server.js        MCP 工具注册与参数校验
scripts/e2e.js       模拟器自动化回归
scripts/cli-e2e.js   open/close/preview/quit/恢复回归
scripts/smoke.js     最小联调脚本
test-fixtures/       测试用小程序（touristappid）
```

### 环境变量

| 变量                                      | 作用                                          | 默认                                               |
| ----------------------------------------- | --------------------------------------------- | -------------------------------------------------- |
| `WECHAT_DEVTOOLS_DIR`                     | 开发者工具安装目录                            | `C:\Program Files (x86)\Tencent\微信web开发者工具` |
| `WECHAT_DEVTOOLS_PROJECT`                 | 默认小程序项目目录                            | 空                                                 |
| `WECHAT_DEVTOOLS_AUTOMATION_PORT`         | 自动化端口                                    | `9420`                                             |
| `WECHAT_DEVTOOLS_MCP_OUTPUT_DIR`          | 截图输出目录                                  | `<repo>/output`                                    |
| `WECHAT_DEVTOOLS_MCP_ALLOW_UPLOAD`        | 设为 `1` 才允许上传工具                       | 未设置                                             |
| `WECHAT_DEVTOOLS_SKIP_SERVICE_PORT_CHECK` | 设为 `1` 跳过预检查                           | 未设置                                             |
| `WECHAT_DEVTOOLS_NO_STALE_CLEANUP`        | 设为 `1` 禁止清理退出后残留的 `.ide` 端口文件 | 未设置                                             |

CLI 需要 token 时用 `WECHAT_DEVTOOLS_CLI_TOKEN`（不通过工具参数传递）。

## 接入 MCP 客户端

Qoder、Claude Desktop、Cursor、Codex 等客户端都使用同样的 stdio 配置。把路径换成仓库的实际绝对路径：

```json
{
  "mcpServers": {
    "wechat-devtools": {
      "command": "node",
      "args": ["C:/path/to/wechat-devtools-mcp/src/server.js"],
      "env": {
        "WECHAT_DEVTOOLS_PROJECT": "C:/path/to/your-miniprogram",
        "WECHAT_DEVTOOLS_AUTOMATION_PORT": "9420"
      }
    }
  }
}
```

Qoder 写在 `~/.qoder/settings.json`，其他客户端按各自文档放到对应位置。修改后重启客户端或重载 MCP。

## 启动与退出恢复

- 调用 open / login / preview / build-npm / auto_start 前，先确保 IDE 以正常 GUI 方式启动，再交给 CLI，避免 CLI 冷启动时抢在服务端口就绪之前检查。
- 开发者工具退出后可能残留 `Default/.ide` 和 `.ide-status=On`，导致 CLI 一直等待旧端口。检测到端口已关闭且文件超过 15 秒未更新时，会备份为 `.ide.stale-<时间>` 并清理，同时把状态写为 `Off`。
- `wdt_quit` 会等待实际 `.ide` 端口关闭（最多 40 秒），然后清理残留。
- 不想让 MCP 动这些状态文件时设 `WECHAT_DEVTOOLS_NO_STALE_CLEANUP=1`。
- 手动改过安全设置后，可先用 `wdt_status` 看 `ide.portOpen` 和 `servicePort`。

## 工具

### 环境与 CLI

- `wdt_status`：工具路径、服务端口开关、自动化连接、端口占用。
- `wdt_open` / `wdt_close_project` / `wdt_quit`：打开、关闭项目、退出 IDE。`wdt_quit` 会等待 IDE 端口关闭（最多 40 秒）。
- `wdt_login` / `wdt_is_login`：触发扫码登录 / 检查登录状态。
- `wdt_preview`：生成预览二维码（terminal/image/base64）。image/base64 未给路径时自动写入 output。
- `wdt_build_npm`：构建 npm；失败时返回 `ok=false` 和可读 `hint`。
- `wdt_upload`：上传版本。默认禁用，需环境变量 + `confirm=true`。

### 自动化

- `wdt_auto_start`：启动并连接自动化端口。默认复用已有连接；`restart=true` 强制重启。总预算默认 45 秒。
- `wdt_auto_connect` / `wdt_disconnect`：连接已有端口 / 断开。
- `wdt_current_page`：当前页面与页面栈。
- `wdt_navigate`：navigateTo / redirectTo / reLaunch / switchTab / navigateBack；默认按 `app.json` 校验页面，动态页面可传 `validate=false`。
- `wdt_query`：按 CSS 选择器查询元素摘要。
- `wdt_element`：tap、input、text、attribute、wxml、trigger、scrollTo、scrollWidth/Height、swipeTo、slideTo、callMethod 等动作。`slideTo` 会补发 change 事件。
- `wdt_wait`：等待选择器或毫秒数（最长 60 秒）。
- `wdt_page_data`：读取/修改页面 data，或调用页面方法（SDK 调用失败时自动用 evaluate 回退）。
- `wdt_screenshot`：模拟器截图，返回 PNG 路径。
- `wdt_evaluate`：执行表达式/语句/函数；表达式自动包成函数，可用 `$args` 访问参数。
- `wdt_wx_method`：调用 `wx` API。
- `wdt_native`：goHome、确认/取消弹窗、授权、分享等原生动作。
- `wdt_system_info`：`systemInfo()`。

## 联调

```bash
node scripts/smoke.js "C:/path/to/your-miniprogram"
```

脚本会依次执行：状态检查 → 启动自动化 → 当前页面 → 查询 `view` → 截图 → 断开。任何一步失败都会返回 CLI 输出，便于定位服务端口或登录问题。

回归测试：

```bash
npm run test:e2e   # 52 项：输入/点击/滑动/滚动/跳转/求值/错误路径
npm run test:cli   # open/close/preview/build/quit/恢复
```

`test:cli` 会退出并重新拉起 IDE，运行前保存好未提交的工作。open/preview 需要真实 AppID，用环境变量提供你自己的小程序项目；未提供时相关用例标记为 SKIP：

```bash
# PowerShell
$env:WECHAT_DEVTOOLS_TEST_USER_PROJECT="C:/path/to/your-miniprogram"
npm run test:cli
```

测试用小程序在 `test-fixtures/miniprogram`，只用于模拟器自动化。

## 安全边界

- `wdt_upload` 默认不可用，避免 AI 误发布；需要显式设置环境变量并传 `confirm=true`。
- `wdt_quit`、`wdt_close_project`、`wdt_upload` 标记为 destructive；调用前应确认。
- `wdt_evaluate` 和 `wdt_wx_method` 属于本地任意执行能力，只在可信项目中使用。
- MCP 只监听 stdio，不开放网络端口；请不要把 `wdt_evaluate` 暴露给不可信输入。
- 本项目只操作微信开发者工具及其模拟器，不控制微信客户端本身。

## 已知限制

- 仅支持 Windows。
- 只覆盖“项目 + 模拟器”两层；IDE 自身的菜单、设置面板等界面级操作未实现。
- `wdt_preview` / `wdt_upload` 需要开发者工具已登录；`touristappid` 不能用于 CLI 的 open/build/preview。
- 微信开发者工具升级后，CLI 参数或自动化协议可能变化；请先跑 `npm run test:e2e`。

## 版本管理

版本号遵循 SemVer，变更记录见 [CHANGELOG.md](CHANGELOG.md)。发布前建议：

```bash
npm run check
npm run format:check
npm run test:e2e
```

## License

[MIT](LICENSE)
