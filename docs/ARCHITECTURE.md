# 架构与连接器合同

## 层次与依赖

```text
DSH Web slots / uiWorkspace
          │
          ▼
  HTTP API（宿主 connection.admit）
          │
          ▼
  ConsoleService ─── Store（单进程 JSON 原子事务）
       │       │
       │       └── WorkflowExecutor → DSH Agent / Jev / Prompt Assembler
       └── Connectors → GitHub网页 / B站视频接口 / 匿名REST回退
```

平台声明能力；来源保存目标、类型和覆盖配置；内容项保存稳定远端 ID、当前版本、阅读版本、处理状态与会话关联。抓取更新内容版本。首次完整抓取建立已读基线并令 `analyzedVersion` 等于当前版本，以跳过自动分析；此时 `analysis` 仍为空，不代表实际执行过模型。

`src/core.js` 不依赖 DSH。`src/dsh.js` 将工作角色映射到独立原生会话，保存会话引用后才执行；人工背景通过公开 `Session.append` 写入真实来源消息，不伪造模型输出或工具记录。每个版本的人工入口可新建会话，旧会话仍可查看。

## 宿主兼容边界

当前目标为 DSH `0.2.1-rc.2`、Cordis `4.0.5`，Assembler 标准 native 后端固定到 `1.1.2` 源码提交 `21183e18c9e8e7f7f01fda04b5af4218ce194539` 及锁文件完整性摘要。该补丁对装配、历史策略与 request-token API 显式要求 DSH owner 认证，保留 Host、Origin、JSON 和桌面 CSRF token 检查。包的 `engines.dsh`、DSH peer 和锁文件共同声明这一组合，不承诺旧宿主继续兼容。此适配不修改插件状态格式、不迁移真实历史，也不修改宿主核心。

新版宿主将工作目录等动态事实放在 runtime context。Assembler 兼容层保留旧文本策略的 `cwd` 变量，并保留宿主必需上下文；插件自身仍通过公开 `agents.create`、`followup`、`whenIdle`、`sessions.flush` 和 `Session.append` 驱动独立角色。尾部 PHI 使用真实 user/pre-step 消息。JSONL 持久化插件的新版入口是命名 `apply`，离线集成测试按模块加载，不再假定 default 导出。

模型目录继续使用 `llm.listProviders()` 和异步 `listModels(provider)`，只返回 provider/id/name。Jev 使用独立的 `decisionModels.config()` 白名单投影及 `ask()`；不因目录探测读取或返回密钥。第三方提供商的 peer/宿主兼容性由其自身声明，不能通过本插件的目录适配绕过。

## 连接器

