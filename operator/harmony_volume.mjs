#!/usr/bin/env node
/** One-shot Harmony volume helper for bridge-owned browser Live sessions. */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { HarmonyHubClient, harmony_press_many } from './harmony_hub.mjs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  if (process.argv[index].startsWith('--')) args.set(process.argv[index].slice(2), process.argv[index + 1] || '');
}

const command = String(args.get('command') || '').trim();
const count = Number(args.get('count'));
const interPressMs = Math.max(0, Number(args.get('inter-press-ms') || 5));
if (!['VolumeDown', 'VolumeUp'].includes(command)) throw new Error('command must be VolumeDown or VolumeUp');
if (!Number.isInteger(count) || count < 1) throw new Error('count must be a positive integer');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mapping = JSON.parse(readFileSync(path.join(root, 'config', 'harmony-mapping.json'), 'utf8'));
const hub = mapping.hub || {};
const activeDeviceIds = new Set((mapping.activities || [])
  .filter((activity) => String(activity.id) !== '-1')
  .flatMap((activity) => activity.devices || activity.deviceIds || [])
  .map((id) => String(id)));
const denon = (mapping.devices || []).find((device) => /denon/i.test(String(device.name || '')) && activeDeviceIds.has(String(device.id)))
  || (mapping.devices || []).find((device) => /denon/i.test(String(device.name || '')));
const deviceId = String(process.env.HARMONY_VOLUME_DEVICE_ID || denon?.id || '').trim();
if (!deviceId) throw new Error('Denon Harmony volume device is not configured');

const client = new HarmonyHubClient({
  host: process.env.HARMONY_HOST || hub.host || '',
  port: Number(process.env.HARMONY_PORT || hub.port || 8088),
  domain: process.env.HARMONY_DOMAIN || hub.domain || 'svcs.myharmony.com',
  hubId: process.env.HARMONY_HUB_ID || hub.id || '',
});
try {
  const result = await harmony_press_many(deviceId, command, count, { client, interPressMs });
  process.stdout.write(`${JSON.stringify({ ok: true, command, ...result })}\n`);
} finally {
  client.close();
}
