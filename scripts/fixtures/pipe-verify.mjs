import assert from "node:assert/strict";
import fs from "node:fs/promises";
const cookie = await fs.readFile("/verification/cookie", "utf8");
const nodeId = "node_installer_e2e";
async function api(path, method = "GET", body, expected = 200) {
  const response = await fetch(`http://127.0.0.1:3000${path}`, { method, headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
  const result = await response.json(); assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(result)}`); return result;
}
const policy = formAction => ({ mode: "form", steps: [], filterId: null, formAction });
if (process.argv[2] === "create") {
  const ids = [];
  const seeds = [];
  for (const family of ["ipv4", "ipv6"]) {
    const n = family === "ipv4" ? "4" : "6", table = `master${n}`, peer = `pipe_peer${n}`;
    const resource = { label: `Pipe lab IPv${n}`, name: `lab_pipe${n}`, nodeIds: [nodeId], family, table: { name: table, source: "existing" }, peerTable: { name: peer, source: "managed" } };
    const before = (await api("/api/dashboard")).inventory;
    const preview = await api("/api/pipes/preview", "POST", resource); assert.equal(preview.valid, true); assert.deepEqual((await api("/api/dashboard")).inventory, before);
    const saved = await api("/api/pipes", "POST", resource, 201); assert.equal(saved.deployment.applied, true); ids.push(saved.resource.id);
    const forward = family === "ipv4" ? "198.18.1.0/24" : "2001:db8:1::/48";
    const blocked = family === "ipv4" ? "198.18.2.0/24" : "2001:db8:2::/48";
    const reverse = family === "ipv4" ? "198.18.3.0/24" : "2001:db8:3::/48";
    seeds.push(`protocol static lab_primary${n} { ${family} { table ${table}; }; route ${forward} blackhole { bgp_local_pref = 177; bgp_community.add((64512,17)); }; route ${blocked} blackhole; }\nprotocol static lab_peer${n} { ${family} { table ${peer}; }; route ${reverse} blackhole; }`);
  }
  await fs.writeFile("/verification/pipe-ids.json", JSON.stringify(ids)); await fs.writeFile("/verification/pipe-seeds.conf", seeds.join("\n"));
  console.log("PASS: read-only candidate preflight and real Agent deployment for both families");
} else {
  const ids = JSON.parse(await fs.readFile("/verification/pipe-ids.json", "utf8"));
  for (const [index, id] of ids.entries()) {
    const family = index === 0 ? "ipv4" : "ipv6", n = index === 0 ? "4" : "6";
    const forward = index === 0 ? "198.18.1.0/24" : "2001:db8:1::/48", blocked = index === 0 ? "198.18.2.0/24" : "2001:db8:2::/48", reverse = index === 0 ? "198.18.3.0/24" : "2001:db8:3::/48";
    const routes = side => api(`/api/pipes/${id}/routes?nodeId=${nodeId}&side=${side}`);
    let primary = await routes("primary"), peer = await routes("peer");
    assert.ok(peer.routes.some(r => r.prefix === forward)); assert.ok(!primary.routes.some(r => r.prefix === reverse));
    const original = peer.routes.find(r => r.prefix === forward); assert.match(original.summary, new RegExp(`lab_primary${n}`)); assert.match(original.details, /BGP.local_pref: 177/); assert.match(original.details, /\(64512,17\)/);
    const state = (await api(`/api/pipes/${id}/runtime`)).nodes[0]; assert.equal(state.state, "up"); assert.equal(state.primary.imported, 0); assert.ok(state.primary.exported >= 2); assert.equal(state.peer.imported, null);
    await api(`/api/pipes/${id}`, "PUT", { importPolicy: policy("all") });
    primary = await routes("primary"); assert.ok(primary.routes.some(r => r.prefix === reverse));
    const filter = await api("/api/filters", "POST", { label: `Pipe lab Filter ${n}`, name: `lab_filter${n}`, nodeIds: [nodeId], source: `filter lab_filter${n} { if net = ${blocked} then reject; accept; }` }, 201);
    const filterId = filter.resource.id;
    await api(`/api/pipes/${id}`, "PUT", { exportPolicy: { mode: "custom", filterId } });
    peer = await routes("peer"); assert.ok(!peer.routes.some(r => r.prefix === blocked)); assert.ok(peer.routes.some(r => r.prefix === forward));
    await api(`/api/filters/${filterId}`, "DELETE", undefined, 409);
    const lookup = await api(`/api/pipes/${id}/routes?nodeId=${nodeId}&side=peer&target=${encodeURIComponent(forward.split('/')[0])}`); assert.equal(lookup.routes[0]?.prefix, forward);
    await api(`/api/pipes/${id}`, "PUT", { enabled: false }); assert.equal((await api(`/api/pipes/${id}/runtime`)).nodes[0].state, "disabled");
    // Seed protocols still reference this table: removal must fail preflight atomically.
    const before = (await api("/api/dashboard")).inventory;
    await api(`/api/pipes/${id}`, "DELETE", undefined, 422); assert.deepEqual((await api("/api/dashboard")).inventory, before);
    assert.ok((await routes("peer")).routes.some(r => r.prefix === reverse));
    await api(`/api/pipes/${id}`, "PUT", { enabled: true });
    console.log(`PASS ${family}: default reverse deny, bidirectional, Filter reject, origin/attributes, real statistics, disabled table retention, last-reference preflight protection`);
  }
}
