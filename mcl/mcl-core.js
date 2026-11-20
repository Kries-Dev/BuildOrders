// MCL tournament logic — pure functions, no Firebase, no DOM.
// Used by mcl-admin.html. The output of publicView() is exactly what bracket.html reads.
//
// Admin state (stored at <season root>/admin):
//   settings: { season_name, groups: ['A','B',…], advance, playoff_size, group_bo, playoff_bo, final_bo,
//               points: { w_clean, w, l, l_clean }, admin_code }
//   teams:    { <id>: { name, clan_tag, clan_name, captain, group, code, order, players: [{ name, url, eligibility, guest_player }] } }
//   fixtures: { <id>: { group, round, t1, t2, score1, score2, vod_url, rec_urls: [] } }      (t1/t2 are team ids)
//   playoff:  { seeds: [teamId, …] | null, results: { UB1: { t1, t2, score1, score2, vod_url } } }

export const DEFAULT_SETTINGS = {
  season_name: 'Season II',
  groups: ['A', 'B', 'C', 'D'],
  advance: 2,
  playoff_size: 8,
  group_bo: 3,
  playoff_bo: 3,
  final_bo: 5,
  points: { w_clean: 3, w: 2, l: 1, l_clean: -1 },
  admin_code: '',
  round_names: {},   // custom playoff round names, keyed like "8_ub0" (bracket size _ section+round index)
};

export const emptyState = () => ({ settings: structuredClone(DEFAULT_SETTINGS), teams: {}, fixtures: {}, playoff: { seeds: null, results: {} } });

// Firebase drops empty arrays/objects and turns arrays into {0:…} objects. Put the shape back.
export function normalise(raw) {
  const s = emptyState();
  if (!raw) return s;
  s.settings = { ...s.settings, ...(raw.settings || {}), points: { ...s.settings.points, ...((raw.settings || {}).points || {}) } };
  s.settings.round_names = { ...((raw.settings || {}).round_names || {}) };
  s.settings.groups = arr(s.settings.groups);
  s.teams = raw.teams || {};
  for (const t of Object.values(s.teams)) t.players = arr(t.players);
  s.fixtures = raw.fixtures || {};
  for (const f of Object.values(s.fixtures)) f.rec_urls = arr(f.rec_urls);
  s.playoff = { seeds: raw.playoff?.seeds ? arr(raw.playoff.seeds) : null, results: raw.playoff?.results || {} };
  return s;
}
export const arr = (v) => (Array.isArray(v) ? v.filter((x) => x != null) : v && typeof v === 'object' ? Object.values(v) : []);

