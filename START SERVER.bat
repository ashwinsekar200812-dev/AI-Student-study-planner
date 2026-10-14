@echo off
echo.
echo ============================================
echo   Smart Study Planner - Starting Server...
echo ============================================
echo.

:: Kill any old node processes
taskkill /F /IM node.exe >nul 2>&1

:: Start the server
"C:\Program Files\nodejs\node.exe" server.js

pause
