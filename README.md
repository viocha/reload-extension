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

CLI 首次连接浏览器时可能触发 Remote Debugging 授权。连接脚本会处理授权并复用后续 session，不关闭现有浏览器或标签页。

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