export const uid = (p = 't') => p + Math.random().toString(36).slice(2, 9);
export const BAD_KEY = /[.#$\[\]\/]/;
export const newCode = () => Array.from({ length: 6 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');

export const teamsInGroup = (s, g) => Object.entries(s.teams).filter(([, t]) => t.group === g).sort((a, b) => (a[1].order ?? 0) - (b[1].order ?? 0));
export const nameOf = (s, id) => (id === 'BYE' ? 'BYE' : s.teams[id]?.name || 'TBD');

// ── Group stage ───────────────────────────────────────────────────────────
// Round robin (circle method). Keeps results of fixtures that still exist.
export function generateGroupFixtures(s) {
  const keep = {};
  for (const [id, f] of Object.entries(s.fixtures)) keep[pairKey(f.t1, f.t2)] = { id, f };
  const out = {};
  for (const g of s.settings.groups) {
    const ids = teamsInGroup(s, g).map(([id]) => id);
    if (ids.length < 2) continue;
    const list = ids.length % 2 ? [...ids, null] : [...ids];
    const n = list.length;
    for (let r = 0; r < n - 1; r++) {
      for (let i = 0; i < n / 2; i++) {
        const a = list[i], b = list[n - 1 - i];
        if (!a || !b) continue;
        const [t1, t2] = r % 2 ? [b, a] : [a, b];
        const prev = keep[pairKey(t1, t2)];
        const round = `Round ${r + 1}`;
        if (prev && prev.f.group === g) out[prev.id] = { ...prev.f, group: g, round };
        else out[uid('f')] = { group: g, round, t1, t2, score1: null, score2: null, vod_url: '', rec_urls: [] };
      }
      list.splice(1, 0, list.pop());
    }
  }
  s.fixtures = out;
  return s;
}
const pairKey = (a, b) => [a, b].sort().join('|');
export const played = (f) => Number.isFinite(f.score1) && Number.isFinite(f.score2) && f.score1 !== f.score2;

export function standings(s, g) {
  const P = s.settings.points;
  const rows = teamsInGroup(s, g).map(([id, t]) => ({ id, name: t.name, wins: 0, losses: 0, pts: 0, gw: 0, gl: 0, played: 0 }));
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  const h2h = {};
  for (const f of Object.values(s.fixtures)) {
    if (f.group !== g || !played(f) || !by[f.t1] || !by[f.t2]) continue;
    const [w, l, ws, ls] = f.score1 > f.score2 ? [f.t1, f.t2, f.score1, f.score2] : [f.t2, f.t1, f.score2, f.score1];
    by[w].wins++; by[l].losses++; by[w].played++; by[l].played++;
    by[w].pts += ls === 0 ? P.w_clean : P.w;
    by[l].pts += ls === 0 ? P.l_clean : P.l;
    by[w].gw += ws; by[w].gl += ls; by[l].gw += ls; by[l].gl += ws;
    h2h[pairKey(w, l)] = w;
  }
  return rows.sort((a, b) => (b.pts - a.pts)
    || (h2h[pairKey(a.id, b.id)] === a.id ? -1 : h2h[pairKey(a.id, b.id)] === b.id ? 1 : 0)
    || ((b.wins - b.losses) - (a.wins - a.losses))
    || ((b.gw - b.gl) - (a.gw - a.gl))
    || b.wins - a.wins
    || a.name.localeCompare(b.name));
}

// Default playoff seeds: every group winner, then every runner-up, and so on.
export function defaultSeeds(s) {
  const tables = s.settings.groups.map((g) => standings(s, g));
  const seeds = [];
  for (let rank = 0; rank < s.settings.advance; rank++) for (const t of tables) if (t[rank]) seeds.push(t[rank].id);
  return seeds;
}
export const currentSeeds = (s) => {
  const auto = defaultSeeds(s);
  const manual = (s.playoff.seeds || []).filter((id) => s.teams[id]);
  return manual.length ? manual : auto;
};

// ── Playoffs: double elimination for 4 / 8 / 16 / 32 ────────────────────
// Match ids follow Season 1 (UB1…, LB1…, GF), so an 8-team bracket is laid out exactly as before.
export function bracketOrder(n) {
  let order = [1, 2];
  while (order.length < n) {
    const m = order.length * 2 + 1;
    order = order.flatMap((x) => [x, m - x]);
  }
  return order;
}

// Default round names (DoD's naming). Counted from the final backwards, so they fit any bracket size.
const UB_NAMES = ['Upper Final', 'Upper Semifinals', 'Upper Quarterfinals'];
const LB_NAMES = ['Lower Final', 'Lower Semifinals', 'Lower Quarterfinals'];
export const roundKey = (n, sec, i) => `${n}_${sec}${i}`;

export function bracketStructure(n, names = {}) {
  const k = Math.log2(n);
  if (!Number.isInteger(k) || k < 2) throw new Error('Playoff size must be 4, 8, 16 or 32');
  const ub = [], lb = [];
  let u = 0, l = 0;
  for (let r = 1; r <= k; r++) {
    const count = n / 2 ** r;
    const fromEnd = k - r;
    const label = UB_NAMES[fromEnd] || `Upper Round ${r}`;
    ub.push({ key: roundKey(n, 'ub', r - 1), default: label, label, ids: Array.from({ length: count }, () => `UB${++u}`) });
  }
  // Lower bracket
  const lr = [];
  lr.push(Array.from({ length: n / 4 }, (_, j) => ({ a: { loser: ub[0].ids[2 * j] }, b: { loser: ub[0].ids[2 * j + 1] } })));
  for (let r = 2; r <= k; r++) {
    const prev = lr[lr.length - 1];
    const ubr = ub[r - 1].ids;
    lr.push(ubr.map((_, j) => ({ a: { winnerOf: prev, j }, b: { loser: ubr[ubr.length - 1 - j] } })));
    if (r < k) {
      const drop = lr[lr.length - 1];
      lr.push(Array.from({ length: drop.length / 2 }, (_, j) => ({ a: { winnerOf: drop, j: 2 * j }, b: { winnerOf: drop, j: 2 * j + 1 } })));
    }
  }
  const src = {};
  ub.forEach((round, r) => round.ids.forEach((id, j) => {
    src[id] = r === 0 ? { a: { seed: bracketOrder(n)[2 * j] }, b: { seed: bracketOrder(n)[2 * j + 1] } }
      : { a: { winner: ub[r - 1].ids[2 * j] }, b: { winner: ub[r - 1].ids[2 * j + 1] } };
  }));
  lr.forEach((round, r) => {
    const ids = round.map(() => `LB${++l}`);
    round.forEach((m, j) => { m.id = ids[j]; });
    const label = LB_NAMES[lr.length - 1 - r] || `Lower Round ${r + 1}`;
    lb.push({ key: roundKey(n, 'lb', r), default: label, label, ids });
  });
  lr.forEach((round) => round.forEach((m) => {
    const res = (x) => (x.winnerOf ? { winner: x.winnerOf[x.j].id } : x);
    src[m.id] = { a: res(m.a), b: res(m.b) };
  }));
  src.GF = { a: { winner: ub[k - 1].ids[0] }, b: { winner: lb[lb.length - 1].ids[0] } };
  const gf = [{ key: roundKey(n, 'gf', 0), default: 'Grand Final', label: 'Grand Final', ids: ['GF'] }];
  for (const round of [...ub, ...lb, ...gf]) if (names[round.key]) round.label = names[round.key];
  return { ub, lb, gf, src };
}

// Resolve every match: who plays, the stored result (dropped if the teams have since changed), the winner.
export function resolveBracket(s) {
  const n = s.settings.playoff_size;
  const st = bracketStructure(n, s.settings.round_names || {});
  const seeds = currentSeeds(s);
  const out = {};
  const order = [...st.ub.flatMap((r) => r.ids), ...st.lb.flatMap((r) => r.ids), 'GF'];
  // Lower rounds depend on later upper rounds' losers, so resolve in passes until stable.
  for (let pass = 0; pass < 4; pass++) {
    for (const id of order) {
      const team = (x) => {
        // Nobody qualified yet: leave the bracket empty instead of filling it with byes.
        if (x.seed) return seeds.length ? (seeds[x.seed - 1] ?? 'BYE') : null;
        const m = out[x.winner || x.loser];
        if (!m || !m.winner) return null;
        return x.winner ? (m.winner === 1 ? m.t1 : m.t2) : (m.winner === 1 ? m.t2 : m.t1);
      };
      const t1 = team(st.src[id].a), t2 = team(st.src[id].b);
      const saved = s.playoff.results[id];
      const m = { id, t1, t2, score1: null, score2: null, vod_url: '', winner: 0 };
      if (t1 && t2) {
        if (t1 === 'BYE' || t2 === 'BYE') m.winner = t1 === 'BYE' ? (t2 === 'BYE' ? 1 : 2) : 1;
        else if (saved && saved.t1 === t1 && saved.t2 === t2) {
          // Keep half-entered scores too, so typing one side doesn't wipe it before the other is in.
          Object.assign(m, { score1: saved.score1 ?? null, score2: saved.score2 ?? null, vod_url: saved.vod_url || '' });
          if (played(saved)) m.winner = saved.score1 > saved.score2 ? 1 : 2;
        }
      }
      out[id] = m;
    }
  }
  return { structure: st, matches: out, seeds };
}

export const bestOf = (s, id) => (id === 'GF' ? s.settings.final_bo : id.startsWith('G') ? s.settings.group_bo : s.settings.playoff_bo);

// ── What the public bracket page reads ──────────────────────────────────
export function publicView(s) {
  const seeds = currentSeeds(s);
  const seedOf = Object.fromEntries(seeds.map((id, i) => [id, i + 1]));
  const groups = {};
  const groupLog = [];
  const records = [];
  for (const g of s.settings.groups) {
    groups[g] = standings(s, g).map((r) => ({ name: r.name, seed: seedOf[r.id] || 0, wins: r.wins, losses: r.losses, pts: r.pts }));
  }
  const fixtures = Object.values(s.fixtures).sort((a, b) => a.group.localeCompare(b.group) || a.round.localeCompare(b.round, undefined, { numeric: true }));
  for (const f of fixtures) {
    const t1 = nameOf(s, f.t1), t2 = nameOf(s, f.t2);
    if (played(f)) groupLog.push({ group: f.group, round: f.round, team1: t1, team2: t2, score1: f.score1, score2: f.score2 });
    records.push(clean({ round: f.round, group: f.group, team1: t1, team2: t2, score: played(f) ? `${f.score1}-${f.score2}` : '', vod_url: f.vod_url || '', rec_urls: f.rec_urls?.length ? f.rec_urls : null }));
  }
  const { structure, matches } = resolveBracket(s);
  const pub = {};
  const sections = [['upper', structure.ub], ['lower', structure.lb], ['grand', structure.gf]];
  for (const [section, rounds] of sections) {
    rounds.forEach((round, ri) => round.ids.forEach((id, order) => {
      const m = matches[id];
      const t1 = m.t1 ? nameOf(s, m.t1) : 'TBD', t2 = m.t2 ? nameOf(s, m.t2) : 'TBD';
      const bye = m.t1 === 'BYE' || m.t2 === 'BYE';   // walkovers: no score, no winner highlight
      const final = m.winner && !bye;
      pub[id] = clean({ id, label: id, section, round: round.label, round_index: ri, order,
        team1: t1, team2: t2, score1: final ? m.score1 : '', score2: final ? m.score2 : '', winner: final ? m.winner : 0,
        seed1: seedOf[m.t1] || '', seed2: seedOf[m.t2] || '', vod_url: m.vod_url || '' });
      if (m.t1 && m.t2 && m.t1 !== 'BYE' && m.t2 !== 'BYE') {
        records.push(clean({ round: `Playoffs · ${round.label}`, group: '', team1: t1, team2: t2,
          score: m.winner ? `${m.score1}-${m.score2}` : '', vod_url: m.vod_url || '', rec_urls: null }));
      }
    }));
  }
  const roster = {}, codes = {};
  for (const t of Object.values(s.teams).sort((a, b) => a.name.localeCompare(b.name))) {
    roster[t.name] = { clan_tag: t.clan_tag || '', clan_name: t.clan_name || '', team: t.name, captain: t.captain || '', players: t.players || [] };
    if (t.code) codes[t.name] = t.code;
  }
  return {
    settings: { season_name: s.settings.season_name, advance_per_group: s.settings.advance, playoff_size: s.settings.playoff_size,
      points: s.settings.points, group_bo: s.settings.group_bo, playoff_bo: s.settings.playoff_bo, final_bo: s.settings.final_bo },
    groups, group_match_log: groupLog, game_records: records, matches: pub, roster, team_codes: codes,
    admin_code: s.settings.admin_code || '',
  };
}
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));

// Parse rows pasted from Excel / Google Sheets: one row per player.
// Columns: Clan Tag | Clan Name | Team | Team Captain | Player Name | AoM Profile | Eligibility | Guest Player
// A header row is skipped automatically. Returns [{ name, clan_tag, clan_name, captain, players: [...] }].
export function parseRosterPaste(text) {
  const rows = text.split(/\r?\n/).map((l) => l.split('\t').map((c) => c.trim())).filter((r) => r.some(Boolean));
  if (rows.length && /clan|team|player/i.test(rows[0].join(' '))) rows.shift();
  const teams = new Map();
  for (const [clan_tag = '', clan_name = '', team = '', captain = '', player = '', url = '', eligibility = '', guest = ''] of rows) {
    const name = team || clan_name || clan_tag;
    if (!name) continue;
    if (!teams.has(name)) teams.set(name, { name, clan_tag, clan_name, captain, players: [] });
    const t = teams.get(name);
    if (captain && !t.captain) t.captain = captain;
    if (player) t.players.push({ name: player, url, eligibility, guest_player: guest });
  }
  return [...teams.values()];
}
