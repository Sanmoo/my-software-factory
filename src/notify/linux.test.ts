import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { LinuxNotifier, renderNotification } from "./linux.js";
import { factoryUnavailableNotice, interventionNotice, type WorkNotification } from "./port.js";

const review: WorkNotification = {
  ref: { repo: "Sanmoo/my-tasks", number: 42 },
  kind: "review",
  url: "https://github.com/Sanmoo/my-tasks/pull/7",
};

const help: WorkNotification = {
  ref: { repo: "Sanmoo/my-tasks", number: 42 },
  kind: "help",
  url: "https://github.com/Sanmoo/my-tasks/issues/42",
};

describe("notify: the factory's own occurrence (issue 118)", () => {
  test("a Docker-unavailable notice is identified as the factory's, names no work and invents no issue", () => {
    const { title, body } = renderNotification(factoryUnavailableNotice(3 * 60_000));

    assert.match(title, /factory/i);
    assert.match(title, /docker/i);
    assert.match(body, /3m/, "the continuous unavailability is named");
    assert.match(body, /suspended/i);
    assert.match(body, /preserved/i);
    assert.match(body, /resumes on its own/i, "no human act is asked for");
    assert.doesNotMatch(`${title}\n${body}`, /Sanmoo\/|my-tasks#/, "a factory occurrence never invents a work");
  });

  test("an intervention notice asks for a decision without claiming a block or an automatic act", () => {
    const { title, body } = renderNotification(
      interventionNotice({ repo: "Sanmoo/my-tasks", number: 42 }),
    );

    assert.match(title, /Sanmoo\/my-tasks#42/);
    assert.match(title, /intervention/i);
    assert.match(body, /nothing was ended, replaced or chosen/i);
    assert.ok(body.includes("https://github.com/Sanmoo/my-tasks/issues/42"));
  });
});

describe("notify: the Linux desktop backend", () => {
  test("a review notice identifies the work, states the reason and shows the PR address", () => {
    const { title, body } = renderNotification(review);

    assert.match(title, /Sanmoo\/my-tasks#42/);
    assert.match(title, /review/i);
    assert.ok(body.includes(review.url), "the PR address is in the content");
    assert.match(body, /review/i);
  });

  test("a help notice identifies the work, states the reason and shows the issue address", () => {
    const { title, body } = renderNotification(help);

    assert.match(title, /Sanmoo\/my-tasks#42/);
    assert.match(title, /help/i);
    assert.ok(body.includes(help.url), "the issue address is in the content");
    assert.match(body, /blocked|attention/i);
  });

  test("delivery hands notify-send the composed title and body (no window, no focus)", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const notifier = new LinuxNotifier({
      send: async (command, args) => {
        calls.push({ command, args });
      },
    });

    await notifier.notify(review);

    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.ok(call);
    assert.equal(call.command, "notify-send");
    assert.ok(call.args.includes("--app-name=msf"));
    assert.ok(call.args.some((arg) => /Sanmoo\/my-tasks#42/.test(arg)), "the work is named");
    assert.ok(call.args.some((arg) => arg.includes(review.url)), "the address is shown");
  });

  test("an unavailable backend (no binary / no graphical session) rejects — the loop reports it", async () => {
    const notifier = new LinuxNotifier({
      send: async () => {
        throw new Error("notify-send: command not found (no graphical session)");
      },
    });

    await assert.rejects(() => notifier.notify(help), /command not found/);
  });
});
