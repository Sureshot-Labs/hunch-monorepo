import { z } from "zod";
export { CONTENT_RENDERER_CONTRACT_ID } from "@hunch/config/content";

export const CONTENT_DOCUMENT_SCHEMA_VERSION = 1 as const;
export const CONTENT_BLOCK_VERSION = 1 as const;
export const CONTENT_DOCUMENT_MAX_BYTES = 1_000_000;
export const CONTENT_DOCUMENT_MAX_BLOCKS = 500;

const externalUrlSchema = z
  .string()
  .trim()
  .url()
  .max(2_048)
  .refine((value) => {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password
    );
  }, "Only credential-free HTTP(S) URLs are allowed");

const canonicalUrlSchema = externalUrlSchema.refine((value) => {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  return (
    url.protocol === "https:" &&
    (hostname === "hunch.trade" || hostname.endsWith(".hunch.trade"))
  );
}, "Canonical URLs must use HTTPS on hunch.trade");

const blockIdSchema = z.string().uuid();
const assetIdSchema = z.string().uuid();

const markSchema = z.enum([
  "bold",
  "italic",
  "strike",
  "underline",
  "code",
  "highlight",
  "superscript",
  "subscript",
]);

const textInlineSchema = z.strictObject({
  type: z.literal("text"),
  text: z.string().max(20_000),
  marks: z.array(markSchema).max(8).optional(),
});

const linkInlineSchema = z.strictObject({
  type: z.literal("link"),
  text: z.string().min(1).max(2_000),
  href: externalUrlSchema,
  marks: z.array(markSchema).max(8).optional(),
  newWindow: z.boolean().default(false),
  rel: z.enum(["default", "nofollow", "sponsored"]).default("default"),
});

const hardBreakInlineSchema = z.strictObject({ type: z.literal("hardBreak") });

const footnoteReferenceInlineSchema = z.strictObject({
  type: z.literal("footnoteRef"),
  footnoteId: blockIdSchema,
  label: z.string().trim().min(1).max(32),
});

export const contentRichTextSchema = z
  .array(
    z.discriminatedUnion("type", [
      textInlineSchema,
      linkInlineSchema,
      hardBreakInlineSchema,
      footnoteReferenceInlineSchema,
    ]),
  )
  .max(2_000);

function block<TType extends string, TData extends z.ZodTypeAny>(
  type: TType,
  data: TData,
) {
  return z.strictObject({
    id: blockIdSchema,
    type: z.literal(type),
    version: z.literal(CONTENT_BLOCK_VERSION),
    data,
  });
}

const captionSchema = contentRichTextSchema.optional();

const imageReferenceFields = {
  assetId: assetIdSchema,
  alt: z.string().trim().max(500).default(""),
  decorative: z.boolean().default(false),
  caption: captionSchema,
  creditName: z.string().trim().max(200).nullable().optional(),
  creditUrl: externalUrlSchema.nullable().optional(),
  focalX: z.number().min(0).max(1).nullable().optional(),
  focalY: z.number().min(0).max(1).nullable().optional(),
};

export const contentImagePlacementSchema = z.strictObject({
  ...imageReferenceFields,
  crop: z
    .enum(["original", "square", "4:3", "3:2", "16:9", "1.91:1"])
    .default("original"),
  presentation: z.enum(["inline", "wide", "full", "cover"]).default("cover"),
});

export const contentSeoSchema = z.strictObject({
  title: z.string().trim().max(120).nullable().default(null),
  description: z.string().trim().max(320).nullable().default(null),
  canonicalUrl: canonicalUrlSchema.nullable().default(null),
  robots: z
    .strictObject({
      index: z.boolean().default(true),
      follow: z.boolean().default(true),
      noarchive: z.boolean().default(false),
      nosnippet: z.boolean().default(false),
      noimageindex: z.boolean().default(false),
    })
    .default({
      index: true,
      follow: true,
      noarchive: false,
      nosnippet: false,
      noimageindex: false,
    }),
  openGraphTitle: z.string().trim().max(120).nullable().default(null),
  openGraphDescription: z.string().trim().max(320).nullable().default(null),
  twitterTitle: z.string().trim().max(120).nullable().default(null),
  twitterDescription: z.string().trim().max(320).nullable().default(null),
});

