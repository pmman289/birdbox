# eBGP / iBGP / OSPF 流程与旧数据实测（2026-10-19）

本记录针对当前工作区代码，生产节点和生产数据库未参与测试。验收覆盖正常生命周期、异常恢复和历史库存，不将模拟运行态作为真实邻居建立的证据。

## 实测环境

| 层级 | 环境 | 验证内容 |
| --- | --- | --- |
| 原生协议 | Debian 12、隔离 Docker 网络、安装脚本部署的 Go Agent、BIRD 2.17.5 / 2.19.0 | 每版分别运行 eBGP、iBGP、OSPF 完整生命周期，检查实际邻居、路由和原生配置预检 |
| 浏览器 | Chromium 桌面 / 手机，含 375/390/430px | 编辑、预检、确认、失败保留草稿、CAS、过期响应和对象切换；错误注入使用模拟 API |
| 浏览器至服务端 | 独立内存 Demo、真实 HTTP 和服务端服务、模拟 Agent | 创建、编辑、预检无写入、明确确认、运行态/路由抽屉、停用恢复、删除 |
| 持久化 | 临时 MySQL 8.4.11、JSON 序列化数据库和内存数据库 | 历史库存升级、重复启动、revision 幂等和提交响应丢失核对 |

## 本轮发现并修复

1. 旧 OSPF 的各节点 Area 参数在转换为拓扑模型后，原样预检也可能统一为第一个节点的值。现在保留未改动 Area 的各节点设置，修改节点参数不会顺带修改其它节点的 Area。
2. Area 前缀转换丢失 `hidden` 等属性；显式清空前缀可能被旧 options 恢复；Stub/NSSA 切回 Normal 可能被旧标志覆盖。现在保留前缀属性，并正确处理明确的类型修改和空列表。
3. OSPF 未设置的可选字段包含 `undefined`，MySQL JSON 会省略这些字段。直接比较内存对象曾导致每次重启递增 revision，也可能将已提交但响应丢失的操作误报失败。库存比较现在遵循 JSON 持久化语义，仍保留 CAS 和版本保护。
4. 真实 HTTP 浏览器复验捕获到刷新后立即点击 eBGP 应用时，后台预检可能吞掉打开确认窗口的请求。显式应用现在等待共享的预检任务，并再次校验上下文与草稿签名；仍须用户明确确认，编辑中的旧候选不能被应用。增加确定性的竞争回归用例。

## 旧数据验收

`test/bgp-ospf-compatibility.test.js` 覆盖 v22/23/28/30 的存量 eBGP、iBGP 和 OSPF：

- 启用与停用各一组，保留资源 ID、节点归属、两端独立端口/策略、单栈/双栈和认证凭据。
- v22 iBGP 的 `address4/address6` 升级为单传输地址，原有邻接不增不减。
- 升级、启动、读取和重启不联系节点；预检只 stage，不 apply、不写库存。
- 通过公开 API 重新打开、预检并确认保存，无意图修改时完整协议声明保持一致；独立 BGP 声明的先后次序与空行不作为语义差异。
- OSPF 两端 Priority 和各节点 Area 的独立设置保持不变；脱敏重载和保存保留真实密钥。
- MySQL 上重复启动不改变 revision；注入提交响应丢失后，核对持久化值并正确确认成功。
- Direct、Kernel、Pipe、Static 不因这些协议升级或编辑而凭空新增。

原有 `test/upgrade-safety.test.js` 继续覆盖 v2/8/10/14/18/19/20/22/23/25/26/27/28/29/30/31，确保集合缺失或为空时不自动补建协议，并保留已存在 Kernel 的历史默认策略。

## 原生结果

- eBGP：真实双栈 Established、实际 IPv4/IPv6 路由；Define → Function → Filter 设置真实 Local Preference 和 Community；拒绝 IPv4 后 IPv6 保留；过期 CAS、非法原生配置、停用、恢复及删除。
- iBGP：两台 Agent 的同 ASN 会话和独立 1179/2179 端口；实际双栈路由、RR 参数、逐端策略及依赖保护；原生 `show bfd sessions` 两端均为 Up；范围缩减清理旧节点、停用恢复和删除。
- OSPF：两台 Agent 的 v2/v3 Full 邻居和实际双栈外部路由；实际 Area 类型/接口/完全邻接统计；独立 Priority；v2 Filter 拒绝且 v3 保留；v2 MD5 认证；草稿与布局无部署；清空成员和删除清理旧节点。

两版均运行 `bird -p`。当前未安装 birdcc，未执行其 lint。实验没有接管宿主机 BIRD、路由或防火墙。真实传输覆盖 Agent，SSH/local 部署、TCP MD5/AO 的 BGP 握手及一小时压力测试不在本轮实测范围内。

## 执行结果

- 前后端类型检查、生产构建、`git diff --check` 通过。
- Node 24 全量单元/API：380 项全部通过，启用临时 MySQL，无跳过。新旧数据专项包含在其中。
- 三类协议的桌面/移动工作区浏览器回归：62 项通过；修复 eBGP 应用竞争后，eBGP 专项 22 项再次全部通过。
- 真实 HTTP 浏览器生命周期：桌面/移动 6 项通过。eBGP 完整生命周期另按桌面/移动各重复 3 次，6 次全部通过；重试不是测试的自动失败重跑。
- eBGP 应用竞争的确定性回归：桌面/移动 2 项通过。
- 三类协议 × 两版真实 BIRD：6 组全部通过；OSPF 与 eBGP/iBGP 均在服务端修复后复跑。
- Agent `go test -race ./...` 和 `go vet ./...` 通过。
- 临时 Agent/BIRD 容器、Docker 网络、MySQL 和本轮验收服务已清理。

## 复现

```bash
npm run build
BIRDBOX_TEST_MYSQL_URL='mysql://<isolated-test-database>' npm test
BIRDBOX_E2E_PORT=31063 npx playwright test \
  test/e2e/ebgp-management.spec.ts test/e2e/ibgp-management.spec.ts \
  test/e2e/ibgp-workspace.spec.ts test/e2e/ospf-workspace.spec.ts \
  test/e2e/ospf-review.spec.ts

# 在独立终端启动模拟验收服务，再执行真实 HTTP 浏览器用例。
BIRDBOX_DEMO_PORT=31064 npx tsx scripts/static-demo.ts
BIRDBOX_STATIC_URL=http://127.0.0.1:31064 npx playwright test \
  --config playwright.static.config.ts \
  test/live/ebgp-live.spec.ts test/live/ibgp-live.spec.ts test/live/ospf-live.spec.ts

for protocol in ebgp ibgp ospf; do
  for version in 2.17.5 2.19.0; do
    BIRD_VERSION="$version" bash "scripts/$protocol-e2e.sh"
  done
done
```

需 Node 24、Docker 和 Playwright Chromium。MySQL 必须为专用临时实例。原生脚本退出时清理各自容器、网络与临时文件；浏览器验收服务和 MySQL 由本轮结束时单独停止。
