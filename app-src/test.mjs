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
await page.evaluate(()=>{window.__peak=0;});
const wrongCode = await page.evaluate(() => {
  const lit = new Set();
  for (const btn of document.querySelectorAll('[data-lit="1"]')) {
    const code = btn.querySelector('[data-code]')?.getAttribute('data-code');
    if (code) lit.add(code);
  }
  const order = ['k2', 'g2', 'k3', 'g3', '4', 'tt', '5', 'k6', 'g6', 'k7', 'g7', '8', 'P1'];
  const code = order.find((item) => !lit.has(item));
  if (!code) throw new Error('geen fout antwoord gevonden, lit=' + [...lit].join(','));
  return code;
});
const names = {
  P1: 'reine prime',
  k2: 'kleine secunde',
  g2: 'grote secunde',
  k3: 'kleine terts',
  g3: 'grote terts',
  '4': 'reine kwart',
  tt: 'tritonus (overmatige kwart / verminderde kwint)',
  '5': 'reine kwint',
  k6: 'kleine sext',
  g6: 'grote sext',
  k7: 'kleine septiem',
  g7: 'grote septiem',
  '8': 'reine octaaf',
};
await page.getByRole('button', { name: names[wrongCode], exact: true }).tap();
await page.waitForTimeout(1200);
const review = await page.evaluate(() => ({
  status: document.querySelector('[role=status]')?.textContent || '',
  correct: document.querySelectorAll('[data-correct="1"]').length,
  yours: document.querySelectorAll('[data-yours="1"]').length,
  next: !!document.querySelector('button[aria-label="Volgende"]'),
  again: !!document.querySelector('button[aria-label="Nog eens horen"]'),
  mine: !!document.querySelector('button[aria-label="Jouw antwoord"]'),
}));
console.log('after wrong answer:', JSON.stringify(review));
if (!review.status.startsWith('Het was:')) throw new Error('status mist het juiste interval: ' + review.status);
if (!review.next || !review.again || !review.mine) throw new Error('review-knoppen ontbreken');
if (review.correct < 1) throw new Error('juiste toetsen niet opgelicht');
await page.getByRole('button', { name: 'Nog eens horen' }).tap();
await page.waitForTimeout(400);
const again = await page.evaluate(() => document.querySelectorAll('[data-correct="1"]').length);
if (again < 1) throw new Error('Nog eens horen liet de juiste toetsen niet zien');
await page.getByRole('button', { name: 'Jouw antwoord' }).tap();
await page.waitForTimeout(300);
const yours = await page.evaluate(() => ({
  yours: document.querySelectorAll('[data-yours="1"]').length,
  correct: document.querySelectorAll('[data-correct="1"]').length,
  status: document.querySelector('[role=status]')?.textContent || '',
}));
console.log('after jouw antwoord:', JSON.stringify(yours));
if (yours.yours < 1) throw new Error('jouw antwoord liet geen toetsen zien');
if (yours.correct !== 0) throw new Error('juiste toetsen bleven branden bij jouw antwoord');
if (!yours.status.startsWith('Het was:')) throw new Error('rond ging te vroeg verder');
await page.getByRole('button', { name: 'Volgende' }).tap();
await page.waitForTimeout(1600);
const st2 = await page.evaluate(() => ({ peak: window.__peak, osc: window.__oscStarts, status: document.querySelector('[role=status]')?.textContent, review: !!document.querySelector('button[aria-label="Volgende"]') }));
console.log('after volgende:', JSON.stringify(st2));
if (st2.review) throw new Error('Volgende liet de review staan');
if (st2.status && st2.status.startsWith('Het was:')) throw new Error('status bleef op het foute antwoord');
const sw = await page.evaluate(async () => { const r = await navigator.serviceWorker?.getRegistration(); return !!r; });
console.log('sw registered:', sw);
await page.screenshot({ path: 'shot.png' });
console.log('errors:', JSON.stringify(errors));
if (errors.length) throw new Error(errors.join('\n'));
await browser.close(); server?.close();
