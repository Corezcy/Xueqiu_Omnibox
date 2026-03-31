const DEFAULT_INDEX_CODES = ["sh000001", "sz399001", "sz399006"];
const STOCK_FILE = "stock.txt";
const REFRESH_INTERVAL_MS = 2000;
const REFRESH_SETTINGS_STORAGE_KEY = "quoteRefreshSettings";
const SUPPORTED_REFRESH_INTERVALS_MS = [1000, 2000, 5000, 10000];
const CN_CODE_PATTERN = /^(sh|sz)(\d{6})$/i;
const HK_CODE_PATTERN = /^hk(?:[.:_-])?(\d{1,5})$/i;
const US_CODE_PATTERN = /^us(?:[.:_-])?([a-z][a-z0-9.-]{0,19})$/i;

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", () => {
  const input = document.getElementById("stockInput");
  const quoteBody = document.getElementById("quoteBody");
  const fetchState = document.getElementById("fetchState");
  const updateTime = document.getElementById("updateTime");
  const errorBanner = document.getElementById("errorBanner");
  const autoRefreshToggle = document.getElementById("autoRefreshToggle");
  const refreshIntervalSelect = document.getElementById("refreshInterval");
  const sourceNote = document.getElementById("sourceNote");

  let watchCodes = [];
  let refreshTimer = null;
  let isFetching = false;
  let allCodes = [...DEFAULT_INDEX_CODES];
  let refreshSettings = normalizeRefreshSettings();

  input.focus();

  input.addEventListener("keypress", (event) => {
    if (event.key !== "Enter") {
      return;
    }

    const code = normalizeCode(input.value) || input.value.trim().toUpperCase();
    if (!code) {
      return;
    }

    chrome.tabs.create({ url: `https://xueqiu.com/S/${code.toUpperCase()}` });
    window.close();
  });

  quoteBody.addEventListener("click", (event) => {
    const row = event.target.closest("tr[data-code]");
    if (!row) {
      return;
    }
    const code = row.dataset.code;
    if (code) {
      chrome.tabs.create({ url: `https://xueqiu.com/S/${code.toUpperCase()}` });
    }
  });

  autoRefreshToggle.addEventListener("change", () => {
    void handleRefreshToggleChange();
  });

  refreshIntervalSelect.addEventListener("change", () => {
    void handleRefreshIntervalChange();
  });

  window.addEventListener("beforeunload", () => {
    stopAutoRefresh();
  });

  initialize().catch((error) => {
    setFetchState(fetchState, "初始化失败");
    showError(errorBanner, `初始化失败：${error.message}`);
    console.error(error);
  });

  async function initialize() {
    refreshSettings = await loadRefreshSettings();
    applyRefreshSettingsToControls();
    watchCodes = await loadWatchCodes(STOCK_FILE);
    allCodes = mergeCodes(DEFAULT_INDEX_CODES, watchCodes);
    const initialIndexRows = DEFAULT_INDEX_CODES.map((code) =>
      toQuoteRow(code)
    );
    const initialWatchRows = watchCodes.map((code) => toQuoteRow(code));
    renderTable(quoteBody, initialIndexRows, initialWatchRows);

    await refreshQuotes();
    syncAutoRefreshTimer();
  }

  async function refreshQuotes() {
    if (isFetching || allCodes.length === 0) {
      return;
    }

    isFetching = true;
    setFetchState(fetchState, "刷新中...", true);

    try {
      const quoteMap = await fetchTencentQuotes(allCodes);
      const indexRows = DEFAULT_INDEX_CODES.map((code) =>
        toQuoteRow(code, quoteMap.get(code))
      );
      const watchRows = watchCodes.map((code) =>
        toQuoteRow(code, quoteMap.get(code))
      );
      renderTable(quoteBody, indexRows, watchRows);

      hideError(errorBanner);
      updateTime.textContent = currentTime();
      setFetchState(fetchState, "已更新");
    } catch (error) {
      setFetchState(fetchState, "刷新失败");
      showError(errorBanner, `行情刷新失败：${error.message}`);
      console.error(error);
    } finally {
      isFetching = false;
    }
  }

  async function handleRefreshToggleChange() {
    refreshSettings = normalizeRefreshSettings({
      ...refreshSettings,
      enabled: autoRefreshToggle.checked,
    });
    applyRefreshSettingsToControls();
    await saveRefreshSettings(refreshSettings);

    if (refreshSettings.enabled) {
      await refreshQuotes();
    } else {
      setFetchState(fetchState, "自动刷新已关闭");
    }

    syncAutoRefreshTimer();
  }

  async function handleRefreshIntervalChange() {
    refreshSettings = normalizeRefreshSettings({
      ...refreshSettings,
      intervalMs: Number(refreshIntervalSelect.value),
    });
    applyRefreshSettingsToControls();
    await saveRefreshSettings(refreshSettings);
    syncAutoRefreshTimer();

    if (refreshSettings.enabled) {
      await refreshQuotes();
    }
  }

  function applyRefreshSettingsToControls() {
    autoRefreshToggle.checked = refreshSettings.enabled;
    refreshIntervalSelect.value = String(refreshSettings.intervalMs);
    refreshIntervalSelect.disabled = !refreshSettings.enabled;
    sourceNote.textContent = getSourceNoteText(refreshSettings);
  }

  function syncAutoRefreshTimer() {
    stopAutoRefresh();
    if (!refreshSettings.enabled) {
      return;
    }

    refreshTimer = window.setInterval(() => {
      void refreshQuotes();
    }, refreshSettings.intervalMs);
  }

  function stopAutoRefresh() {
    if (!refreshTimer) {
      return;
    }
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  });
}

