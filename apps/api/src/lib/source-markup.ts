export function stripSourceMarkup(value: string): string {
  return value
    .replace(/\[\[?\d+\]?\]\([^)]*$/g, "")
    .replace(/\[[^\]]+\]\(https?:\/\/[^)\s]*$/gi, "")
    .replace(/\[\[?\d+\]?\]\([^)]+\)/g, "")
    .replace(/\[(\d+)\]\(https?:\/\/[^)]+\)/gi, "")
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/gi, "$1")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\[\[?\d+\]?\]?/g, "")
    .replace(/[*_`~>#]/g, "")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
