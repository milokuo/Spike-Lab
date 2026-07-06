# SPIKE LAB — M2 Vertical Slice

Authoritative 1v1 volleyball for two players on the same home LAN. Colyseus
server (authoritative physics + lag-compensated touch adjudication), Vite +
Three.js client, and a shared package of pure, deterministic ballistics/quality
functions used identically on both ends.

- **Server:** Colyseus 0.16, `ws://0.0.0.0:2567`, room `match`
- **Client:** Vite dev server, `http://0.0.0.0:5173`
- **Node:** >= 18 (dev host runs 22.17)
- Design details: [`docs/m2_plan.md`](docs/m2_plan.md) · Env audit: [`docs/m2_env_notes.md`](docs/m2_env_notes.md)

---

## Quickstart (3 commands)

```bash
npm install                      # install all workspaces (run once)
npm run build:shared             # compile @spike/shared (run once, and after shared edits)
npm run dev                      # start server (2567) + client (5173) together
```

Then open **http://localhost:5173**. You land on a **lobby menu** (no more
auto-join): one player clicks **Create** to host and gets a short **room code**;
everyone else clicks **Join** and pastes that code. The lobby shows two
6-slot team columns (A 藍 / B 紅, up to **12 players** total); joining
auto-seats you in the smaller side's lowest empty slot, and clicking any empty
slot on the opposite side switches your team — no extra button needed. The
host presses **Start** once at least two players are in with at least one per
side (2 players → 1v1, 4 → 2v2). To play both seats locally, open a second tab
and Join with the code from the first. `npm run dev` runs the server and Vite
concurrently; stop both with `Ctrl+C`.

Run the server and client separately if you prefer:

```bash
npm run start -w @spike/server   # server only  -> ws://0.0.0.0:2567
npm run dev   -w @spike/client   # client only  -> http://0.0.0.0:5173
```

### Verify the slice

```bash
npm test                              # shared unit tests (158 tests, ~99% coverage)
npm run smoke       -w @spike/server  # 2-client scripted smoke test (server must be running)
npm run integration -w @spike/server  # e2e: per-side direction, serve-clears-net, 2v2, 100ms PERFECT, determinism, net physics, map/captain/team-name, illegal-touch
npm run serve       -w @spike/server  # M2.7 offline unit tests: net tape/face resolve, weak-serve, angle sweep (no network)
```

Steady-motion jitter regression (spawns its own server, no separate `npm run dev` needed):

```bash
cd packages/server && npx tsx test/jitter.ts               # prints smoothness metrics
JITTER_ASSERT=1 npx tsx test/jitter.ts                      # exits non-zero on a threshold breach
```

Optional latency matrix (server must be running):

```bash
cd tools/latency-bot && npm install
npm run latency-test -- --url ws://127.0.0.1:2567 --latencies 0,50,100 --offsets 0,50,120
npm run latency-test -- --probe all   # matrix + jump-arc + dive + weak-serve + angle-sweep serve probes
```

---

## LAN play (Windows 11 host)

The **host** runs both servers; up to **three friends** (4 players total, for a
2v2) on the same Wi‑Fi open the host's LAN URL in a browser. The client derives
the WebSocket URL from `location.hostname`, so nothing is hardcoded — friends
just need the host IP, then the **room code** the host shares from the lobby.

1. **Host LAN IP:** currently **`192.168.10.121`** (Wi‑Fi adapter). Re-check with
   `ipconfig` → the IPv4 of the active `192.168.x.x` adapter.
   **Do NOT use `26.x.x.x` (Radmin VPN) — that is a virtual adapter and will not
   work for LAN play.** See [`docs/m2_env_notes.md`](docs/m2_env_notes.md).

2. **Open the firewall** (one-time, elevated / Administrator PowerShell):

   ```powershell
   netsh advfirewall firewall add rule name="VolleyBallGame Server 2567" dir=in action=allow protocol=TCP localport=2567
   netsh advfirewall firewall add rule name="VolleyBallGame Vite 5173"   dir=in action=allow protocol=TCP localport=5173
   ```

   Remove later with:

   ```powershell
   netsh advfirewall firewall delete rule name="VolleyBallGame Server 2567"
   netsh advfirewall firewall delete rule name="VolleyBallGame Vite 5173"
   ```

3. **Start on the host:** `npm run dev` (binds server `0.0.0.0:2567`, Vite `0.0.0.0:5173`).

4. **Host creates the room:** open **`http://localhost:5173`**, enter a name,
   click **Create**, and share the **room code** shown in the waiting room.

