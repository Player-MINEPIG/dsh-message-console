# 架构与连接器合同

## 层次与依赖

```text
DSH Web slots / uiWorkspace
          │
          ▼
  HTTP API（宿主 connection.admit）
          │
          ▼
  ConsoleService ─── Store（SQLite 按行事务）
       │       │
       │       └── WorkflowExecutor → DSH Agent / Jev / Prompt Assembler
       └── Connectors → GitHub网页 / B站视频接口 / 匿名REST回退
```

平台声明能力；来源保存目标、类型和覆盖配置；内容项保存稳定远端 ID、当前版本、阅读版本、处理状态与会话关联。抓取更新内容版本。首次完整抓取建立已读基线并令 `analyzedVersion` 等于当前版本，以跳过自动分析；此时 `analysis` 仍为空，不代表实际执行过模型。

`src/core.js` 不依赖 DSH。`src/dsh.js` 将不同工作角色映射到独立原生会话，同内容分析角色可跨轮复用原生历史，保存会话引用后才执行；人工背景通过公开 `Agent.inject` 准备为待用输入，首次用户发言后才由宿主写入真实消息，不伪造系统头、模型输出或工具记录。每个版本的人工入口可新建会话，旧会话仍可查看。

## 宿主兼容边界

当前目标为 DSH `0.2.1-rc.2`、Cordis `4.0.5`，Assembler 标准 native 后端固定到 `1.1.2` 源码提交 `21183e18c9e8e7f7f01fda04b5af4218ce194539` 及锁文件完整性摘要。该补丁对装配、历史策略与 request-token API 显式要求 DSH owner 认证，保留 Host、Origin、JSON 和桌面 CSRF token 检查。包的 `engines.dsh`、DSH peer 和锁文件共同声明这一组合，不承诺旧宿主继续兼容。插件将旧 JSON 业务数据迁移到 SQLite，DSH 原生会话历史仍由宿主保存，不迁移或重写真实会话事件，也不修改宿主核心。

新版宿主将工作目录等动态事实放在 runtime context。Assembler 兼容层保留旧文本策略的 `cwd` 变量，并保留宿主必需上下文；插件自身仍通过公开 `agents.create`、`followup`、`runMaintenance`、`session/event`、`whenIdle`、`sessions.flush` 和 `inject` 驱动独立角色。尾部 PHI 使用真实 user/pre-step 消息。JSONL 持久化插件的新版入口是命名 `apply`，离线集成测试按模块加载，不再假定 default 导出。

模型目录继续使用 `llm.listProviders()` 和异步 `listModels(provider)`，只返回 provider/id/name。Jev 使用独立的 `decisionModels.config()` 白名单投影及 `ask()`；不因目录探测读取或返回密钥。第三方提供商的 peer/宿主兼容性由其自身声明，不能通过本插件的目录适配绕过。

## 连接器

```js
connector.status() // { ready, canPublish, reason }
connector.fetch(source, { signal, readPreviousItem }) // { complete: true, items: ContentItem[] }
connector.getItem(source, item, { signal }) // 发布前重新读取单项
connector.publish(source, item, draft, { actionId }) // { remoteId, url? }
```

内容项形状：

```js
{
  remoteId: '稳定且带类型的远端ID',
  kind: 'issue', // issue | pr | release | comment
  title: '标题', body: '正文', url: 'https://...',
  payload: { /* 可确定性序列化的上下文、状态与讨论 */ }
}
```

`title/body/payload` 的指纹就是版本，因此不要往 payload 放每次抓取都会变化的本地时间。返回不完整分页必须抛错或 `complete:false`，不能当完整基线提交。重试冷却通过异常上的 `retryMs` 传递。

发布失败只有确认远端未接受时才设置 `error.definitelyNotSent=true`；超时、连接断开、响应无法解析均为不确定结果。不得在连接器内部盲目重试 POST。`actionId` 用于远端关联与后续对账。

## 浏览器桥接扩展点（尚未实现）

外部适配器可以提供 Cordis 服务 `messageConsoleBrowser`：

```js
bridge.status(platform) // { ready, canPublish, reason }
bridge.readSource(source, options) // 完整内容项快照
bridge.readItem(source, remoteId, options) // 一个内容项
bridge.publish(source, item, draft, { actionId }) // 发布回执
```

配置 `cookieFile` 时使用当前内置的 Cookie 只读连接器：GitHub 登录网页采集 issue、PR 和 release，B站视频接口采集根评论与楼中楼。macOS Chrome 导入脚本只读取对应域的白名单 Cookie，落盘权限0600，不随包发布。未配置时仍保留桥接扩展点及匿名 GitHub 回退。内置 Cookie 连接器不提供发布方法。

Release 使用服务端 HTML 列表与详情，不依赖 Issue 或 PR 的 React 数据。列表按页扫描并按标签去重，只接受同仓库的标签与下一页链接；详情验证仓库、标签和发布时间。采集结束重读首页，首页条目或分页发生变化时整轮失败。网页不提供数值 Release ID，因此使用 `release:web-<tag>` 标识；改用 REST 来源时不能据此与数值 ID 自动合并。说明采集不包含附件内容或关联讨论。

Release 仅在 Cookie 缺失或过期、HTTP 401、同源登录跳转或页面缺少登录身份时回退公开网页。回退丢弃本轮已读的 Cookie Release 结果，从第一页匿名重采整批。匿名请求复用串行限速与超时，限于 `github.com` 同仓 Release 路径，不携带凭据、不跟随跳转；分页与详情仍须通过原结构验证。429、其他 HTTP 错误、网络失败与结构异常不会触发回退。`metadata.releaseAccess` 记录 `cookie` 或 `public`，`releaseFallbackReason` 保留登录失效原因；失效时清除旧身份，成功回退不记为抓取失败。Issue 与 PR 不采用匿名回退。

