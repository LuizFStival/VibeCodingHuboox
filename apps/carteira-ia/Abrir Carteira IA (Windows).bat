@echo off
rem Abre o Carteira IA no navegador (Windows). Nao precisa instalar nada.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\serve.ps1"
pause
