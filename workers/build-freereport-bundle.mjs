// Makes ONE file for the Cloudflare dashboard editor (which takes a single script):
//   node workers/build-freereport-bundle.mjs  ->  workers/dist/bookedout-freereport.bundle.js
// It inlines freereport-followups-seq.js and freereport-followups.js into bookedout-freereport.js. No other changes.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const dir = new URL('.', import.meta.url);
const read = (f) => readFileSync(new URL(f, dir), 'utf8');
const seq = read('freereport-followups-seq.js').replace(/^export default /m, 'const SEQ = ');
const fu = read('freereport-followups.js').replace(/^import SEQ from .*$/m, '').replace(/^export (const|function|async function) /gm, '$1 ');
const names = [...read('freereport-followups.js').matchAll(/^export (?:const|function|async function) (\w+)/gm)].map((m) => m[1]);
const main = read('bookedout-freereport.js');
const imp = /^import \* as FU from '\.\/freereport-followups\.js';$/m;
if (!imp.test(main)) throw new Error('import line not found');
const out = main.replace(imp, `// ---- inlined by build-freereport-bundle.mjs ----\nconst FU = (() => {\n${seq}\n${fu}\nreturn { ${names.join(', ')} };\n})();\n// ---- end inlined ----`);
mkdirSync(new URL('dist/', dir), { recursive: true });
writeFileSync(new URL('dist/bookedout-freereport.bundle.js', dir), out);
console.log('wrote workers/dist/bookedout-freereport.bundle.js', out.length, 'bytes; exports:', names.join(','));
