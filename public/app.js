import { pinyin } from "/vendor/pinyin-pro.mjs";
import { createMutationWaitController, resetFormPending, setFormPending } from "/interaction-state.js";
import { availablePolicySourceReferences, policySourceReferenceInsertion } from "/policy-references.js";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const elements = {
  authView: $("#authView"),
  appHeader: $("#appHeader"),
  appMain: $("#appMain"),
  refresh: $("#refreshButton"),
  nodeSelect: $("#nodeSelect"),
  peerSelect: $("#peerSelect"),
  selectionLoadingStatus: $("#selectionLoadingStatus"),
  globalState: $("#globalState"),
  sessionForm: $("#sessionForm"),
  sessionPreviewOverlay: $("#sessionPreviewOverlay"),
  preview: $("#previewButton"),
  apply: $("#applyButton"),
  removeSession: $("#removeSessionButton"),
  stop: $("#stopButton"),
  mutationWaitDialog: $("#mutationWaitDialog"),
  applyDialog: $("#applyDialog"),
  nodeDialog: $("#nodeDialog"),
  peerDialog: $("#peerDialog"),
  policyResourceDialog: $("#policyResourceDialog"),
  policyActionDialog: $("#policyActionDialog"),
  staticDialog: $("#staticDialog"),
  rpkiDialog: $("#rpkiDialog"),
  routeDialog: $("#routeDialog"),
  nodeCleanupDialog: $("#nodeCleanupDialog"),
};

const mutationWaitController = createMutationWaitController(
  elements.mutationWaitDialog,
  $("#mutationWaitTitle"),
  $("#mutationWaitDetail"),
);

let state = null;
let busy = false;
let autoPreviewTimer = null;
let lastPreviewSignature = null;
let policyActionContext = null;
let authMonitorTimer = null;
let dashboardRequestId = 0;
let dashboardAbortController = null;
let dashboardLoading = false;
let previewRequestId = 0;
let previewAbortController = null;
let previewInFlight = false;
let policyActionContextId = 0;
let resourceMutationBusy = false;
let sessionApplyInFlight = false;
let unknownOutcomeRefreshTimer = null;
let staticRouteActionState = {};
let accountSessionsRequestId = 0;
let routeDialogContext = null;
let routeDetailsRequestId = 0;
let routeDetailsAbortController = null;

const CHANNEL_FAMILIES = ["ipv4", "ipv6"];
const THEME_STORAGE_KEY = "birdbox-theme";
const systemThemeQuery = window.matchMedia?.("(prefers-color-scheme: dark)") ?? null;
const API_READ_TIMEOUT_MS = 20000;
const API_MUTATION_TIMEOUT_MS = 60000;
const API_DEPLOYMENT_TIMEOUT_MS = 1810000;

function isDeploymentMutation(path, method) {
  if (method === "GET") return false;
  if (/^\/api\/(defines|functions|filters|rpki|statics)(?:\/|$)/.test(path)) return true;
  if (/^\/api\/sessions\/(?:preview|apply)$/.test(path)) return true;
  if (method === "DELETE" && /^\/api\/sessions\//.test(path)) return true;
  if (path === "/api/nodes/test" || (path === "/api/nodes" && method === "POST")) return true;
  if (/^\/api\/nodes\/[A-Za-z_][A-Za-z0-9_]*$/.test(path) && method === "PUT") return true;
  if (/^\/api\/nodes\/[A-Za-z_][A-Za-z0-9_]*$/.test(path) && method === "DELETE" && !path.includes("force=true")) return true;
  return /^\/api\/peers\/[A-Za-z_][A-Za-z0-9_]*$/.test(path) && method === "PUT";
}

function mutationWaitPresentation(path, method) {
  const pathname = path.split(/[?#]/, 1)[0];
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
  else if (/^\/api\/(defines|functions|filters)(?:\/|$)/.test(pathname)) title = method === "DELETE" ? "正在删除策略资源" : "正在应用策略资源变更";
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

function scheduleUnknownOutcomeRefresh() {
  clearTimeout(unknownOutcomeRefreshTimer);
  unknownOutcomeRefreshTimer = window.setTimeout(async () => {
    unknownOutcomeRefreshTimer = null;
    try {
      await loadDashboard(currentNode()?.id, currentPeer()?.id);
      toast("请求结果未知，已刷新库存和节点状态", "success");
    } catch {
      // The original timeout remains visible; a later manual refresh can retry reconciliation.
    }
  }, 0);
}

function storedTheme() {
  try {
    const theme = localStorage.getItem(THEME_STORAGE_KEY);
    return theme === "dark" || theme === "light" ? theme : null;
  } catch {
    return null;
  }
}

function applyTheme(theme, persist = false) {
  const next = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  document.documentElement.style.colorScheme = next;
  if (persist) {
    try { localStorage.setItem(THEME_STORAGE_KEY, next); } catch {}
  }
  const dark = next === "dark";
  $$('[data-theme-toggle]').forEach((button) => {
    const actionLabel = dark ? "切换到白色模式" : "切换到暗色模式";
    button.title = actionLabel;
    button.setAttribute("aria-label", actionLabel);
    button.removeAttribute("aria-pressed");
    const icon = button.querySelector("span");
    if (icon) icon.textContent = dark ? "☀" : "☾";
  });
}

function initializeTheme() {
  applyTheme(storedTheme() ?? (systemThemeQuery?.matches ? "dark" : "light"));
  $$('[data-theme-toggle]').forEach((button) => button.addEventListener("click", () => {
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark", true);
  }));
  const followSystemTheme = (event) => {
    if (!storedTheme()) applyTheme(event.matches ? "dark" : "light");
  };
  if (systemThemeQuery?.addEventListener) systemThemeQuery.addEventListener("change", followSystemTheme);
  else systemThemeQuery?.addListener?.(followSystemTheme);
}

function familyLabel(family) { return family === "ipv4" ? "IPv4" : "IPv6"; }
function directionKey(direction) { return direction === "import" ? "Import" : "Export"; }
function policyPrefix(family, direction) { return `${family}${directionKey(direction)}`; }

function channelEditorMarkup(family, active) {
  const label = familyLabel(family);
  const policyMarkup = (direction) => {
    const key = policyPrefix(family, direction);
    const directionLabel = direction === "import" ? "导入" : "导出";
    return `<section class="policy-block" aria-labelledby="${key}PolicyTitle">
      <div class="policy-heading">
        <div><span>${direction}</span><h3 id="${key}PolicyTitle">${directionLabel}策略</h3></div>
        ${direction === "export" ? `<small id="${key}FormState">可视化配置生效</small>` : ""}
      </div>
      <div class="segmented-control" role="radiogroup" aria-label="${label} ${directionLabel}策略模式">
        <label><input type="radio" name="${key}PolicyMode" value="combined"><span>可视化</span></label>
        <label><input type="radio" name="${key}PolicyMode" value="custom"><span>自定义</span></label>
      </div>
      <div id="${key}CombinedFields" class="policy-mode-fields" hidden>
        <div class="field-label-row"><span>策略步骤</span><span class="policy-step-actions"><button class="compact-command compact-action-button" type="button" title="添加 Local Preference、prepend、Community 等可视化动作" data-add-policy-action>+ 属性动作</button><button class="compact-icon manage-hint" type="button" title="前往资源管理 Tab 管理 Function" aria-label="前往资源管理 Tab 管理 Function" data-resource-target="functions">?</button></span></div>
        <div id="${key}FunctionPicker" class="function-picker"></div>
        <div id="${key}FormFields" class="policy-form-fields single-field">
          <div class="field"><label for="${key}FormAction">可视化策略动作</label>
            <select id="${key}FormAction">${direction === "import"
              ? '<option value="all">导入所有</option><option value="none">不导入</option>'
              : '<option value="none">不导出</option><option value="all">导出所有</option><option value="cidr">导出指定 CIDR Define</option>'}
            </select>
          </div>
        </div>
        ${direction === "export" ? `<div id="${key}CidrFields" class="policy-form-fields">
          <div class="field"><label for="${family}ExportDefineSelect">${label} CIDR Define</label>
            <div class="select-actions prefix-select-actions"><select id="${family}ExportDefineSelect"></select><button class="compact-icon manage-hint" type="button" title="前往资源管理 Tab 管理 Define" aria-label="前往资源管理 Tab 管理 Define" data-resource-target="defines">?</button></div>
          </div>
        </div>` : ""}
      </div>
      <div id="${key}CustomFields" class="policy-mode-fields" hidden>
        <div class="field-label-row"><label for="${key}FilterSelect">完整 Filter</label><button class="compact-icon manage-hint" type="button" title="前往资源管理 Tab 管理 Filter" aria-label="前往资源管理 Tab 管理 Filter" data-resource-target="filters">?</button></div>
        <select id="${key}FilterSelect"></select>
      </div>
    </section>`;
  };
  return `<section id="${family}ChannelPanel" class="afi-channel-panel ${active ? "active" : ""}" data-family="${family}" role="tabpanel" aria-labelledby="${family}ChannelTab" ${active ? "" : "hidden"}>
    <div class="channel-enable-row">
      <div><span>${label}</span><h3>${label} Channel</h3></div>
      <label class="compact-toggle" for="${family}Enabled"><span>启用</span><input id="${family}Enabled" type="checkbox"><i aria-hidden="true"></i></label>
    </div>
    <div id="${family}ChannelContent" class="channel-content">
      ${policyMarkup("import")}
      ${policyMarkup("export")}
      <section class="session-options" aria-labelledby="${family}LimitsTitle">
        <div class="option-heading"><span>${label}</span><h3 id="${family}LimitsTitle">Channel 限制</h3></div>
        <div class="limit-grid">
          <div class="field"><label for="${family}ImportLimit">Import Limit</label><input id="${family}ImportLimit" type="number" min="1" placeholder="关闭"></div>
          <div class="field"><label for="${family}ImportLimitAction">动作</label><select id="${family}ImportLimitAction"><option value="disable">disable</option><option value="restart">restart</option><option value="block">block</option><option value="warn">warn</option></select></div>
          <div class="field"><label for="${family}ExportLimit">Export Limit</label><input id="${family}ExportLimit" type="number" min="1" placeholder="关闭"></div>
          <div class="field"><label for="${family}ExportLimitAction">动作</label><select id="${family}ExportLimitAction"><option value="disable">disable</option><option value="restart">restart</option><option value="block">block</option><option value="warn">warn</option></select></div>
        </div>
      </section>
      <details class="channel-advanced-settings">
        <summary><span>${label} 高级配置</span><small>Address family</small></summary>
        <div class="advanced-content"><div class="option-grid">
          <div class="field"><label for="${family}ChannelTable">Table</label><input id="${family}ChannelTable" pattern="[A-Za-z_][A-Za-z0-9_]*"></div>
          <div class="field"><label for="${family}ChannelPreference">Preference</label><input id="${family}ChannelPreference" type="number" min="0" max="4294967295"></div>
          <div class="field"><label for="${family}RpkiReload">RPKI Reload</label><select id="${family}RpkiReload"><option value="default">默认</option><option value="on">启用</option><option value="off">关闭</option></select></div>
          <div class="field"><label for="${family}ReceiveLimit">Receive Limit</label><input id="${family}ReceiveLimit" type="number" min="1" placeholder="关闭"></div>
          <div class="field"><label for="${family}ReceiveLimitAction">Receive 动作</label><select id="${family}ReceiveLimitAction"><option value="disable">disable</option><option value="restart">restart</option><option value="block">block</option><option value="warn">warn</option></select></div>
          <div class="field"><label for="${family}NextHopKeep">Next Hop Keep</label><select id="${family}NextHopKeep"><option value="default">默认</option><option value="on">全部</option><option value="ibgp">iBGP</option><option value="ebgp">eBGP</option><option value="off">关闭</option></select></div>
          <div class="field"><label for="${family}NextHopSelf">Next Hop Self</label><select id="${family}NextHopSelf"><option value="default">默认</option><option value="on">全部</option><option value="ibgp">iBGP</option><option value="ebgp">eBGP</option><option value="off">关闭</option></select></div>
          <div class="field"><label for="${family}NextHopAddress">Next Hop Address</label><input id="${family}NextHopAddress"></div>
          <div class="field"><label for="${family}NextHopPrefer">Next Hop Prefer</label><select id="${family}NextHopPrefer"><option value="default">自动</option><option value="global">Global</option><option value="local">Link-local</option></select></div>
          ${family === "ipv6" ? `<div class="field"><label for="${family}LinkLocalNextHopFormat">Link-local Next Hop</label><select id="${family}LinkLocalNextHopFormat"><option value="default">默认 Native</option><option value="native">Native</option><option value="single">Single</option><option value="double">Double</option></select></div>` : ""}
          <div class="field"><label for="${family}GatewayMode">Gateway</label><select id="${family}GatewayMode"><option value="default">自动</option><option value="direct">direct</option><option value="recursive">recursive</option></select></div>
          <div class="field"><label for="${family}IgpTable">IGP Table</label><input id="${family}IgpTable" pattern="[A-Za-z_][A-Za-z0-9_]*"></div>
          <div class="field"><label for="${family}AddPaths">Add Paths</label><select id="${family}AddPaths"><option value="off">关闭</option><option value="on">RX + TX</option><option value="rx">RX</option><option value="tx">TX</option></select></div>
          <div class="field"><label for="${family}Aigp">AIGP</label><select id="${family}Aigp"><option value="default">默认</option><option value="on">启用</option><option value="originate">Originate</option><option value="off">关闭</option></select></div>
          <div class="field"><label for="${family}ChannelCost">Cost</label><input id="${family}ChannelCost" type="number" min="1" max="4294967295"></div>
          <div class="field"><label for="${family}ChannelGracefulRestart">Channel GR</label><select id="${family}ChannelGracefulRestart"><option value="default">默认</option><option value="on">启用</option><option value="off">关闭</option></select></div>
          <div class="field"><label for="${family}ChannelLongLivedGracefulRestart">Channel LLGR</label><select id="${family}ChannelLongLivedGracefulRestart"><option value="default">默认</option><option value="on">启用</option><option value="off">关闭</option></select></div>
          <div class="field"><label for="${family}ChannelLongLivedStaleTime">Channel Stale Time</label><input id="${family}ChannelLongLivedStaleTime" type="number" min="0" max="16777215"></div>
          <div class="field"><label for="${family}ChannelMinLongLivedStaleTime">Min Channel Stale</label><input id="${family}ChannelMinLongLivedStaleTime" type="number" min="0" max="16777215"></div>
          <div class="field"><label for="${family}ChannelMaxLongLivedStaleTime">Max Channel Stale</label><input id="${family}ChannelMaxLongLivedStaleTime" type="number" min="0" max="16777215"></div>
          <label class="compact-toggle" for="${family}ImportKeepFiltered"><span>Keep Filtered</span><input id="${family}ImportKeepFiltered" type="checkbox"><i aria-hidden="true"></i></label>
          <label class="compact-toggle" for="${family}MandatoryChannel"><span>Mandatory</span><input id="${family}MandatoryChannel" type="checkbox"><i aria-hidden="true"></i></label>
          <label class="compact-toggle" for="${family}ImportTable"><span>Import Table</span><input id="${family}ImportTable" type="checkbox"><i aria-hidden="true"></i></label>
          <label class="compact-toggle" for="${family}ExportTable"><span>Export Table</span><input id="${family}ExportTable" type="checkbox"><i aria-hidden="true"></i></label>
          <label class="compact-toggle" for="${family}SecondaryRoutes"><span>Secondary</span><input id="${family}SecondaryRoutes" type="checkbox"><i aria-hidden="true"></i></label>
          <label class="compact-toggle" for="${family}ExtendedNextHop"><span>Extended Next Hop</span><input id="${family}ExtendedNextHop" type="checkbox"><i aria-hidden="true"></i></label>
          ${family === "ipv4" ? `<label class="compact-toggle" for="${family}RequireExtendedNextHop"><span>Require Extended Next Hop</span><input id="${family}RequireExtendedNextHop" type="checkbox"><i aria-hidden="true"></i></label>` : ""}
          <label class="compact-toggle" for="${family}RequireAddPaths"><span>Require Add Paths</span><input id="${family}RequireAddPaths" type="checkbox"><i aria-hidden="true"></i></label>
          <div class="field full-width"><label for="${family}RawChannelOptions">${label} Channel Block</label><textarea id="${family}RawChannelOptions" class="compact-code-editor" spellcheck="false" placeholder="debug { routes };"></textarea></div>
        </div></div>
      </details>
    </div>
  </section>`;
}

function renderChannelEditorShells() {
  $("#channelEditors").innerHTML = `<nav class="afi-tabs" role="tablist" aria-label="BGP Address Family">
    ${CHANNEL_FAMILIES.map((family, index) => `<button id="${family}ChannelTab" class="afi-tab ${index === 0 ? "active" : ""}" type="button" role="tab" aria-selected="${index === 0}" aria-controls="${family}ChannelPanel" tabindex="${index === 0 ? 0 : -1}" data-channel-tab="${family}">${familyLabel(family)} <span id="${family}TabState">开启</span></button>`).join("")}
  </nav>${CHANNEL_FAMILIES.map((family, index) => channelEditorMarkup(family, index === 0)).join("")}`;
}

renderChannelEditorShells();

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function value(id) { return $(`#${id}`).value.trim(); }
function optionalNumber(id) { return value(id) === "" ? null : Number(value(id)); }
function checked(id) { return $(`#${id}`).checked; }

async function api(path, options = {}) {
  const { signal: callerSignal, timeoutMs, headers, mutationWait = true, ...fetchOptions } = options;
  const method = String(fetchOptions.method ?? "GET").toUpperCase();
  const mutationWaitToken = method === "GET" || mutationWait === false
    ? null
    : mutationWaitController.begin(mutationWaitPresentation(path, method));
  const controller = new AbortController();
  const timeout = timeoutMs ?? (method === "GET"
    ? API_READ_TIMEOUT_MS
    : isDeploymentMutation(path, method) ? API_DEPLOYMENT_TIMEOUT_MS : API_MUTATION_TIMEOUT_MS);
  let timedOut = false;
  const abortFromCaller = () => controller.abort();
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
      headers: { "content-type": "application/json", ...(headers ?? {}) },
    });
    const body = await response.text();
    let data;
    try {
      data = body ? JSON.parse(body) : {};
    } catch {
      throw new Error(`服务器返回了无效响应 (${response.status})`);
    }
    if (!response.ok) {
      const error = new Error(data.error || `请求失败 (${response.status})`);
      error.data = data;
      error.status = response.status;
      error.code = data.code;
      if (response.status === 401 && data.code === "AUTH_REQUIRED") {
        showAuthentication({ configured: true, authenticated: false, username: "admin" });
      }
      throw error;
    }
    return data;
  } catch (error) {
    if (timedOut) {
      const timeoutError = new Error("请求超时，服务端可能仍在处理；请刷新状态后确认结果");
      timeoutError.code = "REQUEST_TIMEOUT";
      timeoutError.unknownOutcome = method !== "GET";
      if (timeoutError.unknownOutcome && isDeploymentMutation(path, method)) scheduleUnknownOutcomeRefresh();
      throw timeoutError;
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
    callerSignal?.removeEventListener("abort", abortFromCaller);
    mutationWaitController.end(mutationWaitToken);
  }
}

function toast(message, type = "") {
  const item = document.createElement("div");
  item.className = `toast ${type}`;
  item.textContent = message;
  $("#toastRegion").append(item);
  setTimeout(() => item.remove(), 4300);
}

function clearFormValidation(form) {
  form.classList.remove("validation-attempted");
  form.querySelectorAll(".field-invalid").forEach((field) => field.classList.remove("field-invalid"));
  form.querySelectorAll('[aria-invalid="true"]').forEach((field) => field.removeAttribute("aria-invalid"));
}

function markInvalidControls(form) {
  form.querySelectorAll(".field-invalid").forEach((field) => field.classList.remove("field-invalid"));
  form.querySelectorAll('[aria-invalid="true"]').forEach((field) => field.removeAttribute("aria-invalid"));
  const invalidControls = [...form.querySelectorAll(":invalid")];
  for (const control of invalidControls) {
    control.setAttribute("aria-invalid", "true");
    control.closest(".field, .channel-enable-row, .toggle-row")?.classList.add("field-invalid");
  }
  return invalidControls;
}

function revealInvalidControl(control) {
  const channelPanel = control.closest(".afi-channel-panel");
  if (channelPanel?.dataset.family) activateChannelTab(channelPanel.dataset.family);
  for (let details = control.closest("details"); details; details = details.parentElement?.closest("details")) {
    details.open = true;
  }
}

function invalidControlLabel(control) {
  const label = [...(control.labels ?? [])]
    .map((item) => item.textContent.replace(/\s+/g, " ").trim())
    .find(Boolean);
  return label || control.getAttribute("aria-label") || control.name || control.id || "输入项";
}

function validateForm(form) {
  if (form.checkValidity()) {
    clearFormValidation(form);
    return true;
  }
  form.classList.add("validation-attempted");
  const invalidControls = markInvalidControls(form);
  const firstInvalid = invalidControls[0];
  if (!firstInvalid) return false;
  revealInvalidControl(firstInvalid);
  toast(`请检查“${invalidControlLabel(firstInvalid)}”：${firstInvalid.validationMessage}`, "error");
  requestAnimationFrame(() => {
    firstInvalid.scrollIntoView({ behavior: "smooth", block: "center" });
    firstInvalid.focus({ preventScroll: true });
    firstInvalid.reportValidity();
  });
  return false;
}

function refreshControlValidation(control) {
  const form = control.form;
  if (!form?.classList.contains("validation-attempted") || !control.validity) return;
  if (form.checkValidity()) clearFormValidation(form);
  else markInvalidControls(form);
}

function familyErrorFields(message, suffix) {
  if (/IPv6/i.test(message)) return [`ipv6${suffix}`];
  if (/IPv4/i.test(message)) return [`ipv4${suffix}`];
  return [`ipv4${suffix}`, `ipv6${suffix}`];
}

function formErrorField(form, message) {
  const staticRouteMatch = /Static CIDR (.+?) 动作/.exec(message);
  if (staticRouteMatch) {
    const row = $$("#staticRouteActionList [data-static-route-prefix]")
      .find((item) => item.dataset.staticRoutePrefix === staticRouteMatch[1]);
    if (row) return row.querySelector(message.includes("via 地址") ? "[data-static-route-via]" : "[data-static-route-action]");
  }
  const mappings = [
    [/协议名称只能|协议名称与 Birdbox/, ["protocolName"]],
    [/会话本地地址|本地与 Peer 地址|两端地址不能相同|地址族/, ["sessionLocalAddress"]],
    [/会话本地 ASN|两端 ASN/, ["sessionLocalAsn"]],
    [/会话本地端口/, ["sessionLocalPort"]],
    [/IPv4 与 IPv6 Channel/, ["ipv4Enabled", "ipv6Enabled"]],
    [/Static 所属节点|Static 资源.*不存在的节点/, ["staticNodeId"]],
    [/Static 显示名称/, ["staticLabel"]],
    [/Static 协议名称/, ["staticName"]],
    [/Static 地址族/, ["staticFamily"]],
    [/Static.*CIDR Define/, ["staticDefineId"]],
    [/Static CIDR|静态路由动作/, ["staticBulkAction", "staticBulkVia"]],
    [/Static Import/, ["staticImport"]],
    [/Static Export/, ["staticExport"]],
    [/Static 资源至少|Static 指令/, ["staticRaw"]],
    [/导出.*CIDR Define/, familyErrorFields(message, "ExportDefineSelect")],
    [/Hold Time/, ["holdTime"]],
    [/Keepalive/, ["keepaliveTime"]],
    [/Multihop|连接方式/, ["connectionMode"]],
    [/接口|Interface/, ["bgpInterface"]],
    [/TCP MD5.*密码/, ["bgpPassword"]],
    [/TCP-AO/, ["bgpAoKeys"]],
    [/跨地址族邻居|BGP Capabilities/, ["capabilities"]],
    [/节点名称/, ["nodeEditorName"]],
    [/SSH 目标|节点地址/, ["nodeEditorSshHost"]],
    [/SSH 用户/, ["nodeEditorSshUser"]],
    [/SSH 端口/, ["nodeEditorSshPort"]],
    [/Router ID/, ["nodeEditorRouterId"]],
    [/主配置/, ["nodeEditorMainConfigPath"]],
    [/生成配置/, ["nodeEditorGeneratedConfigPath"]],
    [/Socket/, ["nodeEditorSocketPath"]],
    [/Peer.*地址/, ["peerEditorAddress"]],
    [/Peer.*ASN/, ["peerEditorAsn"]],
    [/Peer.*名称/, ["peerEditorName"]],
    [/RPKI 协议名称|本地 ROA 资源名称/, ["rpkiName"]],
    [/RPKI 资源名称/, ["rpkiLabel"]],
    [/ROA Table/, ["rpkiRoa4Table", "rpkiRoa6Table"]],
    [/RPKI 服务器/, ["rpkiRemote"]],
    [/IPv4 ROA 文件/, ["rpkiFile4"]],
    [/IPv6 ROA 文件/, ["rpkiFile6"]],
    [/RPKI TCP-MD5.*密码/, ["rpkiPassword"]],
    [/RPKI SSH/, ["rpkiBirdPrivateKey", "rpkiRemotePublicKey", "rpkiUser"]],
    [/BIRD 全局标识符冲突/, ["staticName", "policyResourceName", "rpkiName", "protocolName"]],
    [/BIRD .*名称|Define 名称|策略名称|声明开始/, ["policyResourceName", "policyActionName"]],
    [/显示名称/, ["policyResourceLabel", "policyActionLabel"]],
    [/CIDR 列表|Define 表达式|策略源码|源码|顶层声明|花括号/, ["policyResourceSource"]],
  ];
  for (const [pattern, ids] of mappings) {
    if (!pattern.test(message)) continue;
    const control = ids.map((id) => $(`#${id}`)).find((item) => item && form.contains(item) && !item.disabled);
    if (control) return control;
  }
  return null;
}

function presentFormError(form, error) {
  const message = error?.message || "表单提交失败";
  const control = formErrorField(form, message);
  if (control) {
    form.classList.add("validation-attempted");
    control.setAttribute("aria-invalid", "true");
    control.closest(".field, .channel-enable-row, .toggle-row")?.classList.add("field-invalid");
    revealInvalidControl(control);
    requestAnimationFrame(() => {
      control.scrollIntoView({ behavior: "smooth", block: "center" });
      control.focus({ preventScroll: true });
    });
  }
  toast(message, "error");
}

function setAuthError(element, message = "") {
  element.textContent = message;
  element.hidden = !message;
}

async function copyText(text) {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // HTTP deployments and browser policies may reject the modern API.
    }
  }
  const textarea = document.createElement("textarea");
  const activeElement = document.activeElement;
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.append(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  const copied = typeof document.execCommand === "function" && document.execCommand("copy");
  textarea.remove();
  activeElement?.focus?.();
  if (!copied) throw new Error("COPY_UNAVAILABLE");
}

function stopAuthMonitor() {
  clearInterval(authMonitorTimer);
  authMonitorTimer = null;
}

function showAuthentication(status) {
  const setup = status.configured === false;
  stopAuthMonitor();
  dashboardRequestId += 1;
  dashboardAbortController?.abort();
  dashboardAbortController = null;
  dashboardLoading = false;
  elements.refresh.classList.remove("loading");
  elements.refresh.removeAttribute("aria-busy");
  cancelPendingPreview();
  setSelectionLoading(false);
  document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close());
  document.body.classList.add("auth-active");
  elements.authView.hidden = false;
  elements.appHeader.hidden = true;
  elements.appMain.hidden = true;
  $("#authForm").dataset.mode = setup ? "setup" : "login";
  $("#authTitle").textContent = setup ? "设置管理密码" : "登录 Birdbox";
  $("#authSubmitButton").textContent = setup ? "设置并进入" : "登录";
  $("#authConfirmationField").hidden = !setup;
  $("#authConfirmation").required = setup;
  $("#authPassword").autocomplete = setup ? "new-password" : "current-password";
  $("#authPassword").value = "";
  $("#authConfirmation").value = "";
  setAuthError($("#authError"));
  setTimeout(() => $("#authPassword").focus(), 0);
}

