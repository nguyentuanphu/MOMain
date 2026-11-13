HNMO
====

Everything in this folder: the game server, its admin panel and the game, which you
play in a web browser. Nothing needs to be installed.

START
  Windows: double-click "Start HNMO.bat".
  Linux/Mac: run ./start-hnmo.sh

  The game opens in your browser at http://localhost:8080/ after about 15 seconds.
  Test accounts: test0 ... test9, test300, test400 (password = account name).
  Press Enter in the game to chat; "/move devias" travels to Devias.

ADMIN PANEL
  http://localhost:8095/  - only reachable from this computer, on purpose.
  Create the first user on the Users page before you do anything else.

PLAY TOGETHER
  One person runs this folder (the host). Friends need only a web browser.

  Same Wi-Fi / home network:
    1. Find the host's IP address (Windows: run "ipconfig", look for IPv4 Address,
       e.g. 192.168.1.20).
    2. Friends open http://192.168.1.20:8080/ in their browser.
    3. If it doesn't load, allow "HNMO.Web" through the Windows firewall
       (Windows asks the first time - choose "Private networks").

  Over the internet (friends elsewhere):
    Only port 8080 is needed, because the game server talks to the web part on the
    host computer itself.
    - Forward TCP port 8080 on your router to the host computer, and give friends
      http://YOUR-PUBLIC-IP:8080/ (search "what is my IP" to find it), or
    - use a private network app such as Tailscale on every computer, and use the
      host's Tailscale address instead.
    Don't post the address publicly: the game data isn't ours to publish.

PLAY OFFLINE
  Run this folder on your own computer and play at http://localhost:8080/.
  Everyone can have their own copy for playing alone.

GOOD TO KNOW
  - This version runs in demo mode: characters and progress are NOT saved when the
    server stops. Saving comes with the database in a later version.
  - Close the two windows (or press Ctrl+C) to stop the game.

LICENSES
  See the "licenses" folder.
