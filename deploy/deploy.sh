#!/bin/bash
# 로컬(Windows Git Bash)에서 실행 — 서버 IP를 인자로 전달
# 사용법: bash deploy/deploy.sh 1.201.126.200
#
# 계정/키 (2026-06-01 변경): 과거 root@ 직접 접속 → 가비아 Rocky 기본 계정 rocky 로 전환.
#   - root SSH 로그인이 막혀 있어 root@ 로 시도하면 publickey 거부 + fail2ban 차단을 유발한다.
#   - 서비스가 User=rocky 로 구동되어 /opt/today_tactics 는 rocky 소유 → 파일 업로드는 rocky 로 직접 가능.
#   - systemctl restart 만 sudo 필요 (ssh -t 로 비밀번호 프롬프트 허용).
# 필요 시 환경변수로 덮어쓰기: SSH_USER=rocky SSH_KEY=~/.ssh/today-project.pem bash deploy/deploy.sh <IP>
set -e

SERVER_IP=$1
SSH_USER="${SSH_USER:-rocky}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/today-project.pem}"
APP_DIR="/opt/today_tactics"

if [ -z "$SERVER_IP" ]; then
  echo "사용법: bash deploy/deploy.sh <서버IP>   (계정=$SSH_USER, 키=$SSH_KEY)"
  exit 1
fi

SSH="ssh -i $SSH_KEY"
REMOTE="$SSH_USER@$SERVER_IP"
RSH="ssh -i $SSH_KEY"

echo "▶ [1/5] 서비스 파일 전송"
scp -i "$SSH_KEY" deploy/today_tactics.service "$REMOTE:/tmp/"
scp -i "$SSH_KEY" deploy/today_tactics.nginx   "$REMOTE:/tmp/"
scp -i "$SSH_KEY" deploy/setup.sh              "$REMOTE:/tmp/"

echo "▶ [2/5] 코드 동기화 (main.py + crawlers/ + static/ + templates/)"
scp -i "$SSH_KEY" main.py "$REMOTE:$APP_DIR/main.py"
rsync -avz -e "$RSH" --exclude '__pycache__' crawlers/  "$REMOTE:$APP_DIR/crawlers/"
rsync -avz -e "$RSH"                         static/    "$REMOTE:$APP_DIR/static/"
rsync -avz -e "$RSH"                         templates/ "$REMOTE:$APP_DIR/templates/"

echo "▶ [3/5] players.db 전송 (~186MB, 시간 걸릴 수 있음)"
scp -i "$SSH_KEY" players.db "$REMOTE:$APP_DIR/players.db"

echo "▶ [4/5] data/ 폴더 동기화"
rsync -avz -e "$RSH" --progress data/ "$REMOTE:$APP_DIR/data/"

echo "▶ [5/5] 서비스 재시작 (sudo)"
$SSH -t "$REMOTE" "sudo systemctl restart today_tactics && sleep 2 && systemctl status today_tactics --no-pager | head -5 && curl -s -o /dev/null -w 'local HTTP %{http_code}\n' http://127.0.0.1/"

echo ""
echo "✅ 배포 완료! http://$SERVER_IP 에서 확인하세요"
