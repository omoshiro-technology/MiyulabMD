import path from "node:path";
import { fileURLToPath } from "node:url";
import { preview } from "vite";
import { pwaHttpFixture } from "./pwa-http-fixture.mjs";

const webRoot = fileURLToPath(new URL("../", import.meta.url));
const server = await preview({
  configFile: path.join(webRoot, "vite.config.ts"),
  plugins: [pwaHttpFixture(webRoot)],
  preview: {
    host: "127.0.0.1",
    port: 4175,
    proxy: {},
    strictPort: true,
  },
  root: webRoot,
});
server.printUrls();
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    server.httpServer.close(() => process.exit(0));
  });
}