列表完整与上下文完整分别表示：`batch.complete` 验证条目枚举；`payload.contextComplete` 表示该条目的讨论是否完整。GitHub网页尚未遍历全部审查线程，因此PR均标记上下文不完整、仅供查看，不自动审查或拟稿。B站逐页核对计数，根评论与楼中楼总量需与接口声明一致，变化或缺失时不推进基线。

## 发布状态

`pending-supervision` 表示工具已存稿、独立监督尚未成功完成。`ready` 表示监督通过且仍待用户批准；`blocked` 表示监督拒绝。正文创建后不可修改；改稿创建新 `draftId`，被明确替换的旧稿标为 `superseded`，新稿重新等待监督。内容变化会将旧草稿标为 `stale`。用户批准绑定正文指纹与内容版本，发布前再读远端；写入 `sending` 后才请求平台。成功为 `sent`；确定未发送可回到 `ready`；无法确认则 `unknown`，重启后的 `sending` 也变为 `unknown`。

本版没有自动发布开关。平台内容、提示词中的要求以及监督判断都不能代替用户发布批准。

## 已知实现范围

SQLite 将日常状态更新限制在相关行及来源计数投影，列表、评论及工作历史由服务端分页。来源配置数量仍按个人规模处理，连接器仍以完整批次提交；字面子串搜索和深页 OFFSET 也可能随单来源内容量增长。当前实现不保证任意规模恒定开销。平台采集与模型执行的失败分别保留，不以模型成功掩盖采集过期。真实Cookie采集已验证；真实模型账号调用、全部目标插件共存和实际发布仍须完成集成验收。

## 宿主界面与会话归属

客户端注册 `sidebar.panellist` 和相同标识的 `main` 面板，使用 `uiWorkspace.openSession` 返回宿主会话。来源仅保存 `workspaceId`，不保存可漂移的工作目录副本。DSH适配器从 `workspaceRegistry` 解析已有工作区及其状态，创建会话时设置 canonical `cwd`，持久化后调用 `attachSession`，成功后才能唤醒模型。工作区缺失或目录不可用不会回退默认目录。来源改绑后，已有会话保留原归属，新会话使用新工作区；人工会话按内容版本、工作区及 `contextVersion` 共同复用。

## 视频资料与提示词边界

B站来源使用BV/av视频ID或视频链接。每个来源保存独立context、materials和postHistoryInstruction，资料可以是显式文本或工作区内非隐藏文件；解析符号链接后再次检查目录边界。资料内容摘要参与contextVersion，变化后旧审核失效。

DSH通过Assembler native前置system定义任务与不可信输入边界，pre-step追加user角色的post-history提醒；这是宿主支持的真实尾部消息，并非system优先级。每个角色自己的历史持久化。Jev独立请求中同样加入可信规则。平台正文仅进入数据，不参与构造可信尾部指令。此机制降低提示词注入风险，不能保证模型永不受影响；工作 Agent 使用宿主标准工具与两个会话绑定的业务工具，对外发布仍必须单独批准。

## 来源输入合同

来源增加以下可选字段，旧来源缺少时使用默认值。

| 字段 | 合同 |
| --- | --- |
| `description` | 来源简介，最多 1000 字，默认为空 |
| `tags` | 最多 12 个非空标签，每个最多 40 字，默认空数组 |
| `stageContexts` | 按 decision、escalation、generation、supervision 保存可选 context 和 materials，默认空对象 |
| `inputOrder` | `source`、`context`、`materials`、`content` 各出现一次的排列，默认按此顺序 |

`src/input-assembly.js` 是浏览器与服务端共享的纯函数模块。`assembleInput(source, item, { language, stage })` 生成有序 `blocks`，每个块具有 `key`、`label` 与 `value`。`serializeInput(input, extras)` 将块和当前步骤附加数据序列化。资料按 `resolvedMaterials` 的数组顺序装入，不重复装入原始文件配置。

来源信息块包含名称、平台、目标、简介、标签及关注规则。当前内容块白名单保留采集的 ID、类型、标题、正文、URL、内容版本及变化时间。GitHub 输入按下面的有界合同提供概要，其他平台保留各自的数据范围，不携带插件内部 analysis、draft、sessions 或个人处理状态。Agent 的真实 user 消息外层保持 `{ role, input }`。升级判断的 `decision` 和监督的 `draft` 各追加一次。人工背景通过同一组装函数准备为待用输入，由宿主在首次用户轮接受为真实 user 历史。Jev 的 `state` 使用相同顺序的块，可信 PHI 留在问题 `instructions`。数据块顺序不会改变消息角色或提升平台内容的可信级别。

`POST /api/dsh-message-console/sources/preview` 接收 `{ source, sourceId?, itemId?, stage? }`。`source` 是尚未保存的来源表单，另可传 `stage`，默认 `generation`，验证与保存共用相同合同。已有来源必须匹配平台、目标及类型。内容项只从服务端状态中读取，并验证归属。新来源无 `sourceId` 时不能指定实际内容项。预览经 `workspaces.resolve` 和 `prepareSource` 解析显式文件，沿用隐藏目录、符号链接、文本类型及大小限制，不改变状态。

响应包含 `{ input, serialized, postHistory, itemId }`。无内容项时 `content` 块明确占位；浏览器本地预览尚未解析的文件只展示路径和未读取状态。预览中的 system、历史及步骤附加数据为固定位置说明，不伪造宿主或供应商的完整请求。客户端用请求版本号丢弃修改表单前发出的过期响应。

`contextVersion` 包含规范化的 `inputOrder`、名称、简介、标签、上下文、关注规则、资料正文指纹、全部阶段背景与资料正文指纹及补充 PHI。保存这些语义变更时，旧待审核草稿变为 `stale`，已有分析的内容重新成为可整理状态，阅读版本不变。成功分析记录 `analyzedContextVersion`；后续整理也比较实际解析后的资料版本，因此显式文件内容变更可触发既有分析的更新。自动整理不会因资料调整全量分析没有真实分析的首次基线。手动整理已有数据可以处理这些历史内容。运行期间来源配置变化时，旧输入的结果标记为过期。

## 总览统计与导航

