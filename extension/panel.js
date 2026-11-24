import { Blackboard, AuthError, AbortedError, scanCourse, flatten, safeName, extOf, sleep } from "./bb.js";
import { t, setLang, resolveLang, applyStatic } from "./i18n.js";
import { idbGet, idbSet, idbDel } from "./idb.js";

const $ = (id) => document.getElementById(id);

const DEFAULT_SETTINGS = {
  rootDir: "Blackboard", delay: 300, courseDir: true, keepTree: true, skipExisting: true,
  locMode: "dl", lang: "auto",
};

const CATS = [
  { id: "pdf", label: "catPdf", exts: ["pdf"] },
  { id: "slides", label: "catSlides", exts: ["ppt", "pptx", "key", "odp", "pps", "ppsx"] },
  { id: "doc", label: "catDoc", exts: ["doc", "docx", "txt", "rtf", "pages", "odt", "md"] },
  { id: "sheet", label: "catSheet", exts: ["xls", "xlsx", "csv", "numbers", "ods"] },
  { id: "image", label: "catImage", exts: ["jpg", "jpeg", "png", "gif", "tif", "tiff", "exr", "psd", "heic", "webp", "svg", "bmp", "hdr"] },
  { id: "video", label: "catVideo", exts: ["mp4", "mov", "avi", "mkv", "m4v", "webm", "wmv"] },
  { id: "archive", label: "catArchive", exts: ["zip", "rar", "7z", "tar", "gz"] },
  { id: "other", label: "catOther", exts: [] },
];
const EXT_CAT = {};
for (const c of CATS) for (const e of c.exts) EXT_CAT[e] = c.id;
const catOf = (name) => EXT_CAT[extOf(name)] || "other";

const state = {
  settings: { ...DEFAULT_SETTINGS },
  tab: null,
  origin: null,
  conn: "checking", // checking | ok | none | auth
  detectedCourse: null,
  courses: [],
  courseId: null,
  root: null,
  scannedAt: null,
  selected: new Set(),
  status: new Map(),
  existing: new Set(),
  types: new Set(CATS.map((c) => c.id)),
  q: "",
  collapsed: new Set(),
  busy: null, // 'scan' | 'download' | 'courses'
  abort: null,
  currentDownload: null,
  loc: { mode: "dl", scope: "default", handle: null, perm: "granted" },
  defaultHandle: null,
};

// ---------------- 存储 ----------------
const store = {
  get: (k) => chrome.storage.local.get(k).then((r) => r[k]),
  set: (k, v) => chrome.storage.local.set({ [k]: v }),
};

async function loadSettings() {
  const s = await store.get("settings");
  state.settings = { ...DEFAULT_SETTINGS, ...(s || {}) };
  const types = await store.get("types");
  if (Array.isArray(types) && types.length) state.types = new Set(types);
  setLang(resolveLang(state.settings.lang));
  fillSettingsForm();
}

function fillSettingsForm() {
  const s = state.settings;
  $("setRoot").value = s.rootDir;
  $("setDelay").value = s.delay;
  $("setCourseDir").checked = s.courseDir;
  $("setKeepTree").checked = s.keepTree;
  $("setSkip").checked = s.skipExisting;
  $("setLang").value = s.lang;
  $("locDl").setAttribute("aria-checked", String(s.locMode !== "fs"));
  $("locFs").setAttribute("aria-checked", String(s.locMode === "fs"));
  $("locDlBox").hidden = s.locMode === "fs";
  $("locFsBox").hidden = s.locMode !== "fs";
  $("defaultFolderName").textContent = state.defaultHandle ? state.defaultHandle.name : "—";
}

async function saveSettings() {
  const s = state.settings;
  s.rootDir = $("setRoot").value.trim();
  s.delay = Math.max(100, Math.min(3000, Number($("setDelay").value) || 300));
  s.courseDir = $("setCourseDir").checked;
  s.keepTree = $("setKeepTree").checked;
  s.skipExisting = $("setSkip").checked;
  const lang = $("setLang").value;
  const langChanged = lang !== s.lang;
  s.lang = lang;
  await store.set("settings", s);
  if (langChanged) relabel();
  await refreshLocation();
}

function relabel() {
  setLang(resolveLang(state.settings.lang));
  applyStatic();
  fillSettingsForm();
  renderConn();
  renderCourseSelect();
  setBusyUI();
  renderLocation();
  renderSummary();
  render();
}

