# 看点什么 · DSH Message Console

面向个人的 DSH 消息聚合插件，在一个入口查看 GitHub 与 B站的变化、分析结果和待处理事项。

**版本：1.0.1** · [发布说明](docs/releases/v1.0.1.md) · [宣传视频（B站）](https://www.bilibili.com/video/BV1cpxc6qEuH/)

## 主要功能

- **GitHub**：汇总 issue、PR、release，核实问题、审查变更并给出处理建议。
- **B站**：汇总视频评论和私信；评论支持拟稿、独立监督及按来源授权自动回复，私信仅查看和评定重要程度。
- **阅读与处理**：变化提醒、重要性排序、搜索筛选、批量已读与已处理。
- **工作会话**：复用 DSH 模型、工具和真实会话历史，可回到原会话继续讨论。
- **评价学习**：根据个人评价提出提示词和文字配置修改，确认后生效。

## Quick start

需要 DSH `0.2.1` 系列（含 RC 与正式版）。在同一个 profile 中依次安装并启用 **Assembler → Jev → 看点什么**；已有且版本兼容的依赖直接复用。

| 安装顺序 | 仓库 | 安装包 |
| --- | --- | --- |
| 1. Assembler 1.1.3 | [dsh-prompt-assembler](https://github.com/Player-MINEPIG/dsh-prompt-assembler) | [下载 .tgz](https://github.com/Player-MINEPIG/dsh-prompt-assembler/releases/download/v1.1.3/dsh-prompt-assembler-1.1.3.tgz) |
| 2. Jev 0.3.6（本项目适配的 fork） | [dsh-jev-plugin](https://github.com/Player-MINEPIG/dsh-jev-plugin) | [下载固定版本源码包](https://codeload.github.com/Player-MINEPIG/dsh-jev-plugin/tar.gz/2ec0510ffcdabe790df8c93b0b40aee07b93c342)，保存为 `dsh-jev-plugin-0.3.6.tgz` |
| 3. 看点什么 1.0.1 | [dsh-message-console](https://github.com/Player-MINEPIG/dsh-message-console) | [Release 安装包](https://github.com/Player-MINEPIG/dsh-message-console/releases/tag/v1.0.1) |

### GUI 安装（官方桌面端与 Web）

1. 从 [DSH 官网](https://www.deepseek.com/harness/)安装官方桌面端并打开，无需另装 Node.js 或 pnpm。已有 Web Host 也可使用下面的插件页面。
2. 下载上表三个安装包。在左侧选择 **插件 → 添加插件**，输入 Assembler 安装包的**完整绝对路径**，例如 macOS 的 `/Users/你的用户名/Downloads/dsh-prompt-assembler-1.1.3.tgz` 或 Windows 的 `C:\Users\你的用户名\Downloads\dsh-prompt-assembler-1.1.3.tgz`，点击 **安装**。
3. 安装完成后点击 **立即启用**。同样依次安装、启用 Jev 和看点什么；每次只填一个包路径，已有依赖无需重装。
4. 如界面提示需要重启，等待在途工作结束后重启 Host；桌面端需完全退出后重新打开。在 **插件 → 已安装插件** 中确认三个插件已启用且无加载错误。

输入框只填安装来源，不粘贴整条命令。桌面端使用本机路径；远程 Web 使用 **Host 所在服务器**上的路径，需先上传安装包。桌面端与 Web 分别使用自己的 profile。

### CLI 安装（macOS / Linux）

需要 Node.js `^22.19.0 || >=24` 和 `curl`。尚未安装 DSH 时执行：

```sh
npm install -g '@deepseek-ai/dsh@>=0.2.1-0 <0.2.2-0'
```

先停止目标 Host。以下命令下载三个包并依次安装到 `web` profile；使用其他 profile 时修改 `dmc_profile=web`。下载目录需要保留，供后续包管理使用。需要从源码安装时，参见[源码构建步骤](docs/INSTALLATION.md#从源码构建)。

```sh
(
  dmc_profile=web
  set -eu
  dmc_packages="$PWD/dsh-message-console-packages-1.0.1"
  mkdir -p "$dmc_packages"
  curl -fL 'https://github.com/Player-MINEPIG/dsh-prompt-assembler/releases/download/v1.1.3/dsh-prompt-assembler-1.1.3.tgz' -o "$dmc_packages/dsh-prompt-assembler-1.1.3.tgz"
  curl -fL 'https://codeload.github.com/Player-MINEPIG/dsh-jev-plugin/tar.gz/2ec0510ffcdabe790df8c93b0b40aee07b93c342' -o "$dmc_packages/dsh-jev-plugin-0.3.6.tgz"
  curl -fL 'https://github.com/Player-MINEPIG/dsh-message-console/releases/download/v1.0.1/dsh-message-console-1.0.1.tgz' -o "$dmc_packages/dsh-message-console-1.0.1.tgz"
  dsh plugin --profile "$dmc_profile" add "$dmc_packages/dsh-prompt-assembler-1.1.3.tgz"
  dsh plugin --profile "$dmc_profile" add "$dmc_packages/dsh-jev-plugin-0.3.6.tgz"
  dsh plugin --profile "$dmc_profile" add "$dmc_packages/dsh-message-console-1.0.1.tgz"
)
```

安装完成后，以上默认 `web` profile 可这样启动：

```sh
dsh web
```

已有服务部署则按原方式启动。管理官方桌面端时，先打开一次桌面端以初始化 profile，再完全退出；使用桌面端提供的 `dsh` 命令，将 `dmc_profile` 改为 `desktop`，安装后重新打开桌面端。

### 首次使用

1. 按 [Jev 仓库说明](https://github.com/Player-MINEPIG/dsh-jev-plugin#配置调用方式)配置决策 profile，可使用 DSH 普通模型或 Jev 服务。
2. 打开 **看点什么 → 全局配置**，选择模型并配置 GitHub / B站凭据。
3. 在 **添加来源** 中选择 GitHub 仓库、B站视频或私信，绑定已有工作区并保存。
4. 点击 **刷新并整理**；首次采集的历史内容可用 **整理已有数据** 分析。

GitHub 和私信只读；B站评论自动回复需要单独开启来源授权。进阶配置、远程访问和常见安装问题见[安装与账号配置](docs/INSTALLATION.md)。

## Reference

| 内容 | 文档 |
| --- | --- |
| 安装、依赖、账号与 VPS | [安装与账号配置](docs/INSTALLATION.md) |
| 来源、阅读、处理与错误恢复 | [使用指南](docs/USAGE.md) |
| 模型、上下文、会话与 Agent 工具 | [模型工作流](docs/MODEL-WORKFLOWS.md) |
| 专项功能 | [自动回复](docs/AUTO-REPLIES.md) · [私信](docs/PRIVATE-MESSAGES.md) · [评价学习](docs/FEEDBACK.md) · [图片缓存](docs/IMAGES.md) |
| 数据迁移与回退 | [数据存储](docs/STORAGE.md) |
| 开发与扩展 | [预览与验证](docs/VERIFICATION.md) · [架构与 API](docs/ARCHITECTURE.md) · [开发与发布流程](docs/DEVELOPMENT.md) |

## 许可证

[MIT](LICENSE)