```js
connector.status() // { ready, canPublish, reason }
connector.fetch(source, { signal }) // { complete: true, items: ContentItem[] }
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

`ready` 表示监督通过且仍待用户批准；`blocked` 表示监督拒绝。内容变化会将旧草稿标为 `stale`。用户批准绑定正文指纹与内容版本，发布前再读远端；写入 `sending` 后才请求平台。成功为 `sent`；确定未发送可回到 `ready`；无法确认则 `unknown`，重启后的 `sending` 也变为 `unknown`。

本版没有自动发布开关。平台内容、提示词中的要求以及监督判断都不能代替用户发布批准。

## 已知实现范围

当前完整快照与单文件持久化面向个人小规模使用；高频、大量来源需要后续增量同步和存储扩展。平台采集与模型执行的失败分别保留，不以模型成功掩盖采集过期。真实Cookie采集已验证；真实模型账号调用、全部目标插件共存和实际发布仍须完成集成验收。

## 宿主界面与会话归属

客户端注册 `sidebar.panellist` 和相同标识的 `main` 面板，使用 `uiWorkspace.openSession` 返回宿主会话。来源仅保存 `workspaceId`，不保存可漂移的工作目录副本。DSH适配器从 `workspaceRegistry` 解析已有工作区及其状态，创建会话时设置 canonical `cwd`，持久化后调用 `attachSession`，成功后才能唤醒模型。工作区缺失或目录不可用不会回退默认目录。来源改绑后，已有会话保留原归属，新会话使用新工作区；人工会话按内容版本、工作区及 `contextVersion` 共同复用。

## 视频资料与提示词边界

B站来源使用BV/av视频ID或视频链接。每个来源保存独立context、materials和postHistoryInstruction，资料可以是显式文本或工作区内非隐藏文件；解析符号链接后再次检查目录边界。资料内容摘要参与contextVersion，变化后旧审核失效。

DSH通过Assembler native前置system定义任务与不可信输入边界，pre-step追加user角色的post-history提醒；这是宿主支持的真实尾部消息，并非system优先级。每个角色自己的历史持久化。Jev独立请求中同样加入可信规则。平台正文仅进入数据，不参与构造可信尾部指令。此机制降低提示词注入风险，不能保证模型永不受影响；工作Agent不开放工具，对外发布仍必须单独批准。

## 来源输入合同

来源增加以下可选字段，旧来源缺少时使用默认值。

| 字段 | 合同 |
| --- | --- |
| `description` | 来源简介，最多 1000 字，默认为空 |
| `tags` | 最多 12 个非空标签，每个最多 40 字，默认空数组 |
| `stageContexts` | 按 decision、escalation、generation、supervision 保存可选 context 和 materials，默认空对象 |
| `inputOrder` | `source`、`context`、`materials`、`content` 各出现一次的排列，默认按此顺序 |

`src/input-assembly.js` 是浏览器与服务端共享的纯函数模块。`assembleInput(source, item, { language, stage })` 生成有序 `blocks`，每个块具有 `key`、`label` 与 `value`。`serializeInput(input, extras)` 将块和当前步骤附加数据序列化。资料按 `resolvedMaterials` 的数组顺序装入，不重复装入原始文件配置。

来源信息块包含名称、平台、目标、简介、标签及关注规则。当前内容块白名单保留采集的 ID、类型、标题、正文、URL、完整 payload、内容版本、变化时间及前版原文，不携带插件内部 analysis、draft、sessions 或个人处理状态。Agent 的真实 user 消息外层保持 `{ role, input }`。升级判断的 `decision` 和监督的 `draft` 各追加一次。人工背景通过同一组装函数写入真实 user 历史。Jev 的 `state` 使用相同顺序的块，可信 PHI 留在问题 `instructions`。数据块顺序不会改变消息角色或提升平台内容的可信级别。

`POST /api/dsh-message-console/sources/preview` 接收 `{ source, sourceId?, itemId?, stage? }`。`source` 是尚未保存的来源表单，另可传 `stage`，默认 `generation`，验证与保存共用相同合同。已有来源必须匹配平台、目标及类型。内容项只从服务端状态中读取，并验证归属。新来源无 `sourceId` 时不能指定实际内容项。预览经 `workspaces.resolve` 和 `prepareSource` 解析显式文件，沿用隐藏目录、符号链接、文本类型及大小限制，不改变状态。

响应包含 `{ input, serialized, postHistory, itemId }`。无内容项时 `content` 块明确占位；浏览器本地预览尚未解析的文件只展示路径和未读取状态。预览中的 system、历史及步骤附加数据为固定位置说明，不伪造宿主或供应商的完整请求。客户端用请求版本号丢弃修改表单前发出的过期响应。

`contextVersion` 包含规范化的 `inputOrder`、名称、简介、标签、上下文、关注规则、资料正文指纹、全部阶段背景与资料正文指纹及补充 PHI。保存这些语义变更时，旧待审核草稿变为 `stale`，已有分析的内容重新成为可整理状态，阅读版本不变。成功分析记录 `analyzedContextVersion`；后续整理也比较实际解析后的资料版本，因此显式文件内容变更可触发既有分析的更新。自动整理不会因资料调整全量分析没有真实分析的首次基线。手动整理已有数据可以处理这些历史内容。运行期间来源配置变化时，旧输入的结果标记为过期。

## 总览统计与导航

`src/dashboard.js` 统一计算来源与平台统计。综合分数为当前版本重要性乘 10，加上有依据的紧急性修正 3，再以需要处理数、未读数、`changedAt` 和稳定 ID 排序。最近更新模式以 `changedAt` 为首键，`fetchedAt` 只用于显示抓取状态。旧内容版本的分析不参与摘要、重要性或紧急性判断。

未读数与需要处理数均按内容项 ID 去重。待处理和暂后处理会计入；尚未关闭的 `ready`、`blocked`、`stale`、`sending`、`unknown` 草稿也会计入同一内容项。“本轮已处理”阻止旧人工介入分析重新产生待处理计数，但不能代替关闭尚存草稿。

`src/client.jsx` 用单个页面状态选择总览、全部平台、全部来源、平台来源、来源详情、全局配置、新建或编辑来源。插件没有内部侧边栏。`src/dashboard-view.jsx` 展示列表和内容项，`src/source-editor.jsx` 负责来源表单及可排序的真实输入预览，`src/ui-shared.jsx` 保存通用字段与请求组件。

## 手动与自动整理范围

`ConsoleService.organize(sourceId, { scope })` 默认使用 `changes`。调度器与 `refresh` 显式使用此范围，只处理内容版本尚未分析或已有分析的真实背景版本已变化的内容。`POST sources/:id/organize` 显式选择 `history`，额外包含 `analysis` 为空的历史基线，仍跳过内容与背景都已完成的项。来源的刷新或整理正在运行时，同来源新请求明确返回忙碌错误，不复用另一个范围的 Promise。

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
| 人工处理 | 用生成路线创建真实 DSH 会话背景，创建时不唤醒模型，原有历史完整保留 |

生成与分析阶段的摘要和正文来自同一次输出，没有独立总结路由。各阶段共享完整的基础数据块与顺序，只追加当前阶段的专属背景，角色任务指令不同。共用原文及讨论不裁剪，Jev 不接收其他阶段的专属背景。DSH 的 API 连接配置与本插件的 provider/model 选择是两件事。生成路线缺失不阻止 Jev 独立分流，只有实际进入需要该路线的阶段时才产生对应错误，并保留此前的 Jev 记录。

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

Jev 使用 `decision`，一次低置信升级使用 `escalation`，各内容类型的生成和分析使用 `generation`，独立监督使用 `supervision`。人工会话明确使用 `generation`，创建时写入真实背景但不唤醒模型。角色指令、尾部 PHI 与可信边界保持固定。预览使用同一装配函数，升级 decision 和监督 draft 展示明确的占位，不能视为真实执行输出。

## 终止错误与冷会话目录

`src/dsh.js` 从真实 `turn/end.reason` 读取终止结果。失败时保留宿主 `error.code`、`message`、可用 `status` 以及原 `sessionId`，错误附带 `sessionFailure`。业务层将该结构保存在 `run.failure`，来源本轮统计也带回失败会话 ID。没有本轮 `turn/end` 时使用单独的 `MISSING_TURN_END`，不与模型返回格式错误混淆。

宿主 provider 可能在转成流终止结果时只保留公开错误，插件不推测已经丢失的底层 cause，也不把所有 `TRANSPORT` 硬编码成某个网络错误。会话保留真实的 request、attempt、retry 和 turn 记录；失败不会导致伪造成功输出或自动更改路由与网络配置。

`AgentHandle.dispose()` 会释放实时 Agent 和附着 Session，但不会删除已持久化历史。当前宿主的 `session/disposed` 会向前端发布 removed，普通会话行随即消失，真实冷目录仍可从 `sessionPersistence` 和 `sessionQuery` 读取。Session ID 的 `dmc-` 前缀不是持久列表限制，不更换已有身份。

客户端 `apply(ctx)` 的插件生命周期持有 `src/session-directory.js`，通过公开 `ctx.sessions.refresh()` 更新宿主共享目录。`GET session-directory` 仅返回本插件已结束及人工会话的 ID；运行中角色暂不纳入。客户端每五秒读取这份小清单，签名未变时不更换监听，也不因来源状态轮询重复刷新。

监听使用共享目录的真实 `ids` 判断缺失。晚到的 removed 帧可能覆盖进行中的目录拉取，因此缺失的一轮最多进行两次拉取；确实不存在的身份或读取错误不会循环重试。清单读取失败保留之前的 ID 和监听。插件卸载时清理定时器与订阅，忽略尚未完成的响应。主视图切到宿主会话不会停止这项恢复。整个过程不创建新 Session、不重放或合并历史，也不将普通工作会话伪装成子 Agent。
