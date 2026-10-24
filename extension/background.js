"use strict";

try {
  importScripts("lib/core.js");
} catch (error) {
  console.error("Unfold could not load its core text module", error);
}

const ext = globalThis.browser || globalThis.chrome;
const Core = globalThis.UnfoldCore;

// Publishable Pollinations App Key used only to attribute Device Flow sign-ins.
// It is not a secret. Fill this after creating the Unfold App Key.
const UNFOLD_APP_KEY = "pk_UpkWwnVCGEsvwI0W";

const GEN_CHAT_URL = "https://gen.pollinations.ai/v1/chat/completions";
const DEVICE_CODE_URL = "https://enter.pollinations.ai/api/device/code";
const DEVICE_TOKEN_URL = "https://enter.pollinations.ai/api/device/token";
const USERINFO_URL = "https://enter.pollinations.ai/api/oauth/userinfo";
const DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash";
const CACHE_LIMIT = 100;

const KEYS = {
  auth: "unfoldAuthV1",
  settings: "unfoldSettingsV1",
  cache: "unfoldCacheV1",
  pendingDevice: "unfoldPendingDeviceV1",
};

const DEFAULT_SETTINGS = Object.freeze({
  model: DEFAULT_MODEL,
  customModel: "",
  cacheEnabled: true,
  maxDepth: 3,
});

function storageGet(keys) {
  return ext.storage.local.get(keys);
}

function storageSet(values) {
  return ext.storage.local.set(values);
}

function storageRemove(keys) {
  return ext.storage.local.remove(keys);
}

async function getSettings() {
  const stored = await storageGet({ [KEYS.settings]: {} });
  const settings = { ...DEFAULT_SETTINGS, ...(stored[KEYS.settings] || {}) };
  settings.maxDepth = Math.max(0, Math.min(5, Number(settings.maxDepth) || DEFAULT_SETTINGS.maxDepth));
  settings.cacheEnabled = settings.cacheEnabled !== false;
  return settings;
}

function effectiveModel(settings) {
  return String(settings.customModel || settings.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
}

async function getAuth() {
  const stored = await storageGet({ [KEYS.auth]: null });
  const auth = stored[KEYS.auth];
  if (!auth?.apiKey) return null;
  if (auth.expiresAt && Date.parse(auth.expiresAt) <= Date.now()) {
    await storageRemove(KEYS.auth);
    return null;
  }
  return auth;
}

async function saveAuth(apiKey, source, expiresInSeconds) {
  const auth = {
    apiKey,
    source,
    obtainedAt: new Date().toISOString(),
    expiresAt: expiresInSeconds ? new Date(Date.now() + Number(expiresInSeconds) * 1000).toISOString() : null,
    username: "",
  };
  await storageSet({ [KEYS.auth]: auth });
  return auth;
}

async function publicStatus() {
  const [settings, auth, stored] = await Promise.all([
    getSettings(),
    getAuth(),
    storageGet({ [KEYS.cache]: {} }),
  ]);
  const cache = stored[KEYS.cache] || {};
  return {
    connected: Boolean(auth),
    username: auth?.username || "",
    source: auth?.source || "",
    expiresAt: auth?.expiresAt || null,
    model: effectiveModel(settings),
    settings,
    cacheEntries: Object.keys(cache).length,
    appKeyConfigured: Boolean(UNFOLD_APP_KEY),
  };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text.slice(0, 500) };
  }
  return { response, data };
}

function apiErrorMessage(data, fallback) {
  const value = data?.error?.message || data?.error || data?.message || data?.error_description || fallback;
  return typeof value === "string" ? value : JSON.stringify(value);
}

