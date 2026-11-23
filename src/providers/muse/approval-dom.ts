import type { ApprovalCard } from "./approval-wait";

export const APPROVAL_CARD_SELECTOR = '[data-testid="hatch-inline-approval-card"][data-hatch-inline-approval-shortcut-surface="true"][role="group"]:not([data-hatch-background-approval-surface])';

// HatchInlineApprovalCard, Muse build 1001d33c (chunk 3p4v5w72c5i5m).
// This function is serialized into Chromium by Playwright; do not capture module constants here.
export function scanApprovalCard(rootSelector: string): ApprovalCard | null {
  // The shared deck can reuse identical DOM nodes for a new request. The card root's committed
  // host props hold the single/group child React element with `approval` / `approvals` props.
  // Never read an in-progress alternate Fiber or send these provider IDs outside the page.
  const approvalIdentity = (root: HTMLElement): string | null => {
    const key = Object.keys(root).find((name) => name.startsWith("__reactProps$"));
    if (!key) return null;
    const props: unknown = Object.getOwnPropertyDescriptor(root, key)?.value;
    if (!props || typeof props !== "object" || !("children" in props)) return null;
    const pending: unknown[] = [props.children];
    for (let walked = 0; pending.length && walked < 40; walked++) {
      const node = pending.shift();
      if (Array.isArray(node)) {
        for (const child of node.slice(0, 12)) pending.push(child);
      } else if (node && typeof node === "object" && "props" in node) {
        const child = node.props;
        if (!child || typeof child !== "object") continue;
        const requests: readonly unknown[] | undefined = "approval" in child ? [child.approval]
          : "approvals" in child && Array.isArray(child.approvals) ? child.approvals : undefined;
        if (requests?.length && requests.length <= 8) {
          const ids: string[] = [];
          for (const request of requests) {
            if (request && typeof request === "object" && "approvalId" in request &&
                typeof request.approvalId === "string" && request.approvalId.length > 0 && request.approvalId.length <= 256) ids.push(request.approvalId);
          }
          if (ids.length === requests.length) return JSON.stringify(ids);
        }
        if ("children" in child) pending.push(child.children);
      }
    }
    return null;
  };
  const roots = document.querySelectorAll<HTMLElement>(rootSelector);
  for (const root of roots) {
    const surface = root.dataset["hatchApprovalSurface"];
    if ((surface !== "chat" && surface !== "panel") || !root.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })) continue;
    const name = root.getAttribute("aria-label")?.trim();
    const identity = approvalIdentity(root);
    if (!name || !identity) continue;
    const primary = root.querySelector<HTMLButtonElement>('button[data-hatch-approval-primary-action="true"]');
    if (!primary) continue;
    // Compact cards have sibling buttons; the owner's Browser card wraps each sibling in div.contents.
    const primaryGroup = primary.parentElement;
    const row = primaryGroup?.parentElement;
    if (!primaryGroup || !row || row === root || !root.contains(row)) continue;
    const buttons = [...row.children].flatMap((child) =>
      child === primaryGroup ? [primary] : child instanceof HTMLButtonElement ? [child]
        : child.matches("div.contents") ? [...child.querySelectorAll<HTMLButtonElement>(':scope > button[data-slot="button"]')] : [])
      .filter((button) => Boolean(button.textContent?.trim()) &&
      !button.matches(":disabled,[aria-disabled=true]") &&
      button.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }));
    if (!buttons.includes(primary)) continue;
    const more = primaryGroup.querySelector<HTMLElement>(':scope > button[aria-haspopup="menu"][data-slot="dropdown-menu-trigger"]');
    const details = () => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const parts: string[] = [];
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const parent = node.parentElement;
        const text = node.textContent?.trim();
        const excluded = parent?.closest('button,[role="menu"],[aria-hidden="true"],.sr-only');
        if (text && parent && !(excluded && excluded !== root && root.contains(excluded)) &&
          parent.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })) parts.push(text);
      }
      return parts.join(" ").replace(/\s+/g, " ").trim();
    };
    const body = details();
    const description = (body && body !== name ? `${name}: ${body}` : name).slice(0, 500);
    const labels = buttons.map((button) => button.textContent?.trim() ?? "");
    if (labels.some((label) => !label || label.length > 120)) continue;
    return {
      root, description, buttons, labels, more,
      current: () => root.isConnected && approvalIdentity(root) === identity &&
        root.getAttribute("aria-label")?.trim() === name && details() === body,
    };
  }
  return null;
}
