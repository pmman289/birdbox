# Birdbox 生产就绪审计报告

> 审计对象：<https://github.com/pmman289/birdbox>（`main` 分支，提交 `9f59b31`，package 版本 `0.38a`）
> 审计范围：后端（Fastify / TypeScript）、Agent（Go）、节点准备脚本、前端关键调用链、Docker/Compose 与发布脚本、文档
> 审计方式：逐文件阅读源码 + 本地 `tsc` / `vue-tsc` 类型检查 + `node --test` 单元测试 + `npm audit`
> 审计目标：列出阻碍生产可用的问题，给出可直接落地的代码修改；**对可能改变现有流程的修改单独标注风险与灰度方式**

---

## 0. 结论速览（审计快照，修复前）

**整体评价：** 代码质量明显高于同类个人项目。以下几项做得好，修改时应当保持：

- **部署事务**：部署前先预检，写恢复日志，写库时用 CAS 提交，失败时按逆序回滚，进程重启后可以按日志恢复（`deployment-service.ts`）。
- **输入校验**：路径、ID、主机名、IRR 名称都有严格正则；Agent 的结构化 RPC 统一用 `exec.Command` 固定参数位，不经过 shell。
- **认证**：scrypt 加盐；会话 token 只存 SHA-256；Cookie 设置 `HttpOnly`、`SameSite=Strict`；有 Origin 同源校验和完整的安全响应头（CSP 等）。
- **容器**：非 root 运行、`read_only`、`cap_drop: ALL`、`no-new-privileges`、`tini`，停机宽限期与部署超时相匹配。
- **数据库**：Schema 契约校验、迁移锁、拒绝降级写入。
- **测试**：158 个用例，覆盖历史库存升级链路。

以下结论对应报告最初审计提交 `9f59b31`，描述的是修复前状态；当前工作树的复核结果见第 12 节，发布 checklist 见 `docs/production-readiness-checklist.md`。

**审计时不能直接用于生产。** 按严重程度汇总：

| 级别 | 数量 | 含义 |
|---|---|---|
| **P0（阻断）** | 4 | 会导致服务无法启动、配置下发不了、进程崩溃或信息泄露，上线前必须修复 |
| **P1（高）** | 8 | 在常见生产场景（OpenWrt、大前缀集、网络抖动、多节点部署）下出现故障，或存在较大安全面 |
| **P2（中）** | 10 | 健壮性、运维性、纵深防御方面的问题 |
| **P3（低）** | 9 | 优化、文档和工程化 |

---

## 1. 本地验证结果（审计快照，修复前）

| 项目 | 结果 | 说明 |
|---|---|---|
| `tsc -p tsconfig.server.json --noEmit` | ✅ 通过 | 严格模式，无类型错误 |
| `vue-tsc --noEmit` | ✅ 通过 | |
| `node --test`（`NODE_ENV=test`，内存数据库） | 137 通过 / 16 失败 / 5 跳过 | 16 个失败**都是审计机环境造成的**：Windows 路径、缺少 `bird` 二进制、UNIX Socket 路径超长。与代码缺陷无关，建议在 Linux CI 中复核 |
| `npm audit` | ⚠️ 1 high、1 moderate | `fast-uri`（high）和 `fastify <= 5.12.0`（moderate），`npm audit fix` 可修复，详见 P1-8 |
| Go Agent | 未编译（审计机无 Go） | 以下 Go 结论都基于源码阅读 |

---

## 2. 问题总表

「兼容影响」一列说明修复后现有流程是否会变化：**无**＝行为完全兼容；**低**＝只影响异常路径；**⚠️ 谨慎**＝会改变现有用户可见行为，需要灰度或配置开关。

| ID | 级别 | 模块 | 问题 | 兼容影响 |
|---|---|---|---|---|
| P0-1 | P0 | server.ts | 部署恢复在 HTTP 监听之前执行。Agent 节点有未完成部署时，服务永远无法启动（崩溃循环） | ⚠️ 谨慎（启动语义变化） |
| P0-2 | P0 | agent/client.go | Agent 读取轮询响应的上限只有 2 MiB，而控制器允许 16 MiB 任务参数。大 IRR 前缀集无法下发，任务会被静默丢弃 | 低 |
| P0-3 | P0 | http/application.ts | 未登录请求触发的错误响应会附带全部变更事件（`events`），造成信息泄露 | 无 |
| P0-4 | P0 | server.ts | IRR 调度器没有捕获库存读取异常，数据库抖动时触发 `unhandledRejection`，进程直接崩溃（可能恰好在部署中途） | 无 |
| P1-1 | P1 | mutation-routes / agent | Agent 自升级的 `url`、`targetPath`、`service` 完全由浏览器提交，Agent 会以 root 身份把任意二进制写到任意路径 | 低（服务端固定参数） |
| P1-2 | P1 | agent/bird.go | Agent 从不清理 `versions/` 历史文件，OpenWrt 闪存会被写满 | 低 |
| P1-3 | P1 | agent/bird.go | apply 删除资源时不保存 `.rollback`，并且残留旧 `.rollback`。跨节点回滚会失败 | 低 |
| P1-4 | P1 | agent-broker / agent-routes | 长轮询连接断开后，waiter 没有被移除，派发给它的任务丢失，只能等超时 | 低 |
| P1-5 | P1 | http/application.ts | `connectionTimeout: 60000` 会切断耗时超过 60 秒的部署或升级请求 | 低 |
| P1-6 | P1 | Dockerfile / 准备脚本 / 前端 | MIPS 使用 hardfloat；`uname -m` 无法区分大小端；mips64le 被映射成 mips64；前端遇到未知架构时回退为 amd64 | ⚠️ 谨慎（仅新装节点） |
| P1-7 | P1 | 通信 | 默认使用明文 HTTP。Agent token 明文传输，中间人可以向所有节点下发 root 级任务 | 低（告警与可选 CA 固定） |
| P1-8 | P1 | 依赖 | fastify / fast-uri 存在已知漏洞 | 低 |
| P2-1 | P2 | node-onboarding | 生成准备脚本时可以覆盖已存在节点的 Agent token，导致在线节点掉线 | ⚠️ 谨慎 |
| P2-2 | P2 | auth-routes | 登录限流按 socket 地址计算。放在反向代理后所有人共享一个配额，攻击者可以持续锁死管理员 | 无（默认不启用） |
| P2-3 | P2 | auth | 首次初始化没有任何保护，谁先访问谁设置管理员密码 | 无（可选开关） |
| P2-4 | P2 | irr 同步 | 解析成功但部署失败时没有退避，每分钟重跑 bgpq4 并向全部节点重新预检 | 低 |
| P2-5 | P2 | ospf / render | `passwordOptions.algorithm` 和 `id` 未经校验就拼进 BIRD 配置；`txDscp` 没有范围校验 | 低（只在渲染阶段校验） |
| P2-6 | P2 | agent/bird.go | Socket 不存在时 `socketGID` 硬编码返回 999，会把配置文件的属组设成任意组 | 低 |
| P2-7 | P2 | 准备脚本 | Agent 脚本吞掉 `configure` 失败；include 判断不识别注释；摘要只校验首字符；没有创建 `/usr/local/bin` | ⚠️ 谨慎 |
| P2-8 | P2 | node-executor / agent | `legacy.exec`（root shell）已经没有业务调用方，但仍然默认开放 | ⚠️ 谨慎（默认保持开启） |
| P2-9 | P2 | server.ts | `BIRDBOX_PUBLIC_URL` 未做校验；默认的回环地址会被写进远端节点的脚本 | 无 |
| P2-10 | P2 | agent | Agent 可以写任意绝对路径，没有路径白名单 | 低（未配置时保持兼容） |
| P3-1 | P3 | agent/main.go | 每轮轮询都重复注册；401 时立即 `Fatal` 退出造成重启风暴；不检查任务 `deadlineAt` | 低 |
| P3-2 | P3 | agent/bird.go | `atomicWrite` 没有 fsync，路由器掉电后可能留下空文件 | 无 |
| P3-3 | P3 | agent/bird.go | 预检期间会临时替换活动符号链接，崩溃窗口内可能留下未校验的配置 | ⚠️ 设计级 |
| P3-4 | P3 | agent-broker | 对离线 Agent 不做快速失败，后台查询全部等到超时 | 低 |
| P3-5 | P3 | API | TCP-MD5、OSPF 等密钥明文回显到浏览器 | ⚠️ 谨慎 |
| P3-6 | P3 | 可观测性 | 没有变更审计日志，也没有全局 `unhandledRejection` 处理 | 无 |
| P3-7 | P3 | 架构约束 | Agent Broker 和锁都在进程内存里，只支持单副本，但文档未写明 | 无 |
| P3-8 | P3 | 工程化 | 没有 CI；镜像构建不跑 Go 测试；基础镜像未固定 digest；版本号 `0.38a` 不是 semver | 无 |
| P3-9 | P3 | 文档/杂项 | README 与 Compose 的 Secure Cookie 默认值不一致；静态资源没有缓存；服务端依赖了用不到的 `pinyin-pro` | 无 |

---

## 3. P0 —— 上线前必须修复

### P0-1 部署恢复先于 HTTP 监听：Agent 节点有未完成部署时服务无法启动

**位置：** `src/server.ts:207`（`await deploymentService.recover()`）与 `src/server.ts:227`（`await app.listen(...)`）

**问题：**
`recover()` 发现有未完成的部署日志时，会重放 `stageAndValidate` 和 `applyStagedConfig`。对 Agent 节点而言，这两步都要经过 `agentBroker.dispatch()` 把任务放进队列，**等 Agent 通过 `/api/agent/tasks/poll` 来取**。但此时 HTTP 服务还没开始监听，Agent 不可能连上来。结果依次是：

1. 每个任务等满 60 秒后超时；
2. `recover()` 抛出异常；
3. 顶层 `await` 的 rejection 使进程退出；
4. `restart: unless-stopped` 让容器重启，又回到第 1 步，**永久崩溃循环**。

触发条件很常见：部署过程中控制器被 OOM kill、宿主机重启、`docker compose up --force-recreate` 打断了进行中的部署。P0-4 的崩溃也会触发它。

**修改（`src/server.ts`）：** 改为先监听，再在后台带退避重试恢复。恢复运行期间，`withDeploymentLock` 本身会拒绝其他变更（409 或 503），因此不需要额外的保护。

```ts
// ---- 原代码 ----
// await controllerSshIdentity.initialize(recoveryNodes);
// await deploymentService.recover();
// const app = await createHttpApplication({ ... });
// await app.listen({ port, host });

// ---- 修改后 ----
await controllerSshIdentity.initialize(recoveryNodes);

let recoveryState: "idle" | "pending" | "failed" = pendingDeployment ? "pending" : "idle";

const app = await createHttpApplication({
  // ...原有参数不变...
  isDeploymentLocked: () => deploymentLocked || recoveryState !== "idle",
  recoveryState: () => recoveryState,          // 新增，可选：暴露给 /api/health
});

await app.listen({ port, host });
logger.info("Birdbox 服务已启动", { host, port, version: appVersion, recoveryPending: recoveryState !== "idle" });

async function recoverWithRetry(): Promise<void> {
  let delayMs = 5_000;
  while (!shuttingDown) {
    try {
      await deploymentService.recover();
      recoveryState = "idle";
      return;
    } catch (error) {
      recoveryState = "failed";
      logger.error("未完成部署恢复失败，稍后重试", { retryInMs: delayMs, ...errorContext(error) });
      addEvent("error", `未完成部署恢复失败：${error instanceof Error ? error.message : String(error)}；${Math.round(delayMs / 1000)} 秒后自动重试`);
      await new Promise<void>((resolve) => { const t = setTimeout(resolve, delayMs); t.unref(); });
      delayMs = Math.min(delayMs * 2, 300_000);
    }
  }
}

// 没有恢复日志时 recover() 立即返回，与原行为一致
if (pendingDeployment) void recoverWithRetry();
else await deploymentService.recover();
```

`src/http/dashboard-routes.ts` 的健康检查建议同时暴露恢复状态。这里继续返回 200，避免编排系统在恢复期间反复重启容器：

```ts
app.get("/api/health", async (_request, reply) => {
  await options.ping();
  return jsonReply(reply, 200, {
    status: "ok",
    deploymentLocked: options.isDeploymentLocked(),
    recovery: options.recoveryState?.() ?? "idle",
  });
});
```

> ⚠️ **兼容说明：** 原来恢复失败时容器起不来，运维能马上发现。修改后服务正常运行，但**所有变更操作会被锁定**，直到恢复成功，同时事件栏会持续显示恢复失败的原因。建议：
> 1. 在前端顶部横幅中展示 `recovery !== "idle"`；
> 2. 监控系统根据 `/api/health` 中的 `recovery` 字段告警；
> 3. 如果部署只涉及 SSH 节点，恢复逻辑本身不变，只是改成了后台执行。
>
> 另外要注意：「库存与日志均不匹配」这类错误无法靠重试解决，重试循环会持续告警，需要人工从备份恢复。这一点与原设计一致。

**补充测试：** 在 `test/deployment-lifecycle.test.js` 中增加用例。构造一个 `direction: "forward"`、目标为 Agent 节点的日志，启动服务，然后断言：`/api/health` 返回 200；Agent 注册并轮询后，恢复完成；恢复前 `POST /api/statics` 返回 503。

---

### P0-2 Agent 的轮询响应上限 2 MiB，而任务参数上限是 16 MiB

**位置：**
- `agent/client.go:79`：`io.ReadAll(io.LimitReader(resp.Body, 2*1024*1024))`
- `src/agent-broker.ts:57`：`MAX_TASK_PARAMETER_BYTES = 16 * 1024 * 1024`
- `src/http/agent-routes.ts:85`：结果回传的 `bodyLimit` 是 16 MiB，而 Agent 的 stdout 和 stderr 各自最多 8 MiB，再经过 JSON 转义，有可能超过这个值

**问题：** `bird.stage` 和 `bird.apply` 的参数里包含完整的主配置和全部 Define 资源。一个大型 AS-SET 展开 10 万条前缀，大约就有 2.5 MiB 以上。响应被截断到 2 MiB 后，`json.Unmarshal` 报 `unexpected end of JSON input`，接着发生以下事情：

1. 任务已经从控制器队列中取走，**不会再下发**；
2. 控制器等满 60 秒后报超时，部署失败；
3. Agent 进入退避。

对 SSH 节点来说，同样的配置可以正常部署。所以这个问题的表现是 **Agent 节点无法部署大前缀集**，而且报错信息完全看不出真正的原因。

**修改一（`agent/client.go`）：** 放宽上限，并对超限情况明确报错；结果单独截断；上传结果使用超时更长的客户端。