// ---------------- 日志 / 提示 ----------------
function log(msg) {
  const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
  const el = $("log");
  el.textContent += `[${time}] ${msg}\n`;
  el.scrollTop = el.scrollHeight;
}
function showError(msg) {
  $("errorBox").textContent = msg || "";
  $("errorBox").hidden = !msg;
}

// ---------------- 连接 Blackboard 标签页 ----------------
const isBB = (url) => {
  try { const u = new URL(url); return u.protocol === "https:" && /(^|\.)blackboard\.com$/i.test(u.hostname); }
  catch (e) { return false; }
};
const courseFromUrl = (url) => {
  const m = /(?:\/courses\/|course_id=)(_\d+_\d+)/.exec(url || "");
  return m ? m[1] : null;
};

async function findBBTab() {
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active && active.url && isBB(active.url)) return active;
  const all = await chrome.tabs.query({ url: "https://*.blackboard.com/*" });
  all.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return all[0] || null;
}

let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshConnection, 250);
}

function renderConn() {
  const conn = $("conn");
  const map = { ok: "conn ok", auth: "conn bad", none: "conn bad", checking: "conn" };
  conn.className = map[state.conn];
  $("connText").textContent =
    state.conn === "ok" ? new URL(state.tab.url).hostname :
    state.conn === "auth" ? t("needLogin") :
    state.conn === "none" ? t("notConnected") : t("checking");
  conn.title = state.tab ? t("usingTab", { title: state.tab.title || "" }) : "";
}

async function refreshConnection() {
  const tab = await findBBTab();
  if (!tab) {
    if (state.busy) return;
    state.tab = null;
    state.conn = "none";
    renderConn();
    $("openBB").hidden = !(await store.get("lastOrigin"));
    $("noTab").hidden = false;
    $("app").hidden = true;
    $("footer").hidden = true;
    return;
  }
  const origin = new URL(tab.url).origin;
  const originChanged = origin !== state.origin;
  state.tab = tab;
  state.origin = origin;
  if (originChanged) store.set("lastOrigin", origin);
  if (state.conn !== "auth") state.conn = "ok";
  renderConn();
  $("noTab").hidden = true;
  $("app").hidden = false;

  if (originChanged) {
    state.courses = (await store.get(`courses:${origin}`)) || [];
    renderCourseSelect();
    if (!state.courses.length) loadCourses();
  }

  const detected = courseFromUrl(tab.url);
  if (detected && detected !== state.detectedCourse) {
    state.detectedCourse = detected;
    if (!state.busy) {
      if (!state.courses.find((c) => c.id === detected)) {
        state.courses.unshift({ id: detected, name: detected, code: "" });
        fillCourseName(detected);
      }
      renderCourseSelect();
      selectCourse(detected);
    }
  } else if (!state.courseId && state.courses.length && !state.busy) {
    selectCourse(state.courses[0].id);
  }
}

function makeBB(signal) {
  return new Blackboard({ tabId: state.tab.id, origin: state.origin, delay: state.settings.delay, signal });
}

async function fillCourseName(cid) {
  try {
    const info = await makeBB().courseInfo(cid);
    const c = state.courses.find((x) => x.id === cid);
    if (c) { Object.assign(c, info); renderCourseSelect(); renderLocation(); store.set(`courses:${state.origin}`, state.courses); }
  } catch (e) { /* 拿不到名字就先显示 ID */ }
}

async function loadCourses() {
  if (state.busy || !state.tab) return;
  state.busy = "courses";
  $("reloadCourses").classList.add("spin");
  showError("");
  try {
    log(t("logLoadingCourses"));
    const list = await makeBB().myCourses();
    const detected = state.detectedCourse;
    if (detected && !list.find((c) => c.id === detected)) list.unshift(await makeBB().courseInfo(detected));
    state.courses = list;
    state.conn = "ok";
    renderConn();
    await store.set(`courses:${state.origin}`, list);
    renderCourseSelect();
    log(t("logCourses", { n: list.length }));
    state.busy = null;
    if (!state.courseId || !list.find((c) => c.id === state.courseId)) {
      await selectCourse(detected && list.find((c) => c.id === detected) ? detected : list[0] && list[0].id);
    } else {
      renderLocation();
    }
  } catch (e) {
    handleError(e);
  } finally {
    state.busy = null;
    $("reloadCourses").classList.remove("spin");
  }
}

