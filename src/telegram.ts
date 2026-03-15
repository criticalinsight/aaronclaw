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
  callbackQuery?: {
    id: string;
    from: TelegramUser;
    message?: TelegramMessage;
    data?: string;
  } | null;
}

export interface TelegramInlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface TelegramInlineKeyboardMarkup {
  inline_keyboard: TelegramInlineKeyboardButton[][];
}

const TELEGRAM_MAX_MESSAGE_LENGTH = 4000;
const TELEGRAM_PREFERRED_SPLIT_DELIMITERS = ["\n\n", "\n", ". ", "? ", "! ", "; ", ": ", ", ", " "];

export const SCHEMATIC_EMOJIS = {
  WIZARD: "🧙🏾‍♂️",
  PULSE: "⚡",
  SEARCH: "🔍",
  HAND: "✋",
  STATUS: "📊",
  AUDIT: "📋",
  ECONOMOS: "💰",
  SOPHIA: "🧠",
  REBALANCE: "🏗️",
  SHIELD: "🛡️",
  HEALTHY: "✅",
  WARNING: "⚠️",
  ERROR: "❌",
  ORBIT: "🛰️",
  SOVEREIGN: "🏛️",
  FACTORY: "🏭",
  REFRESH: "🔄",
  SUCCESS: "✅",
  FAILURE: "❌"
};

/**
 * Escapes characters for Telegram MarkdownV2 compliance.
 * See: https://core.telegram.org/bots/api#markdownv2-style
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

type TelegramSendMessageResponse = {
  description?: string;
  ok?: boolean;
  result?: {
    message_id?: number;
  };
};

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
    message: parseTelegramMessage(object.message) ?? parseTelegramMessage(object.edited_message),
    callbackQuery: object.callback_query ? {
      id: asString(asObject(object.callback_query)?.id) ?? "",
      from: parseTelegramUser(asObject(object.callback_query)?.from)!,
      message: parseTelegramMessage(asObject(object.callback_query)?.message) ?? undefined,
      data: asString(asObject(object.callback_query)?.data)
    } : null
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
  replyToMessageId?: number;
  text: string;
  parseMode?: "MarkdownV2" | "HTML";
  replyMarkup?: TelegramInlineKeyboardMarkup;
}): Promise<void> {
  const token = input.env.TELEGRAM_BOT_TOKEN?.trim();

  if (!token) {
    throw new Error("telegram bot token is not configured");
  }

  let replyToMessageId = input.replyToMessageId;

  for (const chunk of splitTelegramReplyText(input.text)) {
    const payload = await sendTelegramMessage({
      token,
      chatId: input.chatId,
      replyToMessageId,
      text: chunk,
      parseMode: input.parseMode,
      replyMarkup: input.replyMarkup
    });

    replyToMessageId = payload.result?.message_id ?? replyToMessageId;
  }
}

/**
 * Sends a push notification to the configured administrator chat.
 */
export async function broadcastTelegramMessage(input: {
  env: Env;
  text: string;
  parseMode?: "MarkdownV2" | "HTML";
  replyMarkup?: TelegramInlineKeyboardMarkup;
}): Promise<void> {
  const token = input.env.TELEGRAM_BOT_TOKEN?.trim();
  const adminChatId = input.env.TELEGRAM_ADMIN_CHAT_ID;

  if (!token) {
    console.warn("telegram bot token is not configured, skipping broadcast");
    return;
  }

  if (!adminChatId) {
    console.warn("TELEGRAM_ADMIN_CHAT_ID is not configured, skipping broadcast");
    return;
  }

  const chatId = typeof adminChatId === "string" ? parseInt(adminChatId, 10) : adminChatId;

  if (isNaN(chatId)) {
    console.warn("TELEGRAM_ADMIN_CHAT_ID is invalid, skipping broadcast");
    return;
  }

  for (const chunk of splitTelegramReplyText(input.text)) {
    await sendTelegramMessage({
      token,
      chatId,
      text: chunk,
      parseMode: input.parseMode,
      replyMarkup: input.replyMarkup
    });
  }
}

async function sendTelegramMessage(input: {
  token: string;
  chatId: number;
  replyToMessageId?: number;
  text: string;
  parseMode?: "MarkdownV2" | "HTML";
  replyMarkup?: TelegramInlineKeyboardMarkup;
}): Promise<TelegramSendMessageResponse> {
  const response = await fetch(`https://api.telegram.org/bot${input.token}/sendMessage`, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=UTF-8"
    },
    body: JSON.stringify({
      chat_id: input.chatId,
      text: input.text,
      reply_to_message_id: input.replyToMessageId,
      allow_sending_without_reply: true,
      parse_mode: input.parseMode,
      reply_markup: input.replyMarkup
    })
  });

  const payload = (await response.json().catch(() => null)) as TelegramSendMessageResponse | null;

  if (!response.ok || payload?.ok === false) {
    throw new Error(
      payload?.description
        ? `telegram sendMessage failed: ${payload.description}`
        : `telegram sendMessage failed with status ${response.status}`
    );
  }

  return payload ?? {};
}

function splitTelegramReplyText(value: string): string[] {
  const trimmed = value.trim();

  if (trimmed.length <= TELEGRAM_MAX_MESSAGE_LENGTH) {
    return [trimmed];
  }

  const chunks: string[] = [];
  let remaining = trimmed;

  while (remaining.length > TELEGRAM_MAX_MESSAGE_LENGTH) {
    const splitAt = findTelegramSplitIndex(remaining, TELEGRAM_MAX_MESSAGE_LENGTH);
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  chunks.push(remaining);

  return chunks;
}

function findTelegramSplitIndex(value: string, maxLength: number): number {
  for (const delimiter of TELEGRAM_PREFERRED_SPLIT_DELIMITERS) {
    const boundary = value.lastIndexOf(delimiter, maxLength - delimiter.length);

    if (boundary > 0) {
      return boundary + delimiter.length;
    }
  }

  return maxLength;
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
    from: parseTelegramUser(from)
  };
}

function parseTelegramUser(value: unknown): TelegramUser | null {
  const from = asObject(value);
  if (!from) return null;
  return {
    id: asNumber(from.id) ?? 0,
    isBot: Boolean(from.is_bot),
    username: asString(from.username),
    firstName: asString(from.first_name),
    lastName: asString(from.last_name)
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