export const contentAuthorSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  url: externalUrlSchema.nullable().default(null),
  bio: z.string().trim().max(1_000).nullable().default(null),
  avatarAssetId: assetIdSchema.nullable().default(null),
});

export const contentCategorySchema = z.strictObject({
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  label: z.string().trim().min(1).max(100),
});

export const contentTagSchema = z.strictObject({
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(1)
    .max(48)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  label: z.string().trim().min(1).max(80),
});

const paragraphBlockSchema = block(
  "paragraph",
  z.strictObject({ content: contentRichTextSchema }),
);

const leadBlockSchema = block(
  "lead",
  z.strictObject({ content: contentRichTextSchema }),
);

const headingBlockSchema = block(
  "heading",
  z.strictObject({
    level: z.union([z.literal(2), z.literal(3), z.literal(4)]),
    content: contentRichTextSchema,
    anchor: z
      .string()
      .trim()
      .toLowerCase()
      .max(120)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .nullable()
      .optional(),
  }),
);

const listBlockSchema = block(
  "list",
  z.strictObject({
    style: z.enum(["bullet", "numbered", "task"]),
    start: z.number().int().min(1).max(10_000).optional(),
    items: z
      .array(
        z.strictObject({
          id: blockIdSchema,
          content: contentRichTextSchema,
          depth: z.number().int().min(0).max(3).default(0),
          checked: z.boolean().nullable().optional(),
        }),
      )
      .min(1)
      .max(500),
  }),
);

const quoteBlockSchema = block(
  "quote",
  z.strictObject({
    content: contentRichTextSchema,
    attribution: z.string().trim().max(300).nullable().optional(),
    sourceUrl: externalUrlSchema.nullable().optional(),
  }),
);

const pullQuoteBlockSchema = block(
  "pullQuote",
  z.strictObject({
    content: contentRichTextSchema,
    attribution: z.string().trim().max(300).nullable().optional(),
    alignment: z.enum(["left", "center"]).default("center"),
  }),
);

const citationBlockSchema = block(
  "citation",
  z.strictObject({
    title: z.string().trim().min(1).max(500),
    url: externalUrlSchema,
    publisher: z.string().trim().max(200).nullable().optional(),
    publishedAt: z.string().datetime().nullable().optional(),
    accessedAt: z.string().datetime().nullable().optional(),
    note: contentRichTextSchema.optional(),
  }),
);

const referencesBlockSchema = block(
  "references",
  z.strictObject({
    title: z.string().trim().min(1).max(120).default("References"),
    items: z
      .array(
        z.strictObject({
          id: blockIdSchema,
          label: z.string().trim().min(1).max(500),
          url: externalUrlSchema.nullable().optional(),
          note: contentRichTextSchema.optional(),
        }),
      )
      .min(1)
      .max(200),
  }),
);

const footnotesBlockSchema = block(
  "footnotes",
  z.strictObject({
    title: z.string().trim().min(1).max(120).default("Footnotes"),
    items: z
      .array(
        z.strictObject({
          id: blockIdSchema,
          label: z.string().trim().min(1).max(32),
          content: contentRichTextSchema,
          sourceUrl: externalUrlSchema.nullable().optional(),
        }),
      )
      .min(1)
      .max(200),
  }),
);

const codeBlockSchema = block(
  "code",
  z.strictObject({
    code: z.string().max(100_000),
    language: z.string().trim().min(1).max(64).default("text"),
    filename: z.string().trim().max(255).nullable().optional(),
    caption: captionSchema,
    showLineNumbers: z.boolean().default(false),
  }),
);

const equationBlockSchema = block(
  "equation",
  z.strictObject({
    latex: z.string().trim().min(1).max(20_000),
    display: z.enum(["inline", "block"]).default("block"),
    caption: captionSchema,
  }),
);

