@echo off
chcp 65001 >nul
title klyaksa PRO — Telegram Bot & Licensing Server

echo ======================================================================
echo           klyaksa PRO — Telegram Bot ^& Licensing Server
echo ======================================================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ОШИБКА] Node.js не найден в системе!
    echo Пожалуйста, установите Node.js (рекомендуется v20+) с сайта:
    echo https://nodejs.org/
    echo.
    pause
    exit /b 1
)

cd /d "%~dp0"

echo [1/2] Проверка конфигурации config.json...
if not exist "config.json" (
    echo [ОШИБКА] Файл config.json не найден!
    pause
    exit /b 1
)

echo [2/2] Запуск бота и встроенного HTTP-сервера лицензирования (порт 3782)...
echo.
node bot.js

if %errorlevel% neq 0 (
    echo.
    echo [ВНИМАНИЕ] Работа завершилась с кодом ошибки %errorlevel%.
    pause
)
