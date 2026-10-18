// Execute the actual browser worker in a Node worker with only transport/fetch adapted.
import { parentPort } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
globalThis.self = globalThis;
globalThis.postMessage = value => parentPort.postMessage(value);
globalThis.fetch = async url => {
  const name = new URL(url).pathname.split('/').at(-1);
  if (!['manifest.json','elevation.tif','geoid-egm2008.json'].includes(name)) throw new Error('Unexpected asset request');
  return new Response(await readFile(new URL(`../../odesa/${name}`,import.meta.url)));
};
await import('../../../src/trajectory-worker.ts');
parentPort.on('message',data=>self.onmessage({data}));
parentPort.postMessage({ready:true});
