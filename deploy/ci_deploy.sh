#!/bin/bash
# CI 전용 forced command (P7 하드닝)
# authorized_keys의 command="..."로 강제 실행되는 유일한 스크립트.
# CI 배포키(github-actions-deploy)는 이 스크립트만 실행 가능 — 임의 명령/셸/포워딩 차단.
# GitHub 시크릿 유출 시에도 공격자는 "배포 1회 트리거"만 가능(임의 root 실행 불가).
set -e
cd /opt/today_tactics
git fetch origin main
git reset --hard origin/main
sudo -n systemctl restart today_tactics
sleep 3
curl -sf -o /dev/null -w 'health=%{http_code}\n' http://127.0.0.1:5000/
