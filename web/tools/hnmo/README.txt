HNMO
====

Everything in this folder: the game, its server and admin panel, and a small
database that keeps your progress. You play in a web browser. Nothing needs to be
installed.

START
  Windows: double-click "Start HNMO.bat". One window opens; keep it open while you
           play, close it to stop the game (your progress is saved).
  Linux/Mac: run ./start-hnmo.sh (Ctrl+C stops it).

  The game opens in your browser at http://localhost:8080/ when it's ready. The very
  first start sets up the save game and takes up to a few minutes.

  Windows may warn "Windows protected your PC" (the files aren't signed):
  click "More info" and "Run anyway".

SAVE GAME
  Progress is saved in the "save" folder: accounts, characters, items, guilds, coins.
  To back it up, stop the game and copy the "save" folder. To start over, stop the
  game and delete the "save" folder.

ACCOUNTS AND COINS
  http://localhost:8080/account.html  (friends use your address instead of localhost)
  - Create an account: new accounts get free cash shop coins.
  - My coins: shows an account's coins.
  First, once, on the host computer:
    1. Open the admin panel (below), go to Users and create the first user.
    2. Open "API keys", create a key with the role "Administrator", copy it.
    3. Open http://localhost:8080/account.html and paste the key into the setup box.
  Test accounts also work: test0 ... test9, test300, test400 (password = name).

IN THE GAME
  Log in, pick or create a character (Dark Wizard, Dark Knight and Fairy Elf;
  the other classes unlock later in the game). Click to walk, right-drag to turn,
  mouse wheel to zoom. Press Enter to chat; "/move devias" travels to Devias.

ADMIN PANEL
  http://localhost:8095/  - only on the host computer, on purpose.

PLAY WITH FRIENDS
  One person runs this folder (the host); friends need only a web browser.

  Same Wi-Fi: friends open http://HOST-IP:8080/ (Windows: "ipconfig" shows the
  host's IPv4 address, e.g. 192.168.1.20). Allow "HNMO" through the firewall when
  Windows asks (Private networks).

  Friends elsewhere, without opening ports - Tailscale (free):
    1. The host and every friend install Tailscale (tailscale.com) and sign in.
    2. The host shares this computer with each friend: Tailscale admin console,
       Machines, the host's machine, "Share", and sends them the invite.
    3. Friends open http://HOST-TAILSCALE-IP:8080/ (the host's 100.x.y.z address,
       shown in the Tailscale app).

LICENSES
  See the "licenses" folder.
