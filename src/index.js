// Cloudflare entry. worker.js serves the page and API; Split runs one heavy Qloo step per invocation.
import { WorkerEntrypoint } from 'cloudflare:workers';
import worker from './worker.js';
import { heatChunk, stopInfo } from './qloo.js';

export class Split extends WorkerEntrypoint {
  heat(id, i) { return heatChunk(this.env, id, i); }
  stop(artist, c) { return stopInfo(this.env, artist, c); }
}

export default worker;
