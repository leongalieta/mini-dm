@echo off
title Mini DM
cd /d "%~dp0"
echo.
echo   Mini DM - comentario vira conversa no direct
echo   -------------------------------------------
echo.
if exist "%~dp0servidor.log" del "%~dp0servidor.log" >nul 2>&1
start "Mini DM - servidor" /min cmd /c ""C:\Program Files\nodejs\node.exe" server.js > "%~dp0servidor.log" 2>&1"
timeout /t 3 /nobreak >nul
start "" "http://localhost:3777"
echo   O painel esta em  http://localhost:3777
echo.
echo   Se a pagina nao abrir, digite esse endereco no navegador.
echo   Para encerrar o Mini DM, feche a janela "Mini DM - servidor".
echo.
timeout /t 10 >nul
