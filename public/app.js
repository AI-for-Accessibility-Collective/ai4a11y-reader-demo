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
//
// The article text goes along too, so a question about it ("what is this
// about?", "what does the last paragraph say?") is answered from the page —
// for a person who can't see it, that is the page. The server fences it as
// content, not instructions.
const articleText = () => document.getElementById('article').innerText;

async function understand(text) {
  const current = (await currentNeeds()).map((n) => ({ dimension: n.dimension, value: n.value }));
  const r = await fetch('/api/understand', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, current, article: articleText() }),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || 'understand failed');
  return body; // { type, say, needs?, supportAreas? }
}

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
    case 'answer':
      break; // the answer is in `say`
    case 'read':
      readFrom(action.from, { only: action.only });
      return { say: action.say, speak: false }; // the live region gets it; TTS would cancel the reading
    case 'pause':
      if (!ReadAloud.speaking) return 'Nothing is being read.';
      ReadAloud.pause();
      return { say: action.say, speak: false }; // speaking it would cancel the paused reading
    case 'resume':
      if (!ReadAloud.paused) return 'Nothing is paused.';
      ReadAloud.resume();
      return { say: action.say, speak: false };
    case 'stop':
      stopSpeaking();
      break;
    case 'help':
      return HELP;
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

// ── Reading aloud, a paragraph at a time ─────────────────────────────────────
// A person who can't see the page navigates it by ear: "read the next
// paragraph", "read from the third paragraph", "read that again". So the
// article is read one block at a time (title, then each paragraph), with a
// cursor, chaining to the next block when one ends unless asked for one only.
// The block being read is marked for anyone who can see a little.
const blocks = () => [...document.querySelectorAll('#article h1, #article p')].filter((el) => el.innerText.trim());
let cursor = -1;      // index into blocks() of the block last read
let reading = null;   // token for the current chain; a new chain or stop() invalidates it

function markReading(i) {
  blocks().forEach((el, j) => el.classList.toggle('reading', j === i));
}

function resolveFrom(from) {
  const n = blocks().length;
  if (typeof from === 'number') return Math.min(n - 1, from); // 1 = first paragraph; the title is 0
  switch (from) {
    case 'next': return Math.min(n - 1, cursor + 1);
    case 'previous': return Math.max(0, cursor - 1);
    case 'current': return Math.max(0, cursor);
    case 'last': return n - 1;
    default: return 0; // 'start', 'title'
  }
}

function readFrom(from = 'start', { only = false } = {}) {
  const els = blocks();
  if (!els.length) return;
  stopSpeaking();
  const token = (reading = {});
  const step = (k) => {
    if (reading !== token) return;
    if (k >= els.length) { reading = null; markReading(-1); return; }
    cursor = k;
    markReading(k);
    ReadAloud.speak(els[k].innerText);
    const u = ReadAloud.utterance;
    if (!u) { reading = null; markReading(-1); return; }
    u.onend = () => {
      ReadAloud.speaking = false;
      if (reading !== token) return;
      if (only) { reading = null; markReading(-1); } else step(k + 1);
    };
  };
  step(resolveFrom(from));
}

const HELP = 'This is an article you can read your way. Tell me what you need, by typing or by pressing Speak: '
  + 'bigger text, more space between lines, dark mode, a dyslexia font, or describe yourself, like I have low vision. '
  + 'Say read this to hear the article, read the next paragraph, read from the third paragraph, pause, or stop. '
  + 'Ask about it: what is this article about, or what does the last paragraph say. Say undo, or start over.';

// ── 5. Voice in, voice out ───────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
let busy = false;

async function handle(text) {
  const t = String(text || '').trim();
  if (!t || busy) return;
  busy = true;
  say('…', { speak: false });
  try {
    // act() returns the reply, or { say, speak: false } when speaking it would
    // cancel the reading it just started.
    const r = await act(await understand(t));
    const reply = (r && typeof r === 'object') ? r : { say: r, speak: true };
    say(reply.say || 'Done.', { speak: reply.speak });
  } catch (e) {
    say('Sorry — ' + e.message);
  } finally {
    busy = false;
  }
}

function say(text, { speak = true } = {}) {
  $('reply').textContent = text;           // the live region announces it
  if (speak && $('tts').checked && 'speechSynthesis' in window) {
    stopSpeaking();                        // a spoken reply ends any reading in progress
    speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  }
}

function stopSpeaking() {
  reading = null;
  markReading(-1);
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
// Then say what this page can do — in the live region, so a screen reader
// reads it, and aloud where the browser lets a page speak before any click —
// and put the keyboard in the input.
await render();
say(HELP);
$('text').focus();
window.reader = { librarian, handle, currentNeeds, readFrom, get cursor() { return cursor; } }; // for poking at it in the console
