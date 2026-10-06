import matcher from '../shared/match.cjs';
import { getRules, getSettings, cacheGet, cacheSet } from './store.js';

const { classify } = matcher;

export const CATEGORIES = ['gaming', 'comedy', 'reaction', 'drama', 'clickbait', 'music', 'news', 'educational', 'tech', 'other'];

const keyOf = (v) => `${(v.channel || '').toLowerCase()}|${(v.title || '').toLowerCase()}`.slice(0, 300);

let inFlight = 0;
const queue = [];

/**
 * Resolve a batch of videos the heuristics had no opinion on.
 * Returns a map of key -> category. Anything we can't resolve is simply
 * absent, and an absent verdict means "show it" — this never hides on a guess.
 */
export async function resolveUnknown(videos) {
  const out = {};
  const settings = getSettings();
  const pending = [];

  for (const v of videos) {
    const k = keyOf(v);
    const hit = cacheGet(k);
    if (hit !== undefined) out[k] = hit;
    else pending.push({ key: k, video: v });
  }

  if (!pending.length || !settings.llm?.enabled) return out;

  const results = await Promise.all(pending.map((p) => schedule(() => askModel(p.video, settings))));
  pending.forEach((p, i) => {
    const cat = results[i];
    if (cat) {
      cacheSet(p.key, cat);
      out[p.key] = cat;
    }
  });
  return out;
}

function schedule(fn) {
  const max = getSettings().llm?.maxConcurrent ?? 2;
  return new Promise((resolve) => {
    const run = async () => {
      inFlight += 1;
      try {
        resolve(await fn());
      } catch {
        resolve(null);
      } finally {
        inFlight -= 1;
        const next = queue.shift();
        if (next) next();
      }
    };
    if (inFlight < max) run();
    else queue.push(run);
  });
}

const PROMPT = `You label YouTube videos by topic. Reply with exactly one word from this list and nothing else:
${CATEGORIES.join(', ')}

Use "gaming" for video games, "comedy" for humour/memes/pranks, "reaction" for reaction or watch-along videos, "drama" for creator drama/callouts, "clickbait" for stunt/challenge bait. Use "other" if unsure.`;

async function askModel(video, settings) {
  const { endpoint, model, timeoutMs } = settings.llm;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs ?? 12000);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: ctl.signal,
      body: JSON.stringify({
        model: model || 'local',
        temperature: 0,
        max_tokens: 8,
        messages: [
          { role: 'system', content: PROMPT },
          { role: 'user', content: `Title: ${video.title}\nChannel: ${video.channel || 'unknown'}` },
        ],
      }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const raw = (json.choices?.[0]?.message?.content || '').toLowerCase().trim();
    return CATEGORIES.find((c) => raw.includes(c)) || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function probeLLM() {
  const s = getSettings();
  if (!s.llm?.endpoint) return { ok: false, reason: 'no endpoint' };
  const base = s.llm.endpoint.replace(/\/v1\/.*$/, '/v1/models');
  try {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 2500);
    const res = await fetch(base, { signal: ctl.signal });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const json = await res.json();
    return { ok: true, models: (json.data || []).map((m) => m.id) };
  } catch (err) {
    return { ok: false, reason: err.name === 'AbortError' ? 'timeout' : err.message };
  }
}

export function heuristic(video) {
  const s = getSettings();
  return classify(getRules(), video, { focus: s.focus, hideShorts: s.hideShorts });
}
