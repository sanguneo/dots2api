import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { observeCompletion } from "../src/providers/muse/completion";

test("approval removal cannot confirm completion before the resumed reply finishes", async () => {
  const bundled = chromium.executablePath();
  const chrome = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"]
    .find(existsSync);
  const executablePath = existsSync(bundled) ? bundled : chrome;
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), timeout: 20_000 });
  try {
    const page = await browser.newPage();
    await page.setContent('<div class="chat-user-bubble">Fixture</div><button aria-label="Stop">Stop</button>');
    await page.evaluate(observeCompletion, { knownAttachments: 0, approvalSelector: "[data-fixture-approval]" });
    const completed = () => page.evaluate(() => document.documentElement.dataset["museComplete"] === "true");
    await page.evaluate(() => {
      document.body.insertAdjacentHTML("beforeend", '<div class="hatch-agent-bubble-bg">Preparing.</div><div data-fixture-approval>Approval</div>');
      document.querySelector('button[aria-label="Stop"]')?.remove();
    });
    const duringApproval = await completed();
    await page.evaluate(() => document.querySelector("[data-fixture-approval]")?.remove());
    const betweenApprovalAndResume = await completed();
    await page.evaluate(() => document.body.insertAdjacentHTML("beforeend", '<button aria-label="Stop">Stop</button>'));
    const whileResumed = await completed();
    await page.evaluate(() => {
      document.body.insertAdjacentHTML("beforeend", '<div class="hatch-agent-bubble-bg">Final.</div>');
      document.querySelector('button[aria-label="Stop"]')?.remove();
    });
    expect([duringApproval, betweenApprovalAndResume, whileResumed, await completed()]).toEqual([false, false, false, true]);
  } finally { await browser.close(); }
});
