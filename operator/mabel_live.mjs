#!/usr/bin/env node
/** Experimental GPT-Live Mabel client. Production remains mabel_realtime.mjs. */

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, unlink, writeFile, writeFileSync } from 'node:fs';
import process from 'node:process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { HarmonyHubClient, harmony_press_many } from './harmony_hub.mjs';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i].startsWith('--')) args.set(process.argv[i].slice(2), process.argv[i + 1] || '');
}
const input = args.get('input') || ':0';
const duplex = ['half', 'full', 'hybrid'].includes(args.get('duplex')) ? args.get('duplex') : 'half';
// Streaming remains the interactive architecture. Response mode is only a
// diagnostic comparison path that waits for one complete response.
const requestedPlaybackMode = args.get('playback-mode')
  || (args.has('stream-output') && args.get('stream-output') === 'false' ? 'response' : 'stream');
const playbackMode = ['stream', 'response'].includes(requestedPlaybackMode) ? requestedPlaybackMode : 'stream';
const streamOutput = playbackMode === 'stream';
const captureDir = path.resolve(args.get('capture-dir') || process.cwd());
const requestedCaptureResponse = Number(args.get('capture-response') || 2);
const captureResponseNumber = Number.isFinite(requestedCaptureResponse) ? Math.max(1, Math.floor(requestedCaptureResponse)) : 2;
const verboseDiagnostics = args.get('verbose') === 'true';
const mabelUrl = args.get('mabel-url') || 'http://127.0.0.1:8788';
const ffmpeg = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find((candidate) => existsSync(candidate)) || 'ffmpeg';
const audioDeviceIndex = args.get('audio-device-index') ?? process.env.MABEL_AUDIO_DEVICE_INDEX ?? '';
const outputDevice = args.get('output-device') || process.env.MABEL_AUDIO_OUTPUT_DEVICE || 'HIFI DSD';
const telephoneEq = args.has('telephone-eq') && args.get('telephone-eq') !== 'false';
const nativePlayer = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../state/mabel_live_player');
const useNativePlayer = args.get('player') !== 'ffmpeg' && existsSync(nativePlayer);
const soundsDir = args.get('sounds-dir') || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../sounds');
const soundFiles = { ringback: 'phone-ringback-answer-click.m4a', footsteps: 'high-heels-walk-2s.m4a', hangup: 'phone-hangup-click.m4a' };
const ambienceFile = path.join(soundsDir, 'shyvers-office-ambiance.mp3');
const ambienceEnabled = args.get('ambience') !== 'false';
const ambienceVolume = String(Math.min(1, Math.max(0, Number(args.get('ambience-volume') || 0.064))));
const ambienceLoopDurationSec = 300;
const heelsVoiceGain = Math.min(1, Math.max(0, Number(args.get('heels-voice-gain') ?? 0.18)));
const voicePlaybackSpeed = Math.max(1, Number(args.get('voice-speed') ?? 1.0));
const parsedVoiceGain = Number(args.get('gain') ?? process.env.MABEL_LIVE_GAIN ?? 1.78275);
const requestedVoiceGain = Number.isFinite(parsedVoiceGain) ? Math.max(0, parsedVoiceGain) : 1.78275;
const cleanPathRequested = args.get('voice-speed') === '1.0' && args.get('gain') === '1.0' && !args.has('master-gain-db');
const parsedMasterGainDb = Number(args.get('master-gain-db') ?? process.env.MABEL_MASTER_GAIN_DB ?? (cleanPathRequested ? 0 : 10));
const masterGainDb = Number.isFinite(parsedMasterGainDb) ? parsedMasterGainDb : 0;
const masterGainLinear = 10 ** (masterGainDb / 20);
const cleanPcmPath = voicePlaybackSpeed === 1 && requestedVoiceGain === 1 && masterGainDb === 0;
const maxNumber = 170;
const duckSteps = Math.max(0, Math.min(100, Number(args.get('duck-steps') ?? 40)));
const duckInterPressMs = Math.max(0, Number(args.get('duck-inter-press-ms') ?? 0));
const restoreInterPressMs = Math.max(0, Number(args.get('restore-inter-press-ms') ?? 5));
const harmonyMappingFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../config/harmony-mapping.json');
function localHarmonyConfiguration() {
  try {
    const mapping = JSON.parse(readFileSync(harmonyMappingFile, 'utf8'));
    const hub = mapping.hub || {};
    const activeDeviceIds = new Set((mapping.activities || [])
      .filter((activity) => String(activity.id) !== '-1')
      .flatMap((activity) => activity.devices || activity.deviceIds || [])
      .map((id) => String(id)));
    const denon = (mapping.devices || []).find((device) => /denon/i.test(String(device.name || '')) && activeDeviceIds.has(String(device.id)))
      || (mapping.devices || []).find((device) => /denon/i.test(String(device.name || '')));
    const host = process.env.HARMONY_HOST || hub.host || '';
    const hubId = process.env.HARMONY_HUB_ID || hub.id || '';
    return {
      client: new HarmonyHubClient({
        host,
        port: Number(process.env.HARMONY_PORT || hub.port || 8088),
        domain: process.env.HARMONY_DOMAIN || hub.domain || 'svcs.myharmony.com',
        hubId,
      }),
      volumeDeviceId: String(denon?.id || ''),
      source: 'local Harmony mapping',
    };
  } catch {
    return { client: new HarmonyHubClient(), volumeDeviceId: '', source: 'environment' };
  }
}
const harmonyConfiguration = localHarmonyConfiguration();
const harmonyClient = harmonyConfiguration.client;
const harmonyVolumeDeviceId = args.get('harmony-volume-device-id') || process.env.HARMONY_VOLUME_DEVICE_ID || harmonyConfiguration.volumeDeviceId;
const harmonyVolumeDeviceSource = args.get('harmony-volume-device-id') || process.env.HARMONY_VOLUME_DEVICE_ID ? 'CLI/environment' : harmonyConfiguration.source;
const startedAt = Date.now();
const apiKey = execFileSync('/usr/bin/security', ['find-generic-password', '-s', 'Shyvers Multiphone / OpenAI', '-a', 'mabel-voice', '-w'], { encoding: 'utf8' }).trim();
if (!apiKey) throw new Error('OpenAI API key is not configured');

