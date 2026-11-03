#!/bin/bash
# Today Tactics 일일 백업: players.db + data/*.json
# - SQLite는 .backup 명령으로 일관성 보장 (single-writer 잠금 회피)
# - 30일 보관 후 자동 삭제
# - cron 등록: 0 3 * * * /opt/today_tactics/deploy/backup.sh >> /var/log/today_tactics/backup.log 2>&1
set -e

BACKUP_DIR=/var/backups/today_tactics
SRC_DIR=/opt/today_tactics
TS=$(date +%Y%m%d)

mkdir -p $BACKUP_DIR

# DB 백업 (sqlite3 .backup으로 일관성 있는 스냅샷)
sqlite3 $SRC_DIR/players.db ".backup $BACKUP_DIR/players_$TS.db"
gzip -f $BACKUP_DIR/players_$TS.db

# JSON 데이터 백업
tar czf $BACKUP_DIR/data_$TS.tar.gz -C $SRC_DIR data/

# 30일 이상 된 백업 삭제
find $BACKUP_DIR -name 'players_*.db.gz' -mtime +30 -delete
find $BACKUP_DIR -name 'data_*.tar.gz' -mtime +30 -delete

echo "[$(date +'%Y-%m-%d %H:%M:%S')] backup completed: players_$TS.db.gz, data_$TS.tar.gz"
