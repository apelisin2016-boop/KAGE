#!/bin/sh
set -e
cd /workspace

if curl -sf -o /dev/null http://127.0.0.1:8080/; then
  exit 0
fi

npm run dev &
i=0
while [ "$i" -lt 40 ]; do
  if curl -sf -o /dev/null http://127.0.0.1:8080/; then
    exit 0
  fi
  i=$((i + 1))
  sleep 0.25
done
exit 0
