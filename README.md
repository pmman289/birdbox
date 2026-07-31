# Birdbox Demo

Birdbox is a dependency-free BIRD 2 GUI demo for managed-node inventory,
external Peer definitions, and eBGP session deployment. A session references a
managed node, one of the external Peers defined for that node, and optionally a
reusable CIDR-type Define.

Managed nodes are reached only through SSH. Birdbox creates a persistent
controller key and uses a dedicated, non-privileged account on each node;
there is no node Agent and Birdbox never needs remote root login. External
Peers never contain management credentials and cannot execute commands.
The local BGP address, port, and ASN belong to each session, so one managed node
can use different local endpoints or ASNs for different Peers.

Defines are ordered BIRD declarations with a display name, BIRD symbol, type,
and scope. A Define may be available to every managed node or restricted to one
node. CIDR-type Defines are rendered as prefix sets:

```bird
define MY_EXPORTS = [ 10.0.0.0/8+, 192.0.2.0/24 ];
```

The CIDR editor has separate IPv4 and IPv6 types and accepts BIRD prefix-set
forms such as `10.0.0.0/8+`, `198.51.100.0/24{24,28}`, and
`2001:db8::/32{48,64}`. These Defines are
reusable resources; BGP export filtering references a selected symbol with
`net ~ MY_EXPORTS`. Export form actions can export all routes, export none, or
export only a selected CIDR Define. Static origination is configured separately
for each session channel, so it remains active with form, combined, or custom
export policy. Exact prefixes from a selected CIDR Define may use `blackhole`,
`reject`, `unreachable`, or `prohibit`. Each channel also accepts bounded custom
Static Protocol statements such as `route ... via ...;`; range expressions
remain filter patterns and do not generate routes. Leaving both the action and
custom source empty creates no static routes. Valid form changes are
automatically previewed after a field loses focus.

RPKI resources are managed in their own tab. A source can load BIRD ROA route
files through a Static Protocol, or connect to an RPKI-RTR cache server over
TCP/TCP-MD5 or SSH. IPv4 and IPv6 ROA Tables are independently selectable and
can be shared by multiple sources, so Filters may use `roa_check(TABLE, net,
bgp_path.last)` without hand-editing the generated global declarations. RPKI
server refresh, retry, expire, RTR version, and max-length settings are
validated against BIRD 2.19.1 ranges. SSH transport additionally requires the
target BIRD binary to be built with libssh support; native `bird -p` remains the
final capability check.

Functions and Filters are reusable BIRD policy resources. Each resource may be
global or restricted to one managed node and is parsed by the target node's
native `bird -p` before it is saved. Function declaration order is adjusted
directly in the Functions resource list. A
Function resource contains one complete top-level `function` declaration; a
Filter resource contains one complete named `filter` declaration. Functions
with parameters may be used by other policy source, while parameterless
Functions are also available as session policy steps. The source editor includes
line numbers, cursor position, Tab/Shift+Tab indentation, and inherited line
indentation. It also lists compatible, enabled Defines available before the
edited resource and inserts their symbols at the cursor. Expression-type Defines
store any safe BIRD expression and are emitted as `define NAME = VALUE;`.
CIDR-type and expression-type Defines share one ordered resource list. Policy
resources are validated in the complete node configuration; cross-scope or
disabled Define references are rejected before native parsing. Rename, type,
scope, disable, and delete operations are protected while a session or policy
resource depends on the affected Define.

Import and export policy are selected independently for every BGP session:

- **Form** explicitly emits `import all` by default (or `import none` when
  selected). Export independently supports `all`, `none`, or a selected CIDR
  Define.
- **Combined** contains an ordered list of parameterless Function steps plus one
  movable form-policy step. Function steps are optional; when present, each can
  accept on a true result, reject on a true result, or execute without making a
  route decision. Import uses its
  movable `all`/`none` form decision without an extra fallback. Export always
  appends the generated fallback `reject;` after every movable step. Available
  Functions are added explicitly from the picker.
- **Custom** references one complete named Filter directly. Static resources
  remain independent and are still generated with custom export policy.

