import { exec } from 'kernelsu';

let apps = [];
let changed = false;
let searchQuery = "";
let logEnabled = false;
let addAppEnabled = false;
const MODPATH = "/data/adb/modules/HyperOS_Debloat";
const DANGEROUS_GROUPS = ["危险项"];

function initTheme() {
  const saved = localStorage.getItem("theme");
  if (saved) {
    document.documentElement.setAttribute("data-theme", saved);
  } else {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.setAttribute("data-theme", prefersDark ? "dark" : "light");
  }
  updateThemeIcon();
}

function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme");
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("theme", next);
  updateThemeIcon();
}

function updateThemeIcon() {
  const btn = document.getElementById("btnTheme");
  if (!btn) return;
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  btn.innerHTML = isDark
    ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>'
    : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  btn.setAttribute("aria-label", isDark ? "切换亮色模式" : "切换暗色模式");
}

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 3000);
}

function showConfirmDialog(overlayId, options = {}) {
  return new Promise((resolve) => {
    const overlay = document.getElementById(overlayId);
    if (!overlay) { resolve(false); return; }

    if (options.title) {
      const titleEl = overlay.querySelector('.dialog-title');
      if (titleEl) titleEl.textContent = options.title;
    }
    if (options.appName) {
      const appNameEl = overlay.querySelector('[id$="AppName"]');
      if (appNameEl) appNameEl.textContent = options.appName;
    }
    if (options.appPkg) {
      const appPkgEl = overlay.querySelector('[id$="AppPkg"]');
      if (appPkgEl) appPkgEl.textContent = options.appPkg;
    }
    if (options.desc) {
      const descEl = overlay.querySelector('[id$="Desc"]');
      if (descEl) descEl.innerHTML = options.desc.replace(/\n/g, '<br>');
    }
    if (options.confirmText) {
      const confirmBtn = overlay.querySelector('.dialog-confirm, .dialog-confirm-danger');
      if (confirmBtn) confirmBtn.textContent = options.confirmText;
    }

    overlay.classList.add("show");

    const cancelBtn = overlay.querySelector('.dialog-cancel');
    const confirmBtn = overlay.querySelector('.dialog-confirm, .dialog-confirm-danger');

    const cleanup = () => {
      overlay.classList.remove("show");
      // 恢复默认按钮文本
      if (options.confirmText) {
        confirmBtn.textContent = '确认精简';
      }
      cancelBtn.removeEventListener("click", onCancel);
      confirmBtn.removeEventListener("click", onConfirm);
    };

    const onCancel = () => { cleanup(); resolve(false); };
    const onConfirm = () => { cleanup(); resolve(true); };

    cancelBtn.addEventListener("click", onCancel);
    confirmBtn.addEventListener("click", onConfirm);
  });
}

let logBuffer = [];

async function log(msg) {
  if (!logEnabled) return;
  const ts = new Date().toLocaleString("zh-CN", { hour12: false });
  logBuffer.push("[" + ts + "] " + msg);
}

// 缓冲日志一次性写入，避免每条日志一次外部命令
async function flushLog() {
  if (!logEnabled || logBuffer.length === 0) return;
  const text = logBuffer.join("\n") + "\n";
  logBuffer = [];
  try {
    await exec("cat >> \"" + MODPATH + "/webroot/debug.log\" << 'EOF'\n" + text + "EOF");
  } catch (e) {
    console.error('Log write failed:', e);
  }
}

// 同步调试日志开关到模块目录（service.sh 据此写日志）
async function syncLogFlag() {
  try {
    await exec(logEnabled
      ? 'touch "' + MODPATH + '/webroot/.debug_on"'
      : 'rm -f "' + MODPATH + '/webroot/.debug_on"');
  } catch (e) {
    console.error('Log flag sync failed:', e);
  }
}

