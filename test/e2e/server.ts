import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "birdbox-e2e-"));
const dataDir = path.join(root, "data");
const nodesFile = path.join(root, "nodes.json");

await fs.mkdir(dataDir, { recursive: true });
await fs.writeFile(nodesFile, JSON.stringify([{
  id: "local",
  name: "E2E Router",
  transport: "local",
  routerId: "192.0.2.1",
  listenPort: 179,
}]));
await fs.writeFile(path.join(dataDir, "session.json"), JSON.stringify({
  name: "e2e_peer",
  local: {
    nodeId: "local",
    address: "192.0.2.1",
    asn: 64512,
    advertisePrefix: "198.51.100.0/24",
  },
  remote: {
    name: "Documentation Peer",
    address: "192.0.2.2",
    asn: 64513,
    port: 179,
  },
  multihop: false,
}));

process.env.NODE_ENV = "test";
process.env.BIRDBOX_DATABASE_URL = "memory:";
process.env.BIRDBOX_DATA_DIR = dataDir;
process.env.BIRDBOX_NODES_FILE = nodesFile;
process.env.BIRDBOX_PORT = "31000";
process.env.BIRDBOX_HOST = "0.0.0.0";
process.env.BIRDBOX_SECURE_COOKIE = "false";

await import("../../src/server.js");
