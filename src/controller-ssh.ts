import { execFile } from "node:child_process";
import { promises as fs, type Stats } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import type { ManagedNode } from "../packages/contracts/src/inventory.js";
import { configureManagedSsh } from "./bird.js";
import type { InventoryStore } from "./store.js";

interface ControllerSshOptions {
  store: InventoryStore;
  sshDirectory: string;
  identityFile: string;
  knownHostsFile: string;
}

const execFileAsync = promisify(execFile);

async function fileStat(filePath: string): Promise<Stats | null> {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function assertRegularFile(stat: Stats | null, label: string): asserts stat is Stats {
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} 必须是普通文件且不能是符号链接`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`${label} 必须属于 Birdbox 运行用户`);
  }
}

function publicKeyIdentity(value: unknown): string {
  const fields = String(value ?? "").trim().split(/\s+/);
  const algorithm = fields[0];
  const key = fields[1];
  if (algorithm !== "ssh-ed25519" || !key || !/^[A-Za-z0-9+/]+={0,2}$/.test(key)) {
    throw new Error("Birdbox 控制器 SSH 公钥格式不合法");
  }
  return `${algorithm} ${key}`;
}

export class ControllerSshIdentity {
  readonly #options: ControllerSshOptions;
  #publicKey = "";

  constructor(options: ControllerSshOptions) {
    this.#options = options;
  }

  get publicKey(): string {
    if (!this.#publicKey) throw new Error("Birdbox 控制器 SSH 身份尚未初始化");
    return this.#publicKey;
  }

  async initialize(additionalNodes: ManagedNode[] = []): Promise<void> {
    const inventory = await this.#options.store.read();
    const managedNodes = [...new Map(
      [...inventory.nodes, ...additionalNodes]
        .filter((node) => node.transport === "ssh" && node.sshIdentity === "managed")
        .map((node) => [node.id, node]),
    ).values()];
    const identityRequired = managedNodes.length > 0;
    await this.#ensureSecureDirectory(path.dirname(this.#options.identityFile));
    await this.#ensureSecureDirectory(path.dirname(this.#options.knownHostsFile));

    let privateKeyStat = await fileStat(this.#options.identityFile);
    if (!privateKeyStat) {
      if (identityRequired) {
        throw new Error("已有受管节点，但 Birdbox 控制器 SSH 私钥缺失；拒绝静默轮换身份");
      }
      await execFileAsync("ssh-keygen", [
        "-q", "-t", "ed25519", "-N", "", "-C", "birdbox-controller", "-f", this.#options.identityFile,
      ]);
      privateKeyStat = await fs.lstat(this.#options.identityFile);
    }
    assertRegularFile(privateKeyStat, "Birdbox 控制器 SSH 私钥");
    await fs.chmod(this.#options.identityFile, 0o600);

    const derived = publicKeyIdentity(
      (await execFileAsync("ssh-keygen", ["-y", "-f", this.#options.identityFile])).stdout,
    );
    const publicKeyPath = `${this.#options.identityFile}.pub`;
    const publicKeyStat = await fileStat(publicKeyPath);
    if (!publicKeyStat) {
      await fs.writeFile(publicKeyPath, `${derived} birdbox-controller\n`, { mode: 0o644, flag: "wx" });
    } else {
      assertRegularFile(publicKeyStat, "Birdbox 控制器 SSH 公钥");
      if (publicKeyIdentity(await fs.readFile(publicKeyPath, "utf8")) !== derived) {
        throw new Error("Birdbox 控制器 SSH 公私钥不匹配");
      }
    }
    await fs.chmod(publicKeyPath, 0o644);

    const knownHostsStat = await fileStat(this.#options.knownHostsFile);
    if (!knownHostsStat) {
      if (identityRequired) {
        throw new Error("已有受管节点，但 SSH known_hosts 缺失；拒绝丢失主机身份绑定");
      }
      await fs.writeFile(this.#options.knownHostsFile, "", { mode: 0o600, flag: "wx" });
    } else {
      assertRegularFile(knownHostsStat, "SSH known_hosts");
    }
    const knownHosts = await fs.readFile(this.#options.knownHostsFile, "utf8");
    if (identityRequired && !knownHosts.trim()) {
      throw new Error("已有受管节点，但 SSH known_hosts 为空；拒绝重新信任主机身份");
    }
    for (const node of managedNodes) {
      const target = node.sshPort === 22 ? node.sshHost : `[${node.sshHost}]:${node.sshPort}`;
      if (!target) throw new Error(`受管节点 ${node.name} 缺少 SSH 目标`);
      try {
        await execFileAsync("ssh-keygen", ["-F", target, "-f", this.#options.knownHostsFile]);
      } catch {
        throw new Error(`SSH known_hosts 缺少已有受管节点 ${node.name} 的主机身份；拒绝重新信任`);
      }
    }
    await fs.chmod(this.#options.knownHostsFile, 0o600);
    this.#publicKey = `${derived} birdbox-controller`;
    configureManagedSsh({
      identityFile: this.#options.identityFile,
      knownHostsFile: this.#options.knownHostsFile,
    });
  }

  async #ensureSecureDirectory(directory: string): Promise<void> {
    const existing = await fileStat(directory);
    if (!existing) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`${directory} 必须是目录且不能是符号链接`);
    }
    if (!existing || path.resolve(directory) === path.resolve(this.#options.sshDirectory)) {
      if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
        throw new Error(`${directory} 必须属于 Birdbox 运行用户`);
      }
      await fs.chmod(directory, 0o700);
    }
  }
}