`src/dashboard.js` 保留当前分析、优先级和需处理判定的纯规则，供 Store 更新内容投影。来源计数由同一事务维护，平台统计在后端基于来源摘要计算，前端不读取全库内容重新聚合。综合分数为当前版本重要性乘 10，加上有依据的紧急性修正 3，再以需要处理数、未读数、`changedAt` 和稳定 ID 排序。最近更新模式以 `changedAt` 为首键，`fetchedAt` 只用于显示抓取状态。旧内容版本的分析不参与摘要、重要性或紧急性判断。

未读数与需要处理数均按内容项 ID 去重。待处理、整理错误及 human/review 审核意见会计入；尚未关闭的 `pending-supervision`、`ready`、`blocked`、`stale`、`sending`、`unknown` 草稿也会计入同一内容项。“本轮已处理”阻止旧人工介入分析重新产生待处理计数，但不能代替关闭尚存草稿。

`src/client.jsx` 用单个页面状态选择总览、全部平台、全部来源、平台来源、来源详情、全局配置、新建或编辑来源。插件没有内部侧边栏。`src/dashboard-view.jsx` 展示列表和内容项，`src/source-editor.jsx` 负责来源表单及可排序的真实输入预览，`src/ui-shared.jsx` 保存通用字段与请求组件。

B站评论的当前有效结论变为无需回复时，Store 同事务清除旧 pending/later，未发送的 pending-supervision/ready/blocked/stale 草稿标为 superseded。read_version、正文和历史不变，sending/unknown 保留核实。启动时由 meta 的 comment-ignore-settled-v1 标记执行一次旧状态修正并记录审计；不对过期分析应用，也不会反复覆盖升级后用户主动指定的状态。

## 手动与自动整理范围

`ConsoleService.organize(sourceId, { scope })` 默认使用 `changes`。调度器与 `refresh` 显式使用此范围，只处理内容版本尚未分析或已有分析的真实背景版本已变化的内容。`POST sources/:id/organize` 显式选择 `history`，额外包含 `analysis` 为空的历史基线，仍跳过内容与背景都已完成的项。来源的刷新或整理正在运行时，同来源新请求明确返回忙碌错误，不复用另一个范围的 Promise。

GitHub issue/PR 的关闭或合并状态不影响列表可见性或整理资格；关闭项新分析无需介入时也清理旧待处理与未发送旧草稿（发送中/结果不明仍保留）；旧 showClosed 查询参数和 includeClosed 布尔配置不再限制范围。API 分页采集 closed/reopened/merged 事件及 actor，来源采集身份进入模型输入 ownLogin，供模型结合旧版本判断是否需要查看。

失败提示右上角提供“关闭提示”：调用 `POST sources/:id/dismiss-organization-warning`，携带当前 `reportId`，只记录本轮提示已关闭。关闭状态保存在来源中，刷新、切页及重启后仍生效；记录继续显示在“来源与整理详情”折叠区。新轮次有独立 ID，新的失败重新提示；旧页面的关闭请求不能隐藏新轮次，也不改变来源背景、配置修订、内容处理状态或运行结果。旧记录用稳定指纹标识，无需数据库迁移。

整理返回以下结果，并保存到 `source.lastOrganization`，供页面重新打开后查看。

```js
{
  sourceId, scope, contextVersion, startedAt, finishedAt,
  total, candidates, completed, failed, skipped,
  status, // completed | partial | failed | skipped
  reason, // 没有候选或候选中途过期时的原因
  errors: [{ itemId, title, message }]
}
```

`completed` 表示成功保存处理结果的内容项，`failed` 表示本轮失败的内容项，`skipped` 包含原本无需处理及中途过期的内容项。三者之和等于本轮快照的 `total`。完成数不代表模型调用数。`lastOrganization` 带有所用的背景版本；编辑来源保留这份历史结果，不将它改写为新配置的执行结果。`refresh` 的响应将整理结果放在 `organization` 中。

`WorkflowExecutor` 在上下文不完整时直接返回人工介入标记，不调用模型。Jev 的忽略或人工介入结果也只是固定的分流提示。运行记录保存 `processing` 为 `context-incomplete`、`decision-only` 或 `analysis`，界面据此说明本轮处理方式。已有的 Jev 输入输出和角色会话仍为实际调用记录。分流提示不作为内容摘要列入来源卡片。

## 模型调用与配置

| 阶段 | 实际路线与输入 |
| --- | --- |
| 评论轻量决策 | Jev profile，以有序块作为 state，可信规则放在问题 instructions，输出各选项概率 |
| 低置信决策升级 | 最多一次生成与分析模型调用，附加 decision，不拟回复；仍不确定则人工介入 |
| 生成与分析 | 生成与分析 provider/model，按内容类型执行评论拟稿、PR 审查、issue 核实或 release 摘要 |
| 独立监督 | 有拟发布正文时创建独立会话，附加 draft；缺省字段继承生成与分析路线 |
| 人工处理 | 优先打开同内容的原工作会话；没有可用工作会话时复用当前人工会话或创建背景，打开时不唤醒模型 |

生成与分析阶段的摘要和正文来自同一次输出，没有独立总结路由。各阶段共享完整的基础数据块与顺序，只追加当前阶段的专属背景，角色任务指令不同。共用原文及讨论不裁剪，Jev 不接收其他阶段的专属背景。DSH 的 API 连接配置与本插件的 provider/model 选择是两件事。生成路线缺失不阻止 Jev 独立分流，只有实际进入需要该路线的阶段时才产生对应错误，并保留此前的 Jev 记录。

受管会话的模型请求由 `src/model-fallback.js` 验证实际调用配置；不以可见目录是否列出模型作为可调用性判断。来源覆盖或历史会话路线失效时，读取当前全局生成/分析默认，监督角色读取当前全局监督默认（按既有规则继承生成默认）。宿主请求返回失败时仅重试当前模型请求一次，不重放此前工具；默认请求也失败则明确报配置错误。取消不触发回退。热会话与冷恢复、人工继续及异步任务回报都使用同一处理，普通工作区会话不受影响。配置中的旧选择保留，真实 request/header 记录实际调用路线；含图升级在回退路线重新建立内存转发，不能静默省略图片。

