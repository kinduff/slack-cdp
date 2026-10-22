import { test } from "node:test";
import assert from "node:assert/strict";
import { apiExpression, formFields, workspacesExpression } from "../src/page.js";

test("apiExpression is valid JS even with quotes and backticks in params", () => {
  const text = "It's `a` \"song\" ${x} — ñ </script>";
  const expr = apiExpression("chat.postMessage", { channel: "C01", text }, "T01");
  assert.doesNotThrow(() => new Function(`return ${expr}`));
  assert.ok(expr.includes(JSON.stringify(text).slice(1, -1)));
});

test("workspacesExpression is valid JS", () => {
  assert.doesNotThrow(() => new Function(`return ${workspacesExpression}`));
});

test("formFields stringifies values, sends objects as JSON and drops empty ones", () => {
  assert.deepEqual(formFields({ limit: 20, archived: true, blocks: [{ type: "divider" }], cursor: undefined, ts: null, text: "" }), {
    limit: "20",
    archived: "true",
    blocks: '[{"type":"divider"}]',
    text: "",
  });
});