```go
const (
	maxControllerResponse = 24 * 1024 * 1024 // 大于控制器端 16 MiB 参数上限加上 JSON 包装
	maxResultStdout       = 6 * 1024 * 1024
	maxResultStderr       = 1 * 1024 * 1024
)

type Client struct {
	cfg    Config
	http   *http.Client // 轮询：45s
	upload *http.Client // 回传大结果：5min
}

func NewClient(cfg Config) *Client {
	return &Client{
		cfg:    cfg,
		http:   &http.Client{Timeout: 45 * time.Second},
		upload: &http.Client{Timeout: 5 * time.Minute},
	}
}

func (c *Client) doRequest(ctx context.Context, hc *http.Client, method, path string, body any, response any) error {
	payload, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, method, c.cfg.ControllerURL+path, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.cfg.Token)
	resp, err := hc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxControllerResponse+1))
	if err != nil {
		return err
	}
	if len(data) > maxControllerResponse {
		return fmt.Errorf("controller response exceeds %d bytes", maxControllerResponse)
	}
	if resp.StatusCode == http.StatusUnauthorized {
		return ErrUnauthorized
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("controller returned %s: %s", resp.Status, strings.TrimSpace(string(data[:min(len(data), 4096)])))
	}
	if response != nil && len(data) > 0 {
		return json.Unmarshal(data, response)
	}
	return nil
}

func (c *Client) request(ctx context.Context, method, path string, body any, response any) error {
	return c.doRequest(ctx, c.http, method, path, body, response)
}

func truncateUTF8(s string, max int) string {
	if len(s) <= max {
		return s
	}
	cut := max
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut] + "\n...[birdbox-agent: output truncated]"
}

// RunPoll 中回传结果处：
r := executeTask(ctx, *response.Task)
r.Stdout = truncateUTF8(r.Stdout, maxResultStdout)
r.Stderr = truncateUTF8(r.Stderr, maxResultStderr)
if err := c.doRequest(ctx, c.upload, http.MethodPost, "/api/agent/tasks/"+response.Task.TaskID+"/result", r, nil); err != nil {
	// ...
}
```

需要 `import "unicode/utf8"`。`min` 是 Go 1.21 起的内置函数；`go.mod` 声明的是 1.22，Dockerfile 使用 1.24，都可以用。

**修改二（控制器，兼容旧 Agent）：** 新 Agent 注册时上报能力 `task.large_payload`。对仍然是旧版本的 Agent，控制器在派发前就给出明确提示，而不是让任务静默超时：

```go
// agent/client.go Register 的 Capabilities 末尾追加
"task.large_payload",
```

```ts
// src/agent-broker.ts dispatch() 中，完成序列化长度检查之后
const LEGACY_AGENT_MAX_TASK_BYTES = 1_900_000; // 旧 Agent 读取上限 2 MiB，预留 JSON 包装空间
const agent = this.#agents.get(nodeId);
if (Buffer.byteLength(serializedParams, "utf8") > LEGACY_AGENT_MAX_TASK_BYTES
    && agent && !agent.capabilities.includes("task.large_payload")) {
  return Promise.resolve({
    taskId: "", nodeId, ok: false, stdout: "",
    stderr: `当前 Agent 版本（${agent.agentVersion}）无法接收超过 2 MiB 的配置，请先在节点管理中升级 Agent`,
    code: "AGENT_UPGRADE_REQUIRED",
  });
}
```

```ts
// src/http/agent-routes.ts：结果回传上限与 Agent 端截断值匹配
app.post<{ Params: { taskId: string } }>("/api/agent/tasks/:taskId/result", { bodyLimit: 20 * 1024 * 1024, handler: /* 不变 */ });
```

---

### P0-3 未登录请求的错误响应会泄露事件日志

**位置：** `src/http/application.ts:176`

```ts
if (!authPath && publicError.code !== "AUTH_REQUIRED") payload.events = options.getEvents();
```

**问题：** 下面这些**不需要登录**就能触发的错误，都会把最近 100 条变更事件原样返回。事件内容包括节点名称、协议名、部署报错（其中可能有 BIRD 原始输出、IP、路径）：

| 请求 | 结果 |
|---|---|
| `GET /api/nodes/setup-script/<任意32位字符>` | 404，附带 events |
| `POST /api/agent/register`，请求体为非法 JSON | 400，附带 events |
| 任意 `POST /api/...`，携带跨站 `Origin` | `assertSameOrigin` 返回 403，附带 events |

此外，同一段代码还会调用 `options.addEvent("error", ...)`，于是未登录的扫描器可以往管理员的事件栏里刷垃圾消息。

**修改（`src/http/application.ts`）：** 只在请求确实已登录时，才写入和返回事件。

```ts
import { requestSessionToken } from "./auth-routes.js";

const UNAUTHENTICATED_PREFIXES = ["/api/agent/", "/api/nodes/setup-script/", "/api/auth/", "/api/health"];

app.setErrorHandler(async (error, request, reply) => {
  const publicError = error as PublicError;
  const pathname = new URL(request.raw.url ?? "/", "http://localhost").pathname;
  const healthPath = pathname === "/api/health";
  // ...原有的 413 / 400 归一化逻辑不变...
  const unexpected = !isPublicError(publicError);

  // 只有已登录的请求才写入和回显事件
  let authenticated = false;
  if (!UNAUTHENTICATED_PREFIXES.some((prefix) => pathname.startsWith(prefix))
      && publicError.code !== "AUTH_REQUIRED") {
    authenticated = await options.authStore
      .isAuthenticated(requestSessionToken(request))
      .catch(() => false);
  }
  if (authenticated) options.addEvent("error", safeErrorMessage(publicError));

  if (healthPath) return sendJson(reply, 503, { status: "error" });
  // ...原有的 logger.error 逻辑不变...
  const payload: ApiErrorResponse = { error: unexpected ? "服务器内部错误" : publicError.message };
  if (!unexpected && publicError.code) payload.code = publicError.code;
  if (authenticated) payload.events = options.getEvents();
  if (!reply.sent) return sendJson(reply, publicError.status ?? publicError.statusCode ?? 500, payload);
  reply.raw.destroy();
});
```

> **兼容性：** 已登录用户看到的行为不变，前端依赖的 `payload.events` 仍然会返回。每次出错多一次数据库读取，开销可以忽略。

---
### P0-4 IRR 调度器的未捕获异常会使进程崩溃

**位置：** `src/server.ts:233`（`const inventory = await store.read();` 不在 try 里）以及 `:251` 和 `:253` 的 `void runIrrSchedule()`

**问题：** 只要 MySQL 短暂不可用（主从切换、网络抖动、连接池耗尽），`store.read()` 就会 reject，传到 `void` 调用处成为 `unhandledRejection`。Node 18 及以上版本默认会**直接退出进程**。如果这时正好有部署在进行，就会留下恢复日志；而恢复日志加上 Agent 节点，又正好触发 P0-1 的崩溃循环。

**修改（`src/server.ts`）：**

```ts
async function runIrrSchedule(): Promise<void> {
  if (irrSchedulerStopped || activeIrrSchedule) return;
  activeIrrSchedule = (async () => {
    let inventory;
    try {
      inventory = await store.read();
    } catch (error) {
      logger.error("AS-SET 调度读取库存失败，等待下一个周期", errorContext(error));
      return;
    }
    const now = Date.now();
    for (const define of inventory.defines) {
      // ...循环体不变...
    }
  })().finally(() => { activeIrrSchedule = null; });
  await activeIrrSchedule;
}

const scheduleIrr = (): void => {
  runIrrSchedule().catch((error) => logger.error("AS-SET 调度异常", errorContext(error)));
};
const irrScheduleTimer = setInterval(scheduleIrr, irrSchedulerIntervalMs);
irrScheduleTimer.unref();
scheduleIrr();

// 兜底：记录日志但不退出，避免部署中途被打断（部署本身有恢复日志保护）
process.on("unhandledRejection", (reason) => {
  logger.error("未处理的 Promise 拒绝", errorContext(reason));
});
```

> 最后一段全局兜底的取舍：一种做法是「记录日志后继续运行」，另一种是「记录日志后退出」。这里选前者，理由是部署事务已经有恢复日志保护，而强制退出正是 P0-1 最常见的诱因。如果团队更倾向于 fail-fast，可以改成调用 `shutdown("unhandledRejection")`，这样至少会等进行中的部署结束再退出。

---

## 4. P1 —— 高优先级

### P1-1 Agent 自升级参数完全由客户端提交

**位置：**
- `src/http/mutation-routes.ts`：`POST /api/agent/nodes/:nodeId/upgrade` 直接把 `body` 作为 `agent.self_upgrade` 的参数；`POST /api/agent/upgrades/batch` 同样照搬每个节点的 `params`
- `agent/client.go` 中的 `upgradeTask`：从任意 `url` 下载，只校验调用方同时给出的 `sha256`，然后以 root 身份 `rename` 到任意绝对路径 `targetPath`，再重启任意 `service`
- 前端 `NodeEditorDialog.vue:178` 和 `BatchAgentUpgradeDialog.vue:31`：遇到未知架构时 `?? "amd64"`；下载地址使用 `window.location.origin`

**问题：**
1. **权限放大。** 管理员会话一旦被盗（XSS、Cookie 泄露、共用电脑），攻击者就能向**所有节点**写入任意 root 可执行文件，例如覆盖 `/usr/sbin/bird` 或 `/sbin/init`。在 Birdbox 里，BIRD 配置本身不能执行命令，所以这个接口是会话到 root 的唯一直接通道，应当收紧。
2. **下载地址取错。** `window.location.origin` 是浏览器访问的地址，比如 `http://localhost:3000` 或经 SSH 隧道转发的地址，不一定是 Agent 能访问的 `BIRDBOX_PUBLIC_URL`。结果是升级时下载失败。
3. **可能变砖。** 架构未知时回退为 amd64；新二进制在替换前不做可执行性探测。一旦装错，Agent 就再也起不来，只能登录节点手工恢复。

**修改一：** 新增 `src/agent-release.ts`，由服务端统一解析架构、计算摘要、生成升级参数。

```ts
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

/** Go runtime.GOARCH 取值（Agent 注册时上报的就是它） */
export const AGENT_GOARCH = new Set(["amd64", "arm64", "arm", "mips", "mipsle", "mips64", "mips64le", "riscv64"]);

/** 兼容 uname -m / Node process.arch 别名，仅用于下载接口 */
const ARCH_ALIASES: Record<string, string> = {
  x64: "amd64", x86_64: "amd64", amd64: "amd64",
  aarch64: "arm64", arm64: "arm64",
  armv7l: "arm", arm: "arm",
  mips: "mips", mipsel: "mipsle", mipsle: "mipsle",
  mips64: "mips64", mips64el: "mips64le", mips64le: "mips64le",
  riscv64: "riscv64",
};

export function normalizeAgentArch(value: unknown): string | null {
  const key = String(value ?? "").trim().toLowerCase();
  return ARCH_ALIASES[key] ?? null;
}

export function agentBinaryFile(base: string, arch: string): string {
  return path.extname(base) ? path.join(path.dirname(base), `birdbox-agent-${arch}`) : path.join(base, `birdbox-agent-${arch}`);
}

const digestCache = new Map<string, { mtimeMs: number; size: number; digest: string }>();

export async function agentBinaryDigest(file: string): Promise<string> {
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error("Agent 二进制不存在");
  const cached = digestCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.digest;
  const digest = createHash("sha256").update(await fs.readFile(file)).digest("hex");
  digestCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, digest });
  return digest;
}

export async function buildAgentUpgradeParams(options: {
  architecture: string | null | undefined;
  publicUrl: string;
  binaryBase: string;
  version: string;
}): Promise<Record<string, unknown>> {
  const arch = normalizeAgentArch(options.architecture);
  if (!arch || !AGENT_GOARCH.has(arch)) {
    const error = new Error(`Agent 上报的架构 ${String(options.architecture)} 不受支持，拒绝下发升级`) as Error & { status: number; code: string };
    error.status = 409; error.code = "AGENT_ARCH_UNSUPPORTED";
    throw error;
  }
  const sha256 = await agentBinaryDigest(agentBinaryFile(options.binaryBase, arch));
  return {
    url: `${options.publicUrl.replace(/\/$/, "")}/api/agent/releases/latest/download?arch=${arch}`,
    sha256,
    targetPath: "/usr/local/bin/birdbox-agent",   // 与准备脚本安装路径一致
    service: "birdbox-agent",
    version: options.version,
  };
}
```

**修改二：** `src/http/mutation-routes.ts` 忽略客户端提交的参数，改由服务端生成。`createHttpApplication` 需要把 `publicUrl`、`agentBinaryPath` 和 `appVersion` 传进来。

```ts
interface MutationRoutesOptions {
  // ...原有字段
  agentPublicUrl: string;
  agentBinaryPath?: string;
  appVersion: string;
}

async function serverUpgradeParams(options: MutationRoutesOptions, nodeId: string) {
  if (!options.agentBinaryPath) throw routeError(404, "Agent 二进制尚未发布", "AGENT_RELEASE_MISSING");
  return buildAgentUpgradeParams({
    architecture: options.agentBroker.status(nodeId)?.architecture,
    publicUrl: options.agentPublicUrl,
    binaryBase: options.agentBinaryPath,
    version: options.appVersion,
  });
}

// 单节点升级
app.post<{ Params: { nodeId: string } }>("/api/agent/nodes/:nodeId/upgrade", async (request, reply) => {
  const nodeId = validId(request.params.nodeId);
  if (!options.agentBroker.status(nodeId)?.connected) throw routeError(409, "Agent 当前未连接，无法下发升级任务", "AGENT_OFFLINE");
  jsonBody(request);                               // 仍要求合法 JSON，但内容不再使用
  const params = await serverUpgradeParams(options, nodeId);
  if (!options.agentBroker.beginSingleUpgrade()) throw routeError(409, "已有 Agent 升级任务正在执行，请等待完成", "AGENT_UPGRADE_RUNNING");
  try {
    const result = await options.agentBroker.dispatch(nodeId, "agent.self_upgrade", params, 10 * 60 * 1000);
    return reply.code(result.ok ? 200 : 502).send(result);
  } finally {
    options.agentBroker.endSingleUpgrade();
  }
});

// 批量升级：循环中替换 params
for (const value of raw) {
  // ...原有校验
  const status = options.agentBroker.status(nodeId);
  const params = status?.connected ? await serverUpgradeParams(options, nodeId) : {};
  inputs.push({ nodeId, params });
}
```

> **兼容性：** 前端当前提交的 `targetPath` 和 `service` 本来就是固定值 `/usr/local/bin/birdbox-agent` 与 `birdbox-agent`，服务端生成相同的值，所以升级行为不变。唯一的变化是下载地址改用 `BIRDBOX_PUBLIC_URL`，这正是 Agent 平时回连的地址，比浏览器 origin 更可靠。前端的 `?? "amd64"` 回退应改为抛错，也可以直接只提交 `{}`。

**修改三：** `agent/client.go` 的 `upgradeTask` 在替换前探测新二进制能否执行，并保留旧版本作为回退。

