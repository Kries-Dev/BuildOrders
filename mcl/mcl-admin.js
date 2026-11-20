// MCL Control — admin app for the Mythic Clan League.
// Season N lives at Firebase node mcl_sN (Season 1 stays at "tournament", untouched).
// Every edit saves straight away: the admin state goes to mcl_sN/admin, and the public data that
// bracket.html?season=N reads (groups, matches, roster, game records…) is recomputed and written next to it.
// Captain-written data (availability, scheduled_games, audit_log) is never overwritten.
//
// ?season=3   manage another season      ?demo   try everything without Firebase (saved in this browser only)
import * as C from './mcl-core.js?v=202611201930';

const FIREBASE = {
  apiKey: 'AIzaSyBxXo4fibhtI5cU7ozHETq_hPPya32FlSE',
  authDomain: 'bracket-4b8cc.firebaseapp.com',
  databaseURL: 'https://bracket-4b8cc-default-rtdb.europe-west1.firebasedatabase.app',
  projectId: 'bracket-4b8cc',
  storageBucket: 'bracket-4b8cc.firebasestorage.app',
  messagingSenderId: '671390867584',
  appId: '1:671390867584:web:c49a6f97076f98edb8c665',
};
const SDK = 'https://www.gstatic.com/firebasejs/10.12.0';

const params = new URLSearchParams(location.search);
const SEASON = params.get('season') || '2';
const ROOT = `mcl_s${SEASON}`;
const DEMO = params.has('demo');
const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ── Data store: Firebase, or this browser's storage in demo mode ────────────
async function firebaseStore() {
  const [{ initializeApp }, D, A] = await Promise.all([
    import(`${SDK}/firebase-app.js`), import(`${SDK}/firebase-database.js`), import(`${SDK}/firebase-auth.js`)]);
  const app = initializeApp(FIREBASE);
  const db = D.getDatabase(app), auth = A.getAuth(app);
  return {
    onUser: (cb) => A.onAuthStateChanged(auth, cb),
    signIn: () => A.signInWithPopup(auth, new A.GoogleAuthProvider()),
    signInEmail: (email, pw) => A.signInWithEmailAndPassword(auth, email, pw),
    createEmail: (email, pw) => A.createUserWithEmailAndPassword(auth, email, pw),
    resetPassword: (email) => A.sendPasswordResetEmail(auth, email),
    signOut: () => A.signOut(auth),
    isAdmin: (u) => D.get(D.ref(db, `admins/${u.uid}`)).then((s) => s.val() === true).catch(() => false),
    onData: (cb, onErr) => D.onValue(D.ref(db, ROOT), (s) => cb(s.val()), onErr),
    write: (obj) => D.update(D.ref(db, ROOT), obj),
  };
}
function demoStore() {
  const KEY = `mcl-demo-${ROOT}`;
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch { return null; } };
  let data = load();
  if (!data) { data = demoSeason(); try { localStorage.setItem(KEY, JSON.stringify(data)); } catch {} }
  let listener = null;
  const user = { uid: 'demo', email: 'demo mode', displayName: 'Demo' };
  return {
    onUser: (cb) => setTimeout(() => cb(user)),
    signIn: async () => {}, signOut: async () => { localStorage.removeItem(KEY); location.reload(); },
    isAdmin: async () => true,
    onData: (cb) => { listener = cb; setTimeout(() => cb(structuredClone(data))); },
    write: async (obj) => {
      data = { ...data, ...JSON.parse(JSON.stringify(obj)) };
      try { localStorage.setItem(KEY, JSON.stringify(data)); } catch {}
      window.__mclDemoData = data;           // handy for checking what bracket.html would read
    },
  };
}
function demoSeason() {
  const s = C.emptyState();
  const clans = [['DoD', 'Deities of Death'], ['CBB', 'CBB'], ['UCA', 'UCA'], ['KeeN', 'KeeN'], ['KanT', 'KanT'], ['GDM', 'GDM'], ['LFX', 'Légion Fénix'], ['ITC', 'ITC']];
  let i = 0;
  for (const [tag, clan] of clans) for (const suffix of ['A', 'B']) {
    const id = C.uid();
    s.teams[id] = { name: `${tag} ${suffix}`, clan_tag: tag, clan_name: clan, captain: `${tag}_Captain${suffix}`, group: s.settings.groups[i % 4], order: i, code: C.newCode(),
      players: [1, 2, 3, 4].map((n) => ({ name: `${tag}_Player${suffix}${n}`, url: '', eligibility: 'Yes', guest_player: 'No' })) };
    i++;
  }
  s.settings.admin_code = C.newCode();
  C.generateGroupFixtures(s);
  return { admin: JSON.parse(JSON.stringify(s)), ...C.publicView(s) };
}

// ── App state ────────────────────────────────────────────────────────────────
let store, user = null, state = C.emptyState(), upcoming = [], remote = {};
let tab = (location.hash || '#overview').slice(1);
let dirty = false, saveTimer = null, loaded = false;

const TABS = [
  ['overview', 'Overview'], ['settings', 'Settings'], ['teams', 'Teams'], ['groups', 'Groups'],
  ['results', 'Group results'], ['playoffs', 'Playoffs'], ['upcoming', 'Upcoming games'],
];

function setPill(kind, text) {
  const p = $('#save-pill');
  p.className = `pill ${kind}`;
  p.querySelector('span').textContent = text;
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 2600);
}

