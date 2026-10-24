import { chromium } from 'playwright';
import http from 'http'; import fs from 'fs'; import path from 'path';
const base = process.argv[2];
let server;
let url = base;
if (!base) {
  const types = {'.html':'text/html','.js':'text/javascript','.json':'application/json','.png':'image/png'};
  server = http.createServer((q,r)=>{let p=q.url.split('?')[0]; if(p==='/')p='/index.html'; const f=path.join('dist',p); if(!fs.existsSync(f)){r.writeHead(404);return r.end();} r.writeHead(200,{'content-type':types[path.extname(f)]||'application/octet-stream'}); r.end(fs.readFileSync(f));}).listen(8765);
  url='http://localhost:8765/';
}
const browser = await chromium.launch({ args: ['--autoplay-policy=user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));
await page.addInitScript(() => {
  const orig = AudioNode.prototype.connect;
  window.__peak = 0; window.__oscStarts = 0; window.__ctxs = [];
  AudioNode.prototype.connect = function (target, ...rest) {
    const r = orig.call(this, target, ...rest);
    if (target instanceof AudioDestinationNode && this instanceof GainNode && !this.__tapped) {
      this.__tapped = true;
      const an = this.context.createAnalyser(); an.fftSize = 2048;
      orig.call(this, an);
      const buf = new Float32Array(an.fftSize);
      setInterval(() => { an.getFloatTimeDomainData(buf); for (const v of buf) window.__peak = Math.max(window.__peak, Math.abs(v)); }, 20);
      window.__ctxs.push(this.context);
    }
    return r;
  };
  const os = OscillatorNode.prototype.start;
  OscillatorNode.prototype.start = function (...a) { window.__oscStarts++; return os.apply(this, a); };
});
await page.goto(url, { waitUntil: 'load' });
await page.waitForSelector('text=Begin');
await page.tap('text=Begin');
await page.waitForTimeout(1500);
const st = await page.evaluate(() => ({ state: window.__ctxs[0]?.state, peak: window.__peak, osc: window.__oscStarts, audioAttr: document.querySelector('[data-audio]')?.getAttribute('data-audio'), keys: document.querySelectorAll('[data-midi]').length, labels: document.querySelectorAll('[data-code]').length }));
console.log('after Begin:', JSON.stringify(st));
// answer a round by tapping first enabled interval button
await page.evaluate(()=>{window.__peak=0;});
const btn = page.locator('button[aria-label="reine prime"]');
await btn.tap();
await page.waitForTimeout(2600);
const st2 = await page.evaluate(() => ({ peak: window.__peak, osc: window.__oscStarts, status: document.querySelector('[role=status]')?.textContent }));
console.log('after answer + next round:', JSON.stringify(st2));
const sw = await page.evaluate(async () => { const r = await navigator.serviceWorker?.getRegistration(); return !!r; });
console.log('sw registered:', sw);
await page.screenshot({ path: 'shot.png' });
console.log('errors:', JSON.stringify(errors));
await browser.close(); server?.close();