function startAuthMonitor() {
  stopAuthMonitor();
  authMonitorTimer = setInterval(async () => {
    try {
      const status = await api("/api/auth/status");
      if (!status.authenticated) showAuthentication(status);
    } catch {
      // Normal dashboard requests surface connectivity failures.
    }
  }, 15000);
}

async function showApplication() {
  document.body.classList.remove("auth-active");
  elements.authView.hidden = true;
  elements.appHeader.hidden = false;
  elements.appMain.hidden = false;
  startAuthMonitor();
  await loadDashboard();
}

function formatAccountSessionTime(timestamp) {
  const value = new Date(timestamp);
  if (!Number.isFinite(value.getTime())) return "未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(value);
}

function renderAccountSessions(sessions) {
  const list = $("#accountSessionList");
  $("#activeSessionCount").textContent = `${sessions.length} 个有效会话`;
  $("#revokeOtherSessionsButton").disabled = sessions.length <= 1;
  if (!sessions.length) {
    list.innerHTML = '<p class="account-session-empty">没有有效登录会话</p>';
    return;
  }
  list.innerHTML = sessions.map((session) => {
    const address = session.address || "来源地址未知";
    const client = session.userAgent || "客户端信息未知";
    return `
      <div class="account-session-row">
        <div class="account-session-copy">
          <div class="account-session-title">
            <strong>${escapeHtml(address)}</strong>
            ${session.current ? '<span class="account-session-current">当前会话</span>' : ""}
          </div>
          <span class="account-session-client">${escapeHtml(client)}</span>
          <span class="account-session-time">登录 ${escapeHtml(formatAccountSessionTime(session.createdAt))} · 到期 ${escapeHtml(formatAccountSessionTime(session.expiresAt))}</span>
        </div>
        <button class="text-danger-button" type="button" data-revoke-session="${escapeHtml(session.id)}" data-current-session="${session.current ? "true" : "false"}">${session.current ? "退出此会话" : "注销"}</button>
      </div>`;
  }).join("");
}

async function loadAccountSessions() {
  const requestId = ++accountSessionsRequestId;
  $("#activeSessionCount").textContent = "正在加载";
  $("#revokeOtherSessionsButton").disabled = true;
  $("#accountSessionList").innerHTML = '<p class="account-session-empty">正在加载会话…</p>';
  setAuthError($("#accountSessionsError"));
  try {
    const result = await api("/api/auth/sessions");
    if (requestId !== accountSessionsRequestId || !$("#passwordDialog").open) return;
    renderAccountSessions(result.sessions ?? []);
  } catch (error) {
    if (requestId !== accountSessionsRequestId || !$("#passwordDialog").open) return;
    $("#activeSessionCount").textContent = "加载失败";
    $("#accountSessionList").innerHTML = '<p class="account-session-empty">无法读取有效会话</p>';
    setAuthError($("#accountSessionsError"), error.message);
  }
}

async function initializeAuthentication() {
  try {
    const status = await api("/api/auth/status");
    if (status.authenticated) await showApplication();
    else showAuthentication(status);
  } catch (error) {
    showAuthentication({ configured: true, authenticated: false, username: "admin" });
    setAuthError($("#authError"), error.message);
  }
}

function deploymentSummary(deployment) {
  if (!deployment?.applied) return "配置已保存，尚未同步运行节点";
  const nodeCount = deployment.nodes?.length ?? deployment.nodeIds?.length ?? 0;
  const sessionCount = deployment.sessions?.length ?? 0;
  return `已同步 ${nodeCount} 个节点${sessionCount ? `、${sessionCount} 条现有会话` : ""}`;
}

function setButtonLoading(button, next, label = "处理中") {
  if (!button) return;
  if (next) {
    if (!button.dataset.loadingLabel) {
      button.dataset.loadingLabel = button.textContent;
      button.dataset.loadingDisabled = String(button.disabled);
    }
    button.textContent = label;
    button.disabled = true;
    button.classList.add("is-loading");
    button.setAttribute("aria-busy", "true");
    $("#operationStatus").textContent = label;
    return;
  }
  if (!Object.prototype.hasOwnProperty.call(button.dataset, "loadingLabel")) return;
  if (button.dataset.loadingLabel) button.textContent = button.dataset.loadingLabel;
  delete button.dataset.loadingLabel;
  const wasDisabled = button.dataset.loadingDisabled === "true";
  delete button.dataset.loadingDisabled;
  button.classList.remove("is-loading");
  button.removeAttribute("aria-busy");
  button.disabled = wasDisabled;
  $("#operationStatus").textContent = "";
}

function currentSessionContext() {
  const node = currentNode();
  const peer = currentPeer();
  return node && peer ? { nodeId: node.id, peerId: peer.id } : null;
}

function sameSessionContext(context) {
  const current = currentSessionContext();
  return Boolean(context && current && context.nodeId === current.nodeId && context.peerId === current.peerId);
}

function setSessionPreviewOverlay(next, detail = "") {
  const overlay = elements.sessionPreviewOverlay;
  overlay.hidden = !next;
  if (next) {
    $("#sessionPreviewOverlayTitle").textContent = "正在预检会话配置";
    $("#sessionPreviewOverlayDetail").textContent = detail || "正在等待节点返回候选配置检查结果";
    overlay.setAttribute("aria-busy", "true");
  } else {
    overlay.removeAttribute("aria-busy");
  }
}

function cancelPendingPreview() {
  clearTimeout(autoPreviewTimer);
  autoPreviewTimer = null;
  previewRequestId += 1;
  previewAbortController?.abort();
  previewAbortController = null;
  setSessionPreviewOverlay(false);
  if (previewInFlight) {
    previewInFlight = false;
    setBusy(false);
  }
}

function updateSessionActionState() {
  const sessionUnavailable = !currentPeer();
  const locked = busy || dashboardLoading;
  elements.sessionForm.inert = locked;
  if (locked) elements.sessionForm.setAttribute("aria-busy", "true");
  else elements.sessionForm.removeAttribute("aria-busy");
  elements.preview.disabled = locked || sessionUnavailable;
  elements.apply.disabled = locked || sessionUnavailable;
  elements.removeSession.disabled = locked;
  const session = currentPeer()?.session;
  elements.stop.disabled = locked || !currentNode() || !session || session.enabled === false || currentPeer()?.protocol?.configured === false;
}

function setSelectionLoading(next) {
  const nodesAvailable = (state?.inventory?.nodes?.length ?? 0) > 0;
  const peersAvailable = (state?.peers?.length ?? 0) > 0;
  const locked = next || busy;
  elements.nodeSelect.disabled = locked || !nodesAvailable;
  elements.peerSelect.disabled = locked || !peersAvailable;
  for (const select of [elements.nodeSelect, elements.peerSelect]) {
    select.closest(".select-actions")?.classList.toggle("is-loading", next);
    if (next) select.setAttribute("aria-busy", "true");
    else select.removeAttribute("aria-busy");
  }
  elements.selectionLoadingStatus.hidden = !next;
  updateSessionActionState();
}

function setBusy(next, label = "处理中", activeButton = elements.apply) {
  busy = next;
  const buttons = [elements.preview, elements.apply, elements.removeSession, elements.stop];
  buttons.forEach((button) => {
    if (next && button === activeButton) {
      setButtonLoading(button, true, label);
    } else if (!next) {
      if (button.classList.contains("is-loading")) setButtonLoading(button, false);
    }
  });
  updateSessionActionState();
  setSelectionLoading(dashboardLoading);
}