```go
// main.go：必须放在 root 检查之前，供探测使用
func main() {
	if len(os.Args) > 1 && (os.Args[1] == "-version" || os.Args[1] == "--version") {
		fmt.Println(version)
		return
	}
	// ...原逻辑
}
```

```go
// client.go upgradeTask 中，sha256 校验通过、chmod 之后，rename 之前
if err = probeBinary(tmpName); err != nil {
	r.Stderr = "new agent binary cannot run on this host: " + err.Error()
	r.Code = "INSTALL_FAILED"
	return r
}
if _, statErr := os.Stat(target); statErr == nil {
	_ = os.Remove(target + ".prev")
	_ = os.Link(target, target+".prev") // 保留回退版本（硬链接，不额外占空间）
}

// probeBinary 用于识别「架构错误（exec format error）」和「非法指令（SIGILL，常见于 MIPS hardfloat）」。
// 使用空环境变量，避免旧版本二进制忽略参数后当作第二个 Agent 实例启动。
func probeBinary(path string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, "-version")
	cmd.Env = []string{}
	out, err := cmd.CombinedOutput()
	if err == nil {
		return nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		if ws, ok := exitErr.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
			return fmt.Errorf("killed by signal %s", ws.Signal())
		}
		// 旧版本不认识 -version，会因为缺少环境变量以状态 1 退出。说明二进制可以执行，放行。
		if exitErr.ExitCode() == 1 {
			return nil
		}
	}
	return fmt.Errorf("%v: %s", err, strings.TrimSpace(string(out)))
}
```

---

### P1-2 Agent 从不清理版本文件，OpenWrt 闪存会被写满

**位置：** `agent/bird.go` 中的 `stageMain` 和 `stageResources`。每次预检都会写入 `versions/<name>.<hash>.conf`，但**任何代码路径都不会删除这些文件**。作为对比，SSH 路径（`bird-runtime.ts` 的 `cleanup_staged_versions` 和 `cleanup_versions`）会清理未被引用的版本。

**问题：** 每次预检（包括「预览」、iBGP/OSPF 预检、每次 IRR 刷新）只要内容有变化，就会新增一份完整的主配置和 Define 片段。大 AS-SET 每小时刷新一次，每份 2 到 3 MiB，一天就是几十 MiB。OpenWrt 的 `/etc` 覆盖层（overlay）通常只有几 MiB 到几十 MiB，写满后 **`atomicWrite` 失败，整个节点无法再部署**，还可能影响 OpenWrt 自身的配置保存。

**修改（`agent/bird.go`）：** 在 apply 或 rollback 成功之后执行 GC，只保留被活动链接、candidate 或 rollback 引用的文件。

```go
// pruneVersions 删除 dir 中以 prefix 开头、且不在 keep 集合里的普通文件。
// keep 使用 EvalSymlinks 之后的绝对路径。
func pruneVersions(dir, prefix string, keep map[string]bool) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasPrefix(name, prefix) || !(strings.HasSuffix(name, ".conf") || strings.HasSuffix(name, ".conf.tmp")) {
			continue
		}
		full := filepath.Join(dir, name)
		if keep[full] {
			continue
		}
		if info, err := os.Lstat(full); err == nil && info.Mode().IsRegular() {
			_ = os.Remove(full)
		}
	}
}

func resolvedTarget(path string) string {
	target, err := filepath.EvalSymlinks(path)
	if err != nil {
		return ""
	}
	abs, err := filepath.Abs(target)
	if err != nil {
		return ""
	}
	return abs
}

// gcBirdVersions 只在 include 模式、配置已成功生效之后调用。
func gcBirdVersions(generated, base string) {
	// 主配置版本
	mainKeep := map[string]bool{}
	for _, p := range []string{generated, generated + ".candidate", generated + ".rollback"} {
		if t := resolvedTarget(p); t != "" {
			mainKeep[t] = true
		}
	}
	pruneVersions(filepath.Join(filepath.Dir(generated), "versions"), filepath.Base(generated)+".", mainKeep)

	// Define 资源版本：保留 resources/ 下所有 define_*.conf(.candidate|.rollback) 链接的目标
	resourceDir := filepath.Join(base, "resources")
	resKeep := map[string]bool{}
	if entries, err := os.ReadDir(resourceDir); err == nil {
		for _, entry := range entries {
			if strings.HasPrefix(entry.Name(), "define_") {
				if t := resolvedTarget(filepath.Join(resourceDir, entry.Name())); t != "" {
					resKeep[t] = true
				}
			}
		}
	}
	pruneVersions(filepath.Join(resourceDir, "versions"), "define_", resKeep)
}
```

调用位置：`applyBirdTask` 和 `rollbackBirdTask` 末尾，在 `check.ok && mode == "include"` 分支中调用 `gcBirdVersions(generated, base)`。

> **兼容性：** 被任何链接引用的版本都会保留，所以 rollback 链路不受影响。准备脚本创建的 `versions/<basename>.initial.conf` 在没有被引用之后才会被删除，这时它已经没有用处了。注意这个 GC 只处理 include 模式，legacy 模式不写 versions 目录，不需要清理。

---

### P1-3 Agent apply 不为「删除的资源」保存 rollback，并残留旧的 rollback

**位置：** `agent/bird.go` 中的 `applyBirdTask`：
- 约 `:668-680`：只在旧状态是 symlink 时写 `.rollback`，否则**不清除旧的 `.rollback`**
- 约 `:684`：`for _, removed := range bundle.RemovedResources { removePath(...) }`，删除前没有保存 `.rollback`

SSH 路径中对应的 `resourceSwitchCommands("apply")` 和 `resourceRemovalCommands` 都处理了这两种情况，两条路径的语义不一致。

**问题：** 以一次多节点部署为例，节点 A 已经 apply 成功（其中删除了 Define X），节点 B 失败，于是 A 需要回滚：
1. 回滚配置里引用了 `define_X.conf`；
2. 但 A 上没有 `define_X.conf.rollback`，文件无法恢复；
3. `configure check` 失败，A 回滚失败；
4. 恢复日志残留，系统一直处于 503 状态，只能重启才能恢复。重启后又会触发 P0-1。

另一种情况：旧的 `.rollback` 如果没有清除，回滚时可能恢复成更早的版本。

**修改（`agent/bird.go`）：**

```go
// applyBirdTask：资源切换循环
for _, active := range resourcePaths {
	candidate, readErr := os.Readlink(active + ".candidate")
	if readErr == nil {
		rollback := active + ".rollback"
		if err = removePath(rollback); err != nil { /* restore + fail */ }
		if state := snapshot[active]; state.kind == "symlink" {
			if err = replaceSymlink(rollback, state.target); err != nil {
				_ = restoreSnapshot(snapshot, gid)
				r.Stderr, r.Code = "save resource rollback: "+err.Error(), "APPLY_FAILED"
				return r
			}
		}
		if err = replaceSymlink(active, candidate); err != nil { /* 原有处理 */ }
	} else if !os.IsNotExist(readErr) { /* 原有处理 */ }
}

// 删除资源：先保存 rollback
for _, removed := range bundle.RemovedResources {
	active := filepath.Join(base, "resources", removed)
	rollback := active + ".rollback"
	_ = removePath(rollback)
	if state := snapshot[active]; state.kind == "symlink" {
		if err = replaceSymlink(rollback, state.target); err != nil {
			_ = restoreSnapshot(snapshot, gid)
			r.Stderr, r.Code = "save removed resource rollback: "+err.Error(), "APPLY_FAILED"
			return r
		}
	}
	if err = removePath(active); err != nil {
		_ = restoreSnapshot(snapshot, gid)
		r.Stderr, r.Code = err.Error(), "APPLY_FAILED"
		return r
	}
}
```

同一个函数里，保存主配置 rollback 时的错误被 `_ =` 忽略了。如果 rollback 没有写成功，后续就无法回滚，应当让 apply 直接失败：

```go
switch genState.kind {
case "symlink":
	err = replaceSymlink(rollbackPath, genState.target)
case "file":
	err = atomicWrite(rollbackPath, genState.data, genState.mode, gid)
}
if err != nil {
	r.Stderr, r.Code = "save generated rollback: "+err.Error(), "APPLY_FAILED"
	return r
}
```

另外，`defer func() { _ = snapshot }()` 是一段死代码，可以删除。

**补充 Go 单测**（`agent/bird_test.go`）：构造 base 目录，其中已有 `define_x.conf` 指向 v1。执行 apply，`RemovedResources=[define_x.conf]`，断言 `.rollback` 指向 v1；再执行 rollback，断言 `define_x.conf` 恢复。

---

### P1-4 长轮询连接断开后 waiter 不被移除，任务会丢失

**位置：** `src/agent-broker.ts` 的 `poll()` 和 `dispatch()`，以及 `src/http/agent-routes.ts` 的 `/api/agent/tasks/poll`

**问题：** Agent 发起长轮询后，可能在 25 秒等待期内断开：NAT 或负载均衡的空闲超时（很多 LB 默认 60 秒以内，某些运营商 NAT 只有 30 秒）、Agent 重启、网络闪断都会造成这种情况。这时服务端的 waiter 仍然留在 `#waiters` 里：
1. 下一次 `dispatch()` 会 `shift()` 出这个已经失效的 waiter，把任务交给它；
2. 响应写到已关闭的 socket 上，**任务就此丢失**；
3. 控制器要等满任务超时（部署是 60 秒，升级是 10 分钟）才报错；
4. 同时 Agent 重连后的新 waiter 排在后面，一直拿不到这个任务。

**修改一（`src/agent-broker.ts`）：** `poll` 支持 `AbortSignal`，并提供 `requeue`。

```ts
async poll(nodeId: string, token: string, waitMs = 25_000, signal?: AbortSignal): Promise<AgentTask | null> {
  if (!this.authenticate(nodeId, token)) throw new Error("Agent 凭据无效或已撤销");
  this.heartbeat(nodeId, token);
  const immediate = this.#takeTask(nodeId);
  if (immediate) return immediate;
  if (signal?.aborted) return null;
  return new Promise((resolve) => {
    const waiters = this.#waiters.get(nodeId) ?? [];
    let settled = false;
    const remove = (): void => {
      const current = this.#waiters.get(nodeId) ?? [];
      const index = current.indexOf(waiter);
      if (index >= 0) current.splice(index, 1);
      if (current.length) this.#waiters.set(nodeId, current); else this.#waiters.delete(nodeId);
    };
    const finish = (task: AgentTask | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(task);
    };
    const waiter = (task: AgentTask | null): void => finish(task);
    const onAbort = (): void => { remove(); finish(null); };
    waiters.push(waiter);
    this.#waiters.set(nodeId, waiters);
    const timer = setTimeout(() => { remove(); finish(null); }, Math.max(1000, Math.min(waitMs, 30_000)));
    timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** 任务未能送达 Agent（连接已断开）时放回队首，保持原有的截止时间 */
requeue(task: AgentTask): void {
  if (!this.#pending.has(task.taskId)) return;      // 已超时或已完成
  const queue = this.#queues.get(task.nodeId) ?? [];
  this.#queues.set(task.nodeId, [task, ...queue].sort((l, r) => taskPriority(l.method) - taskPriority(r.method)));
  logger.warn("Agent 任务投递失败，已重新入队", { nodeId: task.nodeId, taskId: task.taskId, method: task.method });
}
```

**修改二（`src/http/agent-routes.ts`）：**

```ts
app.post("/api/agent/tasks/poll", async (request, reply) => {
  const input = body(request); const id = nodeId(request, input);
  const controller = new AbortController();
  const onClose = (): void => controller.abort();
  request.raw.socket.once("close", onClose);
  try {
    const task = await options.broker.poll(id, token(request, input), 25_000, controller.signal);
    if (task && (controller.signal.aborted || request.raw.socket.destroyed)) {
      options.broker.requeue(task);
      return reply;                                   // socket 已关闭，不再写响应
    }
    return reply.send({ task });
  } catch (error) {
    return reject(reply, error instanceof Error ? error.message : "Agent 轮询失败");
  } finally {
    request.raw.socket.off("close", onClose);
  }
});
```

> **遗留风险说明：** 如果 TCP 写入成功、但 Agent 在读完响应之前就断开，这个任务仍然可能丢失。这是长轮询模式本身的局限，要彻底解决需要改成「Agent 确认收到（ack）+ 幂等重投」。不过 stage、apply、rollback 在 Agent 端都是幂等的，下一版可以考虑加 ack。

---

### P1-5 `connectionTimeout: 60000` 会切断耗时较长的部署和升级请求

**位置：** `src/http/application.ts:114-115`

```ts
requestTimeout: 60000,
connectionTimeout: 60000,
```

**问题：** 在 Fastify 5 中，`connectionTimeout` 对应 `server.timeout`，即 socket 空闲超时；`requestTimeout` 对应 Node 的 `server.requestTimeout`，只限制接收请求的时间。部署期间，服务端在拿到结果之前**不会往 socket 写任何数据**。下面这些请求都可能超过 60 秒：

| 请求 | 可能的耗时 |
|---|---|
| Agent 单节点升级 | 最多 10 分钟 |
| 多节点 `mutateAndApply` | 每个节点预检加应用 30 到 120 秒，多节点叠加 |
| 首次 IRR 解析 `resolveIrrDefine` | 45 秒 bgpq4，加部署时间 |

60 秒后 socket 被销毁，前端提示「连接中断，变更可能已经生效」，但服务端**仍在继续部署**。前端虽然设计了 `unknownOutcome` 兜底，可用户体验很差；而且 `/api/agent/nodes/:id/upgrade` 前端设置了 650 秒超时，几乎一定会触发这个问题。

**修改：**

```ts
const app = Fastify({
  bodyLimit: 128 * 1024,
  // requestTimeout 只限制接收请求头和请求体的时间，60 秒足够
  requestTimeout: 60_000,
  // 0 表示不设置 socket 空闲超时。部署类请求可能长时间没有输出。
  // 慢连接攻击由 requestTimeout 和 headersTimeout 防护。
  connectionTimeout: 0,
  keepAliveTimeout: 5_000,
  maxRequestsPerSocket: 0,
  logger: false,
});
app.server.headersTimeout = 30_000;
```

如果前面还有反向代理（Nginx、Traefik），同样需要调整。建议在 `docs/docker-deployment.md` 中补充：

```nginx
location /api/ {
  proxy_pass http://127.0.0.1:3000;
  proxy_read_timeout 1900s;   # 大于前端 API_DEPLOYMENT_TIMEOUT_MS（1810 秒）
  proxy_send_timeout 1900s;
  client_max_body_size 24m;   # Agent 结果回传
}
```

---

### P1-6 MIPS/ARM 架构识别与构建问题：OpenWrt 上常见的安装失败

**位置：** `Dockerfile:18-23`（Agent 构建）、`src/node-onboarding-service.ts:591`（准备脚本中的 `case "$AGENT_ARCH"`）、前端两处架构映射

