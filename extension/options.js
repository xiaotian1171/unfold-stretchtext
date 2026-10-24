"use strict";

const ext = globalThis.browser || globalThis.chrome;
const $ = (id) => document.getElementById(id);
const els = {
  connectionStatus: $("connectionStatus"),
  connectionText: $("connectionText"),
  startDeviceButton: $("startDeviceButton"),
  whoamiButton: $("whoamiButton"),
  disconnectButton: $("disconnectButton"),
  deviceBox: $("deviceBox"),
  deviceCode: $("deviceCode"),
  deviceHint: $("deviceHint"),
  deviceLink: $("deviceLink"),
  pollNowButton: $("pollNowButton"),
  connectionMessage: $("connectionMessage"),
  manualApiKey: $("manualApiKey"),
  saveManualKeyButton: $("saveManualKeyButton"),
  settingsForm: $("settingsForm"),
  modelSelect: $("modelSelect"),
  customModel: $("customModel"),
  maxDepth: $("maxDepth"),
  cacheEnabled: $("cacheEnabled"),
  clearCacheButton: $("clearCacheButton"),
  settingsMessage: $("settingsMessage"),
};

let pollTimer = null;
let pollIntervalSeconds = 5;

function sendBackground(payload) {
  if (globalThis.browser?.runtime?.sendMessage) return globalThis.browser.runtime.sendMessage(payload);
  return new Promise((resolve, reject) => {
    ext.runtime.sendMessage(payload, (response) => {
      const error = ext.runtime.lastError;
      if (error) reject(new Error(error.message || "Unfold background is unavailable."));
      else resolve(response || { ok: false, message: "No response from Unfold." });
    });
  });
}

function setMessage(element, text, tone = "") {
  element.textContent = text || "";
  element.className = `message ${tone}`.trim();
}

function stopPolling() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}

function applyStatus(status) {
  if (!status) return;
  els.connectionStatus.classList.toggle("connected", Boolean(status.connected));
  if (status.connected) {
    const expiry = status.expiresAt ? ` · expires ${new Date(status.expiresAt).toLocaleDateString()}` : "";
    els.connectionText.textContent = `Connected${status.username ? ` as ${status.username}` : ""}${expiry}`;
    els.deviceBox.classList.add("hidden");
    stopPolling();
  } else {
    els.connectionText.textContent = status.appKeyConfigured
      ? "Not connected"
      : "Not connected · this build still needs its publishable App Key for Device Flow";
  }

  if (status.settings) {
    els.modelSelect.value = status.settings.model || "deepseek/deepseek-v4.1-flash";
    els.customModel.value = status.settings.customModel || "";
    els.maxDepth.value = String(status.settings.maxDepth ?? 3);
    els.cacheEnabled.checked = status.settings.cacheEnabled !== false;
  }
  els.clearCacheButton.textContent = `Clear cached results (${status.cacheEntries || 0})`;
}

async function refreshStatus() {
  const status = await sendBackground({ type: "UNFOLD_GET_STATUS" });
  applyStatus(status);
  return status;
}

function showDevice(pending) {
  els.deviceBox.classList.remove("hidden");
  els.deviceCode.textContent = pending.userCode || "Open approval page";
  els.deviceLink.href = pending.verificationUriComplete || pending.verificationUri || "https://enter.pollinations.ai/device";
  pollIntervalSeconds = Math.max(2, Number(pending.interval) || 5);
}

function schedulePoll() {
  stopPolling();
  pollTimer = setTimeout(pollDevice, pollIntervalSeconds * 1000);
}

async function pollDevice() {
  stopPolling();
  try {
    const result = await sendBackground({ type: "UNFOLD_POLL_DEVICE_AUTH" });
    if (result.status === "connected") {
      applyStatus(result);
      setMessage(els.connectionMessage, "Connected. Select text on any article page to unfold it.", "success");
      return;
    }
    if (result.status === "pending") {
      showDevice(result);
      setMessage(els.connectionMessage, "Waiting for approval in Pollinations…");
      schedulePoll();
      return;
    }
    if (result.code !== "NO_PENDING_DEVICE") {
      setMessage(els.connectionMessage, result.message || "Pollinations sign-in did not complete.", "error");
    }
  } catch (error) {
    setMessage(els.connectionMessage, error.message || "Could not check Pollinations sign-in.", "error");
  }
}

