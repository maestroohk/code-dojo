@echo off
dotnet run --project "%~dp0server" -c Release -- %*
