/**
 * Runs in the page's MAIN world, before YouTube's own scripts.
 *
 * This is the layer that actually stops in-stream video ads. Network blocking
 * cannot: ads stream from the same googlevideo.com hosts as the video. What
 * works is what uBlock Origin and Brave do — strip the ad descriptors out of
 * YouTube's player response before the player reads them, so as far as the
 * player is concerned the video simply has no ads scheduled.
 *
 * Equivalent to uBO's:
 *   json-prune-fetch-response playerAds adPlacements adSlots
 *   set-constant ytInitialPlayerResponse.adPlacements undefined
 */
(() => {
  if (window.__miruAds) return;
  const state = { pruned: 0, keys: {} };
  window.__miruAds = state;

  const AD_KEYS = [
    'adPlacements',
    'playerAds',
    'adSlots',
    'adBreakHeartbeatParams',
    'importantForAds',
  ];

  function pruneNode(obj) {
    for (const k of AD_KEYS) {
      if (Object.prototype.hasOwnProperty.call(obj, k)) {
        delete obj[k];
        state.pruned += 1;
        state.keys[k] = (state.keys[k] || 0) + 1;
      }
    }
  }

  // Depth-capped: YouTube parses a lot of JSON and this sits on a hot path.
  function prune(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 4) return obj;
    if (Array.isArray(obj)) {
      if (depth < 4) for (const v of obj) prune(v, depth + 1);
      return obj;
    }
    pruneNode(obj);
    for (const key in obj) {
      const v = obj[key];
      if (v && typeof v === 'object') prune(v, depth + 1);
    }
    return obj;
  }

  // 1. Any JSON.parse — covers the initial page payload.
  const origParse = JSON.parse;
  JSON.parse = function (text, reviver) {
    return prune(origParse.call(this, text, reviver), 0);
  };

  // 2. fetch().json() — covers /youtubei/v1/player on SPA navigation.
  const origJson = Response.prototype.json;
  Response.prototype.json = function () {
    return origJson.call(this).then((data) => prune(data, 0));
  };

  // 3. The global the first page load assigns directly.
  let ypr;
  try {
    Object.defineProperty(window, 'ytInitialPlayerResponse', {
      configurable: true,
      enumerable: true,
      get: () => ypr,
      set: (v) => { ypr = prune(v, 0); },
    });
  } catch { /* already defined by a faster script; JSON.parse hook still covers it */ }
})();
