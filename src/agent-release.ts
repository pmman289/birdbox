import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const AGENT_ARCHITECTURES = new Set(["amd64", "arm64", "arm", "armv6", "armv5", "mips", "mipsle", "mips64", "mips64le", "riscv64"]);

const ALIASES: Record<string, string> = {
  x64: "amd64", x86_64: "amd64", amd64: "amd64", aarch64: "arm64", arm64: "arm64",
  armv7l: "arm", armv7: "arm", arm: "arm", armv6l: "armv6", armv6: "armv6", armv5l: "armv5", armv5: "armv5",
  mips: "mips", mipsel: "mipsle", mipsle: "mipsle", mips64: "mips64", mips64el: "mips64le", mips64le: "mips64le", riscv64: "riscv64",
};

export function normalizeAgentArch(value: unknown): string | null {
  const key = String(value ?? "").trim().toLowerCase();
  return ALIASES[key] ?? (AGENT_ARCHITECTURES.has(key) ? key : null);
}

export function agentBinaryFile(base: string, arch: string): string {
  return path.extname(base) ? path.join(path.dirname(base), `birdbox-agent-${arch}`) : path.join(base, `birdbox-agent-${arch}`);
}

const digestCache = new Map<string, { mtimeMs: number; size: number; digest: string }>();
export async function agentBinaryDigest(file: string): Promise<string> {
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error("Agent 二进制不存在");
  const cached = digestCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.digest;
  const digest = createHash("sha256").update(await fs.readFile(file)).digest("hex");
  digestCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, digest });
  return digest;
}

export async function buildAgentUpgradeParams(options: { architecture: unknown; publicUrl: string; binaryBase: string; version: string }): Promise<Record<string, unknown>> {
  const arch = normalizeAgentArch(options.architecture);
  if (!arch) {
    const error = Object.assign(new Error(`Agent 上报的架构 ${String(options.architecture)} 不受支持，拒绝下发升级`), { status: 409, code: "AGENT_ARCH_UNSUPPORTED" });
    throw error;
  }
  const sha256 = await agentBinaryDigest(agentBinaryFile(options.binaryBase, arch));
  return {
    url: `${options.publicUrl.replace(/\/$/, "")}/api/agent/releases/latest/download?arch=${encodeURIComponent(arch)}`,
    sha256,
    targetPath: "/usr/local/bin/birdbox-agent",
    service: "birdbox-agent",
    version: options.version,
  };
}