function courseName(cid = state.courseId) {
  const c = state.courses.find((x) => x.id === cid);
  return c ? c.name : cid || "";
}

function renderCourseSelect() {
  const sel = $("courseSel");
  sel.innerHTML = "";
  if (!state.courses.length) {
    const o = document.createElement("option");
    o.textContent = t("loadingCourses");
    o.value = "";
    sel.append(o);
    return;
  }
  for (const c of state.courses) {
    const o = document.createElement("option");
    o.value = c.id;
    o.textContent = (c.id === state.detectedCourse ? "● " : "") + c.name + ({ 2: t("notStarted"), 3: t("ended") }[c.rank] || "");
    o.title = `${c.code || ""} ${c.id}`.trim();
    sel.append(o);
  }
  if (state.courseId) sel.value = state.courseId;
}

async function selectCourse(cid) {
  if (!cid) return;
  state.courseId = cid;
  $("courseSel").value = cid;
  state.status.clear();
  state.collapsed.clear();
  const cache = await store.get(`scan:${state.origin}:${cid}`);
  state.root = cache && cache.root ? cache.root : null;
  state.scannedAt = cache && cache.root ? cache.scannedAt : null;
  await refreshLocation({ resetSelection: true });
}

// ---------------- 保存位置 ----------------
const courseKey = (cid = state.courseId) => `course:${state.origin}:${cid}`;

async function refreshLocation({ resetSelection = false } = {}) {
  state.defaultHandle = (await idbGet("default").catch(() => null)) || null;
  const courseHandle = state.courseId ? (await idbGet(courseKey()).catch(() => null)) || null : null;
  let loc;
  if (courseHandle) loc = { mode: "fs", scope: "course", handle: courseHandle };
  else if (state.settings.locMode === "fs" && state.defaultHandle) loc = { mode: "fs", scope: "default", handle: state.defaultHandle };
  else loc = { mode: "dl", scope: "default", handle: null };
  loc.perm = loc.handle ? await loc.handle.queryPermission({ mode: "readwrite" }).catch(() => "prompt") : "granted";
  state.loc = loc;
  fillSettingsForm();
  renderLocation();
  await refreshExisting(resetSelection);
}

function renderLocation() {
  const { loc, settings } = state;
  const el = $("locPath");
  el.innerHTML = "";
  const parts = [];
  if (loc.mode === "dl") {
    parts.push(t("browserDownloads"));
    if (settings.rootDir) parts.push(settings.rootDir);
  } else {
    parts.push(loc.handle.name);
  }
  if (loc.scope === "default" && settings.courseDir && state.courseId) parts.push(courseName());
  el.append(document.createTextNode(parts.join(" › ")));
  const tag = document.createElement("span");
  tag.className = "tag";
  tag.textContent = loc.scope === "course" ? t("courseFolderTag") : t("defaultTag");
  el.append(tag);
  $("locRow").title = parts.join(" › ");
  $("clearCourse").hidden = loc.scope !== "course";
  $("locWarn").hidden = !(loc.handle && loc.perm !== "granted");
  $("locWarn").textContent = t("needPermission");
}

async function pickFolder(key) {
  if (!window.showDirectoryPicker) return openPickWindow(key);
  try {
    const handle = await window.showDirectoryPicker({ id: "bbdl", mode: "readwrite" });
    await idbSet(key, handle);
    await afterPicked(key);
    return true;
  } catch (e) {
    if (e.name === "AbortError") return false;
    return openPickWindow(key);
  }
}

function openPickWindow(key) {
  chrome.windows.create({
    url: chrome.runtime.getURL("pick.html?key=" + encodeURIComponent(key)),
    type: "popup", width: 440, height: 280,
  });
  log(t("pickerFallback"));
  return false;
}

async function afterPicked(key) {
  if (key === "default") {
    state.settings.locMode = "fs";
    await store.set("settings", state.settings);
  }
  await refreshLocation();
}

