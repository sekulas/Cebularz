import { PING_INTERVAL_MS } from './const.js';
import { startNode } from './node.js';

async function main() {
  startNode(4300);
  startNode(4301, 'http://localhost:4300');
  await new Promise(r => setTimeout(r, 1200));
  const peersA = await fetch('http://localhost:4300/peers').then(r => r.json());
  const peersB = await fetch('http://localhost:4301/peers').then(r => r.json());
  console.log('peers[4300]', peersA);
  console.log('peers[4301]', peersB);
  console.log('Waiting to observe ping/pong logs...');
  await new Promise(r => setTimeout(r, PING_INTERVAL_MS + 1000));
  process.exit(0);
}

main();
