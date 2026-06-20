import assert from "node:assert/strict";
import { ProviderWrapper } from "@meer/ai/providers/provider-wrapper.js";
import type { ChatMessage, Provider } from "@meer/ai/base.js";
import { httpRequest } from "@meer/coding-agent/tools/index.js";

class FailingProvider implements Provider {
  async chat(_messages: ChatMessage[]): Promise<string> {
    throw new TypeError("fetch failed", {
      cause: new Error("connect ECONNREFUSED 127.0.0.1:1234"),
    });
  }

  async *stream(_messages: ChatMessage[]): AsyncIterable<string> {
    throw new TypeError("fetch failed", {
      cause: new Error("connect ECONNRESET"),
    });
  }

  getCurrentModel(): string {
    return "failure-model";
  }
}

const wrapped = new ProviderWrapper(new FailingProvider(), {
  name: "test-provider",
  maxRetries: 0,
});

await assert.rejects(
  () => wrapped.chat([{ role: "user", content: "hi" }]),
  (error) => {
    assert(error instanceof Error);
    assert.match(error.message, /provider test-provider chat failed/);
    assert.match(error.message, /Target: model failure-model/);
    assert.match(error.message, /Reason: fetch failed/);
    assert.match(error.message, /connect ECONNREFUSED/);
    return true;
  }
);

const result = await httpRequest("http://127.0.0.1:9/__meer_missing__", {
  timeout: 100,
});

assert(result.error, "http_request should return contextual error");
assert.match(result.error ?? "", /tool http_request GET failed/);
assert.match(result.error ?? "", /Target: http:\/\/127\.0\.0\.1:9\/__meer_missing__/);
assert.match(result.error ?? "", /Reason:/);

console.log("error context verification passed");