function birdNameSlug(label) {
  const words = pinyin(String(label ?? "").trim(), { toneType: "none", type: "array", nonZh: "consecutive" });
  return words.join("_")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function usedBirdNames(excluded = []) {
  const excludedSet = new Set(excluded.filter(Boolean));
  const inventory = state?.inventory;
  if (!inventory) return new Set();
  return new Set([
    ...(inventory.defines ?? []).map((resource) => resource.name),
    ...(inventory.functions ?? []).map((resource) => resource.name),
    ...(inventory.filters ?? []).map((resource) => resource.name),
    ...(inventory.rpki ?? []).flatMap((resource) => [
      resource.name,
      ...(resource.sourceType === "file"
        ? [resource.roa4Table ? `${resource.name}_v4` : null, resource.roa6Table ? `${resource.name}_v6` : null]
        : []),
      resource.roa4Table,
      resource.roa6Table,
    ]),
    ...(inventory.staticProtocols ?? []).map((resource) => resource.name),
    ...(inventory.sessions ?? []).map((session) => session.protocolName),
  ].filter((name) => name && !excludedSet.has(name)));
}

function uniqueBirdName(prefix, label, excluded = [], maxLength = 64) {
  const used = usedBirdNames(excluded);
  const slug = birdNameSlug(label) || "resource";
  let index = 1;
  while (true) {
    const suffix = index === 1 ? "" : `_${index}`;
    const room = Math.max(1, maxLength - prefix.length - 1 - suffix.length);
    const candidate = `${prefix}_${slug.slice(0, room)}${suffix}`;
    if (!used.has(candidate)) return candidate;
    index += 1;
  }
}

function defaultProtocolName(peer) {
  return uniqueBirdName("bgp", peer.name);
}

function currentNode() { return state?.node ?? null; }
function currentPeer() { return state?.selectedPeer ?? null; }

function channelUsesCrossFamilyTransport(family) {
  const peerAddress = currentPeer()?.address ?? "";
  if (!peerAddress) return false;
  return (peerAddress.includes(":") ? "ipv6" : "ipv4") !== family;
}
function inventoryNode(nodeId) {
  return state?.inventory?.nodes.find((item) => item.id === nodeId) ?? null;
}

function nodeOptions(selectedNodeId) {
  return state.inventory.nodes
    .map((node) => `<option value="${escapeHtml(node.id)}" ${node.id === selectedNodeId ? "selected" : ""}>${escapeHtml(node.name)}</option>`)
    .join("");
}

function resourceScopeOptions(selectedNodeId) {
  return `<option value="" ${selectedNodeId === null ? "selected" : ""}>所有节点</option>${nodeOptions(selectedNodeId)}`;
}

function selectedPolicyMode(family, direction) {
  const key = policyPrefix(family, direction);
  return $(`input[name="${key}PolicyMode"]:checked`)?.value ?? "combined";
}

function selectedPolicySteps(family, direction) {
  const key = policyPrefix(family, direction);
  return $$(`#${key}FunctionPicker .function-step`).map((row) => {
    if (row.dataset.stepType === "form") return [{ type: "form" }];
    return { type: "function", functionId: row.dataset.functionId, action: row.querySelector("select").value };
  }).flat();
}

function policyPayload(family, direction) {
  const key = policyPrefix(family, direction);
  const mode = selectedPolicyMode(family, direction);
  return {
    mode,
    steps: mode === "combined" ? selectedPolicySteps(family, direction) : [],
    filterId: mode === "custom" ? (value(`${key}FilterSelect`) || null) : null,
    formAction: value(`${key}FormAction`) || (direction === "import" ? "all" : "none"),
  };
}

function channelPayload(family) {
  return {
    enabled: checked(`${family}Enabled`),
    importPolicy: policyPayload(family, "import"),
    exportPolicy: policyPayload(family, "export"),
    exportDefineId: value(`${family}ExportDefineSelect`) || null,
    table: value(`${family}ChannelTable`) || null,
    preference: optionalNumber(`${family}ChannelPreference`),
    importKeepFiltered: checked(`${family}ImportKeepFiltered`),
    rpkiReload: value(`${family}RpkiReload`),
    importLimit: { value: optionalNumber(`${family}ImportLimit`), action: value(`${family}ImportLimitAction`) },
    receiveLimit: { value: optionalNumber(`${family}ReceiveLimit`), action: value(`${family}ReceiveLimitAction`) },
    exportLimit: { value: optionalNumber(`${family}ExportLimit`), action: value(`${family}ExportLimitAction`) },
    mandatory: checked(`${family}MandatoryChannel`),
    nextHopKeep: value(`${family}NextHopKeep`),
    nextHopSelf: value(`${family}NextHopSelf`),
    nextHopAddress: value(`${family}NextHopAddress`) || null,
    nextHopPrefer: value(`${family}NextHopPrefer`),
    linkLocalNextHopFormat: $(`#${family}LinkLocalNextHopFormat`)?.value ?? "default",
    gateway: value(`${family}GatewayMode`),
    igpTable: value(`${family}IgpTable`) || null,
    importTable: checked(`${family}ImportTable`),
    exportTable: checked(`${family}ExportTable`),
    secondary: checked(`${family}SecondaryRoutes`),
    extendedNextHop: checked(`${family}ExtendedNextHop`),
    requireExtendedNextHop: $(`#${family}RequireExtendedNextHop`)?.checked ?? false,
    addPaths: value(`${family}AddPaths`),
    requireAddPaths: checked(`${family}RequireAddPaths`),
    aigp: value(`${family}Aigp`),
    cost: optionalNumber(`${family}ChannelCost`),
    gracefulRestart: value(`${family}ChannelGracefulRestart`),
    longLivedGracefulRestart: value(`${family}ChannelLongLivedGracefulRestart`),
    longLivedStaleTime: optionalNumber(`${family}ChannelLongLivedStaleTime`),
    minLongLivedStaleTime: optionalNumber(`${family}ChannelMinLongLivedStaleTime`),
    maxLongLivedStaleTime: optionalNumber(`${family}ChannelMaxLongLivedStaleTime`),
    raw: $(`#${family}RawChannelOptions`).value,
  };
}

function activateResourceTab(resourceTarget) {
  $$(".resource-tab").forEach((tab) => {
    const active = tab.dataset.resourceTab === resourceTarget;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  $$(".resource-panel").forEach((panel) => { panel.hidden = panel.id !== `resource-${resourceTarget}`; });
  document.querySelector(`[data-resource-tab="${resourceTarget}"]`)?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
}

function activateWorkspace(workspaceId, resourceTarget = null) {
  $$(".workspace-tab").forEach((tab) => {
    const active = tab.dataset.workspace === workspaceId;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  $$(".workspace-panel").forEach((panel) => { panel.hidden = panel.id !== workspaceId; });
  if (resourceTarget) {
    activateResourceTab(resourceTarget);
    requestAnimationFrame(() => {
      const section = $(`#resource-${resourceTarget}`);
      section?.scrollIntoView({ behavior: "smooth", block: "start" });
      section?.classList.add("resource-highlight");
      setTimeout(() => section?.classList.remove("resource-highlight"), 1200);
    });
  }
}

function sessionPayload() {
  return {
    nodeId: currentNode().id,
    peerId: currentPeer().id,
    protocolName: value("protocolName"),
    enabled: checked("sessionEnabled"),
    localAddress: value("sessionLocalAddress") || null,
    localAsn: Number(value("sessionLocalAsn")),
    localPort: Number(value("sessionLocalPort")),
    bgp: {
      connectionMode: value("connectionMode"),
      multihopTtl: optionalNumber("multihopTtl"),
      passive: checked("passive"),
      bfd: value("bfdMode"),
      bfdOptions: $("#bfdOptions").value,
      ttlSecurity: checked("ttlSecurity"),
      description: value("bgpDescription") || null,
      routerId: value("sessionRouterId") || null,
      vrf: value("sessionVrf") || null,
      interface: value("bgpInterface") || null,
      onlink: checked("onlink"),
      authentication: value("bgpAuthentication"),
      password: value("bgpAuthentication") === "md5" ? (value("bgpPassword") || null) : null,
      aoKeys: value("bgpAuthentication") === "ao" ? $("#bgpAoKeys").value : "",
      setkey: value("bgpSetkey"),
      strictBind: checked("strictBind"),
      freeBind: checked("freeBind"),
      checkLink: value("checkLink"),
      rsClient: checked("rsClient"),
      confederation: optionalNumber("confederation"),
      confederationMember: checked("confederationMember"),
      allowLocalPref: checked("allowLocalPref"),
      allowMed: checked("allowMed"),
      allowLocalAs: value("allowLocalAs") || null,
      allowAsSets: value("allowAsSets"),
      enforceFirstAs: checked("enforceFirstAs"),
      routeRefresh: value("routeRefresh"),
      requireRouteRefresh: checked("requireRouteRefresh"),
      enhancedRouteRefresh: value("enhancedRouteRefresh"),
      requireEnhancedRouteRefresh: checked("requireEnhancedRouteRefresh"),
      gracefulRestart: value("gracefulRestart"),
      gracefulRestartTime: optionalNumber("gracefulRestartTime"),
      minGracefulRestartTime: optionalNumber("minGracefulRestartTime"),
      maxGracefulRestartTime: optionalNumber("maxGracefulRestartTime"),
      requireGracefulRestart: checked("requireGracefulRestart"),
      longLivedGracefulRestart: value("longLivedGracefulRestart"),
      longLivedStaleTime: optionalNumber("longLivedStaleTime"),
      minLongLivedStaleTime: optionalNumber("minLongLivedStaleTime"),
      maxLongLivedStaleTime: optionalNumber("maxLongLivedStaleTime"),
      requireLongLivedGracefulRestart: checked("requireLongLivedGracefulRestart"),
      interpretCommunities: value("interpretCommunities"),
      enableAs4: value("enableAs4"),
      requireAs4: checked("requireAs4"),
      extendedMessages: checked("extendedMessages"),
      requireExtendedMessages: checked("requireExtendedMessages"),
      capabilities: value("capabilities"),
      advertiseHostname: checked("advertiseHostname"),
      requireHostname: checked("requireHostname"),
      disableAfterError: checked("disableAfterError"),
      disableAfterCease: value("disableAfterCease"),
      holdTime: optionalNumber("holdTime"),
      minHoldTime: optionalNumber("minHoldTime"),
      startupHoldTime: optionalNumber("startupHoldTime"),
      keepaliveTime: optionalNumber("keepaliveTime"),
      minKeepaliveTime: optionalNumber("minKeepaliveTime"),
      sendHoldTime: optionalNumber("sendHoldTime"),
      connectDelayTime: optionalNumber("connectDelayTime"),
      connectRetryTime: optionalNumber("connectRetryTime"),
      errorWaitMin: optionalNumber("errorWaitMin"),
      errorWaitMax: optionalNumber("errorWaitMax"),
      errorForgetTime: optionalNumber("errorForgetTime"),
      pathMetric: value("pathMetric"),
      medMetric: checked("medMetric"),
      deterministicMed: checked("deterministicMed"),
      igpMetric: value("igpMetric"),
      preferOlder: checked("preferOlder"),
      defaultMed: optionalNumber("defaultMed"),
      defaultLocalPref: optionalNumber("defaultLocalPref"),
      localRole: value("localRole"),
      requireRoles: checked("requireRoles"),
      raw: $("#rawProtocolOptions").value,
    },
    channels: Object.fromEntries(CHANNEL_FAMILIES.map((family) => [family, channelPayload(family)])),
  };
}

function renderSelectors() {
  const nodes = state.inventory.nodes;
  $("#nodeSelect").innerHTML = nodes.length
    ? nodes
    .map((node) => `<option value="${escapeHtml(node.id)}">${escapeHtml(node.name)}</option>`)
    .join("")
    : '<option value="">尚未添加节点</option>';
  $("#nodeSelect").value = state.selection.nodeId ?? "";
  $("#nodeSelect").disabled = nodes.length === 0;

  if (state.peers.length) {
    $("#peerSelect").innerHTML = state.peers
      .map((peer) => `<option value="${escapeHtml(peer.id)}">${escapeHtml(peer.name)} · AS${peer.asn}</option>`)
      .join("");
    $("#peerSelect").value = state.selection.peerId;
    $("#peerSelect").disabled = false;
  } else {
    $("#peerSelect").innerHTML = '<option value="">尚无远端 Peer</option>';
    $("#peerSelect").disabled = true;
  }
  $("#selectionSummary").textContent = !currentNode()
    ? "尚未添加受管节点"
    : currentPeer()
    ? `${currentNode().name} → ${currentPeer().name}`
    : `${currentNode().name} → 未选择`;
}

function protocolPresentation(peer) {
  if (!peer.session) return { label: "未配置", className: "unconfigured" };
  if (peer.session.enabled === false) return { label: "已停用", className: "disabled" };
  if (peer.protocol?.disabled) return { label: "手动停止", className: "disabled" };
  if (!state.runtime.reachable) return { label: "节点不可达", className: "down" };
  if (peer.protocol?.established) return { label: "Established", className: "established" };
  if (peer.protocol?.state) return { label: peer.protocol.state, className: "down" };
  if (peer.protocol?.configured === false) return { label: "未加载", className: "unknown" };
  return { label: "等待运行", className: "unknown" };
}

function globalHealthPresentation() {
  const fallbackActiveSessions = state.peers.filter((peer) => peer.session?.enabled !== false).length;
  const fallbackNormalSessions = state.peers.filter((peer) => peer.session?.enabled !== false && peer.protocol?.established).length;
  const fallbackOnlineNodes = state.runtime?.reachable && state.runtime?.bird2 ? 1 : 0;
  const health = state.health ?? {
    onlineNodes: fallbackOnlineNodes,
    activeSessions: fallbackActiveSessions,
    normalSessions: fallbackNormalSessions,
    status: fallbackOnlineNodes === 0 ? "error" : fallbackActiveSessions > fallbackNormalSessions ? "warning" : "ready",
  };
  return {
    status: health.status,
    text: `${health.onlineNodes}个节点在线，${health.normalSessions}个会话正常`,
  };
}

function renderTopology() {
  const node = currentNode();
  if (!node) {
    $("#nodeName").textContent = "尚未添加受管节点";
    $("#nodeAddress").textContent = "请在资源管理中添加节点";
    $("#nodeRouterId").textContent = "-";
    $("#birdVersion").textContent = "-";
    $("#nodeTransport").textContent = "-";
    $("#nodeReachable").className = "status-pill unknown";
    $("#nodeReachable").textContent = "未配置";
    $("#managedNodeCard").classList.remove("online");
    $(".topology-network").classList.remove("has-peers");
    $("#peerTopology").innerHTML = '<div class="topology-empty">尚无受管节点</div>';
    return;
  }
  const online = state.runtime.reachable && state.runtime.bird2;
  $("#nodeName").textContent = node.name;
  $("#nodeAddress").textContent = `默认会话端口 ${node.listenPort}`;
  $("#nodeRouterId").textContent = node.routerId;
  $("#birdVersion").textContent = state.runtime.version?.replace("BIRD version ", "") || "-";
  $("#nodeTransport").textContent = "SSH";
  $("#nodeReachable").className = `status-pill ${online ? "online" : "offline"}`;
  $("#nodeReachable").textContent = online ? "可管理" : "不可达";
  $("#managedNodeCard").classList.toggle("online", online);
  $(".topology-network").classList.toggle("has-peers", state.peers.length > 0);

  if (!state.peers.length) {
    $("#peerTopology").innerHTML = '<div class="topology-empty">尚无远端 Peer</div>';
  } else {
    $("#peerTopology").innerHTML = state.peers.map((peer) => {
      const presentation = protocolPresentation(peer);
      const selected = peer.id === state.selection.peerId;
      return `<div class="peer-connection ${peer.protocol?.established ? "established" : ""}" role="treeitem">
        <span class="peer-wire"></span>
        <button class="peer-card ${selected ? "selected" : ""}" type="button" data-peer-id="${escapeHtml(peer.id)}">
          <div class="peer-card-head"><span class="node-icon">P</span><span class="status-pill ${presentation.className}">${escapeHtml(presentation.label)}</span></div>
          <h3>${escapeHtml(peer.name)} · AS${peer.asn}</h3>
          <p>${escapeHtml(peer.address)}:${peer.port}</p>
        </button>
      </div>`;
    }).join("");
    $$(".peer-card").forEach((card) => card.addEventListener("click", () => loadDashboard(node.id, card.dataset.peerId)));
  }
}

function populateSessionOptions(session) {
  const bgp = session?.bgp ?? {};
  const values = {
    connectionMode: bgp.connectionMode ?? "direct",
    multihopTtl: bgp.multihopTtl ?? 10,
    bfdMode: bgp.bfd ?? "off",
    holdTime: bgp.holdTime,
    keepaliveTime: bgp.keepaliveTime,
    bgpDescription: bgp.description,
    sessionRouterId: bgp.routerId,
    sessionVrf: bgp.vrf,
    bgpInterface: bgp.interface,
    bgpAuthentication: bgp.authentication ?? (bgp.password ? "md5" : "none"),
    bgpPassword: bgp.password,
    bgpSetkey: bgp.setkey ?? "default",
    checkLink: bgp.checkLink ?? "default",
    localRole: bgp.localRole ?? "",
    allowLocalAs: bgp.allowLocalAs,
    allowAsSets: bgp.allowAsSets ?? "default",
    confederation: bgp.confederation,
    routeRefresh: bgp.routeRefresh ?? "default",
    enhancedRouteRefresh: bgp.enhancedRouteRefresh ?? "default",
    gracefulRestart: bgp.gracefulRestart ?? "default",
    gracefulRestartTime: bgp.gracefulRestartTime,
    minGracefulRestartTime: bgp.minGracefulRestartTime,
    maxGracefulRestartTime: bgp.maxGracefulRestartTime,
    longLivedGracefulRestart: bgp.longLivedGracefulRestart ?? "default",
    longLivedStaleTime: bgp.longLivedStaleTime,
    minLongLivedStaleTime: bgp.minLongLivedStaleTime,
    maxLongLivedStaleTime: bgp.maxLongLivedStaleTime,
    interpretCommunities: bgp.interpretCommunities ?? "default",
    enableAs4: bgp.enableAs4 ?? "default",
    capabilities: bgp.capabilities ?? "default",
    disableAfterCease: bgp.disableAfterCease ?? "default",
    minHoldTime: bgp.minHoldTime,
    startupHoldTime: bgp.startupHoldTime,
    minKeepaliveTime: bgp.minKeepaliveTime,
    sendHoldTime: bgp.sendHoldTime,
    connectDelayTime: bgp.connectDelayTime,
    connectRetryTime: bgp.connectRetryTime,
    errorForgetTime: bgp.errorForgetTime,
    errorWaitMin: bgp.errorWaitMin,
    errorWaitMax: bgp.errorWaitMax,
    pathMetric: bgp.pathMetric ?? "default",
    igpMetric: bgp.igpMetric ?? "default",
    defaultMed: bgp.defaultMed,
    defaultLocalPref: bgp.defaultLocalPref,
  };
  for (const [id, fieldValue] of Object.entries(values)) $(`#${id}`).value = fieldValue ?? "";

  const checks = {
    passive: bgp.passive,
    ttlSecurity: bgp.ttlSecurity,
    strictBind: bgp.strictBind,
    freeBind: bgp.freeBind,
    onlink: bgp.onlink,
    rsClient: bgp.rsClient,
    confederationMember: bgp.confederationMember,
    allowLocalPref: bgp.allowLocalPref,
    allowMed: bgp.allowMed,
    enforceFirstAs: bgp.enforceFirstAs,
    requireRoles: bgp.requireRoles,
    requireRouteRefresh: bgp.requireRouteRefresh,
    requireEnhancedRouteRefresh: bgp.requireEnhancedRouteRefresh,
    requireGracefulRestart: bgp.requireGracefulRestart,
    requireLongLivedGracefulRestart: bgp.requireLongLivedGracefulRestart,
    requireAs4: bgp.requireAs4,
    requireExtendedMessages: bgp.requireExtendedMessages,
    requireHostname: bgp.requireHostname,
    extendedMessages: bgp.extendedMessages,
    advertiseHostname: bgp.advertiseHostname,
    disableAfterError: bgp.disableAfterError,
    medMetric: bgp.medMetric,
    deterministicMed: bgp.deterministicMed,
    preferOlder: bgp.preferOlder,
  };
  for (const [id, fieldValue] of Object.entries(checks)) $(`#${id}`).checked = fieldValue === true;
  $("#rawProtocolOptions").value = bgp.raw ?? "";
  $("#bfdOptions").value = bgp.bfdOptions ?? "";
  $("#bgpAoKeys").value = bgp.aoKeys ?? "";
  syncBfdMode();
  syncAuthenticationMode();
  syncConnectionMode();
  syncCapabilityRequirements();
  syncTimerConstraints();
}

function populateChannelOptions(family, channel) {
  const values = {
    ChannelTable: channel.table,
    ChannelPreference: channel.preference,
    RpkiReload: channel.rpkiReload ?? "default",
    ImportLimit: channel.importLimit?.value,
    ImportLimitAction: channel.importLimit?.action ?? "disable",
    ReceiveLimit: channel.receiveLimit?.value,
    ReceiveLimitAction: channel.receiveLimit?.action ?? "disable",
    ExportLimit: channel.exportLimit?.value,
    ExportLimitAction: channel.exportLimit?.action ?? "disable",
    NextHopKeep: channel.nextHopKeep ?? "default",
    NextHopSelf: channel.nextHopSelf ?? "default",
    NextHopAddress: channel.nextHopAddress,
    NextHopPrefer: channel.nextHopPrefer ?? "default",
    LinkLocalNextHopFormat: channel.linkLocalNextHopFormat ?? "default",
    GatewayMode: channel.gateway ?? "default",
    IgpTable: channel.igpTable,
    AddPaths: channel.addPaths ?? "off",
    Aigp: channel.aigp ?? "default",
    ChannelCost: channel.cost,
    ChannelGracefulRestart: channel.gracefulRestart ?? "default",
    ChannelLongLivedGracefulRestart: channel.longLivedGracefulRestart ?? "default",
    ChannelLongLivedStaleTime: channel.longLivedStaleTime,
    ChannelMinLongLivedStaleTime: channel.minLongLivedStaleTime,
    ChannelMaxLongLivedStaleTime: channel.maxLongLivedStaleTime,
  };
  for (const [suffix, fieldValue] of Object.entries(values)) {
    const field = $(`#${family}${suffix}`);
    if (field) field.value = fieldValue ?? "";
  }
  const checks = {
    ImportKeepFiltered: channel.importKeepFiltered,
    MandatoryChannel: channel.mandatory,
    ImportTable: channel.importTable,
    ExportTable: channel.exportTable,
    SecondaryRoutes: channel.secondary,
    ExtendedNextHop: channel.extendedNextHop,
    RequireExtendedNextHop: channel.requireExtendedNextHop,
    RequireAddPaths: channel.requireAddPaths,
  };
  for (const [suffix, fieldValue] of Object.entries(checks)) {
    const field = $(`#${family}${suffix}`);
    if (field) field.checked = fieldValue === true;
  }
  $(`#${family}RawChannelOptions`).value = channel.raw ?? "";
}

function renderSessionForm() {
  clearFormValidation(elements.sessionForm);
  const peer = currentPeer();
  const hasPeer = Boolean(peer);
  $("#sessionEmpty").hidden = hasPeer;
  elements.sessionForm.hidden = !hasPeer;
  const session = peer?.session;
  const manuallyDisabled = peer?.protocol?.disabled === true;
  elements.stop.textContent = manuallyDisabled ? "启动当前会话" : "停止当前会话";
  elements.stop.className = `protocol-control ${manuallyDisabled ? "start" : "stop"}${elements.stop.classList.contains("is-loading") ? " is-loading" : ""}`;
  elements.stop.setAttribute("aria-label", `${manuallyDisabled ? "启动" : "停止"} ${session?.protocolName ?? "当前 BGP 会话"}`);
  elements.stop.title = manuallyDisabled ? "启动当前选中的 BGP 会话" : "只停止当前选中的 BGP 会话";
  if (!peer) {
    updateSessionActionState();
    return;
  }

  $("#pairRemote").textContent = `${peer.address} · AS${peer.asn}`;
  $("#protocolName").value = peer.session?.protocolName ?? defaultProtocolName(peer);
  $("#sessionEnabled").checked = peer.session?.enabled !== false;
  $("#sessionLocalAddress").value = peer.session?.localAddress ?? "";
  $("#sessionLocalAsn").value = peer.session?.localAsn ?? "";
  $("#sessionLocalPort").value = peer.session?.localPort ?? 179;
  populateSessionOptions(peer.session);
  for (const family of CHANNEL_FAMILIES) {
    const channel = peer.session?.channels?.[family] ?? {
      enabled: true,
      importPolicy: { mode: "form", steps: [], filterId: null, formAction: "all" },
      exportPolicy: { mode: "form", steps: [], filterId: null, formAction: "none" },
      exportDefineId: null,
    };
    const cidrDefines = state.cidrDefines?.[family] ?? [];
    const defineOptions = cidrDefines
      .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)} · ${escapeHtml(item.name)}${item.nodeId === null ? " · 所有节点" : ""}</option>`)
      .join("");
    const defineSelect = $(`#${family}ExportDefineSelect`);
    defineSelect.innerHTML = '<option value="">不导出 CIDR</option>' + defineOptions;
    defineSelect.value = channel.exportDefineId && cidrDefines.some((item) => item.id === channel.exportDefineId)
      ? channel.exportDefineId
      : "";
    $(`#${family}Enabled`).checked = channel.enabled !== false;
    populateChannelOptions(family, channel);
    for (const direction of ["import", "export"]) {
      const key = policyPrefix(family, direction);
      const policy = channel[`${direction}Policy`] ?? { mode: "form", steps: [], filterId: null };
      $(`#${key}FormAction`).value = policy.formAction ?? (direction === "import" ? "all" : (channel.exportDefineId ? "cidr" : "none"));
      const radio = $(`input[name="${key}PolicyMode"][value="${policy.mode === "form" ? "combined" : policy.mode}"]`);
      if (radio) radio.checked = true;
      renderPolicyResourceChoices(family, direction, policy);
    }
    syncChannelAvailability(family);
    syncChannelRequirementControls(family);
  }
  elements.removeSession.hidden = !peer.session;
  updatePairSummary();
  lastPreviewSignature = JSON.stringify(sessionPayload());
  updateSessionActionState();
}

function renderPolicyResourceChoices(family, direction, policy) {
  const key = policyPrefix(family, direction);
  const callableFunctions = (state.functions ?? []).filter((resource) => resource.callable);
  const functionMap = new Map(callableFunctions.map((resource) => [resource.id, resource]));
  const savedSteps = policy.steps ?? (policy.functionIds ?? []).map((functionId) => ({ type: "function", functionId, action: "execute" }));
  const orderedSteps = savedSteps.some((step) => step.type === "form") ? [...savedSteps] : [...savedSteps, { type: "form" }];
  const selectedIds = new Set(orderedSteps.filter((step) => step.type === "function").map((step) => step.functionId));
  const rows = orderedSteps.flatMap((step) => {
    if (step.type === "form") return [{ type: "form", action: policy.formAction ?? (direction === "import" ? "all" : "none") }];
    const resource = functionMap.get(step.functionId);
    return resource ? [{ type: "function", resource, action: step.action ?? "execute" }] : [];
  });
  const availableFunctions = callableFunctions.filter((resource) => !selectedIds.has(resource.id));
  const picker = $(`#${key}FunctionPicker`);
  picker.innerHTML = rows.map((row) => row.type === "form"
    ? `<div class="function-step form-step" data-step-type="form">
        <span class="step-order">-</span>
        <span class="step-lock" aria-hidden="true">F</span>
        <span class="step-name"><strong>系统策略</strong><small>${direction === "import"
          ? (row.action === "all" ? "导入所有" : "不导入")
          : row.action === "all" ? "导出所有" : row.action === "cidr" ? "指定 CIDR" : "不导出"}</small></span>
        <span class="step-action-static">系统策略</span>
        <span class="step-moves"><button type="button" title="上移系统策略" aria-label="上移系统策略" data-step-move="up">↑</button><button type="button" title="下移系统策略" aria-label="下移系统策略" data-step-move="down">↓</button></span>
      </div>`
    : `<div class="function-step" data-step-type="function" data-function-id="${escapeHtml(row.resource.id)}">
        <span class="step-order">-</span>
        <span class="step-lock function" aria-hidden="true">ƒ</span>
        <span class="step-name"><strong>${escapeHtml(row.resource.label ?? row.resource.name)}</strong><small>${escapeHtml(row.resource.name)}() · ${row.resource.nodeId === null ? "所有节点" : "当前节点"}</small></span>
        <select aria-label="${escapeHtml(row.resource.name)} 命中动作">
          <option value="accept" ${row.action === "accept" ? "selected" : ""}>accept</option>
          <option value="reject" ${row.action === "reject" ? "selected" : ""}>reject</option>
          <option value="execute" ${row.action === "execute" ? "selected" : ""}>仅执行</option>
        </select>
        <span class="step-moves"><button type="button" title="上移 ${escapeHtml(row.resource.name)}" aria-label="上移 ${escapeHtml(row.resource.name)}" data-step-move="up">↑</button><button type="button" title="下移 ${escapeHtml(row.resource.name)}" aria-label="下移 ${escapeHtml(row.resource.name)}" data-step-move="down">↓</button><button type="button" title="移除 ${escapeHtml(row.resource.name)}" aria-label="移除 ${escapeHtml(row.resource.name)}" data-remove-function-step>×</button></span>
      </div>`).join("");
  picker.insertAdjacentHTML("beforeend", `<div class="function-step-add">
    <select aria-label="可用 Function" data-add-function-select>
      <option value="">选择可用 Function</option>
      ${availableFunctions.map((resource) => `<option value="${escapeHtml(resource.id)}">${escapeHtml(resource.label ?? resource.name)} · ${escapeHtml(resource.name)}()</option>`).join("")}
    </select>
    <button type="button" title="添加 Function" aria-label="添加 Function" data-add-function-step>+</button>
  </div>`);
  picker.querySelectorAll('[data-step-move]').forEach((button) => button.addEventListener("click", () => {
    moveFunctionStep(family, direction, button.closest(".function-step"), button.dataset.stepMove);
  }));
  picker.querySelector('[data-add-function-step]').addEventListener("click", () => addFunctionStep(family, direction));
  const addActionButton = picker.closest(".policy-mode-fields")?.querySelector('[data-add-policy-action]');
  if (addActionButton) addActionButton.onclick = () => openPolicyActionDialog(family, direction);
  picker.querySelectorAll('[data-remove-function-step]').forEach((button) => button.addEventListener("click", () => {
    removeFunctionStep(family, direction, button.closest(".function-step").dataset.functionId);
  }));
  syncFunctionStepOrder(family, direction);

  const filterSelect = $(`#${key}FilterSelect`);
  filterSelect.innerHTML = '<option value="">选择 Filter</option>' + (state.filters ?? [])
    .map((resource) => `<option value="${escapeHtml(resource.id)}">${escapeHtml(resource.label ?? resource.name)} · ${escapeHtml(resource.name)}${resource.nodeId === null ? " · 所有节点" : ""}</option>`)
    .join("");
  filterSelect.value = policy.filterId ?? "";
}

function syncFunctionStepOrder(family, direction) {
  const key = policyPrefix(family, direction);
  const active = checked(`${family}Enabled`) && selectedPolicyMode(family, direction) === "combined";
  const rows = $$(`#${key}FunctionPicker .function-step`);
  const selectedRows = rows;
  rows.forEach((row) => {
    row.classList.add("selected");
    const action = row.querySelector("select");
    if (action) action.disabled = !active;
    row.querySelector(".step-order").textContent = String(selectedRows.indexOf(row) + 1);
    const moveButtons = [...row.querySelectorAll('[data-step-move]')];
    if (moveButtons.length) {
      const index = selectedRows.indexOf(row);
      moveButtons[0].disabled = !active || index === 0;
      moveButtons[1].disabled = !active || index === selectedRows.length - 1;
    }
    row.querySelector('[data-remove-function-step]')?.toggleAttribute("disabled", !active);
  });
  const addSelect = $(`#${key}FunctionPicker [data-add-function-select]`);
  const addButton = $(`#${key}FunctionPicker [data-add-function-step]`);
  const actionButton = $(`#${key}CombinedFields [data-add-policy-action]`);
  if (actionButton) actionButton.disabled = !active;
  if (addSelect && addButton) {
    addSelect.disabled = !active || addSelect.options.length <= 1;
    addButton.disabled = addSelect.disabled || !addSelect.value;
    addSelect.onchange = () => { addButton.disabled = !active || !addSelect.value; };
  }
}

function moveFunctionStep(family, direction, row, movement) {
  const key = policyPrefix(family, direction);
  const selectedRows = $$(`#${key}FunctionPicker .function-step`);
  const index = selectedRows.indexOf(row);
  const target = selectedRows[index + (movement === "up" ? -1 : 1)];
  if (!target) return;
  if (movement === "up") target.before(row);
  else target.after(row);
  syncFunctionStepOrder(family, direction);
  scheduleAutoPreview();
}

function addFunctionStep(family, direction) {
  const key = policyPrefix(family, direction);
  const functionId = $(`#${key}FunctionPicker [data-add-function-select]`).value;
  if (!functionId) return;
  const steps = selectedPolicySteps(family, direction);
  const formIndex = steps.findIndex((step) => step.type === "form");
  steps.splice(formIndex < 0 ? steps.length : formIndex, 0, { type: "function", functionId, action: "execute" });
  renderPolicyResourceChoices(family, direction, {
    steps,
    filterId: value(`${key}FilterSelect`) || null,
    formAction: value(`${key}FormAction`) || (direction === "import" ? "all" : "none"),
  });
  syncPolicyControls(family, direction);
  scheduleAutoPreview();
}

function removeFunctionStep(family, direction, functionId) {
  const key = policyPrefix(family, direction);
  const steps = selectedPolicySteps(family, direction).filter((step) => step.type !== "function" || step.functionId !== functionId);
  renderPolicyResourceChoices(family, direction, {
    steps,
    filterId: value(`${key}FilterSelect`) || null,
    formAction: value(`${key}FormAction`) || (direction === "import" ? "all" : "none"),
  });
  syncPolicyControls(family, direction);
  scheduleAutoPreview();
}

function defaultPolicyActionName(label) {
  return uniqueBirdName("function", label);
}

function defaultPolicyActionLabel(direction, action) {
  if (action === "local_pref") return "导入 Local Preference";
  if (action === "prepend") return "导出 AS prepend";
  return `${direction === "import" ? "导入" : "导出"} Community`;
}

function syncPolicyActionName() {
  const name = $("#policyActionName");
  if (name.dataset.edited) return;
  name.value = defaultPolicyActionName(value("policyActionLabel"));
}

function syncPolicyActionDialog() {
  const direction = policyActionContext?.direction ?? "import";
  const isImport = direction === "import";
  $("#policyActionDialogTitle").textContent = `添加${isImport ? "导入" : "导出"}动作 Function`;
  const actionSelect = $("#policyActionType");
  const currentAction = actionSelect.value;
  const options = isImport
    ? [["local_pref", "设置 Local Preference"], ["community", "修改 Community"]]
    : [["prepend", "AS prepend"], ["community", "修改 Community"]];
  actionSelect.innerHTML = options.map(([valueOption, label]) => `<option value="${valueOption}">${label}</option>`).join("");
  actionSelect.value = options.some(([valueOption]) => valueOption === currentAction) ? currentAction : options[0][0];
  const action = actionSelect.value;
  const actionLabel = $("#policyActionLabel");
  if (!actionLabel.dataset.edited) actionLabel.value = defaultPolicyActionLabel(direction, action);
  syncPolicyActionName();
  $("#policyActionLocalPrefFields").hidden = action !== "local_pref";
  $("#policyActionLocalPrefValue").required = action === "local_pref";
  $("#policyActionPrependFields").hidden = action !== "prepend";
  $("#policyActionPrependCount").required = action === "prepend";
  $("#policyActionPrependAsn").required = action === "prepend" && value("policyActionPrependAsnMode") === "custom";
  $("#policyActionPrependAsn").disabled = action !== "prepend" || value("policyActionPrependAsnMode") !== "custom";
  $("#policyActionCommunityFields").hidden = action !== "community";
  $("#policyActionCommunityValues").required = action === "community" && value("policyActionCommunityOperation") !== "empty";
  $("#policyActionCommunityKind").disabled = action !== "community" || value("policyActionCommunityOperation") === "empty";
  $("#policyActionCommunityValues").disabled = action !== "community" || value("policyActionCommunityOperation") === "empty";
  $("#policyActionCommunityOperation").disabled = action !== "community";
  const family = policyActionContext?.family;
  const defineSelect = $("#policyActionDefineSelect");
  if (family && state?.inventory?.defines) {
    const type = family === "ipv4" ? "cidr4" : "cidr6";
    const nodeId = currentNode()?.id;
    const defines = state.inventory.defines.filter((item) => item.type === type && item.enabled && (item.nodeId === null || item.nodeId === nodeId));
    const current = defineSelect.value;
    defineSelect.innerHTML = '<option value="">不选择</option>' + defines.map((item) => `<option value="${escapeHtml(item.name)}">${escapeHtml(item.name)}${item.nodeId === null ? " · 所有节点" : ""}</option>`).join("");
    if (defines.some((item) => item.name === current)) defineSelect.value = current;
  }
}

function parsePolicyActionCommunities(source, kind) {
  const values = String(source ?? "").split(/[\n,]+/).map((item) => item.trim()).filter(Boolean);
  if (!values.length) throw new Error("至少填写一个 Community");
  const max = kind === "large" ? 4294967295 : 65535;
  const expectedParts = kind === "large" ? 3 : 2;
  return values.map((valueInput) => {
    const parts = valueInput.split(":").map((part) => Number(part));
    if (parts.length !== expectedParts || parts.some((part) => !Number.isInteger(part) || part < 0 || part > max)) {
      throw new Error(`${kind === "large" ? "Large" : "Standard"} Community 格式不合法: ${valueInput}`);
    }
    return `(${parts.join(", ")})`;
  });
}

function buildPolicyActionSource() {
  const direction = policyActionContext?.direction;
  const isImport = direction === "import";
  const name = value("policyActionName");
  const condition = value("policyActionCondition").replace(/\s+/g, " ");
  if (!name || !condition) throw new Error("Function 名称和筛选表达式不能为空");
  const statements = [];
  const action = value("policyActionType");
  if (isImport && action === "local_pref") {
    const localPref = optionalNumber("policyActionLocalPrefValue");
    if (localPref === null || localPref < 0 || localPref > 4294967295) throw new Error("Local Preference 必须为 0 到 4294967295 的整数");
    statements.push(`bgp_local_pref = ${localPref};`);
  }
  if (!isImport && action === "prepend") {
    const count = optionalNumber("policyActionPrependCount");
    const asn = value("policyActionPrependAsnMode") === "local" ? optionalNumber("sessionLocalAsn") : optionalNumber("policyActionPrependAsn");
    if (asn === null || asn < 1 || asn > 4294967295) throw new Error("prepend ASN 不合法");
    if (count === null || count < 1 || count > 20 || !Number.isInteger(count)) throw new Error("prepend 次数必须为 1 到 20 的整数");
    for (let index = 0; index < count; index += 1) statements.push(`bgp_path.prepend(${asn});`);
  }
  if (action === "community") {
    const kind = value("policyActionCommunityKind");
    const operation = value("policyActionCommunityOperation");
    const attribute = kind === "large" ? "bgp_large_community" : "bgp_community";
    if (operation === "empty") {
      statements.push(`${attribute}.empty;`);
    } else {
      for (const community of parsePolicyActionCommunities($("#policyActionCommunityValues").value, kind)) {
        statements.push(`${attribute}.${operation}(${community});`);
      }
    }
  }
  if (!statements.length) throw new Error("至少选择一个路由属性操作");
  return `function ${name}()\n{\n  if ${condition} then {\n${statements.map((statement) => `    ${statement}`).join("\n")}\n  }\n}`;
}

function openPolicyActionDialog(family, direction) {
  const context = currentSessionContext();
  if (!context) return;
  policyActionContext = { ...context, family, direction, id: ++policyActionContextId };
  $("#policyActionName").value = "";
  $("#policyActionLabel").value = "";
  delete $("#policyActionName").dataset.edited;
  delete $("#policyActionLabel").dataset.edited;
  $("#policyActionCondition").value = "";
  $("#policyActionDefineSelect").value = "";
  $("#policyActionLocalPrefValue").value = "";
  $("#policyActionType").value = direction === "import" ? "local_pref" : "prepend";
  $("#policyActionPrependAsnMode").value = "local";
  $("#policyActionPrependAsn").value = "";
  $("#policyActionPrependCount").value = "1";
  $("#policyActionCommunityOperation").value = "add";
  $("#policyActionCommunityKind").value = "standard";
  $("#policyActionCommunityValues").value = "";
  syncPolicyActionDialog();
  elements.policyActionDialog.showModal();
}

async function savePolicyAction(event) {
  event.preventDefault();
  syncPolicyActionDialog();
  if (!validateForm(event.currentTarget)) return;
  const context = policyActionContext;
  if (!context || !sameSessionContext(context)) return;
  const saveButton = $("#savePolicyActionButton");
  const form = event.currentTarget;
  try {
    const source = buildPolicyActionSource();
    const payload = {
      nodeId: context.nodeId,
      label: value("policyActionLabel"),
      name: value("policyActionName"),
      source,
      enabled: true,
    };
    setButtonLoading(saveButton, true, "正在预检");
    setFormPending(form, true);
    const result = await api("/api/functions", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const canInsert = policyActionContext?.id === context.id && sameSessionContext(context);
    if (canInsert && elements.policyActionDialog.open) {
      elements.policyActionDialog.close();
      policyActionContext = null;
    }

    // A full dashboard reload would overwrite the rest of the unsaved session
    // draft. Fold the mutation snapshot into the current dashboard instead.
    const inventory = result.inventory ?? {
      ...state.inventory,
      functions: [...state.inventory.functions, result.resource],
    };
    state.inventory = inventory;
    if (Array.isArray(result.events)) state.events = result.events;
    const visibleResources = (collection) => (inventory[collection] ?? []).filter((resource) =>
      resource.enabled && (resource.nodeId === null || resource.nodeId === context.nodeId),
    );
    state.defines = visibleResources("defines");
    state.functions = visibleResources("functions");
    state.filters = visibleResources("filters");
    state.rpki = visibleResources("rpki");
    state.cidrDefines = {
      ipv4: state.defines.filter((resource) => resource.type === "cidr4"),
      ipv6: state.defines.filter((resource) => resource.type === "cidr6"),
    };
    renderEvents();
    renderResourceManagement();

    let inserted = false;
    if (canInsert && policyActionContext === null && sameSessionContext(context)) {
      const key = policyPrefix(context.family, context.direction);
      const policy = policyPayload(context.family, context.direction);
      renderPolicyResourceChoices(context.family, context.direction, policy);
      syncPolicyControls(context.family, context.direction);
      const addSelect = $(`#${key}FunctionPicker [data-add-function-select]`);
      if ([...(addSelect?.options ?? [])].some((option) => option.value === result.resource.id)) {
        addSelect.value = result.resource.id;
        addFunctionStep(context.family, context.direction);
        inserted = true;
      }
    }
    toast(inserted
      ? `已生成 Function ${result.resource.name} 并加入${context.direction === "import" ? "导入" : "导出"}策略`
      : `已生成 Function ${result.resource.name}`,
    "success");
  } catch (error) {
    presentFormError(form, error);
  } finally {
    setButtonLoading(saveButton, false);
    setFormPending(form, false);
  }
}

function syncPolicyControls(family, direction) {
  const key = policyPrefix(family, direction);
  const channelEnabled = checked(`${family}Enabled`);
  const mode = selectedPolicyMode(family, direction);
  const combinedFields = $(`#${key}CombinedFields`);
  const customFields = $(`#${key}CustomFields`);
  combinedFields.hidden = mode !== "combined";
  customFields.hidden = mode !== "custom";
  syncFunctionStepOrder(family, direction);
  const filterSelect = $(`#${key}FilterSelect`);
  filterSelect.disabled = !channelEnabled || mode !== "custom";
  filterSelect.required = channelEnabled && mode === "custom";
  if (direction === "import") {
    const paused = !channelEnabled || mode === "custom";
    $(`#${key}FormAction`).disabled = paused;
    $(`#${key}FormFields`).classList.toggle("paused", paused);
  }
  if (direction === "export") {
    const paused = !channelEnabled || mode === "custom";
    $(`#${key}FormAction`).disabled = paused;
    $(`#${key}FormFields`).classList.toggle("paused", paused);
    $(`#${key}FormState`).textContent = paused ? "可视化配置已暂停" : "可视化配置生效";
    syncExportFormAvailability(family);
  }
}

function syncConnectionMode() {
  const multihop = value("connectionMode") === "multihop";
  $("#multihopTtl").disabled = !multihop;
  $("#multihopTtl").required = multihop;
  $("#bgpInterface").disabled = multihop;
  $("#onlink").disabled = multihop;
  $("#checkLink").querySelector('option[value="on"]').disabled = multihop;
  if (multihop) {
    $("#bgpInterface").value = "";
    $("#onlink").checked = false;
    if (value("checkLink") === "on") $("#checkLink").value = "default";
  }
  for (const family of CHANNEL_FAMILIES) syncChannelRequirementControls(family);
}

function syncBfdMode() {
  const custom = value("bfdMode") === "custom";
  $("#bfdOptionsField").hidden = !custom;
  $("#bfdOptions").required = custom;
}

function syncAuthenticationMode() {
  const mode = value("bgpAuthentication");
  const md5 = mode === "md5";
  const ao = mode === "ao";
  $("#bgpPasswordField").hidden = !md5;
  $("#bgpPassword").disabled = !md5;
  $("#bgpPassword").required = md5;
  $("#bgpAoKeysField").hidden = !ao;
  $("#bgpAoKeys").disabled = !ao;
  $("#bgpAoKeys").required = ao;
  $("#bgpSetkey").disabled = !md5;
}

function setRequirementAvailability(id, available) {
  const field = $(`#${id}`);
  field.disabled = !available;
  if (!available) field.checked = false;
}

function syncCapabilityRequirements() {
  const capabilities = value("capabilities") !== "off";
  const routeRefresh = value("routeRefresh") !== "off";
  const enhancedRefresh = routeRefresh && value("enhancedRouteRefresh") !== "off";
  const gracefulRestart = value("gracefulRestart") !== "off";
  const longLivedGracefulRestart = gracefulRestart && value("longLivedGracefulRestart") !== "off";
  setRequirementAvailability("requireRouteRefresh", capabilities && routeRefresh);
  setRequirementAvailability("requireEnhancedRouteRefresh", capabilities && enhancedRefresh);
  setRequirementAvailability("requireGracefulRestart", capabilities && gracefulRestart);
  setRequirementAvailability("requireLongLivedGracefulRestart", capabilities && longLivedGracefulRestart);
  setRequirementAvailability("requireAs4", capabilities && value("enableAs4") !== "off");
  setRequirementAvailability("requireExtendedMessages", capabilities && checked("extendedMessages"));
  setRequirementAvailability("requireHostname", capabilities && checked("advertiseHostname"));
  setRequirementAvailability("requireRoles", capabilities && Boolean(value("localRole")));
  for (const family of CHANNEL_FAMILIES) syncChannelRequirementControls(family);
}

function syncChannelRequirementControls(family) {
  const enabled = checked(`${family}Enabled`);
  const capabilities = value("capabilities") !== "off";
  const multihop = value("connectionMode") === "multihop";
  const gateway = $(`#${family}GatewayMode`);
  const directOption = gateway.querySelector('option[value="direct"]');
  directOption.disabled = multihop;
  if (multihop && gateway.value === "direct") gateway.value = "default";
  const extendedNextHop = $(`#${family}ExtendedNextHop`);
  const automaticExtendedNextHop = enabled && channelUsesCrossFamilyTransport(family);
  const extendedNextHopLabel = extendedNextHop.closest(".compact-toggle");
  if (automaticExtendedNextHop) extendedNextHop.checked = true;
  extendedNextHop.disabled = !enabled || automaticExtendedNextHop;
  extendedNextHopLabel.classList.toggle("automatic", automaticExtendedNextHop);
  extendedNextHopLabel.querySelector("span").textContent = automaticExtendedNextHop
    ? "Extended Next Hop · 自动"
    : "Extended Next Hop";
  extendedNextHopLabel.title = automaticExtendedNextHop
    ? `${currentPeer().address.includes(":") ? "IPv6" : "IPv4"} 邻居承载 ${familyLabel(family)} Channel，已自动启用`
    : "";
  const extendedRequirement = $(`#${family}RequireExtendedNextHop`);
  if (extendedRequirement) {
    extendedRequirement.disabled = !enabled || !capabilities || !checked(`${family}ExtendedNextHop`);
    if (extendedRequirement.disabled) extendedRequirement.checked = false;
  }
  const addPathRequirement = $(`#${family}RequireAddPaths`);
  addPathRequirement.disabled = !enabled || !capabilities || value(`${family}AddPaths`) === "off";
  if (addPathRequirement.disabled) addPathRequirement.checked = false;
  if (checked("disableAfterError") && optionalNumber(`${family}ImportLimit`) !== null && value(`${family}ImportLimitAction`) === "restart") {
    $(`#${family}ImportLimitAction`).value = "disable";
  }
  $(`#${family}ImportLimitAction`).querySelector('option[value="restart"]').disabled = checked("disableAfterError");
  const crossFamilyChannel = CHANNEL_FAMILIES.some((item) =>
    checked(`${item}Enabled`) && channelUsesCrossFamilyTransport(item),
  );
  $("#capabilities").setCustomValidity(crossFamilyChannel && !capabilities
    ? "跨地址族 Channel 需要 BGP Capabilities 协商"
    : "");
}

function syncTimerConstraints() {
  const hold = optionalNumber("holdTime");
  const effectiveHold = hold ?? 240;
  const keepalive = optionalNumber("keepaliveTime");
  const effectiveKeepalive = keepalive ?? Math.floor(effectiveHold / 3);
  $("#holdTime").setCustomValidity(hold !== null && hold !== 0 && hold < 3 ? "Hold Time 必须为 0 或至少 3 秒" : "");
  $("#keepaliveTime").setCustomValidity(keepalive !== null && keepalive > effectiveHold ? "Keepalive 不能大于 Hold Time" : "");
  const minHold = optionalNumber("minHoldTime");
  $("#minHoldTime").setCustomValidity(minHold !== null && minHold > effectiveHold ? "Min Hold 不能大于 Hold Time" : "");
  const minKeepalive = optionalNumber("minKeepaliveTime");
  $("#minKeepaliveTime").setCustomValidity(minKeepalive !== null && minKeepalive > effectiveKeepalive ? "Min Keepalive 不能大于 Keepalive" : "");
}

function syncFormStepPresentation(family, direction) {
  const key = policyPrefix(family, direction);
  const action = value(`${key}FormAction`);
  const label = direction === "import"
    ? (action === "none" ? "不导入" : "导入所有")
    : action === "all" ? "导出所有" : action === "cidr" ? "指定 CIDR" : "不导出";
  $(`#${key}FunctionPicker .form-step small`)?.replaceChildren(label);
}

function syncExportFormAvailability(family) {
  const key = policyPrefix(family, "export");
  const channelEnabled = checked(`${family}Enabled`);
  const cidrMode = value(`${key}FormAction`) === "cidr";
  const customMode = selectedPolicyMode(family, "export") === "custom";
  $(`#${key}CidrFields`).hidden = !cidrMode;
  $(`#${family}ExportDefineSelect`).disabled = !channelEnabled || customMode || !cidrMode;
  $(`#${family}ExportDefineSelect`).required = channelEnabled && cidrMode && !customMode;
}

function syncChannelAvailability(family) {
  const enabled = checked(`${family}Enabled`);
  const content = $(`#${family}ChannelContent`);
  content.classList.toggle("disabled", !enabled);
  content.querySelectorAll("input, select, textarea").forEach((field) => { field.disabled = !enabled; });
  $(`#${family}TabState`).textContent = enabled ? "开启" : "关闭";
  $(`[data-channel-tab="${family}"]`).classList.toggle("disabled", !enabled);
  for (const direction of ["import", "export"]) syncPolicyControls(family, direction);
  syncChannelRequirementControls(family);
  const atLeastOneChannel = CHANNEL_FAMILIES.some((item) => checked(`${item}Enabled`));
  $("#ipv4Enabled").setCustomValidity(atLeastOneChannel ? "" : "请至少启用 IPv4 或 IPv6 Channel");
}

function activateChannelTab(family) {
  $$(".afi-tab").forEach((tab) => {
    const active = tab.dataset.channelTab === family;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  $$(".afi-channel-panel").forEach((panel) => {
    const active = panel.dataset.family === family;
    panel.classList.toggle("active", active);
    panel.hidden = !active;
  });
}

function updatePairSummary() {
  const localAddress = value("sessionLocalAddress") || "自动选择";
  const localAsn = value("sessionLocalAsn");
  $("#pairLocal").textContent = `${localAddress} · ${localAsn ? `AS${localAsn}` : "ASN 未设置"}`;
}

function renderProtocols() {
  if (!state.peers.length) {
    $("#protocolRows").innerHTML = '<tr><td colspan="5" class="empty-cell">尚无远端 Peer</td></tr>';
    return;
  }
  $("#protocolRows").innerHTML = state.peers.map((peer) => {
    const presentation = protocolPresentation(peer);
    const enabledFamilies = CHANNEL_FAMILIES.filter((family) => peer.session?.channels?.[family]?.enabled);
    const routeSummary = enabledFamilies.map((family) => {
      const channel = peer.protocol?.channels?.[family];
      const fallback = enabledFamilies.length === 1 ? peer.protocol : null;
      const imported = channel?.imported ?? fallback?.imported;
      const exported = channel?.exported ?? fallback?.exported;
      return `<span>${familyLabel(family)} ${imported ?? "-"} 入 / ${exported ?? "-"} 出</span>`;
    }).join("");
    const routesAvailable = Boolean(
      peer.session?.enabled !== false && enabledFamilies.length && state.runtime?.reachable && peer.protocol?.configured !== false,
    );
    const stateClass = peer.protocol?.established ? "up" : (peer.session ? "down" : "");
    return `<tr data-peer-id="${escapeHtml(peer.id)}">
      <td>${escapeHtml(peer.name)}</td>
      <td>${escapeHtml(peer.address)}</td>
      <td>${escapeHtml(peer.session?.protocolName ?? "-")}</td>
      <td><span class="table-state ${stateClass}">${escapeHtml(presentation.label)}</span></td>
      <td>${peer.session ? `<button class="route-summary-button" type="button" data-open-routes="${escapeHtml(peer.id)}"${routesAvailable ? "" : " disabled"} aria-label="查看 ${escapeHtml(peer.name)} 的路由明细"><span class="route-summary-copy"><strong>查看路由</strong>${routeSummary || "<span>Channel 未启用</span>"}</span><span aria-hidden="true">›</span></button>` : "-"}</td>
    </tr>`;
  }).join("");
}

function routeRuntimeCount(peer, family, direction) {
  const enabledFamilies = CHANNEL_FAMILIES.filter((item) => peer.session?.channels?.[item]?.enabled);
  const channel = peer.protocol?.channels?.[family];
  const fallback = enabledFamilies.length === 1 ? peer.protocol : null;
  return channel?.[direction === "import" ? "imported" : "exported"]
    ?? fallback?.[direction === "import" ? "imported" : "exported"]
    ?? null;
}

function syncRouteDialogControls() {
  if (!routeDialogContext) return;
  const peer = state.peers.find((item) => item.id === routeDialogContext.peerId);
  $$("[data-route-family]").forEach((button) => {
    const enabled = peer?.session?.channels?.[button.dataset.routeFamily]?.enabled === true;
    const active = button.dataset.routeFamily === routeDialogContext.family;
    button.disabled = !enabled;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  $$("[data-route-direction]").forEach((button) => {
    const active = button.dataset.routeDirection === routeDialogContext.direction;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function renderRouteDetails(result) {
  if (!routeDialogContext) return;
  const peer = state.peers.find((item) => item.id === routeDialogContext.peerId);
  const runtimeCount = routeRuntimeCount(peer, result.family, result.direction);
  $("#routeDialogCount").textContent = runtimeCount === null
    ? `${result.routes.length}${result.truncated ? "+" : ""} 条路由`
    : result.truncated
      ? `${runtimeCount} 条路由 · 当前显示 ${result.routes.length} 条`
      : `${runtimeCount} 条路由`;
  $("#routeDialogTable").textContent = result.table ? `Table ${result.table}` : "-";
  if (!result.routes.length) {
    const label = result.direction === "import" ? "没有已接受的导入路由" : "没有当前导出路由";
    $("#routeDialogBody").innerHTML = `<div class="route-dialog-state">${label}</div>`;
    return;
  }
  const notice = result.truncated
    ? `<div class="route-list-notice">路由数量较多，仅显示前 ${result.limit} 个前缀</div>`
    : "";
  $("#routeDialogBody").innerHTML = `${notice}<ol class="route-list">${result.routes.map((route) => `
    <li class="route-entry"><details>
      <summary><code class="route-entry-prefix">${escapeHtml(route.prefix)}</code><span class="route-entry-summary">${escapeHtml(route.summary)}</span></summary>
      <pre>${escapeHtml(route.details || route.summary)}</pre>
    </details></li>
  `).join("")}</ol>`;
}

async function loadRouteDetails({ force = false } = {}) {
  const context = routeDialogContext;
  if (!context) return;
  const cacheKey = `${context.family}:${context.direction}`;
  if (!force && context.cache.has(cacheKey)) {
    renderRouteDetails(context.cache.get(cacheKey));
    return;
  }
  routeDetailsAbortController?.abort();
  routeDetailsAbortController = new AbortController();
  const requestId = ++routeDetailsRequestId;
  $("#routeDialogCount").textContent = "正在读取";
  $("#routeDialogTable").textContent = "-";
  $("#routeDialogBody").innerHTML = '<div class="route-dialog-state"><div class="route-loading-copy"><i aria-hidden="true"></i><span>正在读取 BIRD 路由</span></div></div>';
  try {
    const result = await api(
      `/api/sessions/${encodeURIComponent(context.sessionId)}/routes?family=${context.family}&direction=${context.direction}`,
      { signal: routeDetailsAbortController.signal, timeoutMs: 30000 },
    );
    if (requestId !== routeDetailsRequestId || routeDialogContext?.id !== context.id) return;
    context.cache.set(cacheKey, result);
    renderRouteDetails(result);
  } catch (error) {
    if (error.name === "AbortError" || requestId !== routeDetailsRequestId || routeDialogContext?.id !== context.id) return;
    $("#routeDialogCount").textContent = "读取失败";
    $("#routeDialogBody").innerHTML = `<div class="route-dialog-state error"><div><p>${escapeHtml(error.message)}</p><button class="secondary-button" type="button" data-retry-routes>重试</button></div></div>`;
  } finally {
    if (requestId === routeDetailsRequestId) routeDetailsAbortController = null;
  }
}

function openRouteDialog(peerId) {
  const peer = state.peers.find((item) => item.id === peerId);
  const families = CHANNEL_FAMILIES.filter((family) => peer?.session?.channels?.[family]?.enabled);
  if (!peer?.session || !families.length) return;
  routeDetailsAbortController?.abort();
  routeDialogContext = {
    id: routeDetailsRequestId + 1,
    peerId: peer.id,
    sessionId: peer.session.id,
    family: families[0],
    direction: "import",
    cache: new Map(),
  };
  $("#routeDialogTitle").textContent = `${peer.name} 路由`;
  $("#routeDialogSubtitle").textContent = `${currentNode()?.name ?? "节点"} · ${peer.session.protocolName} · ${peer.address}`;
  syncRouteDialogControls();
  elements.routeDialog.showModal();
  void loadRouteDetails();
}

function renderEvents() {
  $("#eventCount").textContent = state.events.length;
  if (!state.events.length) {
    $("#eventLog").innerHTML = '<div class="empty-cell">尚无变更日志</div>';
    return;
  }
  $("#eventLog").innerHTML = [...state.events].reverse().map((entry) => {
    const time = new Date(entry.timestamp).toLocaleTimeString("zh-CN", { hour12: false });
    return `<div class="log-row ${escapeHtml(entry.level)}">
      <time>${time}</time><span>${escapeHtml(entry.nodeId ?? "控制器")}</span><strong>${escapeHtml(entry.message)}</strong>
    </div>`;
  }).join("");
}

function renderResourceManagement() {
  const nodes = state.inventory.nodes;
  $("#manageAddPeerButton").disabled = nodes.length === 0;
  $("#manageAddStaticButton").disabled = nodes.length === 0;
  const nodeNames = new Map(nodes.map((node) => [node.id, node.name]));

  $("#managementNodeRows").innerHTML = nodes.map((node) => `
    <tr>
      <td><strong>${escapeHtml(node.name)}</strong><small>${escapeHtml(node.id)}</small></td>
      <td>SSH · ${escapeHtml(node.sshUser ? `${node.sshUser}@${node.sshHost}:${node.sshPort}` : node.sshHost)}</td>
      <td><code>${escapeHtml(node.routerId)}</code></td>
      <td>${node.listenPort}</td>
      <td><button class="row-edit-button" type="button" title="编辑节点" aria-label="编辑节点 ${escapeHtml(node.name)}" data-edit-node="${escapeHtml(node.id)}">✎</button></td>
    </tr>`).join("");

  $("#managementPeerRows").innerHTML = state.inventory.peers.length
    ? state.inventory.peers.map((peer) => `
      <tr>
        <td><strong>${escapeHtml(peer.name)}</strong><small>${escapeHtml(peer.id)}</small></td>
        <td>${escapeHtml(nodeNames.get(peer.nodeId) ?? peer.nodeId)}</td>
        <td><code>${escapeHtml(peer.address)}:${peer.port}</code></td>
        <td>AS${peer.asn}</td>
        <td><button class="row-edit-button" type="button" title="编辑 Peer" aria-label="编辑 Peer ${escapeHtml(peer.name)}" data-edit-peer="${escapeHtml(peer.id)}">✎</button></td>
      </tr>`).join("")
    : '<tr><td colspan="5" class="empty-cell">尚无 eBGP 远端</td></tr>';

  const referenceCount = (collection, resourceId) => state.inventory.sessions.reduce((count, session) => {
    const policies = Object.values(session.channels).flatMap((channel) => [channel.importPolicy, channel.exportPolicy]);
    return count + policies.filter((policy) => collection === "functions"
      ? policy.steps.some((step) => step.type === "function" && step.functionId === resourceId)
      : policy.filterId === resourceId).length;
  }, 0);
  const statusFor = (resource, collection) => resource.enabled
    ? (collection === "functions" && !resource.callable ? "仅源码引用" : "已启用")
    : "已停用";
  const sourceReferences = (source, symbol) => new RegExp(`(^|[^A-Za-z0-9_])${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9_]|$)`).test(String(source ?? ""));
  const defineReferenceCount = (resource) => [...state.inventory.defines, ...state.inventory.functions, ...state.inventory.filters]
    .filter((item) => item.id !== resource.id && sourceReferences(item.value ?? item.source, resource.name)).length +
    state.inventory.sessions.reduce((count, session) => count + Object.values(session.channels).filter((channel) =>
      channel.exportDefineId === resource.id,
    ).length, 0) +
    (state.inventory.staticProtocols ?? []).filter((item) =>
      item.defineId === resource.id || sourceReferences(item.raw, resource.name),
    ).length;

  $("#managementDefineRows").innerHTML = state.inventory.defines.length
    ? state.inventory.defines.map((resource, index) => `<tr>
      <td><strong>${escapeHtml(resource.label)}</strong><small>${escapeHtml(resource.name)} · ${escapeHtml(resource.id)}</small></td>
      <td>${resource.type === "cidr4" ? "IPv4 CIDR" : resource.type === "cidr6" ? "IPv6 CIDR" : "表达式"}</td>
      <td>${resource.nodeId === null ? "所有节点" : escapeHtml(nodeNames.get(resource.nodeId) ?? resource.nodeId)}</td>
      <td>${index + 1}</td>
      <td><code class="entry-summary" title="${escapeHtml(resource.type.startsWith("cidr") ? resource.entries.join(", ") : resource.value)}">${escapeHtml(resource.type.startsWith("cidr") ? resource.entries.join(", ") : resource.value)}</code></td>
      <td><span class="resource-state ${resource.enabled ? "enabled" : "disabled"}">${statusFor(resource, "defines")}</span></td>
      <td>${defineReferenceCount(resource)}</td>
      <td><span class="resource-row-actions">
        <button class="row-edit-button" type="button" title="上移 Define" aria-label="上移 Define ${escapeHtml(resource.name)}" data-move-resource="${escapeHtml(resource.id)}" data-move-collection="defines" data-move-direction="up" ${index === 0 ? "disabled" : ""}>↑</button>
        <button class="row-edit-button" type="button" title="下移 Define" aria-label="下移 Define ${escapeHtml(resource.name)}" data-move-resource="${escapeHtml(resource.id)}" data-move-collection="defines" data-move-direction="down" ${index === state.inventory.defines.length - 1 ? "disabled" : ""}>↓</button>
        <button class="row-edit-button" type="button" title="编辑 Define" aria-label="编辑 Define ${escapeHtml(resource.name)}" data-edit-policy-kind="defines" data-edit-policy-id="${escapeHtml(resource.id)}">✎</button>
      </span></td>
    </tr>`).join("")
    : '<tr><td colspan="8" class="empty-cell">尚无 Define</td></tr>';

  const defineNames = new Map(state.inventory.defines.map((resource) => [resource.id, resource.label ?? resource.name]));
  $("#managementStaticRows").innerHTML = (state.inventory.staticProtocols ?? []).length
    ? state.inventory.staticProtocols.map((resource) => {
        const standardRoute = resource.defineId
          ? `${defineNames.get(resource.defineId) ?? resource.defineId} · ${Object.keys(resource.routeActions ?? {}).length} 条 CIDR`
          : "仅自定义指令";
        return `<tr>
          <td><strong>${escapeHtml(resource.label)}</strong><small>${escapeHtml(resource.name)} · ${escapeHtml(resource.id)}</small></td>
          <td>${escapeHtml(nodeNames.get(resource.nodeId) ?? resource.nodeId)}</td>
          <td>${resource.family === "ipv4" ? "IPv4" : "IPv6"}</td>
          <td><code>${escapeHtml(standardRoute)}${resource.defineId && resource.raw ? " · + 自定义" : ""}</code></td>
          <td><code>${escapeHtml(resource.import)} / ${escapeHtml(resource.export)}</code></td>
          <td><span class="resource-state ${resource.enabled ? "enabled" : "disabled"}">${resource.enabled ? "已启用" : "已停用"}</span></td>
          <td><button class="row-edit-button" type="button" title="编辑 Static" aria-label="编辑 Static ${escapeHtml(resource.name)}" data-edit-static="${escapeHtml(resource.id)}">✎</button></td>
        </tr>`;
      }).join("")
    : '<tr><td colspan="7" class="empty-cell">尚无 Static 资源</td></tr>';

  $("#managementFunctionRows").innerHTML = state.inventory.functions.length
    ? state.inventory.functions.map((resource, index) => `<tr>
      <td><strong>${escapeHtml(resource.label ?? resource.name)}</strong><small>${escapeHtml(resource.name)} · ${escapeHtml(resource.id)}</small></td>
      <td>${resource.nodeId === null ? "所有节点" : escapeHtml(nodeNames.get(resource.nodeId) ?? resource.nodeId)}</td>
      <td>${index + 1}</td>
      <td><span class="resource-state ${resource.enabled ? "enabled" : "disabled"}">${statusFor(resource, "functions")}</span></td>
      <td>${referenceCount("functions", resource.id)}</td>
      <td><span class="resource-row-actions">
        <button class="row-edit-button" type="button" title="上移 Function" aria-label="上移 Function ${escapeHtml(resource.name)}" data-move-resource="${escapeHtml(resource.id)}" data-move-collection="functions" data-move-direction="up" ${index === 0 ? "disabled" : ""}>↑</button>
        <button class="row-edit-button" type="button" title="下移 Function" aria-label="下移 Function ${escapeHtml(resource.name)}" data-move-resource="${escapeHtml(resource.id)}" data-move-collection="functions" data-move-direction="down" ${index === state.inventory.functions.length - 1 ? "disabled" : ""}>↓</button>
        <button class="row-edit-button" type="button" title="编辑 Function" aria-label="编辑 Function ${escapeHtml(resource.name)}" data-edit-policy-kind="functions" data-edit-policy-id="${escapeHtml(resource.id)}">✎</button>
      </span></td>
    </tr>`).join("")
    : '<tr><td colspan="6" class="empty-cell">尚无 Function</td></tr>';

  $("#managementFilterRows").innerHTML = state.inventory.filters.length
    ? state.inventory.filters.map((resource) => `<tr>
      <td><strong>${escapeHtml(resource.label ?? resource.name)}</strong><small>${escapeHtml(resource.name)} · ${escapeHtml(resource.id)}</small></td>
      <td>${resource.nodeId === null ? "所有节点" : escapeHtml(nodeNames.get(resource.nodeId) ?? resource.nodeId)}</td>
      <td><span class="resource-state ${resource.enabled ? "enabled" : "disabled"}">${statusFor(resource, "filters")}</span></td>
      <td>${referenceCount("filters", resource.id)}</td>
      <td><button class="row-edit-button" type="button" title="编辑 Filter" aria-label="编辑 Filter ${escapeHtml(resource.name)}" data-edit-policy-kind="filters" data-edit-policy-id="${escapeHtml(resource.id)}">✎</button></td>
    </tr>`).join("")
    : '<tr><td colspan="5" class="empty-cell">尚无 Filter</td></tr>';

  const rpkiNodeNames = new Map(state.inventory.nodes.map((node) => [node.id, node.name]));
  $("#managementRPKIRows").innerHTML = (state.inventory.rpki ?? []).length
    ? state.inventory.rpki.map((resource) => `<tr>
      <td><strong>${escapeHtml(resource.label)}</strong><small>${escapeHtml(resource.name)} · ${escapeHtml(resource.id)}</small></td>
      <td>${resource.sourceType === "file" ? "本地文件" : `RPKI-RTR · ${escapeHtml(resource.remote)}`}</td>
      <td>${resource.nodeId === null ? "所有节点" : escapeHtml(rpkiNodeNames.get(resource.nodeId) ?? resource.nodeId)}</td>
      <td><code>${escapeHtml([resource.roa4Table, resource.roa6Table].filter(Boolean).join(" / "))}</code></td>
      <td><span class="resource-state ${resource.enabled ? "enabled" : "disabled"}">${resource.enabled ? "已启用" : "已停用"}</span></td>
      <td><button class="row-edit-button" type="button" title="编辑 RPKI" aria-label="编辑 RPKI ${escapeHtml(resource.name)}" data-edit-rpki="${escapeHtml(resource.id)}">✎</button></td>
    </tr>`).join("")
    : '<tr><td colspan="6" class="empty-cell">尚无 RPKI 来源</td></tr>';

  $$('[data-edit-node]').forEach((button) => button.addEventListener("click", () => {
    openNodeDialog(inventoryNode(button.dataset.editNode));
  }));
  $$('[data-edit-peer]').forEach((button) => button.addEventListener("click", () => {
    openPeerDialog(state.inventory.peers.find((item) => item.id === button.dataset.editPeer));
  }));
  $$('[data-edit-policy-id]').forEach((button) => button.addEventListener("click", () => {
    const collection = button.dataset.editPolicyKind;
    openPolicyResourceDialog(collection, state.inventory[collection].find((item) => item.id === button.dataset.editPolicyId));
  }));
  $$('[data-edit-static]').forEach((button) => button.addEventListener("click", () => {
    openStaticDialog((state.inventory.staticProtocols ?? []).find((item) => item.id === button.dataset.editStatic));
  }));
  $$('[data-edit-rpki]').forEach((button) => button.addEventListener("click", () => {
    openRPKIDialog(state.inventory.rpki.find((item) => item.id === button.dataset.editRpki));
  }));
  $$('[data-move-resource]').forEach((button) => button.addEventListener("click", () => {
    movePolicyResource(button.dataset.moveCollection, button.dataset.moveResource, button.dataset.moveDirection, button);
  }));
}

function renderDashboard() {
  renderSelectors();
  renderTopology();
  renderSessionForm();
  renderProtocols();
  renderEvents();
  renderResourceManagement();
  $("#localConfig").textContent = state.config;
  const health = globalHealthPresentation();
  elements.globalState.className = `global-state ${health.status}`;
  elements.globalState.innerHTML = `<i></i>${health.text}`;
  elements.globalState.title = health.text;
  elements.globalState.setAttribute("aria-label", health.text);
  $("#updatedAt").textContent = `更新于 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`;
}

async function loadDashboard(nodeId = null, peerId = null) {
  const requestId = ++dashboardRequestId;
  dashboardAbortController?.abort();
  cancelPendingPreview();
  const controller = new AbortController();
  dashboardAbortController = controller;
  dashboardLoading = true;
  elements.refresh.classList.add("loading");
  elements.refresh.setAttribute("aria-busy", "true");
  setSelectionLoading(true);
  try {
    const params = new URLSearchParams();
    if (nodeId) params.set("nodeId", nodeId);
    if (peerId) params.set("peerId", peerId);
    const dashboard = await api(`/api/dashboard?${params}`, { signal: controller.signal });
    if (requestId !== dashboardRequestId) return;
    state = dashboard;
    renderDashboard();
  } catch (error) {
    if (error.name === "AbortError" || requestId !== dashboardRequestId) return;
    elements.globalState.className = "global-state error";
    elements.globalState.innerHTML = "<i></i>控制器异常";
    elements.globalState.title = "控制器异常";
    elements.globalState.setAttribute("aria-label", "控制器异常");
    toast(error.message, "error");
    // The native select has already moved to the requested value. Restore the
    // last committed selection when its replacement dashboard cannot load.
    if (state && requestId === dashboardRequestId) renderSelectors();
  } finally {
    if (requestId === dashboardRequestId) {
      dashboardAbortController = null;
      dashboardLoading = false;
      elements.refresh.classList.remove("loading");
      elements.refresh.removeAttribute("aria-busy");
      setSelectionLoading(false);
    }
  }
}

async function previewSession({ silent = false, signature = null } = {}) {
  const valid = sessionFormValid(!silent);
  if (!valid) return false;
  const context = currentSessionContext();
  if (!context) return false;
  const requestId = ++previewRequestId;
  previewAbortController?.abort();
  const controller = new AbortController();
  previewAbortController = controller;
  previewInFlight = true;
  setSessionPreviewOverlay(true, silent ? "正在自动检查刚刚修改的会话配置" : "正在等待节点返回候选配置检查结果");
  setBusy(true, "正在预检", elements.preview);
  try {
    const result = await api("/api/sessions/preview", {
      method: "POST",
      body: JSON.stringify(sessionPayload()),
      signal: controller.signal,
      mutationWait: !silent,
    });
    if (requestId !== previewRequestId || !sameSessionContext(context)) return false;
    $("#localConfig").textContent = result.config;
    state.events = result.events;
    renderEvents();
    lastPreviewSignature = signature ?? JSON.stringify(sessionPayload());
    if (!silent) toast("节点候选配置检查通过", "success");
    return true;
  } catch (error) {
    if (error.name === "AbortError" || requestId !== previewRequestId || !sameSessionContext(context)) return false;
    if (error.data?.config) $("#localConfig").textContent = error.data.config;
    if (error.data?.events) { state.events = error.data.events; renderEvents(); }
    presentFormError(elements.sessionForm, error);
    return false;
  } finally {
    if (requestId === previewRequestId) {
      previewAbortController = null;
      previewInFlight = false;
      setSessionPreviewOverlay(false);
      setBusy(false);
    }
  }
}

function sessionFormValid(report = false) {
  const atLeastOneChannel = CHANNEL_FAMILIES.some((family) => checked(`${family}Enabled`));
  $("#ipv4Enabled").setCustomValidity(atLeastOneChannel ? "" : "请至少启用 IPv4 或 IPv6 Channel");
  return report ? validateForm(elements.sessionForm) : elements.sessionForm.checkValidity();
}

function scheduleAutoPreview() {
  clearTimeout(autoPreviewTimer);
  autoPreviewTimer = setTimeout(async () => {
    autoPreviewTimer = null;
    if (busy || dashboardLoading) {
      scheduleAutoPreview();
      return;
    }
    if (!currentPeer() || !elements.sessionForm.checkValidity()) return;
    const signature = JSON.stringify(sessionPayload());
    if (signature === lastPreviewSignature) return;
    await previewSession({ silent: true, signature });
  }, 180);
}

async function applySession() {
  if (sessionApplyInFlight || busy) return;
  sessionApplyInFlight = true;
  cancelPendingPreview();
  const confirmButton = $("#confirmApplyButton");
  setButtonLoading(confirmButton, true, "正在应用");
  setBusy(true, "正在应用会话变更");
  elements.applyDialog.close();
  const nodeId = currentNode().id;
  const peerId = currentPeer().id;
  try {
    const result = await api("/api/sessions/apply", { method: "POST", body: JSON.stringify(sessionPayload()) });
    toast(result.enabled === false
      ? "会话已停用"
      : result.established ? "BGP 会话已建立" : "配置已应用，正在等待远端 Peer", result.enabled === false || result.established ? "success" : "");
    await loadDashboard(nodeId, peerId);
  } catch (error) {
    await loadDashboard(nodeId, peerId);
    presentFormError(elements.sessionForm, error);
  } finally {
    setBusy(false);
    setButtonLoading(confirmButton, false);
    sessionApplyInFlight = false;
  }
}

function toggleSshField() {
  const isSsh = value("nodeEditorTransport") === "ssh";
  $("#sshHostField").hidden = !isSsh;
  $("#nodeEditorSshHost").required = isSsh;
  $("#nodeEditorSshUser").required = isSsh && value("nodeEditorDeploymentMode") === "include";
}

function nodeEditorPayload() {
  return {
    name: value("nodeEditorName"),
    transport: "ssh",
    sshHost: value("nodeEditorSshHost"),
    sshPort: Number(value("nodeEditorSshPort")),
    sshUser: value("nodeEditorSshUser") || null,
    sshIdentity: value("nodeEditorSshIdentity"),
    deploymentMode: value("nodeEditorDeploymentMode"),
    mainConfigPath: value("nodeEditorMainConfigPath"),
    generatedConfigPath: value("nodeEditorGeneratedConfigPath"),
    socketPath: value("nodeEditorSocketPath"),
    routerId: value("nodeEditorRouterId"),
    listenPort: Number(value("nodeEditorPort")),
  };
}

function setNodeOnboardingStatus(message, stateName = "") {
  const status = $("#nodeOnboardingStatus");
  status.textContent = message;
  status.className = stateName;
}

function resetNodeOnboardingVerification() {
  if (value("nodeId")) return;
  delete $("#nodeForm").dataset.verified;
  $("#saveNodeButton").disabled = true;
  setNodeOnboardingStatus("等待连接测试");
}

function openNodeDialog(node = null) {
  $("#nodeDialogTitle").textContent = node ? "编辑受管节点" : "添加受管节点";
  $("#nodeId").value = node?.id ?? "";
  $("#nodeEditorName").value = node?.name ?? "";
  $("#nodeEditorTransport").value = "ssh";
  $("#nodeEditorDeploymentMode").value = node?.deploymentMode ?? "include";
  $("#nodeEditorSshIdentity").value = node?.sshIdentity ?? "managed";
  $("#nodeEditorSshHost").value = node?.sshHost ?? "";
  $("#nodeEditorSshUser").value = node?.sshUser ?? "";
  $("#nodeEditorSshPort").value = node?.sshPort ?? 22;
  $("#nodeEditorRouterId").value = node?.routerId ?? "";
  $("#nodeEditorPort").value = node?.listenPort ?? 179;
  $("#nodeEditorMainConfigPath").value = node?.mainConfigPath ?? "/etc/bird/bird.conf";
  $("#nodeEditorGeneratedConfigPath").value = node?.generatedConfigPath ?? "/var/lib/birdbox/generated.conf";
  $("#nodeEditorSocketPath").value = node?.socketPath ?? "/run/bird/bird.ctl";
  $("#nodeBirdPaths").open = !node || node.deploymentMode === "include";
  $("#nodeOnboardingPanel").hidden = Boolean(node);
  $("#nodeSetupGuide").hidden = true;
  $("#nodeSetupScript").textContent = "";
  $("#nodeIncludeLine").textContent = "";
  if (node) {
    $("#nodeForm").dataset.verified = "true";
    $("#saveNodeButton").disabled = false;
  } else {
    resetNodeOnboardingVerification();
  }
  $("#nodeRetireActions").hidden = !node;
  $("#nodeRetireActions details").open = false;
  [
    "nodeEditorTransport", "nodeEditorDeploymentMode", "nodeEditorSshIdentity",
    "nodeEditorSshHost", "nodeEditorSshUser", "nodeEditorSshPort",
    "nodeEditorMainConfigPath", "nodeEditorGeneratedConfigPath", "nodeEditorSocketPath",
  ].forEach((fieldId) => { $(`#${fieldId}`).disabled = Boolean(node); });
  toggleSshField();
  elements.nodeDialog.showModal();
}

function showNodeCleanupDialog(node, forced) {
  $("#nodeCleanupDialogTitle").textContent = forced ? "节点已强制遗忘" : "节点已安全退役，仍需人工清理";
  $("#nodeCleanupTarget").textContent = [
    `SSH ${node.sshUser ? `${node.sshUser}@` : ""}${node.sshHost}:${node.sshPort}`,
    `主配置 ${node.mainConfigPath}`,
    `生成配置 ${node.generatedConfigPath}`,
    `Socket ${node.socketPath}`,
  ].join(" · ");
  elements.nodeCleanupDialog.showModal();
}

async function saveNode(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!validateForm(form)) return;
  const id = value("nodeId");
  if (!id && form.dataset.verified !== "true") {
    toast("请先完成节点连接测试", "error");
    return;
  }
  const body = nodeEditorPayload();
  const button = $("#saveNodeButton");
  setButtonLoading(button, true, id ? "正在更新节点" : "正在添加节点");
  setFormPending(form, true);
  try {
    const result = await api(id ? `/api/nodes/${id}` : "/api/nodes", { method: id ? "PUT" : "POST", body: JSON.stringify(body) });
    await loadDashboard(result.node.id);
    setButtonLoading(button, false);
    setFormPending(form, false);
    elements.nodeDialog.close();
    toast(id ? `节点已更新，${deploymentSummary(result.deployment)}` : "节点已添加", "success");
  } catch (error) { presentFormError(form, error); }
  finally {
    setButtonLoading(button, false);
    setFormPending(form, false);
  }
}

async function generateNodeSetupScript() {
  if (!validateForm($("#nodeForm"))) return;
  const button = $("#generateNodeSetupButton");
  setButtonLoading(button, true, "正在生成");
  setFormPending($("#nodeForm"), true);
  setNodeOnboardingStatus("正在生成");
  try {
    const result = await api("/api/nodes/setup-script", { method: "POST", body: JSON.stringify(nodeEditorPayload()) });
    $("#nodeSetupScript").textContent = result.script;
    $("#nodeIncludeLine").textContent = result.includeLine;
    $("#nodeSetupGuide").hidden = false;
    setNodeOnboardingStatus("脚本已生成");
  } catch (error) {
    setNodeOnboardingStatus("生成失败", "error");
    presentFormError($("#nodeForm"), error);
  } finally {
    setButtonLoading(button, false);
    setFormPending($("#nodeForm"), false);
  }
}

async function testNodeConnection() {
  if (!validateForm($("#nodeForm"))) return;
  const button = $("#testNodeConnectionButton");
  setButtonLoading(button, true, "正在检查");
  setFormPending($("#nodeForm"), true);
  setNodeOnboardingStatus("正在检查 SSH、Include 与 BIRD");
  try {
    const result = await api("/api/nodes/test", { method: "POST", body: JSON.stringify(nodeEditorPayload()) });
    $("#nodeForm").dataset.verified = "true";
    $("#saveNodeButton").disabled = false;
    setNodeOnboardingStatus(`${result.runtime.version} · 检查通过`, "ready");
    toast("节点接入检查通过", "success");
  } catch (error) {
    delete $("#nodeForm").dataset.verified;
    $("#saveNodeButton").disabled = true;
    setNodeOnboardingStatus("检查失败", "error");
    presentFormError($("#nodeForm"), error);
  } finally {
    setButtonLoading(button, false);
    setFormPending($("#nodeForm"), false);
  }
}

function openPeerDialog(peer = null) {
  const selectedNodeId = peer?.nodeId ?? currentNode()?.id;
  if (!selectedNodeId) {
    toast("请先添加受管节点", "error");
    return;
  }
  if (elements.peerDialog.open) elements.peerDialog.close();
  resetFormPending($("#peerForm"));
  clearFormValidation($("#peerForm"));
  setButtonLoading($("#savePeerButton"), false);
  setButtonLoading($("#deletePeerButton"), false);
  $("#peerDialogTitle").textContent = peer ? "编辑外部 Peer" : "添加外部 Peer";
  $("#peerId").value = peer?.id ?? "";
  $("#peerEditorNodeId").innerHTML = nodeOptions(selectedNodeId);
  $("#peerEditorNodeId").disabled = Boolean(peer);
  $("#peerEditorName").value = peer?.name ?? "";
  $("#peerEditorAddress").value = peer?.address ?? "";
  $("#peerEditorAsn").value = peer?.asn ?? "";
  $("#peerEditorPort").value = peer?.port ?? 179;
  $("#deletePeerButton").hidden = !peer;
  elements.peerDialog.showModal();
}

async function savePeer(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!validateForm(form)) return;
  const id = value("peerId");
  const nodeId = value("peerEditorNodeId");
  const body = {
    name: value("peerEditorName"),
    address: value("peerEditorAddress"),
    asn: Number(value("peerEditorAsn")),
    port: Number(value("peerEditorPort")),
  };
  const button = event.submitter ?? form.querySelector('button[type="submit"]');
  setButtonLoading(button, true, id ? "正在更新 Peer" : "正在添加 Peer");
  setFormPending(form, true);
  try {
    const result = await api(id ? `/api/peers/${id}` : `/api/nodes/${nodeId}/peers`, { method: id ? "PUT" : "POST", body: JSON.stringify(body) });
    await loadDashboard(nodeId, result.peer.id);
    setButtonLoading(button, false);
    setFormPending(form, false);
    elements.peerDialog.close();
    toast(id ? `Peer 已更新，${deploymentSummary(result.deployment)}` : "Peer 已添加", "success");
  } catch (error) { presentFormError(form, error); }
  finally {
    setButtonLoading(button, false);
    setFormPending(form, false);
  }
}

function syncStaticName() {
  if (value("staticId") || $("#staticName").dataset.edited || !value("staticLabel")) return;
  const prefix = value("staticFamily") === "ipv6" ? "birdbox_static6" : "birdbox_static4";
  $("#staticName").value = uniqueBirdName(prefix, value("staticLabel"));
}

function staticExactCidrEntries(resource) {
  return (resource?.entries ?? []).filter((entry) => /^.+\/\d{1,3}$/.test(entry));
}

function collectStaticRouteActions({ visibleOnly = false } = {}) {
  const actions = visibleOnly ? {} : { ...staticRouteActionState };
  $$("#staticRouteActionList [data-static-route-prefix]").forEach((row) => {
    const prefix = row.dataset.staticRoutePrefix;
    const action = row.querySelector("[data-static-route-action]")?.value ?? "";
    const via = row.querySelector("[data-static-route-via]")?.value.trim() ?? "";
    if (prefix && action) actions[prefix] = action === "via" ? `via ${via}` : action;
  });
  return actions;
}

function syncStaticRouteRow(row) {
  const action = row.querySelector("[data-static-route-action]");
  const via = row.querySelector("[data-static-route-via]");
  if (!action || !via) return;
  const viaMode = action.value === "via";
  via.hidden = !viaMode;
  via.required = viaMode;
  via.setCustomValidity(viaMode && !via.value.trim() ? "请输入 via 地址" : "");
  const prefix = row.dataset.staticRoutePrefix;
  if (prefix && action.value) staticRouteActionState[prefix] = action.value === "via" ? `via ${via.value.trim()}` : action.value;
}

function syncStaticBulkAction() {
  const viaMode = value("staticBulkAction") === "via";
  $("#staticBulkVia").placeholder = value("staticFamily") === "ipv6" ? "2001:db8::1" : "198.51.100.1";
  $("#staticBulkViaField").hidden = !viaMode;
  $("#staticBulkVia").required = viaMode;
  $("#staticBulkVia").setCustomValidity(viaMode && !value("staticBulkVia") ? "请输入 via 地址" : "");
}

function renderStaticRouteActions() {
  const defineId = value("staticDefineId");
  const section = $("#staticRouteActionsSection");
  const list = $("#staticRouteActionList");
  if (!defineId) {
    section.hidden = true;
    list.replaceChildren();
    return;
  }
  const define = (state?.inventory?.defines ?? []).find((resource) => resource.id === defineId);
  const entries = staticExactCidrEntries(define);
  section.hidden = false;
  $("#staticRouteActionSummary").textContent = entries.length
    ? `已筛选 ${entries.length} 条完整 CIDR；BIRD 扩展前缀不会生成 Static 路由`
    : "该 Define 没有完整 CIDR 条目，BIRD 扩展前缀不会生成 Static 路由";
  if (!entries.length) {
    list.innerHTML = '<p class="static-route-empty">没有可编辑的完整 CIDR 条目</p>';
    return;
  }
  const fallback = value("staticAction") || "blackhole";
  list.innerHTML = entries.map((prefix) => {
    const configured = staticRouteActionState[prefix] ?? fallback;
    const viaMatch = /^via\s+(.+)$/i.exec(configured);
    const action = viaMatch ? "via" : configured;
    const via = viaMatch ? viaMatch[1] : "";
    return `<div class="static-route-row" role="listitem" data-static-route-prefix="${escapeHtml(prefix)}">
      <code class="static-route-prefix">${escapeHtml(prefix)}</code>
      <select data-static-route-action aria-label="${escapeHtml(prefix)} 的 Static 动作">
        <option value="blackhole" ${action === "blackhole" ? "selected" : ""}>blackhole</option>
        <option value="reject" ${action === "reject" ? "selected" : ""}>reject</option>
        <option value="unreachable" ${action === "unreachable" ? "selected" : ""}>unreachable</option>
        <option value="prohibit" ${action === "prohibit" ? "selected" : ""}>prohibit</option>
        <option value="via" ${action === "via" ? "selected" : ""}>via</option>
      </select>
      <input class="static-route-via" data-static-route-via value="${escapeHtml(via)}" placeholder="via 地址" aria-label="${escapeHtml(prefix)} 的 via 地址"${action === "via" ? "" : " hidden"}>
    </div>`;
  }).join("");
  $$("#staticRouteActionList [data-static-route-prefix]").forEach((row) => syncStaticRouteRow(row));
}

function syncStaticDefines(preferredDefineId = value("staticDefineId")) {
  staticRouteActionState = collectStaticRouteActions();
  const nodeId = value("staticNodeId");
  const type = value("staticFamily") === "ipv6" ? "cidr6" : "cidr4";
  const compatible = (state?.inventory?.defines ?? []).filter((resource) =>
    resource.enabled && resource.type === type && (resource.nodeId === null || resource.nodeId === nodeId),
  );
  $("#staticDefineId").innerHTML = '<option value="">不创建标准路由</option>' + compatible
    .map((resource) => `<option value="${escapeHtml(resource.id)}">${escapeHtml(resource.label)} · ${escapeHtml(resource.name)}${resource.nodeId === null ? " · 所有节点" : ""}</option>`)
    .join("");
  $("#staticDefineId").value = compatible.some((resource) => resource.id === preferredDefineId) ? preferredDefineId : "";
  renderStaticRouteActions();
}

function syncStaticEditor() {
  const hasDefine = Boolean(value("staticDefineId"));
  const action = $("#staticAction");
  if (!hasDefine) action.value = "";
  action.disabled = !hasDefine;
  staticRouteActionState = collectStaticRouteActions();
  syncStaticBulkAction();
  const exactRouteCount = $$("#staticRouteActionList [data-static-route-prefix]").length;
  $("#staticDefineId").setCustomValidity(hasDefine && !exactRouteCount && !value("staticRaw")
    ? "所选 CIDR Define 没有可用于 Static 的完整 CIDR 条目"
    : "");
  $("#staticRaw").setCustomValidity(!hasDefine && !value("staticRaw") ? "请配置标准路由或填写自定义 Static 指令" : "");
}

function openStaticDialog(resource = null) {
  const selectedNodeId = resource?.nodeId ?? currentNode()?.id ?? state.inventory.nodes[0]?.id;
  if (!selectedNodeId) {
    toast("请先添加受管节点", "error");
    return;
  }
  if (elements.staticDialog.open) elements.staticDialog.close();
  resetFormPending($("#staticForm"));
  clearFormValidation($("#staticForm"));
  setButtonLoading($("#saveStaticButton"), false);
  setButtonLoading($("#deleteStaticButton"), false);
  $("#staticDialogTitle").textContent = resource ? "编辑 Static 资源" : "添加 Static 资源";
  $("#staticId").value = resource?.id ?? "";
  $("#staticNodeId").innerHTML = nodeOptions(selectedNodeId);
  $("#staticNodeId").disabled = Boolean(resource);
  $("#staticLabel").value = resource?.label ?? "";
  $("#staticName").value = resource?.name ?? "";
  $("#staticFamily").value = resource?.family ?? "ipv4";
  $("#staticRouteActionList").replaceChildren();
  staticRouteActionState = { ...(resource?.routeActions ?? {}) };
  const defaultRouteAction = resource?.action ?? Object.values(resource?.routeActions ?? {})[0] ?? (resource?.defineId ? "blackhole" : "");
  const defaultViaMatch = /^via\s+(.+)$/i.exec(defaultRouteAction);
  $("#staticAction").value = defaultRouteAction;
  $("#staticBulkAction").value = defaultViaMatch ? "via" : (defaultRouteAction || "blackhole");
  $("#staticBulkVia").value = defaultViaMatch?.[1] ?? "";
  syncStaticDefines(resource?.defineId ?? "");
  $("#staticImport").value = resource?.import ?? "all";
  $("#staticExport").value = resource?.export ?? "none";
  $("#staticRaw").value = resource?.raw ?? "";
  $("#staticEnabled").checked = resource?.enabled !== false;
  $("#deleteStaticButton").hidden = !resource;
  if (resource) $("#staticName").dataset.edited = "true";
  else delete $("#staticName").dataset.edited;
  syncStaticEditor();
  elements.staticDialog.showModal();
  elements.staticDialog.scrollTop = 0;
  $("#staticLabel").focus({ preventScroll: true });
}

async function saveStatic(event) {
  event.preventDefault();
  const form = event.currentTarget;
  syncStaticEditor();
  if (!validateForm(form)) return;
  const id = value("staticId");
  const nodeId = value("staticNodeId");
  const body = {
    nodeId,
    label: value("staticLabel"),
    name: value("staticName"),
    family: value("staticFamily"),
    defineId: value("staticDefineId") || null,
    action: value("staticAction") || null,
    routeActions: value("staticDefineId") ? collectStaticRouteActions({ visibleOnly: true }) : {},
    import: value("staticImport"),
    export: value("staticExport"),
    raw: $("#staticRaw").value,
    enabled: checked("staticEnabled"),
  };
  const button = $("#saveStaticButton");
  setButtonLoading(button, true, "正在预检");
  setFormPending(form, true);
  try {
    const result = await api(id ? `/api/statics/${id}` : "/api/statics", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(body),
    });
    const peerId = currentNode()?.id === nodeId ? currentPeer()?.id : null;
    await loadDashboard(nodeId, peerId);
    activateResourceTab("statics");
    elements.staticDialog.close();
    toast(`Static 已${id ? "更新" : "添加"}，${deploymentSummary(result.deployment)}`, "success");
  } catch (error) {
    presentFormError(form, error);
  } finally {
    setFormPending(form, false);
    setButtonLoading(button, false);
  }
}

function applyStaticBulkAction() {
  if (!value("staticDefineId")) return;
  syncStaticBulkAction();
  const action = value("staticBulkAction");
  const via = value("staticBulkVia");
  if (action === "via" && !$("#staticBulkVia").reportValidity()) return;
  const configuredAction = action === "via" ? `via ${via}` : action;
  $("#staticAction").value = configuredAction;
  $$("#staticRouteActionList [data-static-route-prefix]").forEach((row) => {
    row.querySelector("[data-static-route-action]").value = action;
    row.querySelector("[data-static-route-via]").value = action === "via" ? via : "";
    syncStaticRouteRow(row);
  });
  syncStaticEditor();
}

function syncRPKIFields() {
  const isFile = value("rpkiSourceType") === "file";
  const isSsh = !isFile && value("rpkiTransport") === "ssh";
  $("#rpkiFileFields").hidden = !isFile;
  $("#rpkiFile6Field").hidden = !isFile;
  $("#rpkiServerFields").hidden = isFile;
  $("#rpkiSshFields").hidden = !isSsh;
  $("#rpkiRemote").required = !isFile;
  $("#rpkiAuthentication").disabled = isFile || isSsh;
  $("#rpkiPassword").disabled = isFile || isSsh || value("rpkiAuthentication") !== "md5";
  $("#rpkiPasswordField").hidden = isFile || isSsh;
  ["rpkiRemote", "rpkiPort", "rpkiLocalAddress", "rpkiTransport", "rpkiRefresh", "rpkiRetry", "rpkiExpire", "rpkiMinVersion", "rpkiMaxVersion", "rpkiIgnoreMaxLength", "rpkiKeepRefresh", "rpkiKeepRetry", "rpkiKeepExpire"].forEach((id) => {
    const field = $(`#${id}`);
    if (field) field.disabled = isFile;
  });
  $("#rpkiBirdPrivateKey").disabled = !isSsh;
  $("#rpkiRemotePublicKey").disabled = !isSsh;
  $("#rpkiUser").disabled = !isSsh;
  if (!isSsh) {
    $("#rpkiBirdPrivateKey").value = "";
    $("#rpkiRemotePublicKey").value = "";
    $("#rpkiUser").value = "";
  }
}

function syncRPKINames() {
  if (value("rpkiId") || !value("rpkiLabel")) return;
  const label = value("rpkiLabel");
  if (!$("#rpkiName").dataset.edited) $("#rpkiName").value = uniqueBirdName("rpki", label, [], 60);
  if (!$("#rpkiRoa4Table").dataset.edited) $("#rpkiRoa4Table").value = uniqueBirdName("roa4", label);
  if (!$("#rpkiRoa6Table").dataset.edited) $("#rpkiRoa6Table").value = uniqueBirdName("roa6", label);
}

function openRPKIDialog(resource = null) {
  if (elements.rpkiDialog.open) elements.rpkiDialog.close();
  resetFormPending($("#rpkiForm"));
  clearFormValidation($("#rpkiForm"));
  setButtonLoading($("#deleteRPKIButton"), false);
  $("#rpkiDialogTitle").textContent = resource ? "编辑 RPKI 资源" : "添加 RPKI 资源";
  $("#rpkiId").value = resource?.id ?? "";
  $("#rpkiNodeId").innerHTML = resourceScopeOptions(resource?.nodeId ?? null);
  $("#rpkiLabel").value = resource?.label ?? "";
  $("#rpkiName").value = resource?.name ?? "";
  $("#rpkiSourceType").value = resource?.sourceType ?? "file";
  $("#rpkiRoa4Table").value = resource?.roa4Table ?? "";
  $("#rpkiRoa6Table").value = resource?.roa6Table ?? "";
  $("#rpkiFile4").value = resource?.file4 ?? "";
  $("#rpkiFile6").value = resource?.file6 ?? "";
  $("#rpkiRemote").value = resource?.remote ?? "";
  $("#rpkiPort").value = resource?.port ?? 323;
  $("#rpkiLocalAddress").value = resource?.localAddress ?? "";
  $("#rpkiTransport").value = resource?.transport ?? "tcp";
  $("#rpkiAuthentication").value = resource?.authentication ?? "none";
  $("#rpkiPassword").value = "";
  $("#rpkiPassword").placeholder = resource?.password ? "留空保持不变" : "TCP-MD5 密码";
  $("#rpkiRefresh").value = resource?.refresh ?? "";
  $("#rpkiRetry").value = resource?.retry ?? "";
  $("#rpkiExpire").value = resource?.expire ?? "";
  $("#rpkiMinVersion").value = resource?.minVersion ?? "";
  $("#rpkiMaxVersion").value = resource?.maxVersion ?? "";
  $("#rpkiIgnoreMaxLength").value = resource?.ignoreMaxLength ?? "default";
  $("#rpkiKeepRefresh").checked = resource?.keepRefresh === true;
  $("#rpkiKeepRetry").checked = resource?.keepRetry === true;
  $("#rpkiKeepExpire").checked = resource?.keepExpire === true;
  $("#rpkiBirdPrivateKey").value = resource?.birdPrivateKey ?? "";
  $("#rpkiRemotePublicKey").value = resource?.remotePublicKey ?? "";
  $("#rpkiUser").value = resource?.user ?? "";
  $("#rpkiEnabled").checked = resource?.enabled !== false;
  $("#deleteRPKIButton").hidden = !resource;
  for (const id of ["rpkiName", "rpkiRoa4Table", "rpkiRoa6Table"]) {
    if (resource) $(`#${id}`).dataset.edited = "true";
    else delete $(`#${id}`).dataset.edited;
  }
  syncRPKIFields();
  elements.rpkiDialog.showModal();
}

async function saveRPKI(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!validateForm(form)) return;
  const id = value("rpkiId");
  const sourceType = value("rpkiSourceType");
  const transport = value("rpkiTransport");
  const body = {
    nodeId: value("rpkiNodeId") || null,
    label: value("rpkiLabel"),
    name: value("rpkiName"),
    sourceType,
    roa4Table: value("rpkiRoa4Table") || null,
    roa6Table: value("rpkiRoa6Table") || null,
    enabled: $("#rpkiEnabled").checked,
    ...(sourceType === "file"
      ? { file4: value("rpkiFile4") || null, file6: value("rpkiFile6") || null }
      : {
          remote: value("rpkiRemote"),
          port: Number(value("rpkiPort")),
          localAddress: value("rpkiLocalAddress") || null,
          transport,
          authentication: value("rpkiAuthentication"),
          ...(() => {
            const current = id ? state.inventory.rpki.find((item) => item.id === id) : null;
            if (value("rpkiPassword")) return { password: value("rpkiPassword") };
            if (current?.authentication === "md5" && value("rpkiAuthentication") === "md5") return {};
            return { password: null };
          })(),
          refresh: optionalNumber("rpkiRefresh"),
          retry: optionalNumber("rpkiRetry"),
          expire: optionalNumber("rpkiExpire"),
          minVersion: optionalNumber("rpkiMinVersion"),
          maxVersion: optionalNumber("rpkiMaxVersion"),
          ignoreMaxLength: value("rpkiIgnoreMaxLength"),
          keepRefresh: checked("rpkiKeepRefresh"),
          keepRetry: checked("rpkiKeepRetry"),
          keepExpire: checked("rpkiKeepExpire"),
          birdPrivateKey: value("rpkiBirdPrivateKey") || null,
          remotePublicKey: value("rpkiRemotePublicKey") || null,
          user: value("rpkiUser") || null,
        }),
  };
  const button = event.submitter ?? form.querySelector('button[type="submit"]');
  setButtonLoading(button, true, "正在预检");
  setFormPending(form, true);
  try {
    const result = await api(id ? `/api/rpki/${id}` : "/api/rpki", { method: id ? "PUT" : "POST", body: JSON.stringify(body) });
    await loadDashboard(currentNode()?.id, currentPeer()?.id);
    activateResourceTab("rpki");
    setButtonLoading(button, false);
    setFormPending(form, false);
    elements.rpkiDialog.close();
    toast(`${id ? "RPKI 已更新" : "RPKI 已添加"}，${deploymentSummary(result.deployment)}`, "success");
  } catch (error) { presentFormError(form, error); }
  finally {
    setButtonLoading(button, false);
    setFormPending(form, false);
  }
}

function policyKindLabel(collection) {
  return collection === "functions" ? "Function" : collection === "filters" ? "Filter" : "Define";
}

function defaultPolicySource(collection, name) {
  if (!name) return "";
  return collection === "functions"
    ? `function ${name}()\n{\n  return true;\n}`
    : collection === "filters"
      ? `filter ${name}\n{\n  reject;\n}`
      : "true";
}

function defaultPolicyResourceName(collection, label, type) {
  const prefix = collection === "functions"
    ? "function"
    : collection === "filters"
      ? "filter"
      : type === "cidr4"
        ? "prefix4"
        : type === "cidr6"
          ? "prefix6"
          : "define";
  return uniqueBirdName(prefix, label);
}

function syncPolicyResourceName() {
  if (value("policyResourceId") || $("#policyResourceName").dataset.edited) return;
  const collection = value("policyResourceKind");
  const type = value("policyResourceType") || "cidr4";
  const previousName = value("policyResourceName");
  const generated = defaultPolicyResourceName(collection, value("policyResourceLabel"), type);
  $("#policyResourceName").value = generated;
  if (!$("#policyResourceSource").dataset.edited) {
    $("#policyResourceSource").value = collection === "defines" && type.startsWith("cidr") ? "" : defaultPolicySource(collection, generated);
    updatePolicySourceEditor();
  } else if (previousName && (collection === "functions" || collection === "filters")) {
    const declaration = collection === "functions" ? "function" : "filter";
    const escapedName = previousName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    $("#policyResourceSource").value = $("#policyResourceSource").value.replace(
      new RegExp(`^(\\s*${declaration}\\s+)${escapedName}(?=\\s*[({])`),
      `$1${generated}`,
    );
    updatePolicySourceEditor();
  }
}

function updatePolicySourceEditor() {
  const editor = $("#policyResourceSource");
  const lineCount = Math.max(1, editor.value.split("\n").length);
  $("#policySourceLines").textContent = Array.from({ length: lineCount }, (_, index) => index + 1).join("\n");
  const beforeCursor = editor.value.slice(0, editor.selectionStart);
  const lines = beforeCursor.split("\n");
  $("#policySourcePosition").textContent = `Ln ${lines.length}, Col ${lines.at(-1).length + 1}`;
  $("#policySourceLines").scrollTop = editor.scrollTop;
}

function renderPolicySourceReferences() {
  const nodeId = value("policyResourceNodeId") || null;
  const currentId = value("policyResourceId");
  const collection = value("policyResourceKind");
  const available = availablePolicySourceReferences({ inventory: state?.inventory, collection, currentId, nodeId });
  const query = value("policySourceReferenceSearch").toLocaleLowerCase();
  const nodeNames = new Map((state?.inventory?.nodes ?? []).map((node) => [node.id, node.name]));
  const typeLabel = (resource, kind) => kind === "function"
    ? (resource.callable ? "无参 Function" : "有参 Function")
    : resource.type === "cidr4" ? "IPv4 CIDR" : resource.type === "cidr6" ? "IPv6 CIDR" : "表达式 Define";
  const matches = (resource, kind) => {
    if (!query) return true;
    const terms = query.split(/\s+/).filter(Boolean);
    const label = resource.label ?? resource.name;
    const searchText = [
      label,
      resource.name,
      kind,
      typeLabel(resource, kind),
      resource.nodeId === null ? "所有节点 global" : (nodeNames.get(resource.nodeId) ?? resource.nodeId),
      birdNameSlug(label).replaceAll("_", " "),
    ].join(" ").toLocaleLowerCase();
    return terms.every((term) => searchText.includes(term));
  };
  const groups = [
    { kind: "define", label: "Defines", resources: available.defines },
    { kind: "function", label: "Functions", resources: available.functions },
  ].filter((group) => group.resources.length);
  const total = groups.reduce((count, group) => count + group.resources.length, 0);
  const filteredGroups = groups.map((group) => ({
    ...group,
    resources: group.resources.filter((resource) => matches(resource, group.kind)),
  })).filter((group) => group.resources.length);
  const shown = filteredGroups.reduce((count, group) => count + group.resources.length, 0);
  $("#policySourceReferenceCount").textContent = query ? `${shown} / ${total} 项` : `${total} 项`;
  $("#policySourceReferences").innerHTML = filteredGroups.length
    ? filteredGroups.map((group) => `<section class="code-reference-group" aria-label="可用 ${group.label}">
        <div class="code-reference-group-heading"><span class="code-reference-kind ${group.kind}" aria-hidden="true">${group.kind === "function" ? "ƒ" : "D"}</span><strong>${group.label}</strong><span>${group.resources.length}</span></div>
        <div class="code-reference-list">${group.resources.map((resource) => {
          const insertion = policySourceReferenceInsertion(resource, group.kind);
          const scope = resource.nodeId === null ? "所有节点" : (nodeNames.get(resource.nodeId) ?? "当前节点");
          const signature = group.kind === "function"
            ? (String(resource.source ?? "").match(/^\s*function\s+[A-Za-z_][A-Za-z0-9_]*\s*\(([^)]*)\)/)?.[1]?.trim() ?? "")
            : "";
          const symbol = group.kind === "function" ? `${resource.name}(${signature})` : resource.name;
          return `<button class="code-reference-button" type="button" title="插入 ${escapeHtml(insertion)}" aria-label="插入 ${escapeHtml(insertion)}" data-reference-insert="${escapeHtml(insertion)}">
            <span class="code-reference-copy"><strong>${escapeHtml(resource.label ?? resource.name)}</strong><code>${escapeHtml(symbol)}</code></span>
            <span class="code-reference-meta"><span>${escapeHtml(typeLabel(resource, group.kind))}</span><span>${escapeHtml(scope)}</span></span>
          </button>`;
        }).join("")}</div>
      </section>`).join("")
    : `<span class="code-reference-empty">${total ? "没有匹配的资源" : "当前作用域没有可用资源"}</span>`;
}

function syncPolicyResourceEditor() {
  const collection = value("policyResourceKind");
  const isDefine = collection === "defines";
  const defineType = value("policyResourceType") || "cidr4";
  $("#policyResourceTypeField").hidden = !isDefine;
  $("#policyResourceLabelField").hidden = false;
  $("#policyResourceLabel").required = true;
  $("#policyResourceSourceLabel").textContent = isDefine
    ? (defineType === "cidr4" ? "IPv4 CIDR 条目" : defineType === "cidr6" ? "IPv6 CIDR 条目" : "值 / 表达式")
    : "源码";
  $("#policyResourceSource").placeholder = collection === "functions"
    ? "function allow_route()\n{\n  return true;\n}"
    : collection === "filters"
      ? "filter peer_policy\n{\n  reject;\n}"
      : defineType === "cidr4"
        ? "10.0.0.0/8+\n192.0.2.0/24"
        : defineType === "cidr6"
          ? "2001:db8::/32+\n2001:db8:100::/48"
        : "150";
  $("#policySourceReferencePanel").hidden = isDefine && defineType.startsWith("cidr");
  renderPolicySourceReferences();
  updatePolicySourceEditor();
}

function replacePolicySource(start, end, text, selectionStart, selectionEnd = selectionStart) {
  const editor = $("#policyResourceSource");
  editor.setRangeText(text, start, end, "end");
  editor.setSelectionRange(selectionStart, selectionEnd);
  editor.dispatchEvent(new Event("input", { bubbles: true }));
}

function handlePolicySourceKeydown(event) {
  const editor = event.currentTarget;
  if (event.key === "Tab") {
    event.preventDefault();
    const { selectionStart: start, selectionEnd: end, value: source } = editor;
    const lineStart = source.lastIndexOf("\n", start - 1) + 1;
    if (start === end && !event.shiftKey) {
      replacePolicySource(start, end, "  ", start + 2);
      return;
    }
    const blockEnd = source.indexOf("\n", end);
    const replaceEnd = blockEnd < 0 ? source.length : blockEnd;
    const block = source.slice(lineStart, replaceEnd);
    const lines = block.split("\n");
    const transformed = lines.map((line) => event.shiftKey ? line.replace(/^ {1,2}/, "") : `  ${line}`);
    const firstDelta = transformed[0].length - lines[0].length;
    const totalDelta = transformed.join("\n").length - block.length;
    replacePolicySource(lineStart, replaceEnd, transformed.join("\n"), Math.max(lineStart, start + firstDelta), Math.max(lineStart, end + totalDelta));
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    const { selectionStart: start, selectionEnd: end, value: source } = editor;
    const lineStart = source.lastIndexOf("\n", start - 1) + 1;
    const currentLine = source.slice(lineStart, start);
    const baseIndent = currentLine.match(/^\s*/)?.[0] ?? "";
    const nested = currentLine.trimEnd().endsWith("{");
    const indent = nested ? `${baseIndent}  ` : baseIndent;
    if (nested && source.slice(end).trimStart().startsWith("}")) {
      const insertion = `\n${indent}\n${baseIndent}`;
      replacePolicySource(start, end, insertion, start + 1 + indent.length);
    } else {
      const insertion = `\n${indent}`;
      replacePolicySource(start, end, insertion, start + insertion.length);
    }
  }
}

function openPolicyResourceDialog(collection, resource = null) {
  resetFormPending($("#policyResourceForm"));
  setButtonLoading($("#savePolicyResourceButton"), false);
  setButtonLoading($("#deletePolicyResourceButton"), false);
  const kind = policyKindLabel(collection);
  $("#policyResourceDialogTitle").textContent = `${resource ? "编辑" : "添加"} ${kind}`;
  $("#policyResourceIcon").textContent = collection === "functions" ? "ƒ" : collection === "filters" ? "F" : "D";
  $("#policyResourceId").value = resource?.id ?? "";
  $("#policyResourceKind").value = collection;
  $("#policySourceReferenceSearch").value = "";
  $("#policyResourceNodeId").innerHTML = resourceScopeOptions(resource ? resource.nodeId : null);
  $("#policyResourceType").value = resource?.type ?? "cidr4";
  $("#policyResourceLabel").value = resource?.label ?? resource?.name ?? "";
  $("#policyResourceName").value = resource?.name ?? "";
  $("#policyResourceSource").value = resource?.type?.startsWith("cidr")
    ? resource.entries.join("\n")
    : resource?.source ?? resource?.value ?? "";
  $("#policyResourceEnabled").checked = resource?.enabled ?? true;
  if (resource) {
    $("#policyResourceSource").dataset.edited = "true";
    $("#policyResourceName").dataset.edited = "true";
  } else {
    delete $("#policyResourceSource").dataset.edited;
    delete $("#policyResourceName").dataset.edited;
  }
  $("#deletePolicyResourceButton").hidden = !resource;
  syncPolicyResourceEditor();
  elements.policyResourceDialog.showModal();
}

async function movePolicyResource(collection, resourceId, direction, button) {
  if (resourceMutationBusy) return;
  resourceMutationBusy = true;
  const controls = $$('[data-move-resource]');
  const disabledStates = new Map(controls.map((control) => [control, control.disabled]));
  setButtonLoading(button, true, "正在调整");
  controls.forEach((control) => {
    if (control !== button) control.disabled = true;
  });
  try {
    await api(`/api/${collection}/${resourceId}/move`, { method: "POST", body: JSON.stringify({ direction }) });
    await loadDashboard(currentNode()?.id, currentPeer()?.id);
    activateResourceTab(collection);
  } catch (error) { toast(error.message, "error"); }
  finally {
    resourceMutationBusy = false;
    setButtonLoading(button, false);
    controls.forEach((control) => {
      if (control.isConnected) control.disabled = disabledStates.get(control);
    });
  }
}

async function savePolicyResource(event) {
  event.preventDefault();
  if (!validateForm(event.currentTarget)) return;
  const form = event.currentTarget;
  const id = value("policyResourceId");
  const collection = value("policyResourceKind");
  const kind = policyKindLabel(collection);
  const body = {
    nodeId: value("policyResourceNodeId") || null,
    label: value("policyResourceLabel"),
    name: value("policyResourceName"),
    enabled: $("#policyResourceEnabled").checked,
    ...(collection === "defines"
      ? {
          type: value("policyResourceType"),
          ...(value("policyResourceType").startsWith("cidr")
            ? { entries: $("#policyResourceSource").value }
            : { value: $("#policyResourceSource").value }),
        }
      : { source: $("#policyResourceSource").value }),
  };
  const saveButton = $("#savePolicyResourceButton");
  setButtonLoading(saveButton, true, "正在预检");
  setFormPending(form, true);
  try {
    const result = await api(id ? `/api/${collection}/${id}` : `/api/${collection}`, {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(body),
    });
    await loadDashboard(body.nodeId ?? currentNode()?.id, currentPeer()?.id);
    activateResourceTab(collection);
    elements.policyResourceDialog.close();
    toast(`${kind} 已${id ? "更新" : "添加"}，${deploymentSummary(result.deployment)}`, "success");
  } catch (error) {
    presentFormError(form, error);
  } finally {
    setFormPending(form, false);
    setButtonLoading(saveButton, false);
  }
}

$("#authForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!validateForm(form)) return;
  const setup = form.dataset.mode === "setup";
  const button = $("#authSubmitButton");
  setButtonLoading(button, true, setup ? "正在设置" : "正在登录");
  setFormPending(form, true);
  setAuthError($("#authError"));
  try {
    await api(setup ? "/api/auth/setup" : "/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        password: $("#authPassword").value,
        confirmation: setup ? $("#authConfirmation").value : undefined,
      }),
    });
    await showApplication();
  } catch (error) {
    setAuthError($("#authError"), error.message);
  } finally {
    setButtonLoading(button, false);
    setFormPending(form, false);
  }
});

$("#accountButton").addEventListener("click", () => {
  $("#passwordForm").reset();
  setAuthError($("#passwordError"));
  setAuthError($("#accountSessionsError"));
  $("#passwordDialog").showModal();
  void loadAccountSessions();
  $("#currentPassword").focus();
});

$("#accountSessionList").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-revoke-session]");
  if (!button) return;
  const current = button.dataset.currentSession === "true";
  const message = current ? "退出当前登录会话？" : "注销这个登录会话？对应设备将需要重新登录。";
  if (!window.confirm(message)) return;
  setButtonLoading(button, true, current ? "正在退出" : "正在注销");
  try {
    const result = await api(`/api/auth/sessions/${button.dataset.revokeSession}`, { method: "DELETE" });
    if (result.current) {
      state = null;
      showAuthentication({ configured: true, authenticated: false, username: "admin" });
      return;
    }
    await loadAccountSessions();
    toast("登录会话已注销", "success");
  } catch (error) {
    setAuthError($("#accountSessionsError"), error.message);
  } finally {
    setButtonLoading(button, false);
  }
});

