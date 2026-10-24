(function attachUnfoldCore(globalScope) {
  "use strict";

  const ACTIONS = Object.freeze({
    grow: {
      label: "Grow",
      instruction:
        "Write an inline expansion that can be inserted immediately after the selected text. Do not repeat the selected text. Add the missing explanation, context, mechanism, example or implication that helps the reader understand it in place. Preserve the source's meaning and do not invent citations, measurements, quotes or facts that are not supported by the supplied context. If a needed fact is not in the context, phrase the expansion generally or state the limit briefly.",
    },
    shrink: {
      label: "Shrink",
      instruction:
        "Compress the selected text into a faithful gist. Preserve named people, dates, numbers, negations, causal claims and uncertainty. Remove examples, repetition and throat-clearing before removing substance. Do not add information that is not in the selected text.",
    },
    explain: {
      label: "Explain",
      instruction:
        "Explain the selected term or passage for a smart non-specialist, using the surrounding context to choose the intended sense. Start with what it means here, then why it matters here. If the context does not settle the meaning, say that briefly instead of guessing.",
    },
  });

  function normalizeText(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function validateSelectionText(value, maxChars = 8000) {
    const text = normalizeText(value);
    if (!text) return { ok: false, code: "EMPTY", message: "Select some text first.", text };
    if (text.length < 2) return { ok: false, code: "TOO_SHORT", message: "Select at least a word or phrase.", text };
    if (text.length > maxChars) {
      return {
        ok: false,
        code: "TOO_LONG",
        message: `That selection is ${text.length} characters. Unfold accepts up to ${maxChars} at a time so one run stays reviewable.`,
        text,
      };
    }
    return { ok: true, code: "OK", message: "", text };
  }

  function targetWords(action, text, depth = 0) {
    const words = Math.max(1, normalizeText(text).split(/\s+/).filter(Boolean).length);
    if (action === "shrink") return Math.max(12, Math.min(180, Math.round(words * 0.32)));
    if (action === "explain") return Math.max(35, Math.min(180, Math.round(words * 1.4) + 30));
    const multiplier = Math.max(1.2, 2.1 - Number(depth || 0) * 0.25);
    return Math.max(35, Math.min(420, Math.round(words * multiplier)));
  }

  function estimateMaxTokens(action, text, depth = 0) {
    // Reasoning-capable models spend part of max_tokens before visible text.
    // Keep enough headroom that a short JSON answer is not truncated.
    return Math.max(320, Math.min(1400, Math.ceil(targetWords(action, text, depth) * 1.55) + 192));
  }

  function buildMessages({ action, text, context = "", depth = 0, insertionMode = "inline", pageTitle = "" } = {}) {
    if (!ACTIONS[action]) throw new Error(`Unknown Unfold action: ${action}`);
    const selected = normalizeText(text);
    const surrounding = normalizeText(context).slice(0, 2400);
    const words = targetWords(action, selected, depth);
    const modeNote =
      action === "grow" && insertionMode === "block"
        ? "The result will be shown as a clearly marked expansion block after the passage, so it may use one or two short paragraphs."
        : action === "grow"
          ? "The result will be inserted inline, so write flowing prose without headings, bullets or a leading colon."
          : "Write flowing prose without headings or bullets unless the selected text is itself a list.";

    return [
      {
        role: "system",
        content: [
          "You are Unfold, a stretchtext reading assistant.",
          ACTIONS[action].instruction,
          modeNote,
          `Aim for about ${words} words; depth is ${Number(depth) || 0}.`,
          "Return JSON only in exactly this shape: {\"text\":\"...\"}. No markdown fence and no commentary outside the JSON.",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          pageTitle ? `Page title: ${normalizeText(pageTitle).slice(0, 240)}` : "",
          "Selected text:",
          selected,
          surrounding && surrounding !== selected ? "\nSurrounding context (for sense only; do not rewrite it):" : "",
          surrounding && surrounding !== selected ? surrounding : "",
        ].filter(Boolean).join("\n"),
      },
    ];
  }

  function stripCodeFence(value) {
    return String(value || "")
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
  }

  function parseTransformContent(content) {
    if (content && typeof content === "object") {
      if (typeof content.text === "string") return normalizeText(content.text);
      if (Array.isArray(content)) {
        return normalizeText(content.map((part) => typeof part === "string" ? part : part?.text || "").join("\n"));
      }
    }

    const raw = stripCodeFence(content);
    if (!raw) return "";

    const candidates = [raw];
    const firstBrace = raw.indexOf("{");
    const lastBrace = raw.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(raw.slice(firstBrace, lastBrace + 1));

    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate);
        if (typeof parsed?.text === "string") return normalizeText(parsed.text);
        if (typeof parsed?.result === "string") return normalizeText(parsed.result);
      } catch {
        // Fall through to plain text; some compatible models ignore JSON mode.
      }
    }
    return normalizeText(raw.replace(/^"|"$/g, ""));
  }

  function cacheKeyMaterial({ action, model, text, context = "", depth = 0, insertionMode = "inline" } = {}) {
    return JSON.stringify({
      v: 1,
      action,
      model,
      text: normalizeText(text),
      context: normalizeText(context).slice(0, 800),
      depth: Number(depth) || 0,
      insertionMode,
    });
  }

  function stableHash(value) {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    const input = String(value || "");
    for (let i = 0; i < input.length; i += 1) {
      const code = input.charCodeAt(i);
      h1 = Math.imul(h1 ^ code, 2654435761);
      h2 = Math.imul(h2 ^ code, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return `${(h2 >>> 0).toString(16).padStart(8, "0")}${(h1 >>> 0).toString(16).padStart(8, "0")}`;
  }

  function cacheKey(parts) {
    return `unfold:v1:${stableHash(cacheKeyMaterial(parts))}`;
  }

  function nearestSentenceWindow(text, start = 0, end = 0, radius = 520) {
    const source = String(text || "");
    if (!source) return "";
    const from = Math.max(0, Math.min(start, source.length) - radius);
    const to = Math.min(source.length, Math.max(end, start) + radius);
    return normalizeText(source.slice(from, to));
  }

  const api = Object.freeze({
    ACTIONS,
    buildMessages,
    cacheKey,
    cacheKeyMaterial,
    estimateMaxTokens,
    nearestSentenceWindow,
    normalizeText,
    parseTransformContent,
    stableHash,
    targetWords,
    validateSelectionText,
  });

  globalScope.UnfoldCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
