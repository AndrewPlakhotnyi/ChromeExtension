import * as pdfjsLib from "./vendor/pdfjs/pdf.min.mjs";
import { getCustomHotkeys, isHotkeyMatch, mountShortcutsUi } from "./shortcuts-ui.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdfjs/pdf.worker.min.mjs");

const pdfFileInput = document.getElementById("pdfFileInput");
const toolbar = document.querySelector(".toolbar");
const toolbarLeft = document.querySelector(".toolbar-left");
const toolbarRight = document.querySelector(".toolbar-right");
const toolbarBookMeta = document.querySelector(".toolbar-book-meta");
const hamburgerButton = document.getElementById("hamburgerButton");
const openFileButton = document.getElementById("openFileButton");
const previousBooksButton = document.getElementById("previousBooksButton");
const openExternalButton = document.getElementById("openExternalButton");
const metadataButton = document.getElementById("metadataButton");
const contentsTabButton = document.getElementById("contentsTabButton");
const pagesTabButton = document.getElementById("pagesTabButton");
const sidePanelToggleButton = document.getElementById("sidePanelToggleButton");
const themeButton = document.getElementById("themeButton");
const pageNumberInput = document.getElementById("pageNumberInput");
const pageCountLabel = document.getElementById("pageCountLabel");
const zoomLabel = document.getElementById("zoomLabel");
const bookTitleText = document.getElementById("bookTitleText");
const bookPathCaption = document.getElementById("bookPathCaption");
const sidePanel = document.getElementById("sidePanel");
const contentsPanel = document.getElementById("contentsPanel");
const thumbnailsPanel = document.getElementById("thumbnailsPanel");
const tocList = document.getElementById("tocList");
const tocEmpty = document.getElementById("tocEmpty");
const tocSearchInput = document.getElementById("tocSearchInput");
const collapseAllTocButton = document.getElementById("collapseAllTocButton");
const thumbsList = document.getElementById("thumbsList");
const thumbsEmpty = document.getElementById("thumbsEmpty");
const viewerContainer = document.getElementById("viewerContainer");
const pagesContainer = document.getElementById("pagesContainer");
const statusText = document.getElementById("statusText");
const metadataOverlay = document.getElementById("metadataOverlay");
const metadataDialogBody = document.getElementById("metadataDialogBody");
const metadataCloseButton = document.getElementById("metadataCloseButton");
const previousBooksOverlay = document.getElementById("previousBooksOverlay");
const previousBooksList = document.getElementById("previousBooksList");
const previousBooksEmpty = document.getElementById("previousBooksEmpty");
const previousBooksCloseButton = document.getElementById("previousBooksCloseButton");
const dbSaveStatusIndicator = document.getElementById("dbSaveStatusIndicator");

const LAST_SESSION_DB_NAME = "pdf-viewer-cache";
const LAST_SESSION_STORE_NAME = "kv";
const LAST_SESSION_KEY = "last-session";
const LAST_VIEW_KEY = "last-view";
const RECENT_BOOKS_KEY = "recent-books";
const BOOK_FILE_KEY_PREFIX = "book-file:";
const MAX_RECENT_BOOKS = 16;
const PDF_VIEWER_SELECTION_KEY = "pdfViewerSelectionText";
const DB_TRACE_PREFIX = "[pdf-db]";

const state = {
  pdfDocument: null,
  currentPageNumber: 1,
  scale: 1.1,
  rotation: 0,
  localObjectUrl: "",
  sourceName: "document.pdf",
  sourceUrl: "",
  sourceCaption: "Local file",
  isRenderingAllPages: false,
  pageElements: [],
  hasContents: false,
  panelMode: null,
  panelVisible: true,
  pendingViewState: null,
  customHotkeys: {
    viewerPreviousPlace: "Ctrl+Alt+A",
    viewerWhatIs: "Ctrl+Alt+W",
    viewerEtymology: "Ctrl+Alt+E",
    viewerTranslateRu: "Ctrl+Alt+T",
  },
  pageRenderObserver: null,
  thumbRenderObserver: null,
  renderedPageNumbers: new Set(),
  renderingPageNumbers: new Set(),
  renderedThumbNumbers: new Set(),
  renderingThumbNumbers: new Set(),
  pageRenderQueue: Promise.resolve(),
  suppressScrollSync: false,
  tocPageEntries: [],
  activeTocButton: null,
  currentBookKey: "",
  metadataCache: null,
  navigationHistory: [],
  suppressNavigationHistory: false,
  externalOpenCacheKey: "",
  externalOpenDownloadId: null,
};

let viewStatePersistTimer = null;
const textMeasurementContext = document.createElement("canvas").getContext("2d");

async function loadCustomHotkeys() {
  try {
    state.customHotkeys = await getCustomHotkeys();
  } catch {
    // Keep defaults if storage is unavailable.
  }
}

async function persistPdfViewerSelection() {
  try {
    const selectedText = window.getSelection().toString().trim();
    await chrome.storage.local.set({
      [PDF_VIEWER_SELECTION_KEY]: selectedText,
    });
  } catch {
    // Ignore storage failures.
  }
}

function setStatus(message) {
  statusText.textContent = message;
}

function traceDb(event, details) {
  const payload = details === undefined ? {} : details;
  try {
    chrome.runtime.sendMessage({
      type: "pdf-db-log",
      level: "log",
      event,
      details: payload,
      source: "pdf-viewer",
      at: Date.now(),
    });
  } catch {
    // Keep tracing best-effort only.
  }
}

function traceDbError(event, error, details = {}) {
  const payload = {
    ...details,
    error: String(error?.message || error),
  };
  try {
    chrome.runtime.sendMessage({
      type: "pdf-db-log",
      level: "error",
      event,
      details: payload,
      source: "pdf-viewer",
      at: Date.now(),
    });
  } catch {
    // Keep tracing best-effort only.
  }
}

function setDbSaveIndicator(mode, message = "") {
  if (!dbSaveStatusIndicator) return;
  const normalizedMode =
    mode === "saving" ||
    mode === "loading" ||
    mode === "saved" ||
    mode === "missing" ||
    mode === "error"
      ? mode
      : "idle";
  const glyphByMode = {
    idle: "○",
    saving: "↻",
    loading: "↻",
    saved: "✓",
    missing: "⚠",
    error: "✕",
  };
  const defaultTitleByMode = {
    idle: "Database status: idle",
    saving: "Database status: saving PDF",
    loading: "Database status: loading PDF from database",
    saved: "Database status: PDF stored in database",
    missing: "Database status: PDF not found in database",
    error: "Database status: database error",
  };
  dbSaveStatusIndicator.textContent = glyphByMode[normalizedMode];
  dbSaveStatusIndicator.classList.remove(
    "db-save-status-idle",
    "db-save-status-saving",
    "db-save-status-loading",
    "db-save-status-saved",
    "db-save-status-missing",
    "db-save-status-error"
  );
  dbSaveStatusIndicator.classList.add(`db-save-status-${normalizedMode}`);
  const title = message || defaultTitleByMode[normalizedMode];
  dbSaveStatusIndicator.title = title;
  dbSaveStatusIndicator.setAttribute("aria-label", title);
}

function normalizePdfFileName(name) {
  const trimmed = String(name || "").trim();
  const sanitized = trimmed.replace(/[\\/:*?"<>|]+/g, "_");
  if (!sanitized) return "document.pdf";
  return /\.pdf$/i.test(sanitized) ? sanitized : `${sanitized}.pdf`;
}

function getExternalOpenCacheKey() {
  if (state.currentBookKey) {
    return `book:${state.currentBookKey}`;
  }
  if (state.sourceUrl) {
    return `url:${state.sourceUrl}`;
  }
  return `name:${state.sourceName || "document.pdf"}`;
}

function downloadViaChrome(downloadOptions) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(downloadOptions, (downloadId) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (typeof downloadId !== "number") {
        reject(new Error("Download was not created."));
        return;
      }
      resolve(downloadId);
    });
  });
}

