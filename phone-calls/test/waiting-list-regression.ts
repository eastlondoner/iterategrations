import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pretendMind, until } from "./pretend-mind.ts";
import { pretendRoutes } from "./pretend-routes.ts";
import { emailIn, WAITING_LIST_CHANGES } from "../waiting-list.ts";

// emailIn: the one address in free text, or why there is none
assert.deepEqual(emailIn("Put me down as ada@example.com, thanks."), {
  ok: true,
  email: "ada@example.com",
});
assert.deepEqual(emailIn("It is Ada.Lovelace+List@Example.COM"), {
  ok: true,
  email: "ada.lovelace+list@example.com",
});
assert.deepEqual(emailIn("I will tell you my address later."), { ok: false, status: "no-address" });
assert.deepEqual(emailIn("ada at example dot com"), { ok: false, status: "no-address" });
assert.deepEqual(emailIn("ada@example.com or grace@example.org"), {
  ok: false,
  status: "several-addresses",
});
assert.deepEqual(emailIn("ada@example.com, I repeat, ADA@example.com"), {
  ok: true,
  email: "ada@example.com",
});
const long = `${"a".repeat(300 - "@example.com".length)}@example.com`;
assert.equal(long.length, 300);
assert.deepEqual(emailIn(`My address is ${long}`), { ok: false, status: "no-address" });
assert.equal(WAITING_LIST_CHANGES, 3);

const dir = mkdtempSync(join(tmpdir(), "waiting-list-"));
const sales = "447700900011",
  other = "447700900010",
  member = "447700900001";
const passwords = join(dir, "passwords");
mkdirSync(passwords);
for (const number of [sales, other]) writeFileSync(join(passwords, number), "fake");
Object.assign(process.env, {
  PHONE_CALLS_BIN: join(import.meta.dirname, "fake-bridge.mjs"),
  FAKE_BRIDGE_CONTROL: join(dir, "control-{line}.jsonl"),
  FAKE_BRIDGE_LOG: join(dir, "log-{line}.jsonl"),
  PHONE_SIP_NUMBERS: `+${other},+${sales}`,
  PHONE_SIP_PASSWORD_DIR: passwords,
  PHONE_CALLS_MEMBERS: JSON.stringify({ [member]: "Sam" }),
  PHONE_CALLS_ANSWER_STRANGERS: "1",
  PHONE_CALLS_STRANGER_MAIL_TO: "grace@example.org",
});
const lineSays = (event: Record<string, unknown>) =>
  appendFileSync(join(dir, `control-${sales}.jsonl`), JSON.stringify(event) + "\n");