// 生成解析候选路径的 shell 片段（结果写入 $v）
function resolveSnippet(path, v) {
  const cands = (path || '').split(';').filter(Boolean);
  let s = v + '=""\nfor _c in';
  for (const c of cands) s += " '" + c.replace(/'/g, "'\\''") + "'";
  s += '; do\n';
  s += '  case "$_c" in apex:*|pm:*) ' + v + '="$_c"; break ;; esac\n';
  s += '  case "$_c" in /system/product/*) if [ -L /system/product ]; then _r="/product${_c#/system/product}"; else _r="$_c"; fi ;; /system/system_ext/*) if [ -L /system/system_ext ]; then _r="/system_ext${_c#/system/system_ext}"; else _r="$_c"; fi ;; *) _r="$_c" ;; esac\n';
  s += '  if [ -e "$_r" ]; then ' + v + '="$_r"; break; fi\n';
  s += 'done\n';
  return s;
}

// 生成维护 .pm_removed 记录的 shell 片段（供删除模块时恢复应用）
function pmRecordSnippet(pkg, removed, file) {
  const q = "'" + pkg.replace(/'/g, "'\\''") + "'";
  if (removed) {
    return 'grep -qxF ' + q + ' "' + file + '" 2>/dev/null || echo ' + q + ' >> "' + file + '"\n';
  }
  return 'if [ -f "' + file + '" ]; then grep -vxF ' + q + ' "' + file + '" > "' + file + '.tmp" 2>/dev/null; mv "' + file + '.tmp" "' + file + '"; fi\n';
}

// 批量应用精简/恢复（一次外部命令完成）
async function applyReplaceBatch(list) {
  let script = '';
  const R = MODPATH + '/.pm_removed';
  for (const app of list) {
    const p = app.path || '';
    if (/^(apex|pm):/.test(p)) {
      const pkg = p.replace(/^(apex|pm):/, '');
      script += 'pm ' + (app.status ? 'uninstall -k --user 0' : 'install-existing --user 0') + " '" + pkg + "' < /dev/null >/dev/null 2>&1\n";
      script += pmRecordSnippet(pkg, app.status, R);
      continue;
    }
    script += resolveSnippet(p, '_real');
    // 元模块只扫描模块的 system 目录，独立分区需落到 system/product 等路径下
    script += 'case "$_real" in /system/*) _mdir="' + MODPATH + '$_real" ;; /*) _mdir="' + MODPATH + '/system$_real" ;; *) _mdir="" ;; esac\n';
    if (app.status) {
      script += 'if [ -n "$_mdir" ]; then mkdir -p "$_mdir" && touch "$_mdir/.replace"; fi\n';
      if (app.pkg) {
        script += "pm uninstall -k --user 0 '" + app.pkg + "' < /dev/null >/dev/null 2>&1\n";
        script += pmRecordSnippet(app.pkg, true, R);
      }
    } else {
      // 恢复：先尝试 umount 系统路径（兼容 Magisk/KernelSU 标准 Magic Mount 的 bind mount），
      // 不支持运行时 umount 的元模块（如 Magic Mount-rs）会失败，此时删除 .replace 后靠下次重启生效
      script += 'timeout 5 umount -l "$_real" >/dev/null 2>&1\n';
      script += 'if [ -n "$_mdir" ]; then rm -rf "$_mdir"; fi\n';
      if (app.pkg) {
        script += "pm install-existing --user 0 '" + app.pkg + "' < /dev/null >/dev/null 2>&1\n";
        script += pmRecordSnippet(app.pkg, false, R);
      }
    }
  }
  if (script) await exec(script);
}

// 与 pkg_map.sh is_blacklisted() 对齐：开机关键组件，任何配置形态都拒绝
const BLACKLIST = ['com.xiaomi.metoknlp'];
function isBlacklisted(path, pkg) {
  const p = (path || '').toLowerCase();
  const b = (pkg || '').toLowerCase();
  return BLACKLIST.some(x => b === x || p.includes(x.split('.').pop()));
}

// 警告文案由 apps.db / apps.conf 下发，WebUI 不再维护副本
const GROUP_MODES = {
  "广告/追踪": 1,
  "游戏中心": 1,
  "设备互联/生态": 2,
  "AI/小爱": 3,
  "内容/工具/安全": 3,
  "系统服务": 3,
  "无障碍/宏": 3,
  "危险项": 0,
  "自定义": 0,
  "其他": 0
};

function expandCustomGroup() {
  const customGroup = document.querySelector('.group:last-child');
  if (!customGroup || customGroup.classList.contains('open')) return;
  customGroup.classList.add('open');
  const bodyEl = customGroup.querySelector('.group-body');
  bodyEl.style.maxHeight = bodyEl.scrollHeight + 'px';
  bodyEl.style.opacity = '1';
  setTimeout(() => { bodyEl.style.maxHeight = 'none'; }, 300);
}

function showDangerConfirm(app) {
  return showConfirmDialog("dangerOverlay", {
    appName: app.name,
    desc: app.warning || "此应用属于危险项，精简后可能影响系统功能"
  });
}

let searchTimer = null;
function initSearch() {
  const input = document.getElementById("searchInput");
  if (!input) return;
  input.addEventListener("input", (e) => {
    searchQuery = e.target.value.trim().toLowerCase();
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => render(), 300);
  });
}

async function syncVersion() {
  try {
    const { stdout } = await exec('cat "' + MODPATH + '/module.prop"');
    const match = stdout.match(/^version=(.+)$/m);
    if (match) {
      const el = document.getElementById("headerVersion");
      if (el) el.textContent = match[1].trim() + " · KernelSU Module";
    }
  } catch (e) {
    console.error('Version read failed:', e);
  }
}

async function loadConfig() {
  try {
    const res = await fetch("./apps.conf");
    if (!res.ok) {
      throw new Error("无法读取 apps.conf（HTTP " + res.status + "）");
    }
    const text = await res.text();
    if (!text.trim()) {
      apps = [];
      render();
      return;
    }
    apps = text.split(/\r?\n/).reduce((acc, line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return acc;
      const parts = trimmed.split("|");
      if (parts.length >= 4) {
        if (isBlacklisted(parts[0], parts[2])) return acc; // 黑名单条目直接丢弃，保存时自愈配置
        const group = parts[4] || "其他";
        const fallbackMode = GROUP_MODES[group] !== undefined ? GROUP_MODES[group] : 0;
        acc.push({
          path: parts[0],
          name: parts[1],
          pkg: parts[2],
          status: parts[3] === "1",
          group: group,
          mode: parts[5] !== undefined && parts[5] !== "" ? parts[5] : String(fallbackMode),
          warning: parts[6] || ""
        });
      }
      return acc;
    }, []);
    originalApps = apps.map(app => ({ ...app }));
    render();
  } catch (err) {
    document.getElementById("apps").innerHTML =
      '<div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-text">加载失败：' + err.message + '</div></div>';
  }
}

function render() {
  const container = document.getElementById("apps");
  const allDisabled = apps.filter((a) => a.status).length;
  document.getElementById("stats").innerHTML = "共 <b>" + apps.length + "</b> 个应用，已精简 <b>" + allDisabled + "</b> 个";

  const openGroups = new Set();
  container.querySelectorAll('.group.open .group-name').forEach(el => {
    openGroups.add(el.textContent.replace(' ⚠', '').trim());
  });

  container.innerHTML = "";

  const groups = {};
  apps.forEach((app, i) => {
    if (!groups[app.group]) groups[app.group] = [];
    groups[app.group].push({ app, index: i });
  });

  const groupColors = {
    "AI/小爱": "#8b5cf6",
    "游戏中心": "#f59e0b",
    "设备互联/生态": "#06b6d4",
    "广告/追踪": "#ef4444",
    "内容/工具/安全": "#10b981",
    "系统服务": "#6366f1",
    "无障碍/宏": "#ec4899",
    "危险项": "#ff3b3b",
    "自定义": "#f97316",
    "其他": "#64748b"
  };

  let groupIdx = 0;
  for (const [groupName, items] of Object.entries(groups)) {
    const filtered = searchQuery
      ? items.filter(({ app }) =>
          app.name.toLowerCase().includes(searchQuery) ||
          app.pkg.toLowerCase().includes(searchQuery))
      : items;

    if (filtered.length === 0) continue;

    const groupDisabled = items.filter((x) => x.app.status).length;
    const accentColor = groupColors[groupName] || "#64748b";
    const isDangerous = DANGEROUS_GROUPS.includes(groupName);

    const group = document.createElement("div");
    const shouldBeOpen = openGroups.has(groupName) || (groupIdx === 0 && openGroups.size === 0);
    group.className = shouldBeOpen ? "group open" : "group";
    groupIdx++;

    if (isDangerous) group.classList.add("danger-group");

    const header = document.createElement("div");
    header.className = "group-header";
    header.setAttribute("role", "button");
    header.setAttribute("aria-expanded", shouldBeOpen ? "true" : "false");
    header.setAttribute("tabindex", "0");
    header.innerHTML =
      '<div class="group-left">' +
      '  <span class="group-accent" style="background:' + accentColor + (isDangerous ? ';box-shadow:0 0 8px ' + accentColor + '60' : '') + '"></span>' +
      '  <span class="group-name">' + groupName + (isDangerous ? ' <span class="danger-tag">⚠</span>' : '') + '</span>' +
      '  <span class="group-badge" style="background:' + accentColor + '18;color:' + accentColor + ';border:1px solid ' + accentColor + '30">' + groupDisabled + '/' + items.length + '</span>' +
      '</div>' +
      '<svg class="group-arrow" viewBox="0 0 24 24"><path d="M10 6l6 6-6 6z"/></svg>';

    header.addEventListener("click", () => {
      const isOpen = group.classList.contains("open");
      const bodyEl = group.querySelector(".group-body");
      if (isOpen) {
        bodyEl.style.maxHeight = bodyEl.scrollHeight + "px";
        requestAnimationFrame(() => {
          bodyEl.style.maxHeight = "0px";
          bodyEl.style.opacity = "0";
        });
        group.classList.remove("open");
      } else {
        bodyEl.style.maxHeight = bodyEl.scrollHeight + "px";
        bodyEl.style.opacity = "1";
        group.classList.add("open");
        setTimeout(() => {
          if (group.classList.contains("open")) bodyEl.style.maxHeight = "none";
        }, 300);
      }
      header.setAttribute("aria-expanded", !isOpen);
    });

    header.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        header.click();
      }
    });

    const body = document.createElement("div");
    body.className = "group-body";
    const inner = document.createElement("div");
    inner.className = "group-body-inner";

    filtered.forEach(({ app, index }) => {
      const isCustom = app.group === '自定义';
      const item = document.createElement("div");
      item.className = "app-item";
      if (isDangerous && app.status) item.classList.add("danger-active");

      let deleteBtnHtml = '';
      if (isCustom) {
        deleteBtnHtml = '<button class="delete-btn" data-index="' + index + '" aria-label="移除 ' + app.name + '">' +
          '<svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>' +
          '</button>';
      }

      item.innerHTML =
        '<div class="app-info">' +
        '  <span class="app-name">' + app.name + (isDangerous ? ' <span class="danger-dot"></span>' : '') + '</span>' +
        '  <span class="app-pkg">' + app.pkg + '</span>' +
        '</div>' +
        deleteBtnHtml +
        '<div class="toggle-wrap' + (app.status ? ' on' : '') + '" ' +
        'role="switch" aria-checked="' + app.status + '" ' +
        'aria-label="' + app.name + '" tabindex="0" data-index="' + index + '" data-danger="' + isDangerous + '" data-custom="' + isCustom + '">' +
        '  <div class="toggle"></div>' +
        '</div>';
      inner.appendChild(item);
    });

    body.appendChild(inner);
    group.appendChild(header);
    group.appendChild(body);
    container.appendChild(group);
  }

  if (container.children.length === 0 && searchQuery) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">🔍</div><div class="empty-text">未找到匹配的应用</div></div>';
  }

  bindToggles();

  const firstBody = container.querySelector(".group.open .group-body");
  if (firstBody) {
    firstBody.style.maxHeight = firstBody.scrollHeight + "px";
    firstBody.style.opacity = "1";
    setTimeout(() => { firstBody.style.maxHeight = "none"; }, 300);
  }
}