**问题：**

1. **`uname -m` 不区分大小端。** 在 OpenWrt 最常见的 ramips/MT7621、ath79 等小端 MIPS 平台上，`uname -m` 返回的是 `mips`，而不是 `mipsel`。脚本因此会下载大端（`mips`）二进制，执行时报 `exec format error`，procd 反复拉起，最后放弃。
2. **`mips64*) AGENT_ARCH=mips64`** 把 mips64el 映射成了大端二进制，镜像里也没有构建 `mips64le`。
3. **没有指定 `GOMIPS=softfloat`。** Go 在 mips/mipsle 上默认生成 hardfloat 代码。大量 SoC（如 MT7621、QCA95xx）没有 FPU，而 OpenWrt 内核通常关闭了 FPU 仿真，结果是 `SIGILL: illegal instruction`。
4. **缺少 `armv6l` 和 `armv5`。** 只构建了 `GOARM=7`，树莓派 Zero、部分 kirkwood 设备都跑不起来。
5. **前端遇到未知架构时回退为 amd64**（见 P1-1）。

**修改一（`Dockerfile`）：**

```dockerfile
FROM golang:1.24-alpine AS agent-build
ARG BIRDBOX_VERSION=dev
WORKDIR /src/agent
COPY agent/go.mod ./
COPY agent/*.go ./
RUN go vet ./... && go test ./...
RUN set -eu; mkdir -p /out; \
    build() { out="$1"; shift; env GOOS=linux CGO_ENABLED=0 "$@" go build -trimpath \
      -ldflags="-s -w -X main.version=${BIRDBOX_VERSION}" -o "/out/birdbox-agent-$out" .; }; \
    build amd64    GOARCH=amd64; \
    build arm64    GOARCH=arm64; \
    build arm      GOARCH=arm GOARM=7; \
    build armv6    GOARCH=arm GOARM=6; \
    build armv5    GOARCH=arm GOARM=5; \
    build mips     GOARCH=mips     GOMIPS=softfloat; \
    build mipsle   GOARCH=mipsle   GOMIPS=softfloat; \
    build mips64   GOARCH=mips64   GOMIPS64=softfloat; \
    build mips64le GOARCH=mips64le GOMIPS64=softfloat; \
    build riscv64  GOARCH=riscv64
```

> softfloat 在有 FPU 的设备上同样可以运行。Agent 几乎不做浮点运算，性能差异可以忽略，所以**已安装节点在下次升级时切换到 softfloat 是安全的**。

**修改二（准备脚本架构探测，`agentSetupScript`）：** 用下面的片段替换原来的单行 `case`。

```sh
detect_agent_arch() {
  machine=$(uname -m)
  # OpenWrt 在 openwrt_release 中给出精确的包架构（例如 mipsel_24kc、aarch64_cortex-a53）
  if [ -r /etc/openwrt_release ]; then
    DISTRIB_ARCH=$(. /etc/openwrt_release 2>/dev/null; printf '%s' "${DISTRIB_ARCH:-}")
    case "$DISTRIB_ARCH" in
      mipsel_*) echo mipsle; return ;;
      mips_*) echo mips; return ;;
      mips64el_*) echo mips64le; return ;;
      mips64_*) echo mips64; return ;;
      # 32 位 ARM 的 DISTRIB_ARCH 命名比较杂（arm_cortex-a7_neon-vfpv4、arm_arm1176jzf-s_vfp 等），交给下面的 uname -m 判断
      aarch64_*) echo arm64; return ;;
      x86_64) echo amd64; return ;;
      riscv64_*) echo riscv64; return ;;
    esac
  fi
  # 通用 Linux：根据 ELF 头第 6 个字节（EI_DATA）判断大小端，1=小端，2=大端
  elf_data() {
    if command -v od >/dev/null 2>&1; then od -An -tx1 -j5 -N1 /bin/sh | tr -d ' \n';
    elif command -v hexdump >/dev/null 2>&1; then hexdump -s 5 -n 1 -e '1/1 "%02x"' /bin/sh;
    fi
  }
  case "$machine" in
    x86_64|amd64) echo amd64 ;;
    aarch64|arm64) echo arm64 ;;
    armv7*|armv8l) echo arm ;;
    armv6*) echo armv6 ;;
    armv5*) echo armv5 ;;
    riscv64) echo riscv64 ;;
    mips|mipsel) [ "$(elf_data)" = 01 ] && echo mipsle || echo mips ;;
    mips64|mips64el) [ "$(elf_data)" = 01 ] && echo mips64le || echo mips64 ;;
    *) echo "" ;;
  esac
}
AGENT_ARCH=$(detect_agent_arch)
[ -n "$AGENT_ARCH" ] || { echo "不支持的 Agent 架构：$(uname -m)" >&2; exit 1; }
```

> 注：`od` 和 `hexdump` 在 BusyBox 中通常都有。如果两者都没有，`elf_data` 会返回空字符串，脚本按大端处理，与现状一致。

控制器下载接口（`agent-routes.ts` 中的 `binaryForArch`）需要同步接受 `armv6`、`armv5` 和 `mips64le`。建议直接复用 P1-1 的 `normalizeAgentArch`，并把 `armv6`、`armv5` 加进白名单。

这两个值不是 GOARCH：Agent 运行时的 `runtime.GOARCH` 仍然是 `arm`。如果不做处理，升级时服务端会一律按 v7 下发。解决办法是在编译时注入真实的构建目标，Agent 注册时一并上报：

```go
// main.go
var buildArch = "" // 由 -ldflags "-X main.buildArch=armv6" 注入

// client.go Register
arch := runtime.GOARCH
if buildArch != "" {
	arch = buildArch
}
// registration{ ..., Architecture: arch }
```

```dockerfile
# Dockerfile 的 build() 函数中，把 -ldflags 改成
-ldflags="-s -w -X main.version=${BIRDBOX_VERSION} -X main.buildArch=$out"
```

服务端的 `buildAgentUpgradeParams` 直接使用上报的 `architecture` 选择下载文件即可。

> ⚠️ **兼容说明：**
> 1. 只影响**新执行的准备脚本**和**之后的升级**，不会改动已在运行的 Agent。
> 2. 原来被错误识别、根本没能运行的节点，在修复后重新执行脚本即可。
> 3. 老版本 Agent 没有 `buildArch`，上报的仍是 `runtime.GOARCH`。其中 `mips`、`mipsle` 这类值本身就能区分大小端，映射没有问题；只有 `arm` 会一律按 v7 下发，这与现状一致。升级到新版本之后，Agent 就会上报准确的构建目标。

---

### P1-7 默认明文 HTTP：Agent token 和任务通道可被中间人利用

**位置：** `.env.example`、`docker-compose.yml`（`BIRDBOX_PUBLIC_URL=http://...`）、`agent/main.go` 的 `loadConfig`

**问题：** Agent 以 root 运行，会执行控制器下发的 `bird.apply`（以 root 写任意路径的文件）、`network.ip_rules`、`agent.self_upgrade`（下载并执行二进制）和 `legacy.exec`（root shell）。在明文 HTTP 下，**同一网段的中间人**可以做到：
- 读取 Bearer token，冒充节点；
- 更严重的是，篡改 `/api/agent/tasks/poll` 的响应，向节点下发任意 `legacy.exec`，**直接拿到节点 root**。

准备脚本从同一个 HTTP 源下载 Agent 二进制和 SHA-256，摘要校验对中间人没有任何防护作用。

**修改一：** 启动时校验地址并给出告警（`src/server.ts`），同时解决 P2-9。

```ts
function normalizePublicUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("BIRDBOX_PUBLIC_URL 必须是完整的 http(s):// URL"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("BIRDBOX_PUBLIC_URL 只支持 http 或 https");
  if (url.username || url.password || url.search || url.hash) throw new Error("BIRDBOX_PUBLIC_URL 不能包含凭据、查询或片段");
  if (["0.0.0.0", "[::]"].includes(url.hostname)) throw new Error("BIRDBOX_PUBLIC_URL 不能使用监听地址 0.0.0.0/::");
  const loopback = /^(127\.|localhost$|\[::1\]$)/.test(url.hostname);
  if (loopback) logger.warn("BIRDBOX_PUBLIC_URL 指向回环地址，远端 Agent 将无法连接", { publicUrl: url.origin });
  if (url.protocol === "http:" && !loopback) {
    logger.warn("BIRDBOX_PUBLIC_URL 使用明文 HTTP：Agent token 与 root 级任务可被同网段中间人窃取或篡改，生产环境请使用 HTTPS", { publicUrl: url.origin });
  }
  return url.toString().replace(/\/$/, "");
}
const publicUrl = normalizePublicUrl(String(process.env.BIRDBOX_PUBLIC_URL ?? `http://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host}:${port}`));
```

前端生成脚本页面也应该在 `setupScriptUrl` 以 `http://` 开头时显示醒目的警告。

**修改二（可选，推荐）：** Agent 支持自定义 CA 或证书固定，适用于自签证书的内网环境。

```go
// main.go loadConfig 之后
func buildTransport(cfg Config) (*http.Transport, error) {
	t := http.DefaultTransport.(*http.Transport).Clone()
	caFile := strings.TrimSpace(os.Getenv("BIRDBOX_CONTROLLER_CA_FILE"))
	if caFile == "" {
		return t, nil
	}
	pem, err := os.ReadFile(caFile)
	if err != nil {
		return nil, err
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pem) {
		return nil, fmt.Errorf("no certificates in %s", caFile)
	}
	t.TLSClientConfig = &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
	return t, nil
}
// NewClient 中：&http.Client{Timeout: ..., Transport: transport}
// upgradeTask 的下载也必须复用同一个 transport，不能再用 http.DefaultClient
```

同时建议增加 `BIRDBOX_AGENT_REQUIRE_HTTPS=true`：开启后，`loadConfig` 拒绝 `http://`。默认关闭，保持兼容。

---

### P1-8 依赖漏洞

`npm audit` 的结果：

- `fast-uri` 3.0.0 到 3.1.7：**high**，涉及 SSRF 和 host confusion（通过 fastify 和 ajv 间接依赖）
- `fastify <= 5.12.0`：moderate，包括 schema 校验绕过和 trustProxy 下的 `X-Forwarded-*` 伪造。本项目目前没有使用 JSON schema 和 trustProxy，实际影响较小，但落实 P2-2 之后就会受影响

**修改：**

```bash
npm install fastify@^5.13.0
npm audit fix
npm test && npm run build
```

然后把 `package.json` 中的 `"fastify": "^5.11.3"` 提升到修复版本，并提交 `package-lock.json`。建议在 CI 中加入 `npm audit --omit=dev --audit-level=high` 作为门禁。

---

## 5. P2 —— 中优先级

### P2-1 生成准备脚本会轮换已存在节点的 Agent token

**位置：** `src/node-onboarding-service.ts:704-712`（`createSetupScript`）

**问题：** `body.id` 由客户端提交，而且**没有检查它是否已经是库存中的节点**。只要对一个在线 Agent 节点的 ID 调用一次 `POST /api/nodes/setup-script`，`issueToken` 就会覆盖原凭据。结果是：
1. 在线 Agent 下一次请求收到 401；
2. Agent 执行 `log.Fatal`，systemd 每 5 秒重启一次，不断重试；
3. 这个节点**彻底失联**，只能重新登录节点执行脚本。

误操作的场景包括：前端状态没有清理，浏览器回退后再次点击「生成」，或者直接调用 API。

**修改：** 对已存在的节点拒绝轮换，除非调用方明确表示要这样做。

```ts
async createSetupScript(body: Record<string, unknown>) {
  // ...
  const inventory = await this.#options.store.read();
  if (node.transport === "agent") {
    if (!this.#options.agentBroker) fail(503, "Agent 通信服务尚未初始化");
    const existing = inventory.nodes.find((item) => item.id === node.id);
    if (existing && body.rotateCredential !== true) {
      fail(409, `节点 ${existing.name} 已存在；重新生成准备脚本会使当前 Agent 凭据失效。如确需重装，请在节点编辑页选择"重置 Agent 凭据"`, "AGENT_CREDENTIAL_EXISTS");
    }
    const token = await this.#options.agentBroker.issueToken(node.id);
    // ...
  }
}
```

> ⚠️ **兼容说明：** 在新增节点流程中，对尚未保存的 `onboardingAgentId` 反复点击「生成」，仍然可以正常轮换，因为这个 ID 还不在库存里，行为不变。旧 SSH 节点走的是 `createAgentUpgradeScript`，不受影响。如果运维以前依赖「对已有 Agent 节点重新生成脚本来重装」，现在需要显式传 `rotateCredential: true`，前端应增加一个带二次确认的「重置 Agent 凭据」按钮。

另外，从未被 `create` 的临时 ID 也会留下凭据。建议在 `AgentBroker` 中给这类凭据加 TTL：创建 24 小时后仍没有对应库存节点、也从未注册的，自动清除。

---

### P2-2 登录限流按 socket 地址计算，放在反向代理后会被锁死

**位置：** `src/http/auth-routes.ts` 的 `loginAttemptKey`（`request.socket.remoteAddress`）和 `authSessionContext`

**问题：** 部署在 Nginx 或 Traefik 后面时，所有客户端的 `remoteAddress` 都是代理的地址。**任何人**只要每 5 分钟输错 5 次密码，就能让管理员一直无法登录。同时，会话列表里显示的登录 IP 也全是代理 IP，审计信息失真。

**修改：** 新增可选环境变量 `BIRDBOX_TRUST_PROXY`，默认不启用，行为与现在完全一致。

```ts
// src/server.ts
function normalizeTrustProxy(value: string | undefined): boolean | string | number | undefined {
  if (!value) return undefined;
  if (value === "true") return true;
  if (/^\d+$/.test(value)) return Number(value);        // 信任的跳数
  return value;                                          // 逗号分隔的 IP/CIDR，例如 "127.0.0.1,10.0.0.0/8"
}
// createHttpApplication({ ..., trustProxy: normalizeTrustProxy(process.env.BIRDBOX_TRUST_PROXY) })

// src/http/application.ts
const app = Fastify({ /* ... */ trustProxy: options.trustProxy ?? false });

// src/http/auth-routes.ts
function loginAttemptKey(request: FastifyRequest): string {
  return request.ip || "unknown";            // 未开启 trustProxy 时等于 socket.remoteAddress
}
function authSessionContext(request: FastifyRequest) {
  return { address: request.ip ?? "", userAgent: request.headers["user-agent"] ?? "" };
}
```

`assertSameOrigin` 在开启 trustProxy 后也应当优先比较 `X-Forwarded-Host`，否则代理改写 Host 头后会误报 403：

```ts
const expectedHost = (request.hostname || String(request.headers.host ?? "")).toLowerCase();
```

Fastify 的 `request.hostname` 在 trustProxy 开启时会读取 `X-Forwarded-Host`。注意需要先完成 P1-8 的升级，修复 trustProxy 相关的 CVE。

