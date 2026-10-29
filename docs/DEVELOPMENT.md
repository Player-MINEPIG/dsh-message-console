# 开发与维护流程

`dev` 是完整的开发集成基线，`main` 是经过验收的正式基线。功能分支只保存正在进行的工作，完成后通过 PR 合入 `dev`。版本通过 tag 记录，不长期维护每次发布的 release 分支。

## 开发与合入

1. 开始前执行 `git fetch origin --prune`，核对 `origin/dev`、`origin/main` 和实际部署的源码 SHA，保全现有未提交工作。
2. 从最新 `origin/dev` 建立短期 `codex/` 分支和独立工作树。主 checkout 留在已核实的 `main`，本地 `.local/` 资料保留。
3. 实现时同步更新受影响的功能说明、API、配置和示例。功能 PR 不逐次涨版本号，构建和部署记录用源码 SHA 区分。
4. 向 `dev` 提交 PR。正常 Linux 测试通过、分支与 `dev` 保持最新、讨论解决后合入。允许 squash 和 merge，关闭 rebase merge；单人维护不要求他人审批。

完成的功能及时进入 `dev`。历史功能分支的存在不代表还有待集成的成果；删除前核对独有提交、等价补丁、工作树和未提交文件。

## Linux 正常测试与 CI 用量

Linux 是当前生产环境，也是正常测试环境。CI 安装固定的 DSH `0.2.1-rc.2` 以复现验证环境；插件兼容声明允许 `0.2.1` 系列预发布与正式版，不固定某个 RC。CI 运行全部 `test/*.test.js`，包括真实 DSH、PTC、Jev、冷恢复、存储、HTTP 和界面测试；随后构建、打包、实际安装并核对包文件与入口。宿主测试跳过会使 CI 失败。

本地运行相同入口：

```sh
npm ci
npm run setup:runtime
npm run test:ci
npm run build
npm run test:package
```

已有隔离宿主时，将 `DMC_DSH_ROOT` 设置为包含该宿主 `package.json` 和 `node_modules` 的绝对目录。普通 `npm test` 仍适合开发时使用；未指定宿主时会跳过宿主集成测试，不能作为完整验收记录。

CI 触发范围：

- 只有目标为 `dev` 的 PR 自动运行正常 Linux 测试。后续更新同一 PR 时取消过时的运行。
- 普通 push、合入后的 push、tag、定时器均不触发 CI。
- 手动 `verify` 对固定的 `dev` SHA 运行同一套正常测试，并保存原始安装包与校验记录 30 天。 全部成功后由 GitHub Actions 回写该提交的 `Linux` 状态，供分支保护识别；手动运行产生的 job check 本身不能满足该门禁。
- 手动 `promote` 复用成功的 `verify` 结果与原始包，保存验收记录 90 天，将 `main` 快进到被测 SHA。它不重复测试、不重新打包、不部署，也不创建 tag 或 Release。

不为迁移增加 macOS 矩阵或另一套较弱的 Linux 检查。需要其他运行平台时再增加对应验收。

## 部署与正式基线

常规迭代可以按已有授权部署到自有 `aws-vps`。从 `dev` 选择明确的提交并记录源码 SHA、包 SHA256、依赖版本、备份及验收结果；开发部署不自动改变 `main`。

部署前确认没有在途工作，备份插件、配置和数据；安装后检查包文件、服务、数据库和界面。隔离模型验收使用合成来源，不为了测试而重放真实生产任务或发送平台内容。含数据库迁移时按对应版本的迁移与回退说明执行。

将开发成果确认为正式基线：

1. 准备一个 PR，按本次实际发布范围更新版本、根锁文件、发布说明和文档中当前版本展示。历史版本号保持原义。
2. 合入 `dev` 后固定候选 SHA。在 Actions → **Project checks** 选择 `dev`，操作选择 `verify`，填写该 SHA。
3. 下载 `candidate-<SHA>-<runID>-<attempt>`，用其中原始 tarball 完成 Linux 设备验收。记录结果，取得用户对更新正式基线的真实确认。
4. 在同一个 workflow 选择 `main`，操作选择 `promote`，填写同一候选 SHA、成功的 verify run ID、设备验收记录和用户确认依据，并勾选确认。
5. 回读 `main`，确认它正是被测 SHA。`dev` 可以继续前进，只要候选仍在其历史中并包含当前 `main`。

`main` 要求 GitHub Actions 来源的 `Linux` 和 `Release approved` 状态。通过受信 `main` 上的 promote 入口推进，保持普通快进，不使用 main 的 PR merge 按钮，也不额外创建 merge commit。分支保护不能独立表达所有快进约束，脚本校验祖先关系并执行普通 push。

验收文本和勾选是维护者声明，不能独立证明设备验收或用户授权真实发生。代理必须引用实际证据。打 tag、创建 Release 仍需用户明确授权；promote 成功不自动授予这项权限。

如果 Actions 机器人因 workflow 写权限无法推送，由具备权限的 owner 核对同一候选、成功 CI、原始包和用户确认后执行普通快进。保留保护规则，不强推或关闭门禁；需要通过受信 workflow 写入相同候选的批准状态，再由 owner 推送。

## 首次迁移基线

本次迁移保留版本 `0.1.11`。业务源码基线为 `913d4b63e4c7f0726d03dcfbdb5a808e77adb679`：AWS 49 个安装文件与原始部署包逐文件一致，包内受版本控制的文件与该提交一致。全部远端分支成果已在该提交历史中，两个本地独有功能提交已有等价补丁。

首次建立 `main` 和 `dev` 时，仅在该业务基线上增加维护流程、CI 和相应验证，不发 tag 或 Release。迁移细节与设备证据保存在被 Git 忽略的 `.local/`。
