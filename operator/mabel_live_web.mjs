#!/usr/bin/env node
/** Secure browser-to-GPT-Live WebSocket relay for the iPad handset. */

import { execFileSync } from 'node:child_process';
import { createServer } from 'node:https';
import { existsSync, readFileSync } from 'node:fs';
import process from 'node:process';
import { WebSocket, WebSocketServer } from 'ws';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  if (process.argv[index].startsWith('--')) args.set(process.argv[index].slice(2), process.argv[index + 1] || '');
}

const port = Number(args.get('port') || 8791);
const host = args.get('host') || '0.0.0.0';
const certPath = args.get('cert');
const keyPath = args.get('key');
const allowedOrigin = args.get('allowed-origin') || '';
const openaiUrl = 'wss://api.openai.com/v1/live/sessions';
function relayLog(message, details = '') {
  process.stdout.write(`[live-web-relay] ${message}${details ? ` ${details}` : ''}\n`);
}
function safeCloseCode(code) {
  const value = Number(code);
  return [1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011].includes(value) ? value : 1000;
}
function safeCloseReason(reason) {
  return String(reason || '').slice(0, 123);
}

if (!certPath || !keyPath || !existsSync(certPath) || !existsSync(keyPath)) {
  throw new Error('Live relay certificate and key are required');
}

const apiKey = execFileSync('/usr/bin/security', [
  'find-generic-password', '-s', 'Shyvers Multiphone / OpenAI', '-a', 'mabel-voice', '-w',
], { encoding: 'utf8' }).trim();
if (!apiKey) throw new Error('OpenAI API key is not configured');

const httpsServer = createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (request, response) => {
  if (request.url === '/health') {
    const body = JSON.stringify({ ok: true, service: 'mabel-live-web-relay', version: '0.1' });
    response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
    response.end(body);
    return;
  }
  response.writeHead(404);
  response.end();
});

const webSocketServer = new WebSocketServer({ noServer: true });
httpsServer.on('upgrade', (request, socket, head) => {
  if (request.url !== '/live') {
    socket.destroy();
    return;
  }
  if (allowedOrigin && request.headers.origin !== allowedOrigin) {
    socket.destroy();
    return;
  }
  webSocketServer.handleUpgrade(request, socket, head, (client) => webSocketServer.emit('connection', client, request));
});

webSocketServer.on('connection', (client) => {
  relayLog('browser connected');
  const queued = [];
  let upstream;
  let closed = false;
  try {
    upstream = new WebSocket(openaiUrl, { headers: { Authorization: `Bearer ${apiKey}` } });
  } catch (error) {
    client.close(1011, error.message.slice(0, 120));
    return;
  }

  const closeBoth = (code = 1000, reason = '') => {
    if (closed) return;
    closed = true;
    if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) client.close(code, reason);
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close(code, reason);
  };

  upstream.on('open', () => {
    relayLog('upstream connected', `queued=${queued.length}`);
    while (queued.length && upstream.readyState === WebSocket.OPEN) upstream.send(queued.shift().toString());
  });
  let firstUpstreamEvent = true;
  let audioDeltaCount = 0;
  upstream.on('message', (data) => {
    if (firstUpstreamEvent) {
      firstUpstreamEvent = false;
      try { relayLog('first upstream event', `type=${JSON.parse(data.toString()).type || 'unknown'}`); }
      catch { relayLog('first upstream event', 'non-json'); }
    }
    // ws exposes upstream messages as Buffers by default. Sending that Buffer
    // to Safari marks the browser frame as binary, so message.data is a Blob
    // and JSON.parse(message.data) fails before Live can process the event.
    // Forward the JSON payload explicitly as a text frame.
    const payload = data.toString();
    try {
      const event = JSON.parse(payload);
      if (/^(?:session|response)\.(?:output_audio|audio)\.delta$/.test(event.type) && typeof event.delta === 'string') {
        audioDeltaCount += 1;
        if (audioDeltaCount <= 3 || audioDeltaCount % 100 === 0) {
          const pcm = Buffer.from(event.delta, 'base64');
          let sum = 0;
          let peak = 0;
          let samples = 0;
          for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
            const sample = pcm.readInt16LE(offset);
            const magnitude = Math.abs(sample);
            peak = Math.max(peak, magnitude);
            sum += sample * sample;
            samples += 1;
          }
          const rms = samples ? Math.sqrt(sum / samples) : 0;
          relayLog('upstream audio level', `delta=${audioDeltaCount} bytes=${pcm.length} peak=${peak} rms=${Math.round(rms)}`);
        }
      }
    } catch {
      relayLog('upstream event parse warning', 'payload was not JSON');
    }
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  });
  upstream.on('error', (error) => {
    relayLog('upstream error', error.message);
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: 'error', error: { message: `Live relay upstream error: ${error.message}` } }));
  });
  upstream.on('close', (code, reason) => {
    relayLog('upstream closed', `code=${code} reason=${reason.toString()}`);
    if (client.readyState === WebSocket.OPEN) client.close(safeCloseCode(code), safeCloseReason(reason));
  });
  client.on('message', (data) => {
    relayLog('browser message', `bytes=${data.length}`);
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data.toString());
    else if (upstream.readyState === WebSocket.CONNECTING) queued.push(data);
  });
  client.on('close', () => { relayLog('browser closed'); closeBoth(); });
  client.on('error', (error) => { relayLog('browser error', error.message); closeBoth(1011, 'browser socket error'); });
});

httpsServer.listen(port, host, () => {
  process.stdout.write(`Mabel Live web relay listening on https://${host}:${port}/live\n`);
});

function stop() {
  webSocketServer.clients.forEach((client) => client.close(1001, 'relay shutting down'));
  httpsServer.close(() => process.exit(0));
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