function bindToggles() {
  document.querySelectorAll(".toggle-wrap").forEach((toggle) => {
    const handler = async function() {
      const idx = parseInt(this.dataset.index);
      const isDanger = this.dataset.danger === "true";
      const isCustom = this.dataset.custom === "true";
      const willEnable = !apps[idx].status;

      if (isDanger && willEnable) {
        const confirmed = await showDangerConfirm(apps[idx]);
        if (!confirmed) return;
      }

      if (isCustom && willEnable) {
        const confirmed = await showCustomConfirm(apps[idx]);
        if (!confirmed) return;
      }

      apps[idx].status = !apps[idx].status;
      this.classList.toggle("on");
      this.setAttribute("aria-checked", apps[idx].status);
      changed = true;
      const appItem = this.closest(".app-item");
      if (isDanger) {
        appItem.classList.toggle("danger-active", apps[idx].status);
      }
      await log("Toggle " + apps[idx].name + " → " + (apps[idx].status ? "debloat" : "keep"));
      const disabled = apps.filter((a) => a.status).length;
      document.getElementById("stats").innerHTML = "共 <b>" + apps.length + "</b> 个应用，已精简 <b>" + disabled + "</b> 个";
      const groupEl = this.closest(".group");
      const gName = groupEl.querySelector(".group-name").textContent.replace(" ⚠", "").trim();
      const gItems = apps.filter((a) => a.group === gName);
      const gDisabled = gItems.filter((a) => a.status).length;
      groupEl.querySelector(".group-badge").textContent = gDisabled + "/" + gItems.length;
    };
    toggle.addEventListener("click", handler);
    toggle.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        handler.call(toggle);
      }
    });
  });

  document.querySelectorAll(".delete-btn").forEach((btn) => {
    btn.addEventListener("click", async function() {
      const idx = parseInt(this.dataset.index);
      await deleteCustomApp(idx);
    });
  });
}

