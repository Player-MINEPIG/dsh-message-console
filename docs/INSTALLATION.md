# 安装与账号配置

[返回项目首页](../README.md)

## DSH 安装

使用 DSH `0.2.1` 系列，含预发布和正式版；本插件的 Host、LLM 与 Session 兼容范围为 `>=0.2.1-0 <0.2.2-0`，不固定某个 RC，也不放行 `0.2.2` 及其预发布。CI 与 Linux 部署已验证 `0.2.1-rc.2`；其他版本仍需满足共享插件自身的兼容要求，例如 Assembler 1.1.3 要求至少 `0.2.1-rc.2`。声明准入范围不代表已经实测每个 RC。

基础安装步骤统一放在 README：

- [依赖版本、仓库与下载链接](../README.md#quick-start)
- [GUI 安装（官方桌面端与 Web）](../README.md#gui-安装官方桌面端与-web)
- [CLI 下载与安装命令](../README.md#cli-安装macos--linux)
- [首次使用](../README.md#首次使用)

升级前核对其他消费者的兼容范围，并等待在途工作结束。以下为安装问题、共享服务和进阶配置。

### 安装问题与上游说明

README 使用本地包逐个安装。DSH `0.2.1-rc.2` 连续使用远程压缩包 URL 安装时，可能在后续步骤遇到 `ERR_PNPM_MISSING_TARBALL_INTEGRITY`；先下载再安装可避免此路径。不要跳过完整性校验。Assembler 的界面操作与共享服务迁移见[上游安装说明](https://github.com/Player-MINEPIG/dsh-prompt-assembler/blob/v1.1.3/docs/INSTALLATION.md)。

### 配置与共享依赖

本插件通过宿主的 `dshPromptAssembler` 和 `decisionModels` 服务工作，不安装或启动私有 Assembler/Jev 副本。包的 optional peer 声明用于阻止 npm 自动安装；运行时仍必须启用这两个服务。开发依赖仅供仓库测试，安装发布包不会安装这些开发依赖。停用共享服务会使依赖它的插件停止工作。

Assembler 从 **插件 → 已安装插件 → dsh-prompt-assembler → 配置当前会话** 打开编辑器。使用标准 native 后端，无需核心扩展。远程 Web 按上游说明配置 `security.allowRemoteClients` 和精确的 `security.allowedHosts`，同时保留正常 DSH 认证。消息插件不另存 Jev URL 或密钥。

### 从源码构建

从源码构建本插件：

```sh
npm ci
npm run build
mkdir -p .local
npm pack --pack-destination .local
```

### 插件配置

包携带 `cordis.patch.yml`，默认将插件数据放入该 profile 的 DSH 数据目录。可在插件配置中指定：

| 配置 | 用途 |
| --- | --- |
| `storageDir` | 本插件的数据目录；单进程独占 |
| `cookieFile` | 显式导入的本机Cookie文件路径；不通过状态API返回凭据 |
| `autoSchedule` | 是否启动抓取/整理计时，默认 true |
| `timeoutMs` | 单轮自动执行时限的后端默认（毫秒），初始 300000；全局/来源 agentTimeoutSeconds 优先 |

从 DSH 左侧插件区域打开“看点什么”，在“全局配置”从宿主目录选择提供商与模型，在“添加来源”绑定已有工作区。`dsh-plugin-subscriptions` 通过宿主 LLM 提供商接口复用，不单独保存供应商凭据。Jev profile 不配置时使用 Jev 默认 profile；若其输出只有选项而无完整概率，插件会记录失败，不冒充获得置信度。

Jev fork 0.3.6 的 native 普通模型和 custom 路径均已用合成输入验证完整概率、低置信升级、失败记录和人工审核边界。native 的概率是模型自报估计，不是 token 概率或经过校准的置信度；阈值仍需真实样本验证。工作记录保留 Jev 返回的 profile、model、answers 和 usage，不推测服务未提供的概率来源 metadata。上述自动化测试不使用真实 Jev 凭据。订阅提供商仍由宿主目录接入，但第三方提供商插件也必须兼容该宿主。此前检查的 `dsh-plugin-subscriptions` 0.9.9 的 peer 声明不包含 `0.2.1-rc.2`；本版不承诺该组合的真实订阅调用兼容性，不应强行跳过依赖检查。

工作模型和监督模型可以使用不同 provider/model；即便使用同一模型，也分别创建独立会话。任务插件不是依赖；Memory Manager 不作为硬依赖。

## 账号与目前限制

- GitHub 默认使用 DSH 运行用户已有的 `gh` 授权。先在同一用户下确认 `gh auth status --hostname github.com`，再启动插件。插件调用 `gh auth token --hostname github.com`，在内存中以该授权读取固定的 `api.github.com`，并通过 `/user` 验证登录身份。正常采集不会创建或修改授权；全局配置的“平台凭据”可主动启动 gh 网页设备授权。不将 token 写入插件配置、数据库、日志或模型输入。每次采集重新读取授权，分页复用该轮内存授权；命令及网络请求均有超时。
- `gh` 不存在、授权失效或请求失败时显示错误并保留已有数据，不自动降级匿名访问。需要匿名读取公开仓库时，可在宿主插件配置中明确设置 `githubAuth: public`；默认值为 `gh`。无论 gh 授权本身具有什么权限，当前 GitHub 连接器只采集，`canPublish` 始终为 false。
- GitHub 始终采集并显示全部 Issue 和 PR，包括已关闭及已合并状态；手动、自动整理均按内容变化处理，不再按关闭状态跳过，旧 includeClosed 设置不再生效。API 采集关闭、重开、合并事件及操作者（[GitHub 事件字段](https://docs.github.com/en/rest/using-the-rest-api/issue-event-types)），结合实际 gh 登录身份和此前内容判断是否值得查看。仅本人关闭/合并且无其他关注点时通常无需介入；关闭项最新分析无需介入时清除旧待处理和未发送旧草稿，保留未读与历史；他人操作提示查看；身份或事件缺失不猜测。首次补采历史状态事件可能产生一次内容版本更新，分析须区分旧事件与新变化。Release 照常整理。
- 从旧 Cookie 采集切换时沿用旧 Release 和 PR 的本地 ID，保留历史版本、会话、评价和草稿引用。API 返回的 Markdown 正文与补全上下文可能产生一轮更新提示，旧草稿会按内容变化规则失效；再次采集相同内容不会重复更新。Release 与 API 数字身份建立关联后，标签改名仍沿用同一内容项。若首次切换前标签已经改名且旧记录没有数字身份，则无法可靠识别为同一 Release。
- `cookieFile` 用于 B 站视频评论采集及按来源授权的评论发送。macOS 可显式运行 `node scripts/import-chrome-cookies.mjs .local/credentials/chrome-cookies.json`。默认 Chrome 的 Default profile，可将 `"Profile 1"` 作为第三个参数。导入文件权限为 0600，不会自动续期。旧文件中的 GitHub Cookie 不再用于采集。
- GitHub 仓库读取目前按完整快照扫描，较大仓库会产生较多请求；限流后保留已有数据，未完整获取不会推进基线。尚无增量缓存。
- PR 文件列表超出 API 上限或未完整取得时，仍采集条目和状态，但标记上下文不完整并停止自动审查。PR 缺失 patch 或代码上下文、issue 缺少复现材料时，只能给出受限分析。Agent 可使用绑定工作区的标准工具核对资料，但不能把可用工具当作已运行测试或已复现的证据。采集链路仍不提供完整仓库检索和自动代码修复流程。
- `unknown` 发布结果需要人工去原平台核实；本版没有自动对账和恢复发送的界面。
- 已有 Linux 宿主、Web 界面、真实账号采集与真实模型调用的验收记录。自动化测试使用合成模型响应；这些结果不保证任意订阅提供商兼容或模型判断准确。真实平台发送需要有效凭据及明确授权，发布验收不重放生产回复。

## 无浏览器的 VPS

GitHub 复用 VPS 上 DSH 运行用户的 gh 登录，无需 Chrome 或复制 Cookie。`GH_TOKEN` 或 `GITHUB_TOKEN` 环境变量可能优先于 gh 保存的授权，实际身份以插件显示的 `/user` 结果为准。

B 站 Cookie 连接器运行时不需要 Chrome。可在自己的 macOS 上显式导出，经安全通道传到 VPS 上 DSH 运行用户的私有目录，设置权限 `0600`，再将 `cookieFile` 指向该文件。连接器每次请求重读文件；登录失效后可在“全局配置 → 平台凭据”粘贴新的 Cookie，或继续按原流程导出替换。VPS 的出口 IP 是否被平台接受、Cookie 有效期和风控限制需要单独实测。

迁移来源数据时还需处理工作区 ID、目录路径及真实 DSH 会话历史，不能只复制插件状态文件。先使用独立的新宿主数据目录验证，再决定是否迁移旧数据。

## 平台凭据配置

全局配置分为“默认配置”和“平台凭据”。凭据页从后端 adapter 读取平台、字段、动作和状态；新增平台的凭据表单无需在前端写平台分支。

- B 站：粘贴单行 Cookie（至少含 `SESSDATA`、`bili_jct`），先验证登录及已有私信来源的账号绑定，再原子保存为 `storageDir/credentials/bilibili.json`（0600）。只保留允许的 B 站 Cookie，保存失败保留原凭据。页面不回显 Cookie，成功保存后无需重启。受管理文件优先于旧 `cookieFile`；旧文件不会被覆盖。回退到旧文件需停服并由管理者移走受管理文件。普通网页不能直接读取 B 站 Cookie。
- GitHub：复用 DSH 运行用户的 `gh`。点击“登录 GitHub”后页面显示设备验证码和官方授权链接；授权完成由 `gh` 保存令牌，页面只查询状态。支持取消及十分钟超时，不接收任意命令、主机或令牌。环境变量身份不能通过该页面替换。公开匿名模式需先在宿主配置改为 `githubAuth: gh`。无系统凭据库时 gh 会回退到本地文件存储。
- 验证是只读身份检查，不抓取来源、不发送平台内容。后台任务执行中拒绝凭据操作；凭据操作期间阻止启动新任务，避免处理中换身份。登录完成不会增加来源发布授权。

凭据 API 使用宿主认证，写请求要求 JSON 和 `X-DSH-Message-Console: 1`；返回禁止缓存，原始凭据不进入普通配置、数据库、模型输入或 API 响应。