async function loadRefreshSettings() {
  const defaultSettings = normalizeRefreshSettings();

  if (
    typeof chrome === "undefined" ||
    !chrome.storage ||
    !chrome.storage.local
  ) {
    return defaultSettings;
  }

  const stored = await chrome.storage.local.get(REFRESH_SETTINGS_STORAGE_KEY);
  return normalizeRefreshSettings(stored[REFRESH_SETTINGS_STORAGE_KEY]);
}

async function saveRefreshSettings(settings) {
  if (
    typeof chrome === "undefined" ||
    !chrome.storage ||
    !chrome.storage.local
  ) {
    return;
  }

  await chrome.storage.local.set({
    [REFRESH_SETTINGS_STORAGE_KEY]: normalizeRefreshSettings(settings),
  });
}

function normalizeRefreshSettings(raw = {}) {
  const enabled =
    typeof raw.enabled === "boolean" ? raw.enabled : true;
  const intervalMs = SUPPORTED_REFRESH_INTERVALS_MS.includes(raw.intervalMs)
    ? raw.intervalMs
    : REFRESH_INTERVAL_MS;

  return { enabled, intervalMs };
}

function getSourceNoteText(settings) {
  if (!settings.enabled) {
    return "数据源：腾讯行情接口，自动刷新已关闭";
  }

  return `数据源：腾讯行情接口，每 ${formatIntervalLabel(
    settings.intervalMs
  )} 自动刷新`;
}

function formatIntervalLabel(intervalMs) {
  return `${intervalMs / 1000} 秒`;
}

async function loadWatchCodes(filename) {
  const url = chrome.runtime.getURL(filename);
  const response = await fetch(url, { cache: "no-store" });

  if (!response.ok) {
    throw new Error(`读取 ${filename} 失败 (${response.status})`);
  }

  const content = await response.text();
  const lines = content.split(/\r?\n/);
  const uniqueCodes = [];
  const seen = new Set();

  for (const line of lines) {
    const code = normalizeCode(line);
    if (!code || seen.has(code)) {
      continue;
    }
    seen.add(code);
    uniqueCodes.push(code);
  }

  return uniqueCodes;
}

function mergeCodes(indexCodes, watchCodes) {
  const codes = [...indexCodes];
  const indexSet = new Set(indexCodes);

  for (const code of watchCodes) {
    if (!indexSet.has(code)) {
      codes.push(code);
    }
  }

  return codes;
}

async function fetchTencentQuotes(codes) {
  const query = codes.join(",");
  const response = await fetch(`https://qt.gtimg.cn/q=${query}`, {
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`腾讯接口请求失败 (${response.status})`);
  }

  const buffer = await response.arrayBuffer();
  const text = decodeTencentPayload(buffer);
  return parseTencentPayload(text);
}