$("#revokeOtherSessionsButton").addEventListener("click", async (event) => {
  if (!window.confirm("注销当前会话之外的全部登录会话？")) return;
  const button = event.currentTarget;
  setButtonLoading(button, true, "正在注销");
  try {
    const result = await api("/api/auth/sessions", { method: "DELETE" });
    await loadAccountSessions();
    toast(result.revoked ? `已注销 ${result.revoked} 个登录会话` : "没有其他有效会话", "success");
  } catch (error) {
    setAuthError($("#accountSessionsError"), error.message);
  } finally {
    setButtonLoading(button, false);
  }
});

$("#logoutButton").addEventListener("click", async () => {
  const button = $("#logoutButton");
  setButtonLoading(button, true, "正在退出");
  try {
    await api("/api/auth/logout", { method: "POST", body: "{}" });
  } catch (error) {
    toast(error.message, "error");
  } finally {
    setButtonLoading(button, false);
    state = null;
    showAuthentication({ configured: true, authenticated: false, username: "admin" });
  }
});

$("#passwordForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!validateForm(form)) return;
  const button = $("#savePasswordButton");
  setButtonLoading(button, true, "正在更新密码");
  setFormPending(form, true);
  setAuthError($("#passwordError"));
  try {
    await api("/api/auth/password", {
      method: "POST",
      body: JSON.stringify({
        currentPassword: $("#currentPassword").value,
        password: $("#newPassword").value,
        confirmation: $("#newPasswordConfirmation").value,
      }),
    });
    $("#passwordDialog").close();
    form.reset();
    toast("管理密码已更新，其他登录会话已注销", "success");
  } catch (error) {
    setAuthError($("#passwordError"), error.message);
  } finally {
    setButtonLoading(button, false);
    setFormPending(form, false);
  }
});

