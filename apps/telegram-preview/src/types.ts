// Wire-only snapshot contract. The runtime deliberately has no API imports.
export type Button = {
  text: string;
  style?: "primary" | "success" | "danger";
  icon_custom_emoji_id?: string;
  callback_data?: string;
  url?: string;
  web_app?: { url: string };
  copy_text?: { text: string };
};

export type Message = {
  text: string;
  parse_mode?: "MarkdownV2";
  reply_markup?: { inline_keyboard: Button[][] };
  rich_message?: Record<string, unknown>;
  photo?: { base64: string; filename: string };
};

export type Screen = {
  id: string;
  title: string;
  group: string;
  message: Message;
  fallback: Message;
  // Destinations are indexed by the original callback_data, never by labels.
  routes: Record<string, string>;
  input?: string;
};

export type Catalog = { version: 1; screens: Screen[] };

export type TelegramMessage = {
  message_id: number;
  date?: number;
  from?: { id: number; is_bot?: boolean };
  chat: { id: number; type: string };
  text?: string;
};

export type Update = {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: {
    id: string;
    from: { id: number; is_bot?: boolean };
    message?: TelegramMessage;
    data?: string;
  };
};

export interface Telegram {
  call<T = unknown>(
    method: string,
    payload: Record<string, unknown>,
  ): Promise<T>;
}
