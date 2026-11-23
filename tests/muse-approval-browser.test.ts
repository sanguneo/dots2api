import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../src/api";
import { jobIdSchema } from "../src/contracts";
import type { Job, JobId } from "../src/contracts";
import { Gateway } from "../src/gateway";
import { createMuseAdapter } from "../src/providers/muse";
import { Store } from "../src/store";

async function browserFixture(mode: "before-send" | "after-send" | "replace" | "reuse" | "sequential" | "resuming" | "owner-markup" | "replace-opening-menu", approvalTimeout = 8_000) {
  const html = await Bun.file(new URL("./fixtures/muse-approval.html", import.meta.url)).text();
  const ownerHtml = await Bun.file(new URL("./fixtures/muse-approval-owner.html", import.meta.url)).text();
  const dir = await mkdtemp(join(tmpdir(), "dots2api-approval-browser-"));
  const events: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/session") return Response.json({ status: "assigned" });
      if (url.pathname === "/thread/new" || url.pathname === "/thread/fixture") {
        events.push(`navigate:${url.pathname}`);
        return new Response(html.replace("__MODE__", mode).replace("__OWNER_APPROVAL__", ownerHtml), { headers: { "content-type": "text/html" } });
      }
      if (url.pathname === "/event" && request.method === "POST") {
        events.push(await request.text());
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/replace") return Response.json({ replace: events.includes("replace") });
      return new Response(null, { status: 404 });
    },
  });
  const store = new Store(dir);
  const adapter = createMuseAdapter(server.url.href, 3_000, approvalTimeout);
  const gateway = new Gateway(store, { muse: adapter, dots: adapter });
  const account = gateway.create("muse", "Synthetic browser", {});
  store.saveAccount({ ...account, status: "ready" });
  const app = createApi(gateway);
  const headers = { authorization: `Bearer ${store.apiKey}`, "content-type": "application/json" };
  return {
    events, store, gateway, account,
    async start(prompt = "Fixture submit"): Promise<JobId> {
      const response = await app.request("/v1/chat/completions", {
        method: "POST", headers: { ...headers, prefer: "respond-async", "x-muse-thread": "fixture-topic" },
        body: JSON.stringify({ model: "muse-agent", messages: [{ role: "user", content: prompt }] }),
      });
      expect(response.status).toBe(202);
      return jobIdSchema.parse((await response.json()).job.id);
    },
    async choose(id: JobId, promptId: string, choiceId: string) {
      return app.request(`/api/jobs/${id}/approvals/${promptId}`, {
        method: "POST", headers, body: JSON.stringify({ choiceId }),
      });
    },
    async close() {
      gateway.stop();
      await gateway.drain();
      store.close();
      await server.stop(true);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function awaitApproval(fixture: Awaited<ReturnType<typeof browserFixture>>, id: JobId, oldId?: string) {
  const ready = Promise.withResolvers<Job>();
  const check = () => {
    const job = fixture.store.job(id);
    if (job && ((job.approval && job.approval.id !== oldId) || job.finishedAt)) ready.resolve(job);
  };
  const unsubscribe = fixture.gateway.subscribe(check);
  try {
    check();
    const job = await ready.promise;
    if (!job.approval) throw new Error(`Expected approval before ${job.status}: ${job.error}`);
    return job.approval;
  } finally { unsubscribe(); }
}

test.each(["before-send", "after-send"] as const)("resumes the exact browser page and clicks only the selected button (%s)", async (mode) => {
  const fixture = await browserFixture(mode);
  try {
    const id = await fixture.start();
    const approval = await awaitApproval(fixture, id);
    expect(approval.description).toContain("Publish the fixture website");
    expect(approval.choices.map(({ label }) => label)).toEqual(["거절", "허용", "이번만 허용"]);
    expect(fixture.gateway.account(fixture.account.id).busy).toBe(true);
    expect(fixture.events.filter((event) => event === "send").length).toBe(mode === "before-send" ? 0 : 1);
    const once = approval.choices.find(({ label }) => label === "이번만 허용");
    if (!once) throw new Error("Missing once button");
    const response = await fixture.choose(id, approval.id, once.id);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect((await fixture.choose(id, approval.id, once.id)).status).toBe(409);
    expect(await fixture.gateway.wait(id)).toMatchObject({
      status: "completed", output: "Completed on the original page.", remoteId: "fixture",
    });
    expect(fixture.events).toEqual(mode === "before-send"
      ? ["navigate:/thread/new", "click:once", "send"]
      : ["navigate:/thread/new", "send", "click:once"]);
  } finally { await fixture.close(); }
});

test("an unanswered browser approval expires with no click and no retry", async () => {
  const fixture = await browserFixture("after-send", 1_500);
  try {
    const id = await fixture.start();
    const approval = await awaitApproval(fixture, id);
    expect(Date.parse(approval.expiresAt)).toBeGreaterThan(Date.now());
    const completed = await fixture.gateway.wait(id);
    expect(completed).toMatchObject({ status: "failed", errorCode: "approval_timeout", remoteId: "fixture" });
    expect(completed.approval).toBeUndefined();
    expect((await fixture.choose(id, approval.id, approval.choices[0]?.id ?? "no-choice")).status).toBe(409);
    expect(fixture.events).toEqual(["navigate:/thread/new", "send"]);
  } finally { await fixture.close(); }
});

test.each(["replace", "reuse"] as const)("a replacement with identical labels cannot receive the old vote (%s)", async (mode) => {
  const fixture = await browserFixture(mode);
  try {
    const id = await fixture.start();
    const first = await awaitApproval(fixture, id);
    fixture.events.push("replace");
    const replacement = await awaitApproval(fixture, id, first.id);
    expect(replacement.choices.map(({ label }) => label)).toEqual(first.choices.map(({ label }) => label));
    expect((await fixture.choose(id, first.id, first.choices[0]?.id ?? "no-choice")).status).toBe(409);
    const once = replacement.choices.find(({ label }) => label === "이번만 허용");
    if (!once) throw new Error("Missing replacement once button");
    expect((await fixture.choose(id, replacement.id, once.id)).status).toBe(200);
    expect(await fixture.gateway.wait(id)).toMatchObject({ status: "completed", remoteId: "fixture" });
    expect(fixture.events).toEqual(["navigate:/thread/new", "send", "replace", "click:once"]);
  } finally { await fixture.close(); }
});

test("a new approval after an answer is published even when its DOM and labels are reused", async () => {
  const fixture = await browserFixture("sequential");
  try {
    const id = await fixture.start();
    const first = await awaitApproval(fixture, id);
    const firstChoice = first.choices.find(({ label }) => label === "이번만 허용");
    if (!firstChoice) throw new Error("Missing first choice");
    expect((await fixture.choose(id, first.id, firstChoice.id)).status).toBe(200);
    const second = await awaitApproval(fixture, id, first.id);
    expect((await fixture.choose(id, first.id, firstChoice.id)).status).toBe(409);
    const secondChoice = second.choices.find(({ label }) => label === "이번만 허용");
    if (!secondChoice) throw new Error(`Missing second choice: ${JSON.stringify(second.choices)}`);
    expect((await fixture.choose(id, second.id, secondChoice.id)).status).toBe(200);
    expect(await fixture.gateway.wait(id)).toMatchObject({ status: "completed", remoteId: "fixture" });
    expect(fixture.events).toEqual(["navigate:/thread/new", "send", "click:once", "click:once"]);
  } finally { await fixture.close(); }
});

test("approval removal and resumed Stop do not complete on the pre-approval progress bubble", async () => {
  const fixture = await browserFixture("resuming");
  try {
    const id = await fixture.start();
    const approval = await awaitApproval(fixture, id);
    const choice = approval.choices.find(({ label }) => label === "이번만 허용");
    if (!choice) throw new Error("Missing choice");
    expect((await fixture.choose(id, approval.id, choice.id)).status).toBe(200);
    expect(await fixture.gateway.wait(id)).toMatchObject({
      status: "completed", output: "Completed on the original page.", remoteId: "fixture",
    });
    expect(fixture.events).toContain("resume-started");
    expect(fixture.events).toContain("final");
  } finally { await fixture.close(); }
});

test("the owner's real main-composer markup exposes all three exact Korean choices and denies on the same page", async () => {
  const fixture = await browserFixture("owner-markup");
  try {
    const id = await fixture.start();
    const approval = await awaitApproval(fixture, id);
    expect(approval.choices.map(choice => choice.label)).toEqual(["이 작업에 대해 허용", "항상 허용", "거부"]);
    expect(approval.description).toContain("Browser를 사용하여 이 웹사이트 열기");
    expect(approval.description).toContain("ipmpt.sanguneo.com/");
    expect(approval.description).toContain("Introduce Eli bot persona");
    const deny = approval.choices.find(choice => choice.label === "거부");
    if (!deny) throw new Error("Missing real deny choice");
    expect((await fixture.choose(id, approval.id, deny.id)).status).toBe(200);
    expect(await fixture.gateway.wait(id)).toMatchObject({ status: "completed", remoteId: "fixture" });
    expect(fixture.events).toEqual(["navigate:/thread/new", "send", "click:deny"]);
  } finally { await fixture.close(); }
});

test("an approval replaced while its menu opens is not advertised with a partial choice list", async () => {
  const fixture = await browserFixture("replace-opening-menu");
  try {
    const id = await fixture.start();
    const approval = await awaitApproval(fixture, id);
    expect(approval.choices.map(choice => choice.label)).toEqual(["거절", "허용", "이번만 허용"]);
    const once = approval.choices.find(choice => choice.label === "이번만 허용");
    if (!once) throw new Error("Missing replacement choice");
    expect((await fixture.choose(id, approval.id, once.id)).status).toBe(200);
    expect(await fixture.gateway.wait(id)).toMatchObject({ status: "completed", remoteId: "fixture" });
    expect(fixture.events).toEqual(["navigate:/thread/new", "send", "click:once"]);
  } finally { await fixture.close(); }
});
