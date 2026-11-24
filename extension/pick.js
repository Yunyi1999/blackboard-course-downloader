// 侧边栏里无法弹出文件夹选择框时的备用小窗
import { idbSet } from "./idb.js";
import { t, setLang, resolveLang, applyStatic } from "./i18n.js";

const params = new URLSearchParams(location.search);
const key = params.get("key");

(async () => {
  const { settings } = await chrome.storage.local.get("settings");
  setLang(resolveLang(settings && settings.lang));
  applyStatic();
})();

document.getElementById("pick").onclick = async () => {
  try {
    const handle = await window.showDirectoryPicker({ id: "bbdl", mode: "readwrite" });
    await idbSet(key, handle);
    await chrome.runtime.sendMessage({ type: "folder-picked", key }).catch(() => {});
    document.getElementById("msg").textContent = t("pickDone");
    setTimeout(() => window.close(), 600);
  } catch (e) {
    if (e.name !== "AbortError") document.getElementById("msg").textContent = e.message;
  }
};