5. **Friends join:** each opens **`http://192.168.10.121:5173`** (replace with
   the host's current `192.168.x` IP), enters a name, clicks **Join**, and
   pastes the code. Teams auto-balance (A vs B, up to **6 slots per side / 12
   players total**) as players arrive; anyone can click an empty slot on the
   other side to switch teams before the match starts.

6. **Host starts:** with ≥2 players and at least one per side, the host presses
   **Start** (2 players → 1v1, 4 → 2v2). If someone leaves mid-match and empties
   a side, the surviving side wins by forfeit.

---

## Controls

| Key / Input        | Action                                             |
|--------------------|----------------------------------------------------|
| `W A S D` / Arrows | Move (8-directional, **relative to your view**: `W`/↑ = toward the net, `D`/→ = your screen-right — identical feel on both sides) |
| `Space`            | **按下即跳（press to jump），按住更高（hold to boost）** — a tap is a low hop, holding through the boost window floats to a higher apex. One stamina charge per jump; no mid-air jump. |
| `J` / `K` / `L`    | **切模式（switch mode）**: `J` = Dig 接球, `K` = Set 舉球, `L` = Spike 殺球. Instant switch, allowed anytime (even mid-charge). The active mode is shown in the HUD badge and tints your capsule (dig=blue, set=green, spike=red). |
| `H` / **左鍵（FPV）** | **H 蓄力出手（hold to charge, release to hit）** — hold to build charge, **release** to execute the touch/serve. Mode, aim (WASD), charge and timing are all sampled at the **release** instant. During the serve phase the aim comes from the **量角器指針（protractor needle）** instead of WASD — see below. In **first-person**, with pointer locked, **左鍵（LMB）is an H-equivalent** — mousedown charges, mouseup releases; third-person LMB does nothing. The click that re-acquires a dropped pointer lock never itself starts a charge. |
| `滾輪（mouse wheel）` | **九宮格選格（select the HUD skill cell）** — works in both views. Steps through the linear 9-cell order `[U,I,O,J,K,L,M,',','.']`; scroll down = next cell, up = previous, wrapping at both ends. Selecting `J`/`K`/`L` switches touchMode immediately; selecting a skill slot only highlights it in the HUD (a distinct highlight from the active mode) — touchMode stays on whatever `J`/`K`/`L` was last active. |
| `Q` / `E`          | **跳排選格（jump a HUD grid row up/down）**, keeping the same column; the middle row's serve cell is skipped (lands on the `J`/`K`/`L` column instead). Pressing `J`/`K`/`L` directly still works and syncs the selection to that cell. |
| `V`                | **切換第一人稱視角（toggle first-person view）** — 進入後滑鼠鎖定並隱藏（pointer lock）：滑鼠 X = 左右轉頭（yaw）、滑鼠 Y = 上下看（pitch，±60°，只影響視角不影響移動）。移動改為「看向哪走向哪」。**`V` 是唯一退出 FPV 的方式**；按 `Esc`／切換視窗／失焦導致 pointer lock 被瀏覽器強制解除時，**仍保持第一人稱**，只顯示「點擊畫面恢復視角控制」提示——點一下 canvas 即重新鎖定。 |
| `G`                | Toggle 3×3 debug grid                              |

Movement and touch aim (`dirInput`) are **player-view-relative**: pressing
"toward the net" or "right" does the same thing on both sides, because the
per-side follow camera and the input→world transform are mirrored together.

- **飛撲（dive):** a `Dig` release that just misses the ball's reach auto-attempts
  a lunging dive — a probabilistic save (closer = better odds) that plays a
  「救球!」/「撲空!」cue and briefly locks your movement. Costs stamina.

### 發球新玩法（M2.3 serve redesign）

**發球輪換（serve rotation, M2.6）:** each team serves in slot-index order; the
same player keeps serving after their team scores, and a side-out (the
receiving team wins the rally) advances that team to its next player — except
the very first time a team earns serve in a game, which does not advance.

During the serve phase, only the serving player can hit, and a **180° 半圓量角器
（half-circle protractor）** is drawn on the ground in front of them (everyone sees
it — the needle is a shared pure function of the synced server clock, so all
clients agree on the aim).

- **量角器指針（sweeping needle）:** the needle sweeps left↔right across the semicircle
  (a 1.6 s triangle wave). **放開 `H` 的瞬間指針指向哪，球就往哪飛（release-instant
  needle heading = serve direction）** — rotated about the "toward-net" axis, ∈ [-90°, +90°].
  WASD no longer aims the serve; you steer purely by **timing your release** to the sweep.
