@echo off
setlocal
if not defined VS80COMNTOOLS (
  echo Run this script from a Visual Studio 2005 Command Prompt.
  exit /b 2
)
pushd "%~dp0"
"%VS80COMNTOOLS%..\IDE\devenv.com" "PocketJS.WM6.sln" /Rebuild "Release|Windows Mobile 6 Professional SDK (ARMV4I)" /Out "rebuild-release.log"
set "WM6_BUILD_RESULT=%ERRORLEVEL%"
popd
exit /b %WM6_BUILD_RESULT%