---

### P2-3 首次初始化没有保护

**位置：** `POST /api/auth/setup`

**问题：** 服务启动后、管理员设置密码之前，**任何能访问端口的人**都能抢先设置管理员密码。README 虽然提示了「首次初始化前不要暴露」，但 `BIRDBOX_BIND_ADDRESS=0.0.0.0`、容器编排、自动化部署等场景下很容易忽略这一步。

**修改：** 新增可选环境变量 `BIRDBOX_SETUP_TOKEN`。未设置时行为不变。

```ts
// src/http/auth-routes.ts
import { timingSafeEqual, createHash } from "node:crypto";
const setupToken = process.env.BIRDBOX_SETUP_TOKEN?.trim() || null;
function setupTokenMatches(value: unknown): boolean {
  if (!setupToken) return true;
  const a = createHash("sha256").update(String(value ?? "")).digest();
  const b = createHash("sha256").update(setupToken).digest();
  return timingSafeEqual(a, b);
}

app.post("/api/auth/setup", async (request, reply) => {
  const body = jsonBody(request);
  if (!setupTokenMatches(body.setupToken)) throw routeError(403, "SETUP_TOKEN_INVALID", "初始化令牌不正确");
  // ...原逻辑
});

// /api/auth/status 增加 setupTokenRequired: Boolean(setupToken)，前端 AuthView 据此显示"初始化令牌"输入框
```

---

### P2-4 IRR 同步：解析成功但部署失败时没有退避

**位置：** `src/resource-application-service.ts:951-968`

**问题：** 只有 `resolveIrrAsSet` **失败**时才会写入 `nextRefreshAt`。如果解析成功，但随后的 `mutateAndApply` 失败，`nextRefreshAt` 不会被更新。失败原因可能是某个节点离线、前缀超出 BIRD 的限制、部署锁被占用（409）等。调度器每 60 秒就会：
1. 重新运行一次 bgpq4，给 IRR 服务器施压，还可能被限流；
2. 对**所有**作用域节点重新预检，相当于每分钟占用一次部署锁，导致用户正常的变更频繁遇到 409。

**修改：**

```ts
let deployed;
try {
  deployed = await mutateAndApply((draft) => { /* 原逻辑 */ }, (_r, inventory) => changed ? resourceNodeIds(inventory, define) : []);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string }).code;
  // 部署锁冲突只是暂时的，不写入错误状态，等下一个周期即可
  if (code !== "DEPLOYMENT_LOCKED" && !/另一个部署正在进行/.test(message)) {
    try {
      await mutateAndApply((draft) => {
        const current = draft.defines.find((item) => item.id === resourceId);
        if (!current || current.type === "expression" || current.entrySource.kind !== "irr-as-set") return null;
        const failedAt = new Date();
        const retryMs = Math.min(current.entrySource.refreshIntervalSeconds * 1000, 15 * 60 * 1000);
        current.sync = { ...current.sync, status: "error", lastAttemptAt: failedAt.toISOString(),
          nextRefreshAt: new Date(failedAt.getTime() + retryMs).toISOString(), error: `部署失败：${message}`.slice(0, 2048) };
        return null;
      }, []);
    } catch { /* 记录状态失败不应掩盖原错误 */ }
  }
  event("error", `AS-SET Define ${define.name} 部署失败，继续使用上一版前缀：${message}`, resourceSingleNodeId(define));
  throw error;
}
const { state, result: resource, deployment } = deployed;
```

> **兼容性：** 失败时 `entries` 仍然保留上一次成功的快照，这与文档中「同步失败时继续使用最近一次成功快照」的描述一致。

---

### P2-5 OSPF `passwordOptions` 等字段未经校验就拼进 BIRD 配置

**位置：** `src/ospf.ts` 中的 `{ ...(item.passwordOptions as RecordValue) }`，原样拷贝对象；`src/bird-render.ts:388-397` 的 `renderPassword`：

```ts
if (options.id != null) text += `${indent}  id ${options.id};\n`;
if (options.algorithm) text += `${indent}  algorithm ${String(options.algorithm).replace("-", " ")};\n`;
```

`options.txDscp` 同样没有范围校验，而同一位置的 `txClass` 和 `txPriority` 都有。

**问题：** `algorithm` 和 `id` 可以写入任意文本，比如 `hmac sha256; }; protocol static x { ... }`，从而把额外的 BIRD 配置块注入到 OSPF 接口里。管理员本身可以写自定义 Filter，所以这不算越权。但它会破坏「表单字段只产生预期指令」这个约束：非法值要么只能在远端 `configure check` 时才被发现，要么直接生成意料之外的合法配置。另外，`String.replace("-", " ")` 只替换第一个 `-`。

**修改（在渲染阶段校验，不影响历史库存的读取）：**

```ts
// src/bird-render.ts
const OSPF_AUTH_ALGORITHMS = new Map([
  ["keyed-md5", "keyed md5"], ["keyed-sha1", "keyed sha1"],
  ["hmac-sha1", "hmac sha1"], ["hmac-sha256", "hmac sha256"],
  ["hmac-sha384", "hmac sha384"], ["hmac-sha512", "hmac sha512"],
]);
const BIRD_DATETIME_RE = /^\d{2}\.\d{2}\.\d{4}(?: \d{2}:\d{2}:\d{2})?$/;   // BIRD 的 dd.mm.yyyy [hh:mm:ss]

const renderPassword = (indent: string, password: string, options: OspfPasswordOptions | undefined): string => {
  assertValidation(!/[\u0000-\u001f\u007f]/.test(password), "OSPF 密码不能包含控制字符");
  if (!options || Object.keys(options).length === 0) return `${indent}password ${birdString(password)};\n`;
  let text = `${indent}password ${birdString(password)} {\n`;
  if (options.id != null) {
    const id = Number(options.id);
    assertValidation(Number.isInteger(id) && id >= 0 && id <= 255, "OSPF 密码 ID 必须是 0-255 的整数");
    text += `${indent}  id ${id};\n`;
  }
  for (const [key, directive] of [["generateFrom", "generate from"], ["generateTo", "generate to"], ["acceptFrom", "accept from"], ["acceptTo", "accept to"], ["from", "from"], ["to", "to"]] as const) {
    if (!options[key]) continue;
    const value = String(options[key]);
    assertValidation(BIRD_DATETIME_RE.test(value), `OSPF 密码 ${directive} 时间格式必须为 dd.mm.yyyy [hh:mm:ss]`);
    text += `${indent}  ${directive} ${birdString(value)};\n`;
  }
  if (options.algorithm) {
    const algorithm = OSPF_AUTH_ALGORITHMS.get(String(options.algorithm));
    assertValidation(algorithm, `不支持的 OSPF 认证算法：${String(options.algorithm)}`);
    text += `${indent}  algorithm ${algorithm};\n`;
  }
  return `${text}${indent}};\n`;
};
// 接口选项
if (options.txDscp != null) {
  assertValidation(Number.isInteger(options.txDscp) && options.txDscp >= 0 && options.txDscp <= 63, "OSPF TX DSCP 必须是 0-63 的整数");
  output += `      tx dscp ${options.txDscp};\n`;
}
```

> **注意：** BIRD 的时间格式需要对照当前 2.x 文档确认。如果现有库存中已经存了别的格式，建议先只对 `algorithm` 和 `id` 做严格校验，时间字段暂时保留原样，只拒绝控制字符和引号。这些校验放在 render 阶段，而不是 `normalizeOspfDomain`，这样历史库存仍然可以读取，只在下一次部署时报出明确错误，不会让整个库存变成不可读。

---

### P2-6 `socketGID` 的硬编码回退值

**位置：** `agent/bird.go:380-395`

```go
for _, line := range []string{"bird:x:999:", "bird:x:100:"} { ... return gid }  // 总是返回 999
```

**问题：** 注释说「OpenWrt 没有 getent 时作为回退」，但代码根本没有读取 `/etc/group`，而是**固定返回 999**。Socket 暂时不存在时（例如 BIRD 正在重启），配置文件和版本目录会被 chown 成 GID 999。这个 GID 在很多系统上属于某个无关的组（例如 `systemd-journal` 或 `docker`），**可能让无关用户读到包含 TCP-MD5 或 OSPF 密钥的配置**；同时 BIRD 本身可能因此读不到文件。

**修改：**

```go
func socketGID(socket string) int {
	var stat syscall.Stat_t
	if err := syscall.Stat(socket, &stat); err == nil {
		return int(stat.Gid)
	}
	if data, err := os.ReadFile("/etc/group"); err == nil {
		for _, line := range strings.Split(string(data), "\n") {
			parts := strings.Split(line, ":")
			if len(parts) > 2 && parts[0] == "bird" {
				if gid, err := strconv.Atoi(parts[2]); err == nil && gid > 0 {
					return gid
				}
			}
		}
	}
	return -1 // 不修改属组，保持 root:root 0640，由后续 socket 恢复后的部署修正
}
```

---

### P2-7 Agent 准备脚本的健壮性问题

**位置：** `src/node-onboarding-service.ts` 中的 `agentSetupScript`

| # | 问题 | 修改 |
|---|---|---|
| a | `birdc ... 'configure check' && birdc ... configure \|\| true`：检查或加载失败被**吞掉**，主配置里仍留着 include，脚本却提示成功 | 失败时恢复主配置备份并 `exit 1`，与 SSH 脚本的 `restore_main_config` 保持一致 ⚠️ |
| b | `grep -Fqx -- 'include "..."'` 只做精确行匹配。如果已有一行空格不同的 include，会**重复追加**，BIRD 报重复定义 | 复用 `ACTIVE_BIRD_INCLUDE_AWK`（SSH 脚本已经在用） |
| c | `case "$EXPECTED" in [0-9a-fA-F]*)` 只校验第一个字符 | 改为检查长度等于 64 且全部是十六进制 |
| d | `TMP=/usr/local/bin/...` 之前没有 `mkdir -p /usr/local/bin`，OpenWrt 默认没有这个目录 | 增加 `mkdir -p /usr/local/bin` |
| e | `chgrp ... 2>/dev/null \|\| true` 失败被忽略，BIRD 可能读不到生成的配置 | 失败时给出警告 |

**代码片段：**

```ts
// c. 摘要校验
`case "$EXPECTED" in *[!0-9a-fA-F]*|'') echo 'Agent 校验摘要格式错误' >&2; exit 1;; esac`,
`[ "\${#EXPECTED}" -eq 64 ] || { echo 'Agent 校验摘要长度错误' >&2; exit 1; }`,

// d. 在 TMP=... 之前
"mkdir -p /usr/local/bin",

// b + a. 替换原来的 grep 追加和 "|| true"
`has_active_include() { awk -v target="$GENERATED_CONFIG" '${ACTIVE_BIRD_INCLUDE_AWK}' "$MAIN_CONFIG"; }`,
`MAIN_BACKUP=''`,
`if ! has_active_include; then MAIN_BACKUP=$(mktemp "$MAIN_CONFIG.birdbox.XXXXXX"); cp -p "$MAIN_CONFIG" "$MAIN_BACKUP"; printf '\n%s\n' ${shellSingleQuote(includeLine)} >> "$MAIN_CONFIG"; fi`,
`if command -v birdc >/dev/null 2>&1; then`,
`  if ! birdc -s ${shellSingleQuote(node.socketPath)} 'configure check' || ! birdc -s ${shellSingleQuote(node.socketPath)} configure; then`,
`    [ -n "$MAIN_BACKUP" ] && cp -p "$MAIN_BACKUP" "$MAIN_CONFIG" && rm -f "$MAIN_BACKUP"`,
`    birdc -s ${shellSingleQuote(node.socketPath)} configure >/dev/null 2>&1 || true`,
`    echo 'BIRD 配置检查/加载失败，已恢复主配置；请修复 BIRD 主配置后重新执行' >&2; exit 1`,
`  fi`,
`fi`,
`[ -n "$MAIN_BACKUP" ] && rm -f "$MAIN_BACKUP"`,
```

> ⚠️ **兼容说明（a）：** 原来即使 BIRD 主配置本身有错误，Agent 也能装上并注册，然后在「测试连接」或预检阶段才暴露问题。修改后，**脚本会直接失败，Agent 不会被安装**。这更安全，但改变了用户能看到的流程。建议在发布说明中写明，或者先把 `exit 1` 换成醒目的 `echo WARNING` 过渡一个版本。

---

### P2-8 `legacy.exec`（root shell）已没有业务调用方，但仍然默认开放

**位置：** `src/agent-protocol.ts:44`、`src/node-executor.ts:213-221`、`agent/client.go:145-190`

**现状：** `bird-runtime.ts` 中所有操作都有 `node.transport === "agent"` 分支，走结构化 RPC；`session-runtime-routes.ts` 的接口查询也做了区分。代码中已经**没有业务路径**通过 `executeNodeCommand` 对 Agent 节点下发 shell 命令，只剩测试（`test/bird.test.js:1331`、`test/agent-broker.test.js:12`）在使用。

**风险：** 这是 Agent 上最大的攻击面，配合 P1-7 的中间人就能直接拿到 root。

**建议分两步收紧：**

```ts
// 第一步（本版本即可合并，默认行为不变）：控制器侧增加开关
// src/node-executor.ts executeNodeCommand 中 agent 分支
if (node.transport === "agent") {
  if (process.env.BIRDBOX_AGENT_LEGACY_EXEC !== "enabled" && process.env.NODE_ENV === "production") {
    logger.warn("拒绝通过 legacy.exec 向 Agent 下发 shell 命令", { nodeId: node.id });
    return { ok: false, stdout: "", stderr: "Agent 节点不支持 shell 命令，请使用结构化 RPC", code: "LEGACY_EXEC_DISABLED" };
  }
  // ...原 legacy.exec 逻辑
}
```

```go
// 第二步：Agent 端通过环境变量关闭，准备脚本新生成的 agent.env 默认写入 BIRDBOX_AGENT_LEGACY_EXEC=disabled
if t.Method == "legacy.exec" && os.Getenv("BIRDBOX_AGENT_LEGACY_EXEC") == "disabled" {
	r.Stderr, r.Code = "legacy.exec disabled on this agent", "METHOD_NOT_ALLOWED"
	return r
}
// Register 的 Capabilities 同步不再上报 legacy.exec
```

> ⚠️ **兼容说明：** 第一步只在 `NODE_ENV=production`（镜像默认值）下生效，测试环境不受影响。上线前应在预发环境全面回归一次（节点接入、会话、iBGP、OSPF、源地址映射、升级），确认没有遗漏的调用方。如果发现遗漏，设置 `BIRDBOX_AGENT_LEGACY_EXEC=enabled` 即可立即恢复原行为。第二步只影响新执行的脚本。

---

### P2-9 `BIRDBOX_PUBLIC_URL` 缺少校验

