import { defineConfig } from "vite";
import { resolve } from "node:path";
import packageJson from "./package.json" with { type: "json" };

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        popup: resolve(import.meta.dirname, "index.html"),
        background: resolve(import.meta.dirname, "src/background.ts"),
      },
      output: {
        entryFileNames: (chunk) => chunk.name === "background"
          ? "background.js"
          : "assets/[name]-[hash].js",
      },
    },
  },
  define: {
    __HEADERLAB_VERSION__: JSON.stringify(packageJson.version),
  },
  plugins: [
    {
      name: "headerlab-manifest",
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "manifest.json",
          source: JSON.stringify(
            {
              manifest_version: 3,
              name: "HeaderLab",
              version: packageJson.version,
              description: "Manage browser request rules.",
              permissions: ["storage", "declarativeNetRequestWithHostAccess", "scripting", "webNavigation", "cookies", "activeTab"],
              optional_host_permissions: ["http://*/*", "https://*/*"],
              incognito: "spanning",
              background: { service_worker: "background.js", type: "module" },
              action: { default_popup: "index.html" },
            },
            null,
            2,
          ),
        });
      },
    },
  ],
});