全局配置及来源覆盖的 `agentTimeoutSeconds` 允许 1–1800 秒。未设置时沿用插件后端 `timeoutMs`（初始 300000ms）。每个插件发起的升级、生成、监督、学习轮次分别计时，包含工具与压缩；新值用于新发起工作，不重置在途计时器。计时在本轮 turn/end 后结束，不覆盖整批、Jev 独立请求、人工继续或远端回报等待。无需为了长时间异步等待扩大此值；调度轮应先保存当前结论并结束，回报到达再继续原会话。

## 宿主模型目录

`src/model-catalog.js` 通过公开 `ctx.llm.listProviders()` 返回提供商的 `id`、`name`，通过异步 `ctx.llm.listModels(provider)` 返回该提供商的 `id`、`name`、`provider`。订阅提供商与普通提供商使用同一个宿主目录，不旁路其可见模型过滤。列表不包含密钥、连接配置或凭据。

`GET catalog` 单独返回 `{ providers, decisionProfiles, defaultDecisionProfile, providerError, decisionError }`。Jev fork 没有 profile 列表接口，因此仅在后端调用公开 `decisionModels.config()`，白名单投影 profile 的 `id`、`name` 及默认 profile ID，不返回其他配置字段。`GET catalog/models/:provider` 按需读取该提供商的模型列表；目录不进入五秒状态轮询。

`src/model-selector.jsx` 在页面打开后读取目录，模型按当前提供商懒加载，并提供显式刷新。不可用的旧选择保留并提示，不自动选择列表首项。`src/model-selection.js` 维护提供商与模型的绑定关系。切换提供商清除旧模型；跨提供商不能恢复继承另一路线的全局模型。监督仅在提供商仍与生成路线相同时继承生成模型，否则必须选择监督提供商对应的模型。恢复全局继承会恢复相应的全局路线。

## 按调用阶段装配背景

`stageContexts` 形状为以下四个可选键，各值只能含 `context` 和 `materials`。

```js
{
  decision: { context: '', materials: [] },
  escalation: { context: '', materials: [] },
  generation: { context: '', materials: [] },
  supervision: { context: '', materials: [] }
}
```

`prepareSource` 解析共用与所有阶段的显式资料，共用工作区边界、隐藏路径、符号链接、类型与大小校验。所有资料合计最多 256KB，每个资料数组最多 12 份。非空的阶段背景及解析后的资料参与 `contextVersion`；空阶段对象不改变旧共用配置的版本。

`assembleInput` 将共用上下文和当前阶段上下文装入原有 `context` 块，将共用资料和当前阶段资料按顺序装入原有 `materials` 块，保留四块可调整顺序。没有阶段专属上下文时保留旧的共用文字形状。其他阶段的背景不进入请求；原始内容也不携带上轮分析和草稿，避免通过旧结果间接串入专属资料。

Jev 使用 `decision`，一次低置信升级使用 `escalation`，各内容类型的生成和分析使用 `generation`，独立监督使用 `supervision`。人工会话明确使用 `generation`，创建时准备待用背景但不唤醒模型。角色指令、尾部 PHI 与可信边界保持固定。预览使用同一装配函数，升级 decision 和监督 draft 展示明确的占位，不能视为真实执行输出。

## 终止错误与冷会话目录

`src/dsh.js` 从真实 `turn/end.reason` 读取终止结果。失败时保留宿主 `error.code`、`message`、可用 `status` 以及原 `sessionId`，错误附带 `sessionFailure`。业务层将该结构保存在 `run.failure`，来源本轮统计也带回失败会话 ID。没有本轮 `turn/end` 时使用单独的 `MISSING_TURN_END`，不与模型返回格式错误混淆。

宿主 provider 可能在转成流终止结果时只保留公开错误，插件不推测已经丢失的底层 cause，也不把所有 `TRANSPORT` 硬编码成某个网络错误。会话保留真实的 request、attempt、retry 和 turn 记录；失败不会导致伪造成功输出或自动更改路由与网络配置。

`AgentHandle.dispose()` 会释放实时 Agent 和附着 Session，但不会删除已持久化历史。当前宿主的 `session/disposed` 会向前端发布 removed，普通会话行随即消失，真实冷目录仍可从 `sessionPersistence` 和 `sessionQuery` 读取。Session ID 的 `dmc-` 前缀不是持久列表限制，不更换已有身份。

客户端 `apply(ctx)` 的插件生命周期持有 `src/session-directory.js`，通过公开 `ctx.sessions.refresh()` 更新宿主共享目录。`GET session-directory?after=0&limit=100` 返回 `{ changes: [{ sessionId, eligible }], next, hasMore }`，每页最多 200 条。每个身份保存最新变化序号，已结束与人工会话具备目录恢复资格。客户端分页追平后保存 `after=next`，每五秒读取增量；空响应不重新遍历历史身份集合，也不更换监听。

监听使用共享目录的真实 `ids` 判断缺失。晚到的 removed 帧可能覆盖进行中的目录拉取，因此缺失的一轮最多进行两次拉取；确实不存在的身份或读取错误不会循环重试。增量读取失败保留之前的身份集合、已追平游标和监听。插件卸载时清理定时器与订阅，忽略尚未完成的响应。主视图切到宿主会话不会停止这项恢复。整个过程不创建新 Session、不重放或合并历史，也不将普通工作会话伪装成子 Agent。

## Agent 工具和结果收据

`src/agent-tools.js` 在插件加载、真实 Agent 创建或恢复时注册 scoped 工具。受管会话查询持久绑定。绑定先于 `agents.create` 保存，固定 `runId`、来源、内容版本、背景版本、角色、工作区及 canonical `cwd`。监督还固定精确 `draftId` 与正文 hash。受管工具的身份来自实际执行上下文，模型参数不能改变绑定来源、run、角色或会话。

