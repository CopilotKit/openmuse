import assert from "node:assert/strict";
import { test } from "node:test";
import { linkOnboarding, onboardingEnabled } from "../apps/server/src/onboarding-telemetry.ts";

const body = {
  installation_id: "00000000-0000-4000-8000-000000000001",
  event_id: "00000000-0000-4000-8000-000000000002",
  platform: "web",
  app_version: "0.1.0",
};
test("link binds server project identity, rejects extras and observes all optouts", async () => {
  const sent: unknown[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response("{}", { status: 202 });
  };
  assert.deepEqual(await linkOnboarding(body, { CPK_TELEMETRY_ID: " project_1 " }, fetcher), {
    enabled: true,
    linked: true,
  });
  assert.equal((sent[0] as { event: string }).event, "oss.onboarding.identity_linked");
  assert.equal(JSON.stringify(sent).includes("project_1"), true);
  assert.deepEqual(await linkOnboarding(body, {}, fetcher), { enabled: true, linked: false });
  await assert.rejects(() => linkOnboarding({ ...body, project_id: "malicious" }, {}, fetcher));
  for (const key of ["DO_NOT_TRACK", "COPILOTKIT_TELEMETRY_DISABLED"])
    for (const value of ["1", "true"]) assert.equal(onboardingEnabled({ [key]: value }), false);
  assert.equal(onboardingEnabled({ COPILOTKIT_TELEMETRY_SAMPLE_RATE: "0" }), false);
  assert.deepEqual(await linkOnboarding(body, { DO_NOT_TRACK: "1" }, fetcher), {
    enabled: false,
    linked: false,
  });
  assert.equal(sent.length, 1);
  await assert.rejects(
    () =>
      linkOnboarding(
        body,
        { CPK_TELEMETRY_ID: "p" },
        async () => new Response("", { status: 503 }),
      ),
    /Telemetry temporarily unavailable/,
  );
});
