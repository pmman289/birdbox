import { createHash } from "node:crypto";

import type { AddressFamily } from "../packages/contracts/src/inventory.js";

export function makeStaticProtocolName(family: AddressFamily, protocolName: string): string {
  const fullName = `birdbox_static${family === "ipv4" ? "4" : "6"}_${protocolName}`;
  if (fullName.length <= 64) return fullName;
  const digest = createHash("sha256").update(fullName).digest("hex").slice(0, 10);
  return `${fullName.slice(0, 64 - digest.length - 1)}_${digest}`;
}

export { birdIdentifierList, birdIdentifiers, birdSourceReferencesSymbol } from "../packages/contracts/src/bird-source-identifiers.js";