elements.refresh.addEventListener("click", () => loadDashboard(currentNode()?.id, currentPeer()?.id));
$("#nodeSelect").addEventListener("change", (event) => loadDashboard(event.target.value));
$("#peerSelect").addEventListener("change", (event) => loadDashboard(currentNode().id, event.target.value));
function moveTabFocus(event, tabs, activate) {
  const keys = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"];
  if (!keys.includes(event.key)) return;
  event.preventDefault();
  const current = tabs.indexOf(event.currentTarget);
  const next = event.key === "Home"
    ? 0
    : event.key === "End"
      ? tabs.length - 1
      : (current + (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1) + tabs.length) % tabs.length;
  const target = tabs[next];
  target.focus();
  activate(target);
}

const workspaceTabs = $$(".workspace-tab");
workspaceTabs.forEach((tab) => {
  tab.addEventListener("click", () => activateWorkspace(tab.dataset.workspace));
  tab.addEventListener("keydown", (event) => moveTabFocus(event, workspaceTabs, (target) => activateWorkspace(target.dataset.workspace)));
});
const resourceTabs = $$(".resource-tab");
resourceTabs.forEach((tab) => {
  tab.addEventListener("click", () => activateResourceTab(tab.dataset.resourceTab));
  tab.addEventListener("keydown", (event) => moveTabFocus(event, resourceTabs, (target) => activateResourceTab(target.dataset.resourceTab)));
});
const channelTabs = $$('.afi-tab');
channelTabs.forEach((tab) => {
  tab.addEventListener("click", () => activateChannelTab(tab.dataset.channelTab));
  tab.addEventListener("keydown", (event) => moveTabFocus(event, channelTabs, (target) => activateChannelTab(target.dataset.channelTab)));
});
$$('[data-resource-target]').forEach((button) => button.addEventListener("click", () => {
  activateWorkspace("resourceWorkspace", button.dataset.resourceTarget);
}));
$("#emptyAddPeerButton").addEventListener("click", () => activateWorkspace("resourceWorkspace", "peers"));
$("#manageAddNodeButton").addEventListener("click", () => openNodeDialog());
$("#manageAddPeerButton").addEventListener("click", () => openPeerDialog());
$("#manageAddDefineButton").addEventListener("click", () => openPolicyResourceDialog("defines"));
$("#manageAddStaticButton").addEventListener("click", () => openStaticDialog());
$("#manageAddFunctionButton").addEventListener("click", () => openPolicyResourceDialog("functions"));
$("#manageAddFilterButton").addEventListener("click", () => openPolicyResourceDialog("filters"));
$("#manageAddRPKIButton").addEventListener("click", () => openRPKIDialog());
$("#nodeEditorTransport").addEventListener("change", toggleSshField);
$("#nodeForm").addEventListener("submit", saveNode);
$("#nodeForm").addEventListener("input", () => {
  if (value("nodeId")) return;
  resetNodeOnboardingVerification();
  $("#nodeSetupGuide").hidden = true;
});
$("#generateNodeSetupButton").addEventListener("click", generateNodeSetupScript);
$("#testNodeConnectionButton").addEventListener("click", testNodeConnection);
$("#copyNodeSetupButton").addEventListener("click", async () => {
  try {
    await copyText($("#nodeSetupScript").textContent);
    toast("准备脚本已复制", "success");
  } catch {
    toast("无法访问剪贴板", "error");
  }
});
$("#peerForm").addEventListener("submit", savePeer);
$("#policyResourceForm").addEventListener("submit", savePolicyResource);
$("#staticForm").addEventListener("submit", saveStatic);
$("#staticLabel").addEventListener("input", syncStaticName);
$("#staticName").addEventListener("input", () => { $("#staticName").dataset.edited = "true"; });
$("#staticNodeId").addEventListener("change", () => {
  syncStaticDefines();
  syncStaticEditor();
});
$("#staticFamily").addEventListener("change", () => {
  syncStaticDefines();
  syncStaticName();
  syncStaticEditor();
});
$("#staticDefineId").addEventListener("change", () => {
  renderStaticRouteActions();
  syncStaticEditor();
});
$("#staticBulkAction").addEventListener("change", syncStaticBulkAction);
$("#staticBulkVia").addEventListener("input", syncStaticBulkAction);
$("#applyStaticBulkActionButton").addEventListener("click", applyStaticBulkAction);
$("#staticRouteActionList").addEventListener("change", (event) => {
  const row = event.target.closest("[data-static-route-prefix]");
  if (!row) return;
  syncStaticRouteRow(row);
  syncStaticEditor();
});
$("#staticRouteActionList").addEventListener("input", (event) => {
  const row = event.target.closest("[data-static-route-prefix]");
  if (!row) return;
  syncStaticRouteRow(row);
  syncStaticEditor();
});
$("#staticRaw").addEventListener("input", syncStaticEditor);
$("#rpkiForm").addEventListener("submit", saveRPKI);
$("#rpkiLabel").addEventListener("input", syncRPKINames);
for (const id of ["rpkiName", "rpkiRoa4Table", "rpkiRoa6Table"]) {
  $(`#${id}`).addEventListener("input", () => { $(`#${id}`).dataset.edited = "true"; });
}
$("#rpkiSourceType").addEventListener("change", syncRPKIFields);
$("#rpkiTransport").addEventListener("change", syncRPKIFields);
$("#rpkiAuthentication").addEventListener("change", syncRPKIFields);
$("#sessionLocalAddress").addEventListener("input", updatePairSummary);
$("#sessionLocalAsn").addEventListener("input", updatePairSummary);
elements.sessionForm.addEventListener("change", (event) => {
  if (event.target.id === "connectionMode") syncConnectionMode();
  if (event.target.id === "bfdMode") syncBfdMode();
  if (event.target.id === "bgpAuthentication") syncAuthenticationMode();
  if ([
    "capabilities", "routeRefresh", "enhancedRouteRefresh", "gracefulRestart",
    "longLivedGracefulRestart", "enableAs4", "extendedMessages", "advertiseHostname",
    "localRole",
  ].includes(event.target.id)) syncCapabilityRequirements();
  if (event.target.id === "disableAfterError") {
    for (const item of CHANNEL_FAMILIES) syncChannelRequirementControls(item);
  }
  if (["holdTime", "keepaliveTime", "minHoldTime", "minKeepaliveTime"].includes(event.target.id)) syncTimerConstraints();
  const family = CHANNEL_FAMILIES.find((item) => event.target.id.startsWith(item) || event.target.name?.startsWith(item));
  if (family && event.target.id === `${family}Enabled`) syncChannelAvailability(family);
  if (family && event.target.id === `${family}ExportDefineSelect`) syncExportFormAvailability(family);
  if (family && [
    `${family}ExtendedNextHop`, `${family}AddPaths`, `${family}GatewayMode`,
    `${family}ImportLimit`, `${family}ImportLimitAction`,
  ].includes(event.target.id)) syncChannelRequirementControls(family);
  for (const direction of ["import", "export"]) {
    const key = family ? policyPrefix(family, direction) : null;
    if (key && event.target.id === `${key}FormAction`) {
      syncFormStepPresentation(family, direction);
      if (direction === "export") syncExportFormAvailability(family);
    }
    if (key && event.target.name === `${key}PolicyMode`) syncPolicyControls(family, direction);
  }
  scheduleAutoPreview();
});
elements.sessionForm.addEventListener("input", (event) => {
  if (["holdTime", "keepaliveTime", "minHoldTime", "minKeepaliveTime"].includes(event.target.id)) syncTimerConstraints();
});
elements.sessionForm.addEventListener("focusout", (event) => {
  if (event.target.matches("input, select, textarea")) scheduleAutoPreview();
});
$("#policyResourceLabel").addEventListener("input", () => {
  syncPolicyResourceName();
});
$("#policyResourceType").addEventListener("change", () => {
  $("#policyResourceSource").value = value("policyResourceType").startsWith("cidr") ? "" : "true";
  delete $("#policyResourceSource").dataset.edited;
  syncPolicyResourceName();
  syncPolicyResourceEditor();
});
$("#policyResourceName").addEventListener("input", () => {
  $("#policyResourceName").dataset.edited = "true";
  if (
    !value("policyResourceId") &&
    !$("#policyResourceSource").dataset.edited &&
    (value("policyResourceKind") !== "defines" || value("policyResourceType") === "expression")
  ) {
    $("#policyResourceSource").value = defaultPolicySource(value("policyResourceKind"), value("policyResourceName"));
    updatePolicySourceEditor();
  }
});
$("#policyResourceSource").addEventListener("input", () => {
  $("#policyResourceSource").dataset.edited = "true";
  updatePolicySourceEditor();
});
$("#policyResourceSource").addEventListener("keydown", handlePolicySourceKeydown);
$("#policyResourceSource").addEventListener("scroll", updatePolicySourceEditor);
$("#policyResourceSource").addEventListener("click", updatePolicySourceEditor);
$("#policyResourceSource").addEventListener("keyup", updatePolicySourceEditor);
$("#policyResourceNodeId").addEventListener("change", renderPolicySourceReferences);
$("#policySourceReferenceSearch").addEventListener("input", renderPolicySourceReferences);
$("#policySourceReferences").addEventListener("click", (event) => {
  const button = event.target.closest("[data-reference-insert]");
  if (!button) return;
  const editor = $("#policyResourceSource");
  const symbol = button.dataset.referenceInsert;
  replacePolicySource(editor.selectionStart, editor.selectionEnd, symbol, editor.selectionStart + symbol.length);
  editor.focus();
});

