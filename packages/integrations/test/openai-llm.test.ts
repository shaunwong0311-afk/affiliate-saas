import { describe, it, expect, vi, afterEach } from "vitest";
import { OpenAiCompatibleLlmClient } from "../src/index.js";

afterEach(() => vi.unstubAllGlobals());

describe("OpenAiCompatibleLlmClient", () => {
  it("POSTs an OpenAI chat-completions request and returns the message content", async () => {
    let captured: { url: string; body: any; auth: string } | null = null;
    vi.stubGlobal("fetch", async (url: string, init: any) => {
      captured = { url, body: JSON.parse(init.body), auth: init.headers.Authorization };
      return { json: async () => ({ choices: [{ message: { content: "0.91" } }] }) };
    });
    const llm = new OpenAiCompatibleLlmClient({ apiKey: "xai-key", baseUrl: "https://api.x.ai/v1", model: "grok-4-fast-non-reasoning" });
    const out = await llm.complete("rate this", { system: "be terse", maxTokens: 8 });

    expect(out).toBe("0.91");
    expect(captured!.url).toBe("https://api.x.ai/v1/chat/completions");
    expect(captured!.auth).toBe("Bearer xai-key");
    expect(captured!.body.model).toBe("grok-4-fast-non-reasoning");
    expect(captured!.body.messages[0]).toEqual({ role: "system", content: "be terse" });
    expect(captured!.body.messages[1]).toEqual({ role: "user", content: "rate this" });
  });

  it("returns empty string on a transport error (never throws)", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    const llm = new OpenAiCompatibleLlmClient({ apiKey: "k", baseUrl: "https://api.x.ai/v1", model: "m" });
    expect(await llm.complete("x")).toBe("");
  });
});
