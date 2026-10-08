# reload-extension

在 Windows 上通过 Playwright CLI 连接当前正在运行的 Chrome 或 Edge，并按名称重新加载 unpacked 浏览器扩展。

项目使用 TypeScript 开发，Bun 负责依赖管理、测试和构建，CLI 参数解析由 `commander` 提供。

## 安装

```powershell
bun install -g reload-extension
```

包直接依赖 `@playwright/cli`，运行时使用包内依赖，不要求全局安装 `@playwright/cli`。

运行时需要 Node.js，包内 Playwright CLI 由 Node.js 执行。Bun 用于开发、测试和构建。

## 使用

默认操作 Edge：

```powershell
reload-extension "Web Toolkit"
```

按名称重载成功后，名称与 ID 的映射保存到 `%LOCALAPPDATA%\reload-extension\cache`，有效期为 30 天。缓存按浏览器隔离，后续调用直接使用缓存 ID，跳过扩展列表查询。缓存 ID 不存在时自动重新按名称查找并更新映射；连接或权限错误直接报告。删除缓存目录可清除全部映射。

跳过缓存读取，重新按名称查找并在重载成功后更新缓存：

```powershell
reload-extension "Web Toolkit" --no-cache
```

清空 Chrome 和 Edge 的全部名称映射缓存并退出，不连接浏览器：

```powershell
reload-extension --clear-cache
```

`--clear-cache` 单独执行，不能与扩展名称、`--id`、`--list` 或 `--no-cache` 同时使用。

指定 Chrome：

```powershell
reload-extension "Web Toolkit" --browser chrome
```

列出扩展：

```powershell
reload-extension --list
reload-extension --list --browser chrome
```

已知 ID 时可以跳过名称查找：

```powershell
reload-extension --id ncekidoiekbflbbpoldpfldjnbccfmmm
```

CLI 连接浏览器时可能触发 Remote Debugging 授权，连接脚本会处理授权。查询或重载结束后会关闭对应 session，操作失败时也会清理连接。现有浏览器和标签页保持打开。

## API

```js
import { listExtensions, reloadExtension } from 'reload-extension';

const extensions = await listExtensions({ browser: 'edge' });
await reloadExtension({ name: 'Web Toolkit', browser: 'edge' });
```

`browser` 支持 `edge`、`msedge` 和 `chrome`，默认 `edge`。

API 传入 `cache: false` 可重新查询并更新缓存；`clearExtensionCache()` 清空全部名称映射缓存。

## 开发

安装依赖：

```powershell
bun install
```

直接运行 TypeScript CLI：

```powershell
bun run dev -- "Web Toolkit"
```

构建 npm 产物：

```powershell
bun run build
```

构建时可从 skills 仓库同步浏览器连接脚本。复制 `.env.example` 为 `.env`，设置 skills 仓库根目录：

```dotenv
SKILLS_REPO_DIR=D:/IT/ai/skills
```

路径支持绝对路径或相对于本项目的路径。Bun 自动读取 `.env`，系统环境变量优先。配置后，`bun run build` 先同步共享脚本和 Playwright 连接脚本，再构建；也可通过 `bun run sync:playwright` 单独同步。未配置时使用仓库内的脚本快照，CI 无需本机 skills 目录。已配置的源文件缺失或结构不符合预期时，构建报错。

`scripts/playwright/` 的 `chromium-connect.ps1`、`connect-playwright-session.ps1` 和 `session-state.ps1` 由同步生成，应随代码提交。同步器适配项目内 CLI 与 core 依赖路径；`package-runtime.ps1` 解析包内依赖，`browser-session.ps1` 在单个 PowerShell 进程中完成连接、查询、重载和清理。会话按浏览器隔离（`reload-extension-edge`、`reload-extension-chrome`），并通过互斥锁串行处理同一浏览器的重载。更新连接逻辑时修改 skills 源文件，再执行构建。

扩展查询和重载使用浏览器级 CDP 的 `Extensions.getExtensions`、`Extensions.loadUnpacked`，需要支持这些协议方法的 Chromium 浏览器。工具等待 CDP 完成响应，独立会话将页面稳定等待设置为 0；普通页面自动化会话不受影响。

构建后的 CLI 和库入口位于：

```text
dist/cli.js
dist/index.js
dist/index.d.ts
```

## 发布

推送到 `main` 后，GitHub Actions 会测试、构建并查询 npm 上的最新版本。本地 `package.json` 版本与线上版本一致时跳过发布；版本不同或包尚不存在时执行 `npm publish`。

仓库需要配置 Actions Secret：

```text
NPM_TOKEN
```

## 要求

- Windows
- Node.js 20.19+ / 22.12+ / 23+
- Chrome 或 Microsoft Edge
