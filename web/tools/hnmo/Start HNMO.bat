@echo off
rem Starts HNMO: the save game database, the game server with its admin panel,
rem and the game, which opens in your browser. Close this window to stop everything.
title HNMO - close this window to stop the game
cd /d "%~dp0"
if not exist "Data\Monsters" (
  echo The game data is missing. Copy the Data folder of the game into "%~dp0Data".
  pause
  exit /b 1
)
cd web
HNMO.exe
