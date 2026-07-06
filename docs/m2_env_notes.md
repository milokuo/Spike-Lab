# M2 Environment Audit — Windows 11 (C:\src\VolleyBallGame)

Audit date: 2026-07-05
Machine: Windows 11 Education 10.0.26200

All checks below are read-only. No installs performed, no firewall rules changed.

## 1. Toolchain versions

| Tool | Version / Path |
|------|-----------------|
| node | v22.17.0 |
| npm  | 10.9.0 |
| pnpm | not found on PATH |
| yarn | not found on PATH |
| git  | `C:\Program Files\Git\cmd\git.exe` |

Note: project uses npm (pnpm/yarn not installed). If the project wants pnpm/yarn, it will need to be installed separately (not done here per read-only instructions).

## 2. LAN IPv4 address

Adapters found via `ipconfig`:

- **Wireless LAN adapter Wi-Fi: `192.168.10.121`** ← this is the private LAN IP to use for local multiplayer testing (phone/other devices on same Wi-Fi).
- Ethernet adapter "Radmin VPN": `26.148.238.222` — this is a virtual VPN adapter, NOT a real LAN address. Do not use for local network testing.
- Several other adapters (Ethernet, additional Wireless LAN entries) had no IPv4 address assigned (disconnected/unused).

**LAN IP to use: `192.168.10.121`**

## 3. Port availability (2567, 5173)

Checked via `Get-NetTCPConnection -LocalPort <port>`:

- **Port 2567**: no active connections/listeners found → **free**
- **Port 5173**: no active connections/listeners found → **free**

(2567 is the typical default Colyseus/game-server port; 5173 is the typical Vite dev-server port.)

## 4. Windows Firewall profile status

`netsh advfirewall show allprofiles state`:

| Profile | State |
|---------|-------|
| Domain  | ON |
| Private | ON |
| Public  | ON |

All three firewall profiles are currently **enabled**.

## 5. Existing Node.js firewall rules

`netsh advfirewall firewall show rule name=all` filtered for "node":

- Rule "Node.js JavaScript Runtime" exists, **Enabled: Yes**, Direction: In, Action: Allow
- Present for both **Public** and **Private** profiles (multiple duplicate entries observed, likely from repeated Node installs/updates)
- Domain profile entry not observed in the filtered output (unknown/not confirmed)

This means inbound connections *to node.exe itself* are already broadly allowed by executable-based rule, on Private and Public profiles. However, this is a rule tied to the `node.exe` binary path, not a port-specific rule — it does not guarantee ports 2567/5173 specifically are open if Node is later blocked by a more specific rule, or if a different binary/port combination is used. For reliability and clarity, explicit port rules are still recommended (documented below, not executed).

## Commands to open ports 2567 and 5173 inbound (DOCUMENTED ONLY — NOT EXECUTED)

Run these later, in an elevated (Administrator) PowerShell or cmd, when ready to allow LAN devices to reach the dev server and game server:

```powershell
# Allow inbound TCP 2567 (game server, e.g. Colyseus)
netsh advfirewall firewall add rule name="VolleyBallGame Server 2567" dir=in action=allow protocol=TCP localport=2567

# Allow inbound TCP 5173 (Vite dev server)
netsh advfirewall firewall add rule name="VolleyBallGame Vite 5173" dir=in action=allow protocol=TCP localport=5173
```

To later remove these rules if no longer needed:

```powershell
netsh advfirewall firewall delete rule name="VolleyBallGame Server 2567"
netsh advfirewall firewall delete rule name="VolleyBallGame Vite 5173"
```

To verify the rules after adding them:

```powershell
netsh advfirewall firewall show rule name="VolleyBallGame Server 2567"
netsh advfirewall firewall show rule name="VolleyBallGame Vite 5173"
```

## Summary / Blockers

- No blockers found. Node/npm are installed and current; git is installed; pnpm/yarn are absent but not required unless the project mandates them.
- LAN IP `192.168.10.121` should be used for other devices to connect (not the Radmin VPN IP).
- Ports 2567 and 5173 are currently free.
- Firewall is ON for all profiles, but Node.js already has an inbound allow rule for Private/Public profiles, so basic connectivity should work. Explicit port rules (commands above) are recommended for robustness and should be run manually by the user with admin rights when needed — not executed as part of this audit.
