import * as pdfjsLib from "./vendor/pdfjs/pdf.min.mjs";
import { getCustomHotkeys, isHotkeyMatch, mountShortcutsUi } from "./shortcuts-ui.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdfjs/pdf.worker.min.mjs");

const pdfFileInput = document.getElementById("pdfFileInput");
const hamburgerButton = document.getElementById("hamburgerButton");
const openFileButton = document.getElementById("openFileButton");
const pdfUrlInput = document.getElementById("pdfUrlInput");
const openUrlButton = document.getElementById("openUrlButton");
const downloadButton = document.getElementById("downloadButton");
const contentsTabButton = document.getElementById("contentsTabButton");
const pagesTabButton = document.getElementById("pagesTabButton");
const themeButton = document.getElementById("themeButton");
const pageNumberInput = document.getElementById("pageNumberInput");
const pageCountLabel = document.getElementById("pageCountLabel");
const zoomOutButton = document.getElementById("zoomOutButton");
const zoomInButton = document.getElementById("zoomInButton");
const zoomLabel = document.getElementById("zoomLabel");
const fitWidthButton = document.getElementById("fitWidthButton");
const rotateButton = document.getElementById("rotateButton");
const sidePanel = document.getElementById("sidePanel");
const contentsPanel = document.getElementById("contentsPanel");
const thumbnailsPanel = document.getElementById("thumbnailsPanel");
const tocList = document.getElementById("tocList");
const tocEmpty = document.getElementById("tocEmpty");
const thumbsList = document.getElementById("thumbsList");
const thumbsEmpty = document.getElementById("thumbsEmpty");
const viewerContainer = document.getElementById("viewerContainer");
const pagesContainer = document.getElementById("pagesContainer");
const statusText = document.getElementById("statusText");

const LAST_SESSION_DB_NAME = "pdf-viewer-cache";
const LAST_SESSION_STORE_NAME = "kv";
const LAST_SESSION_KEY = "last-session";
const LAST_VIEW_KEY = "last-view";

