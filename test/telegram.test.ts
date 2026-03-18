import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sendTelegramReply } from "../src/telegram";

let originalFetch: typeof globalThis.fetch;

function buildTelegramResponse(messageId: number) {
  return new Response(JSON.stringify({ ok: true, result: { message_id: messageId } }), {
    status: 200,
    headers: { "content-type": "application/json; charset=UTF-8" }
  });
}

describe("sendTelegramReply", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  beforeAll(() => {
    originalFetch = globalThis.fetch;
  });

  it("keeps short replies as a single trimmed Telegram message", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(buildTelegramResponse(5000));

    await sendTelegramReply({
      env: { TELEGRAM_BOT_TOKEN: "telegram-test-token" } as Env,
      chatId: 777,
      replyToMessageId: 123,
      text: "  short Telegram reply  "
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const outboundPayload = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body)) as {
      reply_to_message_id: number;
      text: string;
    };

    expect(outboundPayload.reply_to_message_id).toBe(123);
    expect(outboundPayload.text).toBe("short Telegram reply");
  });

  it("splits over-limit replies into ordered Telegram chunks without truncation", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(buildTelegramResponse(5001)).mockResolvedValueOnce(buildTelegramResponse(5002));

    const paragraphOne = "Alpha sentence ".repeat(180);
    const paragraphTwo = "Beta sentence ".repeat(180);
    const longReply = `${paragraphOne}\n\n${paragraphTwo}`;

    expect(longReply.length).toBeGreaterThan(4096);

    await sendTelegramReply({
      env: { TELEGRAM_BOT_TOKEN: "telegram-test-token" } as Env,
      chatId: 778,
      replyToMessageId: 456,
      text: longReply
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const firstPayload = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body)) as {
      reply_to_message_id: number;
      text: string;
    };
    const secondPayload = JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body)) as {
      reply_to_message_id: number;
      text: string;
    };

    expect(firstPayload.text.length).toBeLessThanOrEqual(4000);
    expect(secondPayload.text.length).toBeLessThanOrEqual(4000);
    expect(firstPayload.reply_to_message_id).toBe(456);
    expect(secondPayload.reply_to_message_id).toBe(5001);
    expect(firstPayload.text.endsWith("\n\n")).toBe(true);
    expect(secondPayload.text.startsWith("Beta sentence ")).toBe(true);
    expect(`${firstPayload.text}${secondPayload.text}`).toBe(longReply.trim());
  });
});