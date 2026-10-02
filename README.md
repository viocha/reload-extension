# reload-extension

在 Windows 上通过 Chrome DevTools MCP 连接当前正在运行的 Chrome 或 Edge，并按名称重新加载 unpacked 浏览器扩展。

项目使用 TypeScript 开发，Bun 负责依赖管理、测试和构建，CLI 参数解析由 `commander` 提供。

## 安装

```powershell
npm install -g reload-extension
```

包直接依赖 `chrome-devtools-mcp`，运行时使用包内依赖，不要求全局安装 `chrome-devtools-mcp` 或 `chrome-devtools`。

## 使用

默认操作 Edge：

```powershell
reload-extension "Web Toolkit"
```

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

路径支持绝对路径或相对于本项目的路径。Bun 自动读取 `.env`，系统环境变量优先。配置后，`bun run build` 先同步共享脚本和 Chrome DevTools 连接脚本，再构建；也可通过 `bun run sync:devtools` 单独同步。未配置时使用仓库内的脚本快照，CI 无需本机 skills 目录。已配置的源文件缺失或结构不符合预期时，构建报错。

`scripts/devtools/` 中除 `package-runtime.ps1` 外的脚本均由同步生成，应随代码提交。同步器自动适配项目内 CLI 依赖路径和独立 session（Edge：`e10ad`，Chrome：`c10ad`）；`package-runtime.ps1` 提供 npm 包运行时的依赖解析。更新连接逻辑时修改 skills 源文件，再执行构建。

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