// Every change goes through here: update state, redraw, save shortly after.
function change(fn, { now = false } = {}) {
  fn(state);
  dirty = true;
  render();
  clearTimeout(saveTimer);
  setPill('busy', 'Saving…');
  saveTimer = setTimeout(save, now ? 0 : 450);
}
async function save() {
  const payload = JSON.parse(JSON.stringify({ admin: state, ...C.publicView(state) }));
  try {
    await store.write(payload);
    dirty = false;
    setPill('ok', `Saved ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
  } catch (e) {
    setPill('err', 'Not saved');
    showDenied(e);
  }
}
async function saveUpcoming() {
  setPill('busy', 'Saving…');
  try { await store.write({ upcoming: JSON.parse(JSON.stringify(upcoming)) }); setPill('ok', 'Saved'); }
  catch (e) { setPill('err', 'Not saved'); showDenied(e); }
}
function showDenied(e) {
  const denied = /permission/i.test(String(e?.code || e?.message));
  $('#main').insertAdjacentHTML('afterbegin', `<div class="notice err"><b>${denied ? 'Firebase refused the save.' : 'Saving failed.'}</b>
    ${denied ? 'Your account is not an admin in the database rules yet — see the Setup steps on the Overview tab.' : esc(e?.message || e)}</div>`);
}

// ── Boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  $('#season-label').textContent = `Season ${SEASON}${DEMO ? ' · demo' : ''}`;
  $('#public-link').href = `bracket.html?season=${SEASON}`;
  if (SEASON === '1') { gate('<h2>Season 1 is archived</h2><p class="muted">Season 1 stays as it was. Open MCL Control for Season 2 or later.</p><a class="btn primary" href="?season=2">Open Season 2</a>'); return; }
  try { store = DEMO ? demoStore() : await firebaseStore(); }
  catch (e) { gate(`<h2>Could not load Firebase</h2><p class="muted">${esc(e.message)}</p><a class="btn" href="?demo">Try the demo instead</a>`); return; }
  store.onUser(async (u) => {
    user = u;
    renderUser();
    if (!u) {
      gate(`<img src="mcl/mcl-logo.webp" alt="Mythic Clan League" onerror="this.remove()"><h2>MCL Control</h2>
        <p class="muted">Sign in with the Google or email account that is listed as an MCL admin.</p>
        <button class="btn primary" data-act="signin">Sign in with Google</button>
        <div class="row" style="width:100%;gap:12px;color:var(--dim);font-size:13px"><span style="flex:1;height:1px;background:var(--line)"></span>or with email<span style="flex:1;height:1px;background:var(--line)"></span></div>
        <form id="auth-form" class="stack" style="--gap:10px;width:100%;text-align:left" novalidate>
          <label class="f">Email<input type="email" id="auth-email" autocomplete="username" required></label>
          <label class="f">Password<input type="password" id="auth-pw" autocomplete="current-password" required minlength="6"></label>
          <p class="dim" id="auth-msg" role="status" style="min-height:1.2em;margin:0"></p>
          <div class="row" style="justify-content:space-between">
            <button class="btn" type="submit">Sign in</button>
            <span class="row" style="gap:4px"><button class="btn ghost sm" type="button" data-act="email-create">Create account</button><button class="btn ghost sm" type="button" data-act="email-reset">Forgot password?</button></span>
          </div>
        </form>
        <a class="dim" href="?demo">Or try it in demo mode (nothing is published)</a>`);
      setPill('', 'Signed out');
      return;
    }
    const ok = await store.isAdmin(u);
    if (!ok) { gate(notAdminHtml(u)); setPill('err', 'Not an admin'); return; }
    store.onData((val) => {
      remote = val || {};
      upcoming = C.arr(remote.upcoming);
      if (!dirty) state = C.normalise(remote.admin);
      if (!loaded) { loaded = true; setPill('ok', val ? 'Live' : 'New season'); }
      render();
    }, (err) => { setPill('err', 'Offline'); gate(`<h2>No access to the data</h2><p class="muted">${esc(err.message)}</p>`); });
  });
}
function gate(html) { $('#tabs').hidden = true; $('#main').innerHTML = `<div class="gate"><div class="card">${html}</div></div>`; }
function notAdminHtml(u) {
  return `<h2>Almost there</h2>
    <p class="muted">You're signed in as <b>${esc(u.email)}</b>, but this account isn't an MCL admin yet.</p>
    <p class="muted">In the Firebase console, open <b>Realtime Database → Data</b>, add a node <span class="code">admins</span> and under it a child with this key and the value <span class="code">true</span>:</p>
    <div class="row"><input type="text" readonly value="${esc(u.uid)}" id="uid-box" style="width:320px"><button class="btn sm" data-act="copy-uid">Copy</button></div>
    <p class="dim">Then reload this page.</p>
    <button class="btn ghost sm" data-act="signout">Sign out</button>`;
}
function renderUser() {
  $('#user').innerHTML = user ? `<span>${esc(user.email || user.displayName)}</span><button class="btn sm ghost" data-act="signout">${DEMO ? 'Reset demo' : 'Sign out'}</button>` : '';
}

// ── Render ───────────────────────────────────────────────────────────────────
function render() {
  if (!loaded) return;
  const counts = { teams: Object.keys(state.teams).length, results: `${Object.values(state.fixtures).filter(C.played).length}/${Object.keys(state.fixtures).length}`, upcoming: upcoming.length };
  const nav = $('#tabs');
  nav.hidden = false;
  nav.innerHTML = TABS.map(([id, label]) => `<button role="tab" data-tab="${id}" aria-selected="${tab === id}">${label}${counts[id] != null ? `<span class="n">${counts[id]}</span>` : ''}</button>`).join('');
  const views = { overview, settings, teams, groups, results, playoffs, upcomingView };
  const keepScroll = window.scrollY;
  const focusId = document.activeElement?.id;
  $('#main').innerHTML = (views[tab] || (tab === 'upcoming' ? upcomingView : overview))();
  window.scrollTo(0, keepScroll);
  if (focusId) document.getElementById(focusId)?.focus();
}
const slugify = (name) => name.toLowerCase().trim().replace(/\s+[a-z]$/i, '').replace(/\s+\d+$/, '').replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
const logo = (name) => (name && name !== 'TBD' && name !== 'BYE')
  ? `<img class="logo" src="Logos/${slugify(name)}.png" alt="" loading="lazy" onerror="if(!this.dataset.j){this.dataset.j=1;this.src=this.src.replace('.png','.jpg')}else{this.style.visibility='hidden'}">` : '<span class="logo"></span>';
const teamLabel = (name) => `<span class="team">${logo(name)}<span>${esc(name)}</span></span>`;

function overview() {
  const nTeams = Object.keys(state.teams).length;
  const unassigned = Object.values(state.teams).filter((t) => !state.settings.groups.includes(t.group)).length;
  const fx = Object.values(state.fixtures), playedFx = fx.filter(C.played).length;
  const { matches } = resolveSafe();
  const gf = matches.GF;
  const champId = gf?.winner ? (gf.winner === 1 ? gf.t1 : gf.t2) : null;
  const champ = champId && champId !== 'BYE' ? C.nameOf(state, champId) : null;
  const real = Object.values(matches).filter((m) => m.t1 && m.t2 && m.t1 !== 'BYE' && m.t2 !== 'BYE');
  const decided = real.filter((m) => m.winner).length;
  const step = (done, title, text, go) => `<div class="step${done ? ' done' : ''}"><div><b>${title}</b><span class="muted">${text}</span></div><button class="btn sm" data-goto="${go}">Open</button></div>`;
  const s = state.settings;
  return `<div class="head"><div><h1>Mythic Clan League · ${esc(s.season_name)}</h1>
      <p class="lead">${s.groups.length} groups · top ${s.advance} advance · ${s.playoff_size}-team double-elimination playoffs. Every change is live on the public bracket within a second.</p></div></div>
    ${champ ? `<div class="notice"><b>Champion: ${esc(champ)}</b></div>` : ''}
    <div class="steps">
      ${step(nTeams > 0, 'Add teams and rosters', nTeams ? `${nTeams} teams, ${Object.values(state.teams).reduce((n, t) => n + t.players.length, 0)} players` : 'Paste them from your sign-up sheet', 'teams')}
      ${step(nTeams > 0 && unassigned === 0, 'Put teams in groups', !nTeams ? `${s.groups.length} groups set up, no teams yet` : unassigned ? `${unassigned} teams not in a group yet` : `${s.groups.length} groups ready`, 'groups')}
      ${step(fx.length > 0, 'Create the group fixtures', fx.length ? `${fx.length} games` : 'One click on the Groups tab', 'groups')}
      ${step(fx.length > 0 && playedFx === fx.length, 'Enter group results', `${playedFx} of ${fx.length} played`, 'results')}
      ${step(!!champ, 'Run the playoffs', real.length ? `${decided} of ${real.length} matches ready to play decided` : 'Starts when the group stage is done', 'playoffs')}
    </div>
    <div class="grid" style="--min:320px;margin-top:24px">
      <div class="card stack" style="--gap:10px"><h3>Captain access</h3>
        <p class="muted">Captains log in on the public bracket's Scheduling tab with their team code (Teams tab). The admin code below gives the scheduling admin view there.</p>
        <div class="row"><span class="dim">Admin code</span><span class="code">${esc(s.admin_code) || '—'}</span><button class="btn sm" data-act="new-admin-code">${s.admin_code ? 'New code' : 'Create code'}</button></div></div>
      <div class="card stack" style="--gap:10px"><h3>Public page</h3>
        <p class="muted">Share <a href="bracket.html?season=${SEASON}" target="_blank" rel="noopener">bracket.html?season=${SEASON}</a>. The DoD website's MCL Season II tab can embed the same address.</p>
        <p class="dim">Data node: <span class="code">${ROOT}</span>${DEMO ? ' (demo: stored in this browser only)' : ''}</p></div>
    </div>`;
}
function resolveSafe() { try { return C.resolveBracket(state); } catch { return { matches: {}, structure: null, seeds: [] }; } }

function settings() {
  const s = state.settings;
  const num = (id, label, val, min, max, hint = '') => `<label class="f">${label}<input type="number" id="${id}" data-set="${id}" value="${val}" min="${min}" max="${max}">${hint ? `<span class="dim">${hint}</span>` : ''}</label>`;
  return `<div class="head"><div><h1>Settings</h1><p class="lead">Format of this season. Changing the playoff size or the number of groups keeps all entered results where they still apply.</p></div></div>
  <div class="grid" style="--min:280px">
    <div class="card stack"><h3>Season</h3>
      <label class="f">Season name<input type="text" id="season_name" data-set="season_name" value="${esc(s.season_name)}"></label>
      ${num('group_count', 'Number of groups', s.groups.length, 1, 8, 'Groups are named A, B, C…')}
      ${num('advance', 'Teams that advance per group', s.advance, 1, 8)}
      <label class="f">Playoff bracket size<select id="playoff_size" data-set="playoff_size">${[4, 8, 16, 32].map((n) => `<option ${n === s.playoff_size ? 'selected' : ''}>${n}</option>`).join('')}</select>
        <span class="dim">${s.groups.length * s.advance} teams qualify. ${s.groups.length * s.advance > s.playoff_size ? '<b style="color:var(--red-text)">More than the bracket holds — only the top seeds get in.</b>' : s.groups.length * s.advance < s.playoff_size ? `${s.playoff_size - s.groups.length * s.advance} byes go to the top seeds.` : 'Every slot filled.'}</span></label>
    </div>
    <div class="card stack"><h3>Best of</h3>
      ${num('group_bo', 'Group games', s.group_bo, 1, 9)}${num('playoff_bo', 'Playoff games', s.playoff_bo, 1, 9)}${num('final_bo', 'Grand Final', s.final_bo, 1, 9)}
    </div>
${roundNamesCard()}
    <div class="card stack"><h3>Group points</h3>
      ${num('p_w_clean', 'Win without dropping a game (2-0)', s.points.w_clean, -9, 9)}
      ${num('p_w', 'Win after dropping a game (2-1)', s.points.w, -9, 9)}
      ${num('p_l', 'Loss with a game won (1-2)', s.points.l, -9, 9)}
      ${num('p_l_clean', 'Loss without a game won (0-2)', s.points.l_clean, -9, 9)}
      <span class="dim">Ties: points, head-to-head, match difference, game difference, wins.</span>
    </div>
  </div>`;
}

function roundNamesCard() {
  let st;
  try { st = C.bracketStructure(state.settings.playoff_size, state.settings.round_names); } catch { return ''; }
  const row = (r) => `<label class="f">${esc(r.default)}<input type="text" id="rn-${r.key}" data-round="${r.key}" value="${esc(state.settings.round_names[r.key] || '')}" placeholder="${esc(r.default)}"></label>`;
  return `<div class="card stack"><h3>Round names</h3>
    <span class="dim">Names for the ${state.settings.playoff_size}-team bracket, shown on the public page and in the game records. Leave a box empty to use the name in grey.</span>
    <span class="dim" style="text-transform:uppercase;letter-spacing:.06em">Upper bracket</span>${st.ub.map(row).join('')}
    <span class="dim" style="text-transform:uppercase;letter-spacing:.06em">Lower bracket</span>${st.lb.map(row).join('')}
    ${st.gf.map(row).join('')}</div>`;
}

function teams() {
  const list = Object.entries(state.teams).sort((a, b) => a[1].name.localeCompare(b[1].name));
  return `<div class="head"><div><h1>Teams</h1><p class="lead">Add teams one by one, or paste your sign-up sheet. Team logos come from the <span class="code">Logos</span> folder, named after the clan (e.g. <span class="code">cbb.png</span>).</p></div>
    <div class="row"><button class="btn" data-act="paste">Paste from spreadsheet</button><button class="btn" data-act="codes">Create missing team codes</button><button class="btn primary" data-act="add-team">Add team</button></div></div>
  ${list.length ? `<div class="card tight scroll"><table>
    <thead><tr><th>Team</th><th>Clan</th><th>Captain</th><th class="num">Players</th><th>Group</th><th>Team code</th><th></th></tr></thead><tbody>
    ${list.map(([id, t]) => `<tr><td>${teamLabel(t.name)}</td><td><span class="tag">${esc(t.clan_tag)}</span> ${esc(t.clan_name)}</td><td>${esc(t.captain)}</td>
      <td class="num">${t.players.length}</td><td>${t.group ? `<span class="tag red">${esc(t.group)}</span>` : '<span class="dim">—</span>'}</td>
      <td class="code">${esc(t.code) || '<span class="dim">—</span>'}</td>
      <td style="text-align:right;white-space:nowrap"><button class="btn sm" data-act="edit-team" data-id="${id}">Edit</button></td></tr>`).join('')}
    </tbody></table></div>`
    : `<div class="card"><p class="muted">No teams yet. Use <b>Paste from spreadsheet</b> to bring in the whole sign-up list at once: one row per player with the columns Clan Tag, Clan Name, Team, Team Captain, Player Name, AoM Profile, Eligibility, Guest Player.</p></div>`}`;
}

function groups() {
  const s = state.settings;
  const hasResults = Object.values(state.fixtures).some(C.played);
  const col = (g) => {
    const ids = g ? C.teamsInGroup(state, g) : Object.entries(state.teams).filter(([, t]) => !s.groups.includes(t.group));
    const opts = (cur) => `<option value="">No group</option>${s.groups.map((x) => `<option ${x === cur ? 'selected' : ''}>${x}</option>`).join('')}`;
    return `<div class="gcol ${g ? '' : 'unassigned'}"><header><h3>${g ? `Group ${g}` : 'Not in a group'}</h3><span class="dim">${ids.length} teams</span></header><ol>
      ${ids.map(([id, t], i) => `<li>${teamLabel(t.name)}
        ${g ? `<button class="btn sm ghost" title="Move up" data-act="up" data-id="${id}" ${i ? '' : 'disabled'}>↑</button>` : ''}
        <select data-move="${id}" aria-label="Group for ${esc(t.name)}">${opts(t.group)}</select></li>`).join('') || '<li class="dim" style="background:none">Empty</li>'}
    </ol></div>`;
  };
  const table = (g) => {
    const rows = C.standings(state, g);
    return `<div class="card tight"><div style="padding:12px 16px;border-bottom:1px solid var(--line)"><h3>Group ${g}</h3></div><table>
      <thead><tr><th>#</th><th>Team</th><th class="num">P</th><th class="num">W</th><th class="num">L</th><th class="num">Games</th><th class="num">Pts</th></tr></thead><tbody>
      ${rows.map((r, i) => `<tr class="${i < s.advance ? 'qual' : ''}"><td class="num">${i + 1}</td><td>${teamLabel(r.name)}</td><td class="num">${r.played}</td><td class="num">${r.wins}</td><td class="num">${r.losses}</td><td class="num">${r.gw}-${r.gl}</td><td class="num"><b>${r.pts}</b></td></tr>`).join('')}
      </tbody></table></div>`;
  };
  return `<div class="head"><div><h1>Groups</h1><p class="lead">Move teams between groups, then create the fixtures: every team plays every other team in its group once.</p></div>
    <div class="row"><button class="btn" data-act="snake">Spread teams evenly</button><button class="btn primary" data-act="fixtures">${Object.keys(state.fixtures).length ? 'Update fixtures' : 'Create fixtures'}</button></div></div>
    ${hasResults ? '<p class="dim" style="margin:-8px 0 16px">Updating fixtures keeps every result whose two teams are still in the same group.</p>' : ''}
    <div class="grid" style="--min:250px">${s.groups.map(col).join('')}${Object.values(state.teams).some((t) => !s.groups.includes(t.group)) ? col(null) : ''}</div>
    <h2 style="margin:36px 0 16px">Standings</h2>
    <div class="grid" style="--min:420px">${s.groups.map(table).join('')}</div>`;
}

function results() {
  const s = state.settings;
  const filter = results.filter || 'open';
  const fx = Object.entries(state.fixtures);
  if (!fx.length) return `<div class="head"><h1>Group results</h1></div><div class="card"><p class="muted">No fixtures yet. Create them on the <a href="#groups" data-goto="groups">Groups</a> tab.</p></div>`;
  const sel = `<div class="row"><span class="dim">Show</span>${[['open', 'Not played'], ['all', 'All'], ...s.groups.map((g) => [g, `Group ${g}`])].map(([v, l]) => `<button class="btn sm ${filter === v ? 'primary' : ''}" data-filter="${v}">${l}</button>`).join('')}</div>`;
  const rows = fx.filter(([, f]) => filter === 'all' || (filter === 'open' ? !C.played(f) : f.group === filter))
    .sort((a, b) => a[1].group.localeCompare(b[1].group) || a[1].round.localeCompare(b[1].round, undefined, { numeric: true }));
  const need = Math.ceil(s.group_bo / 2);
  return `<div class="head"><div><h1>Group results</h1><p class="lead">Type the score (best of ${s.group_bo}); the standings and the public page update straight away. Leave both boxes empty for a game that hasn't been played.</p></div>${sel}</div>
  <div class="card tight">${rows.map(([id, f]) => {
    const p = C.played(f), a = C.nameOf(state, f.t1), b = C.nameOf(state, f.t2);
    const w = p ? (f.score1 > f.score2 ? 1 : 2) : 0;
    return `<div class="fx ${p ? 'done' : ''}"><span class="dim">Group ${esc(f.group)} · ${esc(f.round.replace('Round ', 'R'))}</span>
      <span class="r ${w === 1 ? 'won' : w === 2 ? 'lost' : ''}">${teamLabel(a)}</span>
      <span class="vs"><input class="score" type="number" min="0" max="${need}" id="s1-${id}" data-score="${id}" data-side="1" value="${f.score1 ?? ''}" aria-label="${esc(a)} score">
        <span class="dim">–</span><input class="score" type="number" min="0" max="${need}" id="s2-${id}" data-score="${id}" data-side="2" value="${f.score2 ?? ''}" aria-label="${esc(b)} score"></span>
      <span class="${w === 2 ? 'won' : w === 1 ? 'lost' : ''}">${teamLabel(b)}</span>
      <input type="url" placeholder="VOD link (optional)" id="v-${id}" data-vod="${id}" value="${esc(f.vod_url)}"></div>`;
  }).join('') || '<p class="muted" style="padding:20px">Nothing to show — every game here has a result.</p>'}</div>`;
}

function playoffs() {
  const s = state.settings;
  let r;
  try { r = C.resolveBracket(state); } catch (e) { return `<div class="card"><p class="muted">${esc(e.message)}</p></div>`; }
  const manual = !!(state.playoff.seeds && state.playoff.seeds.length);
  const seeds = r.seeds;
  const seedList = `<div class="card tight"><div style="padding:12px 16px;border-bottom:1px solid var(--line)" class="row"><h3 style="margin-right:auto">Seeding</h3>
      ${manual ? '<button class="btn sm" data-act="seeds-auto">Back to automatic</button>' : '<span class="tag">Automatic from standings</span>'}</div>
    <ol style="margin:0;padding:6px;list-style:none">${seeds.slice(0, s.playoff_size).map((id, i) => `<li class="row" style="padding:6px 10px;gap:8px"><span class="dim" style="width:22px">${i + 1}</span>${teamLabel(C.nameOf(state, id))}
      <span style="margin-left:auto" class="row"><button class="btn sm ghost" data-act="seed-up" data-i="${i}" ${i ? '' : 'disabled'} aria-label="Move up">↑</button><button class="btn sm ghost" data-act="seed-down" data-i="${i}" ${i < seeds.length - 1 ? '' : 'disabled'} aria-label="Move down">↓</button></span></li>`).join('')
      || '<li class="dim" style="padding:10px">Seeds appear once teams are in groups.</li>'}
      ${seeds.length < s.playoff_size && seeds.length ? `<li class="dim" style="padding:6px 10px">${s.playoff_size - seeds.length} byes</li>` : ''}</ol>
    <p class="dim" style="padding:0 16px 14px">Default: group winners first, then runners-up${s.groups.length > 1 ? ', in group order' : ''}. Moving a team switches to manual seeding.</p></div>`;
  const match = (id, gf) => {
    const m = r.matches[id];
    const bo = C.bestOf(state, id);
    const real = m.t1 && m.t2 && m.t1 !== 'BYE' && m.t2 !== 'BYE';
    const side = (n) => {
      const t = n === 1 ? m.t1 : m.t2;
      const name = t ? C.nameOf(state, t) : 'TBD';
      const seed = t && t !== 'BYE' ? seeds.indexOf(t) + 1 || '' : '';
      return `<div class="side ${m.winner ? (m.winner === n ? 'win' : 'lose') : ''}"><span class="seed">${seed}</span>${teamLabel(name)}
        ${real ? `<input class="score" type="number" min="0" max="${Math.ceil(bo / 2)}" id="p${n}-${id}" data-pscore="${id}" data-side="${n}" value="${(n === 1 ? m.score1 : m.score2) ?? ''}" aria-label="${esc(name)} score">` : ''}</div>`;
    };
    return `<div class="bm ${real ? '' : 'tbd'} ${gf ? 'gf' : ''}"><div class="id"><span>${id}</span><span>Bo${bo}</span></div>${side(1)}${side(2)}
      ${real ? `<div class="vod"><input type="url" placeholder="VOD link" id="pv-${id}" data-pvod="${id}" value="${esc(m.vod_url)}"></div>` : ''}</div>`;
  };
  const sec = (title, rounds, gf) => `<div class="bsec"><h3>${title}</h3><div class="bracket">${rounds.map((round) => `<div class="bround"><span class="dim">${round.label}</span>${round.ids.map((id) => match(id, gf)).join('')}</div>`).join('')}</div></div>`;
  const st = r.structure;
  return `<div class="head"><div><h1>Playoffs</h1><p class="lead">${s.playoff_size}-team double elimination. Enter scores; winners and losers move on automatically. Changing an earlier result clears later results that no longer fit.</p></div></div>
    <div style="display:grid;gap:24px;grid-template-columns:minmax(260px,320px) minmax(0,1fr);align-items:start" class="po">
      ${seedList}
      <div>${sec('Upper bracket', st.ub)}${sec('Lower bracket', st.lb)}${sec('Grand Final', st.gf, true)}</div>
    </div>
    <style>@media (max-width: 900px) { .po { grid-template-columns: 1fr !important; } }</style>`;
}

function upcomingView() {
  const names = Object.values(state.teams).map((t) => t.name).sort();
  const opts = (cur) => `<option value="">—</option>${names.map((n) => `<option ${n === cur ? 'selected' : ''}>${esc(n)}</option>`).join('')}`;
  return `<div class="head"><div><h1>Upcoming games</h1><p class="lead">Shown on the public page's Upcoming tab, converted to each visitor's timezone. Games both captains confirm in Scheduling appear here by themselves.</p></div>
    <button class="btn primary" data-act="add-upcoming">Add game</button></div>
  <div class="stack">${upcoming.map((u, i) => `<div class="card" style="display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(200px,1fr))">
      <label class="f">Title<input type="text" id="u-title-${i}" data-up="${i}" data-k="title" value="${esc(u.title)}"></label>
      <label class="f">Date and time (GMT)<input type="datetime-local" id="u-dt-${i}" data-up="${i}" data-k="dt" value="${esc(toLocalInput(u.date))}"><span class="dim">${esc(u.date || 'Not set')}</span></label>
      <label class="f">Team 1<select id="u-t1-${i}" data-up="${i}" data-k="team1">${opts(u.team1)}</select></label>
      <label class="f">Team 2<select id="u-t2-${i}" data-up="${i}" data-k="team2">${opts(u.team2)}</select></label>
      <label class="f">Description<input type="text" id="u-d-${i}" data-up="${i}" data-k="description" value="${esc(u.description)}"></label>
      <label class="f">Banner image URL<input type="url" id="u-i-${i}" data-up="${i}" data-k="image" value="${esc(u.image)}"></label>
      <div class="row" style="align-self:end">${u._match_key ? '<span class="tag ok">Confirmed by captains</span>' : ''}<button class="btn sm danger" data-act="del-upcoming" data-i="${i}">Remove</button></div>
    </div>`).join('') || '<div class="card"><p class="muted">No upcoming games.</p></div>'}</div>`;
}
// The public page parses "Sunday 12 Apr · 18:00 GMT".
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'], MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function gmtLabel(v) { const d = new Date(v + 'Z'); return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]} · ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} GMT`; }
function toLocalInput(label) {
  const m = /(\d{1,2})[\s-]*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\D+(\d{1,2}):(\d{2})/i.exec(label || '');
  if (!m) return '';
  const now = new Date(); let y = now.getUTCFullYear();
  const mo = MON.findIndex((x) => x.toLowerCase() === m[2].toLowerCase());
  if (new Date(Date.UTC(y, mo, +m[1])) < new Date(now - 60 * 864e5)) y++;
  return `${y}-${String(mo + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}T${m[3].padStart(2, '0')}:${m[4]}`;
}

// ── Team editor ──────────────────────────────────────────────────────────────
function openTeam(id) {
  const t = id ? structuredClone(state.teams[id]) : { name: '', clan_tag: '', clan_name: '', captain: '', group: '', code: C.newCode(), players: [] };
  const dlg = $('#dlg');
  const draw = () => {
    dlg.innerHTML = `<form method="dialog" id="team-form"><header><h2>${id ? 'Edit team' : 'Add team'}</h2><button class="btn sm ghost" value="cancel" aria-label="Close">✕</button></header>
      <div class="body stack">
        <div class="grid" style="--min:200px">
          <label class="f">Team name<input type="text" id="tf-name" required value="${esc(t.name)}" placeholder="e.g. DoD A"></label>
          <label class="f">Clan tag<input type="text" id="tf-tag" value="${esc(t.clan_tag)}"></label>
          <label class="f">Clan name<input type="text" id="tf-clan" value="${esc(t.clan_name)}"></label>
          <label class="f">Team captain<input type="text" id="tf-cap" value="${esc(t.captain)}"></label>
          <label class="f">Group<select id="tf-group"><option value="">No group</option>${state.settings.groups.map((g) => `<option ${g === t.group ? 'selected' : ''}>${g}</option>`).join('')}</select></label>
          <label class="f">Team code (captain login)<span class="row" style="flex-wrap:nowrap"><input type="text" id="tf-code" class="code" value="${esc(t.code)}"><button type="button" class="btn sm" id="tf-newcode">New</button></span></label>
        </div>
        <div><div class="row" style="justify-content:space-between;margin-bottom:8px"><h3>Players</h3><button type="button" class="btn sm" id="tf-addp">Add player</button></div>
          <div class="prow dim"><span>Name</span><span>AoM profile link</span><span>Eligible</span><span>Guest</span><span></span></div>
          ${t.players.map((p, i) => `<div class="prow">
            <input type="text" data-p="${i}" data-k="name" value="${esc(p.name)}" aria-label="Player name">
            <input type="url" data-p="${i}" data-k="url" value="${esc(p.url)}" aria-label="AoM profile link">
            <select data-p="${i}" data-k="eligibility" aria-label="Eligible">${['Yes', 'No', ''].map((v) => `<option ${v === (p.eligibility || '') ? 'selected' : ''} value="${v}">${v || '—'}</option>`).join('')}</select>
            <select data-p="${i}" data-k="guest_player" aria-label="Guest">${['No', 'Yes', ''].map((v) => `<option ${v === (p.guest_player || '') ? 'selected' : ''} value="${v}">${v || '—'}</option>`).join('')}</select>
            <button type="button" class="btn sm ghost" data-delp="${i}" aria-label="Remove player">✕</button></div>`).join('') || '<p class="dim">No players yet.</p>'}
        </div>
        <p class="dim" id="tf-err" style="color:var(--red-text)"></p>
      </div>
      <footer>${id ? '<button type="button" class="btn danger" id="tf-del">Delete team</button>' : '<span></span>'}<span class="row"><button class="btn" value="cancel">Cancel</button><button class="btn primary" value="save" id="tf-save">Save team</button></span></footer></form>`;
  };
  const read = () => {
    t.name = $('#tf-name').value.trim(); t.clan_tag = $('#tf-tag').value.trim(); t.clan_name = $('#tf-clan').value.trim();
    t.captain = $('#tf-cap').value.trim(); t.group = $('#tf-group').value; t.code = $('#tf-code').value.trim().toUpperCase();
    dlg.querySelectorAll('[data-p]').forEach((el) => { t.players[+el.dataset.p][el.dataset.k] = el.value.trim(); });
  };
  draw();
  dlg.onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.id === 'tf-addp') { read(); t.players.push({ name: '', url: '', eligibility: 'Yes', guest_player: 'No' }); draw(); }
    if (b.dataset.delp) { read(); t.players.splice(+b.dataset.delp, 1); draw(); }
    if (b.id === 'tf-newcode') { $('#tf-code').value = C.newCode(); }
    if (b.id === 'tf-del') {
      if (b.dataset.sure) { change((s) => { delete s.teams[id]; C.generateGroupFixtures(s); if (s.playoff.seeds) s.playoff.seeds = s.playoff.seeds.filter((x) => x !== id); }); dlg.close(); toast('Team deleted'); }
      else { b.dataset.sure = '1'; b.textContent = 'Click again to delete'; }
    }
    if (b.id === 'tf-save') {
      e.preventDefault(); read();
      const err = !t.name ? 'Give the team a name.' : C.BAD_KEY.test(t.name) ? 'Team names can\'t contain . # $ [ ] /' :
        Object.entries(state.teams).some(([k, x]) => k !== id && x.name.toLowerCase() === t.name.toLowerCase()) ? 'Another team already has this name.' : '';
      if (err) { $('#tf-err').textContent = err; return; }
      t.players = t.players.filter((p) => p.name);
      const wasGroup = id ? state.teams[id].group : '';
      change((s) => {
        const key = id || C.uid();
        if (!id) t.order = Object.keys(s.teams).length;
        s.teams[key] = t;
        if (wasGroup !== t.group && Object.keys(s.fixtures).length) C.generateGroupFixtures(s);
      });
      dlg.close(); toast(id ? 'Team saved' : 'Team added');
    }
  };
  dlg.showModal();
}

