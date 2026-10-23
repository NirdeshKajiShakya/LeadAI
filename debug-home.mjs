import fs from 'fs';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const auth = JSON.parse(fs.readFileSync('C:/Users/user/AppData/Local/Temp/opencode/home-verify.json', 'utf8'));
const targets = await (await fetch('http://localhost:9223/json/list')).json();
console.log('targets:', targets.map(t => ({type:t.type, url:t.url})));
const p = targets.find(t => t.url.includes('5174')) || targets.find(t => t.type === 'page');
if (!p) { console.log('no page'); process.exit(1); }
const ws = new WebSocket(p.webSocketDebuggerUrl);
await new Promise(r => { ws.onopen = r; });
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
const send = (method, params = {}) => new Promise(res => {
  const mid = ++id;
  pending.set(mid, res);
  ws.send(JSON.stringify({id: mid, method, params}));
});
await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: 'http://localhost:5174/' });
await sleep(3000);
const setRes = await send('Runtime.evaluate', { expression: `sessionStorage.setItem('leadai-session', ${JSON.stringify(auth.token)}); 'set'`, returnByValue: true });
console.log('set:', setRes.result?.value);
await send('Page.reload', { ignoreCache: true });
await sleep(5000);
const state = await send('Runtime.evaluate', { expression: `({href:location.href,root:document.getElementById('root')?.innerHTML?.slice(0,100),auth:!!document.querySelector('.auth-screen'),home:!!document.querySelector('.home-page'),body:(document.body.innerText||'').slice(0,200)})`, returnByValue: true });
console.log('state:', JSON.stringify(state.result?.value));
ws.close();
process.exit(0);