// ---------------- 扫描 ----------------
async function startScan(folder = null) {
  if (state.busy || !state.tab) return;
  const cid = state.courseId;
  state.busy = "scan";
  state.abort = new AbortController();
  showError("");
  setBusyUI();
  $("scanProgress").hidden = false;
  log(t("logScanStart", { what: folder ? `“${folder.title}”` : t("logWholeCourse") }));
  try {
    const bb = makeBB(state.abort.signal);
    const { root, stats } = await scanCourse(bb, cid, {
      startId: folder ? folder.id : null,
      scanSelf: !folder,
      onProgress: (s) => {
        $("scanText").textContent = t("scanProgress", s) + (s.current ? " · " + s.current : "");
      },
    });
    if (folder) folder.children = root.children;
    else state.root = root;
    state.scannedAt = Date.now();
    await store.set(`scan:${state.origin}:${cid}`, { root: state.root, scannedAt: state.scannedAt, name: courseName(cid) });
    log(t("logScanDone", stats));
    state.conn = "ok";
    renderConn();
    await refreshExisting(true);
  } catch (e) {
    handleError(e);
  } finally {
    state.busy = null;
    state.abort = null;
    $("scanProgress").hidden = true;
    setBusyUI();
    render();
  }
}

// ---------------- 路径与“已下载”检测 ----------------
function pathParts(file, trail) {
  const { settings, loc } = state;
  const dirs = [];
  if (loc.mode === "dl" && settings.rootDir) dirs.push(...settings.rootDir.split(/[\\/]+/).filter(Boolean));
  if (loc.scope === "default" && settings.courseDir) dirs.push(courseName());
  if (settings.keepTree) dirs.push(...trail);
  return { dirs: dirs.map((d) => safeName(d)), name: safeName(file.name, 150) };
}
function displayPath(file, trail) {
  const { dirs, name } = pathParts(file, trail);
  const head = state.loc.mode === "dl" ? t("browserDownloads") : state.loc.handle.name;
  return [head, ...dirs, name].join("/");
}

async function fsExists(root, dirs, name, cache) {
  try {
    let d = root;
    let key = "";
    for (const p of dirs) {
      key += "/" + p;
      if (!cache.has(key)) cache.set(key, d.getDirectoryHandle(p).catch(() => null));
      d = await cache.get(key);
      if (!d) return false;
    }
    const f = await (await d.getFileHandle(name)).getFile();
    return f.size > 0;
  } catch (e) {
    return false;
  }
}

async function refreshExisting(resetSelection = false) {
  state.existing = new Set();
  if (!state.root) { render(); return; }
  const items = flatten(state.root);
  const { loc } = state;
  try {
    if (loc.mode === "dl") {
      const all = await chrome.downloads.search({ exists: true, state: "complete", limit: 0 });
      const paths = all.map((d) => (d.filename || "").replace(/\\/g, "/").toLowerCase());
      for (const { file, trail } of items) {
        const { dirs, name } = pathParts(file, trail);
        const rel = "/" + [...dirs, name].join("/").toLowerCase();
        if (paths.some((p) => p.endsWith(rel))) state.existing.add(file.key);
      }
    } else if (loc.perm === "granted") {
      const cache = new Map();
      for (const { file, trail } of items) {
        const { dirs, name } = pathParts(file, trail);
        if (await fsExists(loc.handle, dirs, name, cache)) state.existing.add(file.key);
      }
    }
  } catch (e) { /* 检测失败不影响使用 */ }
  if (resetSelection) {
    state.selected = new Set(items.filter(({ file }) => !state.existing.has(file.key)).map(({ file }) => file.key));
  }
  render();
}

// ---------------- 渲染 ----------------
const visible = (f) => state.types.has(catOf(f.name)) && (!state.q || f.name.toLowerCase().includes(state.q));

function visibleFiles(node, out = []) {
  for (const c of node.children) {
    if (c.type === "file") { if (visible(c)) out.push(c); }
    else visibleFiles(c, out);
  }
  return out;
}

function ago(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return t("justNow");
  if (s < 3600) return t("minAgo", { n: Math.floor(s / 60) });
  if (s < 86400) return t("hourAgo", { n: Math.floor(s / 3600) });
  return t("dayAgo", { n: Math.floor(s / 86400) });
}

function render() {
  $("scanMeta").textContent = state.scannedAt ? t("lastScan", { t: ago(state.scannedAt) }) : "";
  $("results").hidden = !state.root;
  $("footer").hidden = !state.root || !state.tab;
  setBusyUI();
  if (!state.root) return;
  renderChips();
  renderTree();
  updateCount();
}

