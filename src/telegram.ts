import type { JsonObject } from "./session-state";

interface TelegramUser {
  id: number;
  isBot: boolean;
  username?: string;
  firstName?: string;
  lastName?: string;
}

interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
  firstName?: string;
  lastName?: string;
}

export interface TelegramMessage {
  messageId: number;
  date: number | null;
  text: string | null;
  chat: TelegramChat;
  from: TelegramUser | null;
}

export interface TelegramUpdate {
  updateId: number | null;
  message: TelegramMessage | null;
}

const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

export function isTelegramConfigured(env: Env): boolean {
  return typeof env.TELEGRAM_BOT_TOKEN === "string" && env.TELEGRAM_BOT_TOKEN.trim().length > 0;
}

export function isTelegramWebhookAuthorized(request: Request, env: Env): boolean {
  const expected = env.TELEGRAM_WEBHOOK_SECRET?.trim();

  if (!expected) {
    return true;
  }

  return request.headers.get("x-telegram-bot-api-secret-token") === expected;
}

export function parseTelegramUpdate(value: unknown): TelegramUpdate | null {
  const object = asObject(value);

  if (!object) {
    return null;
  }

  return {
    updateId: asNumber(object.update_id),
    message: parseTelegramMessage(object.message) ?? parseTelegramMessage(object.edited_message)
  };
}

export function buildTelegramSessionId(message: TelegramMessage): string {
  const userId = message.from?.id ?? 0;
  return `telegram:chat:${message.chat.id}:user:${userId}`;
}

export function buildTelegramMessageMetadata(update: TelegramUpdate, message: TelegramMessage): JsonObject {
  return compactJsonObject({
    channel: "telegram",
    telegramUpdateId: update.updateId,
    telegramMessageId: message.messageId,
    telegramChatId: message.chat.id,
    telegramChatType: message.chat.type,
    telegramChatTitle: message.chat.title,
    telegramChatUsername: message.chat.username,
    telegramUserId: message.from?.id ?? null,
    telegramUsername: message.from?.username,
    telegramFirstName: message.from?.firstName,
    telegramLastName: message.from?.lastName,
    telegramDate: message.date
  });
}

export async function sendTelegramReply(input: {
  env: Env;
  chatId: number;
  replyToMessageId: number;
  text: string;
}): Promise<void> {
  const token = input.env.TELEGRAM_BOT_TOKEN?.trim();

  if (!token) {
    throw new Error("telegram bot token is not configured");
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=UTF-8"
    },
    body: JSON.stringify({
      chat_id: input.chatId,
      text: normalizeTelegramText(input.text),
      reply_to_message_id: input.replyToMessageId,
      allow_sending_without_reply: true
    })
  });

  const payload = (await response.json().catch(() => null)) as
    | { description?: string; ok?: boolean }
    | null;

  if (!response.ok || payload?.ok === false) {
    throw new Error(
      payload?.description
        ? `telegram sendMessage failed: ${payload.description}`
        : `telegram sendMessage failed with status ${response.status}`
    );
  }
}

function normalizeTelegramText(value: string): string {
  const trimmed = value.trim();

  if (trimmed.length <= TELEGRAM_MAX_MESSAGE_LENGTH) {
    return trimmed;
  }

  return `${trimmed.slice(0, TELEGRAM_MAX_MESSAGE_LENGTH - 1)}…`;
}

function parseTelegramMessage(value: unknown): TelegramMessage | null {
  const object = asObject(value);
  const chat = asObject(object?.chat);

  if (!object || !chat) {
    return null;
  }

  const messageId = asNumber(object.message_id);
  const chatId = asNumber(chat.id);
  const chatType = asString(chat.type);

  if (messageId === null || chatId === null || !chatType) {
    return null;
  }

  const from = asObject(object.from);

  return {
    messageId,
    date: asNumber(object.date),
    text: asString(object.text) ?? null,
    chat: {
      id: chatId,
      type: chatType,
      title: asString(chat.title),
      username: asString(chat.username),
      firstName: asString(chat.first_name),
      lastName: asString(chat.last_name)
    },
    from: from
      ? {
          id: asNumber(from.id) ?? 0,
          isBot: Boolean(from.is_bot),
          username: asString(from.username),
          firstName: asString(from.first_name),
          lastName: asString(from.last_name)
        }
      : null
  };
}

function compactJsonObject(value: Record<string, string | number | boolean | null | undefined>): JsonObject {
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string | number | boolean | null] => {
      return entry[1] !== undefined;
    })
  );
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}