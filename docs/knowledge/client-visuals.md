# Client 視覺層 — 角色 rig、姿勢機、viewmodel、球、HUD、Lobby、環境

全部路徑在 `packages/client/src/`。**視覺常數與玩法常數嚴格分離**：本層任何數字調整都不得
影響判定（見 pitfalls #8）。角色視覺全數 tunable 集中在 `scene/character/characterConstants.ts`。

---

## 1. 角色 rig：`scene/character/`

### playerCharacter.ts — `PlayerCharacter`（`scene/player.ts` 只是 barrel 轉出）
組裝：`THREE.Group`（`rotation.order='YXZ'`＝先 yaw 再 dive pitch），身體 Capsule（原點＝腳底）、
頭 Sphere（繞 Y −π/2 使臉朝 +Z）、兩手臂（肩 pivot）、nametag sprite。建構
`(name, isLocal, initialFacing)`。`CharacterFrame` 驅動每幀 `update`：`feet, facing, snapFacing
(本地 true 即時／遠端 false slerp), speed01, airborne, charging(本地only), serving, ballWorld, cameraPos`。
- `setMode(mode)`：以 `MODE_TINT` 染身體；本地額外 emissive ×`LOCAL_EMISSIVE_MULT(0.35)`。
- `showHappy()/showDazed()`：換 head material 的臉貼圖（`HAPPY_FACE_MS/DAZED_FACE_MS=1000`）。
- `triggerTouch(mode)`：開 `TOUCH_POSE_MS(350)` 揮擊窗。`triggerDive(ms)`：dive lunge。
- `resolveAim`：touch 有球 → world delta 再 `applyAxisAngle(UP, −facing)` 轉角色本地；
  **無球（air swing, M2.8 §3）→ 本地 +Z（沿 facing 揮）**；dive → (0,−0.2,1)。
- `updateViewmodel`：**只呼叫 viewmodel.update，不再對 aim.x 取負**。唯一鏡像＝
  `FPV_VM_GROUP_YAW`（見 coordinate-systems.md §8）。曾多做 x 取負＝雙重鏡像 bug。
- `updateFacing`：`snapFacing` 則直接設；否則最短弧 `atan2(sin Δ, cos Δ)` 以 `FACING_LERP_RATE(12)/s` slerp。
- `updateNametagScale`：距離量化縮放（見下）。`dispose()`：釋放 body/head/arms/viewmodel/nametag 幾何與材質
  （**臉貼圖是模組單例、故意不 dispose**）。

**K vs L ready pose（owner-specified）**：K=`set`＝對稱雙手過頭 framing；L=`spike`＝不對稱前上揮起。

### armPose.ts — `ArmPoseMachine` 姿勢機
`PoseKind = idle | charging | touch | dive | serveHold`。`PoseInput`: `kind, mode, speed01,
airborne, clockS, touchProgress01, localAim`。**優先序：dive > touch > serveHold > charging > idle/move**，
jump overlay（`JUMP_ARM_RAISE_RAD=26°` 前抬）只疊在 charging 與 idle 分支。
- charging = 靜態 ready pose（`CHARGE_POSES[mode]`，FPV 用 `FPV_CHARGE_POSES`）。
- touch = 放開瞬間 `ACTION_SWINGS[mode]`（startPitch→endPitch 由 `touchProgress01` smoothstep）揮過球。
  spike 只有慣用手（右）揮，另一手用 `SPIKE_TOUCH_BALANCE`。
- serveHold = 慣用手托球（`SERVE_HOLD_DOMINANT/OFF`）。idle = antiphase 走路擺臂
  （`SWING_FREQ=6.5, SWING_AMP_RAD=0.7, SWING_IDLE_FACTOR=0.12`）+ `MODE_LEAN`。
- `update`：slerp 至 target，`alpha = min(1, POSE_SLERP_RATE(10)×dt)`。
- **SIGN NOTE**：手臂靜止指向 (0,−1,0)；ArmEuler.x 負＝前擺（+Z/網）、正＝後擺、±π＝過頭。