async function saveConfig() {
  const btn = document.getElementById("btnSave");
  btn.disabled = true;
  btn.textContent = "保存中...";
  const btnReboot = document.getElementById("btnReboot");
  if (btnReboot) btnReboot.disabled = true;

  const savingToast = document.createElement('div');
  savingToast.className = 'toast show';
  savingToast.textContent = '正在保存配置...';
  document.body.appendChild(savingToast);

  const target = MODPATH + "/webroot/apps.conf";
  const disabled = apps.filter((a) => a.status).length;
  await log("Saving config... " + disabled + "/" + apps.length + " debloated");
  try {
    let content = '# HyperOS Debloat 配置\n# 格式：候选路径|显示名|包名|状态（1=精简 0=保留）|分组|模式|警告文案\n';
    for (const app of apps) {
      content += app.path + "|" + app.name + "|" + app.pkg + "|" + (app.status ? "1" : "0") + "|" + app.group + "|" + (app.mode || "0") + "|" + (app.warning || "") + "\n";
    }

    const todo = [];
    if (deletedApps.length > 0) {
      await log("Restoring deleted: " + deletedApps.length);
      for (const app of deletedApps) {
        todo.push({ ...app, status: false });
      }
    }

    await log("Starting debloat/restore...");
    const originalMap = new Map(originalApps.map(app => [app.pkg, app.status]));
    let changedCount = 0;
    for (const app of apps) {
      const originalStatus = originalMap.get(app.pkg);
      if (originalStatus === undefined || originalStatus !== app.status) {
        todo.push(app);
        changedCount++;
      }
    }
    await applyReplaceBatch(todo);
    await log("Done, processed " + changedCount + " apps");

    // 对 path 类型的恢复操作，验证是否即时生效（不支持运行时 umount 的元模块需重启）
    let needReboot = false;
    const restoredPathApps = todo.filter(app => !app.status && !/^(apex|pm):/.test(app.path || '') && app.pkg);
    if (restoredPathApps.length > 0) {
      const checkScript = restoredPathApps.map(app =>
        "pm path '" + app.pkg + "' | grep -q . && echo '" + app.pkg + ":ok' || echo '" + app.pkg + ":fail'"
      ).join('\n');
      const { stdout: checkOut } = await exec(checkScript);
      needReboot = (checkOut || '').split('\n').some(line => line.trim().endsWith(':fail'));
      if (needReboot) await log("Some path apps still hidden, reboot required");
    }

    // 所有操作成功后才持久化配置，避免失败时配置与实际状态不一致
    await exec('cat > "' + target + '" << \'EOF\'\n' + content + 'EOF');
    await log("Saved, wrote " + apps.length + " entries");

    originalApps = apps.map(app => ({ ...app }));

    await saveToAppsDb();

    deletedApps = [];

    savingToast.remove();

    toast(needReboot ? "配置已保存，部分应用需重启后恢复" : "配置已保存");
    changed = false;
  } catch (err) {
    savingToast.remove();

    await log("Save failed: " + err.message);
    toast("保存失败：" + err.message);
  } finally {
    await flushLog();
    btn.disabled = false;
    btn.textContent = "保存";
    if (btnReboot) btnReboot.disabled = false;
  }
}

