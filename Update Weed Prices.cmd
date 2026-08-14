@echo off
REM Double-click to refresh Tucson flower prices.
REM Scrapes the 9 Dutchie dispensaries, merges your hand-entered JARS items
REM (jars-manual.json), and rebuilds the CSV, Excel, and phone HTML page.
cd /d "%~dp0"
echo Refreshing Tucson flower prices... this takes a minute or two.
echo.
call npm run weed
echo.
echo Done. Outputs in this folder:
echo   weed-best-value.html   (open on your phone)
echo   weed-best-value.xlsx   (spreadsheet)
echo   weed-best-value.csv
echo.
pause
