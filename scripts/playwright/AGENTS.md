# 脚本归属

`chromium-connect.ps1` 和 `runtime-types.ps1` 是生成文件，唯一源码为 `SKILLS_REPO_DIR` 所指 skills 仓库中的同名 `shared/` 文件。只能修改上游，然后执行 `bun run sync:playwright`；禁止直接编辑生成文件或复制一份独立维护。上游未配置或任一文件不存在时必须报错，禁止回退使用本地产物。

`browser-session.ps1` 是 reload-extension 本项目维护的 worker 管理入口，不属于同步文件。