function openDownloadedFile(downloadId) {
  return new Promise((resolve, reject) => {
    chrome.downloads.open(downloadId, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

async function openCurrentPdfInDefaultEditor() {
  if (!state.pdfDocument) return;
  const cacheKey = getExternalOpenCacheKey();
  if (
    cacheKey &&
    state.externalOpenCacheKey === cacheKey &&
    typeof state.externalOpenDownloadId === "number"
  ) {
    try {
      await openDownloadedFile(state.externalOpenDownloadId);
      setStatus("Downloaded file opened.");
      return;
    } catch {
      // Fall through to re-download if previous file is unavailable.
    }
  }
  const sourceUrl = String(state.sourceUrl || "").trim();
  let downloadUrl = sourceUrl || state.localObjectUrl;
  let temporaryObjectUrl = "";
  if (!downloadUrl) {
    try {
      const bytes = await state.pdfDocument.getData();
      temporaryObjectUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      downloadUrl = temporaryObjectUrl;
    } catch {
      // Keep fallback below.
    }
  }
  if (!downloadUrl) {
    setStatus("No PDF source available to open externally.");
    return;
  }
  const filename = normalizePdfFileName(state.sourceName);
  try {
    const downloadId = await downloadViaChrome({
      url: downloadUrl,
      filename,
      saveAs: false,
      conflictAction: "overwrite",
    });
    state.externalOpenCacheKey = cacheKey;
    state.externalOpenDownloadId = downloadId;
    await openDownloadedFile(downloadId);
    setStatus("Downloaded file opened.");
  } catch (error) {
    setStatus(`Could not download/open file: ${String(error?.message || error)}`);
  } finally {
    if (temporaryObjectUrl) {
      setTimeout(() => {
        URL.revokeObjectURL(temporaryObjectUrl);
      }, 15000);
    }
  }
}

function rememberCurrentPlaceForBackNavigation(nextPageNumber, shouldScroll) {
  if (!shouldScroll || state.suppressNavigationHistory || !state.pdfDocument) return;
  const currentPage = Number(state.currentPageNumber);
  const targetPage = Number(nextPageNumber);
  if (!Number.isFinite(currentPage) || !Number.isFinite(targetPage) || currentPage === targetPage) return;
  const entry = {
    pageNumber: currentPage,
    scrollTop: Number(viewerContainer?.scrollTop || 0),
  };
  const last = state.navigationHistory[state.navigationHistory.length - 1];
  if (
    last &&
    last.pageNumber === entry.pageNumber &&
    Math.abs((last.scrollTop || 0) - entry.scrollTop) < 2
  ) {
    return;
  }
  state.navigationHistory.push(entry);
  if (state.navigationHistory.length > 200) {
    state.navigationHistory.shift();
  }
}

async function goToPreviousPlace() {
  if (!state.pdfDocument || !state.navigationHistory.length) return;
  const previous = state.navigationHistory.pop();
  if (!previous || !Number.isFinite(Number(previous.pageNumber))) return;
  state.suppressNavigationHistory = true;
  try {
    await setPage(Number(previous.pageNumber), false, true);
    viewerContainer.scrollTop = Math.max(0, Number(previous.scrollTop) || 0);
  } finally {
    state.suppressNavigationHistory = false;
  }
}

function updateDocumentTitle() {
  const title = String(state.sourceName || "").trim();
  document.title = title || "PDF Viewer";
}

function updateToolbarBookMetaLayout() {
  if (!toolbar || !toolbarBookMeta) return;
  const toolbarRect = toolbar.getBoundingClientRect();
  if (toolbarRect.width <= 0) return;
  const leftEdge = toolbarLeft
    ? toolbarLeft.getBoundingClientRect().right - toolbarRect.left + 8
    : 0;
  const rightEdge = toolbarRight
    ? toolbarRect.right - toolbarRight.getBoundingClientRect().left + 8
    : 0;
  const halfWidth = toolbarRect.width / 2;
  const maxHalf = Math.min(halfWidth - leftEdge, halfWidth - rightEdge);
  const safeWidth = Math.max(0, Math.floor(maxHalf * 2));
  toolbarBookMeta.style.width = `${safeWidth}px`;
}

function updateToolbarBookMeta() {
  if (bookTitleText) {
    const title = String(state.sourceName || "").trim();
    bookTitleText.textContent = title;
  }
  if (bookPathCaption) {
    const caption = String(state.sourceCaption || "").trim();
    bookPathCaption.textContent = caption || "Local file";
  }
  updateToolbarBookMetaLayout();
}

function updateThemeButton() {
  const isDark = document.body.classList.contains("dark");
  themeButton.textContent = isDark ? "☀" : "☾";
}

function nowMillis() {
  return Date.now();
}

function normalizeUrlInput(rawValue) {
  const value = rawValue.trim();
  if (!value) return "";
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

function sanitizePathCaption(caption, fallbackName = "") {
  const text = String(caption || "").trim();
  if (!text) return fallbackName || "Local file";
  const withoutFakePath = text.replace(/^(?:[a-z]:)?[\\/]*fakepath[\\/]/i, "");
  const normalized = withoutFakePath.trim();
  if (!normalized) return fallbackName || "Local file";
  return normalized;
}

function formatPdfDateString(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  const normalized = value.trim();
  const match =
    /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(Z|[+\-]\d{2}'?\d{2}'?)?$/.exec(
      normalized
    );
  if (!match) return normalized;
  const year = match[1];
  const month = match[2] || "01";
  const day = match[3] || "01";
  const hour = match[4] || "00";
  const minute = match[5] || "00";
  const second = match[6] || "00";
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

function normalizeMetadataValue(value) {
  if (value == null) return "—";
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : "—";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    const json = JSON.stringify(value);
    return json && json !== "{}" ? json : "—";
  } catch {
    return String(value);
  }
}

function stringifyMetadataObject(value) {
  if (value == null) return "—";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function closeMetadataDialog() {
  if (!metadataOverlay) return;
  metadataOverlay.classList.add("hidden");
  metadataOverlay.setAttribute("aria-hidden", "true");
}

async function readPdfMetadataRows() {
  if (!state.pdfDocument) return [];
  if (Array.isArray(state.metadataCache) && state.metadataCache.length) {
    return state.metadataCache;
  }
  let metadata = null;
  let info = null;
  let contentDispositionFilename = "";
  let permissions = null;
  let outline = null;
  let pageLabels = null;
  let attachments = null;
  let javaScript = null;
  let destinations = null;
  try {
    const result = await state.pdfDocument.getMetadata();
    metadata = result?.metadata || null;
    info = result?.info || null;
    contentDispositionFilename = result?.contentDispositionFilename || "";
  } catch {
    // Keep dialog usable even when metadata extraction fails.
  }
  try {
    permissions = await state.pdfDocument.getPermissions();
  } catch {}
  try {
    outline = await state.pdfDocument.getOutline();
  } catch {}
  try {
    pageLabels = await state.pdfDocument.getPageLabels();
  } catch {}
  try {
    attachments = await state.pdfDocument.getAttachments();
  } catch {}
  try {
    javaScript = await state.pdfDocument.getJavaScript();
  } catch {}
  try {
    destinations = await state.pdfDocument.getDestinations();
  } catch {}

  const rows = [
    { label: "File name", value: state.sourceName },
    { label: "Source URL", value: state.sourceUrl || "Local file" },
    { label: "Content-disposition filename", value: contentDispositionFilename },
    { label: "Pages", value: state.pdfDocument.numPages },
    { label: "Title", value: info?.Title || metadata?.get?.("dc:title") },
    { label: "Author", value: info?.Author || metadata?.get?.("dc:creator") },
    { label: "Subject", value: info?.Subject },
    { label: "Keywords", value: info?.Keywords },
    { label: "Creator", value: info?.Creator },
    { label: "Producer", value: info?.Producer },
    { label: "PDF version", value: info?.PDFFormatVersion },
    { label: "Creation date", value: formatPdfDateString(info?.CreationDate) },
    { label: "Modified date", value: formatPdfDateString(info?.ModDate) },
    { label: "Language", value: info?.Lang },
    { label: "Permissions", value: normalizeMetadataValue(permissions) },
    {
      label: "Outline entries",
      value: Array.isArray(outline) ? String(outline.length) : "0",
    },
    {
      label: "Page labels",
      value: Array.isArray(pageLabels) ? String(pageLabels.length) : "—",
    },
    {
      label: "Attachments",
      value:
        attachments && typeof attachments === "object"
          ? String(Object.keys(attachments).length)
          : "0",
    },
    {
      label: "Document JavaScript snippets",
      value: Array.isArray(javaScript) ? String(javaScript.length) : "0",
    },
    {
      label: "Named destinations",
      value:
        destinations && typeof destinations === "object"
          ? String(Object.keys(destinations).length)
          : "0",
    },
    {
      label: "Info object (raw)",
      value: stringifyMetadataObject(info),
      multiline: true,
    },
    {
      label: "XMP metadata object (raw)",
      value: stringifyMetadataObject(metadata?.getAll?.() || metadata),
      multiline: true,
    },
    {
      label: "Outline object (raw)",
      value: stringifyMetadataObject(outline),
      multiline: true,
    },
    {
      label: "Page labels object (raw)",
      value: stringifyMetadataObject(pageLabels),
      multiline: true,
    },
    {
      label: "Attachments object (raw)",
      value: stringifyMetadataObject(attachments),
      multiline: true,
    },
    {
      label: "Document JavaScript object (raw)",
      value: stringifyMetadataObject(javaScript),
      multiline: true,
    },
    {
      label: "Named destinations object (raw)",
      value: stringifyMetadataObject(destinations),
      multiline: true,
    },
  ].map((row) => ({
    label: row.label,
    value: row.multiline ? row.value : normalizeMetadataValue(row.value),
    multiline: Boolean(row.multiline),
  }));

  state.metadataCache = rows;
  return rows;
}

async function openMetadataDialog() {
  if (!metadataOverlay || !metadataDialogBody || !state.pdfDocument) return;
  metadataDialogBody.textContent = "";
  const rows = await readPdfMetadataRows();
  for (const row of rows) {
    const rowElement = document.createElement("div");
    rowElement.className = "metadata-row";
    const key = document.createElement("div");
    key.className = "metadata-key";
    key.textContent = row.label;
    const value = document.createElement("div");
    value.className = row.multiline ? "metadata-value metadata-value-multiline" : "metadata-value";
    value.textContent = row.value;
    rowElement.appendChild(key);
    rowElement.appendChild(value);
    metadataDialogBody.appendChild(rowElement);
  }
  metadataOverlay.classList.remove("hidden");
  metadataOverlay.setAttribute("aria-hidden", "false");
}

function isEditableTarget(target) {
  if (!target) return false;
  if (target instanceof HTMLInputElement) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return false;
}

function openLastSessionDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(LAST_SESSION_DB_NAME);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(LAST_SESSION_STORE_NAME)) {
        database.createObjectStore(LAST_SESSION_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onblocked = () => {
      const error = new Error("IndexedDB open is blocked by another tab/session.");
      traceDbError("open-blocked", error);
      reject(error);
    };
    request.onerror = () => reject(request.error);
  });
}

async function saveBookFileData(bookKey, dataBytes) {
  if (!bookKey || !dataBytes) return false;
  try {
    const safeBytes =
      dataBytes instanceof Uint8Array ? dataBytes.slice() : new Uint8Array(dataBytes);
    const storageKey = `${BOOK_FILE_KEY_PREFIX}${bookKey}`;
    traceDb("save-start", {
      bookKey,
      storageKey,
      bytes: Number(safeBytes?.byteLength) || 0,
    });
    const db = await openLastSessionDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(LAST_SESSION_STORE_NAME, "readwrite");
      const store = tx.objectStore(LAST_SESSION_STORE_NAME);
      store.put({ data: safeBytes, savedAt: Date.now() }, storageKey);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    traceDb("save-ok", { bookKey });
    return true;
  } catch (error) {
    traceDbError("save-failed", error, { bookKey });
    setStatus(`DB save failed: ${String(error?.message || error)}`);
    traceDb("save-failed", { bookKey, error: String(error?.message || error) });
    // Ignore storage failures to keep viewer usable.
    return false;
  }
}

async function readBookFileData(bookKey) {
  if (!bookKey) return null;
  try {
    const storageKey = `${BOOK_FILE_KEY_PREFIX}${bookKey}`;
    traceDb("read-start", { bookKey });
    const db = await openLastSessionDb();
    const result = await new Promise((resolve, reject) => {
      const tx = db.transaction(LAST_SESSION_STORE_NAME, "readonly");
      const store = tx.objectStore(LAST_SESSION_STORE_NAME);
      const request = store.get(storageKey);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
    db.close();
    const data = result?.data || null;
    traceDb(data ? "read-hit" : "read-miss", {
      bookKey,
      storageKey,
      bytes: Number(data?.byteLength) || 0,
    });
    return data;
  } catch (error) {
    traceDbError("read-failed", error, { bookKey });
    traceDb("read-failed", { bookKey, error: String(error?.message || error) });
    return null;
  }
}

async function saveLastSession(record) {
  try {
    const db = await openLastSessionDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(LAST_SESSION_STORE_NAME, "readwrite");
      const store = tx.objectStore(LAST_SESSION_STORE_NAME);
      store.put({ ...record, savedAt: Date.now() }, LAST_SESSION_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Ignore storage failures to keep viewer usable.
  }
}

async function readLastSession() {
  try {
    const db = await openLastSessionDb();
    const result = await new Promise((resolve, reject) => {
      const tx = db.transaction(LAST_SESSION_STORE_NAME, "readonly");
      const store = tx.objectStore(LAST_SESSION_STORE_NAME);
      const request = store.get(LAST_SESSION_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return result;
  } catch {
    return null;
  }
}

async function saveViewState(record) {
  try {
    const db = await openLastSessionDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(LAST_SESSION_STORE_NAME, "readwrite");
      const store = tx.objectStore(LAST_SESSION_STORE_NAME);
      store.put({ ...record, savedAt: Date.now() }, LAST_VIEW_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Ignore storage failures.
  }
}

async function readViewState() {
  try {
    const db = await openLastSessionDb();
    const result = await new Promise((resolve, reject) => {
      const tx = db.transaction(LAST_SESSION_STORE_NAME, "readonly");
      const store = tx.objectStore(LAST_SESSION_STORE_NAME);
      const request = store.get(LAST_VIEW_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return result;
  } catch {
    return null;
  }
}

async function saveRecentBooks(books) {
  try {
    const db = await openLastSessionDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(LAST_SESSION_STORE_NAME, "readwrite");
      const store = tx.objectStore(LAST_SESSION_STORE_NAME);
      store.put(books, RECENT_BOOKS_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Ignore storage failures.
  }
}

async function readRecentBooks() {
  try {
    const db = await openLastSessionDb();
    const result = await new Promise((resolve, reject) => {
      const tx = db.transaction(LAST_SESSION_STORE_NAME, "readonly");
      const store = tx.objectStore(LAST_SESSION_STORE_NAME);
      const request = store.get(RECENT_BOOKS_KEY);
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}

function createLocalBookKey(file) {
  const modified = Number(file?.lastModified) || 0;
  const size = Number(file?.size) || 0;
  const name = String(file?.name || "document.pdf").trim();
  return `local:${name}:${size}:${modified}`;
}

function createUrlBookKey(url) {
  return `url:${url}`;
}

async function renderBookPreviewFromCurrentDocument() {
  if (!state.pdfDocument) return "";
  try {
    const page = await state.pdfDocument.getPage(1);
    const viewport = page.getViewport({ scale: 1, rotation: state.rotation });
    const targetWidth = 220;
    const previewScale = Math.min(Math.max(targetWidth / viewport.width, 0.1), 0.45);
    const previewViewport = page.getViewport({
      scale: previewScale,
      rotation: state.rotation,
    });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(previewViewport.width));
    canvas.height = Math.max(1, Math.floor(previewViewport.height));
    const context = canvas.getContext("2d", { alpha: false });
    await page.render({
      canvasContext: context,
      viewport: previewViewport,
    }).promise;
    return canvas.toDataURL("image/jpeg", 0.72);
  } catch {
    return "";
  }
}

function formatBookSubtitle(item) {
  const source = item.type === "url" ? "URL" : "Local file";
  const page = Number(item.lastPage) > 0 ? `Page ${item.lastPage}` : "Page 1";
  return `${source} · ${page}`;
}

async function upsertRecentBook(entry) {
  if (!entry?.bookKey) return;
  const existing = await readRecentBooks();
  const filtered = existing.filter((item) => item?.bookKey !== entry.bookKey);
  filtered.unshift({ ...entry, updatedAt: nowMillis() });
  await saveRecentBooks(filtered.slice(0, MAX_RECENT_BOOKS));
}

async function updateCurrentBookProgress() {
  if (!state.currentBookKey) return;
  const existing = await readRecentBooks();
  const index = existing.findIndex((item) => item?.bookKey === state.currentBookKey);
  if (index < 0) return;
  const next = [...existing];
  const item = { ...next[index], lastPage: state.currentPageNumber || 1, updatedAt: nowMillis() };
  next.splice(index, 1);
  next.unshift(item);
  await saveRecentBooks(next.slice(0, MAX_RECENT_BOOKS));
}

function closePreviousBooksDialog() {
  if (!previousBooksOverlay) return;
  previousBooksOverlay.classList.add("hidden");
  previousBooksOverlay.setAttribute("aria-hidden", "true");
}

async function openRecentBookFromDialog(item) {
  if (!item) return;
  closePreviousBooksDialog();
  state.pendingViewState = {
    pageNumber: Number(item.lastPage) || 1,
  };
  if (item.type === "local") {
    traceDb("open-recent-local-start", {
      bookKey: item.bookKey || "",
      name: item.name || "",
    });
    setDbSaveIndicator("loading", `Loading "${item.name || "document.pdf"}" from database...`);
    let localBytes = null;
    const bookData = await readBookFileData(item.bookKey || "");
    if (bookData) {
      localBytes = new Uint8Array(bookData);
      traceDb("open-recent-local-source-db", {
        bookKey: item.bookKey || "",
        bytes: localBytes.byteLength,
      });
    } else if (item.data) {
      localBytes = new Uint8Array(item.data);
      traceDb("open-recent-local-source-recents-item-data", {
        bookKey: item.bookKey || "",
        bytes: localBytes.byteLength,
      });
      setDbSaveIndicator("missing", "Not in database. Using fallback cached entry data.");
    } else {
      const lastSession = await readLastSession();
      if (
        lastSession?.type === "local" &&
        lastSession.data &&
        (lastSession.name || "") === (item.name || "")
      ) {
        localBytes = new Uint8Array(lastSession.data);
        traceDb("open-recent-local-source-last-session", {
          bookKey: item.bookKey || "",
          bytes: localBytes.byteLength,
        });
        setDbSaveIndicator("missing", "Not in database. Using last-session fallback.");
      }
    }
    if (!localBytes) {
      setStatus("Local file data is unavailable. Please open the file again.");
      setDbSaveIndicator("error", "Database: file bytes unavailable.");
      traceDb("open-recent-local-failed-no-bytes", {
        bookKey: item.bookKey || "",
      });
      return;
    }
    const blob = new Blob([localBytes], { type: "application/pdf" });
    revokeLocalObjectUrl();
    state.localObjectUrl = URL.createObjectURL(blob);
    await loadDocument(
      { data: localBytes },
      item.name || "document.pdf",
      "",
      "From previous books"
    );
    state.currentBookKey = item.bookKey || "";
    await saveLastSession({
      type: "local",
      name: item.name || "document.pdf",
      data: localBytes.buffer,
    });
    await upsertRecentBook({
      ...item,
      lastPage: Number(item.lastPage) || 1,
    });
    if (bookData) {
      setDbSaveIndicator("saved", `Loaded "${item.name || "document.pdf"}" from database.`);
    }
    traceDb("open-recent-local-ok", {
      bookKey: item.bookKey || "",
      page: Number(item.lastPage) || 1,
    });
    return;
  }
  if (item.type === "url" && typeof item.url === "string") {
    setDbSaveIndicator("idle", "Database status not applicable for URL books.");
    await loadDocument(
      { url: item.url },
      item.name || item.url.split("/").pop() || "document.pdf",
      item.url
    );
    state.currentBookKey = item.bookKey || "";
    await saveLastSession({
      type: "url",
      url: item.url,
    });
    await upsertRecentBook({
      ...item,
      lastPage: Number(item.lastPage) || 1,
    });
  }
}

function renderPreviousBooksDialogItems(items) {
  if (!previousBooksList || !previousBooksEmpty) return;
  previousBooksList.textContent = "";
  previousBooksEmpty.style.display = items.length ? "none" : "";
  for (const item of items) {
    const li = document.createElement("li");
    li.className = "previous-book-item";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "previous-book-button";
    button.addEventListener("click", async () => {
      await openRecentBookFromDialog(item);
    });

    if (item.previewDataUrl) {
      const image = document.createElement("img");
      image.className = "previous-book-preview";
      image.src = item.previewDataUrl;
      image.alt = `${item.name || "Book"} preview`;
      button.appendChild(image);
    } else {
      const placeholder = document.createElement("div");
      placeholder.className = "previous-book-preview-placeholder";
      placeholder.textContent = "No preview";
      button.appendChild(placeholder);
    }

    const meta = document.createElement("div");
    meta.className = "previous-book-meta";
    const title = document.createElement("div");
    title.className = "previous-book-title";
    title.textContent = item.name || "document.pdf";
    const subtitle = document.createElement("div");
    subtitle.className = "previous-book-subtitle";
    subtitle.textContent = formatBookSubtitle(item);
    meta.appendChild(title);
    meta.appendChild(subtitle);
    button.appendChild(meta);

    li.appendChild(button);
    previousBooksList.appendChild(li);
  }
}

async function openPreviousBooksDialog() {
  if (!previousBooksOverlay) return;
  const items = await readRecentBooks();
  renderPreviousBooksDialogItems(items);
  previousBooksOverlay.classList.remove("hidden");
  previousBooksOverlay.setAttribute("aria-hidden", "false");
}

function buildCurrentViewState() {
  return {
    pageNumber: state.currentPageNumber,
    scrollTop: viewerContainer.scrollTop,
    scale: state.scale,
    rotation: state.rotation,
    panelMode: state.panelMode,
    panelVisible: state.panelVisible,
  };
}

function scheduleViewStatePersist() {
  if (!state.pdfDocument) return;
  if (viewStatePersistTimer) {
    clearTimeout(viewStatePersistTimer);
  }
  viewStatePersistTimer = setTimeout(() => {
    viewStatePersistTimer = null;
    saveViewState(buildCurrentViewState());
  }, 180);
}

function updateControls() {
  const hasDocument = Boolean(state.pdfDocument);
  const pageCount = hasDocument ? state.pdfDocument.numPages : 0;

  pageNumberInput.disabled = !hasDocument;
  openExternalButton.disabled = !hasDocument;
  metadataButton.disabled = !hasDocument;
  contentsTabButton.disabled = !hasDocument || !state.hasContents;
  pagesTabButton.disabled = !hasDocument;
  tocSearchInput.disabled = !hasDocument || !state.hasContents;
  collapseAllTocButton.disabled = !hasDocument || !state.hasContents;

  pageNumberInput.value = String(state.currentPageNumber || 1);
  pageCountLabel.textContent = `/${pageCount}`;
  zoomLabel.textContent = `${Math.round(state.scale * 100)}%`;
  updateDocumentTitle();
  updateToolbarBookMeta();
}

function isElementVerticallyVisibleInContainer(container, element) {
  if (!container || !element) return false;
  const containerRect = container.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();
  return elementRect.top >= containerRect.top && elementRect.bottom <= containerRect.bottom;
}

function ensureActiveTocEntryVisible(button) {
  if (!button || !contentsPanel || contentsPanel.classList.contains("hidden")) return;
  const target = button.closest(".toc-item-row") || button;
  if (!contentsPanel.contains(target)) return;
  if (isElementVerticallyVisibleInContainer(contentsPanel, target)) return;
  target.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "auto" });
}

function highlightActiveTocEntry(options = {}) {
  const ensureVisible = options.ensureVisible === true;
  const entries = state.tocPageEntries;
  if (!entries.length) {
    if (state.activeTocButton) {
      state.activeTocButton.classList.remove("active");
      state.activeTocButton = null;
    }
    return;
  }

  const currentPage = state.currentPageNumber || 1;
  let activeEntry = entries[0];
  for (const entry of entries) {
    if (entry.pageNumber <= currentPage) {
      activeEntry = entry;
      continue;
    }
    break;
  }

  if (state.activeTocButton && state.activeTocButton !== activeEntry.button) {
    state.activeTocButton.classList.remove("active");
  }
  activeEntry.button.classList.add("active");
  state.activeTocButton = activeEntry.button;
  if (ensureVisible) {
    ensureActiveTocEntryVisible(activeEntry.button);
  }
}

function collapseAllTocSections() {
  const sublists = tocList.querySelectorAll(".toc-sublist");
  const toggles = tocList.querySelectorAll(".toc-item-toggle");
  for (const sublist of sublists) {
    sublist.classList.add("collapsed");
  }
  for (const toggle of toggles) {
    toggle.textContent = "+";
    toggle.setAttribute("aria-expanded", "false");
  }
}

function toggleSidePanelVisibility() {
  const hasPanelMode = state.panelMode === "contents" || state.panelMode === "pages";
  if (!hasPanelMode) {
    if (state.hasContents) {
      state.panelVisible = true;
      setPanelMode("contents");
    } else if (state.pdfDocument) {
      state.panelVisible = true;
      setPanelMode("pages");
    }
    return;
  }
  state.panelVisible = !state.panelVisible;
  syncPanelLayout();
  scheduleViewStatePersist();
}

function normalizeTocSearchQuery(query) {
  return String(query || "").trim().toLowerCase();
}

function setTocItemTitleHighlight(node, normalizedQuery) {
  const titleSpan = node.querySelector(":scope > .toc-item-row .toc-item-title");
  if (!titleSpan) return;
  const fullTitle = titleSpan.dataset.fullTitle || titleSpan.textContent || "";
  titleSpan.dataset.fullTitle = fullTitle;

  if (!normalizedQuery) {
    titleSpan.textContent = fullTitle;
    return;
  }

  const titleLower = fullTitle.toLowerCase();
  let startIndex = titleLower.indexOf(normalizedQuery);
  if (startIndex < 0) {
    titleSpan.textContent = fullTitle;
    return;
  }

  titleSpan.textContent = "";
  let cursor = 0;
  while (startIndex >= 0) {
    if (startIndex > cursor) {
      titleSpan.appendChild(document.createTextNode(fullTitle.slice(cursor, startIndex)));
    }
    const mark = document.createElement("mark");
    mark.className = "toc-search-highlight";
    mark.textContent = fullTitle.slice(startIndex, startIndex + normalizedQuery.length);
    titleSpan.appendChild(mark);
    cursor = startIndex + normalizedQuery.length;
    startIndex = titleLower.indexOf(normalizedQuery, cursor);
  }
  if (cursor < fullTitle.length) {
    titleSpan.appendChild(document.createTextNode(fullTitle.slice(cursor)));
  }
}

function clearTocSearchState() {
  const allItems = tocList.querySelectorAll(".toc-item");
  const allSubLists = tocList.querySelectorAll(".toc-sublist");
  for (const item of allItems) {
    item.classList.remove("toc-item-hidden");
    setTocItemTitleHighlight(item, "");
  }
  for (const subList of allSubLists) {
    subList.classList.remove("toc-sublist-search-open");
  }
}

function filterTocItemsByQuery(query) {
  const normalizedQuery = normalizeTocSearchQuery(query);
  if (!normalizedQuery) {
    clearTocSearchState();
    return;
  }

  const visitNode = (node) => {
    const ownTitle = node.dataset.searchTitle || "";
    const ownMatch = ownTitle.includes(normalizedQuery);
    setTocItemTitleHighlight(node, ownMatch ? normalizedQuery : "");
    const childList = node.querySelector(":scope > .toc-sublist");
    let childMatch = false;

    if (childList) {
      const childItems = childList.querySelectorAll(":scope > .toc-item");
      for (const child of childItems) {
        if (visitNode(child)) {
          childMatch = true;
        }
      }
      childList.classList.toggle("toc-sublist-search-open", childMatch);
    }

    const isVisible = ownMatch || childMatch;
    node.classList.toggle("toc-item-hidden", !isVisible);
    return isVisible;
  };

  const topLevelItems = tocList.querySelectorAll(":scope > .toc-item");
  for (const item of topLevelItems) {
    visitNode(item);
  }
}

function revokeLocalObjectUrl() {
  if (state.localObjectUrl) {
    URL.revokeObjectURL(state.localObjectUrl);
    state.localObjectUrl = "";
  }
}

function syncPanelLayout() {
  const isOpenMode = state.panelMode === "contents" || state.panelMode === "pages";
  const isPanelShown = isOpenMode && state.panelVisible;
  sidePanel.classList.toggle("hidden", !isPanelShown);
  document.body.classList.toggle("panel-open", isPanelShown);
  updateToolbarBookMetaLayout();
}

function setPanelMode(mode) {
  state.panelMode = mode;
  const isOpen = mode === "contents" || mode === "pages";
  if (!isOpen) {
    state.panelVisible = false;
  }
  syncPanelLayout();
  contentsPanel.classList.toggle("hidden", mode !== "contents");
  thumbnailsPanel.classList.toggle("hidden", mode !== "pages");
  contentsTabButton.classList.toggle("active", mode === "contents");
  pagesTabButton.classList.toggle("active", mode === "pages");
  scheduleViewStatePersist();
}

async function closeActiveDocument() {
  if (state.pdfDocument) {
    await state.pdfDocument.destroy();
    state.pdfDocument = null;
  }
  revokeLocalObjectUrl();
  state.sourceUrl = "";
  state.sourceName = "document.pdf";
  state.sourceCaption = "Local file";
  state.currentPageNumber = 1;
  state.scale = 1.1;
  state.rotation = 0;
  state.pageElements = [];
  if (state.pageRenderObserver) {
    state.pageRenderObserver.disconnect();
    state.pageRenderObserver = null;
  }
  if (state.thumbRenderObserver) {
    state.thumbRenderObserver.disconnect();
    state.thumbRenderObserver = null;
  }
  state.renderedPageNumbers.clear();
  state.renderingPageNumbers.clear();
  state.renderedThumbNumbers.clear();
  state.renderingThumbNumbers.clear();
  state.pageRenderQueue = Promise.resolve();
  state.hasContents = false;
  state.tocPageEntries = [];
  state.activeTocButton = null;
  state.currentBookKey = "";
  state.metadataCache = null;
  state.navigationHistory = [];
  state.suppressNavigationHistory = false;
  state.externalOpenCacheKey = "";
  state.externalOpenDownloadId = null;
  setDbSaveIndicator("idle");
  closeMetadataDialog();
  state.panelMode = null;
  state.panelVisible = true;
  pagesContainer.textContent = "";
  tocList.textContent = "";
  tocEmpty.style.display = "";
  thumbsList.textContent = "";
  thumbsEmpty.style.display = "";
  setPanelMode(null);
  viewerContainer.classList.remove("drag-over");
  updateControls();
}

async function resolveOutlineDestinationToPageNumber(destination) {
  if (!state.pdfDocument || !destination) return null;
  try {
    let resolvedDestination = destination;
    if (typeof destination === "string") {
      resolvedDestination = await state.pdfDocument.getDestination(destination);
    }
    if (!Array.isArray(resolvedDestination) || !resolvedDestination[0]) {
      return null;
    }
    const pageRef = resolvedDestination[0];
    const pageIndex = await state.pdfDocument.getPageIndex(pageRef);
    return pageIndex + 1;
  } catch {
    return null;
  }
}

async function mapOutlineItems(outlineItems, depth = 0) {
  if (!Array.isArray(outlineItems)) return [];
  const output = [];
  for (const item of outlineItems) {
    const pageNumber = await resolveOutlineDestinationToPageNumber(item.dest);
    const children = await mapOutlineItems(item.items, depth + 1);
    if (typeof pageNumber === "number" || children.length > 0) {
      output.push({
        title: (item.title || "Untitled").replace(/\s+/g, " ").trim(),
        pageNumber,
        depth,
        children,
      });
    }
  }
  return output;
}

function inferOutlinePreviewPage(item) {
  if (typeof item.pageNumber === "number") return item.pageNumber;
  for (const child of item.children) {
    const page = inferOutlinePreviewPage(child);
    if (typeof page === "number") return page;
  }
  return null;
}

/** Stable, high-contrast palette index from title + page. */
function tocPreviewPaletteVars(title, pageNumber) {
  const s = `${title}\0${pageNumber}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const palettes = [
    { a: "18 88% 56%", b: "350 92% 40%" },
    { a: "35 94% 58%", b: "12 88% 42%" },
    { a: "52 94% 54%", b: "30 88% 40%" },
    { a: "84 86% 52%", b: "132 86% 34%" },
    { a: "148 80% 50%", b: "176 88% 32%" },
    { a: "190 92% 56%", b: "214 90% 38%" },
    { a: "226 92% 60%", b: "248 86% 42%" },
    { a: "264 90% 60%", b: "292 84% 42%" },
    { a: "304 84% 58%", b: "330 86% 40%" },
    { a: "338 88% 60%", b: "16 90% 42%" },
  ];
  const u = h >>> 0;
  return palettes[u % palettes.length];
}

function formatTocPageText(pageNumber, pageLabels) {
  if (!Number.isFinite(pageNumber)) return "";
  const numericPage = Math.max(1, Math.floor(pageNumber));
  const label = Array.isArray(pageLabels) ? pageLabels[numericPage - 1] : "";
  const normalizedLabel = typeof label === "string" ? label.trim() : "";
  return normalizedLabel ? `${normalizedLabel} (${numericPage})` : String(numericPage);
}

function renderOutlineNodes(parentList, nodes, pageEntries = [], pageLabels = []) {
  for (const item of nodes) {
    const hasChildren = item.children.length > 0;
    const previewPage = inferOutlinePreviewPage(item);
    const showPreview =
      item.depth === 0 &&
      hasChildren &&
      item.children.length >= 2 &&
      typeof previewPage === "number";

    const li = document.createElement("li");
    li.className = "toc-item";
    li.dataset.depth = String(item.depth);
    li.dataset.searchTitle = item.title.toLowerCase();
    if (hasChildren) {
      li.classList.add("toc-item-parent");
    }
    if (showPreview) {
      li.classList.add("toc-item-with-preview");
    }

    const row = document.createElement("div");
    row.className = "toc-item-row";
    row.style.paddingLeft = `${Math.min(item.depth, 6) * 12}px`;
    row.dataset.depth = String(item.depth);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "toc-item-button";
    button.dataset.depth = String(item.depth);
    const titleSpan = document.createElement("span");
    titleSpan.className = "toc-item-title";
    titleSpan.textContent = item.title;

    const pageSpan = document.createElement("span");
    pageSpan.className = "toc-item-page";
    pageSpan.textContent =
      typeof item.pageNumber === "number"
        ? formatTocPageText(item.pageNumber, pageLabels)
        : "";

    if (showPreview) {
      const palette = tocPreviewPaletteVars(item.title, previewPage);
      const previewIcon = document.createElement("span");
      previewIcon.className = "toc-item-preview-icon";
      previewIcon.style.setProperty("--toc-dot-a", palette.a);
      previewIcon.style.setProperty("--toc-dot-b", palette.b);
      previewIcon.setAttribute("aria-hidden", "true");
      button.appendChild(previewIcon);
    }
    button.appendChild(titleSpan);
    if (typeof item.pageNumber === "number") {
      button.dataset.pageNumber = String(item.pageNumber);
      button.addEventListener("click", async () => {
        await setPage(item.pageNumber, true, true);
      });
      pageEntries.push({ pageNumber: item.pageNumber, button });
    } else {
      button.disabled = true;
    }

    let childList = null;

    if (hasChildren) {
      const toggleButton = document.createElement("button");
      toggleButton.type = "button";
      toggleButton.className = "toc-item-toggle";
      toggleButton.textContent = "+";
      toggleButton.setAttribute("aria-label", `Toggle ${item.title}`);
      toggleButton.setAttribute("aria-expanded", "false");
      row.appendChild(toggleButton);

      childList = document.createElement("ul");
      childList.className = "toc-sublist collapsed";
      renderOutlineNodes(childList, item.children, pageEntries, pageLabels);

      toggleButton.addEventListener("click", () => {
        const isCollapsed = childList.classList.toggle("collapsed");
        toggleButton.textContent = isCollapsed ? "+" : "-";
        toggleButton.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
      });
    } else {
      const spacer = document.createElement("span");
      spacer.className = "toc-item-toggle-spacer";
      row.appendChild(spacer);
    }

    row.appendChild(button);
    row.appendChild(pageSpan);
    li.appendChild(row);
    if (childList) {
      li.appendChild(childList);
    }

    parentList.appendChild(li);
  }
}

async function renderContents() {
  tocList.textContent = "";
  tocEmpty.style.display = "";
  tocSearchInput.value = "";
  state.hasContents = false;
  state.tocPageEntries = [];
  state.activeTocButton = null;
  if (!state.pdfDocument) {
    updateControls();
    return;
  }

  const outline = await state.pdfDocument.getOutline();
  let pageLabels = [];
  try {
    pageLabels = (await state.pdfDocument.getPageLabels()) || [];
  } catch {
    pageLabels = [];
  }
  const mappedOutline = await mapOutlineItems(outline);
  if (!mappedOutline.length) {
    if (state.panelMode === "contents") {
      setPanelMode(null);
    }
    updateControls();
    return;
  }

  const pageEntries = [];
  renderOutlineNodes(tocList, mappedOutline, pageEntries, pageLabels);
  state.tocPageEntries = pageEntries.sort((a, b) => a.pageNumber - b.pageNumber);

  state.hasContents = true;
  tocEmpty.style.display = "none";
  highlightActiveTocEntry();
  if (state.panelMode === null) {
    setPanelMode("contents");
  }
  updateControls();
}

async function renderTextLayer(page, viewport, textLayer) {
  const textContent = await page.getTextContent();
  for (const item of textContent.items) {
    if (!item.str) continue;
    const textSpan = document.createElement("span");
    textSpan.textContent = item.str;
    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const fontHeight = Math.max(1, Math.hypot(tx[2], tx[3]));
    const textStyle = textContent.styles[item.fontName] || {};
    const fontFamily = textStyle.fontFamily || "sans-serif";
    let fontAscent = fontHeight;
    if (typeof textStyle.ascent === "number") {
      fontAscent = fontHeight * textStyle.ascent;
    } else if (typeof textStyle.descent === "number") {
      fontAscent = fontHeight * (1 + textStyle.descent);
    }

    textSpan.style.left = `${tx[4]}px`;
    textSpan.style.top = `${tx[5] - fontAscent}px`;
    textSpan.style.fontSize = `${fontHeight}px`;
    textSpan.style.fontFamily = fontFamily;

    let textTransform = "";
    if (textMeasurementContext) {
      textMeasurementContext.font = `${fontHeight}px ${fontFamily}`;
      const measuredWidth = textMeasurementContext.measureText(item.str).width;
      const expectedWidth = Math.max(0, item.width * viewport.scale);
      if (measuredWidth > 0 && expectedWidth > 0) {
        const scaleX = expectedWidth / measuredWidth;
        if (Math.abs(scaleX - 1) > 0.01) {
          textTransform = `scaleX(${scaleX})`;
        }
      }
    }

    textSpan.style.transform = textTransform || "none";
    textLayer.appendChild(textSpan);
  }
}

function cleanupFarRenderedPages(centerPage, radius = 8) {
  if (!state.pageElements.length) return;
  for (const pageNumber of Array.from(state.renderedPageNumbers)) {
    if (Math.abs(pageNumber - centerPage) <= radius) continue;
    const shell = state.pageElements[pageNumber - 1];
    if (!shell) continue;
    shell.textContent = "";
    state.renderedPageNumbers.delete(pageNumber);
  }
}

function queuePageRender(pageNumber) {
  if (!state.pdfDocument) return;
  if (state.renderedPageNumbers.has(pageNumber)) return;
  if (state.renderingPageNumbers.has(pageNumber)) return;
  const shell = state.pageElements[pageNumber - 1];
  if (!shell) return;

  state.renderingPageNumbers.add(pageNumber);
  state.pageRenderQueue = state.pageRenderQueue
    .then(async () => {
      if (!state.pdfDocument) return;
      if (state.renderedPageNumbers.has(pageNumber)) return;
      const page = await state.pdfDocument.getPage(pageNumber);
      const viewport = page.getViewport({
        scale: state.scale,
        rotation: state.rotation,
      });
      const outputScale = window.devicePixelRatio || 1;
      const canvas = document.createElement("canvas");
      canvas.className = "pdf-page-canvas";
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      shell.style.width = canvas.style.width;
      shell.style.height = canvas.style.height;

      const context = canvas.getContext("2d", { alpha: false });
      context.imageSmoothingEnabled = false;
      shell.textContent = "";
      shell.appendChild(canvas);

      const textLayer = document.createElement("div");
      textLayer.className = "pdf-text-layer";
      shell.appendChild(textLayer);

      const transform =
        outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null;
      await page.render({ canvasContext: context, viewport, transform }).promise;
      await renderTextLayer(page, viewport, textLayer);
      state.renderedPageNumbers.add(pageNumber);
    })
    .catch(() => {})
    .finally(() => {
      state.renderingPageNumbers.delete(pageNumber);
    });
}

function requestRenderAround(pageNumber) {
  for (let offset = -2; offset <= 2; offset += 1) {
    const target = pageNumber + offset;
    if (target < 1 || !state.pdfDocument || target > state.pdfDocument.numPages) {
      continue;
    }
    queuePageRender(target);
  }
  cleanupFarRenderedPages(pageNumber, 10);
}

async function renderThumbnails() {
  thumbsList.textContent = "";
  thumbsEmpty.style.display = "";
  state.renderedThumbNumbers.clear();
  state.renderingThumbNumbers.clear();
  if (state.thumbRenderObserver) {
    state.thumbRenderObserver.disconnect();
    state.thumbRenderObserver = null;
  }
  if (!state.pdfDocument) return;

  const pageCount = state.pdfDocument.numPages;
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "thumb-button";
    button.dataset.pageNumber = String(pageNumber);
    button.addEventListener("click", async () => {
      await setPage(pageNumber, true, true);
    });

    const label = document.createElement("div");
    label.className = "thumb-label";
    label.textContent = `Page ${pageNumber}`;

    const item = document.createElement("li");
    item.className = "thumb-item";
    item.appendChild(button);
    item.appendChild(label);
    thumbsList.appendChild(item);
  }

  thumbsEmpty.style.display = "none";
  highlightActiveThumbnail();

  const outputScale = Math.max(1, window.devicePixelRatio || 1);
  const targetThumbWidth = 190;
  state.thumbRenderObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const button = entry.target;
        const pageNumber = Number(button.dataset.pageNumber);
        if (!pageNumber) continue;
        if (state.renderedThumbNumbers.has(pageNumber)) continue;
        if (state.renderingThumbNumbers.has(pageNumber)) continue;
        state.renderingThumbNumbers.add(pageNumber);

        (async () => {
          if (!state.pdfDocument) return;
          const page = await state.pdfDocument.getPage(pageNumber);
          const viewport = page.getViewport({ scale: 1, rotation: state.rotation });
          const thumbScale = targetThumbWidth / viewport.width;
          const thumbViewport = page.getViewport({
            scale: Math.min(Math.max(thumbScale, 0.12), 0.6),
            rotation: state.rotation,
          });

          const canvas = document.createElement("canvas");
          canvas.className = "thumb-canvas";
          canvas.width = Math.floor(thumbViewport.width * outputScale);
          canvas.height = Math.floor(thumbViewport.height * outputScale);
          canvas.style.width = `${Math.floor(thumbViewport.width)}px`;
          canvas.style.height = `${Math.floor(thumbViewport.height)}px`;
          const context = canvas.getContext("2d", { alpha: false });
          const transform =
            outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null;
          await page.render({
            canvasContext: context,
            viewport: thumbViewport,
            transform,
          }).promise;
          button.textContent = "";
          button.appendChild(canvas);
          state.renderedThumbNumbers.add(pageNumber);
        })()
          .catch(() => {})
          .finally(() => {
            state.renderingThumbNumbers.delete(pageNumber);
          });
      }
    },
    { root: sidePanel, rootMargin: "400px 0px 400px 0px", threshold: 0.01 }
  );

  const thumbButtons = thumbsList.querySelectorAll(".thumb-button");
  for (const button of thumbButtons) {
    state.thumbRenderObserver.observe(button);
  }
}

function highlightActiveThumbnail() {
  const buttons = thumbsList.querySelectorAll(".thumb-button");
  for (const button of buttons) {
    const pageNumber = Number(button.dataset.pageNumber);
    button.classList.toggle("active", pageNumber === state.currentPageNumber);
  }
}

async function renderAllPages() {
  if (!state.pdfDocument || state.isRenderingAllPages) return;
  state.isRenderingAllPages = true;
  try {
    const pageCount = state.pdfDocument.numPages;
    pagesContainer.textContent = "";
    state.pageElements = [];
    state.renderedPageNumbers.clear();
    state.renderingPageNumbers.clear();
    state.pageRenderQueue = Promise.resolve();
    if (state.pageRenderObserver) {
      state.pageRenderObserver.disconnect();
      state.pageRenderObserver = null;
    }

    const firstPage = await state.pdfDocument.getPage(1);
    const firstViewport = firstPage.getViewport({
      scale: state.scale,
      rotation: state.rotation,
    });
    const estimatedWidth = Math.floor(firstViewport.width);
    const estimatedHeight = Math.floor(firstViewport.height);

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const pageShell = document.createElement("div");
      pageShell.className = "pdf-page-shell";
      pageShell.dataset.pageNumber = String(pageNumber);
      pageShell.style.width = `${estimatedWidth}px`;
      pageShell.style.height = `${estimatedHeight}px`;
      pagesContainer.appendChild(pageShell);
      state.pageElements.push(pageShell);
    }

    state.pageRenderObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const pageNumber = Number(entry.target.dataset.pageNumber);
          if (!pageNumber) continue;
          requestRenderAround(pageNumber);
        }
      },
      { root: viewerContainer, rootMargin: "1200px 0px 1200px 0px", threshold: 0.01 }
    );

    for (const pageElement of state.pageElements) {
      state.pageRenderObserver.observe(pageElement);
    }

    requestRenderAround(state.currentPageNumber || 1);
    updateControls();
  } catch (error) {
    setStatus(`Render failed: ${String(error)}`);
  } finally {
    state.isRenderingAllPages = false;
  }
}

async function loadDocument(taskOptions, sourceName, sourceUrl, sourceCaption) {
  try {
    await closeActiveDocument();
    const loadingTask = pdfjsLib.getDocument(taskOptions);
    state.pdfDocument = await loadingTask.promise;
    state.currentPageNumber = 1;
    state.scale = 1.1;
    state.rotation = 0;
    state.sourceName = sourceName || "document.pdf";
    state.sourceUrl = sourceUrl || "";
    state.sourceCaption = sanitizePathCaption(sourceCaption || sourceUrl || "Local file", sourceName);
    updateControls();
    await renderContents();
    await renderAllPages();
    await renderThumbnails();
    if (state.pendingViewState) {
      const view = state.pendingViewState;
      state.pendingViewState = null;

      const restoredRotation = Number(view.rotation);
      const restoredScale = Number(view.scale);
      const needsRerender =
        (Number.isFinite(restoredRotation) &&
          restoredRotation !== state.rotation) ||
        (Number.isFinite(restoredScale) &&
          Math.abs(restoredScale - state.scale) > 0.001);

      if (Number.isFinite(restoredRotation)) {
        state.rotation =
          ((Math.round(restoredRotation / 90) * 90) % 360 + 360) % 360;
      }
      if (Number.isFinite(restoredScale)) {
        state.scale = Math.min(Math.max(0.25, restoredScale), 4);
      }

      if (needsRerender) {
        await renderAllPages();
        await renderThumbnails();
      }

      const preferredPanelMode =
        view.panelMode === "contents" || view.panelMode === "pages"
          ? view.panelMode
          : state.hasContents
            ? "contents"
            : "pages";
      setPanelMode(preferredPanelMode);
      state.panelVisible = view.panelVisible !== false;
      syncPanelLayout();

      if (Number.isFinite(Number(view.pageNumber))) {
        await setPage(Number(view.pageNumber), false);
      }
      if (Number.isFinite(Number(view.scrollTop))) {
        viewerContainer.scrollTop = Number(view.scrollTop);
      }
    } else {
      scrollToPage(1, true);
    }
    scheduleViewStatePersist();
  } catch (error) {
    setStatus(`Open failed: ${String(error)}`);
  }
}

async function openPdfFromFile(file) {
  if (!file) return;
  const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  if (!isPdf) {
    setStatus("Please choose a PDF file.");
    setDbSaveIndicator("error", "Selected file is not a PDF.");
    return;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const persistableBytes = bytes.slice();
  revokeLocalObjectUrl();
  state.localObjectUrl = URL.createObjectURL(file);
  const localCaption = sanitizePathCaption(
    file.path || file.webkitRelativePath || pdfFileInput.value || file.name,
    file.name
  );
  await loadDocument({ data: bytes }, file.name, "", localCaption);
  const previewDataUrl = await renderBookPreviewFromCurrentDocument();
  const bookKey = createLocalBookKey(file);
  state.currentBookKey = bookKey;
  setDbSaveIndicator("saving", `Saving "${file.name}" to database...`);
  const dbSaved = await saveBookFileData(bookKey, persistableBytes);
  if (dbSaved) {
    setDbSaveIndicator("saved", `Saved "${file.name}" to database.`);
  } else {
    setDbSaveIndicator("error", `Failed to save "${file.name}" to database.`);
    setStatus("Loaded PDF, but failed to store it in database.");
  }
  await upsertRecentBook({
    bookKey,
    type: "local",
    name: file.name,
    previewDataUrl,
    lastPage: state.currentPageNumber || 1,
  });
  await saveLastSession({
    type: "local",
    name: file.name,
    data: persistableBytes.buffer,
  });
}

async function openPdfFromUrl(rawValue) {
  const normalized = normalizeUrlInput(rawValue);
  if (!normalized) {
    setStatus("Enter a URL first.");
    return;
  }

  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      setStatus("Only http/https URLs are supported.");
      return;
    }
    const url = parsed.toString();
    await loadDocument({ url }, parsed.pathname.split("/").pop() || "document.pdf", url, url);
    setDbSaveIndicator("idle", "Database status not applicable for URL books.");
    const previewDataUrl = await renderBookPreviewFromCurrentDocument();
    const bookKey = createUrlBookKey(url);
    state.currentBookKey = bookKey;
    await upsertRecentBook({
      bookKey,
      type: "url",
      name: parsed.pathname.split("/").pop() || url,
      url,
      previewDataUrl,
      lastPage: state.currentPageNumber || 1,
    });
    await saveLastSession({
      type: "url",
      url,
    });
  } catch {
    setStatus("Invalid URL.");
  }
}

async function restoreLastSessionIfAny() {
  state.pendingViewState = await readViewState();
  const lastSession = await readLastSession();
  if (!lastSession) return;

  if (lastSession.type === "local" && lastSession.data) {
    try {
      const bytes = new Uint8Array(lastSession.data);
      const blob = new Blob([bytes], { type: "application/pdf" });
      revokeLocalObjectUrl();
      state.localObjectUrl = URL.createObjectURL(blob);
      await loadDocument(
        { data: bytes },
        lastSession.name || "document.pdf",
        "",
        "Restored local file"
      );
      state.currentBookKey = "";
      setDbSaveIndicator(
        "missing",
        "Restored from last session cache. Database presence is not confirmed."
      );
      setStatus(`Restored: ${lastSession.name || "document.pdf"}`);
      return;
    } catch {
      // Fallback below to URL restore if available.
    }
  }

  if (lastSession.type === "url" && typeof lastSession.url === "string") {
    await openPdfFromUrl(lastSession.url);
  }
}

function scrollToPage(pageNumber, immediate = false) {
  const pageElement = state.pageElements[pageNumber - 1];
  if (!pageElement) return;
  const targetTop = Math.max(0, pageElement.offsetTop);
  viewerContainer.scrollTo({
    top: targetTop,
    behavior: immediate ? "auto" : "smooth",
  });
}

function captureViewportAnchor(clientY = null) {
  if (!state.pageElements.length) return null;
  const containerRect = viewerContainer.getBoundingClientRect();
  const defaultOffset = viewerContainer.clientHeight / 2;
  const clampedOffset = Number.isFinite(clientY)
    ? Math.min(Math.max(clientY - containerRect.top, 0), Math.max(viewerContainer.clientHeight - 1, 0))
    : defaultOffset;
  const anchorY = viewerContainer.scrollTop + clampedOffset;
  let bestPageNumber = 1;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let i = 0; i < state.pageElements.length; i += 1) {
    const page = state.pageElements[i];
    if (!page) continue;
    const top = page.offsetTop;
    const height = Math.max(page.offsetHeight, 1);
    const bottom = top + height;
    if (anchorY >= top && anchorY <= bottom) {
      return {
        pageNumber: i + 1,
        relativeOffset: (anchorY - top) / height,
        viewportOffset: clampedOffset,
      };
    }
    const distance = Math.min(Math.abs(anchorY - top), Math.abs(anchorY - bottom));
    if (distance < bestDistance) {
      bestDistance = distance;
      bestPageNumber = i + 1;
    }
  }

  const fallbackPage = state.pageElements[bestPageNumber - 1];
  const fallbackHeight = Math.max(fallbackPage?.offsetHeight || 1, 1);
  return {
    pageNumber: bestPageNumber,
    relativeOffset: (anchorY - (fallbackPage?.offsetTop || 0)) / fallbackHeight,
    viewportOffset: clampedOffset,
  };
}

function restoreViewportAnchor(anchor) {
  if (!anchor) return;
  const pageElement = state.pageElements[anchor.pageNumber - 1];
  if (!pageElement) return;
  const clampedRelative = Math.min(Math.max(anchor.relativeOffset, 0), 1);
  const targetY =
    pageElement.offsetTop + Math.max(pageElement.offsetHeight, 1) * clampedRelative;
  const viewportOffset = Number.isFinite(anchor.viewportOffset)
    ? anchor.viewportOffset
    : viewerContainer.clientHeight / 2;
  const nextScrollTop = Math.max(0, targetY - viewportOffset);
  viewerContainer.scrollTop = nextScrollTop;
}

async function setPage(pageNumber, shouldScroll = true, immediate = false) {
  if (!state.pdfDocument) return;
  const parsed = Number(pageNumber);
  if (!Number.isFinite(parsed)) return;
  const targetPage = Math.min(Math.max(1, Math.floor(parsed)), state.pdfDocument.numPages);
  rememberCurrentPlaceForBackNavigation(targetPage, shouldScroll);
  state.currentPageNumber = targetPage;
  updateControls();
  highlightActiveThumbnail();
  highlightActiveTocEntry({ ensureVisible: shouldScroll });
  requestRenderAround(targetPage);
  scheduleViewStatePersist();
  updateCurrentBookProgress();
  if (shouldScroll) {
    scrollToPage(targetPage, immediate);
  }
}

async function setScale(nextScale, keepPageAligned = true, anchorClientY = null) {
  if (!state.pdfDocument) return;
  const anchor = keepPageAligned ? null : captureViewportAnchor(anchorClientY);
  state.scale = Math.min(Math.max(0.25, nextScale), 4);
  updateControls();
  state.suppressScrollSync = true;
  try {
    await renderAllPages();
    if (keepPageAligned) {
      scrollToPage(state.currentPageNumber);
    } else {
      restoreViewportAnchor(anchor);
      if (anchor?.pageNumber) {
        state.currentPageNumber = anchor.pageNumber;
        updateControls();
        highlightActiveThumbnail();
        highlightActiveTocEntry();
        requestRenderAround(anchor.pageNumber);
      }
    }
  } finally {
    state.suppressScrollSync = false;
  }
  scheduleViewStatePersist();
}

openFileButton.addEventListener("click", () => pdfFileInput.click());
openExternalButton.addEventListener("click", () => {
  openCurrentPdfInDefaultEditor();
});
previousBooksButton.addEventListener("click", () => {
  openPreviousBooksDialog();
});
pdfFileInput.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  await openPdfFromFile(file);
});

async function commitPageNumberInput() {
  await setPage(pageNumberInput.value, true, true);
}

pageNumberInput.addEventListener("change", commitPageNumberInput);
pageNumberInput.addEventListener("keydown", async (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  await commitPageNumberInput();
  pageNumberInput.blur();
});
pageNumberInput.addEventListener(
  "wheel",
  (event) => {
    if (document.activeElement === pageNumberInput) {
      pageNumberInput.blur();
    }
    event.preventDefault();
  },
  { passive: false }
);
contentsTabButton.addEventListener("click", () => {
  if (!state.hasContents) return;
  state.panelVisible = true;
  setPanelMode("contents");
});
pagesTabButton.addEventListener("click", () => {
  if (!state.pdfDocument) return;
  state.panelVisible = true;
  setPanelMode("pages");
});
collapseAllTocButton.addEventListener("click", () => {
  if (!state.hasContents) return;
  collapseAllTocSections();
});
tocSearchInput.addEventListener("input", () => {
  filterTocItemsByQuery(tocSearchInput.value);
});
hamburgerButton.addEventListener("click", toggleSidePanelVisibility);
sidePanelToggleButton?.addEventListener("click", toggleSidePanelVisibility);
window.addEventListener("resize", updateToolbarBookMetaLayout);

themeButton.addEventListener("click", () => {
  const isDark = document.body.classList.contains("dark");
  document.body.classList.toggle("dark", !isDark);
  document.body.classList.toggle("light", isDark);
  updateThemeButton();
});

["dragenter", "dragover"].forEach((eventName) => {
  viewerContainer.addEventListener(eventName, (event) => {
    event.preventDefault();
    viewerContainer.classList.add("drag-over");
  });
});
["dragleave", "drop"].forEach((eventName) => {
  viewerContainer.addEventListener(eventName, (event) => {
    event.preventDefault();
    viewerContainer.classList.remove("drag-over");
  });
});
viewerContainer.addEventListener("drop", async (event) => {
  const file = event.dataTransfer?.files?.[0];
  await openPdfFromFile(file);
});

viewerContainer.addEventListener("scroll", () => {
  if (state.suppressScrollSync) return;
  if (!state.pageElements.length || !state.renderedPageNumbers.size) return;
  const containerTop = viewerContainer.getBoundingClientRect().top;
  let nearestPage = state.currentPageNumber;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const pageNumber of state.renderedPageNumbers) {
    const pageElement = state.pageElements[pageNumber - 1];
    if (!pageElement) continue;
    const rect = pageElement.getBoundingClientRect();
    const distance = Math.abs(rect.top - containerTop);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestPage = pageNumber;
    }
  }

  if (nearestPage !== state.currentPageNumber) {
    setPage(nearestPage, false);
  }
  requestRenderAround(nearestPage);
  scheduleViewStatePersist();
});

viewerContainer.addEventListener(
  "wheel",
  (event) => {
    if (!state.pdfDocument || !event.ctrlKey) return;
    event.preventDefault();
    const rawStep = Math.min(Math.max(Math.abs(event.deltaY) / 600, 0.04), 0.22);
    const zoomStep = event.deltaY < 0 ? rawStep : -rawStep;
    setScale(state.scale + zoomStep, false, event.clientY);
  },
  { passive: false }
);

function initShortcutsDialog() {
  const overlay = document.getElementById("shortcutsOverlay");
  const body = document.getElementById("shortcutsDialogBody");
  const help = document.getElementById("shortcutsHelpButton");
  const closeBtn = document.getElementById("shortcutsCloseButton");
  const doneBtn = document.getElementById("shortcutsDoneButton");
  const refreshBtn = document.getElementById("shortcutsRefreshButton");
  const openOptsBtn = document.getElementById("shortcutsOpenOptionsButton");
  if (!overlay || !body || !help || !closeBtn || !doneBtn || !refreshBtn || !openOptsBtn) {
    return;
  }

  async function openShortcutsDialog() {
    overlay.classList.remove("hidden");
    overlay.setAttribute("aria-hidden", "false");
    try {
      await mountShortcutsUi(body);
    } catch (error) {
      body.textContent = "";
      const p = document.createElement("p");
      p.className = "shortcuts-intro";
      p.textContent = String(error?.message || error);
      body.appendChild(p);
    }
  }

  function closeShortcutsDialog() {
    overlay.classList.add("hidden");
    overlay.setAttribute("aria-hidden", "true");
  }

  help.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void openShortcutsDialog();
  });
  closeBtn.addEventListener("click", closeShortcutsDialog);
  doneBtn.addEventListener("click", closeShortcutsDialog);
  refreshBtn.addEventListener("click", async () => {
    try {
      await mountShortcutsUi(body);
    } catch (error) {
      body.textContent = "";
      const p = document.createElement("p");
      p.className = "shortcuts-intro";
      p.textContent = String(error?.message || error);
      body.appendChild(p);
    }
  });
  openOptsBtn.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      closeShortcutsDialog();
    }
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !overlay.classList.contains("hidden")) {
      closeShortcutsDialog();
    }
  });
}

function initPreviousBooksDialog() {
  if (
    !previousBooksOverlay ||
    !previousBooksCloseButton ||
    !previousBooksButton ||
    !previousBooksList ||
    !previousBooksEmpty
  ) {
    return;
  }
  previousBooksCloseButton.addEventListener("click", closePreviousBooksDialog);
  previousBooksOverlay.addEventListener("click", (event) => {
    if (event.target === previousBooksOverlay) {
      closePreviousBooksDialog();
    }
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !previousBooksOverlay.classList.contains("hidden")) {
      closePreviousBooksDialog();
    }
  });
}

function initMetadataDialog() {
  if (!metadataOverlay || !metadataCloseButton || !metadataButton) return;
  metadataButton.addEventListener("click", () => {
    void openMetadataDialog();
  });
  metadataCloseButton.addEventListener("click", closeMetadataDialog);
  metadataOverlay.addEventListener("click", (event) => {
    if (event.target === metadataOverlay) {
      closeMetadataDialog();
    }
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !metadataOverlay.classList.contains("hidden")) {
      closeMetadataDialog();
    }
  });
}

window.addEventListener("keydown", async (event) => {
  if (isEditableTarget(event.target)) return;
  if (isHotkeyMatch(event, state.customHotkeys.viewerPreviousPlace)) {
    event.preventDefault();
    await goToPreviousPlace();
    return;
  }
  if (isHotkeyMatch(event, state.customHotkeys.viewerWhatIs)) {
    return;
  }
  if (isHotkeyMatch(event, state.customHotkeys.viewerEtymology)) {
    return;
  }
  if (isHotkeyMatch(event, state.customHotkeys.viewerTranslateRu)) {
    return;
  }
  if (event.ctrlKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "o") {
    event.preventDefault();
    pdfFileInput.click();
    return;
  }
  if (!state.pdfDocument) return;
  if (event.key === "ArrowLeft") {
    await setPage(state.currentPageNumber - 1);
  } else if (event.key === "ArrowRight") {
    await setPage(state.currentPageNumber + 1);
  } else if (event.key === "PageUp") {
    await setPage(state.currentPageNumber - 1);
  } else if (event.key === "PageDown") {
    await setPage(state.currentPageNumber + 1);
  } else if (event.key === "+") {
    await setScale(state.scale + 0.1);
  } else if (event.key === "-") {
    await setScale(state.scale - 0.1);
  } else if (event.key.toLowerCase() === "r") {
    state.rotation = (state.rotation + 90) % 360;
    await renderAllPages();
    await renderThumbnails();
    scrollToPage(state.currentPageNumber);
  }
}, true);

window.addEventListener("beforeunload", async () => {
  try {
    await chrome.storage.local.set({ [PDF_VIEWER_SELECTION_KEY]: "" });
  } catch {
    // Ignore storage failures.
  }
  saveViewState(buildCurrentViewState());
  await closeActiveDocument();
});

document.addEventListener("selectionchange", () => {
  persistPdfViewerSelection();
});

initShortcutsDialog();
initPreviousBooksDialog();
initMetadataDialog();
loadCustomHotkeys();
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.customViewerHotkeys) {
    loadCustomHotkeys();
  }
});

updateControls();
updateThemeButton();
setDbSaveIndicator("idle");
restoreLastSessionIfAny();
