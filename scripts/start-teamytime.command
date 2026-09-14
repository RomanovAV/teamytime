#!/bin/zsh
set -eu
cd -- "${0:A:h:h}"
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  print 'Для запуска нужны Node.js 24+ и npm. Установите их и повторите запуск.'
  read -r '?Нажмите Enter, чтобы закрыть окно.'
  exit 1
fi
if [[ ! -d node_modules ]]; then
  print 'Сначала установите зависимости из каталога проекта: npm ci'
  read -r '?Нажмите Enter, чтобы закрыть окно.'
  exit 1
fi
print 'После запуска откройте http://127.0.0.1:4318. Остановка — Ctrl+C.'
exec npm start
