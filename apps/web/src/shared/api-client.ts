import { dispatchAuthRequired } from "./events";
import type { MutationWaitPresentation } from "./interaction-state";

const API_READ_TIMEOUT_MS = 20_000;
const API_MUTATION_TIMEOUT_MS = 60_000;
const API_DEPLOYMENT_TIMEOUT_MS = 1_810_000;

interface ApiErrorBody {
  error?: unknown;
  code?: unknown;
}

export interface ApiRequestOptions extends RequestInit {
  timeoutMs?: number;
  mutationWait?: boolean;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly data: unknown;
  readonly unknownOutcome: boolean;

  constructor(
    message: string,
    { status = 0, code = null, data = null, unknownOutcome = false }: {
      status?: number;
      code?: string | null;
      data?: unknown;
      unknownOutcome?: boolean;
    } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.data = data;
    this.unknownOutcome = unknownOutcome;
  }
}

function isDeploymentMutation(path: string, method: string): boolean {
  if (method === "GET") return false;
  if (/^\/api\/(defines|functions|filters|rpki|statics|source-policies)(?:\/|$)/.test(path)) return true;
  if (/^\/api\/sessions\/(?:preview|apply)$/.test(path)) return true;
  if (method === "DELETE" && /^\/api\/sessions\//.test(path)) return true;
  if (path === "/api/nodes/test" || (path === "/api/nodes" && method === "POST")) return true;
  if (/^\/api\/ibgp-domains(?:\/|$)/.test(path)) return method !== "PATCH" || /\/layout$/.test(path);
  if (/^\/api\/nodes\/[A-Za-z_][A-Za-z0-9_]*$/.test(path) && method === "PUT") return true;
  if (/^\/api\/nodes\/[A-Za-z_][A-Za-z0-9_]*$/.test(path) && method === "DELETE" && !path.includes("force=true")) return true;
  return /^\/api\/peers\/[A-Za-z_][A-Za-z0-9_]*$/.test(path) && method === "PUT";
}

function mutationWaitPresentation(path: string, method: string): MutationWaitPresentation {
  const pathname = path.split(/[?#]/, 1)[0] ?? path;
  let title = "正在处理变更";
  if (pathname === "/api/sessions/apply") title = "正在应用会话变更";
  else if (pathname === "/api/sessions/preview") title = "正在预检会话配置";
  else if (/^\/api\/sessions\/[^/]+\/control$/.test(pathname)) title = "正在更新会话状态";
  else if (method === "DELETE" && /^\/api\/sessions\//.test(pathname)) title = "正在移除会话";
  else if (pathname === "/api/nodes/test") title = "正在检查节点接入条件";
  else if (pathname === "/api/nodes/setup-script") title = "正在生成节点准备脚本";
  else if (/^\/api\/nodes(?:\/|$)/.test(pathname)) title = method === "DELETE" ? "正在删除节点" : "正在保存节点";
  else if (/^\/api\/peers(?:\/|$)/.test(pathname) || /\/peers$/.test(pathname)) title = method === "DELETE" ? "正在删除 Peer" : "正在保存 Peer";
  else if (/^\/api\/statics(?:\/|$)/.test(pathname)) title = method === "DELETE" ? "正在删除 Static" : "正在应用 Static 变更";
  else if (/^\/api\/rpki(?:\/|$)/.test(pathname)) title = method === "DELETE" ? "正在删除 RPKI" : "正在应用 RPKI 变更";
  else if (/^\/api\/source-policies(?:\/|$)/.test(pathname)) title = method === "DELETE" ? "正在删除源地址出口映射" : "正在应用源地址出口映射";
  else if (/^\/api\/(defines|functions|filters)(?:\/|$)/.test(pathname)) title = method === "DELETE" ? "正在删除策略资源" : "正在应用策略资源变更";
  else if (/^\/api\/ibgp-domains(?:\/|$)/.test(pathname)) title = method === "DELETE" ? "正在删除 iBGP 域" : "正在应用 iBGP 域变更";
  else if (pathname === "/api/auth/login") title = "正在验证登录";
  else if (pathname === "/api/auth/setup") title = "正在设置管理密码";
  else if (pathname === "/api/auth/password") title = "正在更新管理密码";
  else if (/^\/api\/auth\/sessions(?:\/|$)/.test(pathname)) title = "正在注销登录会话";
  else if (pathname === "/api/auth/logout") title = "正在退出";
  return {
    title,
    detail: isDeploymentMutation(path, method) ? "正在变更，请等待节点返回结果" : "请求正在处理，请稍候",
  };
}

function dispatchMutationStart(requestId: number, presentation: MutationWaitPresentation): void {
  window.dispatchEvent(new CustomEvent("birdbox:mutation-start", { detail: { requestId, presentation } }));
}

function dispatchMutationEnd(requestId: number): void {
  window.dispatchEvent(new CustomEvent("birdbox:mutation-end", { detail: { requestId } }));
}

function dispatchUnknownMutationOutcome(): void {
  window.dispatchEvent(new CustomEvent("birdbox:unknown-mutation-outcome"));
}

let requestSequence = 0;

export async function api<Response>(path: string, options: ApiRequestOptions = {}): Promise<Response> {
  const { signal: callerSignal, timeoutMs, headers, mutationWait = true, ...fetchOptions } = options;
  const method = String(fetchOptions.method ?? "GET").toUpperCase();
  const requestId = ++requestSequence;
  const showMutationWait = method !== "GET" && mutationWait;
  if (showMutationWait) dispatchMutationStart(requestId, mutationWaitPresentation(path, method));

  const controller = new AbortController();
  const timeout = timeoutMs ?? (method === "GET"
    ? API_READ_TIMEOUT_MS
    : isDeploymentMutation(path, method) ? API_DEPLOYMENT_TIMEOUT_MS : API_MUTATION_TIMEOUT_MS);
  let timedOut = false;
  const abortFromCaller = (): void => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener("abort", abortFromCaller, { once: true });
  }
  const timeoutId = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout);

  try {
    const response = await fetch(path, {
      credentials: "same-origin",
      ...fetchOptions,
      signal: controller.signal,
      headers: { "content-type": "application/json", ...headers },
    });
    const responseText = await response.text();
    let data: unknown;
    try {
      data = responseText ? JSON.parse(responseText) : {};
    } catch {
      throw new ApiError(`服务器返回了无效响应 (${response.status})`, { status: response.status });
    }
    if (!response.ok) {
      const errorBody = data as ApiErrorBody;
      const code = typeof errorBody.code === "string" ? errorBody.code : null;
      const message = typeof errorBody.error === "string" ? errorBody.error : `请求失败 (${response.status})`;
      if (response.status === 401 && code === "AUTH_REQUIRED") dispatchAuthRequired();
      throw new ApiError(message, { status: response.status, code, data });
    }
    return data as Response;
  } catch (error) {
    if (timedOut) {
      const unknownOutcome = method !== "GET";
      if (unknownOutcome && isDeploymentMutation(path, method)) dispatchUnknownMutationOutcome();
      throw new ApiError("请求超时，服务端可能仍在处理；请刷新状态后确认结果", {
        code: "REQUEST_TIMEOUT",
        unknownOutcome,
      });
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
    callerSignal?.removeEventListener("abort", abortFromCaller);
    if (showMutationWait) dispatchMutationEnd(requestId);
  }
}