### faceTextures.ts — 3 表情
`FaceExpression = normal | happy | dazed`，CanvasTexture 畫一次、**模組單例快取**、永不 dispose、
每個角色共用。`GameSession.handleTouchResult` 依 broadcast 的 TouchResult 觸發**被指認角色**
（本地 or 遠端）：PERFECT→happy；WHIFF/dive_fail/illegal_*→dazed。

### fpvViewmodel.ts — 相機掛載的 viewmodel
兩支簡化 capsule 手臂，parent 到相機，用**同一** `ArmPoseMachine`（傳 `FPV_CHARGE_POSES`）。
group `rotation.y = FPV_VM_GROUP_YAW(π)`、`renderOrder = FPV_VM_RENDER_ORDER(100)`。
材質 `transparent:true, depthTest:false, depthWrite:false`——**因為 opaque pass 先於所有
transparent 繪製、無視 renderOrder**，透明網會蓋掉不透明手臂；改成 transparent 才能靠高
renderOrder 最後畫、depthTest off 不被世界深度剔除（pitfalls #4）。FPV 專屬 charge pose：
第三人稱姿態從 FPV 看會掉出畫面（dig 掉底、set splay），故 dig/set 各自調過（spike 沿用）。

### nametag.ts — billboard + 距離量化縮放
`THREE.Sprite`（自動 billboard），`renderOrder=10` 蓋在角色上、depthTest off。名字 >14 字截為 13+「…」。
`PlayerCharacter.updateNametagScale` 依相機距離縮放：`clamp(dist/NAMETAG_REF_DISTANCE(8), MIN(0.45), MAX(3.2))`，
**量化到 `NAMETAG_SCALE_QUANTUM(0.1)` 步階**——避免每幀相機微抖動重新取樣（閃爍）。追隨相機讓本地
玩家距離近乎固定，故本地名牌釘在單一步階；遠端以 0.1 平滑跳。

---

## 2. 球與場景：`scene/`

### ball.ts — `BallView`
位置**純粹由最新 `BallLaunch` 經 shared `ballPosition` 導出**（無本地物理），除非 serveHold 把球
釘在發球者手上（`+SERVE_HAND_HEIGHT(1.5)`, `+forwardSign×SERVE_HAND_FORWARD_OFFSET(0.4)`）。
- 球 mesh 半徑 `VISUAL_BALL_RADIUS(0.14)`（≠ gameplay `BALL_RADIUS(0.15)`）。
- **blob shadow**：`CircleGeometry(SHADOW_RADIUS = VISUAL_BALL_RADIUS×0.9)`，opacity
  `SHADOW_BASE_OPACITY(0.4)×clamp01(1 − ballY/SHADOW_FADE_HEIGHT(8))`，隨高度略放大。
- **跳發橙光+trail**：`setLaunch` 見 `launch.isJumpServe===true` 才上 emissive
  `JUMP_SERVE_EMISSIVE(0xff3a00, 強度0.9)` + `TRAIL_GHOSTS(10)` 殘影；持續到下次觸球
  （新的無 flag BallLaunch）或死球（`clearJumpServeTint()`）。
- `freezeAtMs` 來自 shared `firstEvent`（球到落點/事件就凍住）。

### court.ts — `buildCourt` → `CourtHandle`
地面/邊線/網面+兩柱/3×3 debug grid（預設隱藏，'g' 切）。**網 wobble 單一 rAF**
（`createNetShaker`）：一 rally 可多次觸網，`triggerNetShake()` 只重設 `shakeStart`，
**共用一個 running loop**（不 per-trigger 開新 rAF 疊加搶 `rotation.z`）。wobble =
`sin(t×π×3)×NET_SHAKE_AMPLITUDE_RAD(0.08)×(1−t)`，`NET_SHAKE_DURATION_MS=220`。

### environment.ts — indoor/outdoor 主題
`applyMapEnvironment(scene, court, map)` 依 `MapId` 套背景+兩盞燈+地面色（**純視覺**，
線與網不變）。indoor：木地板 `0x8a6a45`、暗牆背景、冷白環境光。outdoor：沙 `0xd9c48b`、
天藍背景 `0x7ec8f0`、暖陽 directional 1.05。每次 LobbyState 呼叫；比賽開始後鎖定當時 map。