function renderChips() {
  const counts = {};
  for (const { file } of flatten(state.root)) counts[catOf(file.name)] = (counts[catOf(file.name)] || 0) + 1;
  const box = $("chips");
  box.innerHTML = "";
  for (const c of CATS) {
    if (!counts[c.id]) continue;
    const b = document.createElement("button");
    b.className = "chip" + (state.types.has(c.id) ? " on" : "");
    b.dataset.cat = c.id;
    b.textContent = t(c.label);
    const n = document.createElement("b");
    n.textContent = counts[c.id];
    b.append(n);
    b.onclick = () => {
      state.types.has(c.id) ? state.types.delete(c.id) : state.types.add(c.id);
      store.set("types", [...state.types]);
      render();
    };
    box.append(b);
  }
}

const CARET = '<svg viewBox="0 0 10 10" width="10" height="10"><path fill="currentColor" d="M1 3h8L5 8z"/></svg>';

function renderTree() {
  const tree = $("tree");
  const scroll = tree.parentElement.scrollTop;
  tree.innerHTML = "";
  const top = buildChildren(state.root, [], 0);
  if (!top.childElementCount) {
    const n = document.createElement("div");
    n.className = "notice";
    n.textContent = flatten(state.root).length ? t("noMatch") : t("noFiles");
    tree.append(n);
  } else {
    tree.append(top);
  }
  tree.parentElement.scrollTop = scroll;
}

function buildChildren(node, trail, depth) {
  const frag = document.createElement("div");
  frag.className = "kids";
  for (const f of node.children.filter((c) => c.type === "folder")) {
    const el = buildFolder(f, [...trail, f.title], depth);
    if (el) frag.append(el);
  }
  for (const f of node.children.filter((c) => c.type === "file" && visible(c))) frag.append(buildFile(f, trail, depth));
  return frag;
}

function buildFolder(folder, trail, depth) {
  const files = visibleFiles(folder);
  if (!files.length) return null;
  const wrap = document.createElement("div");
  wrap.className = "folder" + (state.collapsed.has(folder.id) ? " collapsed" : "");
  const row = document.createElement("div");
  row.className = "node";
  row.style.paddingLeft = 6 + depth * 16 + "px";

  const caret = document.createElement("button");
  caret.className = "caret";
  caret.innerHTML = CARET;
  const toggle = () => {
    state.collapsed.has(folder.id) ? state.collapsed.delete(folder.id) : state.collapsed.add(folder.id);
    wrap.classList.toggle("collapsed");
  };
  caret.onclick = toggle;

  const cb = document.createElement("input");
  cb.type = "checkbox";
  const n = files.filter((f) => state.selected.has(f.key)).length;
  cb.checked = n === files.length;
  cb.indeterminate = n > 0 && n < files.length;
  cb.onchange = () => {
    const allOn = n === files.length;
    for (const f of files) allOn ? state.selected.delete(f.key) : state.selected.add(f.key);
    renderTree();
    updateCount();
  };

  const name = document.createElement("span");
  name.className = "fname";
  name.textContent = folder.title;
  name.title = folder.title;
  name.onclick = toggle;

  const count = document.createElement("span");
  count.className = "fcount";
  count.textContent = files.length;

  const re = document.createElement("button");
  re.className = "link rescan";
  re.textContent = t("rescan");
  re.title = t("rescanTip");
  re.disabled = !!state.busy;
  re.onclick = () => startScan(folder);

  row.append(caret, cb, name, count, re);
  wrap.append(row, buildChildren(folder, trail, depth + 1));
  return wrap;
}

function buildFile(file, trail, depth) {
  const row = document.createElement("label");
  row.className = "node";
  row.style.paddingLeft = 6 + depth * 16 + 22 + "px";

  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = state.selected.has(file.key);
  cb.onchange = () => {
    cb.checked ? state.selected.add(file.key) : state.selected.delete(file.key);
    renderTree();
    updateCount();
  };

  const ext = document.createElement("span");
  ext.className = "ext " + catOf(file.name);
  ext.textContent = extOf(file.name) || "?";

  const name = document.createElement("span");
  name.className = "name";
  name.textContent = file.name;
  name.title = `${file.name}\n${t("from", { s: file.source })}\n${t("saveAs", { p: displayPath(file, trail) })}`;

  row.append(cb, ext, name);
  if (file.kind === "embedded") {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = t("embedded");
    tag.title = t("embeddedTip");
    row.append(tag);
  }

  const st = document.createElement("span");
  st.className = "st";
  const s = state.status.get(file.key);
  if (s) {
    st.classList.add(s.s);
    st.textContent = { done: "✓", skip: "✓", fail: "✕", warn: "!" }[s.s] || "";
    st.title = s.msg || "";
  } else if (state.existing.has(file.key)) {
    st.classList.add("done");
    st.textContent = "✓";
    st.title = t("downloaded");
  }
  row.append(st);
  return row;
}

