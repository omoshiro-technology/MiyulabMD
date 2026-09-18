import { collectImageUrls } from "@miyulabmd/markdown";

export type AttachedImage = { url: string; noteId: string; imageId: string };

/** Resolve only same-origin app image endpoints without touching local storage. */
export function attachedImage(
  url: string,
  origin = typeof location === "undefined"
    ? "http://localhost"
    : location.origin,
): AttachedImage | null {
  try {
    const parsed = new URL(url, origin);
    if (
      parsed.origin !== origin ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    const match = /^\/api\/notes\/([^/]+)\/images\/([^/]+)$/.exec(
      parsed.pathname,
    );
    if (!match) {
      return null;
    }
    const noteId = decodeURIComponent(match[1] as string);
    const imageId = decodeURIComponent(match[2] as string);
    if (!(noteId && imageId) || /[/\\]/.test(noteId + imageId)) {
      return null;
    }
    return {
      imageId,
      noteId,
      url: `/api/notes/${encodeURIComponent(noteId)}/images/${encodeURIComponent(imageId)}`,
    };
  } catch {
    return null;
  }
}

export function collectAttachedImages(
  markdown: string,
  origin = typeof location === "undefined"
    ? "http://localhost"
    : location.origin,
): AttachedImage[] {
  const images = new Map<string, AttachedImage>();
  for (const url of collectImageUrls(markdown)) {
    const image = attachedImage(url, origin);
    if (image) {
      images.set(image.url, image);
    }
  }
  return [...images.values()];
}