已并入 P1-7 的 `normalizePublicUrl`。补充一点：`docker-compose.yml` 中默认值 `http://127.0.0.1:${BIRDBOX_PORT}` 会被写进远端节点的准备脚本，Agent 必然连不上。除了启动时的告警，生成脚本的接口也应当在 URL 为回环地址时返回 409，并提示去设置 `BIRDBOX_PUBLIC_URL`：

```ts
// NodeOnboardingService.createSetupScript / createAgentUpgradeScript 开头
if (/^https?:\/\/(127\.|localhost|\[::1\])/.test(this.#options.agentControllerUrl ?? "")) {
  fail(409, "BIRDBOX_PUBLIC_URL 仍是回环地址，远端 Agent 无法回连；请在 .env 中设置节点可达的地址后重建容器", "PUBLIC_URL_LOOPBACK");
}
```

> 例外：如果节点与控制器确实在同一台主机上（开发环境），可以增加 `BIRDBOX_ALLOW_LOOPBACK_PUBLIC_URL=true` 跳过这个检查。

---

### P2-10 Agent 可以以 root 身份写任意绝对路径

**位置：** `agent/bird.go` 中的 `birdPaths`。`mainConfigPath`、`generatedConfigPath`、`baseDirectory`、`socketPath` 只经过「安全绝对路径」格式校验，内容完全由控制器决定。

**风险：** 控制器被攻破或遭遇中间人时，攻击者可以把 `generatedConfigPath` 设成 `/etc/cron.d/x` 这样的路径来写入文件。节点更新接口不允许修改这些路径，这是好的，但 Agent 端没有任何约束。

**修改（纵深防御，未配置时保持兼容）：** 准备脚本把路径写入 `agent.env`，Agent 只接受这些路径。

```sh
# agentSetupScript 写入 agent.env 时追加
BIRDBOX_ALLOWED_MAIN_CONFIG='/etc/bird/bird.conf'
BIRDBOX_ALLOWED_GENERATED_CONFIG='/var/lib/birdbox/generated.conf'
BIRDBOX_ALLOWED_SOCKET='/run/bird/bird.ctl'
```

```go
// bird.go birdPaths() 末尾
func enforceAllowed(name, value string) error {
	allowed := strings.TrimSpace(os.Getenv(name))
	if allowed != "" && filepath.Clean(value) != filepath.Clean(allowed) {
		return fmt.Errorf("%s is pinned to %s by agent.env", name, allowed)
	}
	return nil
}
for _, pair := range [][2]string{
	{"BIRDBOX_ALLOWED_MAIN_CONFIG", mainPath},
	{"BIRDBOX_ALLOWED_GENERATED_CONFIG", generatedPath},
	{"BIRDBOX_ALLOWED_SOCKET", socketPath},
} {
	if err = enforceAllowed(pair[0], pair[1]); err != nil {
		return "", "", "", "", "", err
	}
}
if pinned := os.Getenv("BIRDBOX_ALLOWED_GENERATED_CONFIG"); pinned != "" && mode == "include" && baseDirectory != filepath.Dir(pinned) {
	return "", "", "", "", "", fmt.Errorf("baseDirectory must be %s", filepath.Dir(pinned))
}
```

`birdTaskStructured`、`birdAccessTask` 和 `network.ip_rules` 中使用的 `socketPath` 也要做同样的检查。

> 旧的 `agent.env` 里没有这些变量，Agent 的行为与现在一致。如果路径需要变更（目前的设计是删除节点后重新添加），新脚本会写入新的值。

---

## 6. P3 —— 低优先级与工程化

### P3-1 Agent 主循环

**位置：** `agent/main.go`

- **每轮都重新注册。** 循环中 `RunPoll` 正常返回后，下一轮又会调用一次 `Register`。每 25 秒一次注册请求虽然开销不大，但会刷新 `registeredAt` 之外的全部字段。改为只在启动时和出错后才注册。
- **401 时立即 `log.Fatal`。** 控制器在恢复数据库或切换副本的短暂窗口里可能返回 401，Agent 退出后由 systemd 每 5 秒拉起，形成**重启风暴**。建议连续 N 次 401 并退避后再退出，或者一直退避不退出。
- **不检查 `deadlineAt`。** 任务取回来时如果已经过了截止时间，应当直接丢弃，避免执行一个控制器早已放弃的 apply。在控制器看来这次部署已经失败并回滚，Agent 再去执行就会**造成配置分叉**。这一条尤其重要。

```go
// main.go
registered := false
unauthorized := 0
for ctx.Err() == nil {
	if !registered {
		if err := client.Register(ctx, version); err != nil {
			if errors.Is(err, ErrUnauthorized) {
				unauthorized++
				if unauthorized >= 20 { log.Fatal(err) } // 约 10 分钟后才放弃
			}
			log.Printf("register failed: %v", err)
			if !sleepContext(ctx, backoff) { return }
			backoff = min(backoff*2, 30*time.Second)
			continue
		}
		registered, unauthorized, backoff = true, 0, time.Second
	}
	if err := client.RunPoll(ctx); err != nil {
		registered = false
		// ...同上退避
	}
}

// client.go RunPoll：执行之前
if dl, err := time.Parse(time.RFC3339Nano, response.Task.DeadlineAt); err == nil && time.Now().After(dl) {
	log.Printf("drop expired task task_id=%s method=%s", response.Task.TaskID, response.Task.Method)
	return nil
}
// 并用截止时间约束执行上下文
taskCtx := ctx
if dl, err := time.Parse(time.RFC3339Nano, response.Task.DeadlineAt); err == nil {
	var cancel context.CancelFunc
	taskCtx, cancel = context.WithDeadline(ctx, dl)
	defer cancel()
}
r := executeTask(taskCtx, *response.Task)
```

> 注意：控制器和节点的时钟可能有偏差。建议控制器在任务里同时下发 `timeoutMs`，由 Agent 以本地时间计算截止时间。截止时间判断应**只用于丢弃**，不应用来中断正在执行的 `configure`，因为中断可能导致 BIRD 处于不一致状态。上面用 `WithDeadline` 包裹执行上下文的做法，建议只用于只读任务。

---

### P3-2 `atomicWrite` 没有 fsync

**位置：** `agent/bird.go` 中的 `atomicWrite`。路由器掉电很常见，写临时文件、rename、但不 fsync，就可能留下长度为 0 的配置文件，BIRD 重启后无法加载。

```go
if err = tmp.Chmod(mode); err == nil {
	_, err = tmp.Write(data)
}
if err == nil {
	err = tmp.Sync()
}
// ... Close / Chown / Rename 之后：
if dir, derr := os.Open(filepath.Dir(path)); derr == nil { _ = dir.Sync(); _ = dir.Close() }
```

---

### P3-3 预检阶段会临时替换活动符号链接

**位置：** Agent 的 `stageBirdTask`，以及 SSH 的 `stageAndValidate`

`configure check` 只能检查当前的主配置，所以预检时要**临时**把 `generated.conf` 指向候选版本，检查完再恢复。如果在这个窗口里 Agent 或 BIRD 被 kill，或者节点掉电，BIRD 下次启动就会加载**未经确认**的候选配置。这是现有设计的结构性问题。

**建议（设计级，需要评估）：** 改用 `bird -p -c <临时主配置>`。临时主配置是主配置的副本，把其中 include 的路径替换成候选版本。这样检查完全不触碰活动文件。但主配置里可能有相对路径的 include 和各种自定义内容，改动风险较高，**不建议在本轮修改**，可以作为后续架构改进项。短期内至少应当在 Agent 启动时检查：如果发现 `generated.conf` 指向的文件与 `generated.conf.candidate` 相同，而且不存在 `.rollback`，就记录告警。

---

### P3-4 离线 Agent 不快速失败

**位置：** `AgentBroker.dispatch`

Agent 离线时，任务照样入队，等满超时才报错。Dashboard 已经把每个节点的超时限制在 5 秒，但 `inspectProtocolRoutes`（25 秒）、`inspectRoutePath`（20 秒）等接口仍然要等满时间。

```ts
// dispatch() 开头，仅对后台只读方法快速失败；部署类方法保持原样（Agent 可能正在重连）
if (isBackgroundMethod(method) && !this.status(nodeId)?.connected) {
  return Promise.resolve({ taskId: "", nodeId, ok: false, stdout: "", stderr: "Agent 当前未连接", code: "AGENT_OFFLINE" });
}
```

还有一个相关问题：`#agents` 只在内存里。**控制器重启后的 0 到 25 秒内**，所有节点都会显示离线，直到它们重新注册。这是预期行为，但应当写进文档。

---

### P3-5 敏感字段明文回显

`/api/dashboard` 返回完整库存，其中包括 BGP 的 TCP-MD5 `password`、`aoKeys`，RPKI 的 `password`，OSPF 的 `password`；每个变更接口也都会返回 `inventory`。这些字段还会原样出现在：
- 浏览器 DevTools 和 HAR 文件；
- `docker logs`（如果有 debug 日志）；
- MySQL 备份，这一点无法避免，但文档里应当说明。

**建议：** 读取时把这些字段替换为 `"********"` 或者只返回 `hasPassword: true`；写入时如果收到的是占位符，就保留原值。

> ⚠️ **谨慎：** 前端表单（`BgpOptionsEditor.vue`、`RpkiEditorDialog.vue`、`OspfWorkspace.vue`）目前把整个对象回传给 PUT 接口。服务端合并策略和前端必须同时修改，否则会**把密码覆盖成占位符**，所有会话掉线。建议单独立项，并补充端到端测试。

---

### P3-6 可观测性与审计

- **没有变更审计。** 管理员的每次变更只进入内存中的 100 条事件（重启即丢失）和 stdout 日志。建议在 `mutateAndApply` 提交成功后输出结构化审计日志，包含 `{ actorSessionId, address, route, resourceIds, nodeIds, revisionBefore, revisionAfter }`。更进一步，可以写一张 `birdbox_audit` 表。
- **日志字段。** `logger` 已经做了脱敏，但 `errorContext` 只保留了 `message`，丢失了 stack。建议在 `NODE_ENV!=="production"` 或 `BIRDBOX_LOG_LEVEL=debug` 时附带 stack。
- **没有 metrics。** 可以按需增加 `/api/metrics`（Prometheus 格式，需要认证或只监听内网）：部署次数和失败次数、Agent 在线数、任务队列长度、IRR 同步状态。

---

### P3-7 单副本约束没有写进文档

`AgentBroker`（队列和 waiters）、`deploymentLocked`、`nodeOperationLocks`、脚本分发令牌、登录限流、事件日志都在**进程内存**里。部署多个副本的后果：
- Agent 只会长轮询到其中一个副本，另一个副本派发的任务永远不会被执行；
- 脚本 URL 在另一个副本上返回 404。

MySQL 的 `GET_LOCK` 虽然能保证部署事务互斥，但**不能**弥补上面这些问题。

**修改：** 在 `docs/architecture.md` 和 `docker-deployment.md` 中明确写出「只支持单副本运行，不要设置 `replicas>1`，也不要在负载均衡后放多个实例」。可以在 Compose 中为 `birdbox` 服务加上 `deploy: { replicas: 1 }` 作为提示。

---

### P3-8 工程化

| 项 | 现状 | 建议 |
|---|---|---|
| CI | 仓库中没有 `.github/workflows` | 增加：`npm ci` → `typecheck:server` → `typecheck:web` → `npm test`（使用带 `bird` 的 Linux runner）→ `go vet` 和 `go test ./agent` → `npm audit --audit-level=high` → 构建镜像 |
| Go 测试 | Dockerfile 不运行 | 已在 P1-6 的 Dockerfile 中加入 `go vet && go test` |
| Go 版本 | `go.mod` 声明 `go 1.22`，镜像使用 1.24 | 统一版本，并在 `go.mod` 中加 `toolchain` |
| 基础镜像 | `node:24-alpine`、`golang:1.24-alpine`、`mysql:8.4` 都是浮动标签 | 发布时固定 `@sha256:` digest，与 README 中「生产请固定镜像」的要求一致 |
| 版本号 | `0.38a` 不是 semver | 改为 `0.38.0` 或 `0.38.0-alpha.1`。**注意：** Agent 的 `-X main.version` 和前端显示都依赖这个字段，而 Broker 只在版本变化时写日志，没有做版本比较，所以改格式不影响现有逻辑 |
| 包名 | `birdbox-demo` | 改为 `birdbox` |
| 构建产物 | `dist/` 在 `.gitignore` 中；Dockerfile 在构建阶段编译 | 没有问题 |
| E2E | 有 Playwright，但没有进入 CI | 至少在发布脚本中运行 |
| 测试可移植性 | `application-root.test.js` 等在 Windows 上失败 | 维护者主要用 Linux 开发，可以不修，但应在文档中注明「测试只支持 Linux 和 macOS」 |

---

### P3-9 文档与杂项

1. **README 与 Compose 的默认值矛盾。** README「快速部署」的 `.env` 示例写的是 `BIRDBOX_SECURE_COOKIE=true`，但 `.env.example` 和 Compose 默认都是 `false`。如果照 README 设置 `true`，同时直接用 `http://127.0.0.1:3000` 访问，**浏览器不会保存 Cookie，登录后立刻掉线**。建议 README 默认写 `false`，并补充一句「通过 HTTPS 访问时改为 true」。另外，`secureCookieEnabled` 在 `setting === null` 时会根据 `x-forwarded-proto` 自动判断，可以考虑把 Compose 的默认值改为空，交给自动判断。
2. **静态资源没有缓存。** `serveStatic` 不设置 `Cache-Control` 和 `ETag`，每次都重新读磁盘。资源已经带了 `?v=版本号`，可以对 `/migrated/*`、`/vendor/*`、`/styles.css` 设置 `Cache-Control: public, max-age=31536000, immutable`，`index.html` 设置 `no-cache`。
3. **`pinyin-pro` 放在了服务端 `dependencies` 里。** 服务端代码没有使用它，前端又是从 `/vendor/pinyin-pro.mjs` 加载的。可以移到 `devDependencies`，减小生产镜像体积，同时确认 `public/vendor` 中的文件是否由构建脚本从 node_modules 拷贝而来，以免版本漂移。
4. **静态路径的 `startsWith("..")` 判断。** 名为 `..foo` 的合法文件会被误判为越界。实际没有影响，但更规范的写法是 `const full = path.resolve(publicDirectory, normalized); if (!full.startsWith(publicDirectory + path.sep)) 403`。
5. **`serveStatic` 捕获了 `EISDIR`**，结果返回 500。建议对目录一律返回 404。
6. **`ChangeEventLog.list()` 返回内部数组的引用。** 调用方如果修改它，就会污染事件日志。应返回 `[...this.#events]`。
7. **`MemoryDatabase.withLock` 与 MySQL 实现语义不一致。** MySQL 版会立即返回 409；内存版在锁被占用时抛出的错误码虽然相同，但不支持 `timeoutMs`。只影响测试，写进文档即可。

---