function selectedItems() {
  return flatten(state.root).filter(({ file }) => state.selected.has(file.key) && visible(file));
}

function updateCount() {
  const n = state.root ? selectedItems().length : 0;
  $("selCount").textContent = t("selected", { n });
  if (state.busy !== "download") $("dlBtn").disabled = !n || !!state.busy;
}

function setBusyUI() {
  const scanning = state.busy === "scan";
  const downloading = state.busy === "download";
  $("scanBtn").textContent = scanning ? t("stopScan") : t("scan");
  $("scanBtn").className = "btn grow " + (scanning ? "danger" : "primary");
  $("scanBtn").disabled = !state.courseId || (!!state.busy && !scanning);
  $("courseSel").disabled = !!state.busy;
  $("locChange").disabled = !!state.busy;
  $("dlBtn").textContent = downloading ? t("stop") : t("download");
  $("dlBtn").className = "btn " + (downloading ? "danger" : "primary");
  if (downloading) $("dlBtn").disabled = false;
  else if (state.busy) $("dlBtn").disabled = true;
}

// ---------------- 下载 ----------------
class HtmlError extends Error {}

function human(n) {
  for (const u of ["B", "KB", "MB", "GB"]) { if (n < 1024) return n.toFixed(u === "B" ? 0 : 1) + " " + u; n /= 1024; }
  return n.toFixed(1) + " TB";
}

function httpMessage(status) {
  if (status === 401) return t("errAuth");
  if (status === 403) return t("SERVER_FORBIDDEN");
  if (status === 404) return t("SERVER_BAD_CONTENT");
  return t("errHttp", { s: status });
}

// 先在扩展里直接取；拿不到（没带上登录态等）就让 Blackboard 页面帮忙解析出文件服务器上的最终地址再取
async function fetchFile(bb, file, signal) {
  const allowHtml = /^html?$/.test(extOf(file.name));
  const good = (r) => r && r.ok && (allowHtml || !/text\/html/i.test(r.headers.get("content-type") || ""));
  let r = null;
  try { r = await fetch(file.url, { credentials: "include", signal }); }
  catch (e) { if (signal.aborted) throw e; }
  if (good(r)) return r;
  if (r && r.body) r.body.cancel().catch(() => {});

  const res = await bb.resolve(file.url);
  if (res.status === 0) throw new Error(t("errNet") + ": " + (res.error || ""));
  if (res.status >= 400) throw new Error(httpMessage(res.status));
  if (!allowHtml && /text\/html/i.test(res.type)) throw new HtmlError(t("stHtml"));
  r = await fetch(res.url, { credentials: "include", signal });
  if (!r.ok) throw new Error(httpMessage(r.status));
  if (!good(r)) throw new HtmlError(t("stHtml"));
  return r;
}

async function writeToFolder(root, dirs, name, response, onBytes, signal) {
  let d = root;
  for (const p of dirs) d = await d.getDirectoryHandle(p, { create: true });
  const existed = await d.getFileHandle(name).then(() => true, () => false);
  const fh = await d.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  let n = 0;
  const counter = new TransformStream({ transform(chunk, c) { n += chunk.byteLength; onBytes(n); c.enqueue(chunk); } });
  try {
    await response.body.pipeThrough(counter).pipeTo(w, { signal });
  } catch (e) {
    await w.abort().catch(() => {});
    if (!existed) await d.removeEntry(name).catch(() => {});
    throw e;
  }
  if (n === 0) {
    if (!existed) await d.removeEntry(name).catch(() => {});
    throw new Error("empty response");
  }
  return n;
}