Session options follow the BIRD 2.19.1 protocol model. IPv4 and IPv6 channels
are enabled by default and can be controlled independently, including their
policies, CIDR Defines, static routes, limits, and advanced channel options. Common
controls include direct/multihop mode and TTL, passive mode, BFD, GTSM, hold and
keepalive timers, and import/export route limits. The collapsed advanced area
covers capability requirements, graceful restart bounds, Send Hold Timer,
TCP MD5/TCP-AO authentication, Onlink sessions, eBGP attribute handling,
route selection, IPv6 link-local next-hop formatting, next-hop and gateway
behavior, Adj-RIB-In/Out, Add Paths, AIGP, and channel-specific limits.
Additional protocol-block and per-channel
directives can be entered as bounded BIRD snippets; they cannot close the
managed outer block and are checked in the complete configuration by native
`bird -p` before save or deployment. Selecting BFD emits one shared
`protocol bfd birdbox_bfd` instance for the node.

Each session also has a session-level enable switch. A disabled session remains
in inventory for later editing but is omitted from the generated BGP and Static
configuration; the node deployment dialog applies only enabled sessions.

The generated declaration order is the user-ordered Defines list, ROA Tables and
RPKI sources, Functions, Filters, static routes, and BGP protocols. Editing a
node, Peer, Define, Function, Filter, or RPKI resource first validates the
complete inventory and each affected node with native `bird -p`, then applies
the candidate configuration to all nodes in the old/new scope. The API reports
the affected sessions; a preflight or apply failure leaves inventory unchanged
and rolls back nodes that were already applied.

Birdbox does not replace the system BIRD main configuration. New nodes use:

- controller inventory: `data/inventory.json`
- controller SSH identity: `data/ssh/id_ed25519`
- generated include on each node: `/var/lib/birdbox/generated.conf`
- system BIRD control socket: `/run/bird/bird.ctl`
- default BGP TCP port: `179`

## Requirements

- Node.js 18 or newer on the controller
- BIRD 2.19.1 and `birdc` on every managed node
- an SSH server and an existing non-privileged account on every managed node
- IP reachability between the two configured BGP addresses
- a separately configured external BGP peer

Start the controller:

```bash
npm test
npm start
```

Open <http://127.0.0.1:3000>. In the Nodes tab, start adding a node and generate
its preparation script. Run that script with `sudo` on the target, then add the
displayed line to the system BIRD main configuration:

```bird
include "/var/lib/birdbox/generated.conf";
```

Validate and load that one-time main-config change on the target before using
**Test connection** and **Save node** in Birdbox. The script grants only the
dedicated user access to the generated configuration directory and membership
of the BIRD socket group; it does not edit the main configuration or restart
BIRD. The controller public key is installed with OpenSSH `restrict`, which
disables forwarding and PTY allocation.

Add or edit external Peers, typed Defines, Functions, Filters, and RPKI sources
in their tabs under **Resource Management**. The session workspace keeps
only the selectors and session-specific settings; its question-mark buttons
open the corresponding management section. The topology shows all Peers
belonging to the selected node and their current protocol state.

## API

- `GET /api/dashboard`: inventory, selection, topology, and BGP status
- `POST /api/nodes/setup-script`: generate the non-privileged node preparation script
- `POST /api/nodes/test`: check SSH, include ownership, socket access, BIRD 2, and the complete system configuration
- `POST /api/nodes`, `PUT/DELETE /api/nodes/{id}`: managed-node inventory
- `POST /api/nodes/{id}/peers`, `PUT/DELETE /api/peers/{id}`: external Peer definitions
- `POST /api/functions`, `PUT/DELETE /api/functions/{id}`: BIRD Function resources
- `POST /api/functions/{id}/move`: move a Function declaration up or down
- `POST /api/defines`, `PUT/DELETE /api/defines/{id}`: typed BIRD Define resources (`cidr4`, `cidr6`, or `expression`)
- `POST /api/defines/{id}/move`: move a Define declaration up or down
- `POST /api/filters`, `PUT/DELETE /api/filters/{id}`: BIRD Filter resources
- `POST /api/rpki`, `PUT/DELETE /api/rpki/{id}`: local ROA file and RPKI-RTR source resources
- `POST /api/sessions/preview`: render and validate the selected node
- `POST /api/sessions/apply`: merge and deploy all sessions for the node
- `DELETE /api/sessions/{id}`: remove a session and redeploy the node
- `POST /api/sessions/{id}/control`: enable or disable only the selected BGP protocol (`{"action":"enable"}` or `{"action":"disable"}`); the BIRD daemon and other sessions remain running

This is intentionally a demo. It has no authentication, so bind it to a
trusted management network only. TCP MD5 passwords and TCP-AO key material are
stored in the inventory and rendered into the generated configuration; do not commit or publish either
file without redacting routing credentials and peer details.