els.startDeviceButton.addEventListener("click", async () => {
  els.startDeviceButton.disabled = true;
  setMessage(els.connectionMessage, "Requesting a Pollinations sign-in code…");
  try {
    const result = await sendBackground({ type: "UNFOLD_START_DEVICE_AUTH" });
    if (!result.ok) {
      setMessage(els.connectionMessage, result.message || "Could not start Pollinations sign-in.", "error");
      return;
    }
    showDevice(result);
    setMessage(els.connectionMessage, "Approve Unfold in the Pollinations tab. This page will keep checking.");
    window.open(result.verificationUriComplete, "_blank", "noopener,noreferrer");
    schedulePoll();
  } catch (error) {
    setMessage(els.connectionMessage, error.message || "Could not start Pollinations sign-in.", "error");
  } finally {
    els.startDeviceButton.disabled = false;
  }
});

els.pollNowButton.addEventListener("click", pollDevice);

els.whoamiButton.addEventListener("click", async () => {
  setMessage(els.connectionMessage, "Verifying the saved key…");
  try {
    const result = await sendBackground({ type: "UNFOLD_WHOAMI" });
    if (result.ok) {
      applyStatus(result);
      setMessage(els.connectionMessage, "Connection verified.", "success");
    } else {
      setMessage(els.connectionMessage, result.message || "This key could not be verified.", "error");
      await refreshStatus();
    }
  } catch (error) {
    setMessage(els.connectionMessage, error.message || "Verification failed.", "error");
  }
});

els.disconnectButton.addEventListener("click", async () => {
  stopPolling();
  const result = await sendBackground({ type: "UNFOLD_DISCONNECT" });
  applyStatus(result);
  els.deviceBox.classList.add("hidden");
  setMessage(els.connectionMessage, "Disconnected locally. You can also revoke the key in your Pollinations dashboard.", "success");
});

els.saveManualKeyButton.addEventListener("click", async () => {
  const apiKey = els.manualApiKey.value.trim();
  if (!apiKey) {
    setMessage(els.connectionMessage, "Paste a Pollinations secret key first.", "error");
    return;
  }
  els.saveManualKeyButton.disabled = true;
  try {
    const result = await sendBackground({ type: "UNFOLD_SAVE_MANUAL_KEY", apiKey });
    els.manualApiKey.value = "";
    if (result.ok) {
      applyStatus(result);
      setMessage(els.connectionMessage, result.warning ? `Key saved. Verification note: ${result.warning}` : "Manual key saved in extension-local storage.", result.warning ? "" : "success");
    } else {
      setMessage(els.connectionMessage, result.message || "Could not save that key.", "error");
    }
  } catch (error) {
    setMessage(els.connectionMessage, error.message || "Could not save that key.", "error");
  } finally {
    els.saveManualKeyButton.disabled = false;
  }
});

els.settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const result = await sendBackground({
    type: "UNFOLD_SAVE_SETTINGS",
    settings: {
      model: els.modelSelect.value,
      customModel: els.customModel.value,
      maxDepth: els.maxDepth.value,
      cacheEnabled: els.cacheEnabled.checked,
    },
  });
  if (result.ok) {
    applyStatus(result);
    setMessage(els.settingsMessage, "Settings saved.", "success");
  } else {
    setMessage(els.settingsMessage, result.message || "Could not save settings.", "error");
  }
});

els.clearCacheButton.addEventListener("click", async () => {
  const result = await sendBackground({ type: "UNFOLD_CLEAR_CACHE" });
  applyStatus(result);
  setMessage(els.settingsMessage, "Cached transformations cleared.", "success");
});

(async function init() {
  try {
    const status = await refreshStatus();
    if (!status.connected) {
      // Resume an already-started device approval without showing an error if none exists.
      const pending = await sendBackground({ type: "UNFOLD_POLL_DEVICE_AUTH" });
      if (pending.status === "pending") {
        showDevice(pending);
        setMessage(els.connectionMessage, "Resumed a pending Pollinations approval.");
        schedulePoll();
      } else if (pending.status === "connected") {
        applyStatus(pending);
      }
    }
  } catch (error) {
    setMessage(els.connectionMessage, error.message || "Could not load Unfold status.", "error");
  }
})();
