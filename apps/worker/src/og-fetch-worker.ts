import { fetchOgTarget, parseOgTargetUrl } from "./og-fetch-shared.ts";

/**
 * Zone に載っていない outbound-only Worker。
 * md.miyulab.dev からの same-zone fetch では解決できない
 * CNAME（Vercel 等）へ、公開 DNS 経由で取りに行く。
 * 対象 URL は request.url ではなく x-og-target（binding が URL を書き換えるため）。
 * 公開 URL は持たない（workers_dev = false）。呼び出しは service binding のみ。
 */
export default {
  async fetch(request: Request): Promise<Response> {
    const target = parseOgTargetUrl(request);
    if (!target) {
      return new Response("invalid url", { status: 400 });
    }
    return await fetchOgTarget(target, fetch, request.signal);
  },
};