const state = {
  pdfDocument: null,
  currentPageNumber: 1,
  scale: 1.1,
  rotation: 0,
  localObjectUrl: "",
  sourceName: "document.pdf",
  sourceUrl: "",
  isRenderingAllPages: false,
  pageElements: [],
  hasContents: false,
  panelMode: null,
  panelVisible: true,
  pendingViewState: null,
  customHotkeys: {
    viewerWhatIs: "Ctrl+Alt+W",
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

function setStatus(message) {
  statusText.textContent = message;
}

function updateThemeButton() {
  const isDark = document.body.classList.contains("dark");
  themeButton.textContent = isDark ? "☀" : "☾";
}

function normalizeUrlInput(rawValue) {
  const value = rawValue.trim();
  if (!value) return "";
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

function openLastSessionDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(LAST_SESSION_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(LAST_SESSION_STORE_NAME)) {
        database.createObjectStore(LAST_SESSION_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
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
  zoomInButton.disabled = !hasDocument;
  zoomOutButton.disabled = !hasDocument;
  fitWidthButton.disabled = !hasDocument;
  rotateButton.disabled = !hasDocument;
  downloadButton.disabled = !hasDocument;
  contentsTabButton.disabled = !hasDocument || !state.hasContents;
  pagesTabButton.disabled = !hasDocument;

  pageNumberInput.value = String(state.currentPageNumber || 1);
  pageCountLabel.textContent = `/${pageCount}`;
  zoomLabel.textContent = `${Math.round(state.scale * 100)}%`;
}

function highlightActiveTocEntry() {
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
}

function revokeLocalObjectUrl() {
  if (state.localObjectUrl) {
    URL.revokeObjectURL(state.localObjectUrl);
    state.localObjectUrl = "";
  }
}

function setPanelMode(mode) {
  state.panelMode = mode;
  const isOpen = mode === "contents" || mode === "pages";
  if (!isOpen) {
    state.panelVisible = false;
  }
  sidePanel.classList.toggle("hidden", !isOpen || !state.panelVisible);
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

function renderOutlineNodes(parentList, nodes, pageEntries = []) {
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
    pageSpan.textContent = typeof item.pageNumber === "number" ? String(item.pageNumber) : "";

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
      toggleButton.textContent = "-";
      toggleButton.setAttribute("aria-label", `Toggle ${item.title}`);
      toggleButton.setAttribute("aria-expanded", "true");
      row.appendChild(toggleButton);

      childList = document.createElement("ul");
      childList.className = "toc-sublist";
      renderOutlineNodes(childList, item.children, pageEntries);

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

    if (showPreview) {
      const palette = tocPreviewPaletteVars(item.title, previewPage);
      const previewIcon = document.createElement("span");
      previewIcon.className = "toc-item-preview-icon";
      previewIcon.style.setProperty("--toc-dot-a", palette.a);
      previewIcon.style.setProperty("--toc-dot-b", palette.b);
      previewIcon.setAttribute("aria-hidden", "true");
      row.appendChild(previewIcon);
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
  state.hasContents = false;
  state.tocPageEntries = [];
  state.activeTocButton = null;
  if (!state.pdfDocument) {
    updateControls();
    return;
  }

  const outline = await state.pdfDocument.getOutline();
  const mappedOutline = await mapOutlineItems(outline);
  if (!mappedOutline.length) {
    if (state.panelMode === "contents") {
      setPanelMode(null);
    }
    updateControls();
    return;
  }

  const pageEntries = [];
  renderOutlineNodes(tocList, mappedOutline, pageEntries);
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
    setStatus(`Loaded ${pageCount} pages (lazy render enabled)`);
    updateControls();
  } catch (error) {
    setStatus(`Render failed: ${String(error)}`);
  } finally {
    state.isRenderingAllPages = false;
  }
}

async function loadDocument(taskOptions, sourceName, sourceUrl) {
  try {
    await closeActiveDocument();
    setStatus("Loading PDF...");
    const loadingTask = pdfjsLib.getDocument(taskOptions);
    state.pdfDocument = await loadingTask.promise;
    state.currentPageNumber = 1;
    state.scale = 1.1;
    state.rotation = 0;
    state.sourceName = sourceName || "document.pdf";
    state.sourceUrl = sourceUrl || "";
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
      sidePanel.classList.toggle("hidden", !state.panelVisible);

      if (Number.isFinite(Number(view.pageNumber))) {
        await setPage(Number(view.pageNumber), false);
      }
      if (Number.isFinite(Number(view.scrollTop))) {
        viewerContainer.scrollTop = Number(view.scrollTop);
      }
    } else {
      scrollToPage(1);
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
    return;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  revokeLocalObjectUrl();
  state.localObjectUrl = URL.createObjectURL(file);
  await loadDocument({ data: bytes }, file.name, "");
  await saveLastSession({
    type: "local",
    name: file.name,
    data: bytes.buffer,
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
    await loadDocument({ url }, parsed.pathname.split("/").pop() || "document.pdf", url);
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
        ""
      );
      setStatus(`Restored: ${lastSession.name || "document.pdf"}`);
      return;
    } catch {
      // Fallback below to URL restore if available.
    }
  }

  if (lastSession.type === "url" && typeof lastSession.url === "string") {
    pdfUrlInput.value = lastSession.url;
    await openPdfFromUrl(lastSession.url);
  }
}

function scrollToPage(pageNumber, immediate = false) {
  const pageElement = state.pageElements[pageNumber - 1];
  if (!pageElement) return;
  pageElement.scrollIntoView({
    behavior: immediate ? "auto" : "smooth",
    block: "start",
  });
}

function captureViewportAnchor() {
  if (!state.pageElements.length) return null;
  const viewportCenter = viewerContainer.scrollTop + viewerContainer.clientHeight / 2;
  let bestPageNumber = 1;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let i = 0; i < state.pageElements.length; i += 1) {
    const page = state.pageElements[i];
    if (!page) continue;
    const top = page.offsetTop;
    const height = Math.max(page.offsetHeight, 1);
    const bottom = top + height;
    if (viewportCenter >= top && viewportCenter <= bottom) {
      return {
        pageNumber: i + 1,
        relativeOffset: (viewportCenter - top) / height,
      };
    }
    const distance = Math.min(Math.abs(viewportCenter - top), Math.abs(viewportCenter - bottom));
    if (distance < bestDistance) {
      bestDistance = distance;
      bestPageNumber = i + 1;
    }
  }

  const fallbackPage = state.pageElements[bestPageNumber - 1];
  const fallbackHeight = Math.max(fallbackPage?.offsetHeight || 1, 1);
  return {
    pageNumber: bestPageNumber,
    relativeOffset: (viewportCenter - (fallbackPage?.offsetTop || 0)) / fallbackHeight,
  };
}

function restoreViewportAnchor(anchor) {
  if (!anchor) return;
  const pageElement = state.pageElements[anchor.pageNumber - 1];
  if (!pageElement) return;
  const clampedRelative = Math.min(Math.max(anchor.relativeOffset, 0), 1);
  const targetCenter =
    pageElement.offsetTop + Math.max(pageElement.offsetHeight, 1) * clampedRelative;
  const nextScrollTop = Math.max(0, targetCenter - viewerContainer.clientHeight / 2);
  viewerContainer.scrollTop = nextScrollTop;
}

async function setPage(pageNumber, shouldScroll = true, immediate = false) {
  if (!state.pdfDocument) return;
  const parsed = Number(pageNumber);
  if (!Number.isFinite(parsed)) return;
  const targetPage = Math.min(Math.max(1, Math.floor(parsed)), state.pdfDocument.numPages);
  state.currentPageNumber = targetPage;
  updateControls();
  highlightActiveThumbnail();
  highlightActiveTocEntry();
  requestRenderAround(targetPage);
  scheduleViewStatePersist();
  if (shouldScroll) {
    scrollToPage(targetPage, immediate);
  }
}

async function setScale(nextScale, keepPageAligned = true) {
  if (!state.pdfDocument) return;
  const anchor = keepPageAligned ? null : captureViewportAnchor();
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

async function fitToWidth() {
  if (!state.pdfDocument) return;
  const page = await state.pdfDocument.getPage(1);
  const viewport = page.getViewport({ scale: 1, rotation: state.rotation });
  const availableWidth = Math.max(320, viewerContainer.clientWidth - 32);
  await setScale(availableWidth / viewport.width);
}

function triggerDownload() {
  if (!state.pdfDocument) return;
  const anchor = document.createElement("a");
  anchor.download = state.sourceName || "document.pdf";
  anchor.href = state.localObjectUrl || state.sourceUrl;
  if (!anchor.href) return;
  anchor.click();
}

openFileButton.addEventListener("click", () => pdfFileInput.click());
pdfFileInput.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  await openPdfFromFile(file);
});

openUrlButton.addEventListener("click", async () => {
  await openPdfFromUrl(pdfUrlInput.value);
});

pdfUrlInput.addEventListener("keydown", async (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    await openPdfFromUrl(pdfUrlInput.value);
  }
});

pageNumberInput.addEventListener("change", async () => setPage(pageNumberInput.value));
zoomOutButton.addEventListener("click", async () => setScale(state.scale - 0.1));
zoomInButton.addEventListener("click", async () => setScale(state.scale + 0.1));
fitWidthButton.addEventListener("click", async () => fitToWidth());
rotateButton.addEventListener("click", async () => {
  state.rotation = (state.rotation + 90) % 360;
  await renderAllPages();
  await renderThumbnails();
  scrollToPage(state.currentPageNumber);
  scheduleViewStatePersist();
});
downloadButton.addEventListener("click", triggerDownload);
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
hamburgerButton.addEventListener("click", () => {
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
  sidePanel.classList.toggle("hidden", !state.panelVisible);
  scheduleViewStatePersist();
});

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
    setScale(state.scale + zoomStep, false);
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

window.addEventListener("keydown", async (event) => {
  if (isHotkeyMatch(event, state.customHotkeys.viewerWhatIs)) {
    event.preventDefault();
    const selectedText = window.getSelection().toString().trim();
    if (selectedText) {
      const query = encodeURIComponent(`What is ${selectedText}`);
      chrome.tabs.create({ url: `https://www.google.com/search?q=${query}` });
    }
    return;
  }
  if (isHotkeyMatch(event, state.customHotkeys.viewerTranslateRu)) {
    event.preventDefault();
    const selectedText = window.getSelection().toString().trim();
    if (selectedText) {
      const text = encodeURIComponent(selectedText);
      chrome.tabs.create({
        url: `https://translate.google.com/?sl=auto&tl=ru&text=${text}`,
      });
    }
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
  saveViewState(buildCurrentViewState());
  await closeActiveDocument();
});

initShortcutsDialog();
loadCustomHotkeys();
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.customViewerHotkeys) {
    loadCustomHotkeys();
  }
});

updateControls();
updateThemeButton();
restoreLastSessionIfAny();
