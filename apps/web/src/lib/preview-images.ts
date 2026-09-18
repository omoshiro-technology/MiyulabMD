import { useEffect, useMemo, useState } from "react";
import {
  attachedImage,
  collectAttachedImages,
} from "./attached-image-target.ts";
import { acquireAttachedImageNetworkOnly } from "./network-attached-images.ts";
import type { ViewerContext } from "./viewer-context.ts";

export type ImageViewContext = {
  viewer: ViewerContext;
  source: "network" | "cache";
};

type Images = {
  owner: string;
  status: "ready" | "unavailable";
  urls: Map<string, string | null>;
};
export type PreviewImages = {
  enabled: boolean;
  status: "loading" | "ready" | "unavailable";
  urls: Map<string, string | null>;
};
type AcquisitionMode =
  | "cache"
  | "cache-backed-network"
  | "network-only"
  | "disabled";

function acquisitionMode(context?: ImageViewContext): AcquisitionMode {
  if (!context) {
    return "disabled";
  }
  const { viewer } = context;
  if (context.source === "cache") {
    return viewer.cacheViewerId ? "cache" : "disabled";
  }
  if (viewer.mode === "guest") {
    return "network-only";
  }
  if (viewer.mode !== "authenticated" || !viewer.user?.id) {
    return "disabled";
  }
  if (viewer.cacheViewerId === null) {
    return "network-only";
  }
  return viewer.cacheViewerId === viewer.user.id
    ? "cache-backed-network"
    : "disabled";
}

function ownImageUrl(
  bytes: Blob | null,
  ownedUrls: Set<string>,
): string | null {
  if (!bytes) {
    return null;
  }
  const url = URL.createObjectURL(bytes);
  ownedUrls.add(url);
  return url;
}

function expectedViewerIdForMode(
  mode: AcquisitionMode,
  context?: ImageViewContext,
): string | null | undefined {
  if (mode !== "network-only") {
    return undefined;
  }
  if (context?.viewer.mode === "guest") {
    return null;
  }
  return context?.viewer.user?.id ?? null;
}

/** Blob URLs belong to the preview, never to the acquisition/cache or Markdown. */
export function usePreviewImages(
  markdown: string,
  context?: ImageViewContext,
): PreviewImages {
  const mode = acquisitionMode(context);
  const cacheOnly = mode === "cache";
  const userId = context?.viewer.cacheViewerId ?? null;
  const expectedViewerId = expectedViewerIdForMode(mode, context);
  const enabled = mode !== "disabled";
  const owner = JSON.stringify([
    mode,
    enabled,
    userId,
    expectedViewerId,
    cacheOnly,
    markdown,
  ]);
  const [images, setImages] = useState<Images | null>(null);
  useEffect(() => {
    if (!enabled || (cacheOnly && !userId)) {
      return;
    }
    const acquisitionController = new AbortController();
    let active = true;
    let realmInvalidated = false;
    const ownedUrls = new Set<string>();
    const urls = new Map<string, string | null>();
    const targets = collectAttachedImages(markdown);
    const blocked = new Set<string>();
    const publish = (status: Images["status"]) => {
      if (active) {
        setImages({ owner, status, urls: new Map(urls) });
      }
    };
    const forgetImage = (imageUrl: string) => {
      blocked.add(imageUrl);
      const blobUrl = urls.get(imageUrl);
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
        ownedUrls.delete(blobUrl);
      }
      urls.set(imageUrl, null);
      publish("ready");
    };
    const revokeOwnedUrls = () => {
      for (const url of ownedUrls) {
        URL.revokeObjectURL(url);
      }
      ownedUrls.clear();
    };
    let unsubscribeImage: (() => void) | undefined;
    let unsubscribeNote: (() => void) | undefined;
    let unsubscribeRealm: (() => void) | undefined;
    const usesCache = mode !== "network-only";
    const initialize = async () => {
      if (usesCache) {
        const cache = await import("./offline-cache.ts");
        const attached = await import("./attached-images.ts");
        if (acquisitionController.signal.aborted) {
          return;
        }
        unsubscribeImage = cache.subscribeOfflineCacheImageInvalidation(
          (event) => {
            if (
              event.userId !== userId ||
              acquisitionController.signal.aborted ||
              realmInvalidated ||
              !event.resource ||
              !targets.some(
                (image) =>
                  image.noteId === event.resource.noteId &&
                  image.imageId === event.resource.imageId,
              )
            ) {
              return;
            }
            const imageUrl = targets.find(
              (image) =>
                image.noteId === event.resource?.noteId &&
                image.imageId === event.resource?.imageId,
            )?.url;
            if (imageUrl) {
              forgetImage(imageUrl);
            }
          },
        );
        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: denial notifications must independently invalidate each matching image.
        unsubscribeNote = cache.subscribeOfflineCacheNoteDenial((event) => {
          if (
            event.userId !== userId ||
            acquisitionController.signal.aborted ||
            realmInvalidated
          ) {
            return;
          }
          for (const image of targets) {
            if (!event.resource.aliases.includes(image.noteId)) {
              continue;
            }
            void cache
              .readOfflineNoteDenial(event, [image.noteId])
              .then((denied) => {
                if (!acquisitionController.signal.aborted && denied !== false) {
                  forgetImage(image.url);
                }
              })
              .catch(() => {
                // A target notification must not fail the independent note body.
              });
          }
        });
        unsubscribeRealm = cache.subscribeOfflineCacheInvalidation(
          (invalidatedUser) => {
            if (invalidatedUser !== userId || !active || realmInvalidated) {
              return;
            }
            realmInvalidated = true;
            acquisitionController.abort();
            revokeOwnedUrls();
            urls.clear();
            for (const image of targets) {
              urls.set(image.url, null);
            }
            publish("ready");
          },
        );
        await Promise.all(
          targets.map(async (image) => {
            let bytes: Blob | null = null;
            try {
              bytes = await attached.acquireAttachedImage(image, {
                cacheOnly,
                signal: acquisitionController.signal,
                userId: userId as string,
              });
            } catch {
              // A failed attachment must not replace or fail the note body.
            }
            if (
              acquisitionController.signal.aborted ||
              blocked.has(image.url)
            ) {
              return;
            }
            const url = ownImageUrl(bytes, ownedUrls);
            urls.set(image.url, url);
            publish("ready");
          }),
        );
      } else {
        await Promise.all(
          targets.map(async (image) => {
            let bytes: Blob | null = null;
            try {
              bytes = await acquireAttachedImageNetworkOnly(image, {
                expectedViewerId: expectedViewerId as string | null,
                signal: acquisitionController.signal,
              });
            } catch {
              // A failed attachment must not replace or fail the note body.
            }
            if (
              acquisitionController.signal.aborted ||
              blocked.has(image.url)
            ) {
              return;
            }
            const url = ownImageUrl(bytes, ownedUrls);
            urls.set(image.url, url);
            publish("ready");
          }),
        );
      }
      if (acquisitionController.signal.aborted) {
        return;
      }
      for (const image of targets) {
        if (!urls.has(image.url)) {
          urls.set(image.url, null);
        }
      }
      publish("ready");
    };
    void initialize().catch(() => {
      if (acquisitionController.signal.aborted) {
        return;
      }
      urls.clear();
      publish("unavailable");
    });
    return () => {
      active = false;
      unsubscribeImage?.();
      unsubscribeNote?.();
      unsubscribeRealm?.();
      acquisitionController.abort();
      revokeOwnedUrls();
    };
  }, [cacheOnly, enabled, markdown, owner, userId, expectedViewerId, mode]);
  return useMemo<PreviewImages>(
    () => ({
      enabled,
      status: images?.owner === owner ? images.status : "loading",
      urls:
        images?.owner === owner
          ? images.urls
          : new Map<string, string | null>(),
    }),
    [enabled, images, owner],
  );
}

