# 独立 GitHub Pages 宿主仓库（B）

把本目录**根下的全部内容**推到一个 **public** 的空仓库（或首次提交即包含这些文件），用于 **Actions + deploy-pages** 发布 `site/` 目录。

## 一次性设置（仓库 B）

1. 在 GitHub 新建 public 仓库，例如 `yourname/splashparty-pages`。
2. 将 `external-pages-host/` 里的文件拷到该仓库根目录（保留 `.github/` 与 `site/`），`git push` 到 `main`。
3. **Settings → Pages → Build and deployment → Source** 选 **GitHub Actions**。
4. 在 **Settings → Environments → github-pages** 若有审批规则，按需放行或关闭。

**默认分支**：当前约定宿主仓默认分支为 **`main`**。若 B 使用其他默认分支，请同时修改 **A** 的 `.github/workflows/pages.yml` 里 JamesIves 的 `branch:`，以及 **B** 本 workflow 的 `push.branches`。

## 连接源码仓库（A = SplashParty）

在 **A** 上配置：

| 类型 | 名称 | 说明 |
|------|------|------|
| Repository variable | `PAGES_DEPLOY_REPOSITORY` | 填 `owner/repo-b`（宿主仓库全名） |
| Secret | `PAGES_DEPLOY_TOKEN` | Fine-grained PAT：仅对 **B** 授予 **Contents: Read and write**（及 Metadata） |

推送 **A** 的 `main` 后，`pages.yml` 会把构建好的 `web/` 同步到 **B** 的 `site/`，并触发 **B** 的 workflow 执行 `deploy-pages`。

若 **不** 设置 `PAGES_DEPLOY_REPOSITORY`，A 仍在本仓库内用 `upload-pages-artifact` + `deploy-pages` 发布（与原先行为一致）。
