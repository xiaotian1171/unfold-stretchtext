(function initUnfoldContent() {
  "use strict";

  if (globalThis.__unfoldContentLoaded) return;
  globalThis.__unfoldContentLoaded = true;

  const ext = globalThis.browser || globalThis.chrome;
  const Core = globalThis.UnfoldCore;
  if (!ext?.runtime || !Core) return;

  const ROOT_CLASS = "unfold-extension-root";
  let toolbar = null;
  let toast = null;
  let toastTimer = null;
  let selectionTimer = null;
  let lastSelection = null;
  let running = false;

  function sendMessage(message) {
    if (globalThis.browser?.runtime?.sendMessage) {
      return globalThis.browser.runtime.sendMessage(message);
    }
    return new Promise((resolve, reject) => {
      try {
        ext.runtime.sendMessage(message, (response) => {
          const error = ext.runtime.lastError;
          if (error) reject(new Error(error.message || "Unfold background is unavailable."));
          else resolve(response || { ok: false, message: "Unfold returned no response." });
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function elementFromNode(node) {
    if (!node) return null;
    return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  }

  function isOurUi(node) {
    return Boolean(elementFromNode(node)?.closest(`.${ROOT_CLASS}`));
  }

  function isEditable(node) {
    const element = elementFromNode(node);
    if (!element) return false;
    return Boolean(element.closest("input, textarea, select, [contenteditable='true'], [contenteditable='plaintext-only']"));
  }

  function nearestBlock(node) {
    let element = elementFromNode(node);
    const blockTags = new Set([
      "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DIV", "DT", "FIGCAPTION",
      "FOOTER", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "LI", "MAIN",
      "P", "PRE", "SECTION", "TD", "TH",
    ]);
    while (element && element !== document.body) {
      if (blockTags.has(element.tagName)) return element;
      const display = getComputedStyle(element).display;
      if (["block", "flow-root", "list-item", "table-cell"].includes(display)) return element;
      element = element.parentElement;
    }
    return document.body;
  }

  function selectionDepth(range) {
    const generated = elementFromNode(range.commonAncestorContainer)?.closest("[data-unfold-depth]");
    return Math.max(0, Number(generated?.dataset.unfoldDepth) || 0);
  }

  function buildContext(block, selectedText) {
    const blockText = Core.normalizeText(block?.innerText || block?.textContent || "");
    if (!blockText) return selectedText;
    if (blockText.length <= 2400) return blockText;
    const index = blockText.toLowerCase().indexOf(selectedText.slice(0, 120).toLowerCase());
    if (index >= 0) return Core.nearestSentenceWindow(blockText, index, index + selectedText.length, 900);
    return blockText.slice(0, 2400);
  }

  function captureSelection({ keepExistingOnFailure = false } = {}) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return keepExistingOnFailure ? lastSelection : null;
    }
    const range = selection.getRangeAt(0);
    if (isOurUi(range.commonAncestorContainer)) return keepExistingOnFailure ? lastSelection : null;
    const text = Core.normalizeText(selection.toString());
    if (!text) return keepExistingOnFailure ? lastSelection : null;

    const rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return keepExistingOnFailure ? lastSelection : null;
    const block = nearestBlock(range.commonAncestorContainer);
    const snapshot = {
      text,
      range: range.cloneRange(),
      rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width, height: rect.height },
      block,
      context: buildContext(block, text),
      depth: selectionDepth(range),
      editable: isEditable(range.commonAncestorContainer),
      capturedAt: Date.now(),
    };
    lastSelection = snapshot;
    return snapshot;
  }

  function ensureToolbar() {
    if (toolbar && document.contains(toolbar)) return toolbar;
    toolbar = document.createElement("div");
    toolbar.className = `${ROOT_CLASS} unfold-toolbar`;
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-label", "Unfold stretchtext actions");
    toolbar.innerHTML = `
      <span class="unfold-toolbar-brand" aria-hidden="true">✦ Unfold</span>
      <button type="button" data-unfold-action="grow">Grow</button>
      <button type="button" data-unfold-action="shrink">Shrink</button>
      <button type="button" data-unfold-action="explain">Explain</button>
      <span class="unfold-toolbar-depth" data-unfold-depth-label></span>
      <button type="button" class="unfold-toolbar-close" data-unfold-close aria-label="Hide Unfold toolbar">×</button>
    `;
    toolbar.addEventListener("mousedown", (event) => {
      // Keep the page selection alive while the reader presses a button.
      event.preventDefault();
      event.stopPropagation();
    });
    toolbar.addEventListener("click", async (event) => {
      const close = event.target.closest("[data-unfold-close]");
      if (close) {
        hideToolbar();
        return;
      }
      const button = event.target.closest("[data-unfold-action]");
      if (button) await runAction(button.dataset.unfoldAction, lastSelection);
    });
    document.documentElement.append(toolbar);
    return toolbar;
  }

  function showToolbar(snapshot) {
    if (!snapshot || snapshot.editable) {
      hideToolbar();
      return;
    }
    const bar = ensureToolbar();
    bar.querySelector("[data-unfold-depth-label]").textContent = snapshot.depth ? `depth ${snapshot.depth}` : "";
    bar.classList.add("unfold-visible");

    // Measure after making it visible, then clamp to the viewport.
    const barRect = bar.getBoundingClientRect();
    const margin = 8;
    const above = snapshot.rect.top - barRect.height - 10;
    const top = above >= margin ? above : Math.min(window.innerHeight - barRect.height - margin, snapshot.rect.bottom + 10);
    const left = Math.max(margin, Math.min(snapshot.rect.left, window.innerWidth - barRect.width - margin));
    bar.style.top = `${Math.max(margin, top)}px`;
    bar.style.left = `${left}px`;
  }

  function hideToolbar() {
    toolbar?.classList.remove("unfold-visible");
  }

  function setToolbarBusy(isBusy, label = "") {
    if (!toolbar) return;
    toolbar.classList.toggle("unfold-busy", isBusy);
    for (const button of toolbar.querySelectorAll("button")) button.disabled = isBusy;
    const depth = toolbar.querySelector("[data-unfold-depth-label]");
    if (depth) depth.textContent = isBusy ? label : (lastSelection?.depth ? `depth ${lastSelection.depth}` : "");
  }

  function showToast(message, { connect = false, sticky = false } = {}) {
    if (toast) toast.remove();
    toast = document.createElement("div");
    toast.className = `${ROOT_CLASS} unfold-toast`;
    toast.setAttribute("role", "status");

    const text = document.createElement("span");
    text.textContent = message;
    toast.append(text);

    if (connect) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Connect";
      button.addEventListener("click", async () => {
        await sendMessage({ type: "UNFOLD_OPEN_OPTIONS" }).catch(() => {});
        toast?.remove();
      });
      toast.append(button);
    }

    const close = document.createElement("button");
    close.type = "button";
    close.className = "unfold-toast-close";
    close.setAttribute("aria-label", "Dismiss Unfold message");
    close.textContent = "×";
    close.addEventListener("click", () => toast?.remove());
    toast.append(close);
    document.documentElement.append(toast);

    clearTimeout(toastTimer);
    if (!sticky) toastTimer = setTimeout(() => toast?.remove(), 6500);
  }

  function insertionModeFor(snapshot) {
    if (!snapshot) return "block";
    if (snapshot.text.length > 700 || snapshot.rect.height > 96) return "block";
    const startBlock = nearestBlock(snapshot.range.startContainer);
    const endBlock = nearestBlock(snapshot.range.endContainer);
    return startBlock === endBlock ? "inline" : "block";
  }

  function makeRemoveButton(label = "Remove Unfold insertion") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "unfold-remove";
    button.textContent = "×";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.setAttribute("contenteditable", "false");
    return button;
  }

  function insertInline(snapshot, action, resultText) {
    const range = snapshot.range.cloneRange();
    if (!document.contains(range.commonAncestorContainer)) return false;

    if (action === "shrink") {
      const wrapper = document.createElement("span");
      wrapper.className = "unfold-generated unfold-shrink-wrap";
      wrapper.dataset.unfoldDepth = String(snapshot.depth + 1);

      const original = document.createElement("span");
      original.className = "unfold-original-fragment unfold-collapsed";
      original.append(range.extractContents());

      const gist = document.createElement("span");
      gist.className = "unfold-gist-text";
      gist.textContent = resultText;

      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "unfold-mini-toggle";
      toggle.textContent = "original";
      toggle.setAttribute("aria-expanded", "false");
      toggle.addEventListener("click", () => {
        const collapsed = original.classList.toggle("unfold-collapsed");
        toggle.textContent = collapsed ? "original" : "hide original";
        toggle.setAttribute("aria-expanded", String(!collapsed));
      });

      wrapper.append(gist, original, toggle, makeRemoveButton("Restore the original text"));
      range.insertNode(wrapper);
      return true;
    }

    const node = document.createElement("span");
    node.className = `unfold-generated unfold-inline unfold-${action}`;
    node.dataset.unfoldDepth = String(snapshot.depth + 1);
    node.title = action === "explain" ? "Explanation inserted by Unfold" : "Expansion inserted by Unfold";

    range.collapse(false);
    const needsSpace = !/\s$/.test(snapshot.text) && !/^[\s,.;:!?)]/.test(resultText);
    node.append(document.createTextNode(action === "explain" ? ` (${resultText}) ` : `${needsSpace ? " " : ""}${resultText} `));
    node.append(makeRemoveButton());
    range.insertNode(node);
    return true;
  }

  function insertBlock(snapshot, action, resultText, result) {
    const block = snapshot.block && document.contains(snapshot.block) ? snapshot.block : nearestBlock(snapshot.range.commonAncestorContainer);
    const card = document.createElement("aside");
    card.className = `unfold-generated unfold-card unfold-${action}`;
    card.dataset.unfoldDepth = String(snapshot.depth + 1);
    card.setAttribute("aria-label", `Unfold ${action} result`);

    const header = document.createElement("div");
    header.className = "unfold-card-header";
    const label = document.createElement("strong");
    label.textContent = action === "grow" ? "✦ Grown here" : action === "shrink" ? "↳ Gist" : "? Explained";
    const meta = document.createElement("span");
    meta.textContent = `${result.cached ? "cached · " : ""}${result.model || "Pollinations"}`;
    const collapse = document.createElement("button");
    collapse.type = "button";
    collapse.className = "unfold-card-button";
    collapse.textContent = "Collapse";
    const remove = makeRemoveButton();
    header.append(label, meta, collapse, remove);

    const body = document.createElement("div");
    body.className = "unfold-card-body";
    for (const paragraph of resultText.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean)) {
      const p = document.createElement("p");
      p.textContent = paragraph;
      body.append(p);
    }

    collapse.addEventListener("click", () => {
      const collapsed = body.classList.toggle("unfold-collapsed");
      collapse.textContent = collapsed ? "Expand" : "Collapse";
    });

    card.append(header, body);

    if (action === "shrink" && block && block !== document.body) {
      const footer = document.createElement("div");
      footer.className = "unfold-card-footer";
      const hideOriginal = document.createElement("button");
      hideOriginal.type = "button";
      hideOriginal.className = "unfold-card-button";
      hideOriginal.textContent = "Hide original passage";
      hideOriginal.addEventListener("click", () => {
        const hidden = block.classList.toggle("unfold-original-hidden");
        hideOriginal.textContent = hidden ? "Show original passage" : "Hide original passage";
      });
      footer.append(hideOriginal);
      card.append(footer);
      card._unfoldOriginalBlock = block;
    }

    if (block?.parentNode) block.parentNode.insertBefore(card, block.nextSibling);
    else document.body.append(card);
    return true;
  }

  function insertResult(snapshot, action, result) {
    const mode = insertionModeFor(snapshot);
    try {
      if (mode === "inline" && insertInline(snapshot, action, result.text)) return true;
    } catch (error) {
      console.warn("Unfold inline insertion failed; using a block instead", error);
    }
    try {
      return insertBlock(snapshot, action, result.text, result);
    } catch (error) {
      console.error("Unfold could not insert the result", error);
      return false;
    }
  }

  async function runAction(action, providedSnapshot) {
    if (running) return;
    const snapshot = providedSnapshot || captureSelection({ keepExistingOnFailure: true });
    if (!snapshot) {
      showToast("Select a passage first, then choose Grow, Shrink or Explain.");
      return;
    }
    if (snapshot.editable) {
      showToast("Unfold works on reading text, not inside text fields.");
      return;
    }

    const validation = Core.validateSelectionText(snapshot.text);
    if (!validation.ok) {
      showToast(validation.message);
      return;
    }

    running = true;
    setToolbarBusy(true, `${Core.ACTIONS[action]?.label || action}…`);
    try {
      const result = await sendMessage({
        type: "UNFOLD_TRANSFORM",
        action,
        text: snapshot.text,
        context: snapshot.context,
        depth: snapshot.depth,
        insertionMode: insertionModeFor(snapshot),
        pageTitle: document.title,
      });

      if (!result?.ok) {
        showToast(result?.message || "Unfold could not transform that passage.", {
          connect: result?.code === "NOT_CONNECTED" || result?.code === "AUTH_FAILED" || result?.code === "APP_KEY_NOT_CONFIGURED",
          sticky: result?.code === "NOT_CONNECTED",
        });
        return;
      }

      if (!insertResult(snapshot, action, result)) {
        showToast("The result arrived, but this page changed before Unfold could insert it. Select the passage and try again.", { sticky: true });
        return;
      }

      hideToolbar();
      window.getSelection()?.removeAllRanges();
      lastSelection = null;
    } catch (error) {
      showToast(error?.message || "Unfold could not reach its background worker. Reload the extension and try again.", { sticky: true });
    } finally {
      running = false;
      setToolbarBusy(false);
    }
  }

  function restorePage() {
    let restored = 0;

    for (const wrapper of [...document.querySelectorAll(".unfold-shrink-wrap")]) {
      const original = wrapper.querySelector(".unfold-original-fragment");
      const fragment = document.createDocumentFragment();
      if (original) {
        while (original.firstChild) fragment.append(original.firstChild);
      }
      wrapper.replaceWith(fragment);
      restored += 1;
    }

    for (const node of [...document.querySelectorAll(".unfold-generated")]) {
      if (node._unfoldOriginalBlock) node._unfoldOriginalBlock.classList.remove("unfold-original-hidden");
      node.remove();
      restored += 1;
    }

    for (const block of document.querySelectorAll(".unfold-original-hidden")) {
      block.classList.remove("unfold-original-hidden");
    }

    hideToolbar();
    lastSelection = null;
    showToast(restored ? `Restored the page (${restored} Unfold insertion${restored === 1 ? "" : "s"} removed).` : "This page has no Unfold insertions to restore.");
  }

  document.addEventListener("click", (event) => {
    const remove = event.target.closest?.(".unfold-remove");
    if (!remove) return;
    const generated = remove.closest(".unfold-generated");
    if (!generated) return;
    event.preventDefault();
    event.stopPropagation();

    if (generated.classList.contains("unfold-shrink-wrap")) {
      const original = generated.querySelector(".unfold-original-fragment");
      const fragment = document.createDocumentFragment();
      if (original) while (original.firstChild) fragment.append(original.firstChild);
      generated.replaceWith(fragment);
    } else {
      if (generated._unfoldOriginalBlock) generated._unfoldOriginalBlock.classList.remove("unfold-original-hidden");
      generated.remove();
    }
  }, true);

  function scheduleSelectionCheck() {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => {
      const snapshot = captureSelection();
      if (snapshot && !snapshot.editable) showToolbar(snapshot);
      else hideToolbar();
    }, 90);
  }

  document.addEventListener("selectionchange", scheduleSelectionCheck);
  document.addEventListener("mouseup", scheduleSelectionCheck, true);
  document.addEventListener("keyup", (event) => {
    if (event.key === "Escape") hideToolbar();
    else scheduleSelectionCheck();
  }, true);
  document.addEventListener("contextmenu", () => captureSelection({ keepExistingOnFailure: true }), true);
  window.addEventListener("resize", hideToolbar);
  window.addEventListener("scroll", hideToolbar, { passive: true, capture: true });

  ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "UNFOLD_COMMAND") return undefined;
    (async () => {
      if (message.action === "restore") {
        restorePage();
        return;
      }
      const snapshot = captureSelection({ keepExistingOnFailure: true });
      if (!snapshot && message.selectionText) {
        showToast("Unfold lost the exact selection range. Select the passage again and use the floating toolbar.");
        return;
      }
      await runAction(message.action, snapshot);
    })().catch((error) => showToast(error?.message || "Unfold command failed."));
    sendResponse?.({ ok: true });
    return true;
  });
})();
