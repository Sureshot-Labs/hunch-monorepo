import { z } from "zod";
import { socialPolicySchema } from "../services/social-policy.js";
import * as schema from "./social.js";

const errors = {
  400: schema.socialErrorSchema,
  401: schema.socialErrorSchema,
  403: schema.socialErrorSchema,
  404: schema.socialErrorSchema,
  409: schema.socialErrorSchema,
  429: schema.socialErrorSchema,
  500: schema.socialErrorSchema,
  503: schema.socialErrorSchema,
};
const idResponse = z.object({ id: z.string().uuid() });
const configResponse = z.object({
  policy: socialPolicySchema,
  revision: z.string(),
  source: z.enum(["default", "db"]),
  effectiveAt: z.string().nullable(),
});
const profilePage = {
  params: schema.socialIdParams,
  querystring: schema.socialPageQuery,
  response: { 200: schema.socialProfilesResponse, ...errors },
};
const userAction = {
  params: schema.socialIdParams,
  response: { 200: schema.socialOkSchema, ...errors },
};
const likeAction = {
  params: schema.socialLikeParams,
  response: { 200: schema.socialOkSchema, ...errors },
};

// Schema-only entry point: the offline contract generator must not import routes,
// authentication, API environment parsing, or database/runtime service owners.
export const socialRouteSchemas = {
  get: {
    "/social/config": { response: { 200: configResponse, ...errors } },
    "/social/hunches/:id": {
      params: schema.socialIdParams,
      response: { 200: schema.socialHunchSchema, ...errors },
    },
    "/social/copies/:idempotencyKey": {
      params: schema.socialCopyStatusParams,
      response: { 200: schema.socialCopyStatusResponse, ...errors },
    },
    "/users/handles/:handle": {
      params: schema.socialHandleParams,
      response: { 200: schema.socialHandleResponse, ...errors },
    },
    "/users/by-handle/:handle": {
      params: schema.socialHandleParams,
      response: { 200: schema.socialProfileResponse, ...errors },
    },
    "/users/suggestions": {
      querystring: schema.socialPageQuery,
      response: { 200: schema.socialProfilesResponse, ...errors },
    },
    "/users/rankings": {
      querystring: schema.socialPageQuery,
      response: { 200: schema.socialProfilesResponse, ...errors },
    },
    "/users/me/blocks": {
      querystring: schema.socialPageQuery,
      response: { 200: schema.socialProfilesResponse, ...errors },
    },
    "/users/:id/profile": {
      params: schema.socialIdParams,
      response: { 200: schema.socialProfileResponse, ...errors },
    },
    "/users/:id/followers": profilePage,
    "/users/:id/following": profilePage,
    "/theses/eligibility": {
      querystring: schema.socialEligibilityQuery,
      response: { 200: schema.socialEligibilitySchema, ...errors },
    },
    "/theses/:id": {
      params: schema.socialIdParams,
      response: { 200: schema.socialThesisSchema, ...errors },
    },
    "/social/feed": {
      querystring: schema.socialFeedQuery,
      response: { 200: schema.socialFeedResponse, ...errors },
    },
    "/users/:id/theses": {
      params: schema.socialIdParams,
      querystring: schema.socialPageQuery,
      response: { 200: schema.socialFeedResponse, ...errors },
    },
    "/markets/:marketId/theses": {
      params: z.object({ marketId: z.string() }),
      querystring: schema.socialPageQuery,
      response: { 200: schema.socialFeedResponse, ...errors },
    },
    "/social/comments": {
      querystring: schema.socialCommentsQuery,
      response: { 200: schema.socialCommentsResponse, ...errors },
    },
  },
  post: {
    "/theses/eligibility/refresh": {
      body: schema.socialPurchaseRef,
      response: { 200: schema.socialOkSchema, ...errors },
    },
    "/theses": {
      body: schema.socialPublishBody,
      response: { 200: schema.socialThesisSchema, ...errors },
    },
    "/social/comments": {
      body: schema.socialCommentBody,
      response: { 200: idResponse, ...errors },
    },
    "/social/reports": {
      body: schema.socialReportBody,
      response: { 200: idResponse, ...errors },
    },
  },
  patch: {
    "/users/me/profile": {
      body: schema.socialProfilePatch,
      response: { 200: schema.socialProfileResponse, ...errors },
    },
  },
  put: {
    "/users/:id/follow": userAction,
    "/users/:id/block": userAction,
    "/social/likes/:targetKind/:targetId": likeAction,
  },
  delete: {
    "/users/:id/follow": userAction,
    "/users/:id/block": userAction,
    "/social/likes/:targetKind/:targetId": likeAction,
    "/theses/:id": userAction,
    "/social/comments/:id": userAction,
  },
} as const;
