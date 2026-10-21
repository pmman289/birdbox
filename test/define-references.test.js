import test from 'node:test';
import assert from 'node:assert/strict';
import { defineReferences } from '../packages/contracts/src/define-references.ts';
import { splitBirdPrefixEntries } from '../packages/contracts/src/prefix-entries.ts';
import { parseBirdPrefixEntries } from '../src/bird-prefix.js';
const base = () => ({ defines: [], functions: [], filters: [], sessions: [], staticProtocols: [], sourcePolicies: [], pipeProtocols: [], kernelProtocols: [], ospfDomains: [] });
const define = { id: 'd', name: 'PREFIXES', label: 'Prefixes', type: 'cidr4', nodeIds: null };
test('Quoted BIRD symbols remain dependencies while double-quoted strings and comments do not', () => {
 const i = base(); i.defines.push(define);
 i.functions.push({ id: 'quoted', name: 'quoted_match', label: 'Quoted match', nodeIds: null, source: "function quoted_match() { return net ~ 'PREFIXES'; }" });
 i.filters.push({ id: 'consumer', name: 'quoted_filter', nodeIds: null, source: "filter quoted_filter { if 'quoted_match'() then accept; reject; }" });
 i.functions.push({ id: 'noise', name: 'noise', nodeIds: null, source: 'function noise() { print "\'PREFIXES\'"; # \'PREFIXES\'\n return true; }' });
 assert.deepEqual(defineReferences(i, define).map(r => r.id), ['quoted', 'consumer']);
 assert.deepEqual(defineReferences(i, define)[1].via, ['Quoted match']);
});
test('Prefix import preserves ranges and malformed text instead of silently changing its meaning', () => {
 const text = '[ 192.0.2.0/24{24, 28},\n198.51.100.0/24+; 203.0.113.0/24 ]';
 assert.deepEqual(splitBirdPrefixEntries(text), ['192.0.2.0/24{24, 28}', '198.51.100.0/24+', '203.0.113.0/24']);
 assert.deepEqual(parseBirdPrefixEntries(text, 4), ['192.0.2.0/24{24,28}', '198.51.100.0/24+', '203.0.113.0/24']);
 for (const bad of ['192.0.2.0/24{24,28}}', '192.0.2.0/24{24', '192.0.2.0/24}', '[192.0.2.0/24']) {
  assert.equal(splitBirdPrefixEntries(bad).join('\n'), bad);
  assert.throws(() => parseBirdPrefixEntries(bad, 4), /无效/);
 }
});
test('Define reference graph includes OSPF, source policies and indirect policy consumers, deduplicating resources', () => {
 const i = base(); i.defines.push(define);
 i.functions.push({ id: 'fn', name: 'match_prefixes', label: 'Match', nodeIds: null, source: 'function match_prefixes() { return net ~ PREFIXES; }' });
 i.filters.push({ id: 'fl', name: 'allow_prefixes', label: 'Allow', nodeIds: null, source: 'filter allow_prefixes { if match_prefixes() then accept; }' });
 const policy = { mode: 'custom', filterId: 'fl' };
 i.pipeProtocols.push({ id: 'p', name: 'Pipe', nodeIds: null, importPolicy: policy, exportPolicy: policy });
 i.sessions.push({ id: 'bgp', nodeId: 'one', protocolName: 'BGP', channels: { ipv4: { exportDefineId: 'd', importPolicy: policy, exportPolicy: policy } } });
 i.staticProtocols.push({ id: 's', name: 'Static', nodeId: 'one', defineId: 'd', raw: '', routes: [], routeFilters: {}, importPolicy: policy });
 i.sourcePolicies.push({ id: 'src', label: 'Source', nodeIds: null, internalDefineIds: ['d'] });
 i.ospfDomains.push({ id: 'ospf', name: 'OSPF', nodeConfigs: [{ nodeId: 'one', exportDefineIds: { ospfv2: 'd' }, importPolicies: { ospfv2: {} }, exportPolicies: { ospfv2: { mode: 'form', formAction: 'cidr' }, ospfv3: {} } }] });
 assert.deepEqual(defineReferences(i, define).map(r => r.kind), ['functions', 'filters', 'sessions', 'statics', 'sourcePolicies', 'pipes', 'ospf']);
 assert.deepEqual(defineReferences(i, define).find(r => r.kind === 'pipes').via, ['Match', 'Allow']);
});
test('Define reference scan ignores comments, strings, unrelated symbols and terminates on cycles', () => {
 const i = base(); i.defines.push(define);
 i.functions.push({ id: 'noise', name: 'noise', source: 'function noise() { # PREFIXES\n print "PREFIXES"; /* PREFIXES */ return PREFIXES_OTHER; }' });
 assert.deepEqual(defineReferences(i, define), []);
 i.defines.push({ id: 'a', name: 'A', type: 'expression', value: 'PREFIXES + B' }, { id: 'b', name: 'B', type: 'expression', value: 'A' });
 assert.equal(defineReferences(i, define).length, 2);
});
test('Define reference paths respect node scope even when different nodes reuse the same BIRD name', () => {
 const i = base(); i.defines.push(define);
 for (const nodeId of ['one', 'two']) {
  i.functions.push({ id: `fn_${nodeId}`, name: 'shared_name', label: nodeId, nodeIds: [nodeId], source: 'function shared_name() { return net ~ PREFIXES; }' });
  i.filters.push({ id: `fl_${nodeId}`, name: `filter_${nodeId}`, nodeIds: [nodeId], source: `filter filter_${nodeId} { if shared_name() then accept; }` });
 }
 assert.equal(defineReferences(i, define).filter(r => r.kind === 'filters').length, 2);
 const local = { ...define, nodeIds: ['one'] }; i.defines = [local];
 assert.deepEqual(defineReferences(i, local).map(r => r.id), ['fn_one', 'fl_one']);
});