- **蓄力從 0（charge starts at zero）:** there is **no minimum-charge floor** anymore. The
  HUD charge bar starts empty and shows the raw value; you choose how hard to hit.
- **過蓄紅區（overcharge red zone, M2.4）:** the charge bar now extends past `1.0` up to
  `OVERCHARGE_MAX = 1.3` — the **right-most ~23% is a red segment** that flashes when you
  hold into it. Charging into the red **力量繼續增（more power / distance）**, but pays a
  **品質懲罰（quality penalty）**: quality is multiplied by `overchargeQualityMult(c) = 1 −
  0.5 × (c − 1) / 0.3`, i.e. **linear from ×1.0 at c=1.0 down to ×0.5 at the top of the red
  (c=1.3)**. It applies to **every touch, including serves**. Overcharging trades control for
  power — hold to the top only when you want maximum power and can eat the accuracy hit.
- **太軟會失誤（a too-soft serve faults）:** an under-charged serve doesn't clear the
  net — it either drops short or clips the net and rebounds (see **網子物理** below,
  M2.7) — and lands on your own side, which **scores the opponent** once the ball
  actually lands. Serve faults are a real, allowed outcome; don't feather it.
- **跳發（jump serve）:** press `Space` to jump, then **release the serve while still
  airborne**. A jump serve launches from a **higher hand point (SERVE_HAND_HEIGHT + 跳躍高度)**,
  gets a **×1.25 速度加成**, a **tighter scatter (品質 0.8 → 0.95)** and a flatter,
  slightly-downward arc solved from the release height. It costs **×2 stamina** on
  contact. A grounded release is a normal ground serve (品質 0.8).
- **跳發球發光（jump-serve glow, M2.4）:** a jump serve's ball lights up in a **橘紅
  emissive 發光**, and its trajectory afterimage takes the same warm tint, so both
  players can read at a glance that the incoming ball came off a jump serve. The glow
  clears when that ball is next touched or dies. (Server flags it via `BallLaunch.isJumpServe`.)
- **發球區移動（serve-zone movement）:** while grounded,未發球前你被夾在底線後（`|z| ≥ 9.8`，
  不得進場），但可在後界 `|z| ≤ 14` 內自由移動、後退，指針照常掃動。**起跳後不再夾限**
  （空中越線合法，符合真實排球規則）；球一發出限制全解除。

### 網子物理（net physics, M2.7）

**「觸網＝死球」已廢除。** The net is now a soft obstacle spanning the net plane
(`z=0`, `|x| ≤` half court width, `y ∈ [0, 2.43]`), and the server resolves a
crossing trajectory per contact:

- **擦網續打（tape pass）** — contact in the top 0.15u (the tape band): the ball
  passes **over**, velocity damped ×0.5 with an extra downward tug on `vy` so it
  drags back down onto the far side. A serve that just clips the tape and
  continues is a **let serve — a good ball, no special-casing.**
- **撞網反彈（face rebound）** — contact below the tape: a soft, near-vertical
  bounce back toward the hitter's own side (`vz` reverses at ×0.15, `vx` ×0.5,
  gravity keeps acting on `vy`) — the net absorbs most of the energy.
- Either way the server emits a **new `BallLaunch`** from the exact contact
  point/time (still a pure, deterministic function) flagged `isNetTouch: true`
  and broadcasts it — the ball can touch the net **multiple times** in one
  rally. Only a **ground/out landing** ends the rally now; net contact never
  does. The client needs no special handling (the trajectory is already
  continuous across the new packet) beyond an optional net-shake VFX (see
  below).

### 判分橫幅（scoring banner）

`DeathEvent` now carries a `scoringSide` and a `cause: 'ground' | 'out'` (the
old net-fault cause is gone, since net contact no longer ends a rally). The
client shows a centered banner for ~1.8s: **「{隊名} 得分 — {原因}」**, with
「球落地」for `ground` and「球出界」for `out`, using the scoring team's current
name (see 隊長/隊名 below). If a `DeathEvent` somehow arrives before any lobby
state has set team names yet, it falls back to the default 「A 隊」/「B 隊」
labels rather than showing something blank.

### 連擊 / 觸球次數犯規改為「觸球無效」

Double-touching (the same player touching twice in a row for their team) or a
team already at its 3-touch cap used to end the rally as a fault. Now the
server just **拒絕該次觸球** — `TouchResult.outcome` comes back
`'illegal_double'` or `'illegal_count'`, quality 0, **no new `BallLaunch`**,
and the ball keeps flying its original trajectory to a natural
ground/out landing. The client shows red feedback text (「連擊犯規！」／
「觸球次數用盡！」) — there's no key lock, since the server rejects every
repeat attempt the same way.

