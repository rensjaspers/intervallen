import { render } from 'preact';
import IntervalTrainer from './IntervalTrainer';

render(<IntervalTrainer />, document.getElementById('app')!);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* ignore */ });
  });
}
