/** 直接从 API 抓 SSE，看 delta 事件的原始内容。 */
const token = (await import('node:fs')).readFileSync(
  `${process.env.USERPROFILE}\\.opencoxswain\\token`,
  'utf8',
).trim();

const res = await fetch('http://127.0.0.1:47900/api/events', {
  headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
});
console.log('HTTP', res.status);

// 先发一条消息触发
const projects = await (
  await fetch('http://127.0.0.1:47900/api/projects', {
    headers: { Authorization: `Bearer ${token}` },
  })
).json();
const pid = projects.projects[0].id;
console.log('项目:', pid);

await fetch(`http://127.0.0.1:47900/api/projects/${pid}/say`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: '说一句话' }),
});

const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
let deltas = 0;
let firstDeltaAt = 0;
const started = Date.now();

for (let round = 0; round < 400; round += 1) {
  const { done, value } = await reader.read().catch(() => ({ done: true }));
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let i = buf.indexOf('\n\n');
  while (i >= 0) {
    const raw = buf.slice(0, i);
    buf = buf.slice(i + 2);
    i = buf.indexOf('\n\n');
    for (const line of raw.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      try {
        const item = JSON.parse(line.slice(6));
        if (item.event?.type === 'assistant_delta') {
          deltas += 1;
          if (item.seq && !firstDeltaAt) firstDeltaAt = Date.now() - started;
          if (deltas <= 5) {
            console.log(`  seq=${item.seq} projectId=${item.event.projectId} text=${JSON.stringify(item.event.text)}`);
          }
        }
      } catch {
        /* skip */
      }
    }
  }
  if (deltas > 20) break;
}

console.log(`\n收到 ${deltas} 个 delta，第一个在 ${firstDeltaAt}ms`);
console.log('当前项目:', pid);