function waitDownload(id) {
  return new Promise((resolve) => {
    let finished = false;
    const done = async (st, err) => {
      if (finished) return;
      finished = true;
      chrome.downloads.onChanged.removeListener(listener);
      const [item] = await chrome.downloads.search({ id });
      resolve({ state: st, error: err || (item && item.error), item });
    };
    const listener = (d) => {
      if (d.id !== id || !d.state) return;
      if (d.state.current === "complete") done("complete");
      else if (d.state.current === "interrupted") done("interrupted", d.error && d.error.current);
    };
    chrome.downloads.onChanged.addListener(listener);
    chrome.downloads.search({ id }).then(([item]) => {
      if (item && item.state === "complete") done("complete");
      else if (item && item.state === "interrupted") done("interrupted", item.error);
    });
  });
}

async function downloadViaBrowser(file, trail) {
  const { dirs, name } = pathParts(file, trail);
  const id = await chrome.downloads.download({ url: file.url, filename: [...dirs, name].join("/"), conflictAction: "overwrite", saveAs: false });
  state.currentDownload = id;
  const r = await waitDownload(id);
  state.currentDownload = null;
  if (r.state === "complete") {
    const mime = (r.item && r.item.mime) || "";
    if (/text\/html/i.test(mime) && !/^html?$/.test(extOf(file.name))) throw new HtmlError(t("stHtml"));
    return (r.item && r.item.fileSize) || 0;
  }
  if (r.error === "USER_CANCELED" && state.abort.signal.aborted) throw new AbortedError();
  throw new Error(t(r.error) !== r.error ? t(r.error) : r.error || "?");
}

async function startDownload() {
  if (state.busy === "download") {
    state.abort && state.abort.abort();
    if (state.currentDownload != null) chrome.downloads.cancel(state.currentDownload).catch(() => {});
    return;
  }
  if (state.busy) return;
  const loc = state.loc;
  // 文件夹授权要在点击后立刻请求（需要用户手势）
  if (loc.mode === "fs" && loc.perm !== "granted") {
    loc.perm = await loc.handle.requestPermission({ mode: "readwrite" }).catch(() => "denied");
    renderLocation();
    if (loc.perm !== "granted") { showError(t("permDenied")); return; }
    await refreshExisting(false);
  }
  const items = selectedItems();
  if (!items.length) return;
  state.busy = "download";
  state.abort = new AbortController();
  const signal = state.abort.signal;
  setBusyUI();
  showError("");
  $("dlProgress").hidden = false;
  const bb = makeBB(signal);
  let ok = 0, skip = 0, fail = 0, i = 0;
  log(t("logDlStart", { n: items.length }));

  for (const { file, trail } of items) {
    if (signal.aborted) break;
    i++;
    $("dlBar").style.width = ((i - 1) / items.length) * 100 + "%";
    const head = `${i}/${items.length} · ${file.name}`;
    $("dlText").textContent = head;
    const shown = displayPath(file, trail);
    const { dirs, name } = pathParts(file, trail);

    let exists = state.existing.has(file.key);
    if (loc.mode === "fs") exists = await fsExists(loc.handle, dirs, name, new Map());
    if (state.settings.skipExisting && exists) {
      skip++;
      state.existing.add(file.key);
      state.status.set(file.key, { s: "skip", msg: t("stSkip") });
      log(t("logSkip", { p: shown }));
      renderTree();
      continue;
    }

    state.status.set(file.key, { s: "run" });
    renderTree();
    try {
      let size;
      if (loc.mode === "fs") {
        const resp = await fetchFile(bb, file, signal);
        size = await writeToFolder(loc.handle, dirs, name, resp, (n) => { $("dlText").textContent = `${head} · ${human(n)}`; }, signal);
      } else {
        size = await downloadViaBrowser(file, trail);
      }
      ok++;
      state.existing.add(file.key);
      state.selected.delete(file.key);
      state.status.set(file.key, { s: "done", msg: t("stDone") });
      log(t("logDone", { p: shown }) + (size ? `  (${human(size)})` : ""));
    } catch (e) {
      if (signal.aborted || e instanceof AbortedError || e.name === "AbortError") { state.status.delete(file.key); break; }
      fail++;
      if (e instanceof AuthError) { state.conn = "auth"; renderConn(); }
      if (e instanceof HtmlError) {
        state.status.set(file.key, { s: "warn", msg: e.message });
        log(t("logHtml", { p: shown }));
      } else {
        state.status.set(file.key, { s: "fail", msg: e.message });
        log(t("logFail", { p: shown, m: e.message }));
      }
    }
    renderTree();
    await sleep(state.settings.delay);
  }

  $("dlBar").style.width = "100%";
  const stopped = signal.aborted ? t("stopped") : "";
  state.lastSummary = { ok, skip, fail, aborted: signal.aborted };
  renderSummary();
  log(t("logEnd", { ok, skip, fail, stopped }));
  state.busy = null;
  state.abort = null;
  state.currentDownload = null;
  setBusyUI();
  render();
}