$("#policyActionForm").addEventListener("submit", savePolicyAction);
$("#policyActionLabel").addEventListener("input", () => {
  $("#policyActionLabel").dataset.edited = "true";
  syncPolicyActionName();
});
$("#policyActionName").addEventListener("input", () => { $("#policyActionName").dataset.edited = "true"; });
["policyActionType", "policyActionCommunityOperation", "policyActionCommunityKind", "policyActionPrependAsnMode"].forEach((id) => {
  $(`#${id}`).addEventListener("change", syncPolicyActionDialog);
});
$("#policyActionDefineSelect").addEventListener("change", () => {
  const define = value("policyActionDefineSelect");
  if (!define) return;
  const editor = $("#policyActionCondition");
  editor.value = `net ~ ${define}`;
  editor.focus();
});

$$('[data-close]').forEach((button) => button.addEventListener("click", () => $(`#${button.dataset.close}`).close()));
$$('dialog').forEach((dialog) => dialog.addEventListener("cancel", (event) => {
  if (dialog.querySelector('form[aria-busy="true"]')) event.preventDefault();
}));
elements.mutationWaitDialog.addEventListener("cancel", (event) => event.preventDefault());
elements.policyActionDialog.addEventListener("close", () => { policyActionContext = null; });
$("#protocolRows").addEventListener("click", (event) => {
  const button = event.target.closest("[data-open-routes]");
  if (button && !button.disabled) openRouteDialog(button.dataset.openRoutes);
});
$("#routeFamilyControl").addEventListener("click", (event) => {
  const button = event.target.closest("[data-route-family]");
  if (!button || button.disabled || !routeDialogContext || routeDialogContext.family === button.dataset.routeFamily) return;
  routeDialogContext.family = button.dataset.routeFamily;
  syncRouteDialogControls();
  void loadRouteDetails();
});
$("#routeDirectionControl").addEventListener("click", (event) => {
  const button = event.target.closest("[data-route-direction]");
  if (!button || !routeDialogContext || routeDialogContext.direction === button.dataset.routeDirection) return;
  routeDialogContext.direction = button.dataset.routeDirection;
  syncRouteDialogControls();
  void loadRouteDetails();
});
$("#routeDialogBody").addEventListener("click", (event) => {
  if (event.target.closest("[data-retry-routes]")) void loadRouteDetails({ force: true });
});
elements.routeDialog.addEventListener("close", () => {
  routeDetailsAbortController?.abort();
  routeDetailsAbortController = null;
  routeDetailsRequestId += 1;
  routeDialogContext = null;
});