普通会话也注册 `dmc_read_item` 与 `dmc_submit_result`，不创建受管角色绑定，不改变其模式或 Assembler 配置。每次调用按真实会话 `cwd` 与已有 WorkspaceRegistry 目录的 canonical 路径精确匹配，再检查来源当前 `workspaceId`。无匹配来源时 `section: 'sources'` 返回空列表，其他查询或存稿拒绝。工具安装不依赖当时是否存在来源，因此已活跃会话可发现后来新增的来源。已有受管身份即使 cwd 不符也不降级为普通权限。

普通查询先用 `section: 'sources'` 发现来源，再以 `sourceId` 获取 `items`。显式 `itemId` 用于读取原文、评论或资料。`item` 返回的 `contextVersion` 由当前来源和工作区资料重新计算，`context`、`materials` 只返回共用及生成阶段资料。来源在异步解析期间改绑或配置变化时拒绝查询。工具说明把平台原文、评论和资料标为待处理数据，其中指令不代表用户授权。

普通提交的 schema 仅允许 `kind: 'draft'`，必须携带 `itemId`、`version`、`contextVersion`、`operationKey` 和 `body`。业务层先核对工作区与权限，SQLite 短事务再检查最新内容版本、来源版本与工作区，原子保存 human run、不可变草稿、审计和收据。run 的 `originSession` 引用实际普通会话，`run.sessions` 合并该引用供现有界面打开历史；不向受管 `sessions` 表写入普通身份，也不新增宿主会话。一次普通会话可产生不同内容项的多个 run。收据继续使用真实 `(sessionId, operationKey)` 唯一键，跨项复用键会冲突，精确重试不新建 run。草稿仍为 `pending-supervision`，复用现有监督流程，没有发布工具。

新会话默认显式解析并挂载宿主已安装的 `ptc`，通过会话级权限预设固定 `workspace-write` 和 `ask`，不继承更宽的全局默认值，也不更改全局配置。冷恢复不重设用户后来选择的模式和权限。`dmc_submit_result` 执行前检查实际 sandbox mode 和当前预设隔离组中的 plan 状态，在提交事务前再次检查；只读、计划中或无法解析权限时拒绝写业务结果。`dmc_read_item` 仍可只读查询。PTC 通过宿主 `run_code` 的 `tools.dmc_*` SDK 进入同一 scoped 工具注册及权限检查，宿主持久记录外层调用与 `tool/ptc-dispatch`；业务保存工具仍可结束自动工作轮。DSH 标准文件权限与发布审核分别执行。

`assertStorageOutsideWorkspace` 在创建受管会话前、恢复其工具前和业务提交前，解析存储目录与工作区的 canonical 路径，并与工作区、`/tmp`、`os.tmpdir()` 的写入范围比较。存储目录处于任一可写根内时拒绝启用业务会话，符号链接同样按实际目标比较。数据库继续由领域事务写入，模型不通过文件工具修改数据库。标准 sandbox 的模式只约束文件写入，不构成网络隔离或工作区外读取限制。

人工会话的背景使用 `Agent.inject` 放进 `next-step` 待用队列。`AgentHandle.dispose()` 会清空当前队列，因此 `agent/created` 的串行监听在恢复人工会话时，调用只读 `sessionBackground(sessionId)`，从持久 run 快照重建尚未接受的背景。监听先查实际 `user/message` 与待用队列，已经进入历史或已在队列的背景不再加入。人工会话的 scoped `agent/pre-step` 只把本插件背景移到当前用户输入之前，系统消息仍由宿主创建。首次用户请求因而保持系统、背景、用户的顺序，也不会产生仅处理背景的额外模型轮。冷静态查询保留已有真实历史，尚未执行的背景保持待用身份。

Web `openSession` 打开会话后使用宿主 history follow；DSH 在首个冷 snapshot 后提升为 live Agent，经过同一恢复监听。源码路径与实际 `agents.resume` 的恢复行为已核对；本轮宿主测试使用离线适配器，不把它表述为完整 Web 与真实账号验收。

查询工具以 `section` 区分资源，列表不返回全量原文。

```js
// 参数中的 ID 和 version 均来自此前的工具返回值。
dmc_read_item({ section: 'items', q: '关键词', page: 1, pageSize: 10 })
dmc_read_item({ itemId, version, section: 'comments', page: 1, pageSize: 10 })
dmc_read_item({ itemId, version, section: 'comment', commentId, offset: 0, length: 16000 })
dmc_read_item({ itemId, version, section: 'body', offset: 0, length: 16000 })
```

缺省内容项及版本来自绑定的 run。同来源其他项可显式查询，不能改变原写目标。正文继续使用精确版本与返回的 `nextOffset`，直到 `complete`。`section: 'context'` 和 `'materials'` 使用本轮来源快照及当前角色的装配阶段，不把其他阶段的专属资料混入请求。

提交工具按绑定角色选择 schema。

| 角色 | 提交数据 |
| --- | --- |
| writer、review、investigate | `kind: 'analysis'`、`operationKey`、`analysis` 及可选 `draftBody` |
| decision-escalation | `kind: 'decision'`、`operationKey`、`choice`、`certain`、`reason` |
| supervisor | `kind: 'supervision'`、`operationKey`、`approved`、`reason` |
| human | `kind: 'draft'`、`operationKey`、`body`，替换时附 `replacesDraftId`、`bodyHash` |

提交在短事务内验证绑定、输入版本、背景、角色和替换条件，保存结果、草稿、审计及收据。同一会话的相同操作键与内容返回原收据，内容不同时拒绝；自动阶段已有结果后不能换键重复终结。工具记录保留真实 `callId`。自动提交可结束当前轮，人工存稿后仍可继续讨论。

