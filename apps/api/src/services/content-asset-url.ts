import { getContentServiceRuntime } from "../content-service-runtime.js";

export function contentAssetPublicUrl(key: string): string {
  return `${getContentServiceRuntime().assetPublicBaseUrl}/${key
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}