function decodeTencentPayload(buffer) {
  try {
    return new TextDecoder("gbk").decode(buffer);
  } catch (error) {
    return new TextDecoder("utf-8").decode(buffer);
  }
}

function parseTencentPayload(payload) {
  const rows = payload.split(/;\s*/);
  const map = new Map();

  for (const row of rows) {
    const trimmed = row.trim();
    if (!trimmed) {
      continue;
    }

    const matched = trimmed.match(/^v_([^=]+)="([^"]*)"$/);
    if (!matched) {
      continue;
    }

    const code = normalizeCode(matched[1]);
    if (!code) {
      continue;
    }
    const fields = matched[2].split("~");
    if (fields.length < 35) {
      continue;
    }

    map.set(code, {
      code,
      name: fields[1] || "--",
      latest: toNumber(fields[3]),
      changePercent: toNumber(fields[32]),
      open: toNumber(fields[5]),
      high: toNumber(fields[33]),
      low: toNumber(fields[34]),
    });
  }

  return map;
}

function toQuoteRow(code, quote) {
  if (!quote) {
    return {
      code,
      name: "--",
      latest: null,
      changePercent: null,
      open: null,
      high: null,
      low: null,
    };
  }

  return quote;
}

function renderTable(tbody, indexRows, watchRows) {
  const html = [];
  html.push(sectionRowHtml("指数"));
  for (const row of indexRows) {
    html.push(dataRowHtml(row));
  }

  html.push(sectionRowHtml("自选"));

  if (watchRows.length === 0) {
    html.push(
      '<tr><td class="empty" colspan="7">stock.txt 为空，请添加代码后重新打开弹窗</td></tr>'
    );
  } else {
    for (const row of watchRows) {
      html.push(dataRowHtml(row));
    }
  }

  tbody.innerHTML = html.join("");
}

function sectionRowHtml(title) {
  return `<tr><td class="section-cell" colspan="7">${escapeHtml(
    title
  )}</td></tr>`;
}

function dataRowHtml(row) {
  const changeClass = classifyChange(row.changePercent);
  return `
    <tr class="data-row" data-code="${escapeHtml(row.code)}">
      <td class="code">${escapeHtml(row.code)}</td>
      <td>${escapeHtml(formatName(row.name))}</td>
      <td class="num">${formatPrice(row.latest)}</td>
      <td class="num chg ${changeClass}">${formatChange(row.changePercent)}</td>
      <td class="num">${formatPrice(row.open)}</td>
      <td class="num">${formatPrice(row.high)}</td>
      <td class="num">${formatPrice(row.low)}</td>
    </tr>
  `;
}

function normalizeCode(raw) {
  if (!raw) {
    return "";
  }

  const code = raw.trim();
  if (!code || code.startsWith("#")) {
    return "";
  }

  const cnMatch = code.match(CN_CODE_PATTERN);
  if (cnMatch) {
    return `${cnMatch[1].toLowerCase()}${cnMatch[2]}`;
  }

  const hkMatch = code.match(HK_CODE_PATTERN);
  if (hkMatch) {
    return `hk${hkMatch[1].padStart(5, "0")}`;
  }

  const usMatch = code.match(US_CODE_PATTERN);
  if (usMatch) {
    return `us${usMatch[1].toUpperCase()}`;
  }

  return "";
}

function formatName(name) {
  return Array.from(String(name || ""))
    .slice(0, 8)
    .join("");
}

function toNumber(raw) {
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : null;
}

function formatPrice(value) {
  if (value === null) {
    return "--";
  }
  return value.toFixed(2);
}

function formatChange(value) {
  if (value === null) {
    return "--";
  }

  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(2)}%`;
}

function classifyChange(value) {
  if (value === null || value === 0) {
    return "flat";
  }
  return value > 0 ? "up" : "down";
}

function setFetchState(element, text, loading = false) {
  element.textContent = text;
  element.classList.toggle("loading", loading);
}

function showError(element, message) {
  element.textContent = message;
  element.classList.remove("hidden");
}

function hideError(element) {
  element.textContent = "";
  element.classList.add("hidden");
}

function currentTime() {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    normalizeRefreshSettings,
    getSourceNoteText,
    formatIntervalLabel,
  };
}
