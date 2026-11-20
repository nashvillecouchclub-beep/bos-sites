// Live relay test against the deployed phone worker (Rickey's allowed number, no Telnyx call, no minutes used).
const H = process.env.HOOK_TOKEN, B = 'https://bookedout-booker.rickey-38a.workers.dev';
const sid = 'livetest-' + Date.now();
await fetch(`${B}/t/${H}/voice`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'booker-lab/1' }, body: new URLSearchParams({ CallSid: sid, From: '+13098636854' }) });
const ws = new WebSocket(`${B.replace('https', 'wss')}/t/${H}/relay`);
const lines = (process.argv[2] || '').split('|');
let buf = '', t0 = 0, first = 0, resolveTurn;
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.type === 'text') { if (!first) first = Date.now() - t0; buf += m.token; if (m.last) resolveTurn(); } if (m.type === 'end') resolveTurn && resolveTurn(); };
await new Promise((r) => (ws.onopen = r));
ws.send(JSON.stringify({ type: 'setup', callSid: sid, from: '+13098636854', customParameters: { sid, from: '+13098636854' } }));
await new Promise((r) => setTimeout(r, 1500));
for (const l of lines) {
  buf = ''; first = 0; t0 = Date.now();
  const done = new Promise((r) => (resolveTurn = r));
  ws.send(JSON.stringify({ type: 'prompt', voicePrompt: l, last: true }));
  await Promise.race([done, new Promise((r) => setTimeout(r, 15000))]);
  console.log(`C: ${l}\nB (${first} ms first words): ${buf.trim()}\n`);
  await new Promise((r) => setTimeout(r, 2500));
}
ws.close(); process.exit(0);