const tableBlockSchema = block(
  "table",
  z.strictObject({
    caption: captionSchema,
    columns: z
      .array(
        z.strictObject({
          id: blockIdSchema,
          header: contentRichTextSchema,
          align: z.enum(["left", "center", "right"]).default("left"),
          width: z.number().int().min(5).max(100).nullable().optional(),
        }),
      )
      .min(1)
      .max(20),
    rows: z
      .array(
        z.strictObject({
          id: blockIdSchema,
          cells: z.array(contentRichTextSchema).min(1).max(20),
        }),
      )
      .min(1)
      .max(500),
  }),
);

const calloutBlockSchema = block(
  "callout",
  z.strictObject({
    tone: z.enum(["info", "tip", "note", "warning", "success", "danger"]),
    title: z.string().trim().max(160).nullable().optional(),
    content: contentRichTextSchema,
    icon: z.string().trim().max(64).nullable().optional(),
  }),
);

const articleNoticeBlockSchema = block(
  "articleNotice",
  z.strictObject({
    kind: z.enum(["update", "correction", "disclosure", "sponsored"]),
    title: z.string().trim().max(160).nullable().optional(),
    content: contentRichTextSchema,
    publishedAt: z.string().datetime().nullable().optional(),
  }),
);

const dividerBlockSchema = block(
  "divider",
  z.strictObject({ style: z.enum(["line", "dots", "space"]).default("line") }),
);

const detailsBlockSchema = block(
  "details",
  z.strictObject({
    summary: z.string().trim().min(1).max(300),
    content: contentRichTextSchema,
    openByDefault: z.boolean().default(false),
  }),
);

const definitionListBlockSchema = block(
  "definitionList",
  z.strictObject({
    title: z.string().trim().max(160).nullable().optional(),
    items: z
      .array(
        z.strictObject({
          id: blockIdSchema,
          term: z.string().trim().min(1).max(300),
          definition: contentRichTextSchema,
        }),
      )
      .min(1)
      .max(200),
  }),
);

const keyTakeawaysBlockSchema = block(
  "keyTakeaways",
  z.strictObject({
    title: z.string().trim().min(1).max(120).default("Key takeaways"),
    items: z.array(contentRichTextSchema).min(1).max(20),
  }),
);

const faqBlockSchema = block(
  "faq",
  z.strictObject({
    title: z.string().trim().max(120).nullable().optional(),
    items: z
      .array(
        z.strictObject({
          id: blockIdSchema,
          question: z.string().trim().min(1).max(500),
          answer: contentRichTextSchema,
        }),
      )
      .min(1)
      .max(50),
  }),
);

const timelineBlockSchema = block(
  "timeline",
  z.strictObject({
    title: z.string().trim().max(160).nullable().optional(),
    items: z
      .array(
        z.strictObject({
          id: blockIdSchema,
          label: z.string().trim().min(1).max(160),
          date: z.string().trim().max(120).nullable().optional(),
          content: contentRichTextSchema,
        }),
      )
      .min(1)
      .max(100),
  }),
);

const prosConsBlockSchema = block(
  "prosCons",
  z.strictObject({
    prosTitle: z.string().trim().min(1).max(80).default("Pros"),
    consTitle: z.string().trim().min(1).max(80).default("Cons"),
    pros: z.array(contentRichTextSchema).min(1).max(30),
    cons: z.array(contentRichTextSchema).min(1).max(30),
  }),
);

const metricBlockSchema = block(
  "metric",
  z.strictObject({
    label: z.string().trim().min(1).max(160),
    value: z.string().trim().min(1).max(160),
    detail: z.string().trim().max(500).nullable().optional(),
    trend: z.enum(["up", "down", "flat", "none"]).default("none"),
  }),
);

const statGridBlockSchema = block(
  "statGrid",
  z.strictObject({
    title: z.string().trim().max(160).nullable().optional(),
    columns: z.number().int().min(2).max(4).default(3),
    items: z
      .array(
        z.strictObject({
          id: blockIdSchema,
          label: z.string().trim().min(1).max(160),
          value: z.string().trim().min(1).max(160),
          detail: z.string().trim().max(500).nullable().optional(),
          trend: z.enum(["up", "down", "flat", "none"]).default("none"),
        }),
      )
      .min(2)
      .max(24),
  }),
);