async function startDeviceAuth() {
  if (!UNFOLD_APP_KEY) {
    return {
      ok: false,
      code: "APP_KEY_NOT_CONFIGURED",
      message: "This Unfold build does not have its publishable Pollinations App Key configured yet. Use your own API key below, or finish the developer setup in the README.",
    };
  }

  const { response, data } = await fetchJson(DEVICE_CODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: UNFOLD_APP_KEY }),
  });
  if (!response.ok || !data.device_code) {
    return { ok: false, code: "DEVICE_CODE_FAILED", message: apiErrorMessage(data, `Device code request failed (${response.status}).`) };
  }

  const pending = {
    deviceCode: data.device_code,
    userCode: data.user_code || "",
    verificationUri: data.verification_uri || "https://enter.pollinations.ai/device",
    verificationUriComplete: data.verification_uri_complete || data.verification_uri || "https://enter.pollinations.ai/device",
    interval: Math.max(2, Number(data.interval) || 5),
    expiresAt: Date.now() + Math.max(60, Number(data.expires_in) || 1800) * 1000,
  };
  await storageSet({ [KEYS.pendingDevice]: pending });
  return {
    ok: true,
    status: "pending",
    userCode: pending.userCode,
    verificationUri: pending.verificationUri,
    verificationUriComplete: pending.verificationUriComplete,
    interval: pending.interval,
    expiresAt: pending.expiresAt,
  };
}

async function pollDeviceAuth() {
  const stored = await storageGet({ [KEYS.pendingDevice]: null });
  const pending = stored[KEYS.pendingDevice];
  if (!pending?.deviceCode) return { ok: false, status: "idle", code: "NO_PENDING_DEVICE", message: "Start Pollinations sign-in first." };
  if (pending.expiresAt && pending.expiresAt <= Date.now()) {
    await storageRemove(KEYS.pendingDevice);
    return { ok: false, status: "expired", code: "DEVICE_EXPIRED", message: "That sign-in code expired. Start again." };
  }

  const { response, data } = await fetchJson(DEVICE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_code: pending.deviceCode }),
  });

  if (data.access_token) {
    await saveAuth(data.access_token, "device", data.expires_in || 7 * 24 * 60 * 60);
    await storageRemove(KEYS.pendingDevice);
    return { ok: true, status: "connected", ...(await publicStatus()) };
  }

  const errorCode = typeof data.error === "string" ? data.error : data?.error?.code;
  if (errorCode === "authorization_pending" || response.status === 428) {
    return { ok: true, status: "pending", interval: pending.interval, userCode: pending.userCode, verificationUriComplete: pending.verificationUriComplete };
  }
  if (errorCode === "slow_down") {
    pending.interval = Math.min(30, (pending.interval || 5) + 5);
    await storageSet({ [KEYS.pendingDevice]: pending });
    return { ok: true, status: "pending", interval: pending.interval, userCode: pending.userCode, verificationUriComplete: pending.verificationUriComplete };
  }

  await storageRemove(KEYS.pendingDevice);
  return {
    ok: false,
    status: "failed",
    code: errorCode || "DEVICE_TOKEN_FAILED",
    message: apiErrorMessage(data, `Device sign-in failed (${response.status}).`),
  };
}

async function whoAmI() {
  const auth = await getAuth();
  if (!auth) return { ok: false, code: "NOT_CONNECTED", message: "Connect Pollinations first." };
  const { response, data } = await fetchJson(USERINFO_URL, {
    headers: { Authorization: `Bearer ${auth.apiKey}` },
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) await storageRemove(KEYS.auth);
    return { ok: false, code: "USERINFO_FAILED", message: apiErrorMessage(data, `Could not verify this key (${response.status}).`) };
  }
  auth.username = data.preferred_username || data.name || "";
  await storageSet({ [KEYS.auth]: auth });
  return { ok: true, ...(await publicStatus()) };
}

async function readCache() {
  const stored = await storageGet({ [KEYS.cache]: {} });
  return stored[KEYS.cache] && typeof stored[KEYS.cache] === "object" ? stored[KEYS.cache] : {};
}

async function writeCache(cache) {
  const entries = Object.entries(cache)
    .sort((a, b) => Date.parse(b[1]?.createdAt || 0) - Date.parse(a[1]?.createdAt || 0))
    .slice(0, CACHE_LIMIT);
  await storageSet({ [KEYS.cache]: Object.fromEntries(entries) });
}

