# Reader: learn the AI for Accessibility Toolkit in ten minutes

This is a one-page reading app that adapts itself to the person reading it.
You tell it what you need, in your own words: "bigger text", "I'm dyslexic",
"it's too bright", "read the next paragraph", "what is this article about?"
The page changes, and it remembers you next time.

It is also the smallest complete example of an app built on the
[AI for Accessibility Toolkit](https://github.com/AI-for-Accessibility-Collective/AI-for-Accessibility-Toolkit).
This README is a tutorial: read it top to bottom with
[`public/app.js`](public/app.js) open beside it, and you will know how to use
the toolkit in your own app.

> The toolkit is a pre-alpha research project. Its adapters are not
> validated, and nothing here replaces assistive technology.

## Run it first

You need Node 20.12+ and a Gemini API key
([aistudio.google.com/apikey](https://aistudio.google.com/apikey)).

```bash
npm install
cp .env.example .env     # put GEMINI_API_KEY=... in it
npm start                # open http://127.0.0.1:5173/
```

Type "make the text bigger", then "I'm dyslexic", then reload the page. It
comes back adapted. Keep it open; the steps below ask you to try things in
the browser console.

## The idea in one sentence

**The toolkit keeps a profile of what a person *needs*; your app renders that
profile into settings for its own surface and applies them with adapters.**

```
  "bigger text"            profile                 settings                 the page
  "I'm dyslexic"   ──▶   needs[]           ──▶   { fontScale: 120,   ──▶   adapters
  (what they say)        textSize 1.2            dyslexiaFont: true }      change the DOM
                         dyslexiaFont true
                     Librarian (toolkit)     renderWebSettings (toolkit)   catalog (toolkit)
```

Three things to know, and the three steps that follow teach one each:

- **The profile holds needs, not settings.** A need is device-independent:
  "text 1.2× normal", not `font-size: 21px`. The same profile renders on the
  web, a phone, or a headset. Your app never stores a font size.
- **The Librarian is the one object you talk to.** It is the only thing that
  writes the profile. You read the profile back as an **AbilityModel**.
- **Adapters are the catalog of fixes.** Each one makes one setting true on a
  page: `VisualAssist` scales text, `DarkMode` darkens, `ReadAloud` speaks.
  You pick the ones your surface needs.

## Step 1: create the toolkit over your ports (2 minutes)

The toolkit core is plain JavaScript with no platform code in it. It never
touches storage, the clock, or the DOM directly; it reaches them through
**ports** you hand it. That is why it runs unchanged in a browser, in Node,
or in a native shell.

```js
import { createToolkit } from '/vendor/toolkit/index.js';
import { nodeClock, nodeScheduler } from '/vendor/toolkit/platforms/node/ports.js';
import { noopConsent } from '/vendor/toolkit/ports/index.js';
import { localStorageKV } from './ports/local-storage-kv.js';

const { datastore, librarian } = createToolkit({
  kv: localStorageKV(),       // the one port this app writes
  clock: nodeClock(),         // the toolkit's reference clock (Date.now)
  scheduler: nodeScheduler(), // the toolkit's reference scheduler (setTimeout)
  consent: noopConsent,       // this app never proposes changes on its own
});
await datastore.runMigrations();
```

The only port this app implements is storage,
[`public/ports/local-storage-kv.js`](public/ports/local-storage-kv.js): three
async methods (`get`, `set`, `getAll`) over `localStorage`, 29 lines. That is
the whole contract. A Chrome extension maps the same three methods to
`chrome.storage`; a phone app maps them to its own store.

**Try it.** In the console, `reader.librarian` is the Librarian. Run
`await reader.librarian.getAbilityModel()` and look at the shape: that is the
profile you will be writing to.

## Step 2: write a need into the profile (3 minutes)

A need is `{ dimension, value, strength, source }`. The dimensions are a small
shared vocabulary (`textSize`, `lineSpacing`, `darkTheme`, `dyslexiaFont`,
`readAloudRate`, and more); the value is a magnitude in the person's terms.

```js
await librarian.setProfileField('fields.needs', [
  { dimension: 'textSize', value: 1.4, strength: 'preference', source: 'user' },
]);
```

That one call is all the app does to change what the person gets. It
replaces the whole list, so the app keeps the list and merges each change
into it (`mergeNeeds` in `app.js`), and pushes the previous list on a stack
so "undo" is one pop.

**Try it.** In the console:

```js
await reader.librarian.setProfileField('fields.needs', [
  { dimension: 'darkTheme', value: true, strength: 'preference', source: 'console' },
]);
location.reload();
```

The page comes back dark. Nothing in the app said "dark"; the profile did,
and the next step rendered it.

## Step 3: render the profile and apply it with adapters (3 minutes)

`renderWebSettings` is a pure function from the AbilityModel to the **web
settings vocabulary**, the names the catalog's adapters understand:

```js
import { renderWebSettings } from '/vendor/toolkit/surfaces/web.js';

const model = await librarian.getAbilityModel();   // { supportAreas, needs, ... }
const web   = renderWebSettings(model);            // { fontScale: 140, darkMode: true, ... }
```

`textSize 1.4` became `fontScale: 140`; `darkTheme: true` became
`darkMode: true`. There is a renderer per surface (`surfaces/web.js`,
`surfaces/xr.js`); your app calls the one for its platform.

Then the adapters make those settings true on the page. This is the entire
apply step of the app:

```js
import { VisualAssist } from '/vendor/tools/adapters/visual-assist.js';
import { DarkMode } from '/vendor/tools/adapters/dark-mode.js';
import { ReadAloud } from '/vendor/tools/adapters/read-aloud.js';

function applyWebSettings(web) {
  VisualAssist.enable({
    fontScale: web.fontScale ?? 100,
    lineHeight: web.lineHeight ?? 1.5,
    dyslexiaFont: !!web.dyslexiaFont,
  });
  if (web.darkMode) DarkMode.enable();
  else if (DarkMode.enabled) DarkMode.disable();
  ReadAloud.setRate(web.speechRate ?? 1.0);
}
```

Most adapters have the same shape, `enable(options)` and `disable()`, and
each reverses what it did. The catalog has about fifty (reading ruler, bionic
reading, focus highlighting, captions, landmarks, ...). You do not write
fixes; you choose which ones your surface needs and feed them settings.

`render()` in `app.js` is just those two calls in a row, and it runs once at
boot, so whatever the profile already holds is applied before the first word.

**That is the whole toolkit loop**: write a need, read the model, render it,
apply it. Everything that follows is this app's own user interface.

## Step 4: let people say it in their own words (1 minute)

Needs have to come from somewhere. This app asks a model. [`server.js`](server.js)
holds the Gemini key and answers one question, `POST /api/understand`: *what
does this sentence ask for?* The prompt offers the model the five need
dimensions above, the current needs, and the article text, and asks for one
JSON action: `adjust`, `profile` ("I'm dyslexic" → support areas and the
needs that usually follow), `answer` (a question about the article),
`read`, `pause`, `resume`, `stop`, `undo`, `reset`, `help`, or `none`.

Two things make it reliable. The vocabulary is small and in the person's
terms, so the model is accurate. And the server validates the answer
(unknown dimensions dropped, numbers clamped to range) before the browser
writes it through the Librarian. The article goes in fenced as content to
answer from, never instructions to follow.

You could replace this step with a settings panel, a form, or the toolkit's
own Controller (a grammar plus an optional model, with a remote protocol for
driving other apps). The profile and the adapters would not change.

## Step 5: voice in, voice out (1 minute)

Dictation is the Web Speech API's `SpeechRecognition` into the same text
field; replies land in an ARIA live region (so a screen reader announces
them) and are spoken with `speechSynthesis` when "Speak replies" is on. "Read
this" uses the `ReadAloud` adapter one paragraph at a time with a cursor, so
someone who can't see the page can move through it by ear: "read the next
paragraph", "read from the third paragraph", "pause", "continue". When the
page opens it says what it can do.

## Where things are

```
public/app.js                      the app: steps 1–5, in that order, under 300 lines
public/ports/local-storage-kv.js   the one port this app implements
public/index.html                  the article and the one input
server.js                          the Gemini key and /api/understand; serves the page (zero dependencies)
vendor/*.tgz                       @ai4a11y/toolkit and @ai4a11y/tools, packed (not on npm yet)
scripts/vendor.sh                  re-pack them from a toolkit checkout; vendor/PIN.txt records the commit
```

## Do it in your own app

1. Pack the two packages from a toolkit checkout (`npm run vendor` here shows
   how) and depend on them by path, as [`package.json`](package.json) does.
2. Implement `KVStore` for your platform; borrow the clock and scheduler.
3. `createToolkit(...)`, then `setProfileField('fields.needs', ...)` from
   wherever your needs come from.
4. `renderWebSettings(await librarian.getAbilityModel())`, and feed the
   result to the adapters your surface uses.

Next reads: the toolkit's [QUICKSTART](https://github.com/AI-for-Accessibility-Collective/AI-for-Accessibility-Toolkit/blob/main/docs/QUICKSTART.md),
its [API](https://github.com/AI-for-Accessibility-Collective/AI-for-Accessibility-Toolkit/blob/main/toolkit/API.md),
and [using it in your project](https://github.com/AI-for-Accessibility-Collective/AI-for-Accessibility-Toolkit/blob/main/docs/using-in-your-project.md).

## About

A project of the [AI for Accessibility Collective](https://github.com/AI-for-Accessibility-Collective),
licensed under [Apache 2.0](LICENSE) like the toolkit itself. Contributions
follow the [code of conduct](CODE_OF_CONDUCT.md).