## 7. 需谨慎处理的修改汇总

下面这些修改会改变现有用户可见的行为，**不建议与其他修复混在同一个版本里发布**：

| ID | 变化 | 推荐做法 |
|---|---|---|
| P0-1 | 恢复失败时从「容器起不来」变为「服务运行但变更被锁定」 | 同时上线健康检查中的 `recovery` 字段和前端横幅；在发布说明中写明 |
| P1-6 | 新脚本的架构探测结果可能与旧脚本不同 | 只影响新装节点；先在 MT7621、ath79、x86、aarch64 各一台设备上验证 |
| P2-1 | 对已存在的 Agent 节点重新生成脚本时返回 409 | 前端同步增加「重置 Agent 凭据」按钮，并加二次确认 |
| P2-7a | BIRD 主配置本身有错时，Agent 安装脚本直接失败 | 先输出 WARNING 过渡一个版本，再改为 `exit 1` |
| P2-8 | 生产环境默认禁止 `legacy.exec` | 保留 `BIRDBOX_AGENT_LEGACY_EXEC=enabled` 作为逃生开关；先在预发环境做全量回归 |
| P3-3 | 预检方式改为临时主配置 | 设计级改动，单独立项 |
| P3-5 | 密钥字段打码回显 | 前后端必须同时修改，单独立项，并补充端到端测试 |

其余修改都属于修复 bug（异常路径才触发）或新增默认关闭的开关，可以按优先级直接合并。

---

## 8. 建议的实施顺序

**版本 N（热修复，约 1 到 2 天）：** P0-2、P0-3、P0-4、P1-5、P1-8，加上 P1-2 和 P1-3 的 Go 部分，以及 P2-6。
→ 全部都是低风险的 bug 修复。同时发布新的 Agent（其中 P0-2 需要升级 Agent 才能生效；在此之前，控制器会通过能力探测给出明确提示）。

**版本 N+1（约 1 周）：** P0-1、P1-1、P1-4、P1-6、P1-7（告警和可选 CA），以及 P2-1、P2-2、P2-3、P2-4、P2-5、P2-9。
→ 同时补齐第 9 节的测试，建立 CI（P3-8）。

**版本 N+2：** P2-7、P2-8（第一步）、P2-10、P3-1、P3-2、P3-4、P3-6、P3-7、P3-9。

**长期：** P2-8 第二步、P3-3、P3-5、Agent 任务确认机制（ack，见 P1-4 的遗留风险）。

---

## 9. 建议补充的测试

| 场景 | 类型 | 对应问题 |
|---|---|---|
| 有 Agent 节点的未完成部署日志时启动：健康检查可用，Agent 注册后恢复完成，恢复前变更返回 503 | 集成测试 | P0-1 |
| 下发 3 MiB 配置：新 Agent 成功；旧 Agent（没有 `task.large_payload`）收到 `AGENT_UPGRADE_REQUIRED` | broker 单测 + Go 单测 | P0-2 |
| 未登录访问 setup-script 返回 404、提交非法 JSON、跨站 Origin：响应中不含 `events` | 路由单测 | P0-3 |
| `store.read` 抛错时 IRR 调度不导致进程退出 | 单测 | P0-4 |
| 升级接口忽略客户端提交的 `url` 和 `targetPath`；未知架构返回 409 | 路由单测 | P1-1 |
| 连续 50 次 stage/apply 后，`versions/` 下的文件数量有上限 | Go 单测 | P1-2 |
| 删除资源后进行跨节点回滚，节点 A 恢复成功 | Go 单测 + 集成测试 | P1-3 |
| 长轮询中途断开后派发任务，任务被重新入队并由下一次轮询取走 | broker 单测 | P1-4 |
| 模拟 90 秒的部署，HTTP 连接不被切断 | 集成测试 | P1-5 |
| 对 `uname -m=mips` 加小端 ELF、以及 OpenWrt `DISTRIB_ARCH=mipsel_24kc` 的输出做架构探测 | 脚本单测（busybox 容器） | P1-6 |
| 对已存在节点生成脚本返回 409；带 `rotateCredential` 时成功 | 路由单测 | P2-1 |
| `algorithm="hmac sha256; }"` 在渲染阶段被拒绝 | 渲染单测 | P2-5 |

---

## 10. 附：审计中确认**没有问题**的要点

以下几点在审计中专门核查过，结论是实现正确，修改时不要改动：

- 所有拼进远端 shell 的路径都经过 `ABSOLUTE_PATH_RE=/^\/[A-Za-z0-9_./-]{1,254}$/` 校验，其中不可能出现单引号，所以 `'${path}'` 拼接是安全的。
- `sshArgs` 使用 `--` 分隔参数，主机名禁止以 `-` 开头，`sshUser` 也有正则约束，不存在 OpenSSH 参数注入。
- `bgpq4` 通过 `spawn` 调用，参数以数组传入，AS-SET 和 Server 都有白名单正则，不存在命令或参数注入。
- `network.ip_rules` 在 Agent 端再做一次 CIDR、table 和 priority 校验，并用 exec 数组调用 `ip`。
- Fastify 插件的封装边界正确：`mutationRoutes` 和 `sessionRuntimeRoutes` 的 `onRequest` 认证钩子只作用于各自插件内的路由，而 `/api/agent/*` 的 Agent 接口位于独立插件，不受这两个钩子影响（由 Agent token 认证）。
- `updateNode` 禁止修改 `transport` 和各个路径，因此 `local` 这种 transport（会在控制器容器内执行 `bash -lc`）无法通过 API 引入，只能来自 seed 文件 `config/nodes.json`。
- 认证方面：会话 token 只保存哈希并使用 `timingSafeEqual` 比较；修改密码会注销所有会话；从旧版迁移时不会保留旧的 token。
- MySQL CAS 在连接丢失后会重新读取，确认写入是否已经提交，避免错误地回滚一次已经成功的部署（`store.replace`）。

---

## 11. 追加审计：功能流程、CRUD 与前端样式（实测）

> 此节是对前述源码审计的**功能性补充**，不是对安全问题优先级的覆盖。被测代码仍是 `9f59b31`，没有改动仓库源码。实验环境为 Debian 13/WSL 隔离用户、网络与挂载命名空间；两个独立 network namespace 各运行 BIRD 2.17.5 和原仓库 Go Agent，控制器运行 Node 24 和内存数据库。实验仅验证受控测试网络；**没有**连接真实生产路由器、MySQL 8.4 或 BIRD 2.19.1。
>
> 另用 Windows Chromium/Playwright 对桌面 1440×1000、平板 900×1100、移动端 390×844 的亮色/暗色页面进行截图和 DOM 溢出检查。浏览器数据采用现有截图脚本的模拟库存，**页面测试与真实协议实验是两类不同的证据，不能互相替代**。截图及实验辅助脚本是审计过程中的临时材料，不属于交付物。

### 11.1 实测结论：OSPF 能否跑通？

**能在上述实验条件下跑通完整主流程，但暂不宜据此撤销项目自带的生产风险警告。** 实际操作与结果如下：

1. 两个真实 Agent 节点经 `setup-script → register → test → POST /api/nodes` 接入；两个独立 BIRD 进程分别在隔离网络命名空间中运行。
2. 通过 `POST /api/ospf/preview` 对 **OSPFv2 + OSPFv3** 的配置做了目标节点的真实 `birdc configure check`，返回 `valid=true`。
3. 通过 `POST /api/ospf` 创建跨节点链路后，两侧 BIRD 的 `show ospf neighbors` 出现 `Full/PtP`：IPv4 和 IPv6 邻居均建成（测试网卡配置了两个 IPv4 地址，OSPFv2 出现两个邻接，这是实验网段的配置结果，不代表所有拓扑都会出现两个邻接）。
4. `/api/ospf/:domainId/runtime` 返回节点可达、邻居详情与路由统计；**n1 的 Static 资源前缀 `198.51.100.0/24` 经 OSPF 重分发到 n2，n2 的 Kernel 资源将它写入隔离命名空间的 Linux 路由表**。
5. `PUT /api/ospf/:domainId` 把链路 Cost 从 10 改到 30，生成配置相应变化，邻居恢复到 Full；`PATCH /api/ospf/layout` 与 `PATCH /api/ospf/:domainId/layout` 成功。
6. 向同一节点创建自环链路得到 400，原域未被覆盖；`DELETE /api/ospf/:domainId` 成功后协议从 `birdc show protocols` 消失，学习到的内核路由撤回。

**边界：** 未验证 OSPF 密码认证、BFD、虚链路、NSSA、多 Area、链路故障切换、BIRD 2.19.1/OpenWrt 实机、数据库故障下恢复或真实多用户同时操作。OSPF 工作区本身在 `apps/web/src/app/AppRoot.vue:432-435` 明确提示“实验阶段，勿在生产网络使用”；一次双节点成功不等于所有选项达到生产标准。

**实测补充发现：** 创建源地址出口映射后，BIRD 确实生成递归默认路由，Agent 确实写入了 `ip rule`，但实验中出口表显示 `unreachable default proto bird`。原因是我只在 n2 建了 Direct 资源，n1 的 `master4` 没有用于解析出口地址的直连路由。**这不能直接定性为产品渲染缺陷**；它证明“配置预检/保存成功”不能替代“策略路由下一跳可达”。建议在源地址映射预检后增加运行态检查 `birdc show route table master4 for <出口IP> all`，把“递归出口目前不可达”作为醒目警告（而不是直接拒绝保存，因为初次部署时路由可能尚未收敛）。

### 11.2 实测的其他功能

受控实验共执行 **77 项步骤，其中 76 项通过、1 项测试请求失败**。通过项目包括：

| 功能 | 实验结果 | 说明 |
|---|---|---|
| 认证 | 通过 | 首次设置管理员、重复设置拒绝、错误/正确密码登录、会话列表 |
| 节点 | 通过 | 双 Agent 注册、连接测试、创建、编辑节点名、禁止改部署路径、读取实际网卡、在线状态、在线删除及强制删除 |
| Define / Function / Filter | 通过 | IPv4/IPv6/表达式 Define 创建及更新；Function 创建、排序；Filter 引用和修改；错误 BIRD 语法在预检时被拒绝且未写库存；引用中的 Function/Define 不可删除 |
| Static / Direct / Kernel | 通过 | 创建、更新、删除；BIRD 实际出现 Static 与 Kernel 协议；Static 的 `blackhole → unreachable` 变化在 BIRD 运行态可见 |
| RPKI | 部分通过 | 本地 ROA 文件型资源的创建/停用/删除及 BIRD 配置检查通过；**没有真实 RPKI 数据或缓存服务器**，不声称 ROA 同步正常 |
| eBGP | 通过 | Peer 创建/修改；会话预检/应用/更新/停用/删除；真实 BGP `Established`、跨节点前缀传播、导入/导出明细与路径查询、运行态 disable/enable、Kernel FIB 下发与撤回 |
| iBGP | 通过 | 域预检/创建/改名/布局/删除，双向托管会话生成且达到 `Established`；直接删除域托管会话返回 409 |
| OSPF | 通过（限定场景） | 详见 11.1 |
| 源地址出口映射 | 功能调用通过 | 预检/创建/更新/删除及真实 `ip rule`增删通过；本实验的默认路由为 unreachable，未证实数据面可用 |
| Agent 升级 | 通过 | 用合法摘要下载并替换指定路径的二进制；错误摘要得到 `CHECKSUM_FAILED`；**没有测试服务重启和失败后的自动回退** |
| 故障注入 | 1 项失败，其余通过 | 关闭 n2 BIRD 时预检返回 422、n1 活动配置不变；n2 Agent 重新上线后变更成功。**n2 Agent 离线时 PUT 耗时约 61.5 秒后前端 `fetch failed`，并未收到服务器返回的失败详情**；控制器日志随后显示 `Agent 任务超时`，库存未提交。这是前述 P1-5（60 秒连接超时）与离线节点等待 60 秒的交互所致。|

**实验之外：** 原生单测在 Debian + BIRD 2.17.5 + Node 24 下得到 152 通过 / 1 失败 / 5 跳过；唯一失败是 `test/server-resource.test.js` 的 local 传输实验调用 `install -o bird`，实验容器无 `bird` 系统用户，错误为 `install: invalid user 'bird'`，不是 OSPF 语法错误。Go `go vet ./...` 与 `go test ./...` 均通过。原生 BIRD 集成用例硬编码 `/usr/sbin/bird`，实验二进制在用户目录，故相关用例跳过；上述双节点实验改为通过 PATH 调用真实 BIRD 解析和运行。

**对先前审计的补强：** 单次从初始空配置到清理的实验，在 n1 的 `birdbox/versions` 中留下 **31 个版本文件**；这直接验证 P1-2 的“Agent 版本文件不清理”。实验还显示删除节点时生成配置清空，凭据撤销后 Agent 日志出现 `agent credentials rejected`，符合现有设计。

### 11.3 操作覆盖矩阵：后端支持与前端入口

以下“前端入口”指可在现有 Vue 页面找到对应的创建/编辑/删除动作；“通过”仅指上述实际测试覆盖的场景：

| 对象 | 后端 API 增/查/改/删 | 前端入口 | 功能测试判断 |
|---|---|---|---|
| 节点 | 创建 / Dashboard 查询 / PUT / DELETE（含强制） | 有 | 双 Agent 接入、更新、两种删除通过；准备脚本中途失败与旧 SSH 升级未实测 |
| eBGP Peer | POST / Dashboard / PUT / DELETE | 有 | 真实网络创建/编辑/删除通过 |
| eBGP 会话 | `POST /sessions/preview`、`POST /sessions/apply`（新建/修改/停用）、Dashboard、DELETE | 有 | `Established`、运行态启停、路由收发、修改/删除通过 |
| iBGP 域 | POST / GET / PUT / DELETE / preview / PATCH layout | 有 | 双向会话建立；域编辑/删除通过 |
| **OSPF 域** | POST / GET / PUT / DELETE / preview / PATCH layout | **仅第一域的创建和修改；没有域切换、域命名或域删除入口** | **后端完整流程实测通过，前端多域和删除不可操作**（详见 F-1） |
| OSPF 链路 | 随整个域 POST/PUT/DELETE | 有“添加链路”和单链路编辑；删除需在链路编辑 UI 核实 | 本实验通过域 PUT 修改 Cost / DELETE 删除整域；**未实测前端逐链路删除** |
| Define | POST / Dashboard / PUT / DELETE；Define/Function 提供 move | 有 | 创建、修改、排序（Function）、引用限制通过 |
| Function / Filter | POST / Dashboard / PUT / DELETE | 有 | 错误源码被拒绝，引用限制通过 |
| Static / Direct / Kernel | POST / Dashboard / PUT / DELETE | 有 | 创建、修改、删除以及 BIRD 可见通过 |
| RPKI | POST / Dashboard / PUT / DELETE | 有 | 文件型基础 CRUD 通过，RTR 联网未测 |
| 源地址出口映射 | POST / Dashboard / PUT / DELETE / preview / plan | 有 | Agent `ip rule` 生命周期通过；递归路由数据面未验证 |
| Agent 批量升级 | POST job / GET job | 有 | UI 弹窗曾打开；**没有实际多节点升级验证** |