const persona = `You are Mabel, a lively young adult of about 19, working as a 1940s telephone operator and record spinner for Multiphone in Seattle. Speak only clear American English in a distinctly youthful, light, high-register, lively, animated 1940s telephone-operator vernacular. Sound unmistakably young and bright—not mature, low, husky, or contralto—and keep the pitch lifted as though smiling. Use authentic 1940s American diction, idiom, rhythm, and telephone etiquette throughout: phrases such as “why, hello there,” “my goodness,” “just grand,” “swell,” “right away,” “hold tight,” and “one moment” are appropriate when they fit. Avoid modern assistant language and modern filler such as “okay,” “no problem,” “gotcha,” “yeah,” “totally,” “awesome,” or “sure”; do not sound like a contemporary customer-service agent. Use light period humor and occasional tasteful affection, but stay concise. Speak at a naturally brisk pace approximately 15–20% faster than ordinary conversation, using short pauses and crisp consonants—quick and excited, but never rushed or unintelligible. The caller is already connected to Mabel; she retrieves records from the Multiphone library and never connects, transfers, routes, dials, or “puts through” anyone. Never invent titles, artists, numbers, queue positions, credit counts, or service results. Valid numbered records are 1 through ${maxNumber}. Normal mode is a deterministic numbered-request flow. Do not independently confirm, repeat, reinterpret, or acknowledge a caller's possible record number; wait silently while the local application evaluates it and supplies the exact confirmation wording. When the local application supplies a confirmation, speak only those supplied digit words in the same order—never substitute, round, or invent a digit. If the caller corrects the number, wait for the local application to supply the new confirmation. MANDATORY CONFIRMATION DELIVERY: every number confirmation must be an unmistakable yes-or-no question ending with a clearly audible, strongly high-rising question intonation on the final digit. Never end a confirmation with falling or level intonation. If the caller explicitly says “go off-script” or “I'm a VIP,” enter expanded private music service. The local application performs every VIP action and supplies the exact result; never invent or imply a title, artist, queue state, playback state, credits, or success. After a supplied successful result, report only those facts and follow the local application's sign-off instruction. The local application is authoritative for all Multiphone actions. Never claim success until it supplies the result.`;
const styleGuide = `Speak as a real young American woman answering one telephone line in Seattle in the 1940s, not as a narrator or a performer doing a caricature. You are a busy central music-station operator speaking directly to one patron. Keep routine exchanges short, natural, cheerful, confident, and lightly playful without becoming theatrical, cartoonish, or overly bubbly. Use authentic period diction, idiom, rhythm, and telephone etiquette naturally and sparingly; “lemme grab that off the shelf,” “hold tight,” “one moment,” “my goodness,” “just grand,” and “swell” may fit. Avoid modern slang, technical language, AI language, customer-service clichés, and explanations about portraying the 1940s. Use moderate telephone backchannels only when useful—“mm-hmm,” “uh-huh,” or “right”—and never talk over the patron or compete with a record number. Stop speaking immediately when interrupted and listen for the correction. Keep the line moving because other patrons are waiting. Maintain the same youthful high register, volume, and conversational pace throughout each response, including the final goodbye; do not suddenly become louder, faster, or more emphatic at the end.`;
const pacingAdjustment = 'Use a slightly less brisk working pace—about 10–15% faster than ordinary conversation—with natural pauses between phrases. Stay lively and clear, but do not rush or compress words. Keep any brief approval of a selection natural and varied; you may express that you like the choice in your own words, but do not repeat a stock phrase or catchphrase. Keep such reactions at the same normal conversational volume as the surrounding sentence. Do not shout, punch, bark, or make sudden loudness or theatrical emphasis changes.';
const volumeDeliveryGuide = `VOLUME AND DELIVERY

Maintain a consistent conversational speaking volume throughout the entire call.

Do not become louder, more projected, or more animated when ending the conversation.

Final acknowledgments and goodbyes should be spoken at the same volume and vocal intensity as the preceding conversation.

Treat the sign-off as a quiet telephone goodbye to one person, not an announcement or performance.

Do not emphasize or project the final words of the call.`;
const voiceTimbreGuide = 'VOICE TIMBRE\n\nUse a slightly nasal, forward telephone timbre that suits a young 1940s operator. Keep it subtle and natural, never exaggerated, honking, cartoonish, or theatrical.';
const usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_audio_tokens: 0, output_audio_tokens: 0 };
let ws;
let recorder;
let player;
let session;
let callSession;
let liveStarted = false;
let liveStartedAt = null;
let firstOutputLogged = false;
let closing = false;
let outputPlaying = false;
let outputStartedAt = null;
let outputIdleTimer;
let responseFlushTimer;
let responseMaxFlushTimer;
let outputChunks = [];
let outputStreamOpen = false;
let outputQueue = Promise.resolve();
let playbackGeneration = 0;
let currentPlayback = null;
let streamWriter = null;
let livePcmBytesReceived = 0;
let outputAudioBytes = 0;
let outputAudioDeltas = 0;
let avfoundationAudioBytes = 0;
let avfoundationWriteCalls = 0;
let avfoundationHandoffFrames = 0;
let avfoundationBackpressureCount = 0;
let lastBackpressureLogAt = 0;
let pcmInvariantViolations = 0;
let gainOverflowSamples = 0;
let resampleClampSamples = 0;
let lastLiveAudioDeltaAt = null;
let liveAudioGapCount = 0;
let maxLiveAudioGapMs = 0;
let lastOutputDiagnosticAt = 0;
let transcript = '';
let transcriptTimer;
let confirmationRetryTimer;
let shutdownTimer;
let finalResponseTimer;
let finalResponseSafetyTimer;
let cleanedUp = false;
let pendingNumber = null;
let awaitingConfirmation = false;
let selectionInProgress = false;
let offScript = false;
let offScriptActionInProgress = false;
let turns = 0;
let interruptions = 0;
let overlapMs = 0;
let lastInputActivityAt = Date.now();
let duckResult = { sent: 0 };
let duckPromise = Promise.resolve();
let shutdownPromise = null;
let cleanupPromise = null;
let inputFrames = 0;
let inputBytes = 0;
let inputSentBytes = 0;
let inputSuppressedBytes = 0;
let inputPeakRms = 0;
let lastInputDiagnosticAt = 0;
let lastAcousticDiagnosticAt = 0;
let ambienceProcess = null;
let ambienceTimer = null;
let ambienceActive = false;
let ambienceLoopFile = null;
let finalResponsePending = false;
let finalResponseSawGoodbye = false;
let finalResponseStartedAt = null;
let finalResponseTranscript = '';
let finalResponseAudioDoneAt = null;
let finalGoodbyeAt = null;
let lastOutputAudioAt = null;
let voiceGain = requestedVoiceGain;
let voiceResampleBuffer = [];
let voiceResamplePosition = 0;
let captureResponse = null;
let captureSaved = false;
let completedAudioResponses = 0;
const loggedEventTypes = new Set();

let audioToolboxDeviceIndex = null;
let audioToolboxDeviceResolved = false;

function resolveAudioToolboxDeviceIndex() {
  if (audioToolboxDeviceResolved) return audioToolboxDeviceIndex;
  audioToolboxDeviceResolved = true;
  if (!outputDevice || /^(default|system default)$/i.test(outputDevice)) {
    log('AudioToolbox output device', { requested: outputDevice || 'system default', selected: 'system default', index: -1 });
    audioToolboxDeviceIndex = -1;
    return audioToolboxDeviceIndex;
  }
  const probe = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'info',
    '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', '0',
    '-f', 'audiotoolbox', '-list_devices', 'true', '-audio_device_index', '-1', 'default',
  ], { encoding: 'utf8' });
  const listing = `${probe.stdout || ''}\n${probe.stderr || ''}`;
  const wanted = outputDevice.toLowerCase();
  const line = listing.split(/\r?\n/).find((candidate) => candidate.toLowerCase().includes(wanted));
  const match = line?.match(/\[\s*(\d+)\]/);
  if (!match) {
    throw new Error(`AudioToolbox output device not found: ${outputDevice}`);
  }
  audioToolboxDeviceIndex = Number(match[1]);
  log('AudioToolbox output device', { requested: outputDevice, selected: line.trim(), index: audioToolboxDeviceIndex });
  return audioToolboxDeviceIndex;
}

function audioToolboxOutputArgs() {
  return ['-f', 'audiotoolbox', '-audio_device_index', String(resolveAudioToolboxDeviceIndex()), 'default'];
}

