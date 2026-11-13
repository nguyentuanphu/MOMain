@echo off
rem Starts HNMO: the game server (with the admin panel) and the web client.
rem Close the two windows that open to stop the game.
setlocal
cd /d "%~dp0"

if not exist "Data\Monsters" (
  echo The game data is missing. Copy the Data folder of the game into "%~dp0Data".
  pause
  exit /b 1
)

echo Starting the game server...
start "HNMO server - close to stop" /d "%~dp0server" cmd /c "set ASPNETCORE_URLS=http://127.0.0.1:8095&& MUnique.OpenMU.Startup.exe -demo -autostart -resolveIP:loopback -deamon"

echo Starting the web client...
start "HNMO web - close to stop" /d "%~dp0web" cmd /c "HNMO.Web.exe"

timeout /t 15 /nobreak >nul
start "" "http://localhost:8080/"

echo.
echo HNMO is running.
echo   Play:        http://localhost:8080/
echo   Admin panel: http://localhost:8095/   (only on this computer)
echo   Friends on your network: http://YOUR-PC-IP:8080/   (see README.txt)
echo.
pause