function openPaste() {
  const dlg = $('#dlg');
  dlg.innerHTML = `<form method="dialog"><header><h2>Paste from spreadsheet</h2><button class="btn sm ghost" value="cancel" aria-label="Close">✕</button></header>
    <div class="body stack">
      <p class="muted">Select the rows in Excel or Google Sheets and paste them here. One row per player, in this column order:</p>
      <p class="code dim">Clan Tag · Clan Name · Team · Team Captain · Player Name · AoM Profile · Eligibility · Guest Player</p>
      <textarea id="paste-box" placeholder="Paste here…"></textarea>
      <p class="dim" id="paste-preview">Teams that already exist (same name) get their details and players replaced; other teams are kept.</p>
    </div>
    <footer><span></span><span class="row"><button class="btn" value="cancel">Cancel</button><button class="btn primary" id="paste-go">Import</button></span></footer></form>`;
  const box = $('#paste-box');
  box.oninput = () => { const t = C.parseRosterPaste(box.value); $('#paste-preview').textContent = t.length ? `Found ${t.length} teams, ${t.reduce((n, x) => n + x.players.length, 0)} players: ${t.map((x) => x.name).join(', ')}` : 'Nothing recognised yet.'; };
  $('#paste-go').onclick = (e) => {
    e.preventDefault();
    const list = C.parseRosterPaste(box.value).filter((t) => !C.BAD_KEY.test(t.name));
    if (!list.length) return;
    change((s) => {
      for (const t of list) {
        const found = Object.entries(s.teams).find(([, x]) => x.name.toLowerCase() === t.name.toLowerCase());
        if (found) Object.assign(found[1], { clan_tag: t.clan_tag, clan_name: t.clan_name, captain: t.captain, players: t.players });
        else s.teams[C.uid()] = { ...t, group: '', code: C.newCode(), order: Object.keys(s.teams).length };
      }
    });
    dlg.close(); toast(`Imported ${list.length} teams`);
  };
  dlg.showModal();
}