### 地圖選擇（indoor / outdoor）

The lobby host can toggle the court's **地圖（map）** between **室內（indoor）**
— wood-floor court, gymnasium walls/ceiling, cool white light — and **室外
（outdoor）** — sand-colored court, sky-blue background with a sun-direction
light, warm tone. Non-host players see the host's current pick; once the match
starts, everyone keeps the map the lobby had chosen. This is **purely visual**
— gameplay and court lines are identical on both maps.

### 隊長與隊名

Each team's **隊長（captain）** is whoever on that side has been in the team
longest (earliest join); if the captain leaves, the next-longest-tenured
teammate is automatically promoted. The lobby shows a 「隊長」badge next to the
captain's name, and **only the captain** can edit their team's name (click the
inline edit next to your team's name in the lobby; 1–12 characters, same
character rules as player names). Team names default to 「A 隊」/「B 隊」and
are used everywhere a side name shows up — the lobby header, the HUD scoreboard,
and the scoring banner.

### 角色視覺：名牌／臉／手臂（M2.5, 動作重構 M2.7）

Every player now renders as a full **角色**: the mode-tinted capsule **身體**, a
球形 **頭** with a swappable cartoon **臉**（普通／開心／囧 — 開心 1s after your own
PERFECT, 囧 1s after a WHIFF or 撲空), two procedurally-posed **手臂**, and a
billboard **名牌** floating above the head (white text, dark outline, kept a
constant on-screen size). Your character's whole group rotates to your
**facing**; in FPV your own head/body/nametag are hidden (but see the FPV
viewmodel below). Opponents read your charge mode from both tint and pose. A
soft **球影（ball shadow）** — a translucent black blob sized to roughly the
ball's own radius, so it no longer looms oversized at landing — tracks the
ball's XZ position on the ground (fading and shrinking-toward-the-ball as it
rises), including while it's held for a serve, so you can judge where it will land.

**動作重構（pose rework, M2.7）:** holding `H` now plays a **靜止預備式（still
ready pose）** per mode instead of an idle swing — `dig`: arms extended forward,
hands clasped (platform); `set`: hands raised overhead; `spike`: swing arm
cocked back high, off arm forward, aiming. **放開 `H` 的瞬間** plays a ~0.35s
**出手動作（release swing）** toward the ball (dig scoops low-to-high, set
pushes up, spike whips the swing arm down through contact). Unlocked/idle
movement still uses the plain idle/walk arm-swing; jump/dive overlays are
unchanged.

### 第一人稱視角（first-person view）

Press **`V`** to toggle FPV (see the Controls table). The camera sits at head
height and yaw initializes **facing the net** for your side. In FPV, movement and
touch aim rotate with your **look direction** (W = wherever you're looking,
projected to the ground) instead of the per-side mirrored third-person scheme —
both the client prediction and the server use the same `moveToWorld` transform, so
there is no rubber-banding. `H`, or **左鍵（LMB）** under pointer lock, charges/
releases the touch — see the Controls table. Third-person play is unchanged.

**FPV 手臂 viewmodel（M2.7）:** in first person you now see your own **簡化雙臂**
mounted at the bottom of the camera, driven by the same pose machine as the
third-person character (ready pose while charging, the release swing, serve
hold) — so FPV gets the same visual feedback third-person always had. Head,
body, and nametag stay hidden for yourself.

**發球方向弧（FPV serve-direction arc, M2.7 §7）:** a world-space protractor
needle is unreadable when you can't see your own body, so during **your own
serve, in first person only**, a **2D 半圓弧 HUD** appears bottom-center:
the same `sweepAngleDeg` pure function (synced to the server clock) drives the
needle, and the charge value fills the arc. Third-person still relies on the
world protractor and doesn't show this HUD.

**失焦不退出（M2.4）:** if the browser drops pointer lock (`Esc`, alt-tab, window
blur), FPV **stays active** — the camera keeps its first-person heading with yaw
frozen at its last value, the mouse becomes visible, and an overlay prompts
**「點擊畫面恢復視角控制」**. Clicking the canvas re-requests pointer lock and resumes
look control. Only pressing **`V`** actually leaves FPV.

### HUD 九宮格（bottom-right skill grid）

The bottom-right corner shows a translucent **3×3 grid** (does not block the center
of the screen):