$("#deleteNodeButton").addEventListener("click", async () => {
  const node = inventoryNode(value("nodeId"));
  if (!node) return;
  if (!window.confirm(`安全退役节点 ${node.name}？Birdbox 将先清空远端受管 include；控制器公钥和主配置 include 行仍需手动删除。`)) return;
  const button = $("#deleteNodeButton");
  setButtonLoading(button, true, "正在删除");
  setFormPending($("#nodeForm"), true);
  try {
    await api(`/api/nodes/${node.id}`, { method: "DELETE" });
    await loadDashboard();
    setButtonLoading(button, false);
    setFormPending($("#nodeForm"), false);
    elements.nodeDialog.close();
    showNodeCleanupDialog(node, false);
  } catch (error) { toast(error.message, "error"); }
  finally {
    setButtonLoading(button, false);
    setFormPending($("#nodeForm"), false);
  }
});

$("#forceDeleteNodeButton").addEventListener("click", async () => {
  const node = inventoryNode(value("nodeId"));
  if (!node) return;
  const confirmation = `遗忘 ${node.id}`;
  const counts = [
    ["sessions", state.inventory.sessions.filter((item) => item.nodeId === node.id).length],
    ["Peers", state.inventory.peers.filter((item) => item.nodeId === node.id).length],
    ["Defines", state.inventory.defines.filter((item) => item.nodeId === node.id).length],
    ["Functions", state.inventory.functions.filter((item) => item.nodeId === node.id).length],
    ["Filters", state.inventory.filters.filter((item) => item.nodeId === node.id).length],
    ["RPKI", state.inventory.rpki.filter((item) => item.nodeId === node.id).length],
    ["Static", (state.inventory.staticProtocols ?? []).filter((item) => item.nodeId === node.id).length],
  ].map(([label, count]) => `${label} ${count}`).join("、");
  if (!window.confirm(`强制遗忘 ${node.name} (${node.sshHost}:${node.sshPort})？将级联删除 ${counts}，且不会清理远端配置。`)) return;
  if (window.prompt(`请输入“${confirmation}”以确认：`) !== confirmation) return;
  const button = $("#forceDeleteNodeButton");
  setButtonLoading(button, true, "正在遗忘");
  setFormPending($("#nodeForm"), true);
  try {
    await api(`/api/nodes/${node.id}?force=true`, { method: "DELETE" });
    await loadDashboard();
    setButtonLoading(button, false);
    setFormPending($("#nodeForm"), false);
    elements.nodeDialog.close();
    showNodeCleanupDialog(node, true);
  } catch (error) { toast(error.message, "error"); }
  finally {
    setButtonLoading(button, false);
    setFormPending($("#nodeForm"), false);
  }
});

