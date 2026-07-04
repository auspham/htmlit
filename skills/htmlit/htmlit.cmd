@echo off
rem htmlit launcher for Windows. Pure Python, no Node required.
rem Mirrors the POSIX `htmlit` shell script: run htmlit_cli.py with the same args.
setlocal
where py >nul 2>nul
if %errorlevel%==0 (
  py "%~dp0htmlit_cli.py" %*
) else (
  python "%~dp0htmlit_cli.py" %*
)
exit /b %errorlevel%