renderer 效能（`renderer.ts`）：`pixelRatio` cap `MAX_PIXEL_RATIO(1.5)`（構造與 resize 都套，
防弱內顯 2×/3× 吃滿）、`powerPreference:'high-performance'`。相機常數在 `config.ts`（FOV 55、
back offset 6、height 3.4、pitch 18、follow lerp 0.12）。

---

## 3. HUD：`hud/`

- **hud.ts** `Hud`：in-game orchestrator，持有並協調 scoreboard / roster / skillGrid / serveArc /
  體力+蓄力 bar / 所有 popup（grade/dive/player-left/score-banner 走 `TransientPopup`）/ FPV lock prompt /
  PERFECT flash / 連線 overlay / M2.9 §5 練習 chip（`practiceChip`，`buildPracticeChip` 建於
  `hudDom.ts`，`setPracticeMode(active)` 切顯隱＋連動隱藏 scoreboard，`resetMatchState` 會關掉它）。關鍵：`setCharge`（÷`OVERCHARGE_MAX`，>1 時開 `hud-charge-over` 紅）、
  `updateServeArc(visible, needleDeg, charge, side, yaw)`、`showTouchResult`（回 true＝PERFECT hitstop
  `PERFECT_HITSTOP_MS=100`）、`setSelection` vs `setMode`（雙高亮，見 skillGrid）。
- **scoreboard.ts** `Scoreboard`：頂中玻璃卡、發球側脈動點、`DEUCE_SCORE_THRESHOLD(14)` 雙方≥14 轉琥珀、
  只 pop 變動的位數。
- **skillGrid.ts** `SkillGrid`：右下 3×3（中列多一格發球）。**雙高亮**：`setMode` 開
  `hud-grid-mode-active`（藍/綠/紅＝當前觸球模式）；`setSelection(index)` 開 `hud-grid-selected`
  （白框＝滾輪/Q-E 選中格）——**兩者分離**。`selectableCells` 線性序 `[U,I,O,J,K,L,M,',','.']`
  （發球不可選，對齊 keyboard `SKILL_SEQUENCE`）。
- **serveArc.ts** `ServeArcHud`：FPV 底部 2D 半盤，yaw-aware 針（詳見 coordinate-systems.md §7）。
- **transientPopup.ts** `TransientPopup`：通用「播 CSS 動畫 durationMs 後自動隱藏」，`show` 前
  **強制 reflow（`void offsetWidth`）**讓連續呼叫每次重播動畫。
- **hudText.ts** 靜態文字/色表（GRADE_COLOR、DIVE_TEXT、ILLEGAL_TOUCH_TEXT、DEATH_CAUSE_TEXT、
  CONTROLS_HELP、SERVE_HINT…）。**hudDom.ts** 共用 DOM builder。**hudStyles.ts** `injectHudStyles()`
  單例，串接 scoreboard/skillGrid/serveArc + 其餘 CSS。

---

## 4. Lobby：`lobby/`

- **lobbyView.ts** `LobbyView`：M2.9 起四畫面 MENU（委派給 `MenuScreen`）/ WAITING / GAMEOVER /
  TRANSITION（練習房「進入練習場…」過場卡）。`LobbyCallbacks` 新增 `onPractice`（其餘
  onCreate/onJoin/onStart/onRequestSlot/onSetMap/onSetTeamName/onLeaveToMenu 不變）。WAITING＝房碼+複製、
  A/B 雙欄 slot 格（每 broadcast 重建 12 卡）、mapPicker（host only）、Start（host only，`canStart` 才啟用）、
  hint、Leave。`setPhaseVisibility`：`'lobby'`→顯示 WAITING（或 TRANSITION，見下）、`'gameover'`→
  交給呼叫端 `showGameOver()`、其餘隱藏讓 3D 場景露出。
- **menuScreen.ts** `MenuScreen`（M2.9 §3/§5/§6）：選單本體，`LobbyView` 只把它當一張 screen 掛載。
  `buildBrand`（logo+SPIKE LAB 標題+副標）、`buildCards`（練習模式／多人對戰兩張斜切
  `clip-path` 卡，`menu-card-practice`/`menu-card-versus`）、`buildNamebar`（選手名牌輸入列，
  兩模式共用、`nameOrDefault()` 空值退回 `DEFAULT_PLAYER_NAME`）、`buildPanel`（多人子面板：開房間／
  房碼加入，`openPanel/closePanel` 滑入滑出、`cardsView.style.visibility='hidden'` 讓卡片區留白但
  不佔位）。`reset()`（每次 `showMenu()` 呼叫）強制 `closePanel()`，避免上次的錯誤/面板狀態殘留到
  下次開選單。
