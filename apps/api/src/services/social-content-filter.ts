import {
  DetectModerationLabelsCommand,
  RekognitionClient,
  type ModerationLabel,
} from "@aws-sdk/client-rekognition";
import { ContentError } from "./content-errors.js";
import { SocialError } from "./social-primitives.js";

export const AVATAR_MAX_FILTER_BYTES = 5_000_000;
export const AVATAR_MODERATION_REGION = "eu-west-1";

// Deliberately scoped to severe explicit content, targeted abuse and death threats.
// Reports and moderator reasons must be able to quote abusive text.
const prohibitedText = [
  /\b(?:fuck(?:ing|ed|er|ers|s)?|motherfuck\w*|cunts?|cock(?:s|sucker)?|pussy|dickheads?|whore(?:s)?|sluts?)\b/u,
  /(?:^|[^\p{L}])(?:[бп]л[яе]д[ььи][\p{L}]*|[её]б(?:а[нлт]|у|и|л)[\p{L}]*|ху[йеяю][\p{L}]*|пизд[\p{L}]*)(?=[^\p{L}]|$)/u,
  /\b(?:kill yourself|go kill yourself|i (?:will|gonna) kill you|i will rape you)\b/u,
  /\b(?:nigg(?:er|ers|a|as)|faggots?)\b/u,
  /(?:^|\s)(?:убей себя|я (?:тебя убью|убью тебя)|пидорас(?:ы|ов)?|хач(?:и|ей))(?=\s|[.!?,]|$)/u,
  /\b(?:child porn(?:ography)?|child sexual abuse material)\b/u,
];

export function isSocialTextAllowed(value: string): boolean {
  const normalized = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{Cf}\u034f]/gu, "")
    .replace(/\s+/gu, " ");
  return !prohibitedText.some((pattern) => pattern.test(normalized));
}

export function requireAllowedSocialText(value: string): string {
  if (!isSocialTextAllowed(value))
    throw new SocialError("content_not_allowed", 422);
  return value;
}

const rejectedLabels = new Set([
  "Explicit Nudity",
  "Explicit",
  "Graphic Violence Or Gore",
  "Graphic Violence",
  "Visually Disturbing",
  "Hate Symbols",
  "Extremist",
  "Violence",
]);
export function avatarLabelsRejected(
  labels: readonly ModerationLabel[],
): boolean {
  return labels.some(
    (label) =>
      (label.Confidence ?? 0) >= 80 &&
      [label.Name, label.ParentName].some(
        (name) => name != null && rejectedLabels.has(name),
      ),
  );
}

const rekognition = new RekognitionClient({
  region: AVATAR_MODERATION_REGION,
  maxAttempts: 2,
});
export async function checkAvatarContent(
  bytes: Uint8Array,
  client: Pick<RekognitionClient, "send"> = rekognition,
): Promise<void> {
  if (!bytes.length || bytes.length > AVATAR_MAX_FILTER_BYTES)
    throw new ContentError(
      "avatar_unsupported",
      "Choose a JPEG or PNG smaller than 5 MB",
      422,
    );
  let result;
  try {
    result = await client.send(
      new DetectModerationLabelsCommand({
        Image: { Bytes: bytes },
        MinConfidence: 80,
      }),
      { abortSignal: AbortSignal.timeout(15_000) },
    );
  } catch {
    throw new ContentError(
      "avatar_check_unavailable",
      "Photo safety check is temporarily unavailable",
      503,
    );
  }
  if (!result.ModerationModelVersion || !Array.isArray(result.ModerationLabels))
    throw new ContentError(
      "avatar_check_unavailable",
      "Photo safety check did not complete",
      503,
    );
  if (avatarLabelsRejected(result.ModerationLabels))
    throw new ContentError(
      "content_not_allowed",
      "Choose a photo that follows the Community guidelines",
      422,
    );
}
