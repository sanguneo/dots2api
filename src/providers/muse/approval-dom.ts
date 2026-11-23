import type { ApprovalCard } from "./approval-wait";

export const APPROVAL_CARD_SELECTOR = '[data-testid="hatch-inline-approval-card"][data-hatch-inline-approval-shortcut-surface="true"][role="group"]:not([data-hatch-background-approval-surface])';

// HatchInlineApprovalCard, Muse build 1001d33c (chunk 3p4v5w72c5i5m).
// This function is serialized into Chromium by Playwright; do not capture module constants here.
export function scanApprovalCard(rootSelector: string): ApprovalCard | null {
  // The shared deck can reuse identical DOM nodes for a new request. The card root's committed
  // host props hold the single/group child React element with `approval` / `approvals` props.
  // Never read an in-progress alternate Fiber or send these provider IDs outside the page.
  const approvalDetails = (root: HTMLElement): { identity: string; threadId: string | null } | null => {
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
          if (ids.length === requests.length) {
            const linkedThread = (anchor: HTMLAnchorElement) => {
              const url = new URL(anchor.href, location.href);
              const id = url.origin === location.origin && /^\/thread\/([A-Za-z0-9_-]{1,128})\/?$/.exec(url.pathname)?.[1];
              return id && id !== "new" ? [id] : [];
            };
            const links = [...root.querySelectorAll<HTMLAnchorElement>("a[href]")].flatMap(linkedThread);
            // The observed Korean and English cards name the source chat in their
            // native details. Only resolve that title through an actual sidebar link.
            const cleanTitle = (value: string) => value.replace(/[\u2066-\u2069]/g, "").trim();
            const description = cleanTitle(root.textContent ?? "");
            const title = /이 작업은 ['‘](.+?)['’] 사이드 채팅에서 비롯되었습니다|This task comes from the side chat [“"](.+?)[”"]/u.exec(description);
            const source = title?.[1] ?? title?.[2];
            const rows = source ? [...document.querySelectorAll<HTMLElement>('[data-testid="hatch-thread-row"]')].filter((row) =>
              row.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }) &&
              [row.getAttribute("data-title"), row.getAttribute("title"), row.getAttribute("aria-label"), row.textContent]
                .some((value) => value !== null && cleanTitle(value) === source)) : [];
            const row = rows.length === 1 ? rows[0] : undefined;
            const rowLinks = row instanceof HTMLAnchorElement ? [row] : [...(row?.querySelectorAll<HTMLAnchorElement>("a[href]") ?? [])];
            const candidates = [...new Set([...links, ...rowLinks.flatMap(linkedThread)])];
            return { identity: JSON.stringify(ids), threadId: candidates.length === 1 ? candidates[0] ?? null : null };
          }
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
    const approval = approvalDetails(root);
    if (!name || !approval) continue;
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
      root, ...approval, description, buttons, labels, more,
      current: () => root.isConnected && approvalDetails(root)?.identity === approval.identity &&
        root.getAttribute("aria-label")?.trim() === name && details() === body,
    };
  }
  return null;
}
