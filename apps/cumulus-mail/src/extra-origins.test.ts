import { test } from "node:test";
import assert from "node:assert/strict";
import { extraOrigins } from "./vercel.ts";

test("mirror origins must sit under the passkey rpId", () => {
  assert.deepEqual(extraOrigins(undefined, "mail.cumuluscloud.app"), []);
  assert.deepEqual(extraOrigins(" https://ru.mail.cumuluscloud.app/ ,", "mail.cumuluscloud.app"), ["https://ru.mail.cumuluscloud.app"]);
  assert.throws(() => extraOrigins("https://evil.example", "mail.cumuluscloud.app"), /not under/);
  assert.throws(() => extraOrigins("https://xmail.cumuluscloud.app", "mail.cumuluscloud.app"), /not under/);
});
