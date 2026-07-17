# Hermès Bot — CHANGELOG

## v26.0.1 — June 30 2026 (patch on top of v26.0.0)

### 🔧 CRITICAL FIX: `/api/schedule` crashed on every call, post-response

**Root cause:** the v26.0.0 fix above (awaiting `scheduleAllWallets` with a
real `.catch()`) never actually ran. The route builds the args object for
`scheduleAllWallets(...)` and one of its properties is `merkleApiUrl:
merkleApiUrl || null` — but `merkleApiUrl` was never destructured from
`req.body` in *this* route (it only exists in the unrelated `/api/mint`
handler higher up in the file). Referencing an undeclared bare identifier
throws `ReferenceError: merkleApiUrl is not defined` the instant the object
literal is evaluated — before `scheduleAllWallets` is even called, so
`.catch()` never attaches to anything.

Because this throw happens *after* `res.json({scheduleId, message:
'Scheduled'})` already sent on line 330, the outer `catch(e)` block's
`res.status(500).json(...)` then throws its own error
(`ERR_HTTP_HEADERS_SENT`, headers already sent). That second throw, inside
an `async` Express 4 handler with no global `unhandledRejection` handler
anywhere in the process, becomes an unhandled rejection — which on Node 18's
default `--unhandled-rejections=throw` behavior crashes the entire server
process. Every `/api/schedule` call that passes validation hits this,
unconditionally, regardless of whether the request even included a
`merkleApiUrl`.

This is the most likely explanation for both the silent FCFS failure and
the repeated Render disconnects: the client/Telegram already shows
"✅ Scheduled," then the process dies a moment later, taking the whole bot
(and dashboard) down with it — including any *other* schedules already in
flight on other wallets at the time.

**Fix:** added `merkleApiUrl` to the route's destructured `req.body` fields,
matching how `/api/mint` already does it. One-line change, `node --check`
passes. Not yet run against live RPC/ethers in this sandbox (no network
egress here) — recommend a `dryRun: true` schedule call as the first test
after deploying this.

## v26.0.0 — June 2026

### 🔧 CRITICAL FIX: Scheduled mints silently dying with no error, no result, ghost entries stuck at "0s"

**Root cause (verified by reading the live deployed code, not guessed):**

`server.js`'s `/api/schedule` route called `scheduleAllWallets(...)` without
`await` and without `.catch()`, then immediately responded with a fake
`{ scheduleId, message: 'Scheduled' }`. Any throw inside that function —
including the exact-millisecond "mint time is in the past" check — became
a silent unhandled promise rejection. The webapp had already shown
"✅ Scheduled" by the time it failed, so the user had zero indication
anything went wrong. The dead schedule never even got registered into the
in-memory `schedules{}` tracking object, so Cancel did nothing and Refresh
showed duplicate ghost entries frozen at "0s" forever.

The exact same unguarded pattern existed in `commands.js` (Telegram bot's
schedule handler) — same silent failure, same fake "✅ Scheduled!" message
with nothing ever following it up.

**What was fixed:**

1. **`scheduler.js`** — the schedule entry is now registered in `schedules{}`
   *before* any validation that can throw, so even a rejected schedule is
   visible and gets cleaned up properly instead of vanishing before it's
   ever tracked.
2. **`scheduler.js`** — `scheduleAllWallets` is now wrapped in an outer
   safety-net function. Any throw anywhere in the schedule lifecycle —
   validation, RPC error, wallet fetch failure, anything — removes the
   dead entry from `schedules{}`, records the failure to
   `schedule-results.json` so it's visible in history, and re-throws so
   the caller can surface the real error.
3. **`server.js`** — the past-time check now happens *before* responding
   to the client, so an obviously invalid request gets an honest 400 error
   immediately instead of a fake success. The detached `scheduleAllWallets()`
   call now has a `.catch()` that logs loudly to Render's log viewer.
4. **`commands.js`** (Telegram) — same `.catch()` added. A failed schedule
   now sends an actual "❌ Schedule Failed" message with the real reason
   instead of silence forever after the fake "✅ Scheduled!" message.
5. **3-second grace window** applied consistently across `scheduler.js`,
   `server.js`, `commands.js`, and `app.js` — a mint time of "right now"
   submitted from a slow mobile connection routinely arrives 1-2s "late"
   by the time it's checked. That's not a real error, it means "fire
   immediately," and is now handled as such instead of being rejected.

**Verified with isolated logic-trace tests** (full ethers/wallet dependency
stack not available in this sandbox — no network egress to npm registry),
confirming: instant mint times fire cleanly with no ghost state, genuinely
stale times are rejected with `schedules{}` left empty, and the original
unguarded-throw pattern is reproduced standalone to confirm it matches the
screenshot symptoms exactly.

### What was investigated and found to NOT be a bug
A prior audit claimed the bot prefers `publicMint` over `freeMint`/`mintSigned`,
causing wrong-function routing on signed-mint contracts. This was checked
against the actual `mintEngine.js` and found false — `mintSigned` is
already last-priority with an explicit `mintSignedIsOnlyOption` gate that
correctly routes signature-only contracts (confirmed: BEERZ on OpenSea
Studio/SeaDrop only exposes `mintSigned`, no `publicMint` exists on it at
all). The "No sig fetched" error is the bot correctly refusing to guess at
a private, authenticated signing endpoint that has no public API — this is
intended behavior, not a routing bug.