$("#deletePeerButton").addEventListener("click", async () => {
  const peer = state.inventory.peers.find((item) => item.id === value("peerId"));
  if (!peer) return;
  if (!window.confirm(`删除 Peer ${peer.name}？`)) return;
  const button = $("#deletePeerButton");
  setButtonLoading(button, true, "正在删除");
  setFormPending($("#peerForm"), true);
  try {
    await api(`/api/peers/${peer.id}`, { method: "DELETE" });
    await loadDashboard(peer.nodeId);
    setButtonLoading(button, false);
    setFormPending($("#peerForm"), false);
    elements.peerDialog.close();
    toast("Peer 已删除", "success");
  } catch (error) { toast(error.message, "error"); }
  finally {
    setButtonLoading(button, false);
    setFormPending($("#peerForm"), false);
  }
});

$("#deletePolicyResourceButton").addEventListener("click", async () => {
  const collection = value("policyResourceKind");
  const resource = state.inventory[collection].find((item) => item.id === value("policyResourceId"));
  if (!resource || !window.confirm(`删除 ${policyKindLabel(collection)} ${resource.name}？`)) return;
  const button = $("#deletePolicyResourceButton");
  setButtonLoading(button, true, "正在删除");
  setFormPending($("#policyResourceForm"), true);
  try {
    await api(`/api/${collection}/${resource.id}`, { method: "DELETE" });
    await loadDashboard(resource.nodeId ?? currentNode()?.id, currentPeer()?.id);
    activateResourceTab(collection);
    setButtonLoading(button, false);
    setFormPending($("#policyResourceForm"), false);
    elements.policyResourceDialog.close();
    toast(`${policyKindLabel(collection)} 已删除`, "success");
  } catch (error) { toast(error.message, "error"); }
  finally {
    setButtonLoading(button, false);
    setFormPending($("#policyResourceForm"), false);
  }
});

$("#deleteStaticButton").addEventListener("click", async () => {
  const resource = (state.inventory.staticProtocols ?? []).find((item) => item.id === value("staticId"));
  if (!resource || !window.confirm(`删除 Static ${resource.name}？`)) return;
  const button = $("#deleteStaticButton");
  setButtonLoading(button, true, "正在删除");
  setFormPending($("#staticForm"), true);
  try {
    const result = await api(`/api/statics/${resource.id}`, { method: "DELETE" });
    const peerId = currentNode()?.id === resource.nodeId ? currentPeer()?.id : null;
    await loadDashboard(resource.nodeId, peerId);
    activateResourceTab("statics");
    setButtonLoading(button, false);
    setFormPending($("#staticForm"), false);
    elements.staticDialog.close();
    toast(`Static 已删除，${deploymentSummary(result.deployment)}`, "success");
  } catch (error) { presentFormError($("#staticForm"), error); }
  finally {
    setButtonLoading(button, false);
    setFormPending($("#staticForm"), false);
  }
});

$("#deleteRPKIButton").addEventListener("click", async () => {
  const resource = state.inventory.rpki.find((item) => item.id === value("rpkiId"));
  if (!resource || !window.confirm(`删除 RPKI ${resource.name}？`)) return;
  const button = $("#deleteRPKIButton");
  setButtonLoading(button, true, "正在删除");
  setFormPending($("#rpkiForm"), true);
  try {
    await api(`/api/rpki/${resource.id}`, { method: "DELETE" });
    await loadDashboard(currentNode()?.id, currentPeer()?.id);
    activateResourceTab("rpki");
    setButtonLoading(button, false);
    setFormPending($("#rpkiForm"), false);
    elements.rpkiDialog.close();
    toast("RPKI 已删除", "success");
  } catch (error) { toast(error.message, "error"); }
  finally {
    setButtonLoading(button, false);
    setFormPending($("#rpkiForm"), false);
  }
});

elements.sessionForm.addEventListener("submit", async (event) => { event.preventDefault(); await previewSession(); });
elements.apply.addEventListener("click", () => {
  if (!sessionFormValid(true)) return;
  cancelPendingPreview();
  $("#dialogLocal").textContent = `${value("sessionLocalAddress") || "自动选择"} · AS${value("sessionLocalAsn")}`;
  $("#dialogRemote").textContent = `${currentPeer().name} · AS${currentPeer().asn}`;
  elements.applyDialog.showModal();
});
$("#confirmApplyButton").addEventListener("click", (event) => { event.preventDefault(); void applySession(); });

elements.removeSession.addEventListener("click", async () => {
  const session = currentPeer()?.session;
  if (!session || !window.confirm(`移除会话 ${session.protocolName}？`)) return;
  const nodeId = currentNode().id;
  const peerId = currentPeer().id;
  setBusy(true, "正在移除会话", elements.removeSession);
  try {
    await api(`/api/sessions/${session.id}`, { method: "DELETE" });
    toast("会话已移除", "success");
    await loadDashboard(nodeId, peerId);
  } catch (error) { toast(error.message, "error"); }
  finally { setBusy(false); }
});

elements.stop.addEventListener("click", async () => {
  const node = currentNode();
  const peer = currentPeer();
  const session = peer?.session;
  if (!node || !peer || !session) return;
  const disabled = peer.protocol?.disabled === true;
  const action = disabled ? "enable" : "disable";
  if (!window.confirm(`${disabled ? "启动" : "停止"} ${node.name} 上的 BGP 会话 ${session.protocolName}？`)) return;
  setBusy(true, disabled ? "正在启动会话" : "正在停止会话", elements.stop);
  try {
    await api(`/api/sessions/${session.id}/control`, { method: "POST", body: JSON.stringify({ action }) });
    toast(disabled ? "BGP 会话已启动" : "BGP 会话已停止", "success");
    await new Promise((resolve) => setTimeout(resolve, 500));
    await loadDashboard(node.id, currentPeer()?.id);
  } catch (error) { toast(error.message, "error"); }
  finally { setBusy(false); }
});

$$('.tab').forEach((tab) => tab.addEventListener("click", () => {
  $$('.tab').forEach((item) => item.classList.toggle("active", item === tab));
  $$('.tab').forEach((item) => {
    const active = item === tab;
    item.setAttribute("aria-selected", String(active));
    item.tabIndex = active ? 0 : -1;
  });
  $$('.tab-panel').forEach((panel) => panel.classList.toggle("active", panel.id === tab.dataset.tab));
}));
const configTabs = $$(".tab");
configTabs.forEach((tab) => tab.addEventListener("keydown", (event) => moveTabFocus(event, configTabs, (target) => target.click())));

$$('form[id]').forEach((form) => {
  form.noValidate = true;
  const refreshValidation = (event) => refreshControlValidation(event.target);
  form.addEventListener("input", refreshValidation);
  form.addEventListener("change", refreshValidation);
  form.addEventListener("reset", () => requestAnimationFrame(() => clearFormValidation(form)));
});
$$('dialog').forEach((dialog) => dialog.addEventListener("close", () => {
  dialog.querySelectorAll("form").forEach((form) => {
    resetFormPending(form);
    clearFormValidation(form);
  });
}));
$$('dialog').forEach((dialog) => dialog.addEventListener("cancel", (event) => {
  if (!dialog.querySelector('form[aria-busy="true"]')) return;
  event.preventDefault();
  toast("操作正在进行，请稍候", "error");
}));

initializeTheme();
initializeAuthentication();