`dmc_revise_analysis` 只注册给 writer、review、investigate，并在业务层检查真实角色与来源/内容绑定。可先用 `dmc_read_item({section: 'analysis'})` 查看最新分析；指定完整 analysis、reason、operationKey，可选 evidenceRefs 只存为 Agent 提供的引用，不查询或依赖任务插件。修订不要求旧内容版本、背景版本、analysisRevision 或原轮首次分析收据匹配。旧参数 version、contextVersion 和 expectedAnalysisRevision 可省略，传入时不作为更新条件。目标固定为绑定内容项，不能通过参数切换来源或内容。人工与普通工作区会话的草稿权限保持不变。

修订读取最新来源配置及文件资料，若准备期间来源配置改变则重新准备；在短事务内校验真实绑定并取得最新分析版本。成功原子更新当前分析及关注状态，追加 `kind: 'analysis-revision'` 的 completed run、同 kind 收据和 `tool.analysis.revised` 审计。新 run 保存当前内容与来源快照、修订前分析、原始 run 引用、存在时的原分析 receipt 引用、修订原因和证据引用；originSession 指向实际调用会话，不创建或重绑宿主身份。原 run、原收据不变，`requireSubmission` 排除修订收据，继续读取原工作阶段的结果。不同更新按事务顺序追加历史；相同键和内容可在重启后精确重试，不再次更新面板，键冲突不追加 run。

分析修订后，该项 pending-supervision/ready/blocked 草稿标为 stale；发送中、结果未知和已发送的记录不改写。修订工具不接收 draftBody，不授予发布权限。用户评价冻结新的分析快照并指向修订 run；原 Jev 决策保留在原 run，不复制为一次新决策。无需数据库 schema 升级。任务完成后的自动通知与会话唤醒不属于该工具的职责。

DSH 运行器等待该真实消息所属 session/turn 的 `turn/end` 并 flush 后，通过 `requireSubmission(sessionId, runId)` 读取本轮已保存的收据。缺少收据时明确失败，不解析最终助手 JSON 兜底。Jev 调用和上下文不足等系统分流仍由系统保存，保留真实输入、输出和错误，不伪造 Agent 工具调用。提交成功后的会话失败不删除已落稿，也不把失败会话记成成功。

## 按行存储与迁移

`src/store.js` 独占 SQLite、迁移、查询与短事务。来源、内容、不可变版本、评论、runs、不可变草稿、会话绑定、幂等收据和审核记录分别存行；设置及小型阶段结果仍可用 JSON 列。没有整库 `read/change/view` 兼容入口，HTTP 也不提供 `GET state`。

内容索引覆盖来源与优先级排序、更新时间、未读和需处理筛选，并为有依据的紧急项及可展示摘要建立查询索引。评论以内容版本和 ordinal 排序，runs 以内容项和时间排序，会话目录以单调变化序号分页。`markRead` 和个人处理更新只影响当前项及来源统计，不解码全库 payload。正文及评论原文完整持久化，不以列表摘录替代版本快照。版本的轻量 metadata 投影保存完整性提示、diff 长度和视频标题等，列表及头信息不再反复解析大 payload。分块查询只返回所选正文；diff 和视频简介仍需在 SQLite 内解析该项 payload，切片和长度直接使用 SQLite 内置 substr/length，只有返回的片段进入 JavaScript。

旧 `state.json` 首次导入前保留原文件并复制到 `state.pre-sqlite.json`。迁移保留 ID、版本、hash、Jev 输入输出、错误、会话链接和未知数据，记录旧文件 hash，逐项核对已有字段，并检查实体数、`quick_check` 和 `foreign_key_check`。数据导入与初始化标记在同一事务提交；失败会回滚导入并允许下次重试。未知数据库版本会被拒绝，不会重写其版本号。迁移成功后使用 SQLite 初始化标记，后续启动不会重新导入旧 JSON。旧 previous 缺少 payload 时保留 `complete: false`，不把当前 payload 拼进旧版本。

数据目录使用 `owner.lock` 独占。SQLite 使用 WAL、`synchronous=FULL`、外键约束及私有文件权限。重启将运行中任务标为 `interrupted`，将发送中草稿标为 `unknown`，已存草稿和会话不丢弃，也不自动获得发布授权。

## HTTP 与前端资源边界

所有路径以 `/api/dsh-message-console` 为前缀，保留宿主 owner admission、POST JSON 和来源检查。列表返回统一 `Page`。

```js
{ items, page, pageSize, total, pageCount, revision }
```

页码至少 1，页长只接受 10、20、50；空集合仍为第 1 页，超末页由服务端 clamp。内容排序为优先级降序、更新时间降序、ID 升序。`q` 对当前来源标题和完整正文作 trim 后的字面子串查询，百分号、下划线和引号不是查询语法。SQLite 查询使用注册的 JavaScript 大小写归一化函数，保留非 ASCII 文字的既有匹配语义。

| 路径 | 内容与读取时机 |
| --- | --- |
| `GET overview` | 来源元信息、统计、平台摘要、设置和忙碌状态，不带来源上下文或工作历史正文 |
| `GET sources/:id` | 编辑该来源时读取完整配置 |
| `GET sources/:id/items` | 服务端搜索、筛选及分页，卡片仅带摘录和当前分析 |
| `GET items/:id?version=` | 指定版本的头信息、状态和正文长度 |
| `GET items/:id/content` | `section=body/comment/diff/video-description`，精确版本、offset 和 length，最大每块 32000 个 Unicode 码点 |
| `GET items/:id/comments` | 评论摘要页，含评论 ID 和父子引用，完整评论另取 |
| `GET items/:id/runs`、`drafts`、`versions` | 相互独立的历史页，真实会话入口随 run.sessions 返回，无 run 的旧人工链接明确标为 legacy-session；不返回内部输入及设置快照 |
| `GET drafts/:id` | 列表仅含摘录、长度及正文 hash，展开时读取不可变草稿全文 |
| `GET runs/:id/decision` | 展开 Jev 时读取完整输入输出和错误，不进入轮询 |
| `POST drafts/:id/supervise` | 携带 `bodyHash`，启动精确草稿的独立监督 |
| `POST drafts/:id/publish` | 携带内容 `version` 与 `bodyHash`，仍需人工批准 |

