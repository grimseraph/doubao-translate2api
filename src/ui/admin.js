import { createIcons, Languages, ShieldCheck, LogOut, ArrowRight, Eye, EyeOff, RefreshCw, Plus,
  KeyRound, LockKeyhole, Repeat2, Pin, Copy, Shield, Sparkles, Check, X, Upload, Trash2,
  FileText, CircleCheck, CircleAlert, Clock, Pencil, SearchCheck, Sun, Moon, Activity, Plug } from "lucide";

const icons = { Languages, ShieldCheck, LogOut, ArrowRight, Eye, EyeOff, RefreshCw, Plus, KeyRound,
  LockKeyhole, Repeat2, Pin, Copy, Shield, Sparkles, Check, X, Upload, Trash2, FileText, CircleCheck,
  CircleAlert, Clock, Pencil, SearchCheck, Sun, Moon, Activity, Plug };
const $ = id => document.getElementById(id);
const iconify = () => createIcons({ icons });
const escape = value => String(value).replace(/[&<>"']/g, char => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[char]);
let csrf = "", data = { mode: "failover", activeId: "file", accounts: [] }, editing = null, deleting = null, toastTimer;
const tabs = ["overview-tab", "cookies-tab", "connection-tab", "security-tab"];
let usageTimer, usageLoading = false;
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const label = theme === "dark" ? "切换浅色" : "切换深色";
  $("theme-toggle").title = $("theme-toggle").ariaLabel = label;
  $("theme-toggle").innerHTML = `<i data-lucide="${theme === "dark" ? "sun" : "moon"}"></i>`;
  iconify();
}
let savedTheme;
try { savedTheme = localStorage.getItem("admin-theme"); } catch { /* Storage may be restricted. */ }
setTheme(savedTheme === "light" ? "light" : "dark");
$("theme-toggle").addEventListener("click", () => {
  const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  setTheme(theme);
  try { localStorage.setItem("admin-theme", theme); } catch { /* The toggle still works without storage. */ }
});
const errors = {
  invalid_admin_password: "密码不正确", admin_login_rate_limited: "登录尝试过多，请稍后再试",
  admin_login_required: "登录已过期，请重新登录", admin_csrf_error: "会话已更新，请刷新后重试",
  admin_storage_error: "保存失败，请检查数据目录权限", account_not_found: "这份 Cookie 已不存在",
  invalid_request: "请检查名称与 Cookie，Cookie 需包含 sessionid、sid_tt 和 uid_tt",
  api_key_storage_error: "API Key 读写失败，请检查数据目录权限",
  api_key_managed_externally: "API Key 由环境变量配置，请修改部署配置",
  api_auth_disabled: "API 鉴权已关闭",
  unsupported_target_language: "不支持这个目标语言",
  translation_timeout: "翻译超过总时间限制，请缩短文本后重试",
  no_available_cookie: "没有可用 Cookie，请检查账号状态",
  queue_full: "请求队列已满", queue_timeout: "排队超时",
  upstream_auth_error: "豆包登录已失效", upstream_timeout: "上游请求超时",
  upstream_network_error: "上游连接失败", upstream_incomplete_result: "译文不完整",
};
async function api(path, method = "GET", body) {
  const response = await fetch("/admin/api" + path, {
    method, credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(csrf ? { "X-Admin-CSRF": csrf } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok) {
    if (result.error?.code === "admin_login_required") showLogin();
    throw new Error(errors[result.error?.code] ?? (response.status === 429 ? "请求过多，请稍后重试" : "操作失败，请稍后重试"));
  }
  return result;
}
function toast(message, error = false) {
  clearTimeout(toastTimer);
  $("toast").textContent = message; $("toast").classList.toggle("error", error); $("toast").hidden = false;
  const host = document.querySelector("dialog[open] form") ?? ($("dashboard").hidden ? $("login-form") : $("dashboard"));
  if (host.id === "dashboard") host.insertBefore($("toast"), document.querySelector(".tabs"));
  else host.append($("toast"));
  toastTimer = setTimeout(() => { $("toast").hidden = true; }, 4500);
}
async function busy(button, action) {
  if (button?.disabled) return;
  if (button) { button.disabled = true; button.setAttribute("aria-busy", "true"); }
  try { return await action(); }
  finally { if (button) { button.disabled = false; button.removeAttribute("aria-busy"); } }
}
function showLogin() {
  clearInterval(usageTimer);
  csrf = ""; $("dashboard").hidden = true; $("user-actions").hidden = true; $("login-screen").hidden = false;
  for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();
  $("account-form").reset(); $("password-form").reset(); editing = null; deleting = null;
  data = { mode: "failover", activeId: "file", accounts: [] };
  clearApiKey();
  selectTab("overview-tab");
  $("test-form").reset(); $("test-status").textContent = "";
  $("usage-failures").replaceChildren();
  document.querySelectorAll("[data-reveal]").forEach(button => {
    $(button.dataset.reveal).type = "password";
    button.title = button.ariaLabel = "显示密码";
    button.innerHTML = '<i data-lucide="eye"></i>';
  });
  iconify();
}
async function showDashboard() {
  await reload();
  await loadApiKey();
  await loadTranslationSettings();
  await loadUsage();
  $("login-screen").hidden = true; $("dashboard").hidden = false; $("user-actions").hidden = false;
  $("base-url").textContent = location.origin + "/v1";
  clearInterval(usageTimer);
  usageTimer = setInterval(() => {
    if (!document.hidden && !$("dashboard").hidden && !$("overview-panel").hidden)
      void loadUsage().catch(() => { $("usage-storage").textContent = "刷新失败"; });
  }, 10000);
}
const number = value => new Intl.NumberFormat("zh-CN").format(value ?? 0);
const duration = value => value == null ? "—" : value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`;
async function loadUsage() {
  if (usageLoading) return;
  usageLoading = true;
  const session = csrf;
  try {
    const usage = await api("/usage");
    if (!csrf || csrf !== session) return;
    const today = usage.today ?? {}, completed = (today.succeeded ?? 0) + (today.failed ?? 0);
    $("usage-requests").textContent = number(today.requests);
    $("usage-date").textContent = new Date().toISOString().slice(0, 10);
    $("usage-rate").textContent = completed ? `${(100 * (today.succeeded ?? 0) / completed).toFixed(1)}%` : "—";
    $("usage-average").textContent = duration(usage.averageMs);
    $("usage-p95").textContent = duration(usage.p95Ms);
    $("usage-samples").textContent = usage.sampleCount;
    $("usage-chars").textContent = number(today.inputChars);
    $("usage-outcomes").textContent = `${number(today.succeeded)} / ${number(today.failed)} / ${number(today.cancelled)}`;
    $("usage-upstream").textContent = number(today.upstreamCalls);
    $("usage-retries").textContent = `${number(today.retries)} / ${number(today.switches)}`;
    $("usage-wait").textContent = duration(usage.averageQueueMs);
    const load = usage.concurrency;
    $("usage-active").textContent = `${load.active} / ${load.limit} 处理中`;
    $("usage-queue").textContent = `${load.queued} / ${load.maxQueue} 排队`;
    const segments = 20, filled = Math.ceil(segments * load.active / load.limit);
    $("load-meter").innerHTML = Array.from({ length: segments }, (_, i) => `<span class="${i < filled ? "filled" : ""}"></span>`).join("");
    const days = Array.from({ length: 7 }, (_, i) => {
      const date = new Date(Date.now() - (6 - i) * 86400000).toISOString().slice(0, 10);
      return { date, requests: usage.days.find(day => day.date === date)?.requests ?? 0 };
    });
    const max = Math.max(1, ...days.map(day => day.requests));
    $("usage-trend").innerHTML = days.map(day => `<div class="trend-column"><span>${number(day.requests)}</span><meter min="0" max="${max}" value="${day.requests}" aria-label="${day.date} 请求次数">${day.requests}</meter><span>${day.date.slice(5)}</span></div>`).join("");
    const storageError = usage.persistence === "error" || usage.accountPersistence === "error";
    $("usage-storage").textContent = usage.persistence === "error" ? "统计保存异常" : usage.accountPersistence === "error" ? "账号状态保存异常" :
      usage.persistence === "saved" && usage.accountPersistence === "saved" ? "已保存 · 10 秒刷新" : "等待保存 · 10 秒刷新";
    $("usage-storage").classList.toggle("error-value", storageError);
    $("usage-failures").innerHTML = usage.failures.length ? usage.failures.slice(0, 10).map(item =>
      `<div class="failure-row"><time>${date(item.time)}</time><span>${escape(item.model)}<small>${escape(item.protocol)}</small></span><span class="error-value">${escape(errors[item.code] ?? reasons[item.code] ?? item.code)}</span><span>${duration(item.elapsedMs)}</span></div>`).join("") : '<p class="empty-state">暂无失败记录</p>';
  } finally { usageLoading = false; }
}
const date = time => time ? new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(time) : "—";
const health = {
  unknown: ["待检测", "key-round", "neutral"], valid: ["登录有效", "circle-check", "valid"],
  invalid: ["不可用", "circle-alert", "invalid"], cooldown: ["冷却中", "clock", "cooldown"],
};
const reasons = {
  cookie_missing: "Cookie 文件尚未导入", cookie_invalid: "Cookie 不完整", cookie_expired: "登录已过期",
  upstream_auth_error: "登录已失效", upstream_timeout: "上游请求超时", upstream_network_error: "上游连接失败",
  upstream_http_error: "上游暂时不可用", upstream_incomplete_result: "译文不完整",
};
function render() {
  $("account-count").textContent = data.accounts.length;
  $("enabled-count").textContent = `${data.accounts.filter(x => x.enabled).length} / ${data.accounts.length} 已启用`;
  document.querySelectorAll("input[name=mode]").forEach(input => { input.checked = input.value === data.mode; });
  $("preferred-field").hidden = data.mode === "round-robin";
  $("preferred-account").innerHTML = data.accounts.map(account =>
    `<option value="${escape(account.id)}" ${account.id === data.activeId ? "selected" : ""} ${account.enabled ? "" : "disabled"}>${escape(account.name)}</option>`).join("");
  $("empty-state").hidden = data.accounts.length !== 0;
  $("accounts").innerHTML = data.accounts.map(account => {
    const cooling = account.health.status === "cooldown" && account.health.cooldownUntil > Date.now();
    const [label, icon, tone] = health[account.health.status === "cooldown" && !cooling ? "unknown" : account.health.status] ?? health.unknown;
    const detail = cooling ? `可重试于 ${date(account.health.cooldownUntil)}` :
      account.health.reason ? reasons[account.health.reason] ?? "上游暂时不可用" :
      account.health.checkedAt ? `检测于 ${date(account.health.checkedAt)}` : "—";
    const current = data.mode !== "round-robin" && data.activeId === account.id;
    return `<div class="account-row ${account.enabled ? "" : "disabled-row"}" data-account="${escape(account.id)}">
      <div class="account-identity"><span class="account-avatar ${account.source === "file" ? "local" : ""}"><i data-lucide="${account.source === "file" ? "file-text" : "key-round"}"></i></span>
        <div><div class="account-name">${escape(account.name)}${current ? '<span class="current-label">当前</span>' : ""}</div><div class="account-source">${account.source === "file" ? "本地文件" : "已导入"}</div></div></div>
      <div class="account-health"><span class="badge ${tone}"><i data-lucide="${icon}"></i>${label}</span><div class="health-detail">${escape(detail)}</div></div>
      <div class="account-time">最近使用<br>${date(account.lastUsedAt)}</div>
      <div class="account-toggle"><label class="toggle" title="${account.enabled ? "停用" : "启用"}"><input type="checkbox" data-enable="${escape(account.id)}" ${account.enabled ? "checked" : ""} aria-label="${escape(account.name)}：启用"><span></span></label></div>
      <div class="account-actions">
        <button class="icon-button primary-action" data-action="probe" data-id="${escape(account.id)}" title="检测登录" aria-label="检测 ${escape(account.name)}"><i data-lucide="search-check"></i></button>
        <button class="icon-button" data-action="prefer" data-id="${escape(account.id)}" title="优先使用" aria-label="优先使用 ${escape(account.name)}" ${account.enabled && !current ? "" : "disabled"}><i data-lucide="pin"></i></button>
        <button class="icon-button" data-action="edit" data-id="${escape(account.id)}" title="编辑" aria-label="编辑 ${escape(account.name)}"><i data-lucide="pencil"></i></button>
        <button class="icon-button" data-action="delete" data-id="${escape(account.id)}" title="删除" aria-label="删除 ${escape(account.name)}" ${account.source === "file" ? "disabled" : ""}><i data-lucide="trash-2"></i></button>
      </div></div>`;
  }).join("");
  iconify();
}
async function reload() { data = await api("/accounts"); render(); }
const languageLabels = {
  zh: "简体中文", "zh-Hant": "繁体中文", en: "英语", ja: "日语", ko: "韩语", fr: "法语",
  de: "德语", es: "西班牙语", "es-ES": "西班牙语（西班牙）", pt: "葡萄牙语", ru: "俄语",
  ar: "阿拉伯语", it: "意大利语", id: "印尼语", ms: "马来语", th: "泰语", vi: "越南语",
  fil: "菲律宾语", uz: "乌兹别克语",
};
async function loadTranslationSettings() {
  const settings = await api("/settings/translation");
  const languages = ["zh", "zh-Hant", ...settings.supportedLanguages.filter(lang => !["zh", "zh-Hant"].includes(lang))];
  $("default-target-lang").innerHTML = languages.map(lang =>
    `<option value="${escape(lang)}">${escape(languageLabels[lang] ?? lang)}</option>`).join("");
  $("default-target-lang").value = settings.defaultTargetLang;
  $("test-language").innerHTML = $("default-target-lang").innerHTML;
  $("test-language").value = settings.defaultTargetLang;
}
$("default-target-lang").addEventListener("change", async () => {
  const select = $("default-target-lang"); select.disabled = true;
  try { await api("/settings/translation", "PUT", { targetLang: select.value }); toast("默认目标语言已更新"); }
  catch (error) { await loadTranslationSettings().catch(() => {}); toast(error.message, true); }
  finally { select.disabled = false; }
});
function clearApiKey() {
  $("api-key-value").value = ""; $("api-key-value").type = "password";
  const button = $("reveal-api-key");
  button.title = button.ariaLabel = "显示 API Key";
  button.innerHTML = '<i data-lucide="eye"></i>';
}
async function loadApiKey() {
  const metadata = await api("/api-key");
  clearApiKey();
  $("api-key-source").textContent = metadata.source === "generated" ? "自动生成" :
    metadata.source === "disabled" ? "鉴权已关闭" : `环境变量 · ${metadata.count} 个 Key`;
  $("reveal-api-key").disabled = $("copy-api-key").disabled = metadata.source === "disabled";
  $("rotate-api-key").hidden = !metadata.canRotate;
  iconify();
}
async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return; } catch { /* HTTP NAS pages use the fallback. */ }
  }
  const input = document.createElement("textarea");
  input.value = text; input.style.position = "fixed"; input.style.top = "-9999px";
  document.body.append(input);
  try {
    input.select();
    if (!document.execCommand("copy")) throw new Error("Clipboard unavailable.");
  } finally { input.remove(); }
}
async function revealApiKey() {
  const session = csrf;
  const result = await api("/api-key/reveal", "POST", {});
  if (!csrf || csrf !== session) throw new Error("登录已过期，请重新登录");
  return result.key;
}
$("reveal-api-key").addEventListener("click", () => busy($("reveal-api-key"), async () => {
  if ($("api-key-value").type === "text") { clearApiKey(); iconify(); return; }
  try {
    $("api-key-value").value = await revealApiKey();
    $("api-key-value").type = "text";
    const button = $("reveal-api-key");
    button.title = button.ariaLabel = "隐藏 API Key"; button.innerHTML = '<i data-lucide="eye-off"></i>';
    iconify();
  } catch (error) { toast(error.message, true); }
}));
$("copy-api-key").addEventListener("click", () => busy($("copy-api-key"), async () => {
  try { await copyText(await revealApiKey()); toast("API Key 已复制"); }
  catch { toast("复制失败，可显示 API Key 后手动复制", true); }
}));
$("rotate-api-key").addEventListener("click", () => {
  $("api-key-error").textContent = ""; $("api-key-dialog").showModal();
});
$("api-key-form").addEventListener("submit", async event => {
  event.preventDefault();
  await busy($("api-key-submit"), async () => {
    try {
      await api("/api-key/rotate", "POST", {}); clearApiKey(); iconify();
      $("api-key-dialog").close(); toast("API Key 已更新，旧 Key 已失效");
    } catch (error) { $("api-key-error").textContent = error.message; }
  });
});
function openAccount(account = null) {
  editing = account;
  $("account-form").reset(); $("account-error").textContent = "";
  $("account-name").value = account?.name ?? "";
  $("account-dialog-title").textContent = account ? "编辑 Cookie" : "导入 Cookie";
  $("cookie-fields").hidden = account?.source === "file";
  $("cookie-input").required = !account;
  $("cookie-format").textContent = account ? "新 Cookie（可选）" : "Cookie Header / JSON";
  $("cookie-length").textContent = "0 字符";
  $("account-dialog").showModal();
}
async function readFile(file) {
  if (!file) return;
  if (file.size > 131072) { toast("文件超过 128 KB", true); return; }
  const text = await file.text();
  $("cookie-input").value = text;
  $("cookie-length").textContent = `${text.length} 字符`;
  if (!$("account-name").value) $("account-name").value = file.name.replace(/\.(txt|json)$/i, "").slice(0, 64);
}
$("login-form").addEventListener("submit", async event => {
  event.preventDefault(); $("login-error").textContent = "";
  await busy($("login-submit"), async () => {
    try {
      csrf = (await api("/login", "POST", { password: $("login-password").value })).csrf;
      $("login-password").value = ""; await showDashboard();
    } catch (error) { $("login-error").textContent = error.message; }
  });
});
$("logout").addEventListener("click", () => busy($("logout"), async () => {
  try { await api("/logout", "POST", {}); showLogin(); } catch (error) { toast(error.message, true); }
}));
$("refresh").addEventListener("click", () => busy($("refresh"), async () => {
  try { await Promise.all([reload(), loadUsage()]); toast("数据已更新"); } catch (error) { toast(error.message, true); }
}));
for (const id of ["add-account", "empty-add"]) $(id).addEventListener("click", () => openAccount());
document.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => $(button.dataset.close).close()));
for (const dialog of document.querySelectorAll("dialog")) {
  dialog.addEventListener("close", () => {
    if (dialog.id === "account-dialog") { $("account-form").reset(); editing = null; }
  });
}
document.querySelectorAll("[data-reveal]").forEach(button => button.addEventListener("click", () => {
  const input = $(button.dataset.reveal), reveal = input.type === "password";
  input.type = reveal ? "text" : "password";
  button.title = button.ariaLabel = reveal ? "隐藏密码" : "显示密码";
  button.innerHTML = `<i data-lucide="${reveal ? "eye-off" : "eye"}"></i>`; iconify();
}));
$("cookie-input").addEventListener("input", () => { $("cookie-length").textContent = `${$("cookie-input").value.length} 字符`; });
$("cookie-file").addEventListener("change", () => readFile($("cookie-file").files[0]).catch(() => toast("无法读取文件", true)));
$("cookie-input").addEventListener("dragover", event => event.preventDefault());
$("cookie-input").addEventListener("drop", event => {
  if (event.dataTransfer.files.length) { event.preventDefault(); void readFile(event.dataTransfer.files[0]).catch(() => toast("无法读取文件", true)); }
});
$("account-form").addEventListener("submit", async event => {
  event.preventDefault(); $("account-error").textContent = "";
  await busy($("account-submit"), async () => {
    try {
      const value = { name: $("account-name").value.trim() };
      if ($("cookie-input").value.trim()) value.cookie = $("cookie-input").value;
      const wasEditing = Boolean(editing);
      const result = editing ? await api("/accounts/" + encodeURIComponent(editing.id), "PATCH", value) :
        await api("/accounts", "POST", value);
      $("account-dialog").close(); await reload();
      toast(wasEditing ? "Cookie 已更新" : "Cookie 已导入");
      if (result.id) { await api(`/accounts/${encodeURIComponent(result.id)}/probe`, "POST", {}); await reload(); }
    } catch (error) {
      if ($("account-dialog").open) $("account-error").textContent = error.message;
      else toast(error.message, true);
    }
  });
});
$("accounts").addEventListener("click", async event => {
  const button = event.target.closest("[data-action]");
  if (!button || button.disabled) return;
  const account = data.accounts.find(x => x.id === button.dataset.id);
  if (!account) return;
  if (button.dataset.action === "edit") return openAccount(account);
  if (button.dataset.action === "delete") {
    deleting = account.id; $("delete-name").textContent = account.name; $("delete-dialog").showModal(); return;
  }
  await busy(button, async () => {
    try {
      if (button.dataset.action === "probe") {
        const result = await api(`/accounts/${encodeURIComponent(account.id)}/probe`, "POST", {});
        toast(result.authenticated ? "登录有效" : reasons[result.reason] ?? "登录检测未通过", !result.authenticated);
      } else {
        await api("/settings", "PUT", { mode: data.mode === "round-robin" ? "failover" : data.mode, activeId: account.id });
        toast("优先账号已更新");
      }
      await reload();
    } catch (error) { toast(error.message, true); }
  });
});
$("accounts").addEventListener("change", async event => {
  const input = event.target.closest("[data-enable]");
  if (!input) return;
  input.disabled = true;
  try { await api(`/accounts/${encodeURIComponent(input.dataset.enable)}`, "PATCH", { enabled: input.checked }); await reload(); }
  catch (error) { input.checked = !input.checked; input.disabled = false; toast(error.message, true); }
});
$("delete-form").addEventListener("submit", async event => {
  event.preventDefault();
  await busy($("delete-submit"), async () => {
    try { await api(`/accounts/${encodeURIComponent(deleting)}`, "DELETE", {}); $("delete-dialog").close(); await reload(); toast("Cookie 已删除"); }
    catch (error) { toast(error.message, true); }
  });
});
async function changeRouting(mode, activeId) {
  const controls = [...document.querySelectorAll("input[name=mode]"), $("preferred-account")];
  controls.forEach(control => { control.disabled = true; });
  try { await api("/settings", "PUT", { mode, activeId }); await reload(); toast("调度方式已更新"); }
  catch (error) { render(); toast(error.message, true); }
  finally { controls.forEach(control => { control.disabled = false; }); }
}
document.querySelectorAll("input[name=mode]").forEach(input => input.addEventListener("change", () =>
  changeRouting(input.value, data.accounts.find(x => x.id === data.activeId && x.enabled)?.id ?? data.accounts.find(x => x.enabled)?.id ?? data.activeId)));
$("preferred-account").addEventListener("change", () => changeRouting(data.mode, $("preferred-account").value));
function selectTab(id) {
  clearApiKey(); iconify();
  for (const tabId of tabs) {
    const active = id === tabId;
    $(tabId).ariaSelected = String(active); $(tabId).classList.toggle("active", active); $(tabId).tabIndex = active ? 0 : -1;
    $(tabId.replace("-tab", "-panel")).hidden = !active;
  }
  $("add-account").hidden = id !== "cookies-tab";
  $("page-title").textContent = ({ "overview-tab": "运行概览", "cookies-tab": "Cookie 池", "connection-tab": "连接与翻译", "security-tab": "安全设置" })[id];
  $("toast").hidden = true;
  if (id === "overview-tab" && csrf) void loadUsage().catch(() => toast("统计刷新失败", true));
}
for (const id of tabs) {
  $(id).addEventListener("click", () => selectTab(id));
  $(id).addEventListener("keydown", event => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const next = event.key === "Home" ? tabs[0] : event.key === "End" ? tabs.at(-1) :
        tabs[(tabs.indexOf(id) + (event.key === "ArrowLeft" ? tabs.length - 1 : 1)) % tabs.length];
      selectTab(next); $(next).focus();
    }
  });
}
$("test-form").addEventListener("submit", async event => {
  event.preventDefault();
  const session = csrf;
  $("test-result").value = ""; $("test-status").textContent = "[翻译中…]";
  await busy($("test-submit"), async () => {
    try {
      const result = await api("/translate", "POST", { text: $("test-text").value, model: $("test-model").value, targetLang: $("test-language").value });
      if (csrf !== session) return;
      $("test-result").value = result.text;
      $("test-status").textContent = `${duration(result.elapsedMs)} · ${result.upstreamBatchCount} 批次`;
    } catch (error) {
      if (csrf === session) $("test-status").textContent = error.message;
    }
  });
});
$("copy-base").addEventListener("click", async () => {
  try { await copyText(location.origin + "/v1"); toast("连接地址已复制"); }
  catch { toast("无法访问剪贴板", true); }
});
$("generate-password").addEventListener("click", () => {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const password = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  $("new-password").value = $("confirm-password").value = password;
  $("new-password").type = "text";
  const button = document.querySelector("[data-reveal=new-password]");
  button.title = button.ariaLabel = "隐藏密码"; button.innerHTML = '<i data-lucide="eye-off"></i>'; iconify();
});
$("password-form").addEventListener("submit", async event => {
  event.preventDefault(); $("password-error").textContent = "";
  if ($("new-password").value !== $("confirm-password").value) { $("password-error").textContent = "两次密码不一致"; return; }
  await busy($("password-submit"), async () => {
    try {
      await api("/password", "PUT", { currentPassword: $("current-password").value, newPassword: $("new-password").value });
      showLogin(); toast("密码已更新，请重新登录");
    } catch (error) { $("password-error").textContent = error.message; }
  });
});
iconify();
try { csrf = (await api("/session")).csrf; await showDashboard(); }
catch { showLogin(); }
