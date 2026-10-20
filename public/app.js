// Reader — the whole app, in the order a host uses the toolkit.
//
//   1. Create the toolkit over the ports this host provides.
//   2. Keep the person's NEEDS in the toolkit's profile (the source of truth).
//   3. Render the profile into web settings, and apply them with the catalog.
//   4. Understand what the person says (a model, behind the server).
//   5. Voice in, voice out.
//
// Read it top to bottom; README.md walks the same steps.

// ── 1. The toolkit, over this host's ports ───────────────────────────────────
// The core is pure JavaScript: it runs in the browser as-is. It reaches the
// platform only through the ports you hand it. We write ONE (storage); the
// clock and scheduler are the toolkit's reference implementations, which use
// nothing but setTimeout/Date.now and so work here too. Consent is a no-op:
// this app never proposes profile changes behind the person's back.
import { createToolkit } from '/vendor/toolkit/index.js';
import { nodeClock, nodeScheduler } from '/vendor/toolkit/platforms/node/ports.js';
import { noopConsent } from '/vendor/toolkit/ports/index.js';
import { renderWebSettings } from '/vendor/toolkit/surfaces/web.js';
import { localStorageKV } from './ports/local-storage-kv.js';

const { datastore, librarian } = createToolkit({
  kv: localStorageKV(),
  clock: nodeClock(),
  scheduler: nodeScheduler(),
  consent: noopConsent,
});
await datastore.runMigrations();

// ── 2. The profile: needs, not settings ──────────────────────────────────────
// A need is device-independent: "text 1.4× normal", "dark theme", "dyslexia
// font". The profile holds needs; every surface (web, mobile, XR) renders them
// its own way. This page never stores a font size.
async function currentNeeds() {
  return (await librarian.getAbilityModel()).needs || [];
}

// Merge a change into the needs list. `value: null` removes a need.
function mergeNeeds(existing, changes, source) {
  const byDim = new Map(existing.map((n) => [n.dimension, n]));
  for (const c of changes) {
    if (c.value === null) byDim.delete(c.dimension);
    else byDim.set(c.dimension, { dimension: c.dimension, value: c.value, strength: 'preference', source });
  }
  return [...byDim.values()];
}

const history = []; // previous needs lists, for undo
async function setNeeds(needs, { remember = true } = {}) {
  if (remember) history.push(await currentNeeds());
  await librarian.setProfileField('fields.needs', needs);
  await render();
}

// ── 3. Render the profile → web settings → the page ──────────────────────────
// renderWebSettings is a pure function from the AbilityModel to the web
// settings vocabulary ({ fontScale: 140, darkMode: true, ... }). The catalog
// adapters are the code that makes those settings true on a page.
import { VisualAssist } from '/vendor/tools/adapters/visual-assist.js';
import { DarkMode } from '/vendor/tools/adapters/dark-mode.js';
import { ReadAloud } from '/vendor/tools/adapters/read-aloud.js';

function applyWebSettings(web) {
  VisualAssist.enable({
    fontScale: web.fontScale ?? 100,       // percent; the adapter accepts 140 or 1.4
    lineHeight: web.lineHeight ?? 1.5,
    dyslexiaFont: !!web.dyslexiaFont,
  });
  if (web.darkMode) DarkMode.enable();
  else if (DarkMode.enabled) DarkMode.disable();
  ReadAloud.setRate(web.speechRate ?? 1.0);
}

async function render() {
  const model = await librarian.getAbilityModel();
  const web = renderWebSettings(model);
  applyWebSettings(web);
  showProfile(model, web);
}

function showProfile(model, web) {
  const areas = (model.supportAreas || []).join(', ');
  const needs = (model.needs || []).map((n) => `${n.dimension} ${n.value}`).join(' · ');
  const settings = Object.entries(web).map(([k, v]) => `${k}=${v}`).join(' ');
  document.getElementById('profile').textContent = needs
    ? `Profile${areas ? ` (${areas})` : ''}: ${needs}  →  ${settings}`
    : 'Profile: nothing yet — tell me what you need.';
}

// ── 4. Understanding: one sentence → one action ──────────────────────────────
// The server asks Gemini to turn the sentence into one JSON action using the
// toolkit's need vocabulary (so the model says "textSize 1.4", never a CSS
// value), validates it, and returns it. The browser never holds the key.
async function understand(text) {
  const current = (await currentNeeds()).map((n) => ({ dimension: n.dimension, value: n.value }));
  const r = await fetch('/api/understand', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, current }),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || 'understand failed');
  return body; // { type, say, needs?, supportAreas? }
}

const articleText = () => document.getElementById('article').innerText;

async function act(action) {
  switch (action.type) {
    case 'profile': {
      if (action.supportAreas?.length) await librarian.setProfileField('supportAreas', action.supportAreas);
      await setNeeds(mergeNeeds(await currentNeeds(), action.needs, 'onboarding'));
      break;
    }
    case 'adjust':
      await setNeeds(mergeNeeds(await currentNeeds(), action.needs, 'user'));
      break;
    case 'read':
      stopSpeaking();
      ReadAloud.speak(articleText());
      return action.say; // don't talk over the reading
    case 'stop':
      stopSpeaking();
      break;
    case 'undo':
      if (history.length) await setNeeds(history.pop(), { remember: false });
      else return 'Nothing to undo.';
      break;
    case 'reset':
      await librarian.setProfileField('supportAreas', []);
      await setNeeds([]);
      break;
    default: // 'none'
      break;
  }
  return action.say;
}

// ── 5. Voice in, voice out ───────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
let busy = false;

async function handle(text) {
  const t = String(text || '').trim();
  if (!t || busy) return;
  busy = true;
  say('…', { speak: false });
  try {
    const reply = await act(await understand(t));
    say(reply || 'Done.');
  } catch (e) {
    say('Sorry — ' + e.message);
  } finally {
    busy = false;
  }
}

function say(text, { speak = true } = {}) {
  $('reply').textContent = text;           // the live region announces it
  if (speak && $('tts').checked && 'speechSynthesis' in window) {
    speechSynthesis.cancel();
    speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  }
}

function stopSpeaking() {
  ReadAloud.stop();
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}

$('ask').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('text').value;
  $('text').value = '';
  handle(text);
});

// Dictation through the Web Speech API, where the browser has it. Starting the
// mic silences playback first so it doesn't transcribe the page reading itself.
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (!Recognition) {
  $('mic').disabled = true;
  $('mic').title = 'Speech recognition is not available in this browser';
} else {
  const recog = new Recognition();
  recog.lang = navigator.language || 'en-US';
  recog.interimResults = false;
  let listening = false;
  const setMic = (on) => { listening = on; $('mic').setAttribute('aria-pressed', String(on)); };
  recog.onresult = (ev) => { $('text').value = ev.results[0][0].transcript; };
  recog.onend = () => { setMic(false); if ($('text').value) { const t = $('text').value; $('text').value = ''; handle(t); } };
  recog.onerror = () => setMic(false);
  $('mic').addEventListener('click', () => {
    if (listening) { recog.stop(); return; }
    stopSpeaking();
    try { recog.start(); setMic(true); } catch { /* already started */ }
  });
}

// Boot: whatever the profile already holds is applied before the first word.
await render();
window.reader = { librarian, handle, currentNeeds }; // for poking at it in the console
