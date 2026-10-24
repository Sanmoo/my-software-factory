import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { LinuxNotifier, renderNotification } from "./linux.js";
import {
  factoryUnavailableNotice,
  helpNotice,
  interventionNotice,
  reviewNotice,
  type WorkNotification,
} from "./port.js";
import {
  githubRepository,
  githubTicket,
  jiraTicket,
  workIdentity,
  type WorkIdentity,
} from "../tracker/identity.js";

const REPO = "Sanmoo/my-tasks";
const githubWork = workIdentity(githubTicket(REPO, 42), githubRepository(REPO));
const jiraWork = workIdentity(
  jiraTicket({
    site: "acme.atlassian.net",
    stableId: "10042",
    key: "ABC-42",
    url: "https://acme.atlassian.net/browse/ABC-42",
  }),
  githubRepository(REPO),
);

const review: WorkNotification = reviewNotice(githubWork, 7);
const help: WorkNotification = helpNotice(githubWork);

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
    const { title, body } = renderNotification(interventionNotice(githubWork));

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
    assert.ok(review.url === "https://github.com/Sanmoo/my-tasks/pull/7");
    assert.ok(body.includes(review.url!), "the PR address is in the content");
    assert.match(body, /review/i);
  });

  test("a help notice identifies the work, states the reason and shows the ticket address", () => {
    const { title, body } = renderNotification(help);

    assert.match(title, /Sanmoo\/my-tasks#42/);
    assert.match(title, /help/i);
    assert.ok(body.includes(help.url!), "the ticket address is in the content");
    assert.match(body, /blocked|attention/i);
  });

  test("a Jira notice points at the Jira ticket and never synthesizes a GitHub issue URL", () => {
    const notice = helpNotice(jiraWork);
    const { title, body } = renderNotification(notice);

    assert.match(title, /ABC-42/);
    assert.match(title, /jira:acme\.atlassian\.net/);
    assert.equal(notice.url, "https://acme.atlassian.net/browse/ABC-42");
    assert.match(body, /acme\.atlassian\.net\/browse\/ABC-42/);
    assert.doesNotMatch(`${title}\n${body}`, /github\.com\/.*\/issues\//, "no invented GitHub issue");
  });

  test("a Jira identity without a presentation URL is named without inventing an address", () => {
    const withoutUrl = workIdentity(
      jiraTicket({ site: "acme.atlassian.net", stableId: "10043", key: "ABC-43" }),
      githubRepository(REPO),
    );
    const notice = interventionNotice(withoutUrl);
    const { title, body } = renderNotification(notice);

    assert.equal(notice.url, null);
    assert.match(title, /ABC-43/);
    assert.match(title, /jira:acme\.atlassian\.net/);
    assert.doesNotMatch(`${title}\n${body}`, /https?:\/\//, "the notice invents no URL");
  });

  test("a review notice of a Jira Work points at the destination PR, never at the ticket site", () => {
    const notice = reviewNotice(jiraWork, 11);
    const { body } = renderNotification(notice);

    assert.equal(notice.url, "https://github.com/Sanmoo/my-tasks/pull/11");
    assert.match(body, /Sanmoo\/my-tasks\/pull\/11/);
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
    assert.ok(call.args.some((arg) => arg.includes(review.url!)), "the address is shown");
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
