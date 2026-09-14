#!/bin/zsh
set -eu
cd -- "${0:A:h:h}"
if ! command -v node >/dev/null 2>&1; then
  print 'Для запуска нужен разрешённый Node.js 22.16.0 или новее.'
  read -r '?Нажмите Enter, чтобы закрыть окно.'
  exit 1
fi
print "После запуска откройте http://127.0.0.1:${PORT:-4318}. Остановка — Ctrl+C."
if ! node start.mjs; then
  read -r '?Нажмите Enter, чтобы закрыть окно.'
  exit 1
fi
