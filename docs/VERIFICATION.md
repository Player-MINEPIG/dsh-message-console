# 开发预览与验证

[返回项目首页](../README.md)

## 本地开发与预览

维护使用 `dev` 开发集成基线和 `main` 正式基线。分支、正常 Linux 测试、AWS 部署与正式验收步骤见[开发与维护流程](DEVELOPMENT.md)。

Node.js `^22.19.0 || >=24`，DSH `0.2.1-rc.2`，Cordis `4.0.5`。本版本仅声明这一宿主组合的兼容性，不自动升级宿主。首次使用新版存储时会迁移本插件的旧 JSON 数据，见[数据迁移说明](STORAGE.md)。

```sh
npm ci
npm run check
npm run demo
```

打开 `http://127.0.0.1:3147`。预览使用合成数据和模拟模型，不读取真实账号，不发送消息。每次启动创建独立模拟数据目录；数据、构建临时文件都留在被 Git 忽略的 `.local/`。

## 验证与扩展

`npm test` 覆盖状态、并发审核、发送不确定性、失败恢复、GitHub 协议和 HTTP 入口。开发依赖锁定[安装说明](INSTALLATION.md)中的 Assembler 1.1.3 发布包和 Jev 0.3.6 提交，默认运行 native/custom 共享服务到工作流与持久记录的离线测试；native 使用真实 DSH LLM 服务和合成适配器，custom 拦截 HTTP 并返回合成响应，生成与监督使用合成执行器。可使用本机 DSH 安装执行额外的离线宿主测试（不加载默认 profile 或真实模型凭据）：

```sh
DMC_DSH_ROOT=/absolute/path/to/dsh-install node --test test/host.test.js
```

宿主测试使用真实 Agent Loop、标准 Assembler、工作区、JSONL 持久化和冷会话查询，检查标准工具组件、业务工具绑定、输入顺序、尾部 PHI、必需运行上下文及模型目录白名单。宿主测试还覆盖原生工具直接保存 SQLite、独立监督、人工背景重复冷恢复、只读与计划模式拒绝提交，以及存储目录的可写边界检查。模型输出来自离线合成适配器；这些检查不代替 Web 和真实账号验收。未设置该环境变量时，此测试跳过。

使用同一固定 Jev 开发依赖验证指定宿主的服务挂载、profile 目录和经宿主合成模型的调用，不读取凭据或联网：

```sh
DMC_DSH_ROOT=/absolute/path/to/dsh-install \
node --test test/host.test.js test/jev-host.test.js
```

这些测试验证合同与分流，不证明真实模型判断准确。Jev 拒绝缺失概率的响应后，本插件保留实际错误且停止后续生成；native 上游流失败在当前 Jev 中可能仅返回“native 响应不完整”，无法从 `ask` 恢复原始错误详情。

业务模型、连接器和宿主执行层分离，新增平台需要实现代码适配。详见 [架构与连接器合同](ARCHITECTURE.md)。本项目采用 [MIT](../LICENSE)。

发布包安装检查 `npm run test:package` 覆盖依赖缺失时不自动安装、按顺序安装后复用同一依赖实例，并核对包文件和入口。完整 Linux 验证使用 `npm run test:ci`，不能以跳过宿主测试的普通 `npm test` 代替。
