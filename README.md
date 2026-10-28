# Cabinet Mapper server

A self-hosted version of Cabinet Mapper. One Node.js program serves the app, stores the data and talks to Claude.

- **Studio**, in the web browser: build a cabinet layout from a photo and its electrical drawings, fix mismatches, add the PLC program. Editors change; viewers look (read only).
- **Field view**, in the Android phone app: open a cabinet, tap a component, see its wiring, its drawing and how to test it, diagnose with the PLC.

Every change saved in the Studio shows in the phone app a few seconds later. There is no validation step any more.

## Run it

You need Node.js 18 or newer. There is nothing to install with npm.

```
cp .env.example .env      # then edit .env
node server.js
```

Open `http://localhost:8080`. If you did not set `EDITOR_CODE`, the server prints one when it starts.

With Docker:

```
docker build -t cabinet-mapper .
docker run -d --name cabinet-mapper -p 8080:8080 -v cabinet-data:/data \
  -e EDITOR_CODE=choose-one -e VIEWER_CODE=choose-another \
  -e ANTHROPIC_API_KEY=sk-ant-... -e TRUST_PROXY=1 cabinet-mapper
```

## On Windows: three files to double-click

- **start-server.bat** starts the server. It checks that Node.js is installed, shows the addresses to type on the phone, and starts the server again by itself if it ever stops (so the machine log goes on). Close its window to stop it.
- **start-with-windows.bat** makes the server start by itself, minimized, each time you sign in to Windows. Run it again to undo that.
- **open-firewall.bat** lets the phones reach the server: it opens the server's port in the Windows firewall (it asks for administrator rights once). Use it when the phone cannot open `http://<PC address>:<port>` on the same network.
- **check-network.bat** finds why a phone cannot open the server on the network (it changes nothing; it writes network-check.txt).
- **start-tunnel.bat** opens the server to the internet with a free Cloudflare quick tunnel (see below).
- **install-android.bat** installs or updates the phone app over a USB cable. On the phone, once: Settings, About phone, tap Build number 7 times, then Developer options, USB debugging on. The first time, it offers to download Google's free tool adb (7 MB) into this folder. It finds the app in `public\CabinetMapper.apk`, or next to the .bat file.

## Settings

| Variable | What it does |
|---|---|
| `EDITOR_CODE` | Access code for the Studio. Generated and printed at start if empty. |
| `VIEWER_CODE` | Access code to look without changing anything: the phone app, or the Studio read only. If empty, only editors can sign in. |
| `ANTHROPIC_API_KEY` | Claude API key. Create one in the Claude Console: https://platform.claude.com |
| `PORT` | Port to listen on. Default 8080. |
| `DATA_DIR` | Where data is kept. Default `./data`. |
| `TRUST_PROXY` | Set to `1` behind a reverse proxy or a hosting platform that terminates HTTPS. |
| `HTTPS_PROXY` | Address of the proxy, if the server reaches the internet through one, for example `http://proxy.example.com:8080`. |
| `AI_MODEL`, `AI_MODEL_COMPLEX`, `AI_MODEL_QUICK` | Claude model IDs. Defaults: `claude-sonnet-5-5`, `claude-opus-5-5`, `claude-haiku-4-5-20251001`. |
| `AI_MAX_PER_HOUR` | Upper limit on Claude requests per hour. Default 200. |
| `SESSION_SECRET` | Signs the sign-in cookie. Generated and kept in the data folder if empty. |

Without `ANTHROPIC_API_KEY` the app runs, but components, tags and wires are entered by hand.

## Putting it on the internet

- **Use HTTPS.** The access codes and the cabinet data travel over the connection. Put the server behind a reverse proxy that provides HTTPS (Caddy, nginx, or your hosting platform) and set `TRUST_PROXY=1`.
- **Keep the data folder on a persistent disk.** On platforms with temporary disks, attach a volume and point `DATA_DIR` at it.
- **Choose long access codes.** Anyone with the editor code can change and delete cabinets. After ten wrong tries from one address, sign-in is blocked for ten minutes.
- **Technicians** use the phone app, connected to this server with the viewer code.


### Quickly, with a Cloudflare quick tunnel (free, no account)