async function fetchCompletion(apiKey, payload, useJsonMode) {
  const body = { ...payload };
  if (useJsonMode) body.response_format = { type: "json_object" };
  return fetchJson(GEN_CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function transform(message) {
  if (!Core) return { ok: false, code: "CORE_MISSING", message: "Unfold's text module failed to load. Reload the extension." };

  const action = String(message.action || "");
  const validation = Core.validateSelectionText(message.text);
  if (!Core.ACTIONS[action]) return { ok: false, code: "UNKNOWN_ACTION", message: "Unknown Unfold action." };
  if (!validation.ok) return { ok: false, code: validation.code, message: validation.message };

  const settings = await getSettings();
  const model = effectiveModel(settings);
  const depth = Math.max(0, Math.min(settings.maxDepth, Number(message.depth) || 0));
  if (Number(message.depth) > settings.maxDepth) {
    return { ok: false, code: "MAX_DEPTH", message: `This passage has reached your Unfold depth limit (${settings.maxDepth}).` };
  }

  const cacheParts = {
    action,
    model,
    text: validation.text,
    context: message.context || "",
    depth,
    insertionMode: message.insertionMode || "inline",
  };
  const key = Core.cacheKey(cacheParts);

  if (settings.cacheEnabled) {
    const cache = await readCache();
    if (cache[key]?.text) {
      return { ok: true, text: cache[key].text, model: cache[key].model || model, cached: true, depth };
    }
  }

  const auth = await getAuth();
  if (!auth) {
    return {
      ok: false,
      code: "NOT_CONNECTED",
      message: "Connect your Pollinations wallet in Unfold Options. No text was sent.",
    };
  }

  const payload = {
    model,
    messages: Core.buildMessages({
      action,
      text: validation.text,
      context: message.context || "",
      depth,
      insertionMode: message.insertionMode || "inline",
      pageTitle: message.pageTitle || "",
    }),
    temperature: 0.35,
    max_tokens: Core.estimateMaxTokens(action, validation.text, depth),
  };

  let result = await fetchCompletion(auth.apiKey, payload, true);
  if (!result.response.ok && result.response.status === 400) {
    // Some compatible community models reject response_format. A failed
    // validation request should not have generated text; retry without it.
    result = await fetchCompletion(auth.apiKey, payload, false);
  }

  if (!result.response.ok) {
    const code = result.response.status === 401 || result.response.status === 403
      ? "AUTH_FAILED"
      : result.response.status === 402
        ? "INSUFFICIENT_BALANCE"
        : result.response.status === 429
          ? "RATE_LIMITED"
          : "GENERATION_FAILED";
    if (code === "AUTH_FAILED") await storageRemove(KEYS.auth);
    return { ok: false, code, message: apiErrorMessage(result.data, `Pollinations returned HTTP ${result.response.status}.`) };
  }

  const rawContent = result.data?.choices?.[0]?.message?.content ?? result.data?.choices?.[0]?.text ?? "";
  const text = Core.parseTransformContent(rawContent);
  if (!text) return { ok: false, code: "EMPTY_RESULT", message: "Pollinations returned an empty result. Nothing was inserted." };

  if (settings.cacheEnabled) {
    const cache = await readCache();
    cache[key] = { text, model, action, createdAt: new Date().toISOString() };
    await writeCache(cache);
  }

  return { ok: true, text, model, cached: false, depth };
}

async function saveSettings(next) {
  const current = await getSettings();
  const settings = {
    ...current,
    model: String(next.model || current.model || DEFAULT_MODEL).trim(),
    customModel: String(next.customModel || "").trim(),
    cacheEnabled: next.cacheEnabled !== false,
    maxDepth: Math.max(0, Math.min(5, Number(next.maxDepth ?? current.maxDepth) || 0)),
  };
  await storageSet({ [KEYS.settings]: settings });
  return { ok: true, ...(await publicStatus()) };
}

async function handleMessage(message) {
  switch (message?.type) {
    case "UNFOLD_GET_STATUS":
      return { ok: true, ...(await publicStatus()) };
    case "UNFOLD_START_DEVICE_AUTH":
      return startDeviceAuth();
    case "UNFOLD_POLL_DEVICE_AUTH":
      return pollDeviceAuth();
    case "UNFOLD_WHOAMI":
      return whoAmI();
    case "UNFOLD_SAVE_MANUAL_KEY": {
      const apiKey = String(message.apiKey || "").trim();
      if (!apiKey) return { ok: false, code: "EMPTY_KEY", message: "Paste a Pollinations API key first." };
      await saveAuth(apiKey, "manual", null);
      const checked = await whoAmI();
      return checked.ok ? checked : { ok: true, ...(await publicStatus()), warning: checked.message };
    }
    case "UNFOLD_DISCONNECT":
      await storageRemove([KEYS.auth, KEYS.pendingDevice]);
      return { ok: true, ...(await publicStatus()) };
    case "UNFOLD_SAVE_SETTINGS":
      return saveSettings(message.settings || {});
    case "UNFOLD_CLEAR_CACHE":
      await storageSet({ [KEYS.cache]: {} });
      return { ok: true, ...(await publicStatus()) };
    case "UNFOLD_TRANSFORM":
      return transform(message);
    case "UNFOLD_OPEN_OPTIONS":
      await ext.runtime.openOptionsPage();
      return { ok: true };
    default:
      return { ok: false, code: "UNKNOWN_MESSAGE", message: "Unknown Unfold message." };
  }
}

ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((error) => {
      console.error("Unfold background error", error);
      sendResponse({ ok: false, code: "BACKGROUND_ERROR", message: error?.message || "Unfold hit an unexpected error." });
    });
  return true;
});

