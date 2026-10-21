import test from 'node:test';
import assert from 'node:assert/strict';
import { configDiff } from '../src/config-diff.js';
test('Config diff preserves changed policy order and repeated statements, with bounded output', () => {
 assert.equal(configDiff('same', 'same'), '');
 const diff = configDiff('filter x {\na();\nb();\na();\n}', 'filter x {\nb();\na();\na();\n}');
 assert.match(diff, /- a\(\);/); assert.match(diff, /\+ b\(\);/);
 const deletion = configDiff('a();\na();', 'a();'); assert.match(deletion, /- a\(\);/);
 const large = configDiff('before', Array.from({length:2000},(_,i)=>`after${i}`).join('\n')); assert.ok(large.split('\n').length<=1001); assert.match(large,/完整配置/);
});
