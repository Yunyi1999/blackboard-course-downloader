// Blackboard API 层：所有请求都在已登录的 Blackboard 标签页里发出（同源、自动带登录态），
// 逻辑对应原来的 bb_grab.py / bb_embedded.py。

import { t } from "./i18n.js";

const API_INTERNAL = "/learn/api/v1";
const API_PUBLIC = "/learn/api/public/v1";

const FOLDER_HANDLERS = new Set([
  "resource/x-bb-folder",
  "resource/x-bb-lesson",
  "resource/x-bb-learningmodule",
]);

const NAME_KEYS = ["fileName", "linkName", "displayName", "alternativeText"];

export class AuthError extends Error {
  constructor() { super(t("errAuth")); this.name = "AuthError"; }
}
export class TabError extends Error {
  constructor(msg) { super(msg || t("errTab")); this.name = "TabError"; }
}
export class AbortedError extends Error {
  constructor() { super(t("abort")); this.name = "AbortedError"; }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 在页面里执行的函数（会被序列化注入，不能引用外部变量）
async function pageFetch(url) {
  try {
    const r = await fetch(url, { credentials: "include", headers: { Accept: "application/json" } });
    let data = null;
    const ct = r.headers.get("content-type") || "";
    if (r.ok && ct.includes("json")) {
      try { data = await r.json(); } catch (e) { data = null; }
    }
    return { status: r.status, data, finalUrl: r.url, json: ct.includes("json") };
  } catch (e) {
    return { status: 0, error: String(e) };
  }
}

// 在页面里跟随跳转，拿到文件服务器上的最终（已签名）地址，只读响应头就中止
async function pageResolve(url) {
  const ac = new AbortController();
  try {
    const r = await fetch(url, { credentials: "include", signal: ac.signal });
    const res = { status: r.status, url: r.url, type: r.headers.get("content-type") || "" };
    ac.abort();
    return res;
  } catch (e) {
    return { status: 0, error: String(e) };
  }
}

export class Blackboard {
  constructor({ tabId, origin, delay = 300, signal = null }) {
    this.tabId = tabId;
    this.origin = origin;
    this.delay = delay;
    this.signal = signal;
    this.calls = 0;
  }

  async get(path) {
    if (this.signal && this.signal.aborted) throw new AbortedError();
    if (this.calls++ > 0) await sleep(this.delay);
    let results;
    try {
      results = await chrome.scripting.executeScript({
        target: { tabId: this.tabId },
        func: pageFetch,
        // Ultra 页面带 <base href="...cloudfront.net">，相对路径会被解析到 CDN 上导致跨域失败，必须用完整地址
        args: [/^https?:\/\//i.test(path) ? path : this.origin + path],
      });
    } catch (e) {
      throw new TabError(t("errTab") + ": " + e.message);
    }
    const out = results && results[0] && results[0].result;
    if (!out) throw new TabError();
    if (out.status === 0) throw new Error(t("errNet") + ": " + out.error);
    if (out.status === 401) throw new AuthError();
    // 会话失效时有时会被重定向到登录页（200 + HTML）
    if (out.status === 200 && !out.json) {
      if (/login|auth|sso|saml/i.test(out.finalUrl || "")) throw new AuthError();
      return null;
    }
    // 400 = 该类型条目不能有附件；403/404 = 无权限或不存在。都视作“跳过”
    if ([400, 403, 404].includes(out.status)) return null;
    if (out.status >= 300) throw new Error(t("errHttp", { s: out.status }) + ": " + path);
    return out.data;
  }

  async paged(path) {
    const all = [];
    let next = path;
    let guard = 0;
    while (next && guard++ < 50) {
      const data = await this.get(next);
      if (!data) break;
      all.push(...(data.results || []));
      next = data.paging && data.paging.nextPage;
    }
    return all;
  }

  async myCourses() {
    // expand=course 一次拿到全部课程名，不用每门课单独请求
    const memberships = await this.paged(`${API_PUBLIC}/users/me/courses?expand=course`);
    const now = Date.now();
    const courses = [];
    for (const m of memberships) {
      const cid = m.courseId;
      if (!cid) continue;
      const c = m.course || (await this.get(`${API_PUBLIC}/courses/${cid}`)) || {};
      const av = c.availability || {};
      if (av.available === "No") continue;
      const dur = av.duration || {};
      const start = dur.start ? Date.parse(dur.start) : null;
      const end = dur.end ? Date.parse(dur.end) : null;
      // 0 = 本学期进行中，1 = 无固定日期，2 = 未开始，3 = 已结束
      const rank = start && end ? (now < start ? 2 : now > end ? 3 : 0) : 1;
      courses.push({ id: cid, name: c.name || c.courseId || cid, code: c.courseId || "", rank, end: end || 0 });
    }
    courses.sort((a, b) => a.rank - b.rank || b.end - a.end || a.name.localeCompare(b.name));
    return courses;
  }

  async courseInfo(cid) {
    const c = (await this.get(`${API_PUBLIC}/courses/${cid}`)) || {};
    return { id: cid, name: c.name || c.courseId || cid, code: c.courseId || "" };
  }

  async resolve(url) {
    let results;
    try {
      results = await chrome.scripting.executeScript({ target: { tabId: this.tabId }, func: pageResolve, args: [url] });
    } catch (e) {
      throw new TabError(t("errTab") + ": " + e.message);
    }
    const out = results && results[0] && results[0].result;
    if (!out) throw new TabError();
    return out;
  }

  rootContents(cid) { return this.paged(`${API_INTERNAL}/courses/${cid}/contents`); }
  children(cid, id) { return this.paged(`${API_INTERNAL}/courses/${cid}/contents/${id}/children`); }
  item(cid, id) { return this.get(`${API_INTERNAL}/courses/${cid}/contents/${id}`); }
  async attachments(cid, id) {
    const d = await this.get(`${API_PUBLIC}/courses/${cid}/contents/${id}/attachments`);
    return (d && d.results) || [];
  }
}

// ---------- 工具函数 ----------

export function handlerId(item) {
  const h = item.contentHandler;
  if (h && typeof h === "object") return h.id || "";
  return h || "";
}

const decoder = typeof document !== "undefined" ? document.createElement("textarea") : null;
function unescapeHtml(s) {
  if (!decoder) return s;
  decoder.innerHTML = s;
  return decoder.value;
}

// 从 Ultra 文档正文 HTML 里提取 bbcswebdav 文件链接和真实文件名
export function extractEmbeddedLinks(bodyHtml, origin) {
  const found = [];
  if (!bodyHtml) return found;
  const doc = new DOMParser().parseFromString(bodyHtml, "text/html");
  for (const a of doc.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href") || "";
    if (!/bbcswebdav/i.test(href)) continue;
    let url;
    try { url = new URL(href, origin).href; } catch (e) { continue; }

    let filename = null;
    const raw = a.getAttribute("data-bbfile");
    if (raw) {
      let obj = null;
      try { obj = JSON.parse(raw); } catch (e) {
        try { obj = JSON.parse(unescapeHtml(raw)); } catch (e2) { obj = null; }
      }
      if (obj && typeof obj === "object") {
        for (const k of NAME_KEYS) if (obj[k]) { filename = String(obj[k]); break; }
      } else {
        for (const k of NAME_KEYS) {
          const m = raw.match(new RegExp('\\\\?"' + k + '\\\\?":\\s*\\\\?"([^"\\\\]+)'));
          if (m) { filename = m[1]; break; }
        }
      }
    }
    if (!filename) {
      const text = (a.textContent || "").trim();
      if (text && text.includes(".")) filename = text;
    }
    if (!filename) {
      const seg = decodeURIComponent(new URL(url).pathname.replace(/\/+$/, "").split("/").pop() || "");
      filename = seg || "file.pdf";
      if (!filename.includes(".")) filename += ".pdf";
    }
    found.push({ url, name: filename });
  }
  return found;
}

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
export function safeName(name, maxlen = 120) {
  let n = String(name == null ? "" : name)
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f~]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, "");
  if (n.length > maxlen) {
    const dot = n.lastIndexOf(".");
    const ext = dot > 0 && n.length - dot <= 8 ? n.slice(dot) : "";
    n = n.slice(0, maxlen - ext.length).trim() + ext;
  }
  if (!n) n = "untitled";
  if (RESERVED.test(n)) n = "_" + n;
  return n;
}

