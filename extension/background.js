// 点击工具栏图标：支持侧边栏的浏览器打开侧边栏，否则在新标签页打开同一个界面
if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
} else {
  chrome.action.onClicked.addListener(() => {
    chrome.tabs.create({ url: chrome.runtime.getURL("panel.html") });
  });
}