const imageBlockSchema = block(
  "image",
  contentImagePlacementSchema.extend({
    linkUrl: externalUrlSchema.nullable().optional(),
  }),
);

const galleryItemSchema = z.strictObject({
  id: blockIdSchema,
  ...imageReferenceFields,
});

const galleryBlockSchema = block(
  "gallery",
  z.strictObject({
    layout: z.enum(["grid", "carousel", "masonry"]).default("grid"),
    columns: z.number().int().min(1).max(4).default(2),
    items: z.array(galleryItemSchema).min(2).max(50),
    caption: captionSchema,
  }),
);

const imageComparisonBlockSchema = block(
  "imageComparison",
  z.strictObject({
    before: z.strictObject(imageReferenceFields),
    after: z.strictObject(imageReferenceFields),
    beforeLabel: z.string().trim().max(80).default("Before"),
    afterLabel: z.string().trim().max(80).default("After"),
    caption: captionSchema,
  }),
);

const videoBlockSchema = block(
  "video",
  z
    .strictObject({
      assetId: assetIdSchema,
      posterAssetId: assetIdSchema.nullable().optional(),
      captionsAssetId: assetIdSchema.nullable().optional(),
      caption: captionSchema,
      transcript: contentRichTextSchema.optional(),
      hasAudio: z.boolean().default(true),
      autoplay: z.boolean().default(false),
      muted: z.boolean().default(false),
      loop: z.boolean().default(false),
    })
    .superRefine((value, context) => {
      if (value.autoplay && !value.muted) {
        context.addIssue({
          code: "custom",
          message: "Autoplay video must be muted",
          path: ["muted"],
        });
      }
    }),
);

const audioBlockSchema = block(
  "audio",
  z.strictObject({
    assetId: assetIdSchema,
    title: z.string().trim().max(300).nullable().optional(),
    caption: captionSchema,
    transcript: contentRichTextSchema.optional(),
  }),
);

export const contentEmbedProviderSchema = z.enum([
  "youtube",
  "vimeo",
  "x",
  "instagram",
  "tiktok",
  "bluesky",
  "reddit",
  "spotify",
  "soundcloud",
  "applePodcasts",
  "flourish",
  "datawrapper",
  "googleMaps",
]);

const EMBED_PROVIDER_HOSTS: Record<
  z.infer<typeof contentEmbedProviderSchema>,
  readonly string[]
> = {
  youtube: ["youtube.com", "youtu.be", "youtube-nocookie.com"],
  vimeo: ["vimeo.com"],
  x: ["x.com", "twitter.com"],
  instagram: ["instagram.com"],
  tiktok: ["tiktok.com"],
  bluesky: ["bsky.app"],
  reddit: ["reddit.com", "redd.it"],
  spotify: ["spotify.com"],
  soundcloud: ["soundcloud.com"],
  applePodcasts: ["podcasts.apple.com"],
  flourish: ["flourish.studio"],
  datawrapper: ["datawrapper.de", "dwcdn.net"],
  googleMaps: ["google.com", "maps.app.goo.gl"],
};

function embedHostAllowed(
  provider: keyof typeof EMBED_PROVIDER_HOSTS,
  host: string,
) {
  const normalized = host.toLowerCase().replace(/\.$/, "");
  return EMBED_PROVIDER_HOSTS[provider].some(
    (allowed) => normalized === allowed || normalized.endsWith(`.${allowed}`),
  );
}