`useRemoteResource` 在当前请求结束后才安排下一轮，避免慢请求被后续轮询作废；用 generation 拒绝旧页面或旧修订的迟到响应，切换或卸载时取消在途请求和定时器。改变搜索、筛选或页长回到第 1 页，详情选中项独立于列表及轮询。B站详情头只带视频标题和简介长度，视频简介按精确版本逐块读取。正文逐块加载，并明确显示剩余原文；版本、评论、工作记录和草稿各自分页。来源编辑预览也从服务端搜索候选，不从总览读取全部内容。工作区目录只在编辑或展开来源详情时按需读取，不参加五秒轮询。请求错误在对应区域显示，失败不伪装为空列表。

新 run 保存来源快照、初始设置、内容版本，以及本次观察的 changedAt 和 previous 原文引用。内容 hash 再次出现时，当前观察的 previous 可能不同于该 hash 首次出现时的 previous；人工背景恢复和监督重试使用 run 冻结的信息，不随后续抓取漂移。

## 分析会话与处理轮（schema 6）

`writer/review/investigate` 按 item、source、role、workspace 和 canonical cwd 选择最早有效的原会话。真实会话不存在才继续下一候选或创建；权限、持久化或损坏错误直接失败。忙或存在 inbox 的原会话不切绑定，避免改变用户正在进行的工作。监督、学习及人工会话不进入此候选集合。

`sessions` 是当前绑定指针；新增 `run_sessions(run_id,session_id,role,data)` 保存不可变的逐轮历史关联。schema 5 升级在事务中复制全部 run_id 非空绑定，包括 legacy 历史；legacy 不参与复用。旧 run、receipt 和 native 事件保留。原会话在 `runMaintenance` claim 的真正 idle 阶段同步切换绑定、请求装配并加入带 runId 的真实新输入；失败恢复旧绑定和装配。新输入附当前分析及历史引用，不伪合并其他会话事件。

每轮首收据按 sessionId/runId 查询。内部 JSON 元组幂等键包含 runId，公开 operationKey 不变；旧原始键只在 receipt.runId 或 revision.originRunId 匹配本轮时回放。工具捕获轮次，跨 await 后及写事务前检查当前绑定，原内容/资料/分析 CAS 与写入权限检查继续生效。

`agent/inbox/claimed` 将真实消息关联到 turn，路由钩子按 turn 采用本轮模型，后续用户轮恢复原路由。`session/event` 只结算该 session/turn 的 turn/end；discard 与宿主 idle 提供未接受消息/异常缺日志的失败兜底。计时器只取消仍执行的目标轮，不影响后续用户轮。超时保留 TIMEOUT、时限和真实 hook 原因，外部信号及宿主取消另记。

工作列表的 submission 是 indexed receipt/audit 只读投影，优先正式分析，不被同 run 的监督收据覆盖。原 failed/interrupted 和 finishedAt 不因后补交而改成 completed；结果保存时间、当时采纳与草稿当前监督状态独立展示。同步草稿监督仍沿原 executor 路径。

## 统一私信

B站私信来源固定 `target: 'private-messages'`、`types: ['private-message']`。`ConsoleService.saveSource` 通过真实 nav 登录态绑定 `accountId`，编辑保持原绑定；连接器每轮先复核账号。`Store.saveSource` 在事务内拒绝第二个私信来源，包括停用的来源。

`bilibili-private.js` 独占私信平台协议。会话列表用 `end_ts` 向旧翻页，消息用 `end_seqno` 向旧翻页；安全整数 `msg_seqno` 是会话内身份，不使用超精度 `msg_key`。初见仅最近100条。后续从最新消息翻到本地已知水位或平台可见末尾，与 `readPreviousItem(remoteId)` 返回的旧域快照合并。此回调不暴露Store和SQL，Store不解析消息协议。整批采集成功后才由 `applyFetch` 事务写入完整不可变快照及来源metadata。已知水位不再可见时保留本地消息并明确可见性限制，不声明缺口完整。

消息存为已有按版本分页的 `comments` 行，额外投影作者ID、方向、类型和发送时间。非文字消息保留平台原始字段，可通过 `content(section: 'comment')` 分块读取。撤回消息只保留撤回占位，不保存平台返回的旧正文。轻量头投影联系人和采集范围，历史版本可分页阅读全部已采集消息。Cookie只向新增精确主机 `api.vc.bilibili.com` 转发，不调用发送或已读接口。

`WorkflowExecutor` 对私信只问Jev `importance` 四选项，校验完整归一化概率，保留真实输入输出。`contentInput` 仅输入最近100条，正文总计最多24000字符、单条2000字符，剔除完整payload/rawContent及重复body，显式记录范围和截断。图片、卡片等仅含文字及占位，不走图片模型链。固定摘要和概率理由不声称生成过内容摘要；低置信仅标注不足，不升级、不推断紧急性，`urgent:false/intervention:none`。最终序列化 `state` 超过 Jev 生效字符上限时例外：跳过 Jev，使用生成/分析模型的真实 `decision-escalation` 会话，仅提交 importance/certain/reason。该路径沿用 decision 阶段上下文与资料，按需查询也保持同阶段；工作记录保存 bypass 原因、字符数、上限及普通模型结果，不伪造概率。评论超限也直接进入此普通模型判断，保留后续拟稿与独立监督约束。

`canDraft(kind)` 统一限制受管提交、普通工作区、Store最终存稿、监督及发布。私信人工会话保留真实历史和读取工具，不安装存稿工具。人工阅读与评价学习显式复用全局生成模型路由，不增加自动整理阶段。私信来源不展示自动回复授权、拟稿、监督设置或草稿入口。

## 按来源授权的评论发布

`src/publication.js` 定义自动回复的固定身份前缀、独立审查规则和目标检查。来源 `autoReply` 位于普通默认值之外，新来源默认关闭，学习白名单不包含该字段。Jev 同时输出回复方式和独立重要程度。工作流保存 `decision.resolved`，升级仍不确定时不能获得自动发送资格。

