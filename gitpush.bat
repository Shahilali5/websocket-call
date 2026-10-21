@echo off
setlocal enabledelayedexpansion

echo ==============================================
echo        VCall 1-Click Git Stage, Commit & Push
echo ==============================================

:: Check if git is installed
where git >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Git is not installed or not in PATH.
    exit /b 1
)

:: Get commit message from argument, or default
set "COMMIT_MSG=%~1"
if "!COMMIT_MSG!"=="" (
    set /p "COMMIT_MSG=Enter commit message (default: 'feat: update VCall app'): "
)
if "!COMMIT_MSG!"=="" (
    set "COMMIT_MSG=feat: update VCall app"
)

echo.
echo [*] Staging all files...
git add -A

echo [*] Committing with message: "!COMMIT_MSG!"
git commit -m "!COMMIT_MSG!"

echo [*] Pushing to remote repository...
git push

if %ERRORLEVEL% equ 0 (
    echo.
    echo ==============================================
    echo [SUCCESS] Changes successfully pushed to git!
    echo ==============================================
) else (
    echo.
    echo [NOTICE] If there is no remote configured yet, run:
    echo   git remote add origin ^<your-github-repo-url^>
    echo   git push -u origin main
)
