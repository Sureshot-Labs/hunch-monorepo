import {
  telegramAssetCustomEmojiName,
  telegramCustomEmojiId,
} from "./telegram-custom-emoji.js";

/** Shared presentation only: callbacks and route availability stay with callers. */
export function telegramDepositButtonAppearance(
  assets: readonly string[],
  network: string,
) {
  // Inline buttons support one custom emoji, placed before their plain-text label.
  const assetEmoji = telegramAssetCustomEmojiName(assets[0]);
  return {
    ...(assetEmoji
      ? { icon_custom_emoji_id: telegramCustomEmojiId(assetEmoji) }
      : {}),
    text: `${assets.join(" / ")} · ${network}`,
  };
}

export function telegramDepositButtonRows<T>(buttons: readonly T[]): T[][] {
  const rows: T[][] = [];
  for (let index = 0; index < buttons.length; index += 2) {
    rows.push(buttons.slice(index, index + 2));
  }
  return rows;
}