自动草稿在入库前固定身份标识与目标，监督检查这份最终正文；工具收据只包含JSON可编码的字段。当前整理轮结束后只对本轮返回的有效新草稿检查自动发送，不扫描历史待审核草稿。平台连接器的 `beforeSend` 同步回调在队列和限流等待之后、实际POST之前复核当前来源revision、启用和授权、内容版本、分析revision、草稿状态与正文指纹。数据库claim在短事务中拒绝相同目标的既有sent/sending/unknown记录。

B站根评论作者以 `rootAuthorId` 身份元数据保存在内容项当前状态中，不进入内容指纹；补采这项身份不会改写不可变历史或制造内容变化。发送仍重取平台正文与讨论校验原版本，成功回执记录准确根楼、父评论和远端ID。

学习允许修改当前来源的 `settings.learningGuidance/language/replyStyle/reviewFocus` 与对应默认文字项。默认变更只使仍继承该字段且适用的来源旧草稿失效，现有分析和候选范围保留。实际生效语言、回复风格、PR审查重点以及自动回复授权参与输入contextVersion，防止旧规则的草稿通过版本检查。


### 进入会话处理

内容入口优先选择同内容、来源及当前工作区的 `writer/review/investigate` 会话，按最后关联的工作轮从新到旧查找。内容或来源背景更新不会让原工作会话丢失入口，也不重绑其 run、角色或版本。监督、决策升级和学习会话仍从各自工作记录进入。

跳转前核对绑定与宿主 live/cold 会话的 canonical cwd。确实缺失的身份跳过；持久化读取失败或宿主工作区与绑定不符时明确报错，不静默新建。打开原会话不恢复执行、不注入新消息、不触发模型，也不新建业务 run。没有有效工作会话时，仍按当前内容版本和背景版本复用人工会话；否则创建具有完整背景的人工会话。其他历史入口保留。

## 平台凭据 adapter

`src/credentials/index.js` 注册平台 adapter，`describe()` 返回字段、可用动作与已脱敏状态，`act(action, values)` 执行验证/保存/登录，`busy()` 表示设备授权仍在运行，`close()` 释放子进程。`GET /credentials` 与 `POST /credentials/:platform/:action` 位于既有宿主认证 HTTP 边界，能力白名单在调用前校验。前端 `CredentialsPanel` 只按声明渲染字段和动作，秘密字段始终为空密码输入；设备授权只显示固定平台地址、验证码和状态。

B站 adapter 复用 CookieTransport 与身份检查，临时0600文件验证成功后 rename 激活新连接器，原外部 cookieFile 不修改。已有私信 accountId 必须保持。GitHub adapter 用无 shell、固定参数的 gh 子进程执行设备流，丢弃原始输出，仅解析一次性验证码；不启动服务器浏览器，不向前端传令牌。全局凭据互斥与 ConsoleService 任务门禁防止轮次中切换身份，宿主卸载等待保存结束并终止登录进程。

来源的手动刷新与整理在前端按来源 ID 保留在途状态，切换页面不会丢失，同一来源防止重复提交，其他来源可独立操作。后端继续以来源为单位互斥；禁用按钮的悬停提示说明当前来源已有刷新或整理运行。


## 单项错误恢复

自动分析失败或中断且未采纳结果时，内容保存 organizationError（runId/version/message/at）和 autoOrganizationPaused=true，进入待处理。错误标签优先于已整理/未整理，旧分析仍保留。定时整理、刷新并整理、整理已有数据均跳过暂停项，采集新内容不解除暂停。

- POST /items/:id/organize 接收 {version}，强制只重跑当前条目，与该来源刷新/整理共用互斥锁。成功采纳后清错误并恢复自动整理；失败继续暂停。
- POST /items/:id/automation 接收 {paused}，手动暂停/恢复；有未解决错误时只能通过重新整理恢复。
- POST /items/:id/handling 只接受 none/pending/done。旧 later 一次迁移为 pending；既有已处理状态保留。旧 review 未确认项补入待处理，旧当前版本最后失败项补错误和暂停，历史 run/receipt/分析正文不改。

路径均位于 /api/dsh-message-console 下，沿用宿主认证和同源写入校验。

## GitHub 输入与按需读取

完整采集数据仍入库，初始模型输入不包含 PR patch/diff。文件只提供最多40个概要并声明总数、未读范围与工具入口；正文、讨论及审查意见使用有界摘录。来源规则要求委派时，Agent 可据此交给指定设备处理详情。

dmc_read_item 增加 section=files，按 page/pageSize 返回 filename/status/additions/deletions/changes/patchAvailable；section=file 按 filePath/offset/length 读取对应版本的已存 patch，每次最多32000字符。filePath 仅匹配数据库文件名，不读取服务器路径；未提供 patch 时明确 unavailable。普通工作区及受管会话保留来源访问边界。HTTP 对应 GET /items/:id/files 和 GET /items/:id/content?section=file&filePath=...。

旧 GitHub 会话在 system-prompt/assemble 原生钩子中，将当前上下文内本插件的完整旧输入替换为有界概要。仅真实运行且绑定有效时执行，不影响预览；保留原事件、message ID 和 sourceEventSeqs 派生引用。人工消息和工具记录不重写，后续冷恢复使用同一概要，不重复追加。


## 共享插件依赖

Assembler 1.1.3 与 Jev 0.3.6 由用户在同一 profile 依次安装并启用，再安装消息插件。消息插件通过必需的宿主服务 `dshPromptAssembler` 和 `decisionModels` 使用现有实例，不创建内嵌运行时。两者以 optional peer 声明兼容范围，避免 npm 自动安装；缺少服务时由 Cordis 依赖机制等待，不把它们视为可省略的功能。固定开发依赖仅用于隔离测试。

包验收分别检查：单独安装消息插件不会自动安装这两个插件；先安装依赖再安装消息插件时仍解析到原来的共享包，没有私有副本。
