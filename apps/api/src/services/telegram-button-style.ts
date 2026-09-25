/** Native Bot API button colors. Omit style for neutral navigation. */
export type TelegramButtonStyle = "primary" | "success" | "danger";

export type TelegramButtonAppearance = {
  icon_custom_emoji_id?: string;
  style?: TelegramButtonStyle;
};