- **menuStyles.ts** `injectMenuStyles()` 單例：**`--spike-navy/blue/red/orange/cream` 五個 CSS
  custom properties 定義在 `:root`**（不是 scope 在 `.lobby-menu`），因此 WAITING/GAMEOVER 玻璃卡
  （lobbyStyles.ts）能共用同一色板而不必重複定義。左深右透斜向 scrim
  （`linear-gradient(103deg,...)` + radial vignette）讓下方 orbit 運鏡的球場透出來。
- **volleyballLogo.ts** `createVolleyballLogo()`：inline SVG（圓+三弧線縫線），零外部資產，
  `stroke="currentColor"` 讓 CSS 用 `--spike-orange` 上色，wrapper class 帶慢速自轉動畫
  （`prefers-reduced-motion` 時關閉）。從 menuScreen.ts 抽出（§6 <400 行門檻）。
- **選單背景運鏡 orbitIdle**（M2.9 §4，`scene/renderer.ts`）：`SceneRenderer.orbitIdle(nowMs)`
  是**無狀態純函式式**相機擺位（角度=f(nowMs)，半徑/高度/角速度/lookAt-Y 由 client `config.ts`
  的 `MENU_ORBIT_RADIUS(13)/HEIGHT(6)/SPEED(0.05 rad/s)/LOOK_Y(1)` 決定），`main.ts` 動畫迴圈
  **只在 `connection.room === undefined` 時**每幀呼叫。一旦進房，`setCameraForSide`/
  `followPlayer`/FPV 接管，orbit 在該房間生命週期內永不再被呼叫——**殘留狀態鐵則**：因為函式
  無狀態、閘門只看 `room` 是否存在，入房→離房→再入房不需要額外 reset 邏輯即可正確交接。
- **practiceActive（`LobbyView` 私有）vs isPractice（`GameSession` 私有）——同期新增、易混淆、
  分工完全不同、彼此互不知道對方**：
  - `LobbyView.practiceActive`：只管「lobby overlay 三張畫面（MENU/WAITING/TRANSITION）選哪
    張」。`showPracticeTransition()` 設 true 並顯示 TRANSITION 卡；`showMenu()` 重設 false。
    `setPhaseVisibility('lobby')`：true→維持 TRANSITION 卡、false→WAITING。**存在理由**：
    server snapshot 每 tick 廣播（含 `phase==='lobby'`），practice autostart 有 0–300ms
    （`PRACTICE_AUTOSTART_MS`）窗口 phase 仍是 `'lobby'`；沒有這個 flag 撐住，畫面會在跳進
    serve phase 前閃一下 WAITING room。
  - `GameSession.isPractice`：管**進房後**的呈現——scoreboard 隱藏＋HUD 練習 chip 顯示
    （`hud.setPracticeMode`，練習 chip 見 `hud/hudDom.ts buildPracticeChip` / `hud.ts`
    第 §3 節）、DeathEvent 中性文案（`hud.showPracticeResetBanner`，文字在
    `hudText.ts PRACTICE_RESET_TEXT`）。由 `main.ts onRoomJoined` 傳進
    `wireRoom(room, keyboard, isPractice)`，`reset()` 清回 false。**client 純本地判斷**
    （自己建的房自己知道是不是練習房），完全不靠任何 wire 欄位。
- **WAITING / GAMEOVER 換皮，class 名不動**：同 palette／斜切語彙、`.lobby-glass-card`
  （opacity ~0.62–0.78 半透明玻璃，`backdrop-filter: blur` 露出後方球場），**但 slot grid /
  map picker / team header 的 class 名一律不改**（`lobby-slot-grid`、`lobby-slot-card`、
  `lobby-slot-card-anim` 等）——`slotAnimation.ts` 的 `computeChangedSlotKeys` 與
  `lobbyStyles.ts` 的 `@keyframes lobby-slot-pop` 都綁死這些名字，換皮只能加殼（外層卡片/
  背景/字體），不能連結構一起動。
