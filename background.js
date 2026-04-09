let lastTabOpenDedupe = { dedupeKey: "", timestampMillis: 0 };
const tabHistoryByWindowId = new Map();
let previousTabSelectionChain = Promise.resolve();
const PDF_VIEWER_SELECTION_KEY = "pdfViewerSelectionText";
const TAB_HISTORY_LIMIT = 200;
const PREV_TAB_LOG_PREFIX = "[h2n previous-tab]";

function logPreviousTab(message, details) {
  if (details === undefined) {
    console.log(`${PREV_TAB_LOG_PREFIX} ${message}`);
    return;
  }
  console.log(`${PREV_TAB_LOG_PREFIX} ${message}`, details);
}

function pushTabIntoHistory(windowId, tabId) {
  if (typeof windowId !== "number" || typeof tabId !== "number") return;
  const history = tabHistoryByWindowId.get(windowId) || [];
  if (history[history.length - 1] !== tabId) {
    history.push(tabId);
  }
  if (history.length > TAB_HISTORY_LIMIT) {
    history.splice(0, history.length - TAB_HISTORY_LIMIT);
  }
  tabHistoryByWindowId.set(windowId, history);
}

async function activatePreviousTabByStripOrder(windowId, currentTabId) {
  const tabsInWindow = await chrome.tabs.query({ windowId });
  const ordered = tabsInWindow
    .filter(
      (tab) => typeof tab.id === "number" && typeof tab.index === "number"
    )
    .sort((a, b) => a.index - b.index);
  if (ordered.length < 2) return false;
  const currentIndex = ordered.findIndex((tab) => tab.id === currentTabId);
  if (currentIndex < 0) return false;
  const prevIndex =
    currentIndex === 0 ? ordered.length - 1 : currentIndex - 1;
  const targetTab = ordered[prevIndex];
  try {
    await chrome.tabs.update(targetTab.id, { active: true });
    return true;
  } catch {
    return false;
  }
}

async function activatePreviousTabFromHistory() {
  const [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (!activeTab?.id || typeof activeTab.windowId !== "number") return;

  const windowId = activeTab.windowId;
  const currentTabId = activeTab.id;
  const initialStored = [...(tabHistoryByWindowId.get(windowId) || [])];
  const history = [...initialStored];
  logPreviousTab("Command invoked", {
    windowId,
    currentTabId,
    historyBefore: [...history],
  });

  const tabsInWindow = await chrome.tabs.query({ windowId });
  const liveTabIds = new Set(
    tabsInWindow.map((tab) => tab?.id).filter((id) => typeof id === "number")
  );

  // Ensure current tab is represented, then walk backward.
  if (history[history.length - 1] !== currentTabId) {
    history.push(currentTabId);
  }
  while (history.length && history[history.length - 1] === currentTabId) {
    history.pop();
  }
  while (history.length && !liveTabIds.has(history[history.length - 1])) {
    const staleTabId = history.pop();
    logPreviousTab("Pruned stale tab from history", {
      windowId,
      staleTabId,
      historyNow: [...history],
    });
  }
  while (history.length) {
    const previousTabId = history[history.length - 1];
    if (typeof previousTabId !== "number") {
      history.pop();
      continue;
    }
    try {
      logPreviousTab("Trying activation (MRU)", {
        windowId,
        previousTabId,
        historyNow: [...history],
      });
      await chrome.tabs.update(previousTabId, { active: true });
      tabHistoryByWindowId.set(windowId, history);
      logPreviousTab("Activation succeeded", {
        windowId,
        previousTabId,
      });
      return;
    } catch {
      logPreviousTab("Activation failed, trying older entry", {
        windowId,
        previousTabId,
      });
      while (history.length && history[history.length - 1] === previousTabId) {
        history.pop();
      }
    }
  }

  const stripOk = await activatePreviousTabByStripOrder(
    windowId,
    currentTabId
  );
  if (stripOk) {
    logPreviousTab("Activated via tab strip fallback (left of current)", {
      windowId,
      currentTabId,
    });
    return;
  }

  tabHistoryByWindowId.set(windowId, initialStored);
  logPreviousTab("No previous tab candidate found", {
    windowId,
    restoredHistory: [...initialStored],
  });
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
  const doCreate = (index) => {
    const createProps = { url: createUrl() };
    if (typeof index === "number") {
      createProps.index = index;
    }
    chrome.tabs.create(createProps);
  };
  if (typeof insertIndex === "number") {
    doCreate(insertIndex);
    return;
  }
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs?.[0];
    const nextIndex = typeof tab?.index === "number" ? tab.index + 1 : undefined;
    doCreate(nextIndex);
  });
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

async function readPdfViewerSelectionFromStorage() {
  try {
    const stored = await chrome.storage.local.get(PDF_VIEWER_SELECTION_KEY);
    return String(stored?.[PDF_VIEWER_SELECTION_KEY] || "").trim();
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
    previousTabSelectionChain = previousTabSelectionChain
      .then(() => activatePreviousTabFromHistory())
      .catch(() => {
        // Keep the chain alive if one selection attempt fails.
      });
    await previousTabSelectionChain;
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

  let selectedText = "";
  if (isOurExtensionPage && tabUrl.endsWith("/pdf-viewer.html")) {
    selectedText = await readPdfViewerSelectionFromStorage();
  }
  if (!selectedText) {
    selectedText = await readSelectedTextFromTab(activeTab.id);
  }
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
  pushTabIntoHistory(activeInfo.windowId, activeInfo.tabId);
  logPreviousTab("Recorded activation", {
    windowId: activeInfo.windowId,
    tabId: activeInfo.tabId,
    historyNow: [...(tabHistoryByWindowId.get(activeInfo.windowId) || [])],
  });
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  if (typeof removeInfo.windowId !== "number") return;
  const history = tabHistoryByWindowId.get(removeInfo.windowId);
  if (!history?.length) return;
  const cleaned = history.filter((id) => id !== tabId);
  tabHistoryByWindowId.set(removeInfo.windowId, cleaned);
  logPreviousTab("Removed tab from history", {
    windowId: removeInfo.windowId,
    removedTabId: tabId,
    historyNow: [...cleaned],
  });
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