export function extOf(name) {
  const m = /\.([a-z0-9]{1,6})$/i.exec(name || "");
  return m ? m[1].toLowerCase() : "";
}

// ---------- 扫描 ----------
// 树结构：folder = {type:'folder', id, title, children:[]}；file = {type:'file', key, name, url, kind, source}

export async function scanCourse(bb, courseId, { startId = null, scanSelf = true, onProgress = () => {} } = {}) {
  const origin = bb.origin;
  const seen = new Set();
  const stats = { nodes: 0, files: 0, current: "" };

  const addFiles = (folder, item) => {
    return async () => {
      const cid = item.id;
      const handler = handlerId(item);
      const source = item.title || cid;
      if (!FOLDER_HANDLERS.has(handler)) {
        const atts = await bb.attachments(courseId, cid);
        for (const att of atts) {
          const url = `${origin}${API_PUBLIC}/courses/${courseId}/contents/${cid}/attachments/${att.id}/download`;
          if (seen.has(url)) continue;
          seen.add(url);
          folder.children.push({ type: "file", key: url, url, name: att.fileName || `${cid}.bin`, kind: "attachment", source, mime: att.mimeType || "" });
          stats.files++;
        }
      }
      const body = item.body && typeof item.body === "object" ? item.body.rawText : typeof item.body === "string" ? item.body : "";
      for (const { url, name } of extractEmbeddedLinks(body || "", origin)) {
        if (seen.has(url)) continue;
        seen.add(url);
        folder.children.push({ type: "file", key: url, url, name, kind: "embedded", source });
        stats.files++;
      }
    };
  };

  async function walk(folder, parentId) {
    const items = parentId == null ? await bb.rootContents(courseId) : await bb.children(courseId, parentId);
    for (const item of items) {
      stats.nodes++;
      stats.current = item.title || item.id;
      onProgress({ ...stats });
      await addFiles(folder, item)();
      const isFolder = FOLDER_HANDLERS.has(handlerId(item)) || item.hasChildren;
      if (isFolder) {
        const sub = { type: "folder", id: item.id, title: item.title || item.id, children: [] };
        folder.children.push(sub);
        await walk(sub, item.id);
      }
    }
  }

  const root = { type: "folder", id: startId || "root", title: "", children: [] };
  if (startId && scanSelf) {
    const self = await bb.item(courseId, startId);
    if (self) {
      root.title = self.title || startId;
      await addFiles(root, self)();
    }
  }
  await walk(root, startId);
  onProgress({ ...stats, current: "" });
  return { root, stats };
}

// 把树拍平成 [{file, trail:[folder titles]}]
export function flatten(node, trail = [], out = []) {
  for (const c of node.children) {
    if (c.type === "file") out.push({ file: c, trail });
    else flatten(c, [...trail, c.title], out);
  }
  return out;
}
