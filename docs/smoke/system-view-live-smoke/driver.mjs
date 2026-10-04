// One-off CDP driver for the TASK-261 System-view live smoke (Node 22 global WebSocket, no deps).
// Usage: node docs/smoke/system-view-live-smoke/driver.mjs <cdpPort> eval '<js expr>'
//        node docs/smoke/system-view-live-smoke/driver.mjs <cdpPort> shot <out.png>   (1920x1200 viewport)
// Must live inside the repo: Electron's CDP endpoint refuses a driver resolving outside it.
import { writeFileSync } from 'node:fs';
const [port, cmd, arg] = process.argv.slice(2);
const targets = await (await fetch(`http://localhost:${port}/json/list`)).json();
const page = targets.find((t) => t.type === 'page' && t.url.startsWith('http://localhost'));
if (!page) { console.error('no renderer page'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
let n = 0;
const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data.toString()); const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } });
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++n; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); setTimeout(() => rej(new Error('timeout ' + method)), 30000); });
if (cmd === 'eval') {
  const r = await send('Runtime.evaluate', { expression: `(async()=>{return (${arg});})()`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) { console.error(JSON.stringify(r.exceptionDetails)); process.exit(2); }
  const v = r.result.value;
  console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
} else if (cmd === 'shot') {
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1200, deviceScaleFactor: 1, mobile: false });
  await new Promise((r) => setTimeout(r, 600));
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(arg, Buffer.from(r.data, 'base64'));
  await send('Emulation.clearDeviceMetricsOverride');
  console.log('saved', arg);
}
ws.close(); process.exit(0);