async function doReboot() {
  await log("User triggered reboot");
  await flushLog();
  try {
    await exec("svc power reboot");
  } catch (err) {
    await log("Reboot failed: " + err.message);
    await flushLog();
    toast("重启失败，请手动重启");
  }
}

let addSelectedApps = [];
let addSearchQuery = '';
let systemAppsCache = [];
let deletedApps = [];
let originalApps = [];

async function openAddDialog() {
  const confirmed = await showConfirmDialog("dangerOverlay", {
    appName: "⚠️ 警告",
    desc: "增加应用进行精简属于高级操作，请确保：\n1. 您了解该应用的作用\n2. 精简后不会影响系统正常运行\n3. 建议先备份数据"
  });
  if (!confirmed) return;

  addSelectedApps = [];
  addSearchQuery = '';
  document.getElementById('addSearch').value = '';
  document.getElementById('addCount').textContent = '0';
  document.getElementById('addConfirm').disabled = true;
  document.getElementById('addOverlay').classList.add('show');
  await loadSystemApps();
}

// 批量解析系统应用的真实 APK 目录（一次 exec）。
// 返回 { pkg: 目录路径 或 null }；/data/app 更新副本、APEX、解析失败一律 null（落回 pm 卸载）
async function resolveSystemPaths(pkgs) {
  const result = {};
  if (!pkgs.length) return result;
  let cmd = '';
  for (const p of pkgs) {
    const q = p.replace(/'/g, "'\\''");
    cmd += "_o=$(pm path '" + q + "' 2>/dev/null | head -n1); echo '" + q + "|'\"${_o#package:}\"\n";
  }
  try {
    const { stdout } = await exec(cmd);
    (stdout || '').split('\n').forEach(line => {
      const i = line.indexOf('|');
      if (i <= 0) return;
      const pkg = line.slice(0, i).trim();
      const dir = line.slice(i + 1).trim().replace(/^package:/, '').replace(/\/[^/]*$/, ''); // 去前缀 + dirname
      // 只认只读分区路径；其余（/data/app 更新副本、空、异常）落回 pm
      result[pkg] = /^\/(system|product|system_ext|vendor)\//.test(dir + '/') ? dir : null;
    });
  } catch (e) {
    for (const p of pkgs) result[p] = null;
  }
  return result;
}

async function loadSystemApps() {
  const listEl = document.getElementById('addList');
  const statsEl = document.getElementById('addStats');
  listEl.innerHTML = '<div class="loading-spinner"></div>';
  statsEl.textContent = '正在加载系统应用...';

  try {
    const existingPkgs = new Set(apps.map(a => a.pkg));
    await log('Existing apps: ' + existingPkgs.size);

    let allPackages = [];
    try {
      const allResult = await exec('pm list packages');
      const allPkgs = allResult.stdout.split('\n')
        .filter(l => l.startsWith('package:'))
        .map(l => l.replace('package:', '').trim());
      await log('All apps: ' + allPkgs.length);

      const userResult = await exec('pm list packages -3');
      const userPkgs = new Set(userResult.stdout.split('\n')
        .filter(l => l.startsWith('package:'))
        .map(l => l.replace('package:', '').trim()));
      await log('User apps: ' + userPkgs.size);

      allPackages = allPkgs.filter(pkg => !userPkgs.has(pkg));
      await log('Non-user apps: ' + allPackages.length);
    } catch (e) {
      await log('Get app list failed: ' + e.message);
    }

    allPackages = allPackages.filter(pkg => !existingPkgs.has(pkg));
    await log('After exclude: ' + allPackages.length);

    if (allPackages.length === 0) {
      listEl.innerHTML = '<div class="empty-state"><div class="empty-icon">✅</div><div class="empty-text">所有系统应用已在列表中</div></div>';
      statsEl.textContent = '无新增应用';
      return;
    }

    let appInfos = [];
    try {
      appInfos = JSON.parse(ksu.getPackagesInfo(JSON.stringify(allPackages)));
      await log('ksu.getPackagesInfo got, count: ' + appInfos.length);
    } catch (e) {
      await log('ksu.getPackagesInfo failed: ' + e.message);
    }

    systemAppsCache = appInfos.map(info => ({
      name: info.appLabel || info.packageName,
      pkg: info.packageName,
      path: 'pm:' + info.packageName,
      icon: 'ksu://icon/' + info.packageName
    }));

    systemAppsCache.sort((a, b) => a.name.localeCompare(b.name));

    await log('Build app list done: ' + systemAppsCache.length);
    statsEl.textContent = '共 ' + systemAppsCache.length + ' 个可用应用';
    renderAddList();

  } catch (err) {
    listEl.innerHTML = '<div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-text">加载失败：' + err.message + '</div></div>';
    statsEl.textContent = '加载失败';
  }
}

function renderAddList() {
  const listEl = document.getElementById('addList');
  listEl.innerHTML = '';

  const filtered = addSearchQuery
    ? systemAppsCache.filter(app =>
        app.name.toLowerCase().includes(addSearchQuery) ||
        app.pkg.toLowerCase().includes(addSearchQuery))
    : systemAppsCache;

  if (filtered.length === 0) {
    listEl.innerHTML = '<div class="empty-state"><div class="empty-icon">🔍</div><div class="empty-text">未找到匹配的应用</div></div>';
    return;
  }

  filtered.forEach(app => {
    const isSelected = addSelectedApps.some(a => a.pkg === app.pkg);
    const item = document.createElement('div');
    item.className = 'add-app-item' + (isSelected ? ' selected' : '');
    item.dataset.pkg = app.pkg;

    const iconHtml = app.icon
      ? '<img src="' + app.icon + '" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'" alt=""><span class="icon-placeholder" style="display:none">' + app.name.charAt(0) + '</span>'
      : '<span class="icon-placeholder">' + app.name.charAt(0) + '</span>';

    item.innerHTML =
      '<div class="add-app-icon">' + iconHtml + '</div>' +
      '<div class="add-app-info">' +
      '  <div class="add-app-name">' + app.name + '</div>' +
      '  <div class="add-app-pkg">' + app.pkg + '</div>' +
      '</div>' +
      '<div class="add-app-check"><svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg></div>';

    item.addEventListener('click', () => toggleAddApp(app, item));
    listEl.appendChild(item);
  });
}

function toggleAddApp(app, itemEl) {
  const idx = addSelectedApps.findIndex(a => a.pkg === app.pkg);
  if (idx >= 0) {
    addSelectedApps.splice(idx, 1);
    itemEl.classList.remove('selected');
  } else {
    addSelectedApps.push(app);
    itemEl.classList.add('selected');
  }
  document.getElementById('addCount').textContent = addSelectedApps.length;
  document.getElementById('addConfirm').disabled = addSelectedApps.length === 0;
}

async function confirmAddApps() {
  if (addSelectedApps.length === 0) return;

  const appNames = addSelectedApps.map(a => a.name).join('、');
  const confirmed = await showConfirmDialog("customOverlay", {
    appName: appNames,
    appPkg: '共 ' + addSelectedApps.length + ' 个应用',
    confirmText: "确认添加"
  });

  if (!confirmed) return;

  const btn = document.getElementById('addConfirm');
  btn.disabled = true;
  btn.textContent = '添加中...';

  try {
    // 能拿到只读分区真实路径的走遮蔽（双候选），拿不到的落回 pm 卸载
    const pathMap = await resolveSystemPaths(addSelectedApps.map(a => a.pkg));
    for (const app of addSelectedApps) {
      const real = pathMap[app.pkg];
      apps.push({
        path: real ? real + ';pm:' + app.pkg : 'pm:' + app.pkg,
        name: app.name,
        pkg: app.pkg,
        status: true,
        group: '自定义',
        mode: '0'
      });
      await log('Add app: ' + app.name + ' (' + app.pkg + ')' + (real ? ' [mask]' : ' [pm]'));
    }

    changed = true;
    document.getElementById('addOverlay').classList.remove('show');
    render();
    expandCustomGroup();
    toast('已添加 ' + addSelectedApps.length + ' 个应用，请点击保存');

  } catch (err) {
    toast('添加失败：' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '添加';
  }
}

async function saveToAppsDb() {
  try {
    const dbPath = MODPATH + '/apps.db';
    let content = '# HyperOS Debloat 应用数据库（HyperOS 3 / 4 通用）\n# 格式：候选路径;备选|显示名|包名|分组|模式|警告文案\n';
    apps.forEach(app => {
      content += app.path + '|' + app.name + '|' + app.pkg + '|' + app.group + '|' + (app.mode || '0') + '|' + (app.warning || '') + '\n';
    });
    await exec('cat > "' + dbPath + '" << \'EOF\'\n' + content + 'EOF');
    await log('Synced to apps.db');
  } catch (err) {
    await log('Sync apps.db failed: ' + err.message);
  }
}

function showCustomConfirm(app) {
  return showConfirmDialog("customOverlay", {
    appName: app.name,
    appPkg: app.pkg
  });
}

async function deleteCustomApp(index) {
  const app = apps[index];
  const confirmed = await showConfirmDialog("deleteOverlay", {
    appName: app.name
  });

  if (!confirmed) return;

  if (app.status) {
    deletedApps.push(app);
  }

  apps.splice(index, 1);
  changed = true;
  render();
  expandCustomGroup();
  await log('Remove custom app: ' + app.name);
  toast('已移除 ' + app.name + '，请点击保存');
}

initTheme();
document.getElementById("btnTheme").addEventListener("click", toggleTheme);
document.getElementById("btnSave").addEventListener("click", saveConfig);
document.getElementById("btnReboot").addEventListener("click", () => {
  document.getElementById("dialogOverlay").classList.add("show");
});
document.getElementById("dialogCancel").addEventListener("click", () => {
  document.getElementById("dialogOverlay").classList.remove("show");
});
document.getElementById("dialogConfirm").addEventListener("click", async () => {
  document.getElementById("dialogOverlay").classList.remove("show");
  await saveConfig();
  await doReboot();
});
window.addEventListener("beforeunload", (e) => {
  if (changed) {
    e.preventDefault();
    e.returnValue = "";
  }
});

document.getElementById('btnAdd').addEventListener('click', openAddDialog);
document.getElementById('addClose').addEventListener('click', () => {
  document.getElementById('addOverlay').classList.remove('show');
});
document.getElementById('addCancel').addEventListener('click', () => {
  document.getElementById('addOverlay').classList.remove('show');
});
document.getElementById('addConfirm').addEventListener('click', confirmAddApps);
let addSearchTimer = null;
document.getElementById('addSearch').addEventListener('input', (e) => {
  addSearchQuery = e.target.value.trim().toLowerCase();
  if (addSearchTimer) clearTimeout(addSearchTimer);
  addSearchTimer = setTimeout(() => renderAddList(), 300);
});

// Settings
function loadSettings() {
  const savedLog = localStorage.getItem('logEnabled');
  logEnabled = savedLog === 'true';
  const toggleLog = document.getElementById('toggleLog');
  if (toggleLog) {
    toggleLog.classList.toggle('on', logEnabled);
    toggleLog.setAttribute('aria-checked', logEnabled);
  }

  const savedAddApp = localStorage.getItem('addAppEnabled');
  addAppEnabled = savedAddApp === 'true';
  const toggleAddApp = document.getElementById('toggleAddApp');
  if (toggleAddApp) {
    toggleAddApp.classList.toggle('on', addAppEnabled);
    toggleAddApp.setAttribute('aria-checked', addAppEnabled);
  }
  document.getElementById('addAppRow').style.display = addAppEnabled ? '' : 'none';
  syncLogFlag();
}

document.getElementById('btnSettings').addEventListener('click', () => {
  document.getElementById('settingsOverlay').classList.add('show');
});
document.getElementById('settingsClose').addEventListener('click', () => {
  document.getElementById('settingsOverlay').classList.remove('show');
});
document.getElementById('toggleLog').addEventListener('click', function() {
  logEnabled = !logEnabled;
  this.classList.toggle('on');
  this.setAttribute('aria-checked', logEnabled);
  localStorage.setItem('logEnabled', logEnabled);
  syncLogFlag();
  toast(logEnabled ? '日志已开启' : '日志已关闭');
});
document.getElementById('toggleAddApp').addEventListener('click', async function() {
  if (!addAppEnabled) {
    const confirmed = await showConfirmDialog("dangerOverlay", {
      appName: "⚠️ 免责声明",
      desc: "开启此功能后，您可以添加系统应用进行精简。\n\n⚠️ 风险提示：\n1. 添加的应用将优先采用开机遮蔽方式精简，遮蔽错误的关键应用可能导致无法开机\n2. 精简错误的应用可能导致系统不稳定\n3. 建议先备份数据\n4. 操作风险由您自行承担",
      confirmText: "确认开启"
    });
    if (!confirmed) return;
  }
  addAppEnabled = !addAppEnabled;
  this.classList.toggle('on');
  this.setAttribute('aria-checked', addAppEnabled);
  localStorage.setItem('addAppEnabled', addAppEnabled);
  document.getElementById('addAppRow').style.display = addAppEnabled ? '' : 'none';
  toast(addAppEnabled ? '自定义精简应用已开启' : '自定义精简应用已关闭');
});

initSearch();
syncVersion();
loadSettings();
loadConfig();