function spawnAudioToolboxFile(file, volume = null, durationSec = null) {
  const effectiveVolume = volume === null ? masterGainLinear : Number(volume) * masterGainLinear;
  const filterArgs = effectiveVolume === 1 ? [] : ['-af', `volume=${effectiveVolume}`];
  const durationArgs = durationSec === null ? [] : ['-t', String(durationSec)];
  return spawn(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-re',
    '-i', file, '-vn', '-map', '0:a:0', ...filterArgs, ...durationArgs,
    ...audioToolboxOutputArgs(),
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
}

function log(message, details = {}) {
  console.log(`[live ${new Date().toISOString()}] ${message}${Object.keys(details).length ? ` ${JSON.stringify(details)}` : ''}`);
}
function playEffect(name) {
  const file = path.join(soundsDir, soundFiles[name]);
  if (!existsSync(file)) { log('sound effect missing', { name, file }); return Promise.resolve(); }
  const volume = name === 'ringback' ? '0.125' : name === 'footsteps' ? '0.175' : '0.375';
  return new Promise((resolve) => {
    let playback;
    try {
      playback = spawnAudioToolboxFile(file, volume, name === 'ringback' ? 9 : name === 'footsteps' ? 6 : 4);
    } catch (error) {
      log('sound effect output device error', { name, outputDevice, error: error.message });
      resolve();
      return;
    }
    playback.stderr.on('data', (chunk) => log('sound effect error', { name, error: chunk.toString().trim() }));
    playback.once('error', (error) => { log('sound effect error', { name, error: error.message }); resolve(); });
    playback.once('close', () => resolve());
    setTimeout(() => { if (!playback.killed) playback.kill('SIGTERM'); }, name === 'ringback' ? 10000 : name === 'footsteps' ? 7000 : 5000).unref();
  });
}
function startAmbience() {
  if (!ambienceEnabled || ambienceActive || !existsSync(ambienceFile)) return;
  ambienceActive = true;
  ambienceLoopFile = path.join(tmpdir(), `mabel-live-ambience-${process.pid}.mp3`);
  try {
    execFileSync(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-stream_loop', '-1', '-i', ambienceFile,
      '-t', String(ambienceLoopDurationSec), '-c:a', 'copy', '-y', ambienceLoopFile,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (error) {
    log('ambience loop generation failed; using source file', { error: error.message });
    unlink(ambienceLoopFile, () => {});
    ambienceLoopFile = null;
  }
  const playbackFile = ambienceLoopFile || ambienceFile;
  const playNext = () => {
    if (!ambienceActive) return;
    try {
      ambienceProcess = spawnAudioToolboxFile(playbackFile, ambienceVolume);
    } catch (error) {
      log('ambience output device error', { outputDevice, error: error.message });
      ambienceActive = false;
      return;
    }
    const playback = ambienceProcess;
    playback.stderr.on('data', (chunk) => log('ambience playback error', { error: chunk.toString().trim() }));
    playback.once('close', () => { if (ambienceProcess === playback) { ambienceProcess = null; if (ambienceActive) setTimeout(playNext, 25); } });
    ambienceTimer = setTimeout(() => { if (ambienceProcess === playback) playback.kill('SIGTERM'); }, ambienceLoopDurationSec * 1000);
    ambienceTimer.unref();
  };
  playNext();
  log('office ambience started', { file: ambienceFile, playbackFile, volume: ambienceVolume, loopDurationSec: ambienceLoopDurationSec });
}
function stopAmbience() {
  ambienceActive = false;
  if (ambienceTimer) clearTimeout(ambienceTimer);
  ambienceTimer = null;
  if (ambienceProcess) ambienceProcess.kill('SIGTERM');
  ambienceProcess = null;
  if (ambienceLoopFile) unlink(ambienceLoopFile, () => {});
  ambienceLoopFile = null;
}
function startVolumeDucking() {
  log('volume ducking configuration', {
    source: harmonyVolumeDeviceSource,
    deviceConfigured: Boolean(harmonyVolumeDeviceId),
    hubConfigured: Boolean(harmonyClient.host && harmonyClient.hubId),
  });
  if (duckSteps > 0 && harmonyVolumeDeviceId) {
    duckPromise = harmony_press_many(harmonyVolumeDeviceId, 'VolumeDown', duckSteps, { client: harmonyClient, interPressMs: duckInterPressMs })
      .then((result) => { duckResult = result; log('volume ducked', { sent: result.sent, interPressMs: duckInterPressMs }); })
      .catch((error) => log('volume duck error', { error: error.message }));
  } else if (duckSteps > 0) {
    log('volume ducking skipped', { reason: 'HARMONY_VOLUME_DEVICE_ID is unset' });
  }
}
async function post(endpoint, body) {
  const response = await fetch(`${mabelUrl}${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Mabel service HTTP ${response.status}`);
  return result;
}
function digits(number) { return String(number).split('').join('-'); }
function numberFromText(text) {
  const value = String(text || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ');
  const digit = value.match(/\b\d+\b/);
  if (digit) {
    const number = Number(digit[0]);
    return Number.isInteger(number) && number >= 1 && number <= maxNumber ? number : null;
  }
  const units = { one: 1, two: 2, three: 3, tree: 3, free: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
  const small = { ...units, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
  const tens = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
  const digitWords = { zero: 0, oh: 0, naught: 0, ...units };
  const digitTokens = value.replace(/-/g, ' ').split(/\s+/).filter(Boolean);
  for (let i = 0; i < digitTokens.length; i += 1) {
    let j = i;
    let digitsText = '';
    while (j < digitTokens.length && digitWords[digitTokens[j]] !== undefined) {
      digitsText += String(digitWords[digitTokens[j]]);
      j += 1;
    }
    if (digitsText.length >= 2 && digitsText.length <= 3) {
      const number = Number(digitsText);
      if (number >= 1 && number <= maxNumber) return number;
    }
    if (j > i) i = j - 1;
  }
  const tokens = value.replace(/-/g, ' ').split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] === 'and') continue;
    if (small[tokens[i]] === undefined && tens[tokens[i]] === undefined) continue;
    let number = small[tokens[i]] ?? tens[tokens[i]];
    let j = i + 1;
    if (tokens[j] === 'hundred' && small[tokens[i]] !== undefined && small[tokens[i]] < 10) {
      number *= 100;
      j += 1;
      if (tokens[j] === 'and') j += 1;
      if (tens[tokens[j]] !== undefined) {
        number += tens[tokens[j]];
        j += 1;
        if (units[tokens[j]] !== undefined) number += units[tokens[j]];
      } else if (small[tokens[j]] !== undefined) {
        number += small[tokens[j]];
      }
    } else if (tens[tokens[i]] !== undefined && units[tokens[j]] !== undefined) {
      number += units[tokens[j]];
    } else if (small[tokens[i]] !== undefined && small[tokens[i]] < 10 && tens[tokens[j]] !== undefined) {
      // Colloquial forms such as “one fifty” mean 150.
      number = (small[tokens[i]] * 100) + tens[tokens[j]];
      if (units[tokens[j + 1]] !== undefined) number += units[tokens[j + 1]];
    } else if (small[tokens[i]] !== undefined && small[tokens[i]] < 10 && small[tokens[j]] !== undefined && small[tokens[j]] >= 10) {
      // Likewise, “one ten” means 110 when dictating a three-digit number.
      number = (small[tokens[i]] * 100) + small[tokens[j]];
    }
    if (number >= 1 && number <= maxNumber) return number;
  }
  return null;
}
function affirmative(text) { return /\b(yes|yeah|yep|yup|uh[- ]?huh|right|exactly|that'?s (right|the one|it|correct)|that is (right|the one|it|correct)|you got it|sure|correct)\b/i.test(text); }
function negative(text) { return /\b(no|nope|wrong|not that|wait|hold on|sorry)\b/i.test(text); }
function callerRequestedTermination(text) {
  return /\b(?:goodbye|bye(?:\s+now)?|hang\s+up|terminate|end\s+(?:the\s+)?call|you\s+can\s+(?:hang\s+up|terminate))\b/i.test(String(text || ''));
}
const offScriptTriggerPattern = /\bgo[ -]?off[ -]?script\b|\boff[ -]?script\b|\bi(?:['’]m| am)\s+a\s+v(?:\.?i\.?p\.?)\b/i;
function offScriptRequestFromText(text) {
  const value = String(text || '').trim().replace(/[.!?]+$/, '');
  if (/\b(?:what(?:'s| is)|now)\s+(?:currently\s+)?playing\b|\bnow playing\b/i.test(value)) return { action: 'now_playing' };
  const mix = value.match(/\b(?:play|put on|make|give me)\b.*?\bmix\b(?:\s+of)?\s+(.+)/i) || value.match(/\bmix\s+(?:of\s+)?(.+)/i);
  if (mix) {
    const artists = mix[1].split(/\s+and\s+|\s*,\s*/i).map((item) => item.trim()).filter(Boolean);
    if (artists.length >= 2) return { action: 'play_mix', artists };
  }
  const album = value.match(/\b(?:play|put on|get|find|queue)\s+(?:the\s+)?album\s+[“"]?(.+?)[”"]?$/i)
    || value.match(/\b(?:play|put on|get|find|queue)\s+(?:the\s+)?[“"]?(.+?)[”"]?\s+album\b/i);
  if (album) return { action: 'play_album', album: album[1].trim() };
  const playlist = value.match(/\b(?:play|put on|get|find|queue)\s+(?:the\s+)?playlist\s+[“"]?(.+?)[”"]?$/i)
    || value.match(/\b(?:play|put on|get|find|queue)\s+(?:the\s+)?[“"]?(.+?)[”"]?\s+playlist\b/i);
  if (playlist) return { action: 'play_playlist', playlist: playlist[1].trim() };
  const artist = value.match(/\b(?:play|put on|get|find|queue)\s+(?:some\s+)?(?:music|records?|songs?)?\s*(?:by|from)\s+(.+)/i);
  if (artist) return { action: 'play_artist', artist: artist[1].trim() };
  const genericPlay = value.match(/\b(?:play|put on|give me|let me hear|listen to|i(?:'d| would) like to hear)\s+(?:some\s+)?(.+)/i);
  if (genericPlay && !/\b(?:album|playlist|mix|now playing)\b/i.test(genericPlay[1])) {
    return { action: 'play_artist', artist: genericPlay[1].trim() };
  }
  return null;
}
function offScriptResultInstructions(request, envelope) {
  const result = envelope?.result && typeof envelope.result === 'object' ? envelope.result : envelope;
  const facts = JSON.stringify(result || {});
  if (request.action === 'now_playing') return `The local Multiphone application returned this authoritative now-playing result: ${facts}. Report only the supplied title, artist, and playback facts. Do not invent anything. Remain in VIP mode and keep listening.`;
  return `The local Multiphone application returned this authoritative VIP result for ${request.action}: ${facts}. Briefly tell the caller only what the result establishes, and say that playback is starting only if the result says it started. Do not invent a title, artist, queue state, or success. Then give a brief varied goodbye containing “bye” or “goodbye” at the same conversational volume and pace. Do not ask another question; this is the final response and end the call.`;
}
async function processOffScriptRequest(request) {
  if (offScriptActionInProgress || closing) return;
  offScriptActionInProgress = true;
  try {
    const body = { sessionId: callSession.sessionId, action: request.action };
    if (request.action === 'play_album') body.album = request.album;
    if (request.action === 'play_artist') body.artist = request.artist;
    if (request.action === 'play_playlist') body.playlist = request.playlist;
    if (request.action === 'play_mix') body.artists = request.artists;
    const result = await post('/shyvers/offscript', body);
    log('deterministic VIP result', { request, result });
    if (request.action !== 'now_playing') armFinalResponseShutdown();
    announce(offScriptResultInstructions(request, result));
  } catch (error) {
    log('VIP selection error', { request, error: error.message });
    armFinalResponseShutdown();
    announce(`The local Multiphone application reported this authoritative VIP error: “${error.message}”. Say briefly that the central station could not complete that private request, then give a quiet goodbye containing “bye” or “goodbye” and end the call. Do not invent a result.`);
  } finally {
    offScriptActionInProgress = false;
  }
}
function confirmationDigits(number) {
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
  return String(number).split('').map((digit) => words[Number(digit)]).join(' ');
}
const confirmationLeadIns = [
  'I don’t want to grab the wrong one, so just confirming',
  'Let me make sure I have the right record before I fetch it—just confirming',
  'It’s a bit noisy here, so just confirming',
  'Before I pull that one from the cabinet, just confirming',
];
let confirmationStyleIndex = 0;
function requestConfirmation(number) {
  clearTimeout(confirmationRetryTimer);
  confirmationRetryTimer = null;
  const spokenDigits = confirmationDigits(number);
  const leadIn = confirmationLeadIns[confirmationStyleIndex % confirmationLeadIns.length];
  confirmationStyleIndex += 1;
  log('confirmation requested', { number, spokenDigits, leadIn, questionIntonation: 'high-rising-final-digit' });
  announce(`The local application has supplied the exact confirmation. Say exactly: “${leadIn}, ${spokenDigits}?” MANDATORY: this must be an unmistakable yes-or-no question with a strong, clearly audible upward pitch rise on the final digit word ${spokenDigits.split(' ').at(-1)}. Do not use falling or level intonation; hold the rise through the end of that final digit and leave a brief beat afterward. Do not say any other number, do not substitute a digit, and do not add a second number.`);
  confirmationRetryTimer = setTimeout(() => {
    confirmationRetryTimer = null;
    if (closing || !awaitingConfirmation || pendingNumber !== number) return;
    log('confirmation retry', { number, waitMs: 1800 });
    requestConfirmation(number);
  }, 1800);
  confirmationRetryTimer.unref();
}
function announce(content) {
  if (ws?.readyState !== WebSocket.OPEN || closing) return;
  ws.send(JSON.stringify({ type: 'session.commentary.append', event_id: `mabel_${Date.now()}`, delegation_id: null, content }));
}
function pcmRms(chunk) {
  let sum = 0; let count = 0;
  for (let i = 0; i + 1 < chunk.length; i += 2) { const sample = chunk.readInt16LE(i) / 32768; sum += sample * sample; count += 1; }
  return count ? Math.sqrt(sum / count) : 0;
}
function pcmWav(pcm, sampleRate = 24000, channels = 1) {
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + pcm.length, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22); wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * blockAlign, 28); wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(bytesPerSample * 8, 34); wav.write('data', 36);
  wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
  return wav;
}
function saveCapturedResponse(boundary = 'audio.done') {
  if (!captureResponse || captureSaved) return;
  captureSaved = true;
  const raw = Buffer.concat(captureResponse.rawChunks);
  const rendered = Buffer.concat(captureResponse.renderedChunks);
  const files = {
    rawPcm: path.join(captureDir, 'live-raw.pcm'),
    rawWav: path.join(captureDir, 'live-raw.wav'),
    renderedWav: path.join(captureDir, 'live-rendered.wav'),
  };
  try {
    writeFileSync(files.rawPcm, raw);
    writeFileSync(files.rawWav, pcmWav(raw));
    writeFileSync(files.renderedWav, pcmWav(rendered));
  } catch (error) {
    log('capture write error', { captureDir, error: error.message });
  }
  log('Live response capture saved', {
    boundary,
    responseNumber: captureResponse.responseNumber,
    captureDir,
    rawPcmBytes: raw.length,
    renderedPcmBytes: rendered.length,
    rawDurationMs: Math.round(raw.length / 48),
    renderedDurationMs: Math.round(rendered.length / 48),
    files,
  });
}
function applyVoiceGain(pcm) {
  if (voiceGain === 1) return pcm;
  const adjusted = Buffer.from(pcm);
  let clampedSamples = 0;
  for (let offset = 0; offset + 1 < adjusted.length; offset += 2) {
    const scaled = Math.round(adjusted.readInt16LE(offset) * voiceGain);
    const sample = Math.max(-32768, Math.min(32767, scaled));
    if (sample !== scaled) { gainOverflowSamples += 1; clampedSamples += 1; }
    adjusted.writeInt16LE(sample, offset);
  }
  if (clampedSamples) log('PCM gain clamp', { samples: clampedSamples, gain: voiceGain });
  return adjusted;
}
function resampleVoicePcm(pcm) {
  if (voicePlaybackSpeed === 1) return pcm;
  for (let offset = 0; offset + 1 < pcm.length; offset += 2) voiceResampleBuffer.push(pcm.readInt16LE(offset));
  const output = [];
  let clampedSamples = 0;
  while (voiceResamplePosition + 1 < voiceResampleBuffer.length) {
    const index = Math.floor(voiceResamplePosition);
    const fraction = voiceResamplePosition - index;
    const interpolated = Math.round(voiceResampleBuffer[index] + ((voiceResampleBuffer[index + 1] - voiceResampleBuffer[index]) * fraction));
    const sample = Math.max(-32768, Math.min(32767, interpolated));
    if (sample !== interpolated) { resampleClampSamples += 1; clampedSamples += 1; }
    output.push(sample);
    voiceResamplePosition += voicePlaybackSpeed;
  }
  const consumed = Math.floor(voiceResamplePosition);
  if (consumed > 0) {
    voiceResampleBuffer = voiceResampleBuffer.slice(consumed);
    voiceResamplePosition -= consumed;
  }
  const result = Buffer.alloc(output.length * 2);
  output.forEach((sample, index) => result.writeInt16LE(sample, index * 2));
  if (clampedSamples) log('PCM resample clamp', { samples: clampedSamples, speed: voicePlaybackSpeed });
  return result;
}

// Future AEC/DSP insertion point. This v1 performs policy gating only.
function processInputAudio(chunk) {
  const rms = pcmRms(chunk);
  inputFrames += 1;
  inputBytes += chunk.length;
  inputPeakRms = Math.max(inputPeakRms, rms);
  if (Date.now() - lastInputDiagnosticAt >= 2000) {
    log('microphone diagnostic', { outputPlaying, frames: inputFrames, capturedBytes: inputBytes, sentBytes: inputSentBytes, suppressedBytes: inputSuppressedBytes, peakRms: Number(inputPeakRms.toFixed(4)) });
    lastInputDiagnosticAt = Date.now();
    inputPeakRms = 0;
  }
  if (rms >= 0.018) {
    lastInputActivityAt = Date.now();
    if (outputPlaying) {
      overlapMs += chunk.length / 2 / 24000 * 1000;
      if (verboseDiagnostics && Date.now() - lastAcousticDiagnosticAt >= 1000) {
        log('acoustic activity while output is playing', { duplex, rms: Number(rms.toFixed(4)), bytes: chunk.length });
        lastAcousticDiagnosticAt = Date.now();
      }
    }
  }
  if (duplex === 'half' && outputPlaying) { inputSuppressedBytes += chunk.length; return null; }
  // Hybrid is intentionally transparent in v1: measure before adding DSP.
  return chunk;
}
function setOutputPlaying(value) {
  if (value === outputPlaying) return;
  outputPlaying = value;
  if (value) { outputStartedAt = Date.now(); log('output started'); }
  else { log('output drained', { outputMs: outputStartedAt ? Date.now() - outputStartedAt : null }); outputStartedAt = null; }
}
function playPcm(pcm, generation) {
  if (generation !== playbackGeneration) return Promise.resolve();
  const wav = pcmWav(pcm);
  const file = path.join(tmpdir(), `mabel-live-${Date.now()}.wav`);
  return new Promise((resolve) => {
    writeFile(file, wav, (writeError) => {
      if (writeError) { log('audio file error', { error: writeError.message }); resolve(); return; }
      if (generation !== playbackGeneration) { unlink(file, () => {}); resolve(); return; }
      let playback;
      try {
        playback = spawnAudioToolboxFile(file);
      } catch (error) {
        log('playback output device error', { outputDevice, error: error.message });
        unlink(file, () => {});
        resolve();
        return;
      }
      currentPlayback = playback;
      log('file voice playback started', { bytes: pcm.length, durationMs: Math.round(pcm.length / 48) });
      let stderr = '';
      playback.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      playback.once('error', (error) => { log('playback error', { error: error.message }); currentPlayback = null; unlink(file, () => {}); resolve(); });
      playback.once('close', (code, signal) => {
        if (code !== 0 || signal) log('playback ended abnormally', { code, signal, stderr: stderr.trim() });
        else log('file voice playback finished', { bytes: pcm.length });
        currentPlayback = null;
        unlink(file, () => {}); resolve();
      });
    });
  });
}
function flushOutput() {
  if (!outputChunks.length) return;
  clearTimeout(responseFlushTimer);
  responseFlushTimer = null;
  clearTimeout(responseMaxFlushTimer);
  responseMaxFlushTimer = null;
  const pcm = Buffer.concat(outputChunks);
  outputChunks = [];
  outputStreamOpen = false;
  const generation = playbackGeneration;
  outputQueue = outputQueue.then(() => playPcm(pcm, generation)).catch((error) => log('playback queue error', { error: error.message })).finally(() => {
    if (!outputStreamOpen && !outputChunks.length) setOutputPlaying(false);
  });
}
function interruptLocalPlayback(reason) {
  playbackGeneration += 1;
  voiceResampleBuffer = [];
  voiceResamplePosition = 0;
  outputQueue = Promise.resolve();
  if (currentPlayback) {
    log('stale playback interrupted', { reason });
    currentPlayback.kill('SIGTERM');
    currentPlayback = null;
  }
  setOutputPlaying(false);
}
function drainStreamPlayer() {
  const activePlayer = player;
  if (!activePlayer) return Promise.resolve();
  log('draining stream player before shutdown');
  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      log('stream player drain timeout; terminating', { waitMs: 5000 });
      activePlayer.kill('SIGTERM');
      resolve();
    }, 5000);
    timeout.unref();
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    activePlayer.once('close', finish);
    activePlayer.once('error', finish);
    if (activePlayer.stdin?.writable) activePlayer.stdin.end();
    else finish();
  });
}
function ensureNativeStream() {
  if (streamWriter?.writable) return;
  if (useNativePlayer) {
    const playerArgs = [];
    if (telephoneEq) playerArgs.push('--telephone-eq');
    if (masterGainDb !== 0) playerArgs.push('--master-gain-db', String(masterGainDb));
    if (outputDevice) playerArgs.push('--output-device', outputDevice);
    player = spawn(nativePlayer, playerArgs, { stdio: ['pipe', 'ignore', 'pipe'] });
    log('voice player started', { backend: 'AVFoundation', output: outputDevice || 'system default', telephoneEq, masterGainDb, format: 'pcm_s16le mono 24000 Hz' });
  } else {
  const deviceArgs = audioDeviceIndex === '' ? [] : ['-audio_device_index', audioDeviceIndex];
  player = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', '24000', '-ch_layout', 'mono', '-i', 'pipe:0', '-ar', '48000', '-ch_layout', 'stereo', '-flush_packets', '1', '-f', 'audiotoolbox', ...deviceArgs, 'default'], { stdio: ['pipe', 'ignore', 'pipe'] });
  log('voice player started', { backend: 'ffmpeg-audiotoolbox', output: 'default', deviceIndex: audioDeviceIndex === '' ? 'system default' : Number(audioDeviceIndex), format: 'pcm_s16le stereo 48000 Hz', flushPackets: true });
  }
  player.stderr.on('data', (chunk) => log('stream playback error', { error: chunk.toString().trim() }));
  player.stdin.on('error', (error) => log('stream playback pipe error', { error: error.message }));
  player.once('error', (error) => log('stream player error', { error: error.message }));
  player.once('close', (code, signal) => { if (code !== 0 || signal) log('stream player closed', { code, signal }); player = null; streamWriter = null; });
  streamWriter = player.stdin;
}
function outputDelta(audio) {
  if (!firstOutputLogged) { firstOutputLogged = true; log('first output audio', { latencyMs: liveStartedAt ? Date.now() - liveStartedAt : null }); }
  const receivedAt = Date.now();
  if (lastLiveAudioDeltaAt !== null) {
    const gapMs = receivedAt - lastLiveAudioDeltaAt;
    maxLiveAudioGapMs = Math.max(maxLiveAudioGapMs, gapMs);
    if (gapMs > 120) {
      liveAudioGapCount += 1;
      log('Live audio delta gap', { gapMs, delta: outputAudioDeltas + 1 });
    }
  }
  lastLiveAudioDeltaAt = receivedAt;
  const livePcm = Buffer.from(audio, 'base64');
  if (livePcm.length % 2 !== 0) {
    pcmInvariantViolations += 1;
    log('PCM invariant violation', { stage: 'Live decode', reason: 'odd byte length', bytes: livePcm.length, delta: outputAudioDeltas + 1 });
    return;
  }
  livePcmBytesReceived += livePcm.length;
  if (!captureResponse && !captureSaved && completedAudioResponses + 1 >= captureResponseNumber) {
    captureResponse = { rawChunks: [], renderedChunks: [], deltas: 0, responseNumber: completedAudioResponses + 1 };
  }
  if (captureResponse && !captureSaved) { captureResponse.rawChunks.push(livePcm); captureResponse.deltas += 1; }
  const pcm = cleanPcmPath ? livePcm : applyVoiceGain(resampleVoicePcm(livePcm));
  if (pcm.length % 2 !== 0) {
    pcmInvariantViolations += 1;
    log('PCM invariant violation', { stage: 'DSP output', reason: 'odd byte length', bytes: pcm.length, delta: outputAudioDeltas + 1 });
    return;
  }
  lastOutputAudioAt = Date.now();
  if (finalResponsePending && !finalResponseSawGoodbye) scheduleFinalResponseClose();
  outputAudioBytes += pcm.length;
  outputAudioDeltas += 1;
  if (Date.now() - lastOutputDiagnosticAt >= 2000) {
    log('voice audio diagnostic', { deltas: outputAudioDeltas, bytes: outputAudioBytes, chunkBytes: pcm.length, chunkRms: Number(pcmRms(pcm).toFixed(4)), playbackMode });
    lastOutputDiagnosticAt = Date.now();
  }
  if (streamOutput) {
    ensureNativeStream();
    setOutputPlaying(true);
    if (streamWriter?.writable) {
      const frames = pcm.length / 2;
      if (!Number.isInteger(frames) || frames * 2 !== pcm.length) {
        pcmInvariantViolations += 1;
        log('PCM invariant violation', { stage: 'AVFoundation handoff', reason: 'bytes do not equal frames × 2', bytes: pcm.length, frames });
        return;
      }
      const accepted = streamWriter.write(pcm);
      if (!accepted) {
        avfoundationBackpressureCount += 1;
        if (Date.now() - lastBackpressureLogAt >= 1000) {
          log('PCM handoff backpressure', { bytes: pcm.length, frames, count: avfoundationBackpressureCount });
          lastBackpressureLogAt = Date.now();
        }
      }
      if (captureResponse && !captureSaved) captureResponse.renderedChunks.push(pcm);
      avfoundationAudioBytes += pcm.length;
      avfoundationHandoffFrames += frames;
      avfoundationWriteCalls += 1;
    } else {
      pcmInvariantViolations += 1;
      log('PCM invariant violation', { stage: 'AVFoundation handoff', reason: 'stream writer unavailable', bytes: pcm.length });
    }
    clearTimeout(outputIdleTimer);
    // AudioToolbox may still be draining the physical speaker after the final
    // network delta. Keep half-duplex input suppressed through that tail so
    // speaker leakage cannot trigger another Live response.
    outputIdleTimer = setTimeout(() => setOutputPlaying(false), 1500);
    return;
  }
  if (!outputStreamOpen) { outputStreamOpen = true; outputChunks = []; }
  setOutputPlaying(true);
  outputChunks.push(pcm);
  if (!streamOutput && !responseMaxFlushTimer) {
    // Diagnostic response mode must not remain silent if Live keeps producing
    // autonomous output without exposing a usable audio-done boundary.
    responseMaxFlushTimer = setTimeout(() => {
      if (outputStreamOpen && outputChunks.length) {
        log('response playback maximum-wait flush', { waitMs: 10000, bytes: outputChunks.reduce((total, chunk) => total + chunk.length, 0) });
        flushOutput();
      }
    }, 10000);
  }
  clearTimeout(responseFlushTimer);
  // Some Live sessions do not emit an audio-done event. Response mode is
  // diagnostic only, so use a conservative quiet-period fallback rather than
  // leaving the complete response silent indefinitely.
  responseFlushTimer = setTimeout(() => {
    if (!streamOutput && outputStreamOpen && outputChunks.length) {
      log('response playback fallback flush', { quietMs: 3000, bytes: outputChunks.reduce((total, chunk) => total + chunk.length, 0) });
      flushOutput();
    }
  }, 3000);
}
function scheduleFinalResponseClose() {
  if (!finalResponsePending || closing) return;
  clearTimeout(finalResponseTimer);
  if (finalResponseSawGoodbye) {
    // Live's transcript can reach "goodbye" before its final audio delta
    // (for example, "Goodbye" followed by "now."). Do not close the
    // session on transcript timing alone; wait for both a generous tail and
    // a real period of audio silence.
    const goodbyeTailMs = 1_800;
    const goodbyeQuietMs = 1_200;
    const missingAudioDoneFallbackMs = 3_000;
    const elapsedMs = finalGoodbyeAt ? Date.now() - finalGoodbyeAt : 0;
    const quietForMs = lastOutputAudioAt ? Date.now() - lastOutputAudioAt : 0;
    finalResponseTimer = setTimeout(() => {
      if (!finalResponsePending || closing) return;
      const sinceGoodbyeMs = finalGoodbyeAt ? Date.now() - finalGoodbyeAt : 0;
      const currentQuietMs = lastOutputAudioAt ? Date.now() - lastOutputAudioAt : 0;
      const audioDone = finalResponseAudioDoneAt !== null;
      const waitingForMissingAudioDone = !audioDone && sinceGoodbyeMs < missingAudioDoneFallbackMs;
      const waitingForAudioQuiet = audioDone && (currentQuietMs < goodbyeQuietMs || outputPlaying);
      if (sinceGoodbyeMs < goodbyeTailMs || waitingForMissingAudioDone || waitingForAudioQuiet) {
        scheduleFinalResponseClose();
        return;
      }
      log('final response complete', { quietMs: currentQuietMs, goodbyeHeard: true, audioDone });
      finalResponsePending = false;
      clearTimeout(finalResponseSafetyTimer);
      stop(0);
    }, Math.max(50, goodbyeTailMs - elapsedMs, goodbyeQuietMs - quietForMs));
    finalResponseTimer.unref();
    return;
  }
  const quietTargetMs = finalResponseSawGoodbye ? 1500 : 2500;
  const quietForMs = lastOutputAudioAt ? Date.now() - lastOutputAudioAt : 0;
  finalResponseTimer = setTimeout(() => {
    if (!finalResponsePending || closing) return;
    const currentQuietMs = lastOutputAudioAt ? Date.now() - lastOutputAudioAt : quietTargetMs;
    if (currentQuietMs < quietTargetMs || outputPlaying) {
      scheduleFinalResponseClose();
      return;
    }
    log('final response complete', { quietMs: currentQuietMs, goodbyeHeard: finalResponseSawGoodbye });
    finalResponsePending = false;
    clearTimeout(finalResponseSafetyTimer);
    stop(0);
  }, Math.max(50, quietTargetMs - quietForMs));
  finalResponseTimer.unref();
}
function armFinalResponseShutdown() {
  finalResponsePending = true;
  finalResponseSawGoodbye = false;
  finalResponseStartedAt = Date.now();
  finalResponseTranscript = '';
  finalResponseAudioDoneAt = null;
  finalGoodbyeAt = null;
  lastOutputAudioAt = null;
  clearTimeout(finalResponseSafetyTimer);
  finalResponseSafetyTimer = setTimeout(() => {
    if (!finalResponsePending || closing) return;
    log('final response safety timeout', { elapsedMs: Date.now() - finalResponseStartedAt, goodbyeHeard: finalResponseSawGoodbye });
    finalResponsePending = false;
    stop(0);
  }, 45000);
  finalResponseSafetyTimer.unref();
}
async function handleTranscript(text) {
  const clean = String(text || '').trim();
  if (!clean || selectionInProgress) return;
  turns += 1;
  log('caller utterance complete', { text: clean, outputPlaying, transcriptLatencyMs: Date.now() - lastInputActivityAt });
  if (callerRequestedTermination(clean)) {
    log('caller requested termination', { text: clean });
    if (outputPlaying) interruptLocalPlayback('caller requested termination');
    stop(0);
    return;
  }
  if (outputPlaying) interruptLocalPlayback('caller utterance');
  if (!offScript && offScriptTriggerPattern.test(clean)) {
    offScript = true;
    pendingNumber = null;
    awaitingConfirmation = false;
    log('VIP mode enabled', { trigger: clean });
    announce('The caller explicitly invoked the private off-script service. Acknowledge that briefly in period-appropriate language, then ask what music they would like. Do not mention software, tools, or technical details. Remain in VIP mode.');
    return;
  }
  if (offScript) {
    const request = offScriptRequestFromText(clean);
    if (request) {
      await processOffScriptRequest(request);
    } else {
      announce('The caller is in VIP mode but has not yet given a bounded request. Ask briefly whether they want an album, an artist, a playlist, a mix, or to know what is playing. Do not guess their request.');
    }
    return;
  }
  const candidate = numberFromText(clean);
  if (awaitingConfirmation && pendingNumber !== null) {
    if (candidate !== null && candidate !== pendingNumber) {
      pendingNumber = candidate;
      requestConfirmation(candidate);
    } else if (negative(clean)) {
      if (candidate !== null) pendingNumber = candidate;
      requestConfirmation(pendingNumber);
    } else if (affirmative(clean)) {
      clearTimeout(confirmationRetryTimer);
      confirmationRetryTimer = null;
      await submitSelection(pendingNumber);
    }
    else if (candidate !== null) {
      pendingNumber = candidate;
      requestConfirmation(candidate);
    }
    return;
  }
  if (candidate !== null) {
    pendingNumber = candidate; awaitingConfirmation = true;
    requestConfirmation(candidate);
  }
}
function queueTranscriptDelta(delta) {
  transcript += String(delta || '');
  clearTimeout(transcriptTimer);
  // Live documents input transcript deltas but does not expose a separate
  // input-transcript.done event. Use a generous quiet period so pauses inside
  // phrases such as “No, wait, 148” do not finalize the first fragment.
  transcriptTimer = setTimeout(() => {
    const complete = transcript;
    transcript = '';
    log('input transcript finalized locally', { text: complete.trim(), quietMs: 1200 });
    handleTranscript(complete).catch((error) => log('transcript handling error', { error: error.message }));
  }, 1200);
}
async function submitSelection(number) {
  selectionInProgress = true; awaitingConfirmation = false;
  const actionStarted = Date.now();
  try {
    const result = await post('/shyvers/response', {
      sessionId: callSession.sessionId,
      number,
      suppressSpeech: true,
      deferPlayback: true,
    });
    let outcome = result?.result && typeof result.result === 'object' ? result.result : result;
    log('deterministic selection result', { number, actionMs: Date.now() - actionStarted, outcome });
    voiceGain = heelsVoiceGain;
    log('voice softened for footsteps', { gain: heelsVoiceGain });
    try {
      await playEffect('footsteps');
    } finally {
      voiceGain = requestedVoiceGain;
      log('voice restored after footsteps');
    }
    if (outcome.playbackDeferred && Number.isInteger(Number(outcome.mpdSongId))) {
      const started = await post('/shyvers/start-song', {
        sessionId: callSession.sessionId,
        songId: Number(outcome.mpdSongId),
      });
      if (!started?.ok) throw new Error(started?.error || 'Now Playing did not start the deferred record');
      outcome = { ...outcome, playbackDeferred: false, playbackStarted: Boolean(started.playbackStarted ?? started.ok) };
      log('deferred playback started after footsteps', { number, songId: Number(outcome.mpdSongId), started });
    }
    const trackName = [outcome.title, outcome.artist].filter((value) => String(value || '').trim()).join(' by ');
    let finalInstruction = `The caller confirmed Multiphone number ${number}. The application completed that exact request. ${trackName ? `Say exactly the supplied song title and artist: “${trackName}”. ` : ''}`;
    if (outcome.queuedBehindJukebox) {
      const totalJukeboxRecords = Number(outcome.jukeboxQueueLength) || 1;
      const spinsAway = Math.max(1, totalJukeboxRecords - 1);
      finalInstruction += `Say that the record was added to the others waiting on your desk for Clem's Place and will be coming up in exactly ${spinsAway} spin${spinsAway === 1 ? '' : 's'} or so. Do not invent or change that number. `;
    } else if (outcome.playbackStarted) {
      finalInstruction += 'Say that the record started playing immediately. ';
    } else if (Number.isFinite(Number(outcome.queueLength))) {
      finalInstruction += `Say that it is in the queue at the supplied position, using only the application result: ${JSON.stringify(outcome)}. `;
    } else {
      finalInstruction += `Briefly summarize the supplied application result using only these facts: ${JSON.stringify(outcome)}. `;
    }
    finalInstruction += 'Deliver this as one compact, uninterrupted paragraph with brisk continuous speech: do not insert long pauses between the supplied facts or clauses. Add at most one brief, natural, period-appropriate reaction; reactions should not be overly energetic. Then give a brief, natural period-appropriate goodbye of your choice that clearly ends the call and includes “bye” or “goodbye.” Do not use the same fixed goodbye every time. Deliver the goodbye as an ordinary spoken sentence at the same volume, pitch, register, and pace as the preceding sentence—do not suddenly get louder, faster, more emphatic, or more animated, and do not treat the final goodbye words as a punchline or flourish. Pronounce every word fully; do not compress, clip, or rush the final words. Use a calm sentence ending, not exclamatory emphasis. Do not ask another question; this is the final response and end the call after speaking.';
    armFinalResponseShutdown();
    announce(finalInstruction);
  } catch (error) {
    log('selection error', { number, error: error.message });
    announce(`The application reported an error: ${error.message}. Apologize briefly, thank the caller, say goodbye, and end the call.`);
    setTimeout(() => stop(1), 5000).unref();
  }
}
async function restoreVolume() {
  await duckPromise;
  if (!duckResult.sent || !harmonyVolumeDeviceId) return;
  try { await harmony_press_many(harmonyVolumeDeviceId, 'VolumeUp', duckResult.sent, { client: harmonyClient, interPressMs: restoreInterPressMs }); log('volume restored', { sent: duckResult.sent, interPressMs: restoreInterPressMs }); }
  catch (error) { log('volume restore error', { error: error.message }); }
}
function finishShutdown(code = 0) {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = restoreVolume()
    .catch((error) => log('volume shutdown wait error', { error: error.message }))
    .then(() => cleanup())
    .catch((error) => log('cleanup error', { error: error.message }))
    .finally(() => {
      log('shutdown complete', { code });
      process.exit(code);
    });
  return shutdownPromise;
}
function handleEvent(event) {
  if (event.type === 'session.started') {
    session = event.session;
    liveStarted = true;
    liveStartedAt = Date.now();
  log('session started', { id: session.id, model: session.model, duplex, playbackMode, cleanPcmPath, voiceSpeed: voicePlaybackSpeed, gain: requestedVoiceGain, masterGainDb, outputDevice, telephoneEq });
    announce('Begin now. Say exactly one brief greeting: “Multiphone! Mabel here—hello to Clem’s Place. What number, please?” Then listen.');
  } else if (event.type === 'session.output_audio.delta') outputDelta(event.delta);
  else if (event.type === 'session.output_audio.done' || event.type === 'response.output_audio.done' || event.type === 'response.audio.done') {
    completedAudioResponses += 1;
    if (finalResponsePending) {
      finalResponseAudioDoneAt = Date.now();
      log('final response audio complete', { responseNumber: completedAudioResponses });
      scheduleFinalResponseClose();
    }
    if (!streamOutput) flushOutput();
    saveCapturedResponse(event.type);
  }
  else if (event.type === 'session.input_transcript.delta') queueTranscriptDelta(event.delta);
  else if (event.type === 'session.output_transcript.delta') {
    log('Mabel transcript delta', { delta: event.delta });
    if (finalResponsePending) finalResponseTranscript += String(event.delta || '');
    if (finalResponsePending && !finalResponseSawGoodbye && /\b(?:bye|goodbye)\b/i.test(finalResponseTranscript)) {
      finalResponseSawGoodbye = true;
      finalGoodbyeAt = Date.now();
      log('final goodbye heard', { delta: event.delta, transcript: finalResponseTranscript });
      scheduleFinalResponseClose();
    }
  }
  else if (event.type === 'session.closed') {
    const finalUsage = event.usage || {};
    Object.keys(usage).forEach((key) => { if (key in finalUsage) usage[key] = Number(finalUsage[key]) || 0; });
    log('session closed', {
      durationMs: Date.now() - startedAt,
      turns,
      interruptions,
      overlapMs,
      livePcmBytesReceived,
      processedPcmBytes: outputAudioBytes,
      avfoundationPcmBytesWritten: avfoundationAudioBytes,
      avfoundationHandoffFrames,
      avfoundationWriteCalls,
      avfoundationBackpressureCount,
      pcmInvariantViolations,
      gainOverflowSamples,
      resampleClampSamples,
      liveAudioGapCount,
      maxLiveAudioGapMs,
      usage,
      estimatedLiveCostUsd: Number(((Date.now() - startedAt) / 60000 * 0.05).toFixed(4)),
    });
    finishShutdown(0);
  } else if (event.type === 'error') log('Live API error', { error: event.error || event });
  else if (event.type === 'session.interruption' || event.type === 'response.interrupted') { interruptions += 1; log('interruption', { event }); }
  else if (!loggedEventTypes.has(event.type)) { loggedEventTypes.add(event.type); log('Live event type', { type: event.type }); }
}
async function start() {
  callSession = await post('/shyvers/call', { event: 'coin', station: "Clem's Place", suppressGreeting: true });
  const ringbackPromise = playEffect('ringback');
  startVolumeDucking();
  await ringbackPromise;
  startAmbience();
  ws = new WebSocket('wss://api.openai.com/v1/live/sessions', { headers: { Authorization: `Bearer ${apiKey}` } });
  ws.on('open', () => ws.send(JSON.stringify({ type: 'session.start', event_id: 'mabel_start', session: { model: 'gpt-live-1', instructions: `${persona}\n\n${styleGuide}\n\n${pacingAdjustment}\n\n${volumeDeliveryGuide}\n\n${voiceTimbreGuide}`, audio: { format: { type: 'audio/pcm', rate: 24000 }, output: { voice: 'sage' } }, delegation: { type: 'client' } } })));
  ws.on('message', (message) => { try { handleEvent(JSON.parse(message.toString())); } catch (error) { log('invalid Live event', { error: error.message }); } });
  ws.on('error', (error) => log('WebSocket error', { error: error.message }));
  ws.on('close', (code, reason) => { if (!closing) log('disconnect before session.closed', { code, reason: reason.toString() }); });
  recorder = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'avfoundation', '-i', input, '-ac', '1', '-ar', '24000', '-f', 's16le', '-'], { stdio: ['ignore', 'pipe', 'inherit'] });
  recorder.stdout.on('data', (chunk) => { const processed = processInputAudio(chunk); if (processed && liveStarted && ws.readyState === WebSocket.OPEN) { inputSentBytes += processed.length; ws.send(JSON.stringify({ type: 'session.input_audio.append', audio: processed.toString('base64') })); } });
  recorder.on('error', (error) => log('recorder error', { error: error.message }));
}
function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanedUp = true;
  if (shutdownTimer) clearTimeout(shutdownTimer);
  shutdownTimer = null;
  if (finalResponseTimer) clearTimeout(finalResponseTimer);
  if (finalResponseSafetyTimer) clearTimeout(finalResponseSafetyTimer);
  if (confirmationRetryTimer) clearTimeout(confirmationRetryTimer);
  if (responseFlushTimer) clearTimeout(responseFlushTimer);
  responseFlushTimer = null;
  if (responseMaxFlushTimer) clearTimeout(responseMaxFlushTimer);
  responseMaxFlushTimer = null;
  stopAmbience();
  if (recorder) recorder.kill('SIGTERM');
  clearTimeout(outputIdleTimer);
  if (outputStreamOpen) flushOutput();
  if (ws && ws.readyState < WebSocket.CLOSING) ws.close();
  const pendingPlayback = outputQueue;
  const pendingStreamDrain = drainStreamPlayer();
  cleanupPromise = Promise.all([pendingPlayback, pendingStreamDrain])
    .catch((error) => log('playback drain error', { error: error.message }))
    .then(() => playEffect('hangup'));
  return cleanupPromise;
}
function stop(code = 0) {
  if (closing) return; closing = true; clearTimeout(transcriptTimer); clearTimeout(outputIdleTimer);
  if (ws?.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ type: 'session.close', event_id: `mabel_close_${Date.now()}` })); shutdownTimer = setTimeout(() => { finishShutdown(code); }, 15000); shutdownTimer.unref(); }
  else finishShutdown(code);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop(0));
start().catch((error) => { log('startup error', { error: error.message }); finishShutdown(1); });