// ── Email sign-in ────────────────────────────────────────────────────────────
const AUTH_ERRORS = {
  'auth/invalid-email': 'That email address doesn\'t look right.',
  'auth/missing-password': 'Type your password.',
  'auth/invalid-credential': 'Email or password is wrong. New here? Use Create account.',
  'auth/wrong-password': 'Email or password is wrong.',
  'auth/user-not-found': 'No account with this email yet. Use Create account.',
  'auth/email-already-in-use': 'This email already has an account. Sign in instead, or use Forgot password.',
  'auth/weak-password': 'Use a password of at least 6 characters.',
  'auth/too-many-requests': 'Too many tries. Wait a few minutes, or use Forgot password.',
};
async function emailAuth(mode) {
  const email = $('#auth-email')?.value.trim(), pw = $('#auth-pw')?.value || '';
  const msg = $('#auth-msg');
  const say = (t, err) => { if (msg) { msg.textContent = t; msg.style.color = err ? 'var(--red-text)' : ''; } };
  if (!email) return say('Type your email address first.', true);
  try {
    if (mode === 'reset') { await store.resetPassword(email); say(`If ${email} has an account, a reset link is on its way. Check your spam folder too.`); return; }
    if (mode === 'create') { if (pw.length < 6) return say('Choose a password of at least 6 characters.', true); say('Creating your account…'); await store.createEmail(email, pw); return; }
    say('Signing in…'); await store.signInEmail(email, pw);
  } catch (err) { say(AUTH_ERRORS[err.code] || err.message, true); }
}
document.addEventListener('submit', (e) => { if (e.target.id === 'auth-form') { e.preventDefault(); emailAuth('signin'); } });