const embedBlockSchema = block(
  "embed",
  z
    .strictObject({
      provider: contentEmbedProviderSchema,
      canonicalUrl: externalUrlSchema,
      resourceId: z
        .string()
        .trim()
        .min(1)
        .max(1_024)
        .regex(/^[^<>"']+$/, "Embed resource ID contains unsafe characters"),
      aspectRatio: z
        .enum(["auto", "1:1", "4:3", "16:9", "9:16"])
        .default("auto"),
      caption: captionSchema,
      consentCategory: z
        .enum(["essential", "analytics", "marketing"])
        .default("marketing"),
    })
    .superRefine((value, context) => {
      const url = new URL(value.canonicalUrl);
      if (url.protocol !== "https:") {
        context.addIssue({
          code: "custom",
          message: "Embed URLs must use HTTPS",
          path: ["canonicalUrl"],
        });
      }
      if (!embedHostAllowed(value.provider, url.hostname)) {
        context.addIssue({
          code: "custom",
          message: `URL host is not allowed for ${value.provider}`,
          path: ["canonicalUrl"],
        });
      }
    }),
);

const fileBlockSchema = block(
  "file",
  z.strictObject({
    assetId: assetIdSchema,
    label: z.string().trim().min(1).max(300),
    description: z.string().trim().max(1_000).nullable().optional(),
  }),
);

const linkCardBlockSchema = block(
  "linkCard",
  z.strictObject({
    url: externalUrlSchema,
    title: z.string().trim().min(1).max(300),
    description: z.string().trim().max(1_000).nullable().optional(),
    imageAssetId: assetIdSchema.nullable().optional(),
    publisher: z.string().trim().max(160).nullable().optional(),
  }),
);

const ctaBlockSchema = block(
  "cta",
  z.strictObject({
    title: z.string().trim().min(1).max(200),
    content: contentRichTextSchema.optional(),
    buttons: z
      .array(
        z.strictObject({
          id: blockIdSchema,
          label: z.string().trim().min(1).max(100),
          url: externalUrlSchema,
          style: z.enum(["primary", "secondary", "text"]).default("primary"),
        }),
      )
      .min(1)
      .max(3),
    tone: z.enum(["brand", "neutral", "accent"]).default("brand"),
  }),
);

const relatedArticlesBlockSchema = block(
  "relatedArticles",
  z.strictObject({
    title: z.string().trim().min(1).max(120).default("Related articles"),
    articleIds: z.array(z.string().uuid()).min(1).max(12),
  }),
);

const tableOfContentsBlockSchema = block(
  "tableOfContents",
  z.strictObject({
    title: z.string().trim().min(1).max(120).default("Table of contents"),
    maxDepth: z.union([z.literal(2), z.literal(3), z.literal(4)]).default(3),
  }),
);

const authorCardBlockSchema = block(
  "authorCard",
  z.strictObject({ showBio: z.boolean().default(true) }),
);

const newsletterBlockSchema = block(
  "newsletter",
  z.strictObject({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(500).nullable().optional(),
    audience: z.string().trim().max(100).default("blog"),
  }),
);

const marketSnapshotSchema = z.strictObject({
  version: z.literal(1),
  title: z.string().trim().min(1).max(300),
  subtitle: z.string().trim().max(500).nullable().optional(),
  probability: z.number().min(0).max(1).nullable().optional(),
  volumeUsd: z.number().finite().nonnegative().nullable().optional(),
  status: z.enum(["open", "closed", "resolved", "unknown"]),
  capturedAt: z.string().datetime(),
  url: externalUrlSchema.nullable().optional(),
});

const eventSnapshotSchema = z.strictObject({
  version: z.literal(1),
  title: z.string().trim().min(1).max(300),
  description: z.string().trim().max(1_000).nullable().optional(),
  startsAt: z.string().datetime().nullable().optional(),
  status: z.enum(["upcoming", "live", "completed", "unknown"]),
  capturedAt: z.string().datetime(),
  url: externalUrlSchema.nullable().optional(),
});

const marketCardBlockSchema = block(
  "marketCard",
  z
    .strictObject({
      marketId: z.string().trim().min(1).max(255),
      mode: z.enum(["live", "snapshot"]).default("live"),
      snapshot: marketSnapshotSchema.nullable().optional(),
    })
    .superRefine((value, context) => {
      if (value.mode === "snapshot" && !value.snapshot) {
        context.addIssue({
          code: "custom",
          message: "Snapshot mode requires a versioned market snapshot",
          path: ["snapshot"],
        });
      }
    }),
);

const eventCardBlockSchema = block(
  "eventCard",
  z
    .strictObject({
      eventId: z.string().trim().min(1).max(255),
      mode: z.enum(["live", "snapshot"]).default("live"),
      snapshot: eventSnapshotSchema.nullable().optional(),
    })
    .superRefine((value, context) => {
      if (value.mode === "snapshot" && !value.snapshot) {
        context.addIssue({
          code: "custom",
          message: "Snapshot mode requires a versioned event snapshot",
          path: ["snapshot"],
        });
      }
    }),
);

const oddsTableBlockSchema = block(
  "oddsTable",
  z.strictObject({
    title: z.string().trim().max(200).nullable().optional(),
    rows: z
      .array(
        z.strictObject({
          id: blockIdSchema,
          label: z.string().trim().min(1).max(200),
          probability: z.number().min(0).max(1),
          venue: z.string().trim().max(100).nullable().optional(),
          url: externalUrlSchema.nullable().optional(),
        }),
      )
      .min(1)
      .max(100),
    capturedAt: z.string().datetime(),
  }),
);

const probabilityChartBlockSchema = block(
  "probabilityChart",
  z.strictObject({
    title: z.string().trim().max(200).nullable().optional(),
    series: z
      .array(
        z.strictObject({
          id: blockIdSchema,
          label: z.string().trim().min(1).max(120),
          points: z
            .array(
              z.strictObject({
                at: z.string().datetime(),
                probability: z.number().min(0).max(1),
              }),
            )
            .min(1)
            .max(10_000),
        }),
      )
      .min(1)
      .max(20),
  }),
);

const chartBlockSchema = block(
  "chart",
  z
    .strictObject({
      kind: z.enum(["line", "area", "bar", "stackedBar", "pie", "donut"]),
      title: z.string().trim().max(200).nullable().optional(),
      categories: z.array(z.string().trim().max(160)).min(1).max(500),
      series: z
        .array(
          z.strictObject({
            id: blockIdSchema,
            label: z.string().trim().min(1).max(120),
            values: z.array(z.number().finite().nullable()).min(1).max(500),
            color: z
              .string()
              .trim()
              .regex(/^#[0-9a-f]{6}$/i)
              .nullable()
              .optional(),
          }),
        )
        .min(1)
        .max(20),
      xAxisLabel: z.string().trim().max(120).nullable().optional(),
      yAxisLabel: z.string().trim().max(120).nullable().optional(),
      sourceLabel: z.string().trim().max(300).nullable().optional(),
      sourceUrl: externalUrlSchema.nullable().optional(),
      capturedAt: z.string().datetime().nullable().optional(),
    })
    .superRefine((value, context) => {
      for (const [index, series] of value.series.entries()) {
        if (series.values.length !== value.categories.length) {
          context.addIssue({
            code: "custom",
            message: "Chart series length must match categories length",
            path: ["series", index, "values"],
          });
        }
      }
    }),
);

const marketComparisonBlockSchema = block(
  "marketComparison",
  z.strictObject({
    title: z.string().trim().max(200).nullable().optional(),
    marketIds: z.array(z.string().trim().min(1).max(255)).min(2).max(20),
    capturedAt: z.string().datetime().nullable().optional(),
  }),
);

const layoutChildSchema = z.discriminatedUnion("type", [
  paragraphBlockSchema,
  imageBlockSchema,
  quoteBlockSchema,
  calloutBlockSchema,
  metricBlockSchema,
]);

const columnsBlockSchema = block(
  "columns",
  z.strictObject({
    ratio: z.enum(["1:1", "1:2", "2:1"]).default("1:1"),
    columns: z
      .array(
        z.strictObject({
          id: blockIdSchema,
          blocks: z.array(layoutChildSchema).min(1).max(20),
        }),
      )
      .length(2),
    collapseOnMobile: z.boolean().default(true),
  }),
);

export const contentBlockSchema = z.discriminatedUnion("type", [
  paragraphBlockSchema,
  leadBlockSchema,
  headingBlockSchema,
  listBlockSchema,
  quoteBlockSchema,
  pullQuoteBlockSchema,
  citationBlockSchema,
  referencesBlockSchema,
  footnotesBlockSchema,
  codeBlockSchema,
  equationBlockSchema,
  tableBlockSchema,
  calloutBlockSchema,
  articleNoticeBlockSchema,
  dividerBlockSchema,
  detailsBlockSchema,
  definitionListBlockSchema,
  keyTakeawaysBlockSchema,
  faqBlockSchema,
  timelineBlockSchema,
  prosConsBlockSchema,
  metricBlockSchema,
  statGridBlockSchema,
  imageBlockSchema,
  galleryBlockSchema,
  imageComparisonBlockSchema,
  videoBlockSchema,
  audioBlockSchema,
  embedBlockSchema,
  fileBlockSchema,
  linkCardBlockSchema,
  ctaBlockSchema,
  relatedArticlesBlockSchema,
  tableOfContentsBlockSchema,
  authorCardBlockSchema,
  newsletterBlockSchema,
  marketCardBlockSchema,
  eventCardBlockSchema,
  oddsTableBlockSchema,
  probabilityChartBlockSchema,
  chartBlockSchema,
  marketComparisonBlockSchema,
  columnsBlockSchema,
]);

export const contentDocumentSchema = z
  .strictObject({
    schemaVersion: z.literal(CONTENT_DOCUMENT_SCHEMA_VERSION),
    blocks: z.array(contentBlockSchema).max(CONTENT_DOCUMENT_MAX_BLOCKS),
  })
  .superRefine((document, context) => {
    const idPaths = new Map<string, Array<string | number>>();
    const visitIds = (value: unknown, path: Array<string | number>) => {
      if (Array.isArray(value)) {
        value.forEach((item, index) => visitIds(item, [...path, index]));
        return;
      }
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        const childPath = [...path, key];
        if (key === "id" && typeof child === "string") {
          const previousPath = idPaths.get(child);
          if (previousPath) {
            context.addIssue({
              code: "custom",
              message: `Duplicate stable id: ${child}`,
              path: childPath,
            });
          } else {
            idPaths.set(child, childPath);
          }
        }
        visitIds(child, childPath);
      }
    };
    visitIds(document.blocks, ["blocks"]);
    const definedFootnotes = new Set<string>();
    for (const item of document.blocks) {
      if (item.type !== "footnotes") continue;
      for (const footnote of item.data.items) definedFootnotes.add(footnote.id);
    }
    const visitFootnoteReferences = (
      value: unknown,
      path: Array<string | number>,
    ) => {
      if (Array.isArray(value)) {
        value.forEach((item, index) =>
          visitFootnoteReferences(item, [...path, index]),
        );
        return;
      }
      if (!value || typeof value !== "object") return;
      const record = value as Record<string, unknown>;
      if (
        record.type === "footnoteRef" &&
        typeof record.footnoteId === "string" &&
        !definedFootnotes.has(record.footnoteId)
      ) {
        context.addIssue({
          code: "custom",
          message: `Footnote reference has no matching definition: ${record.footnoteId}`,
          path: [...path, "footnoteId"],
        });
      }
      for (const [key, child] of Object.entries(record)) {
        visitFootnoteReferences(child, [...path, key]);
      }
    };
    visitFootnoteReferences(document.blocks, ["blocks"]);
    if (
      Buffer.byteLength(JSON.stringify(document), "utf8") >
      CONTENT_DOCUMENT_MAX_BYTES
    ) {
      context.addIssue({
        code: "too_big",
        origin: "array",
        maximum: CONTENT_DOCUMENT_MAX_BYTES,
        inclusive: true,
        message: `Document exceeds ${CONTENT_DOCUMENT_MAX_BYTES} bytes`,
        path: ["blocks"],
      });
    }
  });

export type ContentRichText = z.infer<typeof contentRichTextSchema>;
export type ContentImagePlacement = z.infer<typeof contentImagePlacementSchema>;
export type ContentSeo = z.infer<typeof contentSeoSchema>;
export type ContentAuthor = z.infer<typeof contentAuthorSchema>;
export type ContentCategory = z.infer<typeof contentCategorySchema>;
export type ContentTag = z.infer<typeof contentTagSchema>;
export type ContentBlock = z.infer<typeof contentBlockSchema>;
export type ContentDocument = z.infer<typeof contentDocumentSchema>;