function renderSummary() {
  const s = state.lastSummary;
  if (!s) return;
  $("dlText").textContent = t("dlSummary", { ok: s.ok, skip: s.skip, fail: s.fail, stopped: s.aborted ? t("stopped") : "" });
}

function handleError(e) {
  if (e instanceof AbortedError) { log(t("abort")); return; }
  if (e instanceof AuthError) { state.conn = "auth"; renderConn(); }
  showError(e.message);
  log(t("errPrefix") + e.message);
}

// ---------------- 事件绑定 ----------------
function bind() {
  $("settingsBtn").onclick = () => { $("settings").hidden = !$("settings").hidden; };
  for (const id of ["setRoot", "setDelay", "setCourseDir", "setKeepTree", "setSkip", "setLang"]) $(id).addEventListener("change", saveSettings);
  $("locDl").onclick = async () => { state.settings.locMode = "dl"; await store.set("settings", state.settings); await refreshLocation(); };
  $("locFs").onclick = async () => {
    if (state.defaultHandle) { state.settings.locMode = "fs"; await store.set("settings", state.settings); await refreshLocation(); }
    else await pickFolder("default");
  };
  $("pickDefault").onclick = () => pickFolder("default");

  $("locChange").onclick = (e) => { e.stopPropagation(); $("locMenu").hidden = !$("locMenu").hidden; };
  document.addEventListener("click", (e) => { if (!$("locMenu").contains(e.target)) $("locMenu").hidden = true; });
  $("pickCourse").onclick = () => { $("locMenu").hidden = true; pickFolder(courseKey()); };
  $("clearCourse").onclick = async () => { $("locMenu").hidden = true; await idbDel(courseKey()); await refreshLocation(); };
  $("openDefault").onclick = () => { $("locMenu").hidden = true; $("settings").hidden = false; };

  $("openBB").onclick = async () => {
    const o = await store.get("lastOrigin");
    if (o) chrome.tabs.create({ url: o + "/ultra/course" });
  };
  $("reloadCourses").onclick = loadCourses;
  $("courseSel").onchange = (e) => selectCourse(e.target.value);
  $("scanBtn").onclick = () => (state.busy === "scan" ? state.abort.abort() : startScan());
  $("dlBtn").onclick = startDownload;
  $("search").addEventListener("input", (e) => { state.q = e.target.value.trim().toLowerCase(); renderTree(); updateCount(); });
  document.querySelectorAll("[data-sel]").forEach((b) => {
    b.onclick = () => {
      const files = visibleFiles(state.root);
      const mode = b.dataset.sel;
      if (mode === "none") for (const f of files) state.selected.delete(f.key);
      else for (const f of files) {
        if (mode === "all" || !state.existing.has(f.key)) state.selected.add(f.key);
        else state.selected.delete(f.key);
      }
      renderTree();
      updateCount();
    };
  });
  const allFolders = (n, out = []) => { for (const c of n.children) if (c.type === "folder") { out.push(c.id); allFolders(c, out); } return out; };
  $("expandAll").onclick = () => { state.collapsed.clear(); renderTree(); };
  $("collapseAll").onclick = () => { state.collapsed = new Set(allFolders(state.root)); renderTree(); };

  chrome.runtime.onMessage.addListener((msg) => { if (msg && msg.type === "folder-picked") afterPicked(msg.key); });
  chrome.tabs.onActivated.addListener(scheduleRefresh);
  chrome.tabs.onUpdated.addListener((id, info) => { if (info.url || info.status === "complete") scheduleRefresh(); });
  chrome.tabs.onRemoved.addListener(scheduleRefresh);
  chrome.windows.onFocusChanged.addListener(scheduleRefresh);
}

(async function init() {
  bind();
  await loadSettings();
  applyStatic();
  renderConn();
  renderCourseSelect();
  setBusyUI();
  await refreshConnection();
  setInterval(() => { if (state.scannedAt) $("scanMeta").textContent = t("lastScan", { t: ago(state.scannedAt) }); }, 30000);
})();
