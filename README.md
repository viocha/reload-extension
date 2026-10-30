# reload-extension

在 Windows 上通过 Playwright 浏览器级 CDP 连接当前正在运行的 Chrome 或 Edge，并按名称重新加载 unpacked 浏览器扩展。

项目使用 TypeScript 开发，Bun 负责依赖管理、测试和构建，CLI 参数解析由 `commander` 提供。

## 安装

```powershell
bun install -g reload-extension
```

包直接依赖 `playwright-core`，无需安装浏览器自动化 CLI。

运行时需要 Node.js，浏览器连接 worker 由 Node.js 执行。Bun 用于开发、测试和构建。

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

连接浏览器时可能触发 Remote Debugging 授权，授权脚本会处理提示。查询和重载共用 CDP 连接，每条命令最多等待 10 秒；操作完成或失败后断开连接。重载通过隐藏的扩展管理页调用浏览器正式重载接口，完成后关闭隐藏页，不切换当前标签页，不读取用户页面内容。

### 恢复扩展界面

重载默认恢复目标扩展已打开的标签页和正在显示的侧边栏，无需增加参数。例如，Web Toolkit 的 `chrome-extension://ncekidoiekbflbbpoldpfldjnbccfmmm/options.html` 设置页会在重载后重新打开。

- 标签页保留完整 URL（含查询参数和锚点）、窗口归属、顺序、固定、静音及激活状态；原窗口关闭时恢复到替代窗口。
- 同一 URL 的多个标签页分别恢复；浏览器或扩展自行重开的页面按数量复用。
- 当前窗口正在查看的常规扩展页优先恢复并激活，无需等待其他扩展页初始化；存活或扩展自行补建的当前页直接复用。
- 扩展接管的新标签页通过 `edge://newtab/` 或 `chrome://newtab/` 入口重新创建，保留真正新标签页的地址栏表现；新标签恢复位置和状态后关闭原标签，标签数量保持不变。
- 当前窗口正在查看扩展新标签页时，重载完成在原标签左侧新建并切换；其余新标签也插入各自原标签左侧，页面并发初始化，状态恢复及原标签批量清理在后台完成。
- 侧边栏在原窗口或原标签页重新打开，保留配置的页面路径；未显示的侧边栏不自动打开。

恢复的是页面入口和打开状态；未保存的表单、滚动位置等页面内临时状态由扩展自行持久化。重载失败时不执行恢复；重载成功但部分界面恢复失败时，命令明确报告失败项。

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

构建必须从 skills 上游仓库生成浏览器授权脚本。复制 `.env.example` 为 `.env`，设置 skills 仓库根目录：

```dotenv
SKILLS_REPO_DIR=D:/IT/ai/skills
```

路径支持绝对路径或相对于本项目的路径。Bun 自动读取 `.env`，系统环境变量优先。`bun run build` 先同步浏览器授权共享脚本，再构建；也可通过 `bun run sync:playwright` 单独同步。未配置上游路径或上游文件不存在时直接报错，即使本地已有生成文件也不能跳过同步。CI 拉取 skills 上游仓库并配置该路径。

`scripts/playwright/chromium-connect.ps1` 和 `runtime-types.ps1` 是从 skills 仓库的同名 `shared/` 文件生成的打包产物，由 Git 忽略；所有修改必须在上游完成，然后重新同步，禁止在本仓库复制或独立维护这些文件。发布包包含生成文件，安装后的用户无需上游仓库。授权、超时等待、窗口状态恢复和进程树清理由上游共享函数提供。`browser-session.ps1` 是本项目的 worker 管理及命令通信入口。`dist/browser-worker.js` 使用 `chromium.connectOverCDP` 直接连接当前浏览器。

扩展查询使用 `Extensions.getExtensions`，重载使用隐藏 `chrome://extensions/` 页面的 `chrome.developerPrivate.reload`，需要支持 `Extensions.getExtensions` 和隐藏 target 的 Chromium 浏览器。正式重载保留扩展的安装方式和配置，浏览器重启后持久安装的扩展会正常加载。

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
GH_TOKEN
NPM_TOKEN
```

`GH_TOKEN` 使用能访问私有 `viocha/skills` 仓库的 GitHub token；经典 PAT 需要 `repo` 权限。工作流通过该 Secret 拉取 skills 上游源码。`NPM_TOKEN` 用于发布 npm 包。

## 要求

- Windows
- Node.js 20.19+ / 22.12+ / 23+
- Chrome 或 Microsoft Edge
