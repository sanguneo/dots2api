import { randomUUID } from "node:crypto";
import { errors } from "playwright";
import type { JSHandle, Page } from "playwright";
import { GatewayError } from "../../contracts";
import type { AdapterContext, JobApproval } from "../../contracts";
import { APPROVAL_CARD_SELECTOR } from "./approval-dom";

export interface ApprovalCard {
  readonly root: HTMLElement;
  readonly identity: string;
  readonly threadId: string | null;
  readonly description: string;
  readonly buttons: HTMLElement[];
  readonly labels: string[];
  readonly more: HTMLElement | null;
  readonly current: () => boolean;
  menu?: HTMLElement;
}
const POLL_MS = 200;

interface StandingApproval {
  readonly register: (identity: string) => Promise<{ readonly id: string; readonly expiresAt: string } | null>;
  readonly publish: (threadId: string | null, approval: JobApproval, choose: (choiceId: string) => Promise<boolean>) => () => void;
  readonly clicked: (identity: string, threadId: string | null) => Promise<void>;
}

/** One page, one approval budget. Handles pin the actual controls, not an index in a mutable list. */
export class ApprovalWait {
  #remaining: number;
  #answered: JSHandle<ApprovalCard | null> | undefined;

  constructor(
    private readonly page: Page,
    private readonly context: AdapterContext,
    private readonly scan: (rootSelector: string) => ApprovalCard | null,
    timeout: number,
    private readonly standing?: StandingApproval,
  ) { this.#remaining = timeout; }

  async dispose(): Promise<void> {
    const answered = this.#answered;
    this.#answered = undefined;
    await answered?.dispose();
  }

  private async loadMenu(card: JSHandle<ApprovalCard | null>): Promise<void> {
    const property = await card.getProperty("more");
    try {
      const trigger = property.asElement();
      if (!trigger) return;
      if (await trigger.getAttribute("aria-expanded") !== "true") {
        // The bundle's nondecision trigger opens on pointerdown in Radix; this is not an approval.
        try { await trigger.click({ timeout: 750 }); }
        catch (error) { if (error instanceof errors.TimeoutError) return; throw error; }
      }
      try {
        const ready = await this.page.waitForFunction((value) => {
          const opener = value?.more;
          if (!opener?.isConnected || opener.getAttribute("aria-expanded") !== "true") return false;
          const id = opener.getAttribute("aria-controls");
          const menu = id && document.getElementById(id);
          return menu && menu.matches('[role="menu"][data-slot="dropdown-menu-content"][data-radix-menu-content]') &&
            menu.querySelector('[role="menuitem"]') && menu.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }) ? menu : false;
        }, card, { timeout: 750 });
        try {
          await card.evaluate((value, menu) => {
            if (!value || !(menu instanceof HTMLElement) || !value.current()) return;
            const buttons = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')]
              .filter((item) => !item.matches(":disabled,[aria-disabled=true],[data-disabled]") &&
                item.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }));
            for (const button of buttons) {
              const label = button.textContent?.trim();
              if (label && label.length <= 120 && value.buttons.length < 8) {
                value.buttons.push(button);
                value.labels.push(label);
              }
            }
            value.menu = menu;
          }, ready);
        } finally { await ready.dispose(); }
      } catch (error) { if (!(error instanceof errors.TimeoutError)) throw error; }
    } finally { await property.dispose(); }
  }

  /** Returns true if it waited on a prompt, so the generation budget can exclude time spent here. */
  async check(): Promise<boolean> {
    const card = await this.page.evaluateHandle(this.scan, APPROVAL_CARD_SELECTOR);
    let keep = false;
    try {
      const match = await card.evaluate((value, answered) => value && (!answered || value.root !== answered.root ||
        value.description !== answered.description || !answered.current() ||
        value.buttons.some((button, index) => button !== answered.buttons[index] || value.labels[index] !== answered.labels[index]))
        ? { identity: value.identity, threadId: value.threadId } : null, this.#answered ?? null);
      if (!match) return false;
      const registration = await this.standing?.register(match.identity);
      if (this.standing && !registration) return false;
      await this.loadMenu(card);
      const summary = await card.evaluate((value, answered) => {
        if (!value || !value.current() || (answered && answered.current() && value.root === answered.root && value.description === answered.description &&
          value.buttons.length === answered.buttons.length &&
          value.buttons.every((button, index) => button === answered.buttons[index] && value.labels[index] === answered.labels[index]))) return null;
        return { description: value.description, labels: value.labels };
      }, this.#answered ?? null);
      if (!summary) return false;
      await this.dispose();
      const start = Date.now();
      const deadline = registration ? Date.parse(registration.expiresAt) : start + this.#remaining;
      const expired = () => new GatewayError("approval_timeout", "Muse approval expired without a choice.", 504);
      if (!this.standing && this.#remaining <= 0) throw expired();
      if (this.standing && deadline <= start) return false;
      const approval: JobApproval = {
        id: registration?.id ?? randomUUID(), description: summary.description,
        choices: summary.labels.map((label, index) => ({ id: String(index), label })),
        expiresAt: new Date(deadline).toISOString(),
      };
      const decision = Promise.withResolvers<boolean>();
      let closing = false;
      let submitted = false;
      const choose = async (choiceId: string) => {
        if (submitted || closing || this.context.signal.aborted || Date.now() >= deadline) return false;
        const index = approval.choices.findIndex((choice) => choice.id === choiceId);
        if (index < 0) return false;
        submitted = true;
        let clicked = false;
        try {
          clicked = await card.evaluate((value, { index, deadline }) => {
            const button = value?.buttons[index];
            if (!value || !button || Date.now() >= deadline || !value.current() ||
              !(value.root.contains(button) || value.menu?.contains(button)) ||
              !button.isConnected || button.matches(":disabled,[aria-disabled=true],[data-disabled]") ||
              !button.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }) ||
              button.textContent?.trim() !== value.labels[index]) return false;
            button.click();
            return true;
          }, { index, deadline });
        } catch (error) {
          // A disconnected/navigated page cannot confirm a click. Never retarget it.
          if (!(error instanceof Error)) throw error;
        } finally {
          try {
            if (clicked) await this.standing?.clicked(match.identity, match.threadId);
          } finally { decision.resolve(clicked); }
        }
        return clicked;
      };
      const withdraw = this.standing
        ? this.standing.publish(match.threadId, approval, choose)
        : this.context.onApproval?.(approval, choose);
      try {
        for (;;) {
          this.context.signal.throwIfAborted();
          if (submitted) {
            // The DOM-side check enforces the same deadline even when the command is already in flight.
            keep = await decision.promise;
            if (keep) {
              this.#answered = card;
            } else if (!this.standing && Date.now() >= deadline) throw expired();
            return true;
          }
          if (Date.now() >= deadline) {
            throw expired();
          }
          const stillThere = await card.evaluate((value) => value !== null && value.current() &&
            value.buttons.every((button, index) => (value.root.contains(button) || value.menu?.contains(button)) &&
              button.isConnected && !button.matches(":disabled,[aria-disabled=true],[data-disabled]") &&
              button.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }) &&
              button.textContent?.trim() === value.labels[index]));
          if (!stillThere && !submitted) return true;
          const tick = Promise.withResolvers<void>();
          const timer = setTimeout(tick.resolve, Math.max(0, Math.min(POLL_MS, deadline - Date.now())));
          try { await Promise.race([tick.promise, decision.promise]); }
          finally { clearTimeout(timer); }
        }
      } finally {
        closing = true;
        withdraw?.();
        this.#remaining = Math.max(0, this.#remaining - (Date.now() - start));
      }
    } finally {
      if (!keep) await card.dispose();
    }
  }
}
