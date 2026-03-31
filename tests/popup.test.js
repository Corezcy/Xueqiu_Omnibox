const test = require("node:test");
const assert = require("node:assert/strict");

global.document = {
  addEventListener() {},
};

const popup = require("../popup.js");

test("normalizeRefreshSettings returns defaults for empty input", () => {
  assert.deepEqual(popup.normalizeRefreshSettings(), {
    enabled: true,
    intervalMs: 2000,
  });
});

test("normalizeRefreshSettings falls back to defaults for invalid values", () => {
  assert.deepEqual(
    popup.normalizeRefreshSettings({
      enabled: "yes",
      intervalMs: 1234,
    }),
    {
      enabled: true,
      intervalMs: 2000,
    }
  );
});

test("normalizeRefreshSettings preserves supported interval values", () => {
  assert.deepEqual(
    popup.normalizeRefreshSettings({
      enabled: false,
      intervalMs: 10000,
    }),
    {
      enabled: false,
      intervalMs: 10000,
    }
  );
});