- **mapPicker.ts** `MAP_OPTIONS`（室內/室外），host 可點、非 host 禁用只標當前。
- **teamHeader.ts** 隊名 inline 編輯：captain-only ✎ 換成 input，`TEAM_NAME_MAX_LEN=12`（server 再驗），
  Enter/blur commit（僅非空且有改）。`CH.SET_TEAM_NAME` 只帶名字，side 由 server 從 sender 推斷。
- **slotAnimation.ts** diff-based：`computeChangedSlotKeys(prev, state)` 回傳 `playerId` 有變的 slot key
  集（涵蓋 join/leave/switch），只對真正變動的卡播 pop 動畫。首次掛載無 prev → 空集不動畫。
- **lobbyStyles.ts** `injectLobbyStyles()` 單例，含 `@keyframes lobby-slot-pop`。

---

## 5. Orchestration：`app/gameSession.ts` `GameSession`

- `wireRoom`：註冊 onSnapshot/onBallLaunch/onTouchResult/onLobbyState/onDeath。LobbyState →
  `applyMapEnvironment`（視覺）。Death → `clearJumpServeTint` + `showScoreBanner`。
- **TouchResult 驅動臉/dive**（`handleTouchResult`）：TouchResult 廣播帶 playerId，
  `isOwn = playerId===sessionId`。HUD grade 文字 local-only。happy/dazed 套**被指認角色**（本地 or 遠端）。
  只有 dive_success/dive_fail 驅動 dive 呈現：本地 `beginDiveLock`，遠端 stamp `lastTouchBurstMs`
  防同時的 isCharging 落緣又觸發普通揮擊，再 `triggerDive`。
- **serveArc yaw 餵入**（`updateServeArc`）：只在 FPV+自己發球顯示，`needleDeg =
  sweepAngleDeg(serverTimeNow − phaseStart)`，把 **live FPV yaw（`viewController.lookYaw`）**
  餵進 `hud.updateServeArc`，每幀重投影（詳 coordinate-systems.md §7）。
- **本地發球上升緣呼叫 `viewController.faceNetForServe()`**（edge-only，不與滑鼠打架；詳 coord §6）。
- **`reset()`＝單一 room 生命週期 teardown**：移除並 `dispose()` 本地與所有遠端角色（**dispose 幾何/材質
  防 GPU leak**）、清 remotePlayers/knownPlayerIds、`protractor.hide()`、`viewController.setActive(false)`、
  `keyboard.clearListeners()`+`setInputActive(false)`、`ballView.reset()`、`hud.resetMatchState()`。
  重進房前務必 reset，否則 listener 重複註冊、殘留角色 leak（pitfalls #3/#4）。
- `ensureLocalPlayer`：建 `LocalPlayer` + `PlayerCharacter`、`attachFpvViewmodel(scene.camera)`、
  `setCameraForSide`、`viewController.setSide`。

## 6. 輸入：`input/keyboard.ts` `KeyboardInput`

按鍵：WASD/方向鍵移動、Space 跳（press 上升緣、held 每幀送）、J/K/L 即時切 touchMode（蓄力中也可）、
**H 或 FPV 鎖定時 LMB＝蓄力**（hold 蓄、release 執行）、滾輪/Q/E 選格、V 切視角。
蓄力：`chargeFrom = min(OVERCHARGE_MAX, heldSec × CHARGE_RATE)`（可蓄進紅區，capped 1.3）。
`startCharge` idempotent（H+LMB 不疊）、`releaseCharge` 發 `RawTouchEvent`、`isCharging()` 每幀進 InputFrame。
`cancelPendingCharge()`＝pointer 重鎖時 ViewController 吞掉 mousedown 時呼叫，清蓄力（防幽靈發球，pitfalls #7）。
`setInputActive(false)` 也會清 pending 蓄力。**注意：無 `mouseDownAtMs` 欄位**，蓄力計時只靠
`chargeKeyDownAtMs`（LMB 路徑經 ViewController 驅動同欄）。`clearListeners()` 是 §4 teardown 的一環。