// ── Events ───────────────────────────────────────────────────────────────────
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-tab],[data-goto],[data-act],[data-filter]');
  if (!el || el.closest('dialog')) return;
  if (el.dataset.tab || el.dataset.goto) { e.preventDefault(); tab = el.dataset.tab || el.dataset.goto; history.replaceState(null, '', `${location.search}#${tab}`); render(); window.scrollTo(0, 0); return; }
  if (el.dataset.filter) { results.filter = el.dataset.filter; render(); return; }
  const id = el.dataset.id;
  switch (el.dataset.act) {
    case 'signin': store.signIn().catch((err) => toast(/popup-closed|cancelled-popup/.test(err.code) ? 'Sign-in cancelled.' : err.message)); break;
    case 'email-create': emailAuth('create'); break;
    case 'email-reset': emailAuth('reset'); break;
    case 'signout': store.signOut(); break;
    case 'copy-uid': navigator.clipboard?.writeText($('#uid-box').value).then(() => toast('Copied'), () => $('#uid-box').select()); break;
    case 'add-team': openTeam(null); break;
    case 'edit-team': openTeam(id); break;
    case 'paste': openPaste(); break;
    case 'codes': change((s) => { for (const t of Object.values(s.teams)) if (!t.code) t.code = C.newCode(); }); toast('Team codes ready'); break;
    case 'new-admin-code': change((s) => { s.settings.admin_code = C.newCode(); }); break;
    case 'up': change((s) => {
      const g = s.teams[id].group; const list = C.teamsInGroup(s, g); const i = list.findIndex(([k]) => k === id);
      if (i > 0) { list.splice(i - 1, 0, list.splice(i, 1)[0]); list.forEach(([k], n) => { s.teams[k].order = n; }); }
    }); break;
    case 'snake': change((s) => {
      const all = Object.entries(s.teams).sort((a, b) => (a[1].order ?? 0) - (b[1].order ?? 0));
      const G = s.settings.groups;
      all.forEach(([, t], i) => { const r = Math.floor(i / G.length), c = i % G.length; t.group = G[r % 2 ? G.length - 1 - c : c]; t.order = i; });
      if (Object.keys(s.fixtures).length) C.generateGroupFixtures(s);
    }); toast('Teams spread over the groups'); break;
    case 'fixtures': change((s) => C.generateGroupFixtures(s)); toast(`${Object.keys(state.fixtures).length} group games ready`); break;
    case 'seeds-auto': change((s) => { s.playoff.seeds = null; }); break;
    case 'seed-up': case 'seed-down': change((s) => {
      const list = C.currentSeeds(s); const i = +el.dataset.i; const j = el.dataset.act === 'seed-up' ? i - 1 : i + 1;
      [list[i], list[j]] = [list[j], list[i]]; s.playoff.seeds = list;
    }); break;
    case 'add-upcoming': upcoming.push({ title: 'MCL Season II', date: '', team1: '', team2: '', description: '', image: '' }); render(); saveUpcoming(); break;
    case 'del-upcoming': upcoming.splice(+el.dataset.i, 1); render(); saveUpcoming(); break;
  }
});

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.closest('dialog')) return;
  const d = el.dataset;
  if (d.set) {
    change((s) => {
      const v = el.value;
      if (d.set === 'season_name') s.settings.season_name = v.trim() || 'Season II';
      else if (d.set === 'group_count') {
        const n = Math.max(1, Math.min(8, +v || 1));
        s.settings.groups = 'ABCDEFGH'.slice(0, n).split('');
        for (const t of Object.values(s.teams)) if (!s.settings.groups.includes(t.group)) t.group = '';
        if (Object.keys(s.fixtures).length) C.generateGroupFixtures(s);
      } else if (d.set.startsWith('p_')) s.settings.points[d.set.slice(2)] = Math.round(+v || 0);
      else s.settings[d.set] = Math.max(1, Math.round(+v || 1));
    });
  }
  if (d.round) change((s) => {
    const v = el.value.trim();
    if (v) s.settings.round_names[d.round] = v; else delete s.settings.round_names[d.round];
  });
  if (d.move) change((s) => { s.teams[d.move].group = el.value; s.teams[d.move].order = 999; if (Object.keys(s.fixtures).length) C.generateGroupFixtures(s); });
  if (d.score) {
    const other = $(`#s${d.side === '1' ? 2 : 1}-${d.score}`);
    const v = el.value === '' ? null : +el.value, o = other.value === '' ? null : +other.value;
    change((s) => { const f = s.fixtures[d.score]; [f.score1, f.score2] = d.side === '1' ? [v, o] : [o, v]; });
  }
  if (d.vod) change((s) => { s.fixtures[d.vod].vod_url = el.value.trim(); });
  if (d.pscore || d.pvod) {
    const mid = d.pscore || d.pvod;
    const m = C.resolveBracket(state).matches[mid];
    change((s) => {
      const r = s.playoff.results[mid] && s.playoff.results[mid].t1 === m.t1 && s.playoff.results[mid].t2 === m.t2 ? s.playoff.results[mid] : { t1: m.t1, t2: m.t2, score1: null, score2: null, vod_url: '' };
      if (d.pvod) r.vod_url = el.value.trim();
      else {
        const a = $(`#p1-${mid}`).value, b = $(`#p2-${mid}`).value;
        r.score1 = a === '' ? null : +a; r.score2 = b === '' ? null : +b;
      }
      s.playoff.results[mid] = r;
    });
  }
  if (d.up) {
    const u = upcoming[+d.up];
    if (d.k === 'dt') u.date = el.value ? gmtLabel(el.value) : '';
    else u[d.k] = el.value;
    if ((d.k === 'team1' || d.k === 'team2') && u.team1 && u.team2 && (!u.title || /^MCL Season/.test(u.title))) u.title = `${state.settings.season_name} — ${u.team1} vs ${u.team2}`;
    render(); saveUpcoming();
  }
});
window.addEventListener('hashchange', () => { tab = location.hash.slice(1) || 'overview'; render(); });

boot();