```
        [U] [I] [O]
  [發球] [J] [K] [L]
        [M] [,] [.]
```

- **`J` / `K` / `L`** are the live modes (Dig / Set / Spike); the active one is
  highlighted in its colour (dig=blue, set=green, spike=red).
- **`U I O M , .`** are skill slots reserved for **M3** — shown as locked/empty
  dashed cells for now.
- **`[發球]`** lights up (with a ball/「發」cue) only during the serve phase when it
  is **your turn to serve**; otherwise it stays dim.
- **滾輪 / `Q` / `E`（M2.7 §8）** move a **selected-cell** cursor around the grid
  (see the Controls table) — landing on `J`/`K`/`L` switches touchMode
  immediately, landing on a skill slot only highlights that cell (a visually
  distinct highlight from the active-mode colour) without changing touchMode.

---

## 效能提示（rendering performance, M2.6 §5）

If a friend's frame rate is low (especially on laptops with two GPUs), the
browser may be running on the integrated GPU instead of the discrete one:

- We already ask for the fast path from our side: the renderer is created with
  `powerPreference: 'high-performance'`, and `devicePixelRatio` is capped at
  **1.5** (checked on resize too), so we don't oversample on high-DPI screens.
- The final GPU pick is still up to the **browser** and the **OS**. On
  **Windows 11**, go to **設定 → 系統 → 顯示 → 圖形（Settings → System → Display →
  Graphics）**, find your browser (Chrome/Edge/Firefox) in the list — or **加入
  (Add) → 瀏覽器捷徑 (browser shortcut)** if it isn't listed — open its options and
  set **圖形效能偏好 (Graphics preference)** to **高效能 (High performance)**. This
  forces the browser (and this page) onto the discrete GPU.
- Some laptops also expose this per-app in the GPU vendor's control panel
  (NVIDIA Control Panel / AMD Software) under program-specific 3D settings.

---

## 開發知識庫（for dev agents）

每輪必讀 [`CLAUDE.md`](CLAUDE.md)（協作模式、架構鐵律、指令與驗證閘、除錯鐵則）。
需要時才讀的情境知識庫在 [`docs/knowledge/`](docs/knowledge/)：

| 檔案 | 何時讀 |
|---|---|
| [`coordinate-systems.md`](docs/knowledge/coordinate-systems.md) | 動到移動／瞄準／相機／FPV／鏡像任何一處（地雷區，四個鏡像 bug 全史＋真值表守門） |
| [`netcode.md`](docs/knowledge/netcode.md) | 動到預測、對帳、延遲補償、ring buffer、wire 協定、schema |
| [`gameplay-rules.md`](docs/knowledge/gameplay-rules.md) | 動到品質函數、發球、輪換、犯規、網子物理、過蓄、體力 |
| [`client-visuals.md`](docs/knowledge/client-visuals.md) | 動到角色 rig、姿勢機、viewmodel、HUD 模組、地圖環境 |
| [`testing.md`](docs/knowledge/testing.md) | 寫測試、跑驗證閘、擴充 latency-bot 探針 |
| [`pitfalls.md`](docs/knowledge/pitfalls.md) | 開工前掃一眼；遇到怪 bug 先查有沒有前例 |

Source of truth 仍是實際程式碼（`packages/*`、`tools/latency-bot`）與規格書
（`spike_lab_spec_v0.2.md`、`docs/m2.*_spec.md`，最新編號＝現況權威）。

---

## Troubleshooting

- **Friend loads the page but the ball never moves / no opponent appears.**
  The WebSocket (port **2567**) is blocked. Confirm the `2567` firewall rule
  above and that any third‑party AV/firewall isn't overriding Windows Defender.
  Port 5173 controls page loading; 2567 controls gameplay.

- **Friend can't load the page at all.**
  Wrong host IP or blocked port 5173. Verify you gave them the **`192.168.x`**
  address (NOT the `26.x` Radmin VPN IP), both machines are on the same Wi‑Fi,
  and the `5173` firewall rule exists.

- **`Error: listen EADDRINUSE :::2567` (or `5173`).**
  A previous server/Vite is still running. Find and stop it:
  ```powershell
  netstat -ano | findstr 2567      # note the PID in the last column
  taskkill /PID <pid> /F
  ```
  (Same for 5173.)

- **Client connects to the wrong server.**
  The client always talks to `ws://<page-host>:2567`. Make sure the friend
  loaded the page from the host's LAN IP, not `localhost`.

- **Changed something in `packages/shared` and it isn't picked up.**
  Re-run `npm run build:shared` (the server/client import the compiled barrel).
