'use strict';
/**
 * Heuristic video classifier, shared verbatim between the main process and the
 * YouTube preload so both sides always agree on a verdict.
 *
 * classify() -> { verdict: 'block' | 'allow' | 'unknown', category, score }
 *   'unknown' means no rule had an opinion; that's the only case worth paying
 *   the local LLM for.
 */

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Word-ish boundary that also works for tokens starting/ending with punctuation
// (e.g. "#shorts"), which \b cannot handle.
const boundedAlt = (words) =>
  new RegExp('(?<![a-z0-9])(?:' + words.map(escapeRe).join('|') + ')(?![a-z0-9])', 'gi');

const safeRe = (src, flags) => {
  try {
    return new RegExp(src, flags);
  } catch {
    return null;
  }
};

const COMPILED = new WeakMap();

function compileRules(rules) {
  let c = COMPILED.get(rules);
  if (c) return c;

  c = { categories: {}, rescue: null, blockSet: new Set(), allowSet: new Set() };

  for (const [name, def] of Object.entries(rules.categories || {})) {
    c.categories[name] = {
      weight: def.weight ?? 1,
      words: def.words?.length ? boundedAlt(def.words) : null,
      channelWords: def.channelWords?.length ? boundedAlt(def.channelWords) : null,
      patterns: (def.patterns || []).map((p) => safeRe(p, 'i')).filter(Boolean),
    };
  }

  const rescueWords = rules.rescue?.words || [];
  c.rescue = {
    weight: rules.rescue?.weight ?? 3,
    words: rescueWords.length ? boundedAlt(rescueWords) : null,
  };

  for (const ch of rules.channels?.block || []) c.blockSet.add(ch.trim().toLowerCase());
  for (const ch of rules.channels?.allow || []) c.allowSet.add(ch.trim().toLowerCase());

  COMPILED.set(rules, c);
  return c;
}

const countMatches = (re, text) => {
  if (!re || !text) return 0;
  re.lastIndex = 0;
  const m = text.match(re);
  return m ? m.length : 0;
};

function classify(rules, video, opts = {}) {
  const c = compileRules(rules);
  const title = (video.title || '').toLowerCase();
  const channel = (video.channel || '').toLowerCase().trim();
  const focus = rules.focus || {};
  const threshold = focus.threshold ?? 2;
  const minVotes = focus.channelMinVotes ?? 2;
  const reputation = channel ? (rules.channelReputation || {})[channel] : null;
  // YouTube's own label for the channel, looked up once and cached. Authoritative
  // where we have it — this is what "known for" actually means.
  const ytCategory = reputation?.yt ? (focus.ytCategoryMap || {})[reputation.yt] : null;

  if (channel && c.allowSet.has(channel)) return { verdict: 'allow', category: 'channel-allow', score: 0, learn: null };
  if (channel && c.blockSet.has(channel)) return { verdict: 'block', category: 'channel-block', score: 99, learn: null };

  // Shorts are killed independently of Focus mode — they're a format, not a topic.
  if (video.isShort || (rules.focus?.hideShortsAlways && countMatches(c.categories.shorts?.words, title))) {
    if (opts.hideShorts !== false) return { verdict: 'block', category: 'shorts', score: 99, learn: null };
  }

  const rescueScore = countMatches(c.rescue.words, title) * c.rescue.weight;

  let best = null;
  let bestScore = 0;
  let anySignal = false;
  // Tracked separately from `best`: what the title/channel words alone say. Only
  // this may teach a channel its category, so reputation can never feed itself.
  let kwBest = null;
  let kwBestScore = 0;

  for (const name of focus.blockCategories || []) {
    const def = c.categories[name];
    if (!def) continue;
    let hits = countMatches(def.words, title);
    for (const p of def.patterns) if (p.test(title)) hits += 1;
    const chHits = countMatches(def.channelWords, channel);
    const kwScore = (hits + chHits) * def.weight;
    // A channel we've already identified counts as one extra keyword hit: enough
    // to trip the threshold on a keyword-free title, still beatable by a rescue
    // word, so a gaming channel's genuine tutorial survives.
    const known = ytCategory === name || (reputation && (reputation[name] || 0) >= minVotes);
    const repHit = known ? 1 : 0;
    const score = (hits + chHits + repHit) * def.weight;
    if (score > 0) anySignal = true;
    if (kwScore > kwBestScore) {
      kwBestScore = kwScore;
      kwBest = name;
    }
    if (score > bestScore) {
      bestScore = score;
      best = name;
    }
  }

  const learn = kwBest && kwBestScore - rescueScore >= threshold ? kwBest : null;

  // Focus off: nothing is filtered, but keep reporting what the keywords proved
  // so the channel map still builds while browsing in Open mode.
  if (!opts.focus) return { verdict: 'allow', category: null, score: 0, learn };

  const net = bestScore - rescueScore;
  if (net >= threshold) return { verdict: 'block', category: best, score: net, learn };
  if (!anySignal && rescueScore === 0) return { verdict: 'unknown', category: null, score: 0, learn };
  return { verdict: 'allow', category: best, score: net, learn };
}

module.exports = { classify, compileRules, escapeRe };
