import path from "node:path";
import { fileURLToPath } from "node:url";

export function resolveApplicationRoot(moduleUrl: string | URL): string {
  const moduleDir = path.dirname(fileURLToPath(moduleUrl));
  return path.basename(path.dirname(moduleDir)) === "dist"
    ? path.resolve(moduleDir, "../..")
    : path.resolve(moduleDir, "..");
}
