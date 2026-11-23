#!/bin/bash
# CI 전용 forced command (P7 하드닝)
# authorized_keys의 command="..."로 강제 실행되는 유일한 스크립트.
# CI 배포키(github-actions-deploy)는 이 스크립트만 실행 가능 — 임의 명령/셸/포워딩 차단.
# GitHub 시크릿 유출 시에도 공격자는 "배포 1회 트리거"만 가능(임의 root 실행 불가).
set -e
cd /opt/today_tactics
git fetch origin main
# 크론이 서버에서 갱신하는 추적 데이터(data/*.json — 결과·선수 등)는 reset 이 저장소의 오래된 버전으로
# 되돌리므로(다음 크론까지 /api/results 가 과거 상태) 보존했다가 reset 뒤 복원한다. 2026-11-23.
KEEP=$(mktemp -d)
trap 'rm -rf "$KEEP"' EXIT
git diff --name-only -- data/ | while IFS= read -r f; do
  [ -f "$f" ] && mkdir -p "$KEEP/$(dirname "$f")" && cp -p "$f" "$KEEP/$f"
done
git reset --hard origin/main
if [ -d "$KEEP/data" ]; then
  (cd "$KEEP" && find data -type f) | while IFS= read -r f; do cp -p "$KEEP/$f" "$f"; echo "kept $f"; done
fi
sudo -n systemctl restart today_tactics
sleep 3
curl -sf -o /dev/null -w 'health=%{http_code}\n' http://127.0.0.1:5000/
