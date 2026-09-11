const TELEGRAM_KEYCAP_NUMBERS = [
  "1️⃣",
  "2️⃣",
  "3️⃣",
  "4️⃣",
  "5️⃣",
  "6️⃣",
  "7️⃣",
  "8️⃣",
  "9️⃣",
  "🔟",
] as const;

export function telegramMenuIndexEmoji(index: number): string {
  if (!Number.isInteger(index) || index < 1) return "#️⃣";
  return TELEGRAM_KEYCAP_NUMBERS[index - 1] ?? String(index);
}
