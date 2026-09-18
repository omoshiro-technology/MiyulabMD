/** Register the production shell without making registration a boot dependency. */
export async function registerServiceWorker(): Promise<void> {
  if (!("serviceWorker" in navigator)) {
    return;
  }

  try {
    await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  } catch (error) {
    console.warn("MiyulabMD offline shell registration failed", error);
  }
}
