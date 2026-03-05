import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";

test("health endpoint", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const app = await buildApp();
  const response = await app.inject({
    method: "GET",
    url: "/healthz"
  });

  assert.equal(response.statusCode, 200);
  await app.close();
});