/** Input is already sanitized HTML. Only owned blob URLs are inserted afterwards.
 * A detached template prevents duplicate browser downloads of pending API images.
 * Without a view resolver, preserve the renderer's exact output.
 */
export function resolvePreviewImages(
  html: string,
  images: {
    enabled: boolean;
    status?: "loading" | "ready" | "unavailable";
    urls: Map<string, string | null>;
  },
): string {
  if (typeof document === "undefined") {
    return sanitizePreviewImagesWithoutDocument(html);
  }
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const node of template.content.querySelectorAll("img")) {
    const image = attachedImage(node.getAttribute("src") ?? "");
    if (!image) {
      continue;
    }
    const url = images.enabled ? images.urls.get(image.url) : null;
    if (url) {
      node.src = url;
    } else {
      node.removeAttribute("src");
      const message = document.createElement("span");
      message.setAttribute("role", "status");
      message.textContent =
        !images.enabled ||
        images.status === "unavailable" ||
        (images.urls.has(image.url) && url === null)
          ? "画像を表示できません（未保存または閲覧不可）。"
          : "画像を読み込み中…";
      node.after(message);
    }
  }
  return template.innerHTML;
}

/**
 * SSR fallback for the resolver. It deliberately only interprets quoted src
 * attributes: an ambiguous managed-looking candidate is stripped, while
 * ordinary external images and all non-image markup are retained.
 */
export function sanitizePreviewImagesWithoutDocument(html: string): string {
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    const source = /\bsrc\s*=\s*(["'])(.*?)\1/i.exec(tag);
    if (!source) {
      return /(?:^|\s)src\s*=\s*(?:\/|%2f|%252f)/i.test(tag)
        ? tag.replace(/\s+src\s*=\s*(?:[^\s>]+)/i, "")
        : tag;
    }
    const candidate = attachedImage(source[2] ?? "");
    if (!(candidate || looksLikeManagedImage(source[2] ?? ""))) {
      return tag;
    }
    return tag.replace(source[0], "");
  });
}

function looksLikeManagedImage(source: string): boolean {
  return (
    /^\/?(?:%2f|%252f)*api\/notes\//i.test(source) ||
    /(?:^|%2f)api(?:%2f|\/)notes(?:%2f|\/)/i.test(source)
  );
}
