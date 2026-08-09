import { fileURLToPath, URL } from "node:url";
import { readFileSync } from "node:fs";

import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

const packageDocument = JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")) as { version?: unknown };
const packageVersion = typeof packageDocument.version === "string" ? packageDocument.version : "dev";

export default defineConfig({
  publicDir: false,
  plugins: [vue()],
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
    __BIRDBOX_VERSION__: JSON.stringify(packageVersion),
  },
  resolve: {
    alias: {
      "@birdbox/contracts": fileURLToPath(new URL("../../packages/contracts/src", import.meta.url)),
    },
  },
  build: {
    outDir: fileURLToPath(new URL("../../public/migrated", import.meta.url)),
    emptyOutDir: true,
    lib: {
      entry: {
        "app-root": fileURLToPath(new URL("./src/app/main.ts", import.meta.url)),
        "theme-init": fileURLToPath(new URL("./src/theme-init.ts", import.meta.url)),
      },
      formats: ["es"],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      external: ["pinyin-pro"],
      output: {
        paths: {
          "pinyin-pro": "/vendor/pinyin-pro.mjs",
        },
      },
    },
  },
});
