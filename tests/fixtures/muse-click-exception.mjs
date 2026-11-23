// Inject a lost click acknowledgement into the real Node worker, after its local page handles Send.
import { chromium } from "playwright";

const launch = chromium.launchPersistentContext.bind(chromium);
chromium.launchPersistentContext = async (...args) => {
  const browser = await launch(...args);
  for (const page of browser.pages()) {
    const locate = page.locator.bind(page);
    page.locator = (selector, options) => {
      const locator = locate(selector, options);
      if (selector === 'button[aria-label="Send"]') {
        const first = locator.first.bind(locator);
        locator.first = () => {
          const send = first();
          const click = send.click.bind(send);
          send.click = async (...clickArgs) => {
            await click(...clickArgs);
            if (!clickArgs[0]?.trial) throw new Error("Synthetic lost click acknowledgement");
          };
          return send;
        };
      }
      return locator;
    };
  }
  return browser;
};
