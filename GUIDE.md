# Hermès Mint Bot — Full Usage Guide

## Quick Setup Checklist
Before anything else, confirm these are set in Render → Environment:
- `BOT_TOKEN` — Telegram bot token from @BotFather
- `ALLOWED_USER_ID` — Your Telegram user ID (get from @userinfobot)
- `MASTER_PRIVATE_KEY` — Master wallet private key (64 hex chars, with or without 0x)
- `ALCHEMY_RPC` — Your Alchemy HTTPS RPC URL
- `WEBAPP_API_TOKEN` — Any secret string (e.g. `hermes-secret-123`)
- `WEBAPP_URL` — Your Render URL (e.g. `https://arenax-mint-bot.onrender.com`)

---

## Part 1 — Wallets

### Setting Up Wallets
You need two types of wallets:
- **Master wallet** — holds your ETH, funds sub-wallets, set via `MASTER_PRIVATE_KEY` in Render
- **Sub-wallets** — the wallets that actually mint

**Add sub-wallets (Telegram):**
1. Open bot → tap **👜 My Wallets**
2. Tap **Add Wallet**
3. Paste the private key (with or without 0x)
4. Give it a label (e.g. "Wallet 1")

**Add sub-wallets (Webapp):**
1. Open `https://your-render-url.onrender.com`
2. Scroll to **Wallet Management**
3. Paste private key → Add

### Funding Sub-Wallets

**Option A — Auto-Balance (recommended):**
In the webapp, scroll to ⚡ **Auto-Balance Wallets**:
- Set **Min ETH threshold** — wallets below this get topped up (e.g. `0.001`)
- Set **Target ETH per wallet** — what to top them up to (e.g. `0.005`)
- Click **Auto-Balance Now**

Your master wallet must have enough ETH for all wallets + gas.

**Option B — Manual Fund:**
Telegram → **💰 Fund Wallets** → enter amount per wallet.

**Option C — Withdraw back to master:**
Telegram → **🦅 Withdraw** → drains all sub-wallets back to master.

---

## Part 2 — Minting

### Before You Mint — Research the Contract

Open the project's mint page and note:
1. **Contract address** (from Etherscan or the project site)
2. **Mint price** in ETH (or 0 for free)
3. **Chain** (Ethereum, Base, etc.)
4. **Mint function** — check Etherscan → Write Contract for the payable function name

