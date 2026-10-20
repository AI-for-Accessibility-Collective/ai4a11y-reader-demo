// The ONE port this app implements: a KVStore over localStorage.
//
// The toolkit core never touches storage, the clock, or the DOM itself; a host
// hands it ports (see @ai4a11y/toolkit/ports). KVStore is three async methods
// over named "areas" (the Chrome extension maps them to chrome.storage.local
// and .sync; here they are just key prefixes). That's the whole contract.

export function localStorageKV({ prefix = 'ai4a11y' } = {}) {
  const k = (area, key) => `${prefix}:${area}:${key}`;
  return {
    async get(area, key) {
      const raw = localStorage.getItem(k(area, key));
      return raw === null ? undefined : JSON.parse(raw);
    },
    async set(area, key, value) {
      if (value === undefined) localStorage.removeItem(k(area, key));
      else localStorage.setItem(k(area, key), JSON.stringify(value));
    },
    async getAll(area) {
      const head = `${prefix}:${area}:`;
      const out = {};
      for (let i = 0; i < localStorage.length; i++) {
        const name = localStorage.key(i);
        if (name.startsWith(head)) out[name.slice(head.length)] = JSON.parse(localStorage.getItem(name));
      }
      return out;
    },
  };
}
