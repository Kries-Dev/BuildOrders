# MCL Control

Admin app for the Mythic Clan League, Season 2 onwards: **https://kries-dev.github.io/BuildOrders/mcl-admin.html**
Public bracket for the same season: **https://kries-dev.github.io/BuildOrders/bracket.html?season=2**
(`bracket.html` without `?season` is still Season 1, unchanged.)

Try it without touching Firebase: `mcl-admin.html?demo` (saved in your browser only).

## What it does

Settings (groups, teams per group that advance, bracket size 4/8/16/32, best-of, group points) →
Teams (paste the sign-up sheet, edit rosters, captain codes) → Groups (move teams, create the round robin) →
Group results (type scores; standings update) → Playoffs (seeding from the standings, double elimination;
winners and losers move on by themselves) → Upcoming games.

Every change is saved straight away to Firebase node `mcl_s2`: the app's own data under `mcl_s2/admin`,
and next to it exactly what `bracket.html?season=2` reads. What captains write from the Scheduling tab
(availability, scheduled games, audit log) is never overwritten.

## One-time Firebase setup (console.firebase.google.com → project bracket-4b8cc, owned by the Christophe account)

1. **Authentication → Sign-in method → Google → Enable.** (done 20 Nov 2026)
2. **Authentication → Settings → Authorized domains → Add domain:** `kries-dev.github.io` (done 20 Nov 2026)
3. **Realtime Database → Rules:** the rules in `database.rules.json` (Season 1's `tournament` block as it was,
   plus `admins` and `mcl_s2`). Done on 20 Nov 2026.
4. Open `mcl-admin.html`, sign in with Google or Microsoft. The page shows your user ID with a Copy button.
   **Realtime Database → Data:** add `admins` → `<your user ID>`: `true`. Reload. Do the same for co-admins.

## Microsoft sign-in

Firebase → Authentication → Sign-in method → Microsoft, with the Application (client) ID and a client secret from an
app registration in portal.azure.com (Microsoft Entra ID → App registrations). Redirect URI in that registration:
`https://bracket-4b8cc.firebaseapp.com/__/auth/handler`. Client secrets expire: renew them in Azure before the end date
and paste the new one into Firebase, or Microsoft sign-in stops working (Google keeps working).

## Next season

Open `mcl-admin.html?season=3` and `bracket.html?season=3`, and copy the `mcl_s2` rules block as `mcl_s3`.

## Files

- `mcl-admin.html`, `mcl/mcl-admin.js` — the app
- `mcl/mcl-core.js` — fixtures, standings, seeding and the double-elimination bracket (no Firebase, no page code)
- `bracket.html` — public page; picks the season from `?season=`, draws any bracket size from the data