function createContextMenus() {
  if (!ext.contextMenus) return;
  ext.contextMenus.removeAll(() => {
    ext.contextMenus.create({ id: "unfold-root", title: "Unfold", contexts: ["selection"] });
    ext.contextMenus.create({ id: "unfold-grow", parentId: "unfold-root", title: "Grow in place", contexts: ["selection"] });
    ext.contextMenus.create({ id: "unfold-shrink", parentId: "unfold-root", title: "Shrink to a gist", contexts: ["selection"] });
    ext.contextMenus.create({ id: "unfold-explain", parentId: "unfold-root", title: "Explain this", contexts: ["selection"] });
    ext.contextMenus.create({ id: "unfold-restore", title: "Restore page (remove Unfold insertions)", contexts: ["page", "selection"] });
  });
}

ext.runtime.onInstalled.addListener(createContextMenus);
ext.runtime.onStartup?.addListener(createContextMenus);

async function sendCommandToTab(tabId, action, selectionText = "") {
  if (!tabId) return;
  try {
    await ext.tabs.sendMessage(tabId, { type: "UNFOLD_COMMAND", action, selectionText });
  } catch {
    // Restricted browser pages and PDF viewers do not accept content scripts.
  }
}

ext.contextMenus?.onClicked.addListener(async (info, tab) => {
  const actions = {
    "unfold-grow": "grow",
    "unfold-shrink": "shrink",
    "unfold-explain": "explain",
    "unfold-restore": "restore",
  };
  const action = actions[info.menuItemId];
  if (action) await sendCommandToTab(tab?.id, action, info.selectionText || "");
});

ext.commands?.onCommand.addListener(async (command, tab) => {
  const actions = {
    "grow-selection": "grow",
    "shrink-selection": "shrink",
    "restore-page": "restore",
  };
  const action = actions[command];
  if (!action) return;
  let targetTab = tab;
  if (!targetTab?.id && ext.tabs?.query) {
    const tabs = await ext.tabs.query({ active: true, currentWindow: true });
    targetTab = tabs[0];
  }
  await sendCommandToTab(targetTab?.id, action);
});
