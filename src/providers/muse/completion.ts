/** Serialized into the Muse page. Only a real reply Stop transition confirms completion. */
export function observeCompletion({ knownAttachments, approvalSelector }: { readonly knownAttachments: number; readonly approvalSelector: string }): void {
  let seenStop = false;
  const root = document.documentElement;
  const stopSelector = '[data-testid="hatch-composer-stop-button"], button[aria-label*="Stop" i], button[aria-label*="\u{505c}\u{6b62}"]';
  const bubbleSelector = 'div[class*="hatch-agent-bubble-bg"]';
  const previous = new Map([...document.querySelectorAll(bubbleSelector)].map((bubble) => [bubble, bubble.textContent]));
  let attachmentBaseline = knownAttachments;
  const observe = () => {
    const stop = [...document.querySelectorAll(stopSelector)].find((el) => !/task|\u{4efb}\u{52a1}/iu.test(el.getAttribute("aria-label") ?? "")) ?? null;
    if ([...document.querySelectorAll(approvalSelector)].some((card) => card.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }))) {
      seenStop = Boolean(stop);
      previous.clear();
      for (const bubble of document.querySelectorAll(bubbleSelector)) previous.set(bubble, bubble.textContent);
      attachmentBaseline = document.querySelectorAll('[data-testid^="hatch-chat-attachment-presentation-"]').length;
      delete root.dataset["museComplete"];
      return;
    }
    if (stop) {
      seenStop = true;
      delete root.dataset["museComplete"];
      return;
    }
    if (!seenStop || root.dataset["museComplete"] === "true") return;
    if (!document.querySelector('div[class*="chat-user-bubble"]')) return;
    const hasText = [...document.querySelectorAll(bubbleSelector)].some((bubble) => bubble.textContent?.trim() && bubble.textContent !== previous.get(bubble));
    const hasMedia = document.querySelectorAll('[data-testid^="hatch-chat-attachment-presentation-"]').length > attachmentBaseline;
    if (hasText || hasMedia) root.dataset["museComplete"] = "true";
  };
  new MutationObserver(observe).observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
  observe();
}
