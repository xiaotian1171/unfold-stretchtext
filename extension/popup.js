"use strict";

const ext = globalThis.browser || globalThis.chrome;
const statusLine = document.getElementById("statusLine");
const statusText = document.getElementById("statusText");
const message = document.getElementById("popupMessage");
const optionsButton = document.getElementById("optionsButton");

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

function setMessage(text, tone = "") {
  message.textContent = text;
  message.className = `message ${tone}`.trim();
}

async function loadStatus() {
  try {
    const status = await sendBackground({ type: "UNFOLD_GET_STATUS" });
    statusLine.classList.toggle("connected", Boolean(status.connected));
    statusText.textContent = status.connected
      ? `Connected${status.username ? ` as ${status.username}` : ""} · ${status.model}`
      : "Not connected — your text stays local";
    optionsButton.textContent = status.connected ? "Settings" : "Connect Pollinations";
  } catch (error) {
    statusText.textContent = "Unfold worker unavailable";
    setMessage(error.message || "Could not read Unfold status.", "error");
  }
}

async function sendCommand(action) {
  setMessage(action === "restore" ? "Restoring this page…" : "Sending the selection to Unfold…");
  try {
    const tabs = await ext.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab?.id) throw new Error("No active tab found.");
    await ext.tabs.sendMessage(tab.id, { type: "UNFOLD_COMMAND", action });
    window.close();
  } catch (error) {
    setMessage("Unfold cannot run on this browser page. Try a normal http(s) article page.", "error");
    console.warn("Unfold popup command failed", error);
  }
}

for (const button of document.querySelectorAll("[data-command]")) {
  button.addEventListener("click", () => sendCommand(button.dataset.command));
}

optionsButton.addEventListener("click", async () => {
  await ext.runtime.openOptionsPage();
  window.close();
});

loadStatus();
