import type { Inventory } from "../packages/contracts/src/inventory.js";
import { assertValidation } from "./bird-normalize-common.js";

/** Explicit mutations put their requested resources in the input first.
 * Migration/normalization must preserve that protocol resource set. */
export function assertExplicitProtocolResources(input: unknown, inventory: Inventory): void {
  assertValidation(input && typeof input === "object" && !Array.isArray(input), "库存数据必须是对象");
  const source = input as Record<string, unknown>;
  for (const key of ["directProtocols", "kernelProtocols", "pipeProtocols"] as const) {
    const expected = source[key] ?? [];
    assertValidation(Array.isArray(expected), `${key}必须是数组`);
    const ids = new Set(expected.map(resource => String(resource?.id ?? "").trim()));
    if (inventory[key].length === expected.length && inventory[key].every(resource => ids.has(resource.id))) continue;
    throw Object.assign(new Error(`库存升级或规范化试图隐式改变 ${key} 资源集合，已阻止写入`), {
      status: 409,
      code: "INVENTORY_PROTOCOL_SET_CHANGED",
    });
  }
}