1. Start the server (`start-server.bat`) and wait for "running on port".
2. Double-click `start-tunnel.bat`. The first time it downloads `cloudflared.exe` (Cloudflare's tunnel program) into this folder. After a few seconds its window shows an address like `https://word-word-word-word.trycloudflare.com`.
3. Open that address in a browser, or in the phone app: "Connect to a server", type the address (the app uses https for such a name by itself).

Keep both windows open. If it does not work:
- **Error 1033 or 530** from Cloudflare: the tunnel window was closed, or the address is an old one. Each start of `start-tunnel.bat` gives a NEW address; use the one shown now.
- **Error 502**: the tunnel runs but the server does not: start `start-server.bat`. The tunnel must point to `http://127.0.0.1:8080` (not https, not port 8443).
- **The page opens but sign-in fails**: type the address with `https://`. Sign in with the editor or viewer code as usual.
- **The phone app shows the old address**: in the app, "Connect to a server" again with the new address.

The server sees that a request came through the tunnel. Over the internet, everything can be seen, but **reset from the phone is refused**: it works only on the plant network (set `RESET_FROM_INTERNET=1` to allow it, not advised). Anyone who has the address can try the access codes: use long ones (`EDITOR_CODE`, `VIEWER_CODE` in `.env`); after 10 wrong codes an address waits 10 minutes.

A quick tunnel is for trying and for occasional use: its address changes and it has no guarantee. For a fixed address, make a free Cloudflare account and a named tunnel on your own domain (Cloudflare Zero Trust, Networks, Tunnels), pointing to `http://127.0.0.1:8080`.
## The app on phones

The Field view is the Android app `CabinetMapper.apk`. Copy it into the folder `public` of the server; phones then get it from `http://<this computer>:8080/install` (signed in), which also says what to enter in the app. Allow port 8080 in the Windows firewall for the plant network.

In the app, enter the address of this server and sign in. The app shows the cabinets live and keeps a copy on the phone (drawings and photos included). Where the server cannot be reached, it opens that copy by itself.

The browser on a phone opens the Studio. iPhones have no app.

## Data and backups

Everything is in `DATA_DIR`:

- `docs/` holds one JSON file per cabinet and drawing page (`published/` holds the validated copies of earlier versions; no longer used).
- `assets/` holds uploaded photos and drawing pages.
- `editor-code.txt` and `session-secret` are created on first start.

To back up, copy the folder. To restore, put it back and start the server.

A new installation starts empty. Earlier versions came with three example cabinets (Cabinet 1, 2 and 3): this version removes them from the data folder at its first start. A `seed` folder left over from an earlier version is no longer used and can be deleted.

## What Claude is used for, and what it costs

| Action | Model setting | Notes |
|---|---|---|
| Detect components in a photo | `AI_MODEL` | One request per photo. |
| Read a drawing page | `AI_MODEL_COMPLEX` | One request per page, with the page plus four enlarged quarters. |
| "Ask Claude about this exact part" | `AI_MODEL` | Text only. Viewers can use it. |

All requests are billed to your API key. The key stays on the server and is never sent to the browser. Photos and drawing pages are sent to the Claude API when you press Detect or Read. API documentation: https://platform.claude.com/docs

## Cabinet files (no API key needed)

A cabinet file (`name.cabinet.json`) holds one complete cabinet: photo, components, drawing pages and wires. In Studio, press **Add a cabinet file** on the first screen and choose the file; it is in the phone app as soon as it is added. Adding a file never changes an existing cabinet; a second copy gets "(2)" after its name.

A file can also hold several cabinets that are wired to each other (`"version": 2`, a `"group"` name and a `"cabinets"` list whose entries look like the single cabinet below). They are added together and share the group name. Inside a group, a wire that ends on a tag of another cabinet is shown as a link to that cabinet: in the wiring list of the component, as a block under the layout, and in the **Connections** screen of the group. Tags must be unique inside a group. You can also put your own cabinets in a group: open the List tab of each cabinet and give them the same group name.

The file is plain JSON, with pictures stored inside it as data URLs:

```
{ "format": "cabinet-mapper", "version": 1, "name": "...", "desc": "...",
  "photo": "data:image/jpeg;base64,...",            (or null)
  "comps": [ { "t": "contactor", "tag": "K1", "tagOk": true, "x": 0.12, "y": 0.30, "w": 0.03, "h": 0.06 } ],
  "ext": [ "M1", "S30.3" ],                          (tags that are outside the cabinet)
  "sheets": [ { "name": "Page 1", "image": "data:image/jpeg;base64,...",
                "reading": { "title": "", "page": "", "potentials": [], "devices": [], "wires": [] } } ],
  "manual": [ { "a": "K1", "at": "A1", "b": "X1", "bt": "4", "no": "W12" } ] }
```

A component can list its pins: `"pins": [ { "p": "1", "l": "I30.0", "x": "function text" } ]` (pin, label, text). Pins without an entry are taken from the wires. Component positions are fractions of the photo (0 to 1). A page's `reading` uses the same format Claude returns when the app reads a page.

## If detection or reading fails

The app shows what the server said, and the same line is written to the server's output. To test the Claude connection without the app, stop the server and run:

```
node server.js --test-claude
```

It sends one tiny request per model and prints the result. Common answers:

- **"credit balance is too low"**: add billing or credits in the Claude Console.
- **"The Claude API key was refused"**: the key in `.env` is wrong, expired or revoked.
- **"could not connect"**: this server cannot open a connection to `api.anthropic.com` on port 443. Either a firewall blocks it, or the server reaches the internet through a proxy. A browser uses the Windows proxy settings by itself; this program does not, so set `HTTPS_PROXY` in `.env`. Proxies that require Windows (NTLM) sign-in are not supported.

## Updating to a newer version

Replace `server.js` and the `public` folder with the new ones, then restart. Keep your `.env` file and your `data` folder; they are not part of the update.

## How it is built

- `server.js`: the whole server. Routes: `/api/login`, `/api/doc`, `/api/col`, `/api/assets`, `/_blob/<id>`, `/api/ai`.
- `public/index.html`: the app: the Studio in a browser, the Field view inside the phone app.
- `public/adapter.js`: connects the app to the server's routes and shows the sign-in form.

Open pages check the server for changes every five seconds, so a change saved in the Studio appears on phones a few seconds later. Answers are compressed.

## Limits to know

- One server process with files on disk. It suits one site or one team; it is not built for many simultaneous editors of the same cabinet. The last save wins.
- Two shared access codes, not personal accounts. There is no record of who changed what.
- The test steps in the Field view are general guidance per type of part. Have a qualified electrician review them before technicians rely on them.
- Reading drawings with Claude makes mistakes on dense pages. Every read wire is a draft until someone confirms it.

## Diagnosis with the PLC program

In the studio, open a cabinet, go to the Diagnose tab and add these files exported from STEP 7:

1. The source of the program: in the Sources folder, generate one source from all blocks (OBs, FCs, FBs, DBs) and export it as `.AWL`. One file with the whole program is best.
2. The symbol table, exported as `.SDF`. It gives every name its address and every data block its number.
3. The hardware configuration: in HW Config, Station → Export, a `.cfg` text file. It tells which module or drive holds each address.

The files are stored with the cabinet, packed (a whole program of 850 KB takes about 90 KB). If the same block is in two files, the file added last is used, so older partial files can be removed.

What the app does with them:

- It follows the program the way the PLC runs it: from OB 1 through every call, each block called with parameters worked out with the values the call passes. Blocks nothing calls are left out and listed under "How the program was read".
- For each output, input, memory bit, timer and data-block bit it shows the conditions that switch it, and for inputs and outputs the electrical path taken from the drawings.
- Jumps are followed: a statement a jump can skip is shown with the condition under which it is worked on. Parts switched off for good (for example behind an always-0 bit) are shown as switched off.
- Comparisons are shown with their values (for example `position ≥ (target + offset)`), including the calculations made before them: sums, differences, absolute values, and a value stored under a condition.
- A block that reads a device at an address given by the call (a drive status word, a record read with DPRD_DAT) is worked out per call: "drive fault" becomes the input bit of that drive, named with its PROFIBUS station when the hardware configuration is loaded.
- A data block whose number is kept in a word (`AUF DB [MW..]`) is followed by reading that word first.

What it does not follow: loops, the few other addresses worked out while the program runs, and values copied in blocks by BLKMOV. These show as "not known" and can be entered by hand.

Program files added in the Studio reach the phone app as soon as they are saved.

## Machines

Everything of one machine is kept together: its cabinets, its PLC (and so its live states and its drives) and its log. The first page of the Studio and of the phone app is the list of machines; open one to see its cabinets, **Drives** and **Machine log**.

- **New machine** (Studio, editors): give it a name, then in **Machine settings** the IP address of its PLC (port 102, rack 0, slot 2 for an S7-300), and press **Test the PLC**. Each machine has its own PLC; two machines can also use the same one.
- A new cabinet, or a cabinet file, is added to the machine that is open. To move a cabinet to another machine: open it, **List** tab, **Machine**.
- The cabinets of a machine are wired to each other and share its PLC program (the program can be added to any one of them). **Connections** shows the wires between them.
- A machine can be deleted once it holds no cabinet.
- On the phone, the app opens the machine used last; the arrow at the top goes back to the list.

**Inputs and outputs of another CPU.** On some machines the cabinet's I/O modules belong to one CPU and the program runs in another, which copies them with GET/PUT (Four 2: the CPU 313 holds the modules, the CPU 1500 reads them into the data blocks `ciH`, `ciwH` and writes `cqH`). The machine's PLC is then the CPU with the program. In the cabinet file, each module pin carries the data-block bit of that CPU (for example `DB4.DBX0.0` for I0.0 of the CPU 313), and the pin text says which address of which CPU it is. Diagnose lists these pins with the inputs and outputs, shows their wiring and reads them live like any other signal.

When the server is first started with this version, it puts the existing cabinets into machines by itself: the cabinets with the same group name become one machine, named after the group. That machine also gets the PLC of `.env` (`PLC_HOST`...), the reset settings and the log recorded so far. A copy of the documents from before is kept in the data folder, `backup-before-machines`. After that, the PLC of each machine is set in the Studio, not in `.env`.

## Production and maintenance

Each machine has a **Production** page and a **Maintenance** page. The server follows the PLC day and night for them (reading only), whether the pages are open or not, and keeps the totals for 3 years in the data folder, `monitor/<machine>`.

**Setting it up** (Studio, editors): open the machine, Production or Maintenance, tab **What is followed**, press **Set up from the program**, check and name what was found, **Save**. The program of the machine is read to find:
- **the counters the PLC keeps itself** (a value the program adds 1 to on a pulse): for the Empileuse, the wagons sent to the kiln (`DB80.DBD4`), the pick-ups of the two robots (`DB5.DBW12`, `DB5.DBW14`), the strokes of the long-bench servo pusher. One is the main one, drawn hour by hour; "Each one is" turns it into another unit (1 wagon = 3 walls);
- **the material word** (`DB17.DBW16`): each count is also added to the material running at that moment;
- **a running signal** whose time is added up per shift (the program counts the seconds of E2.0; what E2.0 is remains to be named) and the **automatic** signals;
- **the movements**: an output the program switches off when one end switch is reached (pushers, barriers, rollers up/down, the hydraulic pusher, the gripper's lift, translation, opening and head rotations);
- **the drives** (from the program and the hardware configuration) and **the alarms**.

The shifts start at 05:00, 13:00 and 21:00; the production day starts with the first shift. Change them in What is followed.

**Production**: this shift (each counter, time running, in automatic, with an alarm, the stop now), the day hour by hour; the shifts of the last days; the stops (time lost per alarm, then each stop); the counts per material. Export to Excel.

**Maintenance**:
- each movement is timed, from its output switching ON to its end switch. Its **normal time** is learned from its first 40 strokes; it is then shown on **To watch** when its average of the day is more than 20% over normal, when it often takes far longer, or when it does not reach its end switch. After a repair, press **Learn again**;
- each drive: running hours, starts, faults, and warnings from its status word (voltage, current, thermal). Each Danfoss also sends two more process words that the program does not use; their average, lowest and highest values while the motor runs are kept. If they follow the load, the drive is set to send its current or torque in them (parameter 9-16);
- each alarm: how often it comes, the average time to clear it and the time between two.

Timing is as fine as the reading: the server reads every 0.25 s, so a short movement (about 1 s) is followed by its average over many strokes, a long one stroke by stroke.

## Machine log

The server can record the PLC around the clock (reading only, like the Diagnose tab), so you can see later what happened on the machine: alarms, signals and values. Each machine has its own log: open the machine and press **Machine log**.

- **What is logged** (editors): choose the signals and the values from the program. **All inputs** and **All outputs** take every input and output the program uses; any other bit (M, DB) can be added. Values are the words the program compares and the analog inputs (PEW) of the symbol table; for an analog input, give the range it stands for (raw 0 to 27648 means 0 to 10 bar, for example) and a unit. Then press **Save**: the server follows the new list within a few seconds.
- **Alarms**: what is present on the machine now and since when, each alarm of the time chosen (when it appeared, when it cleared, how long it lasted), and the alarms that came most often. In **What is logged**, **All alarms of the program** takes the alarm bits the program sets (the symbols ALARM_1 to ALARM_512, the alarm words MD400 to MD460 that the operator panel shows); other fault signals of the program (1U101_Fault...) can be added. Each alarm's text comes from the symbol table; where it is missing or its letters were lost in the export, it is worked out from what sets the alarm in the program ("From the program: E2.1 is OFF"). Correct any text there, for example with the text the operator panel shows.
- **Events**: every switch of a logged signal, with its time to the millisecond, its address and its text from the drawings and the symbol table. Search by address or text, filter inputs or outputs. When only a few signals match, a timeline shows when each was ON.
- **Curves**: one chart per value, all on the same time axis. Point at a chart to read the value at that time.
- **Time**: the last 15 min, 1 h, 8 h, 24 h or 4 days (these follow on by themselves), or any range by date and time. **Export to Excel** saves the events or the curves of that range as a .csv file (`;` between columns, decimal comma).

A signal is written each time it changes; a value when it moves by more than its dead band, and at least once a minute. When the PLC cannot be reached, the log says so and goes on by itself once it is back. Data older than `LOG_DAYS` days (4) is deleted by the server. The log is in the data folder, `log`, one folder per machine and one file per hour; back it up with the rest if you want to keep it longer.

Logging only runs while the server runs: leave the PC on with the server started. To start it with Windows: double-click `start-with-windows.bat` (in this folder). Also set the PC never to sleep.

## Simulation without a PLC

In the Diagnose tab, "Simulate the PLC" runs the program read from the files in the page itself, ten cycles a second. No PLC and no server connection to a PLC are needed, so it also works in the phone app and in a downloaded copy.

- Tap an input (or a memory the program never writes, such as a panel button) to switch it. Memory bits, outputs, timers (in real time) and counters follow the program.
- Values that the program compares (positions, recipe values) start at 0. "Set values" next to a comparison sets them.
- It runs the conditions the app has read from the program, not the CPU itself: calculations that store new values, system functions and the CPU clock memory are not run. Use it to learn the machine and to practise a diagnosis; check the real machine with live reading.

## Live reading of the PLC

The Diagnose tab can show the real states of inputs, outputs and memory bits, read from a Siemens S7 PLC every second.

- The PLC needs an Ethernet interface that speaks S7 communication (a PN CPU or an Ethernet CP), and this server must reach it on TCP port 102.
- Set the IP address of the PLC in the Studio: open the machine, **Machine settings**. Rack and slot default to 0 and 2 (S7-300, ET 200S CPU). S7-1200/1500: slot 1 or 0, and PUT/GET access must be allowed in the CPU protection settings.
- Check it with `node server.js --test-plc`, then restart the server and press "Read the PLC live" in the Diagnose tab.
- It is read-only, except for the one reset request bit of "Reset from the phone" below, and only when that is set up. `plc.js` holds the whole connection; it has no function that starts or stops the PLC, and its only write accepts one memory or data-block bit.
- It reads bits (E/I, A/Q, M, `DBn.DBXx.y`) and the bytes and words the program compares (`MBx`, `MWx`, `MDx`, `DBn.DBBx`, `DBn.DBWx`, `DBn.DBDx`). A data-block variable written by name (for example `"DB".VAR`) is read once the source of that data block has been added and its DB number is known (from the symbol table, or typed in the tab). Inputs outside the process image (drives and other bus devices read with `PEW`/`PED`) are read straight from the device (`PEx.y`, `PEWx`).
- Timers and counters: the time left of a timer and the count of a counter are read. A timer is then ON, running or finished from its time left and its start condition; without a reading it is taken from its start condition alone. A counter is ON while its count is above zero.
- The hardware configuration shows whether the PLC has an Ethernet connection at all. A CPU with MPI and PROFIBUS only needs an Ethernet module in its rack, or an adapter that puts the MPI/PROFIBUS port on Ethernet and answers on TCP port 102.
- Only what the open page needs is read: the signals of the list on screen, or everything the open signal depends on. Neighbouring addresses are read together, so a page takes a few requests per second.
- A read uses one of the PLC's connection resources, like a programming device or a panel does.

## Reset from the phone

The Drives page can send a reset, protected by a reset code, the same reset as the RESET ALARM button of the machine. It is off until you set it up, and it needs one small change in the PLC program.

Why a change in the program: the program writes `RESET_FAULT` (M247.0) every cycle from the reset buttons, so a value written from outside would be overwritten at once. Instead the server sets one free memory bit, the request bit, and the program decides what to do with it.

### 1. The PLC program (STEP 7)

M600.0, M600.1 and T120 are not used anywhere in the program of the Empileuse (not in the symbol table, not addressed). Check again if the program has changed since.

In OB1 "main", insert a new network just before the network that writes `RESET_FAULT`:

```
// Reset request from Cabinet Mapper: M600.0 is set by the server after the reset code
      U     M    600.0
      L     S5T#2S
      SV    T    120          // keep the reset on for 2 s, like a press on the button
      U     M    600.0
      R     M    600.0        // take the request: the server sees the bit go back to 0
      U     T    120
      =     M    600.1        // reset from the phone, on for 2 s
```

Then add one line to the `RESET_FAULT` network:

```
      O     "PB_resetAlarm"
      O     "PB reset alarm ..."
      O     M    600.1        // <- added
      =     "RESET_FAULT"
```

Optional, the 10 gripper drives: their fault latches (M970.x, M971.x in FC "Pince Ligne") are reset by the input E108.5 "RESET ALARME" only. To reset them from the phone too, add a network in OB1 before the call of "Pince Ligne": `O "E108.5"`, `O M 600.1`, `= M 600.2`, and in "Pince Ligne" replace each `U "E108.5"` (12 places) by `U M 600.2`.

You can give the new bits names in the symbol table (for example `RESET_PHONE_REQ` M600.0, `RESET_PHONE` M600.1, `T_RESET_PHONE` T120).

Download OB1 (and "Pince Ligne" if changed) with the machine at a standstill and safe, and keep a backup of the project before. Press RESET ALARM on the machine once afterwards to check it still works as before.

### 2. The server and the Studio

Reset writes to a PLC, so the server must allow it first. In `.env`:

```
ALLOW_RESET=1
```

Restart the server; it prints "Reset from the app is allowed on this server". Then for each machine that may be reset, in the Studio: open the machine, **Machine settings**, **Reset from the phone**:

- **Reset request bit**: `M600.0` (the bit of the network above).
- **Reset code**: its own code, different from the access codes, at least 4 characters. Give it only to the people allowed to reset. It is kept hashed on the server: nobody can read it back, only set a new one or remove it.

Press **Save the bit and the code**; the page says "Reset from the phone is ON for this machine". Each machine has its own bit and its own code.

(The older settings `RESET_BIT` and `RESET_CODE` in `.env` still work as ALLOW_RESET=1, and are moved to the first machine once, when the server is updated to machines.)

### How it behaves

- On the phone, Drives shows "Reset faults with the reset code…" and, on a card in fault, "Reset with the reset code (at the machine)". Type the code, press Reset now.
- The server sets M600.0 and waits up to 3 s for the program to clear it. If the program cleared it, the phone says the PLC took the reset. If not (the program was not changed), the server clears the bit itself and the phone says the reset was not taken: nothing happens on the machine.
- It is the machine's reset, not one drive's: the program resets every fault it allows, and a fault whose cause is still there comes back.
- After 5 wrong codes from one device, reset is refused for 10 minutes. Every reset, taken or not, is written in the machine log with who sent it.
- The reset request bit of a machine is the only address the server ever writes to its PLC. It must be a memory or data-block bit; an input, an output or a word is refused.
- Without `ALLOW_RESET=1`, or for a machine without its bit and its code, the server writes nothing and the reset buttons do not show.
"# Diag-elec" 
