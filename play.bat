@echo off
title Weekend Road Trip - GTA build
cd /d "%~dp0"
set "PORT=8090"

rem Prefer "python", fall back to the "py" launcher (pick one so we never
rem accidentally start two servers on the same port).
set "PY=python"
where python >nul 2>nul || set "PY=py"

echo ============================================================
echo    WEEKEND ROAD TRIP  -  hidden GTA build
echo ------------------------------------------------------------
echo    Serving this folder at  http://localhost:%PORT%
echo.
echo    A browser tab opens automatically in a second.
echo.
echo    To reach the hidden mode:
echo      - finish the coast-to-coast drive, then press  F
echo      - or press F12 and run   ONFOOT.enter()
echo.
echo    KEEP THIS WINDOW OPEN while you play.
echo    Close it (or press Ctrl+C) to stop the server.
echo ============================================================
echo.

rem Open the browser ~1.5s after the server has had time to bind.
start "" /b powershell -NoProfile -Command "Start-Sleep -Milliseconds 1500; Start-Process 'http://localhost:%PORT%/'"

rem Start the static server (blocks until you close this window).
%PY% -m http.server %PORT%
