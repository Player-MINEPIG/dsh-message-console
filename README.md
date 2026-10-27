# 看点什么 · DSH Message Console

面向个人的 DSH 消息聚合插件，在一个入口查看 GitHub 与 B站的变化、分析结果和待处理事项。

**版本：1.0.0** · [发布说明](docs/releases/v1.0.0.md)

## 主要功能

- **GitHub**：汇总 issue、PR、release，核实问题、审查变更并给出处理建议。
- **B站**：汇总视频评论和私信；评论支持拟稿、独立监督及按来源授权自动回复，私信仅查看和评定重要程度。
- **阅读与处理**：变化提醒、重要性排序、搜索筛选、批量已读与已处理。
- **工作会话**：复用 DSH 模型、工具和真实会话历史，可回到原会话继续讨论。
- **评价学习**：根据个人评价提出提示词和文字配置修改，确认后生效。

## Quick start

需要 DSH `0.2.1` 系列（含 RC 与正式版）。在同一个 profile 中依次安装并启用 **[Assembler 1.1.3](https://github.com/Player-MINEPIG/dsh-prompt-assembler/releases/tag/v1.1.3) → Jev 0.3.6 → 看点什么**；已有依赖直接复用。

1. 从 [Releases](https://github.com/Player-MINEPIG/dsh-message-console/releases) 下载安装包。**官方桌面端**在「插件 → 添加插件」中逐个填入包路径，安装后点击「立即启用」。详见 [GUI 安装](docs/INSTALLATION.md#gui-安装官方桌面端与-web)或 [CLI 安装](docs/INSTALLATION.md#cli-安装)。
2. 打开 DSH 左侧 **看点什么 → 全局配置**，配置模型和平台凭据。
3. 在 **添加来源** 中选择 GitHub 仓库、B站视频或私信，绑定已有工作区并保存。
4. 点击 **刷新并整理** 查看新变化；首次采集的历史内容可用 **整理已有数据** 分析。

GitHub 和私信只读；B站评论自动回复需要单独开启来源授权。

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
