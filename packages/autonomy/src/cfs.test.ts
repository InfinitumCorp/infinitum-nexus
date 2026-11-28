import assert from "node:assert/strict";
import { test } from "node:test";
import { cfsPrimaryHeader } from "./cfs.ts";

test("cFS command header matches CFE_MSG_CMD_HDR_INIT", () => {
  assert.deepEqual(
    [...cfsPrimaryHeader(0x1881, 100)],
    [0x18, 0x81, 0xc0, 0x00, 0x00, 0x5d],
  );
});