**关键注意：** CRUD API 齐全不代表前端可达，也不代表全部高级参数在目标 BIRD 版本上可用。OSPF 的前端缺口是确定性的；没有实测的功能应标为“未验证”，而非“正常”。

### 11.4 新增功能问题与修改建议

#### F-1｜高：OSPF 后端支持多域，前端却只能操作 `domains[0]`，且没有删除域入口

**证据：** `src/http/mutation-routes.ts` 注册了 `GET/POST/PUT/DELETE /api/ospf...`；`src/resource-application-service.ts:1134-1173` 实现了域增改删；但 `apps/web/src/ospf/OspfWorkspace.vue:1335` 只取 `response.domains[0]`，`:729-731` 保存时把 `name` 固定写为 `"默认 OSPF 域"`，`:750-765` 仅 POST/PUT，全文件没有针对 `/api/ospf/:id` 的 DELETE 请求，也没有域选择/改名控件。

**后果：** 如果 API/旧数据里已有第二个域，界面看不到且无法修改、删除；保存第一域可能把它原来的域名改为默认名。用户无法经 UI 完成 OSPF 域的删除，即使后端已实现。单条 OSPF 链路也只有 `links.value.push(...)` 增加和字段编辑，没有对应的 `links.value.splice(...)` / 按 id 删除入口；“删除 Area 下的 Networks/External/Stubnet 项”和“删除 Virtual Link”是不同功能，不能算链路删除。

**建议（单独 PR、谨慎兼容）：**

1. 增加 `domains = ref<OspfDomain[]>([])`、`selectedDomainId = ref<string|null>(null)`、域名编辑框/域下拉选择器；加载时保留当前选中 ID，若已不存在再默认选第一个，不再每次硬选 `[0]`。
2. 引入 `domainName` 表单字段；`domainPayload()` 改为 `name: domainName.value.trim()`，编辑时加载服务器原名，避免修改其它字段时误改域名。
3. 增加“新建域”（清空**仅当前域草稿**、分配新 ID）和“删除域”（显示影响节点数、协议会话重建风险，要求确认；调用 `DELETE /api/ospf/${encodeURIComponent(selectedDomainId.value)}`；成功后重新获取权威库存）。**不要复用 iBGP 删除按钮直接删本地状态**，须以服务端部署成功为准。
4. 链路编辑器增加“删除此链路”，按稳定的 `link.id` 从草稿中过滤；保存前显示将要下线的两端节点/OSPF 邻接；预检通过后再提交。删除链路不应自动清空 `nodeConfigs`（无链路节点可保留独立协议配置），避免额外改变现存流程。
5. 先加回归：多域加载选中、修改不改名、删除选中域后切换、删除链路后 POST/PUT payload 不含它、后端失败时原草稿保留。确认旧库存默认域仍能被正确编辑后，才开放“新建多域”。

一个最小入口伪码：

```ts
// OspfWorkspace.vue（省略具体类型和响应异常处理）
const domains = ref<OspfDomain[]>([]);
const selectedDomainId = ref<string | null>(null);
const domainName = ref("默认 OSPF 域");
async function reloadDomains() {
  const response = await api<OspfListResponse>("/api/ospf");
  domains.value = response.domains;
  const selected = response.domains.find((d) => d.id === selectedDomainId.value)
    ?? response.domains[0] ?? null;
  selectedDomainId.value = selected?.id ?? null;
  domainName.value = selected?.name ?? "默认 OSPF 域";
  hydrateSelectedDomain(selected, response.layout); // 复用目前 1335 行后的填表逻辑
}
async function deleteSelectedDomain() {
  if (!selectedDomainId.value || !window.confirm(`确认删除域“${domainName.value}”？其邻接将被撤销。`)) return;
  await api(`/api/ospf/${encodeURIComponent(selectedDomainId.value)}`, { method: "DELETE" });
  selectedDomainId.value = null;
  await reloadDomains(); await loadDashboard(null, null);
}
function removeLink(linkId: string) {
  links.value = links.value.filter((link) => link.id !== linkId);
}
```

#### F-2｜中：OSPF 警告弹窗使现有 E2E 测试全部卡住

**证据：** `AppRoot.vue:216-239` 首次进入 OSPF 要点击“我已了解风险，继续”；但 `test/e2e/ospf-workspace.spec.ts` 中 4 个用例在 `#ospfWorkspaceTab` 点击后就断言 `#ospfWorkspace` 可见，没有确认弹窗。**实际运行：桌面 OSPF 4/4 失败**，四例均卡在 workspace `hidden`；临时给用例补上确认点击后，桌面 **4/4**、移动端 **4/4** 通过；其它桌面 3 项、移动端 3 项也通过。临时用例已删除，仓库源码未变。

**修改：** 在该测试文件统一封装 `openOspfWorkspace(page)`：

```ts
async function openOspfWorkspace(page: Page) {
  await page.locator("#ospfWorkspaceTab").click();
  const dialog = page.locator("#ospfWarningDialog");
  if (await dialog.isVisible()) {
    await dialog.getByRole("button", { name: "我已了解风险，继续" }).click();
  }
  await expect(page.locator("#ospfWorkspace")).toBeVisible();
}
```

同时给“返回”和“确认”各加一个独立测试，避免以后弹窗改动导致 OSPF 主用例假失败。警告每刷新一次页面都会出现是当前产品行为；可选地以 `sessionStorage` 记忆本浏览器当前会话的确认结果（不建议悄悄永久跳过风险提示），但测试修复无需等待此功能变更。

#### F-3｜高：Vite 抽出的 Vue 组件样式完全没有被页面加载

**证据与复现：** `npm run build:web` 生成 `public/migrated/birdbox-demo.css`（约 1 KB），其中有 `BatchAgentUpgradeDialog.vue` 和 `ResourceWorkspace.vue` 的 scoped CSS；`public/index.html` 只加载 `/styles.css`，没有加载该 CSS。Chromium 实际 `document.styleSheets` 只有 `styles.css`，也找不到 `.batch-upgrade-row` 规则。截取的**批量升级 Agent 弹窗**内容贴边、状态行无边框、列表无间距，亮色和暗色均可复现；资源管理标题右侧的按钮行与选择数也没有这些 scoped 布局样式。

**最小修复（`public/index.html`）：**

```html
<link rel="stylesheet" href="/styles.css?v=__BIRDBOX_VERSION__">
<link rel="stylesheet" href="/migrated/birdbox-demo.css?v=__BIRDBOX_VERSION__">
```

**更稳妥：** 在 `apps/web/vite.config.ts` 的 `build.lib` 中显式设置 `cssFileName: "birdbox-demo"`，在 `build` 中设置 `cssCodeSplit: false`，固定产物名称；构建后 CI 校验 `public/index.html` 引用的 CSS 文件确实存在，并通过浏览器断言 `.batch-upgrade-row` 的 `display` 为 `flex`。目前弹窗也没有 `<form>` 容器，因此不会获得 `public/styles.css:763` 的 `dialog form { padding: 22px }`；**只加 CSS link 仍需补 `padding: 22px`**（可以加在 `dialog.batch-upgrade-dialog` 上）。scoped CSS 里的 `--border-color`、`--text-muted` 与全局设计 token `--line`、`--muted` 不一致；将 fallback 换为全局变量，状态色用 `--green` / `--red` 等现有 token，确保暗色下对比度可接受。

> 此修复会改变 Batch 弹窗及资源标题行的布局；先在桌面、移动端和两种主题截图对比，再发布。

#### F-4｜中：移动端 OSPF 操作区、资源表有明显拥挤

**实测界面：** 390px 移动端 OSPF 顶部“预检配置/保存并应用”和拓扑的“重置拓扑/查询路径/添加链路”按钮会折成狭窄多行；节点拓扑在固定宽画布中须拖拽才能找全，操作入口缺乏明确的“可拖动”提示。移动端资源管理表把 Router ID 列隐藏后，“管理方式”文字仍被切割成多行，SSH 地址与端口拆行。尽管自动检查显示 `documentElement.scrollWidth <= clientWidth`，**这只能证明没有整页水平溢出，不代表可读或易用**。资源 tab 在移动端横向滚动，因此屏幕外的 tab 本身不算 bug；应增加滚动提示或渐隐边缘。

**建议：** `@media (max-width: 640px)` 下把 OSPF 工具条做两行栅格/独立 `details` 菜单；主保存按钮固定可见但不遮挡内容；`ResourceTable.vue` 节点表管理方式移动端只展示 `Agent / SSH` 状态标签，详细地址放在节点二级文本；拓扑加“拖拽空白处平移，滚轮或按钮缩放”的触屏说明；优先实机检查 320/375/390/430px 以及 200% 缩放和长中文节点名。

#### F-5｜低：测试页面控制台请求错误须区分模拟环境与产品缺陷

模拟截图环境中 `/api/nodes/edge/interfaces` 返回 502（Windows 本地 OpenSSH 的 ControlPath 超长），浏览器出现 “Failed to load resource” 错误。实际追踪表明所查看页面的脚本和**已引用**的 `/styles.css` 加载正常；其它模拟请求报出的 404 尚未逐一定位，**不要无证据地归因于静态资源缺失**。F-3 的问题不是 HTTP 404，而是 Vite 生成的额外 CSS **根本没有被 HTML 引用**。前端应在节点接口查询失败时显示错误及重试，而不是仅留下控制台错误。

### 11.5 建议的功能验收门槛

| 验收层 | 必须通过的项目 |
|---|---|
| 仓库自动化 | 修复 F-2 后，既有 Playwright 用例在 desktop/mobile 全绿；新增多域/删域/删链路测试、CSS 加载断言和服务端长请求用例 |
| 协议实验室 | 至少两台独立节点实测 OSPFv2/v3 `Full`、前缀重分发和撤回、Cost 更新、跨节点回滚；eBGP/iBGP 与源地址策略规则无回归 |
| 实机兼容 | BIRD 2.19.1、实际 Linux 与 OpenWrt 各至少一组；特别检查不同网卡名、OSPF 密码/BFD/NSSA、网络断链重连、Flash 版本文件清理与系统重启后恢复 |
| 数据层 | MySQL 8.4 上进行创建/更新/删除/失败回滚/控制器重启后的部署日志恢复，不以本次内存数据库实验代替 |
| 页面 | 320、375、390、430、900、1440px，亮/暗主题；键盘导航、弹窗打开关闭、长节点名、真实错误态、无横向整页溢出和按钮重叠 |

**最终判断：** 核心 OSPFv2/v3 的预检、部署、邻接、路由、修改及 API 删除在隔离实验室已跑通；但 OSPF 前端缺少多域、域删除和链路删除入口（F-1），现有 OSPF 自动化测试被风险弹窗阻断（F-2），还有未加载的组件样式（F-3）及移动端可用性问题（F-4）。这些与前述 P0/P1 项一起，仍构成生产放行的阻碍。

## 12. 修复后复核（2026-10-01）

本节覆盖本报告提出的问题在当前工作树中的落地状态。前文保留审计时的原始证据，不能再作为当前实现状态的唯一结论；发布前应以本节命令输出和 `docs/production-readiness-checklist.md` 为准。

### 12.1 已完成的代码闭环

| 项目 | 当前实现 | 兼容性与残余风险 |
|---|---|---|
| P0-1 | 控制器先监听 HTTP，再后台退避恢复未完成部署；恢复期间健康接口可见 `recovery`，写操作返回 503；Agent 注册、轮询并回传恢复任务后自动解锁 | 改变了“恢复失败时进程不监听”的旧行为；需要监控 `recovery=failed`，不能把 200 健康响应当作远端部署已恢复。`test/deployment-lifecycle.test.js` 已覆盖真实 HTTP listener、Agent register/poll/result 和恢复前后锁状态 |
| P0-2~P2-10 | Agent 大响应、升级固定参数、版本 GC/删除回滚、长轮询重投、长请求、OpenWrt 架构/TLS、输入校验和路径白名单均已实现 | 旧 Agent 对大任务仍会收到明确升级提示；明文 HTTP 仍只适合受信任内网，生产必须使用 HTTPS |
| P3-3 | SSH 和 Agent 的 Include 预检都在临时主配置/生成文件上执行 `bird -p -c`，不替换活动 generated/resource 链接；只有 apply 才切换 | 临时目录和 `mktemp`/`readlink -f` 需在目标 OpenWrt 发行版做一次灰度验证；失败时活动配置保持不变 |
| P3-5 | Dashboard、资源、预览中的密码和令牌脱敏 | 脱敏不能替代权限控制；审计和日志不得记录原始密钥 |
| P3-6 | MySQL 迁移创建有界 `birdbox_audit_events`；管理员 API 查询；Prometheus `/metrics` 可选令牌保护；Agent 高频轮询排除在审计之外 | 审计写入异步，数据库暂时不可用时请求不失败但会记录错误；应监控日志并定期备份审计表 |
| F-1~F-5 | OSPF 多域/删除、风险弹窗、CSS 加载、错误态和移动端 320/375/390/430px 回归已补齐 | Playwright 是布局回归证据，仍需发布前在真实触摸设备检查可读性 |

### 12.2 当前验证命令

在 Linux CI/发布构建中执行：

```bash
npm run typecheck:server
npm run typecheck:web
npm test
(cd agent && go vet ./... && go test ./...)
npm audit --omit=dev --audit-level=high
npm run build
npm run test:e2e -- --project=desktop --project=mobile
```

关键专项证据包括：

- `agent/bird_test.go` 执行隔离预检命令并断言活动 generated/resource 链接不变；
- `test/deployment-lifecycle.test.js` 启动真实 Fastify listener，在 pending recovery 时验证 `/api/health=200`、变更接口 `503`，再通过 Agent HTTP 注册/轮询/结果回传完成恢复并验证自动解锁；
- `test/observability.test.js` 验证审计写入、Agent 高频请求排除、metrics 令牌保护；
- `test/e2e/ospf-workspace.spec.ts` 验证风险确认、失败恢复和 320/375/390/430px 无整页溢出；
- `test/database-schema.test.js` 验证审计表迁移和 MySQL 表契约。

### 12.3 发布判断

清单中的 P0、P1、P2、P3 和 F 项均已在代码与自动化测试层闭环；其中 P0-1 现在有完整的启动恢复集成证据，而不是仅有状态门控单测。生产发布仍需先完成一次真实 MySQL、真实 BIRD/OpenWrt 和反向代理灰度；灰度期间重点观察部署恢复、Agent 长轮询重连、Include 预检不改活动文件、审计表增长和 OSPF 移动端布局。未完成这些环境级验证时，只能称为“通过自动化门槛的候选版本”，不能宣称已替代真实节点验收。