const heard = (): Record<string, any>[] =>
  existsSync(join(dir, `log-${sales}.jsonl`))
    ? readFileSync(join(dir, `log-${sales}.jsonl`), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
try {
  const mind = pretendMind();
  const smsSent: unknown[] = [];
  const emailsSent: unknown[] = [];
  const api = {
    ...mind.itx,
    config: {
      sendSms: async (input: unknown) => void smsSent.push(input),
      routeCall: pretendRoutes({
        lines: [other, sales],
        sales: [sales],
        instructions: () => "## Opening\n\n> Hello.\n\nAsk for an email address.",
      }).routeCall,
    },
    email: { send: async (input: unknown) => void emailsSent.push(input) },
    repos: { get: () => ({ tip: async () => "test" }) },
    cd: (path: string) => {
      const context = mind.itx.cd(path);
      return {
        ...context,
        append: async (...events: Parameters<typeof context.append>[0][]) => {
          const result = [];
          for (const event of events) {
            await context.append(event);
            result.push({ ...event, offset: mind.events.length });
          }
          return result;
        },
      };
    },
  };
  const { default: provide } = await import("../calls-iterate.ts");
  const bridge = await provide({ itx: api as never });
  await until("registered", () => bridge.lines().every((line) => line.ready));
  const policy = await bridge.salesPolicy();
  assert.equal(policy?.waitingList.action, "note-waiting-list-email");
  assert.equal(policy?.waitingList.changesPerCall, WAITING_LIST_CHANGES);

  const begin = async (callId: string, number: string) => {
    lineSays({ event: "incoming", callId, number, from: number });
    await until("answered", () => heard().some((event) => event.answer === callId));
    await until("active", () => bridge.status()?.answered);
    const agent = bridge.status()!.streamPath!;
    return { relay: agent.replace("/agents", ""), client: agent.split("/").at(-1)! };
  };
  const ended = () => mind.events.filter((e) => e.type === "phone-calls/call-ended");
  const end = async () => {
    const count = ended().length;
    bridge.hangup();
    await until("ended", () => ended().length > count);
    return ended().at(-1)!.payload;
  };
  const answers = (relay: string) =>
    mind.events.filter(
      (e) => e.path === relay && e.type === "events.iterate.com/agent/web-message-sent",
    );
  const note = async (live: { relay: string; client: string }, words: string) => {
    const count = answers(live.relay).length;
    const result = await bridge.salesMessage(live.client, words);
    const answer = await until(
      "handoff answer",
      () => answers(live.relay).length > count && answers(live.relay).at(-1),
    );
    return { result, message: answer.payload.message as string };
  };
  const spoken = () =>
    mind.events.filter((e) => e.type === "events.iterate.com/voice-agent/words-given").length;

  // one address is noted, a later one replaces it, the fourth change is refused
  const first = await begin("noted", member);
  const spokenBefore = spoken();
  const once = await note(first, "Her address is Ada@Example.com, please add her.");
  assert.deepEqual(once.result.waitingList, { ok: true, status: "noted" });
  assert.equal(
    once.message.split("\n")[0],
    JSON.stringify({ action: "note-waiting-list-email", ok: true, status: "noted" }),
  );
  assert.match(once.message, /ada@example\.com is noted/);
  assert.match(once.message, /do not say that an email was sent/);
  assert.match(once.message, /\(2 changes left\)/);
  assert.equal(
    (await note(first, "Actually grace@example.org")).result.waitingList.status,
    "noted",
  );
  assert.equal(
    (await note(first, "ada@example.com and grace@example.org")).result.waitingList.status,
    "several-addresses",
  );
  assert.equal((await note(first, "Make it sam@example.org")).result.waitingList.status, "noted");
  const refused = await note(first, "No, ada@example.com after all");
  assert.deepEqual(refused.result.waitingList, { ok: false, status: "too-many-changes" });
  assert.match(refused.message, /no changes left/);
  assert.equal(spoken(), spokenBefore, "the bridge speaks nothing for this action");
  const firstEnded = await end();
  assert.equal(firstEnded.mode, "sales");
  assert.equal(firstEnded.promptCommit, "test");
  assert.deepEqual(firstEnded.waitingList, { email: "sam@example.org" });
  await assert.rejects(
    bridge.salesMessage(first.client, "ada@example.com"),
    /no active sales call/,
  );

  // words with no address note nothing, and the fact has no waitingList
  const second = await begin("no-address", "447700900002");
  const none = await note(second, "Send me the link by text instead.");
  assert.deepEqual(none.result.waitingList, { ok: false, status: "no-address" });
  assert.match(none.message, /name@example\.com/);
  await assert.rejects(
    bridge.salesMessage(first.client, "ada@example.com"),
    /no active sales call/,
  );
  await assert.rejects(
    bridge.salesMessage("phone-sales-another", "ada@example.com"),
    /no active sales call/,
  );
  const secondEnded = await end();
  assert.equal(secondEnded.mode, "sales");
  assert.ok(!("waitingList" in secondEnded));

  // the outcome facts hold no address; nothing was texted or mailed
  const outcomes = mind.events.filter((e) => e.type === "phone-calls/waiting-list-email-outcome");
  assert.deepEqual(
    outcomes.map((e) => e.payload.status),
    ["noted", "noted", "several-addresses", "noted", "too-many-changes", "no-address"],
  );
  for (const outcome of outcomes) {
    assert.deepEqual(Object.keys(outcome.payload).sort(), ["callId", "client", "line", "status"]);
    assert.doesNotMatch(JSON.stringify(outcome.payload), /@/);
  }
  assert.equal(smsSent.length, 0);
  assert.equal(emailsSent.length, 0);
  assert.equal(mind.messages.length, 0);
  assert.ok(!mind.provisioned.some((client) => client.startsWith("phone-sales-")));
  console.log(
    "PASS: waiting list: emailIn, noted address on call-ended, replacement, change limit, no address, closed or other client, no SMS or email, outcome facts without addresses",
  );
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
