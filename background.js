let lastTabOpenDedupe = { dedupeKey: "", timestampMillis: 0 };
const tabHistoryByWindowId = new Map();
const ignoredActivationByWindowId = new Map();

function pushTabIntoHistory(windowId, tabId) {
  if (typeof windowId !== "number" || typeof tabId !== "number") return;
  const history = tabHistoryByWindowId.get(windowId) || [];
  if (history[history.length - 1] !== tabId) {
    history.push(tabId);
  }
  tabHistoryByWindowId.set(windowId, history);
}

async function activatePreviousTabFromHistory() {
  const [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (!activeTab?.id || typeof activeTab.windowId !== "number") return;

  const windowId = activeTab.windowId;
  const currentTabId = activeTab.id;
  const history = tabHistoryByWindowId.get(windowId) || [];

  // Ensure current tab is represented, then walk backward.
  if (history[history.length - 1] !== currentTabId) {
    history.push(currentTabId);
  }
  while (history.length && history[history.length - 1] === currentTabId) {
    history.pop();
  }
  const previousTabId = history[history.length - 1];
  if (typeof previousTabId !== "number") {
    tabHistoryByWindowId.set(windowId, history);
    return;
  }

  ignoredActivationByWindowId.set(windowId, previousTabId);
  tabHistoryByWindowId.set(windowId, history);
  try {
    await chrome.tabs.update(previousTabId, { active: true });
  } catch {
    // Tab could have been closed; clear stale id and keep history usable.
    ignoredActivationByWindowId.delete(windowId);
    const cleaned = history.filter((tabId) => tabId !== previousTabId);
    tabHistoryByWindowId.set(windowId, cleaned);
  }
}
function openTabUnlessDuplicate(dedupeKey, createUrl, insertIndex) {
  const now = Date.now();
  if (
    lastTabOpenDedupe.dedupeKey === dedupeKey &&
    now - lastTabOpenDedupe.timestampMillis < 500
  ) {
    return;
  }
  lastTabOpenDedupe = { dedupeKey, timestampMillis: now };
  const createProps = { url: createUrl() };
  if (typeof insertIndex === "number") {
    createProps.index = insertIndex;
  }
  chrome.tabs.create(createProps);
}

function openGoogleSearchForSelection(selectedText, insertIndex) {
  openTabUnlessDuplicate(
    "google-search:" + selectedText,
    () =>
      `https://www.google.com/search?q=${encodeURIComponent(selectedText)}`,
    insertIndex
  );
}

function openGoogleTranslateRuForSelection(selectedText, insertIndex) {
  openTabUnlessDuplicate(
    "translate-ru:" + selectedText,
    () =>
      `https://translate.google.com/?sl=auto&tl=ru&text=${encodeURIComponent(selectedText)}`,
    insertIndex
  );
}

function openGoogleWhatIsSearchForSelection(selectedText, insertIndex) {
  const googleQuery = `What is ${selectedText}`;
  openTabUnlessDuplicate(
    "what-is:" + selectedText,
    () =>
      `https://www.google.com/search?q=${encodeURIComponent(googleQuery)}`,
    insertIndex
  );
}

function openGoogleEtymologySearchForSelection(selectedText, insertIndex) {
  const googleQuery = `${selectedText} etymology`;
  openTabUnlessDuplicate(
    "etymology:" + selectedText,
    () =>
      `https://www.google.com/search?q=${encodeURIComponent(googleQuery)}`,
    insertIndex
  );
}

async function closeTabsToTheRightOfActive() {
  const [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (!activeTab?.id || typeof activeTab.index !== "number") return;
  const tabsInWindow = await chrome.tabs.query({ currentWindow: true });
  const idsToRemove = tabsInWindow
    .filter(
      (t) =>
        typeof t.id === "number" &&
        typeof t.index === "number" &&
        t.index > activeTab.index
    )
    .map((t) => t.id);
  if (idsToRemove.length) {
    await chrome.tabs.remove(idsToRemove);
  }
}

async function readSelectedTextFromTab(tabId) {
  try {
    const [{ result: injectedResult }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.getSelection().toString(),
    });
    return (injectedResult || "").trim();
  } catch {
    return "";
  }
}

async function runCommand(commandName) {
  if (commandName === "close-tabs-to-the-right") {
    await closeTabsToTheRightOfActive();
    return;
  }
  if (commandName === "select-previous-tab") {
    await activatePreviousTabFromHistory();
    return;
  }
  const [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (!activeTab?.id) return;
  const tabUrl = activeTab.url || "";
  const isOurExtensionPage = tabUrl.startsWith(
    `chrome-extension://${chrome.runtime.id}/`
  );
  const isUnsupportedUrl =
    tabUrl.startsWith("chrome://") ||
    tabUrl.startsWith("edge://") ||
    tabUrl.startsWith("about:") ||
    (tabUrl.startsWith("chrome-extension://") && !isOurExtensionPage);
  if (isUnsupportedUrl) {
    return;
  }

  const selectedText = await readSelectedTextFromTab(activeTab.id);
  if (!selectedText) return;
  const insertIndex =
    typeof activeTab.index === "number" ? activeTab.index + 1 : undefined;
  if (commandName === "search-selection-google") {
    openGoogleSearchForSelection(selectedText, insertIndex);
  } else if (commandName === "search-selection-what-is") {
    openGoogleWhatIsSearchForSelection(selectedText, insertIndex);
  } else if (commandName === "search-selection-etymology") {
    openGoogleEtymologySearchForSelection(selectedText, insertIndex);
  } else if (commandName === "translate-selection-ru") {
    openGoogleTranslateRuForSelection(selectedText, insertIndex);
  }
}

chrome.commands.onCommand.addListener((commandName) => {
  runCommand(commandName);
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const ignoredTabId = ignoredActivationByWindowId.get(activeInfo.windowId);
  if (ignoredTabId === activeInfo.tabId) {
    ignoredActivationByWindowId.delete(activeInfo.windowId);
    return;
  }
  pushTabIntoHistory(activeInfo.windowId, activeInfo.tabId);
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  if (typeof removeInfo.windowId !== "number") return;
  const history = tabHistoryByWindowId.get(removeInfo.windowId);
  if (!history?.length) return;
  const cleaned = history.filter((id) => id !== tabId);
  tabHistoryByWindowId.set(removeInfo.windowId, cleaned);
  const ignoredTabId = ignoredActivationByWindowId.get(removeInfo.windowId);
  if (ignoredTabId === tabId) {
    ignoredActivationByWindowId.delete(removeInfo.windowId);
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  const viewerUrl = chrome.runtime.getURL("pdf-viewer.html");
  const insertIndex = typeof tab?.index === "number" ? tab.index + 1 : undefined;
  const createProps = { url: viewerUrl };
  if (typeof insertIndex === "number") {
    createProps.index = insertIndex;
  }
  await chrome.tabs.create(createProps);
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (typeof message?.text !== "string") return;
  const selectedText = message.text.trim();
  if (!selectedText) return;
  const insertIndex =
    typeof sender.tab?.index === "number" ? sender.tab.index + 1 : undefined;
  if (message.command === "search-selection-google") {
    openGoogleSearchForSelection(selectedText, insertIndex);
  } else if (message.command === "search-selection-what-is") {
    openGoogleWhatIsSearchForSelection(selectedText, insertIndex);
  } else if (message.command === "search-selection-etymology") {
    openGoogleEtymologySearchForSelection(selectedText, insertIndex);
  } else if (message.command === "translate-selection-ru") {
    openGoogleTranslateRuForSelection(selectedText, insertIndex);
  }
});

function ensureContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "search-selection-google",
      title: "Search selection in Google (Alt+S)",
      contexts: ["selection"],
    });
    chrome.contextMenus.create({
      id: "search-selection-what-is",
      title: "What is… (Alt+Shift+W)",
      contexts: ["selection"],
    });
    chrome.contextMenus.create({
      id: "search-selection-etymology",
      title: "Search etymology in Google (Alt+E)",
      contexts: ["selection"],
    });
    chrome.contextMenus.create({
      id: "translate-selection-ru",
      title: "Translate selection to Russian (Alt+Shift+T)",
      contexts: ["selection"],
    });
  });
}

chrome.runtime.onInstalled.addListener(ensureContextMenus);

chrome.contextMenus.onClicked.addListener((contextMenuClickInfo) => {
  const selectedText = contextMenuClickInfo.selectionText?.trim();
  if (!selectedText) return;
  const tab = contextMenuClickInfo.tab;
  const insertIndex =
    typeof tab?.index === "number" ? tab.index + 1 : undefined;
  if (contextMenuClickInfo.menuItemId === "search-selection-google") {
    openGoogleSearchForSelection(selectedText, insertIndex);
  } else if (contextMenuClickInfo.menuItemId === "search-selection-what-is") {
    openGoogleWhatIsSearchForSelection(selectedText, insertIndex);
  } else if (contextMenuClickInfo.menuItemId === "search-selection-etymology") {
    openGoogleEtymologySearchForSelection(selectedText, insertIndex);
  } else if (contextMenuClickInfo.menuItemId === "translate-selection-ru") {
    openGoogleTranslateRuForSelection(selectedText, insertIndex);
  }
});
