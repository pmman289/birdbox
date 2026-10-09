# OSPF 管理重设计与验收

目标：完成域管理、节点配置、链路与 Area 编辑、双栈策略、权威配置预览、可靠部署和运行态诊断的完整闭环。

## 已确认的旧设计缺陷

- Export `all` 在规范化时变成 `none`；现有模拟 API 浏览器测试不能发现实际策略改变。
- 链路存在即强制启用端点，用户无法保留拓扑并停用某个节点的 OSPF。
- 两端共用接口选项和 NBMA 邻居列表，使用 Router ID 猜测邻居地址。
- 前端自行生成第二份配置，协议名、高级字段、策略顺序与后端可能不同。
- 域加载、节点切换、运行态和接口请求没有统一草稿生命周期；旧响应可能覆盖新选择。
- 布局写入争抢部署锁，草稿把全部受管节点加入每一个域。
- 协议状态从邻居表推断，不能区分已启动但尚无邻居与协议不存在。

## 设计约束

1. 共享契约是唯一持久化模型；前端草稿独立深复制，加载与请求失败必须可见。
2. 链路建立时启用所选端点；之后明确停用必须保留。新域只包含用户选定节点。
3. 每节点、每版本、每接口独立配置；公共链路字段继续读取旧库存，新增端点字段有明确覆盖顺序。
4. `dead` 表示秒；显式 count 模式必须保持其精确含义，不能静默取整。
5. NBMA/PtMP 邻居采用实际接口地址，不能从 Router ID 自动推导。共享接口参数必须一致；编辑器新建并行链路默认使用无需静态邻居的 PtMP，显式 NBMA 必须提供对应协议地址族的邻居。
6. 策略和资源验证在写入前完成；旧库存原位可读，不自动创建 Direct/Kernel/Static。
7. 前端显示服务端生成的候选配置；自动预览只渲染，手动预检调用原生 BIRD，应用重新预检。
8. 创建、更新、删除沿用 DeploymentService 的持久日志、CAS、回滚和重启恢复。
9. 运行态按协议和地址族读取真实状态、邻居、路由和接口；节点错误不能隐藏其它节点结果。
10. 拓扑与路径查询支持缩放、拖动、平行链路、失败原因、环路和多下一跳，过期请求不更新当前域。

## 验证范围

| 功能 | 完成证据 |
| --- | --- |
| 空域、新建、重命名、切换、删除、多域隔离 | 真实应用服务/API测试与浏览器流程 |
| 添加/移除成员、启停、Router ID、v2/v3/双栈 | 领域测试、原生解析、刷新后的浏览器草稿 |
| 两端接口、Cost、定时器、类型、认证、BFD与接口选项 | 参数化领域/解析测试、端点隔离浏览器测试 |
| Area、Stub/NSSA、前缀、虚链路、密码选项 | 合法/非法输入测试及 BIRD 解析 |
| Import/Export、Define、Function、Filter、静态重分发 | 真实规范化/渲染/API与浏览器策略测试 |
| 配置实时预览、远端预检、保存与错误恢复 | 前后端配置比对、旧响应隔离、浏览器验证 |
| 部署失败、CAS、回滚、恢复、并发布局 | 执行器故障注入及现有生命周期测试 |
| 邻居、协议、路由、接口、Area与路径诊断 | 原始 BIRD 输出解析、真实隔离实验与浏览器验证 |
| 历史库存、凭据脱敏、非 OSPF 资源边界 | fixture、认证/API和跨资源回归 |
| 桌面/移动、大拓扑、长轮询与队列界限 | Playwright与运行态压力测试 |

## 验收记录

- 领域与渲染回归：`NODE_ENV=test BIRDBOX_DATABASE_URL=memory: NODE_OPTIONS=--import=tsx node --test test/ospf.test.js`，46 项通过。
- 运行态隔离与轮询：`NODE_OPTIONS=--import=tsx node --test test/ospf-runtime-isolation.test.js`，3 项通过。
- 全量 Node 测试：`NODE_ENV=test BIRDBOX_DATABASE_URL=memory: NODE_OPTIONS=--import=tsx node --test`，211 项中 210 项通过、1 项按环境跳过；OSPF 专项 46 项全部通过。
- 类型、构建与浏览器回归：`npm run typecheck:server`、`npm run typecheck:web`、`npm run build` 均通过；`npm run test:e2e` 为 20 项通过、2 项默认跳过的压力测试（桌面和移动各执行一次）。
- Agent：`cd agent && gofmt -w bird.go && go vet ./... && go test ./...` 通过。
- 本机原生解析器：`/usr/sbin/bird -p`，BIRD 2.17.5；已用实际解析器覆盖 OSPFv2/v3 高级选项、认证、RFC5838 Instance ID、虚链路 Instance ID、重传/等待时间边界。`birdcc` 未安装，因此未声称覆盖其额外规则。
- 安全与差异检查：`npm audit --omit=dev --audit-level=high` 无高危漏洞，`git diff --check` 通过。