Use [Tenderly](https://dashboard.tenderly.co) to check recent transactions on the contract — look at the **Function** column to see what others called successfully.

### Step-by-Step Mint Flow

**Step 1 — Select Chain**
In the webapp header, select the correct chain from the dropdown (Ethereum / Base / etc.).

**Step 2 — Enter Contract Info**
In the **Mint NFT** panel:
- **Contract Address** — paste the NFT contract address
- **QTY / Wallet** — how many NFTs per wallet (check max per wallet on the project page)
- **Price (ETH)** — mint price per NFT (0 for free mints)
- **Mint Function** — leave as `auto` first; if auto fails, enter the exact function name (e.g. `publicMint`, `mint`, `mintPublic`)
- **Gas Tip (Gwei)** — 5 is standard; use 20-50 for competitive FCFS mints

**Step 3 — Select Proof Mode**

| Proof Mode | When to use |
|---|---|
| 🔒 None — public mint | Standard public mint, no whitelist |
| 🌊 SeaDrop | OpenSea drops where SeaDrop IS configured (Check Phase will tell you) |
| 🌐 Launchpad Auto-Proof | Manifold, thirdweb, Zora, Highlight drops |
| 📋 Per-wallet JSON map | You have a proof per wallet from the project API |
| 🔑 Single proof for all | Same Merkle proof for all wallets |
| ✍️ EIP-712 Signature | Server-signed mints (you have the signature) |

**Step 4 — Select Wallets**
Check the boxes next to wallets you want to mint from. Balances shown next to each.

**Step 5 — Dry Run First (ALWAYS)**
Tick **✅ Dry run — simulate only, no tx broadcast** → click **🔥 Mint Selected Wallets**.

Read the results:
- `dry-run-ok` → safe to mint live
- `dry-run-fail` with "Simulation failed (would revert)" → mint is closed, check phase
- `failed: Insufficient` → wallet needs more ETH
- `failed: SeaDrop public drop not configured` → use a different proof mode or the project site

**Step 6 — Live Mint**
Uncheck dry run → click **🔥 Mint Selected Wallets**.

---

## Part 3 — Diagnosing Before Minting

### Check Phase
In the webapp, scroll to **🔍 Phase & Contract Info**:
- Enter contract address → **Check Phase**

| Result | Meaning |
|---|---|
| ✅ PUBLIC — VERIFIED | Mint is open, safe to mint |
| 🌊 SeaDrop (price shown) | SeaDrop mint — select SeaDrop proof mode |
| ❓ UNKNOWN — Mint appears closed | Mint not open yet or wrong contract |
| 🔴 PAUSED | Mint paused |
| 🔴 SOLD_OUT | Fully minted out |

### Check Eligibility
Scroll to **✅ Wallet Eligibility**:
- Enter contract → **Check Eligibility**
- ⚠️ "No eligibility fn found — will attempt mint" = public mint, no whitelist check needed
- ✅ = whitelisted
- ❌ = not eligible

---

## Part 4 — Scheduling

For mints with a known start time:

**Telegram:**
1. Tap **⏰ Schedule Mint**
2. Enter contract address
3. Select trigger type:
   - **🕐 Time (exact datetime)** — fires at a specific ISO time (e.g. `2026-07-01T15:00:00Z`)
   - **🔍 Phase (poll until open)** — polls the contract every few seconds until mint opens
   - **🔀 Both (time then poll)** — waits until the time, then polls until phase confirms open
4. Follow prompts for price, qty, proof mode
5. Confirm → bot shows ID and countdown

**Cancel a schedule:**
```
/cancel SCHEDULE_ID
```
Or Telegram → **📅 Schedules** → find the ID → `/cancel ID`

**View active schedules:**
Telegram → **📅 Schedules**

---

## Part 5 — Proof Modes Explained

### For Unknown Sites (Finding Your Own Proof)
1. Open the project's mint site on your phone/PC
2. Open DevTools → Network tab
3. Connect wallet and attempt to mint
4. Look for a request with `/allowlist`, `/proof`, `/merkle`, `/eligible`, `/stage` in the URL
5. Click it → copy the `proof` array from the response

**Paste as Per-wallet JSON:**
```json
{
  "0xYourWallet1": ["0xleaf1", "0xleaf2"],
  "0xYourWallet2": ["0xleaf1", "0xleaf3"]
}
```
Telegram → **🔐 Load Proofs** → Per-wallet JSON map

**Or as Single proof (same for all wallets):**
```json
["0xleaf1", "0xleaf2", "0xleaf3"]
```
Telegram → **🔐 Load Proofs** → Single proof for all wallets

---

## Part 6 — Mint Types and Success Rates

| Mint type | Success rate | What to use |
|---|---|---|
| Standard public ERC721 | ✅ 85-90% | None proof mode, auto function |
| ERC1155 public | ✅ 75-85% | None proof mode |
| Manifold allowlist | ✅ 70-80% | Launchpad Auto-Proof |
| thirdweb allowlist | ✅ 65-75% | Launchpad Auto-Proof |
| SeaDrop public (configured) | ✅ 80-90% | SeaDrop proof mode |
| Merkle whitelist (manual proof) | ✅ 80-90% | Per-wallet JSON |
| OpenSea Studio/Seaport drops | ⚠️ Not supported | Use OpenSea site |
| SeaDrop signed (OpenSea GTD) | ❌ Not supported | Use OpenSea site |

---

## Part 7 — Gas Strategy

| Mint type | Recommended gas tip |
|---|---|
| Relaxed / non-competitive | 1-3 gwei |
| Standard | 5 gwei (default) |
| Competitive FCFS | 20-50 gwei |
| War (10k collection, seconds matter) | 100+ gwei |

Set Gas Tip in the webapp before minting. Higher tip = faster inclusion but more cost.

---

## Part 8 — Common Errors and Fixes

| Error | Meaning | Fix |
|---|---|---|
| `Insufficient: has X ETH, needs ~Y ETH` | Wallet underfunded | Auto-Balance or manually fund |
| `publicMint() reverted — Phase: UNKNOWN` | Mint is closed | Wait for mint to open |
| `Phase: SOLD_OUT` | Fully minted | Find another contract |
| `SeaDrop public drop not configured` | Contract uses Seaport | Use project site directly |
| `Simulation failed (would revert)` | Pre-flight check caught a revert | Check Phase and Eligibility |
| `Invalid proof` | Merkle proof doesn't match | Re-fetch proof from project site |
| `Gas estimate failed — fallback 150000` | ABI not verified | Enter mint function name manually |
| `All RPCs failed for chain 8453` | No Base RPC | Add `CHAIN_8453_RPC` in Render env |
| `MASTER_PRIVATE_KEY not configured` | Master key missing | Add to Render → Environment |

---

## Part 9 — Chain Setup

| Chain | ChainId | Add RPC env var |
|---|---|---|
| Ethereum | 1 | `ALCHEMY_RPC` (already set) |
| Base | 8453 | `CHAIN_8453_RPC` = Base Alchemy/QuickNode URL |
| Optimism | 10 | `CHAIN_10_RPC` |
| Arbitrum | 42161 | `CHAIN_42161_RPC` |
| Zora | 7777777 | `CHAIN_7777777_RPC` |

Get free RPC URLs from [Alchemy](https://alchemy.com) or [QuickNode](https://quicknode.com).

---

## Part 10 — The Right Workflow for Any Drop

```
1. Find contract address (Discord, Twitter, Etherscan)
2. Check Phase → confirm it says PUBLIC or shows SeaDrop with a price
3. Check Eligibility → confirm wallets are eligible
4. Fund wallets if needed (Auto-Balance)
5. DRY RUN → all wallets should show dry-run-ok
6. Uncheck dry run → MINT
7. Check results — success shows tx hash
```

Never skip the dry run. It costs zero gas and catches 95% of failures before they happen.[B

---

## Part 11 — Pushing Updates to GitHub & Render

### One-Time Git Setup (run in Termux)
```bash
cd ~/arenax-mint-bot
git config user.name "Adebusayo0325"
git config user.email "your@email.com"
```
Set up a GitHub PAT (Personal Access Token) once so you don't enter password every time:
```bash
git remote set-url origin https://Adebusayo0325:<YOUR_PAT>@github.com/Adebusayo0325/arenax-mint-bot.git
```
Get a PAT from: GitHub → Settings → Developer settings → Personal access tokens → Generate new token (scope: `repo`).

---

### Push Workflow (After Every Update Session)

```bash
cd ~/arenax-mint-bot

# Stage all changed files
git add -A

# Commit with a description of what changed
git commit -m "v3.x — smart fund, mobile nav, execution flow, OpenSea 2026"

# Push to GitHub (triggers Render auto-deploy)
git push origin main
```

Render auto-deploys on every push to `main`. Watch: Render dashboard → your service → Events.

---

### Multi-File Update (Base64 Method for Termux)
When pasting multi-line code from chat (heredoc collapses newlines), use the base64 trick:

```bash
# In the chat, Claude gives you a base64 string. In Termux:
echo 'BASE64_STRING_HERE' | base64 -d > src/webapp/index.html
git add src/webapp/index.html
git commit -m "update index.html"
git push origin main
```

---

### Quick Patch Version Bump
```bash
npm version patch          # bumps package.json 3.x.y → 3.x.(y+1)
git push && git push --tags
```

---

### If Render Doesn't Auto-Deploy
1. Render dashboard → your service → click **Manual Deploy** → Deploy latest commit
2. Or: Settings → Build & Deploy → enable **Auto-Deploy from GitHub**

---

## Part 12 — Smart Auto-Fund Guide

### Why 0.005 ETH target for a 0.002 ETH mint is wasteful

| Item | Cost |
|---|---|
| Mint price | 0.002 ETH |
| Mint gas (~180k gas @ 12 gwei) | ~0.00216 ETH |
| **Wallet needs** | **~0.00416 ETH** |
| Funding tx gas (21k gas @ 12 gwei) | ~0.000252 ETH each |
| Old target (0.005) | 0.005 ETH — **20% wasted** |
| Smart target | 0.004 ETH — **exact fit** |

For 4 wallets: old approach costs 0.0201 ETH (4×0.005 + 4×funding gas) vs smart approach 0.0163 ETH. **Save ~19%**.

### How to use Smart Auto-Fund
1. In Overview → Smart Auto-Fund:
   - Enter **Mint Price** (e.g. `0.002`)
   - Enter **Qty / Wallet** (e.g. `1`)
   - Select **Chain**
2. Click **🧮 Calculate Optimal** — see the breakdown
3. Click **⚡ Auto-Fund All Wallets** — uses the calculated target

The bot now warns you if your target is >3× the mint cost before sending.

---

## Part 13 — OpenSea 2026 Mint Format

### How it works
OpenSea Studio drops in 2026 use the **Drops API** (`/api/v2/drops/{chain}/{contract}`):
1. Bot fetches drop info → gets active stage, price, eligibility
2. Requests fulfillment data from `/drops/{chain}/{contract}/fulfill`
3. Executes the signed Seaport transaction

### Proof mode to use
In the Mint tab, set **Proof Mode → 🌊 OpenSea / Seaport (Studio drops)**. This:
- Tries Drops API first (2026 format)
- Falls back to Seaport order fulfillment (older format)
- Works for both ERC721SeaDrop and standard Seaport contracts

### Required env vars (already set)
- `OPENSEA_API_KEY` — your OpenSea API key
- `ALCHEMY_RPC` — for on-chain calls

### Workflow for an OpenSea drop
```
1. Check Phase → confirm "OpenSea Drops 2026 — public stage"
2. Note the price shown (auto-filled into mint form)
3. Smart Auto-Fund wallets to (price + gas estimate)
4. Set Proof Mode → OpenSea / Seaport
5. Run Execution Flow → review PREFLIGHT results
6. Confirm → EXECUTE
```
