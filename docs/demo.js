"use strict";

const article = document.getElementById("demoArticle");
const status = document.getElementById("demoStatus");
const originalHtml = article.innerHTML;
let growDepth = 0;
let explained = false;
let shrunk = false;

const EXPANSIONS = [
  " Instead of forcing every reader through the same amount of detail, the page could open a small explanatory layer at the exact sentence that caused the question. A hurried reader keeps moving; a curious one unfolds the idea without losing their place.",
  " That locality is the difference from opening a chatbot in another tab: the new layer inherits the sentence, paragraph and reading position that made it necessary, so the explanation can be shorter and more relevant.",
];

function setStatus(message) {
  status.textContent = message;
}

function restoreDemo(message = "Demo restored to the original passage.") {
  article.innerHTML = originalHtml;
  growDepth = 0;
  explained = false;
  shrunk = false;
  setStatus(message);
}

function growDemo() {
  if (shrunk) restoreDemo();
  const lead = document.getElementById("demoLead");
  if (!lead) return;
  if (growDepth >= EXPANSIONS.length) {
    setStatus("This canned demo has two growth layers. The installed extension lets you choose a maximum depth from 0 to 5.");
    return;
  }
  const span = document.createElement("span");
  span.className = "demo-generated";
  span.textContent = EXPANSIONS[growDepth];
  lead.append(span);
  growDepth += 1;
  setStatus(`Grown to demo depth ${growDepth}. In the extension, you could now select part of the purple layer and grow it again.`);
}

function shrinkDemo() {
  restoreDemo();
  const lead = document.getElementById("demoLead");
  if (!lead) return;
  const gist = document.createElement("span");
  gist.className = "demo-generated shrink";
  gist.textContent = "Nelson's stretchtext let prose expand or contract on demand, but hand-writing every level was too costly.";
  lead.replaceChildren(gist);
  shrunk = true;
  setStatus("Shrunk to a gist. In the installed extension, inline shrink keeps the original behind an “original” toggle.");
}

function explainDemo() {
  if (shrunk) restoreDemo();
  if (explained) {
    setStatus("The demo gloss is already visible after “stretchtext.” Restore to run it again.");
    return;
  }
  const term = article.querySelector("mark");
  if (!term) return;
  const gloss = document.createElement("span");
  gloss.className = "demo-generated explain";
  gloss.textContent = " (text whose level of detail changes in place, rather than sending the reader to a footnote or another page)";
  term.after(gloss);
  explained = true;
  setStatus("Explained in context. In the extension, Explain uses the surrounding passage to choose the intended sense.");
}

for (const button of document.querySelectorAll("[data-demo-action]")) {
  button.addEventListener("click", () => {
    const action = button.dataset.demoAction;
    if (action === "grow") growDemo();
    else if (action === "shrink") shrinkDemo();
    else if (action === "explain") explainDemo();
    else if (action === "restore") restoreDemo();
  });
}
