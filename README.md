# Reader — the smallest complete host of the AI for Accessibility Toolkit

A one-page reading app that adapts itself to the person. You tell it what
you need, in your own words, by typing or speaking — "bigger text", "I'm
dyslexic", "it's too bright", "read this" — and the page changes. It
remembers next time.

It exists to show, in about 200 lines, how an app uses the
[AI for Accessibility Toolkit](https://github.com/AI-for-Accessibility-Collective/AI-for-Accessibility-Toolkit):
the toolkit keeps a **profile of the person's needs**; the app renders that
profile into **settings for its own surface** and applies them with the
toolkit's **catalog of adapters**. The app never stores a font size.

> Status: a demo of a pre-alpha research toolkit. The adapters are not
> validated and this is not a replacement for assistive technology.

## Run it

You need Node 20.12+ and a Gemini API key
([aistudio.google.com/apikey](https://aistudio.google.com/apikey)).

```bash
npm install
cp .env.example .env     # put GEMINI_API_KEY=... in it
npm start                # http://127.0.0.1:5173/
```

Then type (or press 🎤 and say) things like:

| You say | What happens |
|---|---|
| "could you make the text a bit bigger" | need `textSize 1.2` → `fontScale 120` |
| "bigger" | relative to the current need → `textSize 1.44` |
| "I'm dyslexic" | support area `reading`; needs `dyslexiaFont`, `lineSpacing 1.8` |
| "it's too bright in here" | need `darkTheme` → `darkMode` |
| "read this to me" | the article is read aloud |
| "what is this article about?" | answered from the article text |
| "what does the last paragraph say?" | answered from the article text |
| "does it mention Spotify?" | "The article doesn't say." |
| "go back to how it was" | undo the last change |
| "forget everything and start over" | profile cleared |
| "tell me about dark matter" | nothing changes (it mentions dark, it doesn't ask for it) |

Reload the page: it comes back adapted, because the profile lives in the
browser's storage through the toolkit.

## How it is built — the tutorial

The whole app is [`public/app.js`](public/app.js), written top to bottom in
the order a host uses the toolkit. Read it alongside this.

### 1. Create the toolkit over your ports

The toolkit core is plain JavaScript with no platform code in it. It reaches
storage, the clock and the scheduler only through **ports** the host hands
it. This app implements one, [`public/ports/local-storage-kv.js`](public/ports/local-storage-kv.js):
three async methods over `localStorage`. The clock and scheduler are the
toolkit's reference implementations (they use nothing but `Date.now` and
`setTimeout`, so they run in a browser). Consent is the no-op, because this
app never proposes a profile change on its own.

```js
const { datastore, librarian } = createToolkit({
  kv: localStorageKV(), clock: nodeClock(), scheduler: nodeScheduler(), consent: noopConsent,
});
await datastore.runMigrations();
```

The **Librarian** is the one object you talk to. It is the only writer to the
person's profile.

### 2. Keep needs, not settings

The profile holds **needs**: device-independent magnitudes like
`{ dimension: 'textSize', value: 1.4 }` or `{ dimension: 'darkTheme', value: true }`.
A need says what the person needs; it says nothing about CSS, fonts or
pixels, so the same profile renders on the web, on a phone, or in a headset.

```js
await librarian.setProfileField('fields.needs', [
  { dimension: 'textSize', value: 1.4, strength: 'preference', source: 'user' },
]);
```

`app.js` keeps the whole list and rewrites it on every change (`mergeNeeds`),
and keeps the previous lists on a stack for undo.

### 3. Render the profile, apply it with the catalog

`renderWebSettings(model)` is a pure function from the profile's
**AbilityModel** to the web settings vocabulary:

```js
const model = await librarian.getAbilityModel();   // { supportAreas, needs, ... }
const web   = renderWebSettings(model);            // { fontScale: 140, darkMode: true, ... }
```

The settings are made true on the page by **adapters** from `@ai4a11y/tools`:
`VisualAssist` (font scale, line height, dyslexia font), `DarkMode`,
`ReadAloud`. That is `applyWebSettings()` — a dozen lines. Each adapter is
one fix; the app chooses which ones its surface needs.

### 4. Understand what the person said

[`server.js`](server.js) holds the Gemini key and answers one question,
`POST /api/understand`: *what does this sentence ask for?* The prompt offers
the model the **need vocabulary** from step 2 (five dimensions, with their
ranges), the current needs, and the article text, and asks for one JSON
action: `adjust`, `profile`, `answer`, `read`, `stop`, `undo`, `reset` or
`none`.

Two things make this reliable. The vocabulary is small and in the person's
terms ("text 1.4× normal"), not CSS, so the model is accurate; and the server
**validates** the answer — unknown dimensions dropped, numbers clamped to
range — before the browser applies it through the toolkit, which validates
again.

The article goes in for one reason: a person who can't see the page needs
"what is this about?", "what does the third paragraph say?", "does it
mention dyslexia?" answered from the text. It is fenced in the prompt as
content to answer from, never instructions to follow, and capped in length.
An `answer` is spoken like any other reply.

### 5. Voice in, voice out

The Web Speech API, where the browser has it: `SpeechRecognition` dictates
into the same text field (starting the mic first silences playback so it
doesn't transcribe the page reading itself); replies land in an ARIA live
region (so a screen reader announces them) and are spoken with
`speechSynthesis` when "Speak replies" is on. "Read this" uses the
`ReadAloud` adapter on the article text.

## Layout

```
server.js                     the key, /api/understand, static files   (zero dependencies)
public/index.html             the article and the one input
public/app.js                 the app: steps 1–5 above
public/ports/local-storage-kv.js   the one port this host implements
vendor/*.tgz                  the two toolkit packages, packed (not on npm yet)
scripts/vendor.sh             re-pack them from a toolkit checkout
```

## Updating the toolkit

The packages are not on npm yet, so they are vendored as tarballs
(`npm pack` from the toolkit repository, see its
`docs/using-in-your-project.md`). With a checkout of the toolkit next to this
folder:

```bash
npm run vendor     # or TOOLKIT_DIR=/path/to/toolkit npm run vendor
```

`vendor/PIN.txt` records the toolkit commit the tarballs came from.

## About

A project of the [AI for Accessibility Collective](https://github.com/AI-for-Accessibility-Collective),
licensed under [Apache 2.0](LICENSE) like the toolkit itself. Contributions
follow the [code of conduct](CODE_OF_CONDUCT.md).

## What to try next

- Add a need: give the model `letterSpacing` in `server.js`'s `DIMENSIONS`,
  and nothing else changes — `renderWebSettings` already maps it and
  `VisualAssist` already applies it.
- Add an adapter: `ReadingRuler` from the catalog, for a `readingGuide` need.
- Swap the port: write a `KVStore` over `fetch` to your own backend, and the
  profile roams.
- Replace the understanding step with the toolkit's Controller
  (`controller/` in the toolkit repository), which adds a deterministic
  grammar, an LLM lane, confirmation flows and a remote `ControlPort` for
  driving other apps.
