import json
import os
import time
import uuid
import sqlite3
import secrets as _secrets
import subprocess
import threading
import urllib.request
from datetime import datetime, timezone, timedelta
from functools import wraps
import time as _time_mod


# ── API 응답 인메모리 캐시 (TTL) ────────────────────────────
# 사용처: 무거운 read-only 라우트(통계/누적/예측). 세션·CRUD 라우트는 절대 캐싱 금지.
# Flask test 환경/단일 process gunicorn 가정. multi-worker 시 동기화 안 됨 (worker별 캐시).
_API_CACHE = {}  # key → (expires_at, payload). Python 3.7+ dict는 insertion order 보존 → LRU 흉내
_API_CACHE_TTL = 3600  # 1시간
_API_CACHE_MAX_KEYS = 4096  # player_id × 파라미터 조합 폭발 방지 cap


def _api_cache_evict_if_full():
    """캡 초과 시 만료된 키 우선 삭제, 그래도 초과면 oldest insertion부터 삭제."""
    if len(_API_CACHE) < _API_CACHE_MAX_KEYS:
        return
    now = _time_mod.time()
    expired = [k for k, v in _API_CACHE.items() if v[0] <= now]
    for k in expired:
        _API_CACHE.pop(k, None)
    overflow = len(_API_CACHE) - _API_CACHE_MAX_KEYS + 128  # 한 번에 128개 헤드룸
    if overflow > 0:
        for k in list(_API_CACHE.keys())[:overflow]:
            _API_CACHE.pop(k, None)


def cached_response(ttl=_API_CACHE_TTL):
    """request.full_path를 키로 응답 객체 캐싱. JSON 직렬화 결과(text)를 저장."""
    def deco(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            try:
                from flask import request as _req, Response
                key = f"{fn.__name__}|{_req.full_path}"
            except Exception:
                return fn(*args, **kwargs)
            now = _time_mod.time()
            ent = _API_CACHE.get(key)
            if ent and ent[0] > now:
                body, mimetype, status = ent[1]
                return Response(body, status=status, mimetype=mimetype)
            resp = fn(*args, **kwargs)
            try:
                # Response 객체 또는 tuple 처리
                if hasattr(resp, "get_data"):
                    body = resp.get_data(as_text=True)
                    mimetype = resp.mimetype
                    status = resp.status_code
                else:
                    body = resp
                    mimetype = "application/json"
                    status = 200
                # 4xx/5xx는 캐시하지 않음 (일시 오류가 굳지 않도록)
                if 200 <= status < 300:
                    _api_cache_evict_if_full()
                    _API_CACHE[key] = (now + ttl, (body, mimetype, status))
            except Exception:
                pass
            return resp
        return wrapper
    return deco


def invalidate_api_cache():
    """update_data.py 실행 후 새 데이터 반영 위해 캐시 클리어."""
    _API_CACHE.clear()

from flask import Flask, render_template, jsonify, request, session, redirect, url_for, abort
from authlib.integrations.flask_client import OAuth

app = Flask(__name__)
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0

# ── 세션 / 보안 설정 ─────────────────────────────────────────────
# SECRET_KEY: 환경변수로 주입. 없으면 부팅 시 임시 키 생성 (재기동 시 모든 세션 무효).
app.config["SECRET_KEY"] = os.environ.get("FLASK_SECRET_KEY") or _secrets.token_urlsafe(32)
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SECURE=True,           # HTTPS 전용 (프로덕션 today-tactics.co.kr)
    SESSION_COOKIE_SAMESITE="Lax",
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),
)

# 로컬 개발(127.0.0.1, http) 접근 허용 — Secure 쿠키 비활성
if os.environ.get("FLASK_DEV") == "1":
    app.config["SESSION_COOKIE_SECURE"] = False

BASE_DIR    = os.path.dirname(os.path.abspath(__file__))
DB_PATH     = os.path.join(BASE_DIR, "players.db")
SAVES_DIR   = os.path.join(BASE_DIR, "saves")
SQUADS_DIR  = os.path.join(BASE_DIR, "squads")
STATUS_FILE = os.path.join(BASE_DIR, "data", "player_status.json")
os.makedirs(SAVES_DIR,  exist_ok=True)
os.makedirs(SQUADS_DIR, exist_ok=True)


# ════════════════════════════════════════════════════════════════
# 인증 / OAuth (Google, Kakao, Naver)
# ════════════════════════════════════════════════════════════════
oauth = OAuth(app)

# Google — OpenID Connect (자동 메타데이터 fetch)
oauth.register(
    name="google",
    client_id=os.environ.get("GOOGLE_CLIENT_ID"),
    client_secret=os.environ.get("GOOGLE_CLIENT_SECRET"),
    server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
    client_kwargs={"scope": "openid email profile"},
)

# Kakao — OpenID Connect 지원
oauth.register(
    name="kakao",
    client_id=os.environ.get("KAKAO_CLIENT_ID"),
    client_secret=os.environ.get("KAKAO_CLIENT_SECRET", ""),  # Kakao는 secret 선택사항
    authorize_url="https://kauth.kakao.com/oauth/authorize",
    access_token_url="https://kauth.kakao.com/oauth/token",
    api_base_url="https://kapi.kakao.com/",
    client_kwargs={"scope": "profile_nickname account_email profile_image"},
)

# Naver
oauth.register(
    name="naver",
    client_id=os.environ.get("NAVER_CLIENT_ID"),
    client_secret=os.environ.get("NAVER_CLIENT_SECRET"),
    authorize_url="https://nid.naver.com/oauth2.0/authorize",
    access_token_url="https://nid.naver.com/oauth2.0/token",
    api_base_url="https://openapi.naver.com/",
    client_kwargs={},
)

def _init_users_table():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            provider     TEXT NOT NULL,
            provider_sub TEXT NOT NULL,
            email        TEXT,
            name         TEXT,
            picture      TEXT,
            created_at   TEXT NOT NULL,
            last_login   TEXT NOT NULL,
            UNIQUE(provider, provider_sub)
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)")
    conn.commit()
    conn.close()

_init_users_table()


def _upsert_user(provider, sub, email, name, picture):
    """OAuth 콜백에서 사용자 정보 저장/갱신. user_id 반환."""
    now = datetime.now().isoformat()
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute(
        "SELECT id FROM users WHERE provider=? AND provider_sub=?",
        (provider, sub),
    )
    row = cur.fetchone()
    if row:
        user_id = row[0]
        cur.execute(
            "UPDATE users SET email=?, name=?, picture=?, last_login=? WHERE id=?",
            (email, name, picture, now, user_id),
        )
    else:
        cur.execute(
            """INSERT INTO users (provider, provider_sub, email, name, picture, created_at, last_login)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (provider, sub, email, name, picture, now, now),
        )
        user_id = cur.lastrowid
    conn.commit()
    conn.close()
    return user_id


def _login_user(user_id, provider, name, email, picture):
    session.permanent = True
    session["user"] = {
        "id":       user_id,
        "provider": provider,
        "name":     name or email or "사용자",
        "email":    email or "",
        "picture":  picture or "",
    }


def login_required(view):
    """페이지 라우트용 — 미인증 시 /login 리디렉트."""
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("user"):
            return redirect(url_for("login_page", next=request.path))
        return view(*args, **kwargs)
    return wrapped


def login_required_api(view):
    """API 라우트용 — 미인증 시 401 JSON."""
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("user"):
            return jsonify({"error": "unauthorized"}), 401
        return view(*args, **kwargs)
    return wrapped


# 로그인 강제 토글 — 환경변수 LOGIN_REQUIRED=1 일 때만 게이트 활성
# (OAuth 앱 등록·secret 발급 전까지 OFF로 두어 사이트 공개 유지)
LOGIN_REQUIRED = os.environ.get("LOGIN_REQUIRED", "0") == "1"


@app.before_request
def _auth_gate():
    """전체 사이트 잠금 — LOGIN_REQUIRED=1 일 때만 동작.
    /login, /auth/*, /static/, /health, /favicon 은 항상 무인증 허용."""
    if not LOGIN_REQUIRED:
        return None
    p = request.path
    PUBLIC_PREFIXES = ("/static/", "/login", "/auth/", "/health", "/favicon")
    if any(p.startswith(x) for x in PUBLIC_PREFIXES):
        return None
    if session.get("user"):
        return None
    # API는 401 JSON, 그 외는 /login 리디렉트
    if p.startswith("/api/"):
        return jsonify({"error": "unauthorized", "login_url": "/login"}), 401
    return redirect(url_for("login_page", next=p))


# ── 페이지 ─────────────────────────────────────
@app.route("/login")
def login_page():
    if session.get("user"):
        return redirect("/")
    next_url = request.args.get("next", "/")
    err = request.args.get("err", "")
    return render_template(
        "login.html",
        next_url=next_url,
        error=err,
        google_enabled=bool(os.environ.get("GOOGLE_CLIENT_ID")),
        kakao_enabled=bool(os.environ.get("KAKAO_CLIENT_ID")),
        naver_enabled=bool(os.environ.get("NAVER_CLIENT_ID")),
    )


@app.route("/auth/login/<provider>")
def oauth_login(provider):
    if provider not in ("google", "kakao", "naver"):
        return redirect(url_for("login_page", err="invalid_provider"))
    client = getattr(oauth, provider, None)
    if client is None or not os.environ.get(f"{provider.upper()}_CLIENT_ID"):
        return redirect(url_for("login_page", err="provider_disabled"))
    # next URL session에 저장 (CSRF 우회 방지 — 외부 URL 차단)
    nxt = request.args.get("next", "/")
    if not nxt.startswith("/") or nxt.startswith("//"):
        nxt = "/"
    session["oauth_next"] = nxt
    redirect_uri = url_for("oauth_callback", provider=provider, _external=True)
    return client.authorize_redirect(redirect_uri)


@app.route("/auth/callback/<provider>")
def oauth_callback(provider):
    if provider not in ("google", "kakao", "naver"):
        return redirect(url_for("login_page", err="invalid_provider"))
    client = getattr(oauth, provider)
    try:
        token = client.authorize_access_token()
    except Exception as e:
        return redirect(url_for("login_page", err="oauth_error"))

    sub = email = name = picture = None
    try:
        if provider == "google":
            info = token.get("userinfo") or client.parse_id_token(token, nonce=None)
            sub     = str(info.get("sub"))
            email   = info.get("email")
            name    = info.get("name") or info.get("given_name")
            picture = info.get("picture")
        elif provider == "kakao":
            r = client.get("v2/user/me", token=token)
            data = r.json()
            sub = str(data.get("id"))
            kakao_account = data.get("kakao_account") or {}
            profile = kakao_account.get("profile") or {}
            email   = kakao_account.get("email")
            name    = profile.get("nickname")
            picture = profile.get("profile_image_url") or profile.get("thumbnail_image_url")
        elif provider == "naver":
            r = client.get("v1/nid/me", token=token)
            data = r.json().get("response", {})
            sub     = str(data.get("id"))
            email   = data.get("email")
            name    = data.get("nickname") or data.get("name")
            picture = data.get("profile_image")
    except Exception as e:
        return redirect(url_for("login_page", err="profile_fetch_failed"))

    if not sub:
        return redirect(url_for("login_page", err="no_user_id"))

    user_id = _upsert_user(provider, sub, email, name, picture)
    _login_user(user_id, provider, name, email, picture)

    nxt = session.pop("oauth_next", "/")
    if not nxt.startswith("/") or nxt.startswith("//"):
        nxt = "/"
    return redirect(nxt)


@app.route("/auth/logout", methods=["GET", "POST"])
def auth_logout():
    session.pop("user", None)
    session.pop("oauth_next", None)
    return redirect(url_for("login_page"))


@app.route("/auth/me")
def auth_me():
    """현재 로그인 사용자 정보 (헤더 표시용)."""
    u = session.get("user")
    if not u:
        return jsonify({"authenticated": False}), 200
    return jsonify({"authenticated": True, "user": u})


@app.route("/health")
def health():
    return jsonify({"ok": True})


def _init_default_squads():
    """kleague_players_2026.json 을 읽어 팀별 기본 스쿼드 파일을 생성한다."""
    players_file = os.path.join(BASE_DIR, "data", "kleague_players_2026.json")
    if not os.path.exists(players_file):
        return
    with open(players_file, "r", encoding="utf-8") as f:
        all_data = json.load(f)
    now = datetime.now().isoformat()
    for team_id, tdata in all_data.items():
        fpath = os.path.join(SQUADS_DIR, f"default_{team_id}.json")
        if os.path.exists(fpath):       # 이미 있으면 덮어쓰지 않음
            continue
        players = [{"number": p["number"], "name": p["name"], "position": p.get("position",""), "height": p.get("height",0), "weight": p.get("weight",0), "dob": p.get("dob","")} for p in tdata.get("players", [])]
        data = {
            "id": f"default_{team_id}",
            "teamId": team_id,
            "name": f"2026 시즌 ({tdata.get('team_name', team_id)})",
            "players": players,
            "createdAt": now,
            "updatedAt": now,
        }
        with open(fpath, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

_init_default_squads()

# ── K리그 2026 팀 데이터 (K리그 데이터 포털 기준) ─────────
TEAMS = [
    # K1 리그 (12팀)
    # border_home: HOME 킷 아이콘 테두리색 / border_away: AWAY 킷 아이콘 테두리색
    {"id": "ulsan",    "sofascore_id": 7653,  "name": "울산 HD FC",        "short": "울산",   "league": "K1", "primary": "#1d5fa5", "secondary": "#ffffff", "accent": "#f2a900", "emblem": "emblem_K01.png", "border_home": "#fbf500", "border_away": "#6294c1"},
    {"id": "pohang",   "sofascore_id": 7650,  "name": "포항 스틸러스",      "short": "포항",   "league": "K1", "primary": "#d41123", "secondary": "#ffffff", "accent": "#ffffff", "emblem": "emblem_K03.png", "border_home": "#191e24", "border_away": "#c70027"},
    {"id": "jeju",     "sofascore_id": 7649,  "name": "제주 유나이티드",     "short": "제주",   "league": "K1", "primary": "#f47920", "secondary": "#ffffff", "accent": "#ffffff", "emblem": "emblem_K04.png", "border_home": "#121928", "border_away": "#121928"},
    {"id": "jeonbuk",  "sofascore_id": 6908,  "name": "전북 현대 모터스",    "short": "전북",   "league": "K1", "primary": "#0a4436", "secondary": "#ffffff", "accent": "#ffd700", "emblem": "emblem_K05.png", "border_home": "#50b79a", "border_away": "#214b4f"},
    {"id": "fcseoul",  "sofascore_id": 7646,  "name": "FC 서울",           "short": "서울",   "league": "K1", "primary": "#ef3744", "secondary": "#e8e7ef", "accent": "#ffd700", "emblem": "emblem_K09.png", "border_home": "#161516", "border_away": "#1f2125"},
    {"id": "daejeon",  "sofascore_id": 7645,  "name": "대전 하나 시티즌",    "short": "대전",   "league": "K1", "primary": "#059a86", "secondary": "#ffffff", "accent": "#ffffff", "emblem": "emblem_K10.png", "border_home": "#771e34", "border_away": "#771e34"},
    {"id": "incheon",  "sofascore_id": 7648,  "name": "인천 유나이티드",     "short": "인천",   "league": "K1", "primary": "#01a0fc", "secondary": "#bac6d4", "accent": "#ffffff", "emblem": "emblem_K18.png", "border_home": "#1f2521", "border_away": "#52b3f7"},
    {"id": "gangwon",  "sofascore_id": 34220, "name": "강원 FC",           "short": "강원",   "league": "K1", "primary": "#f55947", "secondary": "#e4e3f3", "accent": "#f47920", "emblem": "emblem_K21.png", "border_home": "#191e24", "border_away": "#191e24"},
    {"id": "gwangju",  "sofascore_id": 48912, "name": "광주 FC",           "short": "광주",   "league": "K1", "primary": "#f3ad02", "secondary": "#e4e3ed", "accent": "#000000", "emblem": "emblem_K22.png", "border_home": "#121621", "border_away": "#0f1b2f"},
    {"id": "bucheon",  "sofascore_id": 92539, "name": "부천 FC 1995",      "short": "부천",   "league": "K1", "primary": "#8e272b", "secondary": "#e1d8db", "accent": "#ffffff", "emblem": "emblem_K26.png", "border_home": "#170f0c", "border_away": "##a31822"},
    {"id": "anyang",   "sofascore_id": 32675, "name": "FC 안양",           "short": "안양",   "league": "K1", "primary": "#501b85", "secondary": "#ffffff", "accent": "#ffd700", "emblem": "emblem_K27.png", "border_home": "#ffffff", "border_away": "#501b85"},
    {"id": "gimcheon", "sofascore_id": 7647,  "name": "김천 상무 FC",       "short": "김천",   "league": "K1", "primary": "#df242b", "secondary": "#eeeeee", "accent": "#ffffff", "emblem": "emblem_K35.png", "border_home": "#1d1e2e", "border_away": "#262d3d"},
    # K2 리그 (17팀)
    {"id": "suwon",    "sofascore_id": 7652,  "name": "수원 삼성 블루윙즈",  "short": "수원",   "league": "K2", "primary": "#2553a5", "secondary": "#e7e6ec", "accent": "#c8102e", "emblem": "emblem_K02.png", "border_home": "#253052", "border_away": "#1f4183"},
    {"id": "busan",    "sofascore_id": 7642,  "name": "부산 아이파크",      "short": "부산",   "league": "K2", "primary": "#b4050f", "secondary": "#b7c6ca", "accent": "#ffffff", "emblem": "emblem_K06.png", "border_home": "#120d11", "border_away": "#ffffff"},
    {"id": "jeonnam",  "sofascore_id": 7643,  "name": "전남 드래곤즈",      "short": "전남",   "league": "K2", "primary": "#fbea09", "secondary": "#f0f0f2", "accent": "#000000", "emblem": "emblem_K07.png", "border_home": "#000000", "border_away": "#000000"},
    {"id": "seongnam", "sofascore_id": 7651,  "name": "성남 FC",           "short": "성남",   "league": "K2", "primary": "#0e131b", "secondary": "#ffffff", "accent": "#ffffff", "emblem": "emblem_K08.png", "border_home": "#ffffff", "border_away": "#1a222d"},
    {"id": "daegu",    "sofascore_id": 7644,  "name": "대구 FC",           "short": "대구",   "league": "K2", "primary": "#86c5e8", "secondary": "#e2e5ea", "accent": "#ffffff", "emblem": "emblem_K17.png", "border_home": "#e2e5ea", "border_away": "#86c5e8"},
    {"id": "gyeongnam","sofascore_id": 22020,  "name": "경남 FC",           "short": "경남",   "league": "K2", "primary": "#ac101b", "secondary": "#d9d9d9", "accent": "#ffffff", "emblem": "emblem_K20.png", "border_home": "#121211", "border_away": "#121211"},
    {"id": "suwon_fc", "sofascore_id": 41261, "name": "수원 FC",           "short": "수원FC", "league": "K2", "primary": "#07306a", "secondary": "#cac3c3", "accent": "#ffffff", "emblem": "emblem_K29.png", "border_home": "#c9232e", "border_away": "#0b3972"},
    {"id": "seouland", "sofascore_id": 189422, "name": "서울 이랜드 FC",     "short": "이랜드", "league": "K2", "primary": "#030a1b", "secondary": "#d7dddd", "accent": "#1e3a8a", "emblem": "emblem_K31.png", "border_home": "#051025", "border_away": "#051025"},
    {"id": "ansan",    "sofascore_id": 248375, "name": "안산 그리너스 FC",    "short": "안산",   "league": "K2", "primary": "#0087a7", "secondary": "#eaedf4", "accent": "#ffd700", "emblem": "emblem_K32.png", "border_home": "#272c3d", "border_away": "#00677f"},
    {"id": "asan",     "sofascore_id": 339827, "name": "충남 아산 FC",       "short": "아산",   "league": "K2", "primary": "#12122c", "secondary": "#dfdfdf", "accent": "#e30613", "emblem": "emblem_K34.png", "border_home": "#d3a84c", "border_away": "#d3a84c"},
    {"id": "gimpo",    "sofascore_id": 195172, "name": "김포 FC",           "short": "김포",   "league": "K2", "primary": "#78bc36", "secondary": "#ebebeb", "accent": "#ffffff", "emblem": "emblem_K36.png", "border_home": "#0f2716", "border_away": "#0f2716"},
    {"id": "cheongju", "sofascore_id": 314293, "name": "충북 청주 FC",       "short": "청주",   "league": "K2", "primary": "#0d1026", "secondary": "#f0f0f0", "accent": "#ffffff", "emblem": "emblem_K37.png", "border_home": "#ae1d25", "border_away": "#0d1026"},
    {"id": "cheonan",  "sofascore_id": 41263,  "name": "천안 시티 FC",       "short": "천안",   "league": "K2", "primary": "#3e8fb3", "secondary": "#e2e2e2", "accent": "#e30613", "emblem": "emblem_K38.png", "border_home": "#201d1d", "border_away": "#3e8fb3"},
    {"id": "hwaseong", "sofascore_id": 195174, "name": "화성 FC",           "short": "화성",   "league": "K2", "primary": "#d45820", "secondary": "#ffffff", "accent": "#ffffff", "emblem": "emblem_K39.png", "border_home": "#fbf5f6", "border_away": "#090811"},
    {"id": "paju",     "sofascore_id": 314294, "name": "파주 시민축구단",     "short": "파주",   "league": "K2", "primary": "#042ba0", "secondary": "#f8f8f8", "accent": "#c8102e", "emblem": "emblem_K40.png", "border_home": "#d381a2", "border_away": "#d381a2"},
    {"id": "gimhae",   "sofascore_id": 41260,  "name": "김해 FC",           "short": "김해",   "league": "K2", "primary": "#ac0d0e", "secondary": "#f3f3f3", "accent": "#ffd700", "emblem": "emblem_K41.png", "border_home": "#2c2c2c", "border_away": "#bba473"},
    {"id": "yongin",   "sofascore_id": 41266,  "name": "용인 시민축구단",     "short": "용인",   "league": "K2", "primary": "#910c26", "secondary": "#dddddd", "accent": "#ffd700", "emblem": "emblem_K42.png", "border_home": "#54bfe1", "border_away": "#8c0e29"},
    # K3 리그 및 기타 (팀명 표시 전용)
    {"id": "siheung",  "sofascore_id": 346812, "name": "시흥 시티",           "short": "시흥",   "league": "K3", "primary": "#000000", "secondary": "#ffffff", "accent": "#ffffff", "emblem": "", "border_home": "#000000", "border_away": "#000000"},
    {"id": "gyeongju", "sofascore_id": 41257,  "name": "경주 KHNP",          "short": "경주",   "league": "K3", "primary": "#000000", "secondary": "#ffffff", "accent": "#ffffff", "emblem": "", "border_home": "#000000", "border_away": "#000000"},
    {"id": "gangneung","sofascore_id": 41258,  "name": "강릉 시티 FC",        "short": "강릉",   "league": "K3", "primary": "#000000", "secondary": "#ffffff", "accent": "#ffffff", "emblem": "", "border_home": "#000000", "border_away": "#000000"},
    {"id": "mokpo",    "sofascore_id": 41259,  "name": "FC 목포",            "short": "목포",   "league": "K3", "primary": "#000000", "secondary": "#ffffff", "accent": "#ffffff", "emblem": "", "border_home": "#000000", "border_away": "#000000"},
    {"id": "changwon", "sofascore_id": 41262,  "name": "창원 시티 FC",        "short": "창원",   "league": "K3", "primary": "#000000", "secondary": "#ffffff", "accent": "#ffffff", "emblem": "", "border_home": "#000000", "border_away": "#000000"},
    {"id": "dj_korail","sofascore_id": 41264,  "name": "대전 코레일",         "short": "코레일", "league": "K3", "primary": "#000000", "secondary": "#ffffff", "accent": "#ffffff", "emblem": "", "border_home": "#000000", "border_away": "#000000"},
    {"id": "jinju",    "sofascore_id": 376197, "name": "진주 시민 FC",        "short": "진주",   "league": "K3", "primary": "#000000", "secondary": "#ffffff", "accent": "#ffffff", "emblem": "", "border_home": "#000000", "border_away": "#000000"},
    {"id": "seosan",   "sofascore_id": 1169779,"name": "서산 시민 FC",        "short": "서산",   "league": "K3", "primary": "#000000", "secondary": "#ffffff", "accent": "#ffffff", "emblem": "", "border_home": "#000000", "border_away": "#000000"},
    {"id": "jincheon", "sofascore_id": 1169782,"name": "진천 HR FC",         "short": "진천",   "league": "K3", "primary": "#000000", "secondary": "#ffffff", "accent": "#ffffff", "emblem": "", "border_home": "#000000", "border_away": "#000000"},
]


@app.route("/api/teams")
def teams():
    return jsonify(TEAMS)


PLAYER_STEP = 0.16  # 선수 간 고정 세로 간격

# 포메이션별 행 x-좌표 기준값 (GK 제외, 각 행의 공격 방향 깊이)
# 각 포메이션의 전술적 특성을 반영한 행 간 거리 — 등간격 대신 실측 기반 조정
FORMATION_ROW_X = {
    "4-4-2":   [0.15, 0.33, 0.47],          # DF · MF · FW
    "4-3-3":   [0.15, 0.33, 0.47],          # DF · MF(3) · FW(3)
    "3-4-3":   [0.15, 0.33, 0.47],          # DF(3) · MF(4) · FW(3)
    "4-2-3-1": [0.15, 0.26, 0.38, 0.47],   # DF · CDM(2) · AM(3) · ST — CDM이 DF 블록에 밀착
    "4-1-4-1": [0.15, 0.23, 0.36, 0.47],   # DF · CDM(1) · MF(4) · ST — CDM이 DF 바로 앞
    "3-5-2":   [0.15, 0.35, 0.47],          # DF(3) · MF(5) · FW(2)
    "5-4-1":   [0.15, 0.35, 0.47],          # DF(5) · MF(4) · ST
    "5-3-2":   [0.15, 0.33, 0.47],          # DF(5) · MF(3) · FW(2)
    "3-4-2-1": [0.15, 0.27, 0.39, 0.47],   # DF(3) · MF(4) · AM(2) · ST
    "3-4-1-2": [0.15, 0.27, 0.39, 0.47],   # DF(3) · MF(4) · AM(1) · FW(2)
    "4-5-1":   [0.15, 0.35, 0.47],          # DF · MF(5) · ST
    "4-4-1-1": [0.15, 0.27, 0.39, 0.47],   # DF · MF(4) · AM · ST
    "3-1-4-2": [0.15, 0.23, 0.35, 0.47],   # DF(3) · CDM · MF(4) · FW(2)
    "4-1-3-2": [0.15, 0.23, 0.35, 0.47],   # DF · CDM · MF(3) · FW(2)
    "3-2-4-1": [0.15, 0.26, 0.38, 0.47],   # DF(3) · DM(2) · MF(4) · ST
    "4-3-1-2": [0.15, 0.27, 0.39, 0.47],   # DF · MF(3) · AM · FW(2)
    "4-3-2-1": [0.15, 0.27, 0.39, 0.47],   # DF · MF(3) · AM(2) · ST
    "4-2-2-2": [0.15, 0.26, 0.37, 0.47],   # DF · DM(2) · MF(2) · FW(2)
    "3-5-1-1": [0.15, 0.30, 0.40, 0.47],   # DF(3) · MF(5) · AM · ST
    "3-3-3-1": [0.15, 0.27, 0.38, 0.47],   # DF(3) · MF(3) · AM(3) · ST
    "5-2-3":   [0.15, 0.33, 0.47],          # DF(5) · MF(2) · FW(3)
}

def compute_formation(formation_str):
    """포메이션 문자열 → 선수 좌표(0~1 정규화). FORMATION_ROW_X 기준값 우선 적용."""
    rows = [int(x) for x in formation_str.split("-")]
    positions = []

    positions.append({"x": 0.05, "y": 0.5})

    row_xs = FORMATION_ROW_X.get(formation_str)
    num_rows = len(rows)

    for row_idx, count in enumerate(rows):
        if row_xs and row_idx < len(row_xs):
            x = row_xs[row_idx]
        else:
            # 기준값 없는 포메이션: 0.15~0.47 등간격 fallback
            x = 0.15 + (row_idx / max(num_rows - 1, 1)) * 0.32

        for player_idx in range(count):
            if count == 1:
                y = 0.5
            else:
                total_h = min((count - 1) * PLAYER_STEP, 0.80)
                step = total_h / (count - 1)
                start = 0.5 - total_h / 2
                y = start + player_idx * step
            positions.append({"x": round(x, 3), "y": round(y, 3)})

    return positions


# 데이터 수집 대상에서 항상 제외할 매치 (synthetic event — lineup/avg/shot 없음).
# matches-by-date 목록과 event_id endpoint들이 함께 사용.
EXCLUDED_EVENT_IDS = {90333089}  # 2026-02-21 슈퍼컵 전북 vs 대전
EXCLUDED_EVENT_IDS_SQL = "(" + ",".join(str(i) for i in EXCLUDED_EVENT_IDS) + ")"


POSITION_LABELS = {
    "4-4-2": ["GK", "LB", "CB", "CB", "RB", "LM", "CM", "CM", "RM", "ST", "ST"],
    "4-3-3": ["GK", "LB", "CB", "CB", "RB", "CM", "CM", "CM", "LW", "ST", "RW"],
    "3-5-2": ["GK", "CB", "CB", "CB", "LM", "CM", "CDM", "CM", "RM", "ST", "ST"],
    "4-2-3-1": ["GK", "LB", "CB", "CB", "RB", "CDM", "CDM", "LW", "AM", "RW", "ST"],
    "4-1-4-1": ["GK", "LB", "CB", "CB", "RB", "CDM", "LM", "CM", "CM", "RM", "ST"],
    "3-4-3": ["GK", "CB", "CB", "CB", "LM", "CM", "CM", "RM", "LW", "ST", "RW"],
    "5-3-2": ["GK", "LWB", "CB", "CB", "CB", "RWB", "CM", "CM", "CM", "ST", "ST"],
    "5-4-1": ["GK", "LWB", "CB", "CB", "CB", "RWB", "LM", "CM", "CM", "RM", "ST"],
    "4-5-1":   ["GK", "LB", "CB", "CB", "RB", "LM", "CM", "CM", "CM", "RM", "ST"],
    "3-4-2-1": ["GK", "CB", "CB", "CB", "LM", "CM", "CM", "RM", "LW", "RW", "ST"],
    "3-4-1-2": ["GK", "CB", "CB", "CB", "LM", "CM", "CM", "RM", "AM", "ST", "ST"],
    "4-4-1-1": ["GK", "LB", "CB", "CB", "RB", "LM", "CM", "CM", "RM", "AM", "ST"],
    "3-1-4-2": ["GK", "CB", "CB", "CB", "CDM", "LM", "CM", "CM", "RM", "ST", "ST"],
}

def mirror_labels(labels):
    result = []
    for label in labels:
        if label.startswith("L"):
            result.append("R" + label[1:])
        elif label.startswith("R"):
            result.append("L" + label[1:])
        else:
            result.append(label)
    return result


FORMATIONS = {}
for name in POSITION_LABELS:
    team_a = compute_formation(name)
    team_b = [{"x": round(1.0 - p["x"], 3), "y": p["y"]} for p in compute_formation(name)]
    FORMATIONS[name] = {
        "teamA": team_a,
        "teamB": team_b,
        "labelsA": POSITION_LABELS[name],
        "labelsB": mirror_labels(POSITION_LABELS[name]),
    }


@app.route("/")
def index():
    resp = app.make_response(render_template("index.html", current_user=session.get("user")))
    # index.html은 cache-bust 위해 항상 새로 받게 — query(?v=N)는 정적 파일에서 immutable 캐시
    resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return resp


@app.route("/api/formations")
def formations():
    return jsonify(FORMATIONS)


@app.route("/api/saves", methods=["GET"])
def list_saves():
    saves = []
    for fname in os.listdir(SAVES_DIR):
        if not fname.endswith(".json"):
            continue
        fpath = os.path.join(SAVES_DIR, fname)
        with open(fpath, "r", encoding="utf-8") as f:
            data = json.load(f)
        saves.append({
            "id": data["id"],
            "name": data["name"],
            "formation": data.get("formation", ""),
            "createdAt": data.get("createdAt", ""),
            "updatedAt": data.get("updatedAt", ""),
        })
    saves.sort(key=lambda s: s["updatedAt"], reverse=True)
    return jsonify(saves)


import re
_SAFE_ID_RE = re.compile(r'^[a-zA-Z0-9_\-]+$')

def _safe_path(base_dir, file_id):
    """파일 ID를 검증하고 안전한 절대 경로를 반환한다. 경로 탈출 시 None."""
    if not file_id or not _SAFE_ID_RE.match(file_id):
        return None
    fpath = os.path.normpath(os.path.join(base_dir, f"{file_id}.json"))
    if not fpath.startswith(os.path.normpath(base_dir)):
        return None
    return fpath


@app.route("/api/saves", methods=["POST"])
def create_save():
    body = request.get_json()
    save_id = str(uuid.uuid4())[:8]
    now = datetime.now().isoformat()
    data = {
        "id": save_id,
        "name": body.get("name", "Untitled"),
        "formation": body.get("formation", ""),
        "players": body.get("players", []),
        "lines": body.get("lines", body.get("arrows", [])),
        "teamAId": body.get("teamAId"),
        "teamBId": body.get("teamBId"),
        "createdAt": now,
        "updatedAt": now,
    }
    fpath = _safe_path(SAVES_DIR, save_id)
    if not fpath:
        return jsonify({"error": "Invalid ID"}), 400
    with open(fpath, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    return jsonify(data), 201


@app.route("/api/saves/<save_id>", methods=["GET"])
def get_save(save_id):
    fpath = _safe_path(SAVES_DIR, save_id)
    if not fpath or not os.path.exists(fpath):
        return jsonify({"error": "Not found"}), 404
    with open(fpath, "r", encoding="utf-8") as f:
        data = json.load(f)
    return jsonify(data)


@app.route("/api/saves/<save_id>", methods=["PUT"])
def update_save(save_id):
    fpath = _safe_path(SAVES_DIR, save_id)
    if not fpath or not os.path.exists(fpath):
        return jsonify({"error": "Not found"}), 404
    with open(fpath, "r", encoding="utf-8") as f:
        existing = json.load(f)
    body = request.get_json()
    existing["name"] = body.get("name", existing["name"])
    existing["formation"] = body.get("formation", existing["formation"])
    existing["players"] = body.get("players", existing["players"])
    existing["lines"] = body.get("lines", existing.get("lines", existing.get("arrows", [])))
    existing["teamAId"] = body.get("teamAId", existing.get("teamAId"))
    existing["teamBId"] = body.get("teamBId", existing.get("teamBId"))
    existing["updatedAt"] = datetime.now().isoformat()
    with open(fpath, "w", encoding="utf-8") as f:
        json.dump(existing, f, ensure_ascii=False, indent=2)
    return jsonify(existing)


@app.route("/api/saves/<save_id>", methods=["DELETE"])
def delete_save(save_id):
    fpath = _safe_path(SAVES_DIR, save_id)
    if not fpath or not os.path.exists(fpath):
        return jsonify({"error": "Not found"}), 404
    os.remove(fpath)
    return jsonify({"ok": True})


# ── 스쿼드(선수 명단) API ──────────────────────────────────
@app.route("/api/squads", methods=["GET"])
def list_squads():
    team_id = request.args.get("teamId")
    squads = []
    for fname in os.listdir(SQUADS_DIR):
        if not fname.endswith(".json"):
            continue
        fpath = os.path.join(SQUADS_DIR, fname)
        with open(fpath, "r", encoding="utf-8") as f:
            data = json.load(f)
        if team_id and data.get("teamId") != team_id:
            continue
        squads.append({
            "id": data["id"],
            "teamId": data["teamId"],
            "name": data["name"],
            "playerCount": len(data.get("players", [])),
            "updatedAt": data.get("updatedAt", ""),
        })
    squads.sort(key=lambda s: s["updatedAt"], reverse=True)
    return jsonify(squads)


@app.route("/api/squads", methods=["POST"])
def create_squad():
    body = request.get_json()
    squad_id = str(uuid.uuid4())[:8]
    now = datetime.now().isoformat()
    data = {
        "id": squad_id,
        "teamId": body.get("teamId", ""),
        "name": body.get("name", "Untitled"),
        "players": body.get("players", []),
        "createdAt": now,
        "updatedAt": now,
    }
    fpath = _safe_path(SQUADS_DIR, squad_id)
    if not fpath:
        return jsonify({"error": "Invalid ID"}), 400
    with open(fpath, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    return jsonify(data), 201


@app.route("/api/squads/<squad_id>", methods=["GET"])
def get_squad(squad_id):
    # 직접 파일명으로 시도
    fpath = _safe_path(SQUADS_DIR, squad_id)
    if not fpath:
        return jsonify({"error": "Invalid ID"}), 400
    if not os.path.exists(fpath):
        # 내부 id로 스캔 (safe: listdir은 SQUADS_DIR 내부만 탐색)
        fpath = None
        for fname in os.listdir(SQUADS_DIR):
            if not fname.endswith(".json"):
                continue
            candidate = os.path.join(SQUADS_DIR, fname)
            with open(candidate, "r", encoding="utf-8") as f:
                d = json.load(f)
            if d.get("id") == squad_id:
                fpath = candidate
                break
    if not fpath:
        return jsonify({"error": "Not found"}), 404
    with open(fpath, "r", encoding="utf-8") as f:
        data = json.load(f)
    return jsonify(data)


@app.route("/api/squads/<squad_id>", methods=["DELETE"])
def delete_squad(squad_id):
    # 직접 파일명으로 시도
    fpath = _safe_path(SQUADS_DIR, squad_id)
    if not fpath:
        return jsonify({"error": "Invalid ID"}), 400
    if not os.path.exists(fpath):
        # 내부 id로 스캔
        fpath = None
        for fname in os.listdir(SQUADS_DIR):
            if not fname.endswith(".json"):
                continue
            candidate = os.path.join(SQUADS_DIR, fname)
            with open(candidate, "r", encoding="utf-8") as f:
                d = json.load(f)
            if d.get("id") == squad_id:
                fpath = candidate
                break
    if not fpath:
        return jsonify({"error": "Not found"}), 404
    os.remove(fpath)
    return jsonify({"ok": True})


# ── 경기 결과 / H2H / 팀 스탯 API ──────────────────────
RESULTS_FILE  = os.path.join(BASE_DIR, "data", "kleague_results_2026.json")
H2H_FILE      = os.path.join(BASE_DIR, "data", "kleague_h2h.json")
STATS_FILE    = os.path.join(BASE_DIR, "data", "kleague_team_stats.json")

@app.route("/api/results")
@cached_response(ttl=3600)
def get_results():
    team_id = request.args.get("teamId")
    if not os.path.exists(RESULTS_FILE):
        return jsonify([])
    with open(RESULTS_FILE, "r", encoding="utf-8") as f:
        all_results = json.load(f)
    if team_id:
        return jsonify(all_results.get(team_id, []))
    return jsonify(all_results)

@app.route("/api/h2h")
@cached_response(ttl=3600)
def get_h2h():
    team_a = request.args.get("teamA")
    team_b = request.args.get("teamB")
    if not team_a or not team_b:
        return jsonify({"error": "teamA and teamB required"}), 400
    if not os.path.exists(H2H_FILE):
        return jsonify({"w": 0, "d": 0, "l": 0, "total": 0})
    with open(H2H_FILE, "r", encoding="utf-8") as f:
        h2h = json.load(f)
    key = f"{team_a}|{team_b}"
    return jsonify(h2h.get(key, {"w": 0, "d": 0, "l": 0, "total": 0}))

@app.route("/api/h2h-matches")
@cached_response(ttl=3600)
def get_h2h_matches():
    """두 팀 간 최근 맞대결 경기 목록 + 득점 선수 (events DB 기반)"""
    team_a = request.args.get("teamA")
    team_b = request.args.get("teamB")
    year   = request.args.get("year")            # optional: "2026" 등
    limit  = request.args.get("limit", type=int) # optional: default 10
    if limit is None or limit <= 0 or limit > 100:
        limit = 10
    if not team_a or not team_b:
        return jsonify([])
    info_a = next((t for t in TEAMS if t["id"] == team_a), None)
    info_b = next((t for t in TEAMS if t["id"] == team_b), None)
    if not info_a or not info_b:
        return jsonify([])
    ss_a, ss_b = info_a["sofascore_id"], info_b["sofascore_id"]

    # 팀 리그 기반 tournament_id 결정 (기존 K2 하드코딩 → K1 대응)
    # 두 팀 리그가 다르면 team_a 리그를 기준으로 함 (교차 리그는 맞대결 없음)
    tid = 410 if info_a.get("league") == "K1" else 777

    db_path = DB_PATH
    if not os.path.exists(db_path):
        return jsonify([])

    from datetime import datetime, timezone
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    year_clause = "AND strftime('%Y', datetime(date_ts,'unixepoch','localtime')) = ?" if year else ""
    yp = [year] if year else []

    cur.execute(f"""
        SELECT id, date_ts, home_team_id, away_team_id, home_team_name, away_team_name,
               home_score, away_score
        FROM events
        WHERE tournament_id = ?
          AND home_score IS NOT NULL
          AND ((home_team_id=? AND away_team_id=?) OR (home_team_id=? AND away_team_id=?))
          {year_clause}
        ORDER BY date_ts DESC
        LIMIT ?
    """, (tid, ss_a, ss_b, ss_b, ss_a, *yp, limit))
    rows = cur.fetchall()

    result = []
    for event_id, ts, home_id, away_id, home_name, away_name, hs, as_ in rows:
        date_str = datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")
        is_home_a = (home_id == ss_a)
        result_a = "W" if (is_home_a and hs > as_) or (not is_home_a and as_ > hs) \
                   else ("D" if hs == as_ else "L")

        # 득점 선수 조회 (자책골 제외: 홈팀 득점자만 홈에, 원정팀 득점자만 원정에)
        cur.execute("""
            SELECT mps.team_id,
                   COALESCE(p.name_ko, mps.player_name, p.name) as name,
                   SUM(mps.goals) as g
            FROM match_player_stats mps
            LEFT JOIN players p ON mps.player_id = p.id
            WHERE mps.event_id = ? AND mps.goals > 0
            GROUP BY mps.player_id, mps.team_id
            ORDER BY mps.team_id, g DESC
        """, (event_id,))
        scorer_rows = cur.fetchall()

        # 홈팀 득점자는 home_id와 team_id가 일치하는 선수만
        # 원정팀 득점자는 away_id(= not home_id)와 team_id가 일치하는 선수만
        scorers_home = [{"name": r[1], "goals": r[2]} for r in scorer_rows if r[0] == home_id]
        scorers_away = [{"name": r[1], "goals": r[2]} for r in scorer_rows if r[0] == away_id]

        result.append({
            "date": date_str,
            "home": home_name,
            "away": away_name,
            "home_score": hs,
            "away_score": as_,
            "result_a": result_a,
            "is_home_a": is_home_a,
            "scorers_home": scorers_home,
            "scorers_away": scorers_away,
        })

    conn.close()
    return jsonify(result)

@app.route("/api/team-stats")
@cached_response(ttl=3600)
def get_team_stats():
    team_id = request.args.get("teamId")
    if not os.path.exists(STATS_FILE):
        return jsonify({})
    with open(STATS_FILE, "r", encoding="utf-8") as f:
        stats = json.load(f)
    if team_id:
        return jsonify(stats.get(team_id, {}))
    return jsonify(stats)


@app.route("/api/team-stats-by-year")
@cached_response(ttl=3600)
def get_team_stats_by_year():
    """연도별 홈/원정 승무패 (match_player_stats DB 기반)"""
    team_id = request.args.get("teamId")
    if not team_id:
        return jsonify({})

    # slug → sofascore_id 변환
    team_info = next((t for t in TEAMS if t["id"] == team_id), None)
    if not team_info:
        return jsonify({})
    ss_id = team_info["sofascore_id"]

    db_path = DB_PATH
    if not os.path.exists(db_path):
        return jsonify({})

    conn = sqlite3.connect(db_path)
    cur = conn.cursor()
    cur.execute("""
        SELECT strftime('%Y', datetime(e.date_ts, 'unixepoch', 'localtime')) as year,
               CASE WHEN e.home_team_id = ? THEN 1 ELSE 0 END as is_home,
               COUNT(CASE WHEN (e.home_team_id=? AND e.home_score > e.away_score)
                            OR (e.away_team_id=? AND e.away_score > e.home_score) THEN 1 END) as w,
               COUNT(CASE WHEN e.home_score = e.away_score THEN 1 END) as d,
               COUNT(CASE WHEN (e.home_team_id=? AND e.home_score < e.away_score)
                            OR (e.away_team_id=? AND e.away_score < e.home_score) THEN 1 END) as l,
               COUNT(*) as games,
               SUM(CASE WHEN e.home_team_id=? THEN e.home_score ELSE e.away_score END) as gf,
               SUM(CASE WHEN e.home_team_id=? THEN e.away_score ELSE e.home_score END) as ga
        FROM events e
        WHERE (e.home_team_id = ? OR e.away_team_id = ?)
          AND e.home_score IS NOT NULL
          AND e.tournament_id = 777
        GROUP BY year, is_home
        ORDER BY year, is_home
    """, (ss_id, ss_id, ss_id, ss_id, ss_id, ss_id, ss_id, ss_id, ss_id))
    rows = cur.fetchall()
    conn.close()

    result = {}
    total = {"home": {"w": 0, "d": 0, "l": 0, "games": 0, "gf": 0, "ga": 0},
             "away": {"w": 0, "d": 0, "l": 0, "games": 0, "gf": 0, "ga": 0}}
    for year, is_home, w, d, l, games, gf, ga in rows:
        if year not in result:
            result[year] = {"home": {}, "away": {}}
        key = "home" if is_home else "away"
        result[year][key] = {"w": w, "d": d, "l": l, "games": games, "gf": gf or 0, "ga": ga or 0}
        total[key]["w"] += w
        total[key]["d"] += d
        total[key]["l"] += l
        total[key]["games"] += games
        total[key]["gf"] += gf or 0
        total[key]["ga"] += ga or 0

    result["전체"] = total
    return jsonify(result)


@app.route("/api/team-ranking")
@cached_response(ttl=1800)
def get_team_ranking():
    """현재 시즌(최신 연도) 리그 순위 계산"""
    team_id = request.args.get("teamId")
    team_info = next((t for t in TEAMS if t["id"] == team_id), None)
    if not team_info:
        return jsonify({})
    ss_id = team_info["sofascore_id"]

    db_path = DB_PATH
    if not os.path.exists(db_path):
        return jsonify({})

    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    # 최신 연도 확인
    cur.execute("""
        SELECT MAX(strftime('%Y', datetime(date_ts,'unixepoch','localtime')))
        FROM events WHERE tournament_id = 777
    """)
    row = cur.fetchone()
    latest_year = row[0] if row and row[0] else str(datetime.now().year)

    # 해당 연도 전체 경기
    cur.execute("""
        SELECT home_team_id, away_team_id, home_score, away_score
        FROM events
        WHERE tournament_id = 777
          AND home_score IS NOT NULL
          AND strftime('%Y', datetime(date_ts,'unixepoch','localtime')) = ?
    """, (latest_year,))
    rows = cur.fetchall()
    conn.close()

    # 팀별 집계
    standings = {}
    for home_id, away_id, hs, as_ in rows:
        for tid, gf, ga, is_home in [(home_id, hs, as_, True), (away_id, as_, hs, False)]:
            if tid not in standings:
                standings[tid] = {"w": 0, "d": 0, "l": 0, "gf": 0, "ga": 0, "pts": 0}
            s = standings[tid]
            s["gf"] += gf
            s["ga"] += ga
            if gf > ga:
                s["w"] += 1; s["pts"] += 3
            elif gf == ga:
                s["d"] += 1; s["pts"] += 1
            else:
                s["l"] += 1

    # 정렬: 승점 → 득실차 → 득점
    sorted_teams = sorted(standings.items(),
                          key=lambda x: (x[1]["pts"], x[1]["gf"] - x[1]["ga"], x[1]["gf"]),
                          reverse=True)
    rank = next((i + 1 for i, (tid, _) in enumerate(sorted_teams) if tid == ss_id), None)
    total_teams = len(sorted_teams)
    my = standings.get(ss_id, {})

    return jsonify({
        "rank": rank,
        "total": total_teams,
        "year": latest_year,
        "w": my.get("w", 0),
        "d": my.get("d", 0),
        "l": my.get("l", 0),
        "gf": my.get("gf", 0),
        "ga": my.get("ga", 0),
        "pts": my.get("pts", 0),
    })


@app.route("/api/team-top-players")
@cached_response(ttl=1800)
def get_team_top_players():
    """현재 시즌 팀 득점/어시스트 TOP 3"""
    team_id = request.args.get("teamId")
    team_info = next((t for t in TEAMS if t["id"] == team_id), None)
    if not team_info:
        return jsonify({})
    ss_id = team_info["sofascore_id"]

    db_path = DB_PATH
    if not os.path.exists(db_path):
        return jsonify({})

    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    # 최신 연도
    cur.execute("""
        SELECT MAX(strftime('%Y', datetime(date_ts,'unixepoch','localtime')))
        FROM events WHERE tournament_id = 777
    """)
    row = cur.fetchone()
    latest_year = row[0] if row and row[0] else str(datetime.now().year)

    _ALLOWED_TOP_STATS = {"goals", "assists"}

    def fetch_top(stat_col, limit=3):
        if stat_col not in _ALLOWED_TOP_STATS:
            raise ValueError(f"disallowed stat column: {stat_col}")
        cur.execute(f"""
            SELECT mps.player_id, mps.player_name,
                   COALESCE(p.name_ko, mps.player_name, p.name) as display_name,
                   SUM(mps.{stat_col}) as total
            FROM match_player_stats mps
            JOIN events e ON mps.event_id = e.id
            LEFT JOIN players p ON mps.player_id = p.id
            WHERE mps.team_id = ?
              AND e.tournament_id = 777
              AND strftime('%Y', datetime(e.date_ts,'unixepoch','localtime')) = ?
              AND mps.{stat_col} > 0
            GROUP BY mps.player_id
            ORDER BY total DESC
            LIMIT ?
        """, (ss_id, latest_year, limit))
        return [{"name": row[2], "val": row[3]} for row in cur.fetchall()]

    scorers = fetch_top("goals")
    assisters = fetch_top("assists")
    conn.close()

    return jsonify({"year": latest_year, "scorers": scorers, "assisters": assisters})


_ENG_TO_KO = {t["sofascore_id"]: t["name"] for t in TEAMS}

def _ko_name_by_ss_id(ss_id):
    """sofascore team id (int 또는 str) → 한국어 팀명"""
    try:
        return _ENG_TO_KO.get(int(ss_id)) or _ENG_TO_KO.get(ss_id)
    except (ValueError, TypeError):
        return _ENG_TO_KO.get(ss_id)


_LEAGUE_TID_BY_KEY = {"K1": 410, "K2": 777}


def _team_league(ss_id):
    """sofascore team id → ('K1'|'K2', tournament_id). 매칭 안 되면 ('K2', 777) 기본."""
    try:
        sid = int(ss_id)
    except (ValueError, TypeError):
        return "K2", 777
    for t in TEAMS:
        if t["sofascore_id"] == sid:
            key = t.get("league", "K2")
            return key, _LEAGUE_TID_BY_KEY.get(key, 777)
    return "K2", 777


@app.route("/api/team-analytics")
@cached_response(ttl=3600)
def get_team_analytics():
    """팀별 상대팀 승률 / 월별 승률 / 홈어웨이 분석"""
    team_id = request.args.get("teamId")
    year    = request.args.get("year")          # optional filter
    team_info = next((t for t in TEAMS if t["id"] == team_id), None)
    if not team_info:
        return jsonify({}), 404

    ss_id = team_info["sofascore_id"]
    db_path = DB_PATH
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    # 사용 가능 연도 목록
    cur.execute("""
        SELECT DISTINCT strftime('%Y', datetime(date_ts,'unixepoch','localtime'))
        FROM events WHERE tournament_id=777
          AND (home_team_id=? OR away_team_id=?)
        ORDER BY 1
    """, (ss_id, ss_id))
    available_years = [r[0] for r in cur.fetchall()]

    year_clause = "AND strftime('%Y', datetime(date_ts,'unixepoch','localtime')) = ?" if year else ""
    yp = (year,) if year else ()

    # 1. 상대팀별 승률 (홈+원정 합산, 팀 ID 포함해 한글명 변환)
    cur.execute("""
        SELECT opp_id, opp_name, SUM(g) games,
               SUM(w) w, SUM(d) d, SUM(l) l,
               SUM(gf) gf, SUM(ga) ga
        FROM (
            SELECT away_team_id opp_id, away_team_name opp_name,
                   COUNT(*) g,
                   SUM(CASE WHEN home_score > away_score THEN 1 ELSE 0 END) w,
                   SUM(CASE WHEN home_score = away_score THEN 1 ELSE 0 END) d,
                   SUM(CASE WHEN home_score < away_score THEN 1 ELSE 0 END) l,
                   SUM(home_score) gf, SUM(away_score) ga
            FROM events WHERE tournament_id=777 AND home_team_id=? {yc}
            GROUP BY away_team_id
            UNION ALL
            SELECT home_team_id opp_id, home_team_name opp_name,
                   COUNT(*) g,
                   SUM(CASE WHEN away_score > home_score THEN 1 ELSE 0 END) w,
                   SUM(CASE WHEN home_score = away_score THEN 1 ELSE 0 END) d,
                   SUM(CASE WHEN away_score < home_score THEN 1 ELSE 0 END) l,
                   SUM(away_score) gf, SUM(home_score) ga
            FROM events WHERE tournament_id=777 AND away_team_id=? {yc}
            GROUP BY home_team_id
        )
        GROUP BY opp_id ORDER BY games DESC, w DESC
    """.format(yc=year_clause), (ss_id, *yp, ss_id, *yp))
    vs_rows = cur.fetchall()
    vs_opponents = [
        {"name": _ko_name_by_ss_id(r[0]) or r[1],
         "games": r[2], "w": r[3], "d": r[4], "l": r[5],
         "gf": r[6], "ga": r[7]}
        for r in vs_rows
    ]

    # 2. 월별 승률
    cur.execute("""
        SELECT mon, SUM(g) games, SUM(w) w, SUM(d) d, SUM(l) l, SUM(gf) gf, SUM(ga) ga
        FROM (
            SELECT CAST(strftime('%m', datetime(date_ts,'unixepoch','localtime')) AS INT) mon,
                   COUNT(*) g,
                   SUM(CASE WHEN home_score > away_score THEN 1 ELSE 0 END) w,
                   SUM(CASE WHEN home_score = away_score THEN 1 ELSE 0 END) d,
                   SUM(CASE WHEN home_score < away_score THEN 1 ELSE 0 END) l,
                   SUM(home_score) gf, SUM(away_score) ga
            FROM events WHERE tournament_id=777 AND home_team_id=? {yc}
            GROUP BY mon
            UNION ALL
            SELECT CAST(strftime('%m', datetime(date_ts,'unixepoch','localtime')) AS INT) mon,
                   COUNT(*) g,
                   SUM(CASE WHEN away_score > home_score THEN 1 ELSE 0 END) w,
                   SUM(CASE WHEN home_score = away_score THEN 1 ELSE 0 END) d,
                   SUM(CASE WHEN away_score < home_score THEN 1 ELSE 0 END) l,
                   SUM(away_score) gf, SUM(home_score) ga
            FROM events WHERE tournament_id=777 AND away_team_id=? {yc}
            GROUP BY mon
        )
        GROUP BY mon ORDER BY mon
    """.format(yc=year_clause), (ss_id, *yp, ss_id, *yp))
    month_rows = cur.fetchall()
    by_month = [
        {"month": r[0], "games": r[1], "w": r[2], "d": r[3], "l": r[4],
         "gf": r[5], "ga": r[6]}
        for r in month_rows
    ]

    # 3. 홈/어웨이 연도별 승률
    cur.execute("""
        SELECT yr, side, SUM(g) games, SUM(w) w, SUM(d) d, SUM(l) l, SUM(gf) gf, SUM(ga) ga
        FROM (
            SELECT strftime('%Y', datetime(date_ts,'unixepoch','localtime')) yr,
                   'home' side,
                   COUNT(*) g,
                   SUM(CASE WHEN home_score > away_score THEN 1 ELSE 0 END) w,
                   SUM(CASE WHEN home_score = away_score THEN 1 ELSE 0 END) d,
                   SUM(CASE WHEN home_score < away_score THEN 1 ELSE 0 END) l,
                   SUM(home_score) gf, SUM(away_score) ga
            FROM events WHERE tournament_id=777 AND home_team_id=? {yc}
            GROUP BY yr
            UNION ALL
            SELECT strftime('%Y', datetime(date_ts,'unixepoch','localtime')) yr,
                   'away' side,
                   COUNT(*) g,
                   SUM(CASE WHEN away_score > home_score THEN 1 ELSE 0 END) w,
                   SUM(CASE WHEN home_score = away_score THEN 1 ELSE 0 END) d,
                   SUM(CASE WHEN away_score < home_score THEN 1 ELSE 0 END) l,
                   SUM(away_score) gf, SUM(home_score) ga
            FROM events WHERE tournament_id=777 AND away_team_id=? {yc}
            GROUP BY yr
        )
        GROUP BY yr, side ORDER BY yr, side
    """.format(yc=year_clause), (ss_id, *yp, ss_id, *yp))
    ha_rows = cur.fetchall()
    by_year_ha = {}
    for yr, side, g, w, d, l, gf, ga in ha_rows:
        if yr not in by_year_ha:
            by_year_ha[yr] = {}
        by_year_ha[yr][side] = {"games": g, "w": w, "d": d, "l": l, "gf": gf, "ga": ga}

    # 4. 날씨별 승률 (기온 / 습도 / 풍속)
    weather_sql = """
        SELECT
            e.id,
            CASE WHEN mps.team_id = ? THEN
                CASE WHEN (mps.is_home=1 AND e.home_score > e.away_score)
                          OR (mps.is_home=0 AND e.away_score > e.home_score) THEN 'w'
                     WHEN e.home_score = e.away_score THEN 'd'
                     ELSE 'l' END
            END result,
            CASE WHEN mps.is_home=1 THEN e.home_score ELSE e.away_score END gf,
            CASE WHEN mps.is_home=1 THEN e.away_score ELSE e.home_score END ga,
            mps.temperature, mps.humidity, mps.wind_speed
        FROM events e
        JOIN match_player_stats mps ON e.id = mps.event_id
        WHERE e.tournament_id = 777
          AND mps.team_id = ?
          AND mps.temperature IS NOT NULL
          {yc_e}
        GROUP BY e.id
    """.format(yc_e="AND strftime('%Y', datetime(e.date_ts,'unixepoch','localtime')) = ?" if year else "")
    cur.execute(weather_sql, (ss_id, ss_id, *yp))
    w_rows = cur.fetchall()

    def bucket_weather(rows, key_fn, labels):
        buckets = {lbl: {"games":0,"w":0,"d":0,"l":0,"gf":0,"ga":0} for lbl in labels}
        for _, result, gf, ga, temp, hum, wind in rows:
            lbl = key_fn(temp, hum, wind)
            if lbl and result:
                b = buckets[lbl]
                b["games"] += 1
                b[result] += 1
                b["gf"] += gf or 0
                b["ga"] += ga or 0
        return [{"label": k, **v} for k, v in buckets.items() if v["games"] > 0]

    temp_labels  = ["영하~5도","5~15도","15~25도","25도~"]
    hum_labels   = ["건조(<40%)","보통(40~65%)","습함(65%+)"]
    wind_labels  = ["약풍(<3)","중풍(3~7)","강풍(7+)"]

    by_temp = bucket_weather(w_rows,
        lambda t,h,w: "영하~5도" if t<5 else "5~15도" if t<15 else "15~25도" if t<25 else "25도~",
        temp_labels)
    by_hum  = bucket_weather(w_rows,
        lambda t,h,w: "건조(<40%)" if h<40 else "보통(40~65%)" if h<65 else "습함(65%+)",
        hum_labels)
    by_wind = bucket_weather(w_rows,
        lambda t,h,w: "약풍(<3)" if w<3 else "중풍(3~7)" if w<7 else "강풍(7+)",
        wind_labels)

    conn.close()
    return jsonify({
        "team": team_info["name"],
        "available_years": available_years,
        "vs_opponents": vs_opponents,
        "by_month": by_month,
        "by_year_ha": by_year_ha,
        "weather": {
            "by_temp": by_temp,
            "by_hum": by_hum,
            "by_wind": by_wind,
        },
    })


@app.route("/api/team-compare")
@cached_response(ttl=3600)
def get_team_compare():
    """두 팀의 주요 스탯을 동일 기준으로 병렬 집계 (팀 비교용)."""
    team_a = request.args.get("teamA")
    team_b = request.args.get("teamB")
    year   = request.args.get("year")  # optional

    info_a = next((t for t in TEAMS if t["id"] == team_a), None)
    info_b = next((t for t in TEAMS if t["id"] == team_b), None)
    if not info_a or not info_b:
        return jsonify({"error": "teamA/teamB required"}), 400

    db_path = DB_PATH
    if not os.path.exists(db_path):
        return jsonify({"error": "db not found"}), 500

    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    def _tid_for(info):
        # league → tournament_id (K1=410, 그 외 K2=777)
        return 410 if info.get("league") == "K1" else 777

    def _compute(info):
        ss_id = info["sofascore_id"]
        tid   = _tid_for(info)
        year_clause = "AND strftime('%Y', datetime(date_ts,'unixepoch','localtime')) = ?" if year else ""
        yp = [year] if year else []

        # 전체 누적 (홈+원정)
        cur.execute(f"""
            SELECT
              COUNT(*) AS games,
              SUM(CASE WHEN (home_team_id=? AND home_score > away_score)
                        OR (away_team_id=? AND away_score > home_score) THEN 1 ELSE 0 END) w,
              SUM(CASE WHEN home_score = away_score THEN 1 ELSE 0 END) d,
              SUM(CASE WHEN (home_team_id=? AND home_score < away_score)
                        OR (away_team_id=? AND away_score < home_score) THEN 1 ELSE 0 END) l,
              SUM(CASE WHEN home_team_id=? THEN home_score ELSE away_score END) gf,
              SUM(CASE WHEN home_team_id=? THEN away_score ELSE home_score END) ga
            FROM events
            WHERE tournament_id=?
              AND home_score IS NOT NULL
              AND (home_team_id=? OR away_team_id=?)
              {year_clause}
        """, (ss_id, ss_id, ss_id, ss_id, ss_id, ss_id, tid, ss_id, ss_id, *yp))
        games, w, d, l, gf, ga = cur.fetchone()
        games = games or 0
        w = w or 0; d = d or 0; l = l or 0
        gf = gf or 0; ga = ga or 0

        # 홈/원정 분할
        cur.execute(f"""
            SELECT 'home', COUNT(*),
                   SUM(CASE WHEN home_score > away_score THEN 1 ELSE 0 END),
                   SUM(CASE WHEN home_score = away_score THEN 1 ELSE 0 END),
                   SUM(CASE WHEN home_score < away_score THEN 1 ELSE 0 END),
                   SUM(home_score), SUM(away_score)
            FROM events
            WHERE tournament_id=? AND home_team_id=? AND home_score IS NOT NULL
              {year_clause}
            UNION ALL
            SELECT 'away', COUNT(*),
                   SUM(CASE WHEN away_score > home_score THEN 1 ELSE 0 END),
                   SUM(CASE WHEN home_score = away_score THEN 1 ELSE 0 END),
                   SUM(CASE WHEN away_score < home_score THEN 1 ELSE 0 END),
                   SUM(away_score), SUM(home_score)
            FROM events
            WHERE tournament_id=? AND away_team_id=? AND home_score IS NOT NULL
              {year_clause}
        """, (tid, ss_id, *yp, tid, ss_id, *yp))
        ha = {"home": {}, "away": {}}
        for side, g, ww, dd, ll, gf_, ga_ in cur.fetchall():
            ha[side] = {"games": g or 0, "w": ww or 0, "d": dd or 0, "l": ll or 0,
                        "gf": gf_ or 0, "ga": ga_ or 0}

        # 최근 5경기 폼
        cur.execute(f"""
            SELECT
              CASE WHEN home_team_id=? THEN
                CASE WHEN home_score > away_score THEN 'W'
                     WHEN home_score = away_score THEN 'D' ELSE 'L' END
              ELSE
                CASE WHEN away_score > home_score THEN 'W'
                     WHEN home_score = away_score THEN 'D' ELSE 'L' END
              END
            FROM events
            WHERE tournament_id=? AND home_score IS NOT NULL
              AND (home_team_id=? OR away_team_id=?)
              {year_clause}
            ORDER BY date_ts DESC
            LIMIT 5
        """, (ss_id, tid, ss_id, ss_id, *yp))
        form = [r[0] for r in cur.fetchall()]

        # 경기당 xG (최근 연도 내 평균, fallback = 실제 득실)
        cur.execute(f"""
            SELECT
              AVG(CASE WHEN mps.is_home=1 THEN mps.expected_goals END) xg_home,
              AVG(CASE WHEN mps.is_home=0 THEN mps.expected_goals END) xg_away
            FROM match_player_stats mps
            JOIN events e ON e.id = mps.event_id
            WHERE mps.team_id=? AND mps.expected_goals IS NOT NULL
              AND e.tournament_id=?
              {year_clause.replace('date_ts', 'e.date_ts') if year else ''}
        """, (ss_id, tid, *yp))
        row = cur.fetchone()
        xg_home = row[0] if row and row[0] is not None else None
        xg_away = row[1] if row and row[1] is not None else None

        def _pct(n, total): return round(n / total * 100, 1) if total else 0.0

        return {
            "id": info["id"],
            "name": info["name"],
            "short": info.get("short"),
            "league": info.get("league"),
            "emblem": info.get("emblem"),
            "primary": info.get("primary"),
            "accent": info.get("accent"),
            "games": games, "w": w, "d": d, "l": l,
            "gf": gf, "ga": ga, "gd": gf - ga,
            "pts": w * 3 + d,
            "win_pct": _pct(w, games),
            "draw_pct": _pct(d, games),
            "loss_pct": _pct(l, games),
            "avg_gf": round(gf / games, 2) if games else 0,
            "avg_ga": round(ga / games, 2) if games else 0,
            "ppg":    round((w * 3 + d) / games, 2) if games else 0,
            "clean_sheet_pct": None,  # 자리만 확보, 추후 확장
            "form": form,
            "home": ha["home"],
            "away": ha["away"],
            "xg_home": round(xg_home, 2) if xg_home is not None else None,
            "xg_away": round(xg_away, 2) if xg_away is not None else None,
        }

    result_a = _compute(info_a)
    result_b = _compute(info_b)

    # 두 팀 공통 사용 가능 연도
    ss_a, ss_b = info_a["sofascore_id"], info_b["sofascore_id"]
    cur.execute("""
        SELECT DISTINCT strftime('%Y', datetime(date_ts,'unixepoch','localtime'))
        FROM events
        WHERE home_team_id IN (?,?) OR away_team_id IN (?,?)
        ORDER BY 1
    """, (ss_a, ss_b, ss_a, ss_b))
    available_years = [r[0] for r in cur.fetchall() if r[0]]

    # H2H (A 기준 승/무/패, 득실)
    h2h_yc = "AND strftime('%Y', datetime(date_ts,'unixepoch','localtime')) = ?" if year else ""
    h2h_params = [ss_a, ss_a, ss_a, ss_a, ss_b, ss_b, ss_a]
    if year:
        h2h_params.append(year)
    cur.execute(f"""
        SELECT COUNT(*),
               SUM(CASE WHEN home_team_id=? THEN
                     CASE WHEN home_score>away_score THEN 1 ELSE 0 END
                   ELSE
                     CASE WHEN away_score>home_score THEN 1 ELSE 0 END
                   END),
               SUM(CASE WHEN home_score=away_score THEN 1 ELSE 0 END),
               SUM(CASE WHEN home_team_id=? THEN home_score ELSE away_score END),
               SUM(CASE WHEN home_team_id=? THEN away_score ELSE home_score END)
        FROM events
        WHERE home_score IS NOT NULL
          AND ((home_team_id=? AND away_team_id=?) OR (home_team_id=? AND away_team_id=?))
          {h2h_yc}
    """, h2h_params)
    h2h_row = cur.fetchone()
    h2h_g       = h2h_row[0] or 0
    h2h_a_wins  = h2h_row[1] or 0
    h2h_draws   = h2h_row[2] or 0
    h2h_a_gf    = h2h_row[3] or 0
    h2h_a_ga    = h2h_row[4] or 0
    h2h_b_wins  = max(0, h2h_g - h2h_a_wins - h2h_draws)

    conn.close()

    return jsonify({
        "teamA": result_a,
        "teamB": result_b,
        "available_years": available_years,
        "year": year or "전체",
        "same_league": info_a.get("league") == info_b.get("league"),
        "h2h": {
            "games": h2h_g,
            "a_wins": h2h_a_wins,
            "draws":  h2h_draws,
            "b_wins": h2h_b_wins,
            "a_gf":   h2h_a_gf,
            "a_ga":   h2h_a_ga,
        },
    })


# ═══════════════════════════════════════════════════════════════
# /api/league-rankings — 팀 비교용 리그 순위 7지표 (30분 캐시)
# ═══════════════════════════════════════════════════════════════

# (league, year) → (result_dict, expires_epoch)
_league_rankings_cache = {}
_LEAGUE_RANKINGS_TTL = 30 * 60  # 30분
_MIN_SAMPLE_MATCHES  = 5        # 이 아래면 순위 제외 (샘플 부족)

# 지표 정의: key, 라벨, 방향(higher=값이 클수록 좋음 / lower=작을수록 좋음), 포맷
_LR_METRICS = [
    ("xg_conversion",          "xG 실현율",        "higher", "ratio2"),
    ("xg_per_game",            "경기당 xG",        "higher", "num2"),
    ("shot_accuracy",          "유효슈팅 %",       "higher", "pct1"),
    ("big_miss_per_game",      "빅찬스 미스/경기", "lower",  "num2"),
    ("duel_won_pct",           "듀얼 승률 %",      "higher", "pct1"),
    ("tackles_per_game",       "경기당 태클",      "higher", "num1"),
    ("gf_per_game",            "경기당 득점",      "higher", "num2"),
    ("ga_per_game",            "경기당 실점",      "lower",  "num2"),
    ("form_ppg_last5",         "최근 5경기 PPG",   "higher", "num2"),
    ("first_goal_win_pct",     "선제득점 시 승률", "higher", "pct1"),
    ("first_conceded_win_pct", "선제실점 후 승률", "higher", "pct1"),
]


@app.route("/api/league-rankings")
def get_league_rankings():
    """팀별 7개 고급 지표 + 리그 내 순위 (30분 메모리 캐시)."""
    league = (request.args.get("league") or "K1").upper()
    year   = request.args.get("year") or None   # None = 전체 기간

    if league not in ("K1", "K2"):
        return jsonify({"error": "league must be K1 or K2"}), 400
    tid = 410 if league == "K1" else 777

    cache_key = (league, year or "ALL")
    now = int(time.time())
    cached = _league_rankings_cache.get(cache_key)
    if cached and cached[1] > now:
        return jsonify(cached[0])

    db_path = DB_PATH
    if not os.path.exists(db_path):
        return jsonify({"teams": [], "metrics": _lr_metrics_meta()})

    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    year_clause_mps = "AND strftime('%Y', datetime(e.date_ts,'unixepoch','localtime')) = ?" if year else ""
    year_clause_ev  = "AND strftime('%Y', datetime(date_ts,'unixepoch','localtime')) = ?"   if year else ""
    yp = [year] if year else []

    # 1) mps 기반 6지표 집계 (팀별)
    cur.execute(f"""
        SELECT mps.team_id,
               COUNT(DISTINCT mps.event_id) AS matches,
               SUM(mps.goals)           AS goals,
               SUM(mps.expected_goals)  AS xg_sum,
               SUM(mps.total_shots)     AS shots_total,
               SUM(mps.shots_on_target) AS shots_on,
               SUM(mps.big_chances_missed) AS big_miss,
               SUM(mps.duel_won)        AS duel_won,
               SUM(mps.duel_lost)       AS duel_lost,
               SUM(mps.tackles)         AS tackles
        FROM match_player_stats mps
        JOIN events e ON e.id = mps.event_id
        WHERE e.tournament_id = ?
          {year_clause_mps}
        GROUP BY mps.team_id
    """, (tid, *yp))
    mps_rows = {r[0]: r for r in cur.fetchall()}

    # 2) events 기반 득/실 (event 레벨이 신뢰도 더 높음)
    cur.execute(f"""
        SELECT tid, SUM(gf) AS gf, SUM(ga) AS ga, COUNT(*) AS games
        FROM (
            SELECT home_team_id AS tid, home_score AS gf, away_score AS ga
            FROM events
            WHERE tournament_id = ? AND home_score IS NOT NULL
              {year_clause_ev}
            UNION ALL
            SELECT away_team_id AS tid, away_score AS gf, home_score AS ga
            FROM events
            WHERE tournament_id = ? AND home_score IS NOT NULL
              {year_clause_ev}
        )
        GROUP BY tid
    """, (tid, *yp, tid, *yp))
    gfga_rows = {r[0]: (r[1] or 0, r[2] or 0, r[3] or 0) for r in cur.fetchall()}

    # 3) 최근 5경기 PPG (팀별)
    cur.execute(f"""
        WITH team_matches AS (
            SELECT home_team_id AS tid, home_score AS gf, away_score AS ga, date_ts
            FROM events
            WHERE tournament_id = ? AND home_score IS NOT NULL
              {year_clause_ev}
            UNION ALL
            SELECT away_team_id AS tid, away_score AS gf, home_score AS ga, date_ts
            FROM events
            WHERE tournament_id = ? AND home_score IS NOT NULL
              {year_clause_ev}
        ),
        ranked AS (
            SELECT tid, gf, ga,
                   ROW_NUMBER() OVER (PARTITION BY tid ORDER BY date_ts DESC) AS rn
            FROM team_matches
        )
        SELECT tid,
               SUM(CASE WHEN gf > ga THEN 3
                        WHEN gf = ga THEN 1
                        ELSE 0 END) AS pts,
               COUNT(*) AS games
        FROM ranked
        WHERE rn <= 5
        GROUP BY tid
    """, (tid, *yp, tid, *yp))
    form_rows = {r[0]: (r[1] or 0, r[2] or 0) for r in cur.fetchall()}

    # 4) 선제득점 시 팀 결과 (goal_events 기반, K1은 커버리지 0%)
    first_scorer_rows = {}    # tid → (wins, draws, games, avg_min)
    first_conceded_rows = {}  # tid → (wins, draws, games)
    ev_year_clause_e = "AND strftime('%Y', datetime(e.date_ts,'unixepoch','localtime')) = ?" if year else ""
    try:
        cur.execute(f"""
            WITH first_goals AS (
                SELECT event_id, team_id,
                       minute + IFNULL(added_time, 0) AS raw_min,
                       ROW_NUMBER() OVER (
                           PARTITION BY event_id
                           ORDER BY minute, IFNULL(added_time,0), id
                       ) AS rn
                FROM goal_events
                WHERE is_own_goal = 0
            ),
            joined AS (
                SELECT fg.team_id AS scorer_tid,
                       fg.raw_min,
                       e.home_team_id, e.away_team_id,
                       e.home_score, e.away_score
                FROM first_goals fg
                JOIN events e ON e.id = fg.event_id
                WHERE fg.rn = 1
                  AND e.tournament_id = ?
                  AND e.home_score IS NOT NULL
                  {ev_year_clause_e}
            )
            SELECT scorer_tid AS tid,
                   SUM(CASE WHEN (scorer_tid = home_team_id AND home_score > away_score)
                              OR (scorer_tid = away_team_id AND away_score > home_score)
                            THEN 1 ELSE 0 END) AS wins,
                   SUM(CASE WHEN home_score = away_score THEN 1 ELSE 0 END) AS draws,
                   COUNT(*) AS games,
                   AVG(raw_min) AS avg_min
            FROM joined
            GROUP BY scorer_tid
        """, (tid, *yp))
        for r in cur.fetchall():
            first_scorer_rows[r[0]] = (r[1] or 0, r[2] or 0, r[3] or 0, r[4])

        # 선제실점 (상대가 먼저 득점) → 우리 팀 결과
        cur.execute(f"""
            WITH first_goals AS (
                SELECT event_id, team_id,
                       ROW_NUMBER() OVER (
                           PARTITION BY event_id
                           ORDER BY minute, IFNULL(added_time,0), id
                       ) AS rn
                FROM goal_events
                WHERE is_own_goal = 0
            ),
            joined AS (
                SELECT fg.team_id AS scorer_tid,
                       e.home_team_id, e.away_team_id,
                       e.home_score, e.away_score
                FROM first_goals fg
                JOIN events e ON e.id = fg.event_id
                WHERE fg.rn = 1
                  AND e.tournament_id = ?
                  AND e.home_score IS NOT NULL
                  {ev_year_clause_e}
            )
            SELECT
                CASE WHEN scorer_tid = home_team_id THEN away_team_id ELSE home_team_id END AS conceded_tid,
                SUM(CASE WHEN (home_team_id != scorer_tid AND home_score > away_score)
                           OR (away_team_id != scorer_tid AND away_score > home_score)
                         THEN 1 ELSE 0 END) AS wins,
                SUM(CASE WHEN home_score = away_score THEN 1 ELSE 0 END) AS draws,
                COUNT(*) AS games
            FROM joined
            GROUP BY conceded_tid
        """, (tid, *yp))
        for r in cur.fetchall():
            first_conceded_rows[r[0]] = (r[1] or 0, r[2] or 0, r[3] or 0)
    except sqlite3.OperationalError:
        pass  # goal_events 없거나 window 함수 미지원 환경 fallback

    conn.close()

    # 3) 팀별 지표 값 계산
    teams_raw = []
    for team_info in TEAMS:
        if team_info.get("league") != league:
            continue
        ss_id = team_info["sofascore_id"]
        m = mps_rows.get(ss_id)
        gf_sum, ga_sum, ev_games = gfga_rows.get(ss_id, (0, 0, 0))
        form_pts, form_games = form_rows.get(ss_id, (0, 0))
        fs = first_scorer_rows.get(ss_id)        # (wins, draws, games, avg_min)
        fc = first_conceded_rows.get(ss_id)      # (wins, draws, games)

        matches = m[1] if m else 0
        # "전반적 경기 샘플" = events 기반 경기수 우선 (mps보다 신뢰도 높음)
        total_games = ev_games or matches

        if total_games == 0:
            continue  # 완전 데이터 없음 → 제외

        def _safe_div(n, d):
            return (float(n) / float(d)) if (n is not None and d) else None

        # 선제득점 승률 = 승+무 점수로 하면 무승부를 반영하기 어려움 → 순수 승률
        # (draws는 정보 손실이지만 "선제득점 시 이겼는가?"가 핵심 질문)
        fs_games = fs[2] if fs else 0
        fc_games = fc[2] if fc else 0

        values = {
            "xg_conversion":     _safe_div(m[2] if m else 0, m[3] if m else 0),
            "xg_per_game":       _safe_div(m[3] if m else 0, matches),
            "shot_accuracy":     _safe_div((m[5] if m else 0) * 100, m[4] if m else 0),
            "big_miss_per_game": _safe_div(m[6] if m else 0, matches),
            "duel_won_pct":      _safe_div((m[7] if m else 0) * 100, (m[7] if m else 0) + (m[8] if m else 0)),
            "tackles_per_game":  _safe_div(m[9] if m else 0, matches),
            "gf_per_game":       _safe_div(gf_sum, ev_games) if ev_games else None,
            "ga_per_game":       _safe_div(ga_sum, ev_games) if ev_games else None,
            "form_ppg_last5":    _safe_div(form_pts, form_games) if form_games else None,
            "first_goal_win_pct":     _safe_div((fs[0] if fs else 0) * 100, fs_games) if fs_games >= 3 else None,
            "first_conceded_win_pct": _safe_div((fc[0] if fc else 0) * 100, fc_games) if fc_games >= 3 else None,
        }
        # 참고용 추가 필드 (랭킹 대상 아님)
        extras = {
            "first_goal_avg_min": round(fs[3], 1) if (fs and fs[3] is not None) else None,
            "first_goal_games":     fs_games,
            "first_conceded_games": fc_games,
        }

        teams_raw.append({
            "id":      team_info["id"],
            "name":    team_info["name"],
            "short":   team_info.get("short"),
            "emblem":  team_info.get("emblem"),
            "primary": team_info.get("primary"),
            "matches":       total_games,
            "mps_matches":   matches,     # mps 경기수 (xG/태클 등 유효 샘플)
            "eligible":      total_games >= _MIN_SAMPLE_MATCHES,
            "values":  values,
            "extras":  extras,
        })

    # 4) 각 지표별 순위 계산 (eligible 팀만)
    ranks = {k: {} for (k, *_rest) in _LR_METRICS}
    for key, _label, direction, _fmt in _LR_METRICS:
        eligible = [t for t in teams_raw if t["eligible"] and t["values"].get(key) is not None]
        reverse = (direction == "higher")
        eligible.sort(key=lambda t: t["values"][key], reverse=reverse)
        for idx, t in enumerate(eligible, start=1):
            ranks[key][t["id"]] = idx
        # eligible 개수
        ranks[key]["_total"] = len(eligible)

    # 5) 최종 응답 구조
    result_teams = []
    for t in teams_raw:
        team_ranks = {}
        for key, *_r in _LR_METRICS:
            team_ranks[key] = ranks[key].get(t["id"])  # None if not eligible
        result_teams.append({
            "id":      t["id"],
            "name":    t["name"],
            "short":   t["short"],
            "emblem":  t["emblem"],
            "primary": t["primary"],
            "matches":     t["matches"],
            "mps_matches": t.get("mps_matches", 0),
            "eligible": t["eligible"],
            "values":  {k: (round(v, 2) if isinstance(v, float) else v)
                        for k, v in t["values"].items()},
            "ranks":   team_ranks,
            "extras":  t.get("extras", {}),
        })

    totals = {k: ranks[k]["_total"] for k, *_r in _LR_METRICS}
    payload = {
        "league":  league,
        "year":    year or "전체",
        "teams":   result_teams,
        "metrics": _lr_metrics_meta(),
        "totals":  totals,              # key → eligible team count
        "min_sample": _MIN_SAMPLE_MATCHES,
    }

    _league_rankings_cache[cache_key] = (payload, now + _LEAGUE_RANKINGS_TTL)
    return jsonify(payload)


def _lr_metrics_meta():
    return [{"key": k, "label": lbl, "direction": d, "format": f}
            for (k, lbl, d, f) in _LR_METRICS]


# ═══════════════════════════════════════════════════════════════
# /api/team-trend — 팀의 경기별 득/실/결과 시계열 (라인차트용)
# ═══════════════════════════════════════════════════════════════

@app.route("/api/team-trend")
@cached_response(ttl=3600)
def get_team_trend():
    """팀의 경기별 날짜 · 득점 · 실점 · 결과 · 누적승점 시계열."""
    team_id = request.args.get("teamId")
    year    = request.args.get("year") or None

    team_info = next((t for t in TEAMS if t["id"] == team_id), None)
    if not team_info:
        return jsonify({"error": "teamId required"}), 400

    ss_id = team_info["sofascore_id"]
    tid   = 410 if team_info.get("league") == "K1" else 777

    db_path = DB_PATH
    if not os.path.exists(db_path):
        return jsonify({"team_id": team_id, "matches": []})

    year_clause = "AND strftime('%Y', datetime(date_ts,'unixepoch','localtime')) = ?" if year else ""
    yp = [year] if year else []

    conn = sqlite3.connect(db_path)
    cur = conn.cursor()
    cur.execute(f"""
        SELECT id, date_ts, home_team_id, away_team_id,
               home_team_name, away_team_name,
               home_score, away_score
        FROM events
        WHERE tournament_id = ?
          AND home_score IS NOT NULL
          AND (home_team_id = ? OR away_team_id = ?)
          {year_clause}
        ORDER BY date_ts ASC
    """, (tid, ss_id, ss_id, *yp))
    rows = cur.fetchall()
    conn.close()

    from datetime import datetime as _dt, timezone as _tz
    matches = []
    cum_pts = 0
    for eid, ts, h_id, a_id, h_name, a_name, hs, as_ in rows:
        is_home = (h_id == ss_id)
        gf = hs if is_home else as_
        ga = as_ if is_home else hs
        if gf > ga:
            result = "W"; pts = 3
        elif gf == ga:
            result = "D"; pts = 1
        else:
            result = "L"; pts = 0
        cum_pts += pts
        matches.append({
            "event_id":  eid,
            "date":      _dt.fromtimestamp(ts, tz=_tz.utc).strftime("%Y-%m-%d"),
            "opponent":  a_name if is_home else h_name,
            "is_home":   is_home,
            "gf":        gf,
            "ga":        ga,
            "result":    result,
            "pts":       pts,
            "cum_pts":   cum_pts,
        })

    return jsonify({
        "team":    team_info["name"],
        "team_id": team_id,
        "short":   team_info.get("short"),
        "primary": team_info.get("primary"),
        "year":    year or "전체",
        "matches": matches,
    })


_POISSON_MAX_GOALS = 5  # 스코어 매트릭스 최대 (0~5골)

# 리그별 포아송 모델 상수 (2026 실측 기반 재튜닝 — 2026-05-12, 표본 2배 누적)
# 실측 (79경기 K1 / 83경기 K2):
#   K1: pred home 43%/draw 39%/away 18% → actual 33%/32%/35%. away 과소예측·draw 과대.
#       → home_adv 1.04→0.98, away_adj 0.93→1.02, draw_boost 0.12→0.04
#   K2: pred home 42%/draw 12%/away 46% → actual 36%/31%/33%. draw 심각 과소예측.
#       → draw_boost 0.06→0.18, dc_rho 0.00→0.10 (Dixon-Coles 무승부 보정 가산)
# draw_boost 수식: new_draw% = (raw_draw + boost) / (1 + boost)
_LEAGUE_CONSTANTS = {
    410: {"home_adv": 0.98, "away_adj": 1.02, "draw_boost": 0.19, "dc_rho": 0.10, "shrinkage_k": 3},  # K1: 2026-05-27 draw_boost 0.04→0.19 (calibration 정상화). 이전 0.04는 무승부를 한 번도 argmax로 안 잡음(예측 0 vs 실제 27/90=30%). 오프라인 스윕(analysis/predict_param_sweep.py)으로 base rate 매칭값 채택 — 예측 무승부 0→29(≈실제27), 1X2 50.0→51.1%, brier flat. in-sample 최대 hit(52.2%)은 노이즈로 판단해 안 좇음. home_adv/away_adj는 2026-05-12 미세보정 backfire(-1.3%p) 후 유지.

    777: {"home_adv": 0.96, "away_adj": 0.90, "draw_boost": 0.18, "dc_rho": 0.10, "shrinkage_k": 0, "use_sos": True},  # K2: draw boost ↑↑ + Dixon-Coles ρ. 2026-05-27 use_sos 활성화 — 오프라인 검증상 전반기 +6%p·후반 무해·brier flat (전·후반 분할 검증). K1은 use_sos 미설정(SOS가 hit 악화).
}
_DEFAULT_LEAGUE_CONSTANTS = {"home_adv": 1.00, "away_adj": 0.90, "draw_boost": 0.10, "dc_rho": 0.0, "shrinkage_k": 0}

# 시간 감쇠 계수: 경기 순위가 1 올라갈 때마다 가중치를 λ배로 감쇠
# 0.88 → 최근 경기 대비 10경기 전은 약 27% 비중, 20경기 전(전 시즌)은 약 7% 비중
_DECAY_LAMBDA = 0.88

# 레거시 상수 (기존 코드 호환용, 내부에서는 _LEAGUE_CONSTANTS 사용)
_HOME_ADVANTAGE    = 1.15
_AWAY_ADJUSTMENT   = 0.90

# ── 인메모리 TTL 캐시 (예측 관련 반복 쿼리 최적화) ──────────────
_PRED_CACHE: dict = {}
_PRED_CACHE_TTL = 600  # 10분

def _pcache_get(key):
    entry = _PRED_CACHE.get(key)
    if entry and time.time() - entry[0] < _PRED_CACHE_TTL:
        return entry[1]
    return None

def _pcache_set(key, val):
    _PRED_CACHE[key] = (time.time(), val)


def _league_coefs(tid_filter):
    return _LEAGUE_CONSTANTS.get(tid_filter, _DEFAULT_LEAGUE_CONSTANTS)


def _poisson_pmf(k, lam):
    """Poisson P(X=k) — math.exp/factorial 만 사용, scipy 불필요"""
    import math
    if lam <= 0:
        return 1.0 if k == 0 else 0.0
    return (lam ** k) * math.exp(-lam) / math.factorial(k)


def _score_matrix(lam_h, lam_a, max_goals=_POISSON_MAX_GOALS, dc_rho=0.0):
    """
    홈/원정 람다로 스코어 매트릭스 반환.
    m[i][j] = P(홈 i골 × 원정 j골).
    마지막 행/열은 max_goals 이상 누적 포함.

    dc_rho: Dixon-Coles 보정 파라미터.
      rho > 0: 0-0/0-1/1-0/1-1 영역에서 1-1·0-0 확률 ↓, 1-0·0-1 확률 ↑ → 무승부 과다 예측 완화
      rho < 0: 반대 (무승부 과소 보정)
      rho = 0: 표준 포아송 (보정 없음)
    """
    ph = [_poisson_pmf(k, lam_h) for k in range(max_goals + 1)]
    pa = [_poisson_pmf(k, lam_a) for k in range(max_goals + 1)]
    # 꼬리 확률(max_goals+ 이상)을 마지막 칸에 합산
    ph[-1] += max(0.0, 1.0 - sum(ph))
    pa[-1] += max(0.0, 1.0 - sum(pa))
    matrix = [[ph[i] * pa[j] for j in range(max_goals + 1)] for i in range(max_goals + 1)]

    if dc_rho != 0.0:
        # Dixon-Coles tau: 저득점 4칸만 곱셈 보정 후 재정규화
        tau00 = max(0.0, 1.0 - lam_h * lam_a * dc_rho)
        tau01 = max(0.0, 1.0 + lam_h * dc_rho)
        tau10 = max(0.0, 1.0 + lam_a * dc_rho)
        tau11 = max(0.0, 1.0 - dc_rho)
        matrix[0][0] *= tau00
        matrix[0][1] *= tau01
        matrix[1][0] *= tau10
        matrix[1][1] *= tau11
        s = sum(sum(row) for row in matrix)
        if s > 0:
            matrix = [[v / s for v in row] for row in matrix]
    return matrix


def _matrix_outcomes(matrix, draw_boost=0.0):
    """
    스코어 매트릭스 → 홈승/무/원정승 확률 및 상위 5스코어.
    draw_boost: 0~1 스케일 오프셋. draw 확률에 더한 후 재정규화.
        K1처럼 무승부 비율 높은 리그에서 argmax outcome 결정 시 draw 선택 개선.
    """
    home_p = draw_p = away_p = 0.0
    scores = []
    n = len(matrix)
    for i in range(n):
        for j in range(n):
            p = matrix[i][j]
            scores.append({"home": i, "away": j, "prob": p})
            if i > j:
                home_p += p
            elif i == j:
                draw_p += p
            else:
                away_p += p
    draw_p += max(0.0, draw_boost)
    total = home_p + draw_p + away_p or 1
    scores.sort(key=lambda s: s["prob"], reverse=True)
    # 결과별(홈승/무/원정승) 최빈 스코어 — 예측 결과와 스코어 일치용
    # (전체 최빈 스코어는 대개 1-0이라 '무 예측인데 스코어는 1-0' 모순이 생김)
    by_outcome = {"home": None, "draw": None, "away": None}
    for s in scores:  # prob 내림차순
        key = "home" if s["home"] > s["away"] else "draw" if s["home"] == s["away"] else "away"
        if by_outcome[key] is None:
            by_outcome[key] = {"home": s["home"], "away": s["away"], "pct": round(s["prob"] * 100, 1)}
        if all(by_outcome.values()):
            break
    return {
        "home": round(home_p / total * 100),
        "draw": round(draw_p / total * 100),
        "away": round(away_p / total * 100),
        "top_scores": [
            {"home": s["home"], "away": s["away"], "pct": round(s["prob"] * 100, 1)}
            for s in scores[:5]
        ],
        "top_score_by_outcome": by_outcome,
    }


def _all_team_def(cur, tid_filter, year_str, as_of_ts):
    """
    리그 내 모든 팀의 평균 xg_against (경기당 실점 xG) 사전 계산.
    상대 강도(SOS) 보정용. xG 없으면 실제 실점으로 fallback.
    반환: {team_id: avg_xg_against}
    """
    _key = f"team_def:{tid_filter}:{year_str}:{as_of_ts}"
    cached = _pcache_get(_key)
    if cached is not None:
        return cached
    # 코릴레이티드 서브쿼리 → LEFT JOIN 집계로 교체 (경기 수만큼 서브쿼리 반복 제거)
    cur.execute("""
        WITH mps_agg AS (
            SELECT event_id, team_id, SUM(expected_goals) AS xg_sum
            FROM match_player_stats
            GROUP BY event_id, team_id
        )
        SELECT team_id, AVG(xg_a)
        FROM (
            SELECT e.home_team_id AS team_id,
                   COALESCE(m_away.xg_sum, e.away_score) AS xg_a
            FROM events e
            LEFT JOIN mps_agg m_away ON m_away.event_id=e.id AND m_away.team_id=e.away_team_id
            WHERE e.tournament_id=? AND e.home_score IS NOT NULL
              AND strftime('%Y', datetime(e.date_ts,'unixepoch','localtime'))=?
              AND e.date_ts < ?
            UNION ALL
            SELECT e.away_team_id AS team_id,
                   COALESCE(m_home.xg_sum, e.home_score) AS xg_a
            FROM events e
            LEFT JOIN mps_agg m_home ON m_home.event_id=e.id AND m_home.team_id=e.home_team_id
            WHERE e.tournament_id=? AND e.home_score IS NOT NULL
              AND strftime('%Y', datetime(e.date_ts,'unixepoch','localtime'))=?
              AND e.date_ts < ?
        )
        GROUP BY team_id
    """, (tid_filter, year_str, as_of_ts, tid_filter, year_str, as_of_ts))
    result = {row[0]: float(row[1]) for row in cur.fetchall() if row[1] is not None}
    _pcache_set(_key, result)
    return result


def _team_sos(cur, ss_id, tid_filter, year_str, as_of_ts, team_def_dict, league_def_avg):
    """
    팀이 만난 상대들의 평균 수비력 / 리그 평균 수비력.
    > 1.0: 약한 수비 상대들 만남 (xg_for 부풀림 의심) → 우리 atk를 디스카운트
    < 1.0: 강한 수비 상대들 만남 (xg_for 저평가) → 우리 atk를 부스트
    """
    cur.execute("""
        SELECT CASE WHEN e.home_team_id=? THEN e.away_team_id ELSE e.home_team_id END AS opp_id
        FROM events e
        WHERE e.tournament_id=?
          AND (e.home_team_id=? OR e.away_team_id=?)
          AND e.home_score IS NOT NULL
          AND strftime('%Y', datetime(e.date_ts,'unixepoch','localtime'))=?
          AND e.date_ts < ?
    """, (ss_id, tid_filter, ss_id, ss_id, year_str, as_of_ts))
    opp_defs = []
    for (opp_id,) in cur.fetchall():
        d = team_def_dict.get(opp_id)
        if d is not None:
            opp_defs.append(d)
    if not opp_defs or league_def_avg <= 0:
        return 1.0
    return (sum(opp_defs) / len(opp_defs)) / league_def_avg


def _team_rest_days(cur, tid_filter, ss_id, as_of_ts):
    """팀의 직전 완료 경기로부터의 휴식일. 없으면 None."""
    cur.execute("""
        SELECT date_ts FROM events
        WHERE tournament_id=?
          AND (home_team_id=? OR away_team_id=?)
          AND home_score IS NOT NULL AND date_ts < ?
        ORDER BY date_ts DESC LIMIT 1
    """, (tid_filter, ss_id, ss_id, as_of_ts))
    r = cur.fetchone()
    if not r:
        return None
    return int((as_of_ts - r[0]) / 86400)


def _rest_factor(rest_days):
    """
    휴식일 기반 λ 보정 계수.
    백테스트 분석(K2)에서 rest≤3일 → 홈승률 27.5% (4-7일 36.1% 대비 -8.6pt).
    → 짧은 rest 팀의 공격력을 9% 디스카운트.
    K1은 signal 약하지만 동일 적용 (효과 없으면 무해).
    """
    if rest_days is None:
        return 1.0
    if rest_days <= 3:
        return 0.91  # 피로
    return 1.0


def _predict_core(cur, home_ss, away_ss, tid_filter, as_of_ts, year_str,
                  apply_sos=False, apply_rest=True,
                  home_rest_days=None, away_rest_days=None,
                  decay=None):
    """
    포아송 기반 핵심 예측 (백테스트/실시간 공통).
    - as_of_ts 직전까지의 데이터만 사용 (look-ahead bias 차단)
    - 부상자 보정은 호출자가 책임 (백테스트는 부상 데이터가 시점성 없으므로 제외)
    - apply_sos: True면 상대 강도(SOS) 보정 적용
    - decay: 시간 감쇠 계수. None이면 _DECAY_LAMBDA(0.88) 사용. K1은 2024+2025+2026, K2는 2025+2026.
    반환: {lam_home, lam_away, pred_home/draw/away, top_scores, h_games, a_games, league_avg, matrix, sos_home, sos_away}
    None 반환: 양 팀 중 한 쪽 사전 경기 0 (cold start)
    """
    if decay is None:
        decay = _DECAY_LAMBDA
    coefs = _league_coefs(tid_filter)
    shrinkage_k = coefs.get("shrinkage_k", 0)
    # as_of_ts 포함 필수: 키에 없으면 rolling backtest가 첫 매치의 league_avg를 전 매치에 재사용하고,
    # 실시간 호출(as_of=now, 전 시즌 데이터)이 캐시를 오염시켜 과거 매치 예측에 look-ahead 유입.
    # (_all_team_def는 이미 as_of_ts 포함 — 동일 패턴으로 통일)
    _lavg_key = f"league_avg:{tid_filter}:{year_str}:{as_of_ts}"
    league_avg = _pcache_get(_lavg_key)
    if league_avg is None:
        cur.execute("""
            SELECT AVG(home_score + away_score) / 2.0
            FROM events
            WHERE tournament_id=? AND home_score IS NOT NULL AND away_score IS NOT NULL
              AND strftime('%Y', datetime(date_ts,'unixepoch','localtime'))=?
              AND date_ts < ?
        """, (tid_filter, year_str, as_of_ts))
        _r = cur.fetchone()
        league_avg = float(_r[0]) if _r and _r[0] else 1.3
        _pcache_set(_lavg_key, league_avg)

    def _team_xg(ss_id):
        # 학습 기간: K1은 2024 포함(데이터 부족 보강), K2는 2025+2026
        # P2(2026-04-29) 정합성 작업으로 2024 events 메타 복구되어 K1 백필 활용 가능
        years = "('2024','2025','2026')" if tid_filter == 410 else "('2025','2026')"
        # 서브쿼리 2개 → 단일 조건부 집계 JOIN으로 교체
        cur.execute(f"""
            SELECT e.id, e.home_team_id=? AS is_home, e.home_score, e.away_score,
                   mps_agg.xg_for, mps_agg.xg_against
            FROM events e
            LEFT JOIN (
                SELECT event_id,
                       SUM(CASE WHEN team_id=? AND expected_goals IS NOT NULL
                                THEN expected_goals END) AS xg_for,
                       SUM(CASE WHEN team_id IS NOT NULL AND team_id != ?
                                     AND expected_goals IS NOT NULL
                                THEN expected_goals END) AS xg_against
                FROM match_player_stats
                GROUP BY event_id
            ) mps_agg ON mps_agg.event_id=e.id
            WHERE e.tournament_id=?
              AND (e.home_team_id=? OR e.away_team_id=?)
              AND e.home_score IS NOT NULL AND e.away_score IS NOT NULL
              AND e.date_ts < ?
              AND strftime('%Y', datetime(e.date_ts,'unixepoch','localtime')) IN {years}
            ORDER BY e.date_ts DESC
        """, (ss_id, ss_id, ss_id, tid_filter, ss_id, ss_id, as_of_ts))
        rows = cur.fetchall()
        if not rows:
            return None
        wf = wa = wt = 0.0
        for rank, (_id, is_home, hs, as_, xg_f, xg_a) in enumerate(rows):
            w = decay ** rank
            gf = hs if is_home else as_
            ga = as_ if is_home else hs
            wf += w * (float(xg_f) if xg_f is not None else float(gf or 0))
            wa += w * (float(xg_a) if xg_a is not None else float(ga or 0))
            wt += w
        # Empirical Bayes shrinkage: 표본 부족 팀의 추정치를 리그 평균(prior)으로 끌어당김
        # shrinkage_k=가상 prior 경기 수. 표본 wt가 클수록 prior 영향 ↓
        if shrinkage_k > 0:
            return {
                "games":       len(rows),
                "xg_for":     (wf + shrinkage_k * league_avg) / (wt + shrinkage_k),
                "xg_against": (wa + shrinkage_k * league_avg) / (wt + shrinkage_k),
            }
        return {"games": len(rows), "xg_for": wf / wt, "xg_against": wa / wt}

    h = _team_xg(home_ss)
    a = _team_xg(away_ss)
    if not h or not a:
        return None

    h_atk = (h["xg_for"]     / league_avg) if league_avg else 1.0
    h_def = (h["xg_against"] / league_avg) if league_avg else 1.0
    a_atk = (a["xg_for"]     / league_avg) if league_avg else 1.0
    a_def = (a["xg_against"] / league_avg) if league_avg else 1.0

    # ── 상대 강도(SOS) 보정 ──
    # 양 팀 모두 6경기 이상 + 클램핑(0.88~1.12)으로 노이즈 억제
    # 리그별 use_sos 코프로도 켤 수 있음 (K2: 2026-05-27 검증 — 전반기 +6%p, 후반기 무해, brier flat.
    #   K1은 off 유지 — 균형 리그라 SOS 과보정으로 hit -1.1%p 악화).
    apply_sos = apply_sos or coefs.get("use_sos", False)
    sos_home = sos_away = 1.0
    if apply_sos and h["games"] >= 6 and a["games"] >= 6:
        team_def = _all_team_def(cur, tid_filter, year_str, as_of_ts)
        if team_def:
            league_def_avg = sum(team_def.values()) / len(team_def)
            sos_home = _team_sos(cur, home_ss, tid_filter, year_str, as_of_ts, team_def, league_def_avg)
            sos_away = _team_sos(cur, away_ss, tid_filter, year_str, as_of_ts, team_def, league_def_avg)
            sos_home = max(0.88, min(1.12, sos_home))
            sos_away = max(0.88, min(1.12, sos_away))
            h_atk = h_atk / sos_home
            a_atk = a_atk / sos_away

    lam_h = max(0.1, h_atk * a_def * league_avg * coefs["home_adv"])
    lam_a = max(0.1, a_atk * h_def * league_avg * coefs["away_adj"])

    # 휴식일 보정 (≤3일 연전 시 피로 패널티)
    rest_factor_home = rest_factor_away = 1.0
    if apply_rest:
        rh = home_rest_days if home_rest_days is not None else _team_rest_days(cur, tid_filter, home_ss, as_of_ts)
        ra = away_rest_days if away_rest_days is not None else _team_rest_days(cur, tid_filter, away_ss, as_of_ts)
        rest_factor_home = _rest_factor(rh)
        rest_factor_away = _rest_factor(ra)
        lam_h *= rest_factor_home
        lam_a *= rest_factor_away

    matrix   = _score_matrix(lam_h, lam_a, dc_rho=coefs.get("dc_rho", 0.0))
    outcomes = _matrix_outcomes(matrix, draw_boost=coefs.get("draw_boost", 0.0))
    return {
        "lam_home":   lam_h,
        "lam_away":   lam_a,
        "pred_home":  outcomes["home"],
        "pred_draw":  outcomes["draw"],
        "pred_away":  outcomes["away"],
        "top_scores": outcomes["top_scores"],
        "top_score_by_outcome": outcomes["top_score_by_outcome"],
        "h_games":    h["games"],
        "a_games":    a["games"],
        "league_avg": league_avg,
        "matrix":     matrix,
        "sos_home":   round(sos_home, 3),
        "sos_away":   round(sos_away, 3),
        "rest_home":  round(rest_factor_home, 3),
        "rest_away":  round(rest_factor_away, 3),
    }


@app.route("/api/match-prediction")
@cached_response(ttl=1800)
def get_match_prediction():
    """두 팀 간 예측 보고서: 포아송 승률·스코어 매트릭스·신뢰도·부상자 반영"""
    home_id = request.args.get("homeTeam")
    away_id = request.args.get("awayTeam")
    home_info = next((t for t in TEAMS if t["id"] == home_id), None)
    away_info = next((t for t in TEAMS if t["id"] == away_id), None)
    if not home_info or not away_info:
        return jsonify({}), 404

    hid = home_info["sofascore_id"]
    aid = away_info["sofascore_id"]
    # 리그 구분: K1(410) or K2(777)
    league = home_info.get("league", "K2")
    tid_filter = 410 if league == "K1" else 777

    db_path = DB_PATH
    conn = sqlite3.connect(db_path)
    cur  = conn.cursor()

    import math, datetime
    now_month = datetime.datetime.now().month
    now_year  = str(datetime.datetime.now().year)

    def compute_standings(year):
        """현재 순위표 계산 (해당 리그 기준)"""
        cur.execute("""
            SELECT home_team_id, away_team_id, home_score, away_score
            FROM events
            WHERE tournament_id=? AND home_score IS NOT NULL AND away_score IS NOT NULL
              AND strftime('%Y', datetime(date_ts,'unixepoch','localtime'))=?
        """, (tid_filter, year,))
        standing = {}
        for home_id, away_id, hs, as_ in cur.fetchall():
            for tid, gf, ga, is_home in [(home_id, hs, as_, True), (away_id, as_, hs, False)]:
                if tid not in standing:
                    standing[tid] = {"played": 0, "w": 0, "d": 0, "l": 0, "gf": 0, "ga": 0, "pts": 0}
                s = standing[tid]
                s["played"] += 1
                s["gf"] += gf; s["ga"] += ga
                if gf > ga:
                    s["w"] += 1; s["pts"] += 3
                elif gf == ga:
                    s["d"] += 1; s["pts"] += 1
                else:
                    s["l"] += 1
        # 정렬: pts → gd → gf
        ranked = sorted(standing.items(),
                        key=lambda x: (x[1]["pts"], x[1]["gf"] - x[1]["ga"], x[1]["gf"]),
                        reverse=True)
        result = {}
        for rank, (tid, s) in enumerate(ranked, 1):
            result[tid] = {**s, "rank": rank, "gd": s["gf"] - s["ga"]}
        return result

    standings = compute_standings(now_year)

    def team_stats(ss_id, side_home):
        """팀 전반 지표 계산"""
        cur.execute("""
            SELECT COUNT(*) g,
                   SUM(CASE WHEN home_score>away_score THEN 1 ELSE 0 END) w,
                   SUM(CASE WHEN home_score=away_score THEN 1 ELSE 0 END) d,
                   SUM(home_score) gf, SUM(away_score) ga
            FROM events WHERE tournament_id=? AND home_team_id=?
              AND strftime('%Y', datetime(date_ts,'unixepoch','localtime'))=?
        """, (tid_filter, ss_id, now_year))
        hrow = cur.fetchone()
        cur.execute("""
            SELECT COUNT(*) g,
                   SUM(CASE WHEN away_score>home_score THEN 1 ELSE 0 END) w,
                   SUM(CASE WHEN home_score=away_score THEN 1 ELSE 0 END) d,
                   SUM(away_score) gf, SUM(home_score) ga
            FROM events WHERE tournament_id=? AND away_team_id=?
              AND strftime('%Y', datetime(date_ts,'unixepoch','localtime'))=?
        """, (tid_filter, ss_id, now_year))
        arow = cur.fetchone()
        hg,hw,hd,hgf,hga = hrow
        ag,aw,ad,agf,aga = arow
        hg  = hg  or 0; hw  = hw  or 0; hd  = hd  or 0; hgf = hgf or 0; hga = hga or 0
        ag  = ag  or 0; aw  = aw  or 0; ad  = ad  or 0; agf = agf or 0; aga = aga or 0
        total_g = hg + ag
        total_w = hw + aw
        home_wr = hw / (hg or 1) * 100
        away_wr = aw / (ag or 1) * 100

        # 최근 5경기 폼 — score NULL(미래 매치/취소 매치) 제외
        cur.execute("""
            SELECT home_score, away_score, home_team_id FROM events
            WHERE tournament_id=? AND (home_team_id=? OR away_team_id=?)
              AND home_score IS NOT NULL AND away_score IS NOT NULL
            ORDER BY date_ts DESC LIMIT 5
        """, (tid_filter, ss_id, ss_id))
        recent = cur.fetchall()
        form = []
        for hs, as_, ht in recent:
            is_home = ht == ss_id
            gf = hs if is_home else as_
            ga = as_ if is_home else hs
            form.append("W" if gf>ga else "D" if gf==ga else "L")

        # 월별 승률 — 현재 달 기준 과거 데이터 (미래 매치 제외)
        cur.execute("""
            SELECT SUM(g), SUM(w) FROM (
                SELECT COUNT(*) g, SUM(CASE WHEN home_score>away_score THEN 1 ELSE 0 END) w
                FROM events WHERE tournament_id=? AND home_team_id=?
                  AND home_score IS NOT NULL AND away_score IS NOT NULL
                  AND CAST(strftime('%m', datetime(date_ts,'unixepoch','localtime')) AS INT)=?
                UNION ALL
                SELECT COUNT(*) g, SUM(CASE WHEN away_score>home_score THEN 1 ELSE 0 END) w
                FROM events WHERE tournament_id=? AND away_team_id=?
                  AND home_score IS NOT NULL AND away_score IS NOT NULL
                  AND CAST(strftime('%m', datetime(date_ts,'unixepoch','localtime')) AS INT)=?
            )
        """, (tid_filter, ss_id, now_month, tid_filter, ss_id, now_month))
        mr = cur.fetchone()
        month_wr = (mr[1] or 0)/(mr[0] or 1)*100 if (mr and mr[0]) else None

        # 홈/원정 격차
        ha_gap = home_wr - away_wr

        # 득점 top3 (현재 시즌)
        cur.execute("""
            SELECT MAX(strftime('%Y', datetime(date_ts,'unixepoch','localtime')))
            FROM events WHERE tournament_id=?
        """, (tid_filter,))
        _row = cur.fetchone()
        latest_yr = _row[0] if _row and _row[0] else str(datetime.now().year)
        cur.execute("""
            SELECT mps.player_id, COALESCE(p.name_ko, mps.player_name, p.name), SUM(mps.goals) g
            FROM match_player_stats mps
            JOIN events e ON mps.event_id=e.id
            LEFT JOIN players p ON mps.player_id=p.id
            WHERE mps.team_id=? AND e.tournament_id=?
              AND strftime('%Y', datetime(e.date_ts,'unixepoch','localtime'))=?
              AND mps.goals>0
            GROUP BY mps.player_id ORDER BY g DESC LIMIT 3
        """, (ss_id, tid_filter, latest_yr))
        top_scorers = [{"id": r[0], "name": r[1], "goals": r[2]} for r in cur.fetchall()]

        avg_gf = ((hgf or 0)+(agf or 0)) / (total_g or 1)
        avg_ga = ((hga or 0)+(aga or 0)) / (total_g or 1)

        # ── 클린시트 / 무득점 경기 비율
        cur.execute("""
            SELECT
                SUM(CASE WHEN is_home=1 AND away_g=0 THEN 1
                         WHEN is_home=0 AND home_g=0 THEN 1 ELSE 0 END) cs,
                SUM(CASE WHEN is_home=1 AND home_g=0 THEN 1
                         WHEN is_home=0 AND away_g=0 THEN 1 ELSE 0 END) blank,
                COUNT(*) total
            FROM (
                SELECT home_score home_g, away_score away_g, 1 is_home
                FROM events WHERE tournament_id=? AND home_team_id=?
                  AND home_score IS NOT NULL AND away_score IS NOT NULL
                  AND strftime('%Y', datetime(date_ts,'unixepoch','localtime'))=?
                UNION ALL
                SELECT home_score home_g, away_score away_g, 0 is_home
                FROM events WHERE tournament_id=? AND away_team_id=?
                  AND home_score IS NOT NULL AND away_score IS NOT NULL
                  AND strftime('%Y', datetime(date_ts,'unixepoch','localtime'))=?
            )
        """, (tid_filter, ss_id, now_year, tid_filter, ss_id, now_year))
        cs_row = cur.fetchone()
        cs_count  = (cs_row[0] or 0) if cs_row else 0
        blank_cnt = (cs_row[1] or 0) if cs_row else 0
        cs_total  = (cs_row[2] or 0) if cs_row else 0
        clean_sheet_rate = cs_count  / (cs_total or 1) * 100
        blank_rate       = blank_cnt / (cs_total or 1) * 100

        # ── 접전 경기 (1골차) 승/패
        cur.execute("""
            SELECT
                SUM(CASE WHEN gf-ga=1 THEN 1 ELSE 0 END) cw,
                SUM(CASE WHEN ga-gf=1 THEN 1 ELSE 0 END) cl,
                SUM(CASE WHEN ABS(gf-ga)=1 THEN 1 ELSE 0 END) ct
            FROM (
                SELECT home_score gf, away_score ga FROM events
                WHERE tournament_id=? AND home_team_id=?
                  AND home_score IS NOT NULL AND away_score IS NOT NULL
                  AND strftime('%Y', datetime(date_ts,'unixepoch','localtime'))=?
                UNION ALL
                SELECT away_score gf, home_score ga FROM events
                WHERE tournament_id=? AND away_team_id=?
                  AND home_score IS NOT NULL AND away_score IS NOT NULL
                  AND strftime('%Y', datetime(date_ts,'unixepoch','localtime'))=?
            )
        """, (tid_filter, ss_id, now_year, tid_filter, ss_id, now_year))
        cl_row = cur.fetchone()
        close_win   = (cl_row[0] or 0) if cl_row else 0
        close_loss  = (cl_row[1] or 0) if cl_row else 0
        close_total = (cl_row[2] or 0) if cl_row else 0
        close_wr = close_win / (close_total or 1) * 100

        # ── 대량 득점 (3골+) 빈도
        cur.execute("""
            SELECT SUM(CASE WHEN gf>=3 THEN 1 ELSE 0 END), COUNT(*) FROM (
                SELECT home_score gf FROM events
                WHERE tournament_id=? AND home_team_id=?
                  AND home_score IS NOT NULL
                  AND strftime('%Y', datetime(date_ts,'unixepoch','localtime'))=?
                UNION ALL
                SELECT away_score gf FROM events
                WHERE tournament_id=? AND away_team_id=?
                  AND away_score IS NOT NULL
                  AND strftime('%Y', datetime(date_ts,'unixepoch','localtime'))=?
            )
        """, (tid_filter, ss_id, now_year, tid_filter, ss_id, now_year))
        bs_row = cur.fetchone()
        big_score_rate = (bs_row[0] or 0) / (bs_row[1] or 1) * 100 if bs_row else 0

        # ── xG 효율 (match_player_stats)
        cur.execute("""
            SELECT SUM(mps.goals), SUM(mps.expected_goals)
            FROM match_player_stats mps JOIN events e ON mps.event_id=e.id
            WHERE mps.team_id=? AND e.tournament_id=?
              AND strftime('%Y', datetime(e.date_ts,'unixepoch','localtime'))=?
        """, (ss_id, tid_filter, latest_yr))
        xg_row = cur.fetchone()
        xg_actual = (xg_row[0] or 0) if xg_row else 0
        xg_sum_val = (xg_row[1] or 0) if xg_row else 0
        xg_efficiency = (xg_actual / xg_sum_val) if xg_sum_val >= 3 else None

        # ── 연속 기록 (최근 15경기 기준) — score NULL(미래 매치) 제외
        cur.execute("""
            SELECT home_score, away_score, home_team_id FROM events
            WHERE tournament_id=? AND (home_team_id=? OR away_team_id=?)
              AND home_score IS NOT NULL AND away_score IS NOT NULL
            ORDER BY date_ts DESC LIMIT 15
        """, (tid_filter, ss_id, ss_id))
        streak_rows = cur.fetchall()
        streak_res = []
        for hs, as_, ht in streak_rows:
            ih = ht == ss_id
            gf_s = hs if ih else as_
            ga_s = as_ if ih else hs
            streak_res.append("W" if gf_s > ga_s else "D" if gf_s == ga_s else "L")
        win_streak = sum(1 for _ in __import__("itertools").takewhile(lambda r: r=="W",  streak_res))
        unbeat_streak = sum(1 for _ in __import__("itertools").takewhile(lambda r: r!="L", streak_res))
        loss_streak = sum(1 for _ in __import__("itertools").takewhile(lambda r: r=="L",  streak_res))

        # ── 최근 5경기 득점 추세 vs 시즌 평균
        recent5_gf = sum(
            (hs if ht==ss_id else as_)
            for hs, as_, ht in streak_rows[:5]
        )
        recent5_avg = recent5_gf / min(5, len(streak_rows)) if streak_rows else avg_gf

        # ── 득점 의존도 (top scorer 기여율)
        total_team_goals = (hgf or 0) + (agf or 0)
        scorer_dep = None
        if top_scorers and total_team_goals >= 5:
            scorer_dep = top_scorers[0]["goals"] / total_team_goals * 100

        # ── 유의사항 도출 ──
        notes = []

        # 연승/무패/연패 스트릭
        if win_streak >= 4:
            notes.append(f"현재 {win_streak}연승 행진 중")
        elif win_streak >= 3:
            notes.append(f"최근 {win_streak}연승")
        elif unbeat_streak >= 6:
            notes.append(f"최근 {unbeat_streak}경기 무패")
        if loss_streak >= 3:
            notes.append(f"현재 {loss_streak}연패 위기")
        elif form.count("L") >= 3 and loss_streak < 3:
            notes.append("최근 5경기 부진")

        # 홈/원정 강세
        if ha_gap > 20:
            notes.append(f"홈에서 특히 강함 (홈승률 {home_wr:.0f}% vs 원정 {away_wr:.0f}%)")
        elif ha_gap < -10:
            notes.append(f"원정이 오히려 강함 (원정승률 {away_wr:.0f}% vs 홈 {home_wr:.0f}%)")

        # 월별 강/약세
        if month_wr is not None:
            mn = ["1월","2월","3월","4월","5월","6월","7월","8월","9월","10월","11월","12월"][now_month-1]
            if month_wr >= 60:
                notes.append(f"{mn} 절정 (역대 {mn} 승률 {month_wr:.0f}%)")
            elif month_wr >= 50:
                notes.append(f"{mn} 강세 (역대 {mn} 승률 {month_wr:.0f}%)")
            elif month_wr <= 20:
                notes.append(f"{mn} 징크스 (역대 {mn} 승률 {month_wr:.0f}%)")
            elif month_wr <= 33:
                notes.append(f"{mn} 약세 (역대 {mn} 승률 {month_wr:.0f}%)")

        # 클린시트 / 수비력
        if clean_sheet_rate >= 50:
            notes.append(f"수비 철벽 (무실점률 {clean_sheet_rate:.0f}%)")
        elif clean_sheet_rate >= 35:
            notes.append(f"수비 견고 (무실점률 {clean_sheet_rate:.0f}%)")

        # 무득점 경기
        if blank_rate >= 40:
            notes.append(f"득점력 불안 (무득점 경기 {blank_rate:.0f}%)")
        elif blank_rate >= 30:
            notes.append(f"간헐적 득점 침묵 ({blank_rate:.0f}%)")

        # 접전 강/약
        if close_total >= 3:
            if close_wr >= 67:
                notes.append(f"접전에서 강함 (1골차 승률 {close_wr:.0f}%)")
            elif close_wr <= 30:
                notes.append(f"접전에서 약함 (1골차 승률 {close_wr:.0f}%)")

        # 대량 득점 폭발력
        if big_score_rate >= 40:
            notes.append(f"폭발적 공격력 (3골+ 경기 {big_score_rate:.0f}%)")

        # xG 효율
        if xg_efficiency is not None:
            if xg_efficiency >= 1.3:
                notes.append(f"결정력 탁월 (xG 대비 +{(xg_efficiency-1)*100:.0f}% 득점)")
            elif xg_efficiency <= 0.7:
                notes.append(f"결정력 부족 (xG 대비 -{(1-xg_efficiency)*100:.0f}% 손실)")

        # 득점력/실점 기본
        if avg_gf >= 2.0:
            notes.append(f"고득점 팀 (경기당 {avg_gf:.1f}골)")
        elif avg_gf >= 1.6:
            notes.append(f"공격적 (경기당 {avg_gf:.1f}골)")
        if avg_ga >= 2.0:
            notes.append(f"실점 다발 (경기당 {avg_ga:.1f}실점)")
        elif avg_ga >= 1.6:
            notes.append(f"수비 취약 (경기당 {avg_ga:.1f}실점)")

        # 득점 의존도
        if scorer_dep is not None and scorer_dep >= 50:
            notes.append(f"{top_scorers[0]['name']} 원톱 의존 ({scorer_dep:.0f}%)")

        # 최근 득점 추세
        if len(streak_rows) >= 3 and avg_gf > 0:
            if recent5_avg >= avg_gf * 1.4:
                notes.append(f"최근 공격력 급상승 (최근 {recent5_avg:.1f} vs 시즌 {avg_gf:.1f})")
            elif recent5_avg <= avg_gf * 0.55:
                notes.append(f"최근 득점 침체 (최근 {recent5_avg:.1f} vs 시즌 {avg_gf:.1f})")

        return {
            "total_games": total_g,
            "win_rate": total_w/(total_g or 1)*100,
            "home_wr": home_wr,
            "away_wr": away_wr,
            "form": form,
            "month_wr": month_wr,
            "notes": notes,
            "top_scorers": top_scorers,
            "avg_gf": avg_gf,
            "avg_ga": avg_ga,
            "standing": standings.get(ss_id),
        }

    # H2H 직접 전적 (전 리그/전 시즌 — tournament_id 무관, 두 팀 간 만남 모두 집계)
    cur.execute("""
        SELECT COUNT(*) g,
               SUM(CASE WHEN home_team_id=? THEN
                     CASE WHEN home_score>away_score THEN 1 ELSE 0 END
                   ELSE
                     CASE WHEN away_score>home_score THEN 1 ELSE 0 END
                   END) w,
               SUM(CASE WHEN home_score=away_score THEN 1 ELSE 0 END) d
        FROM events
        WHERE home_score IS NOT NULL
          AND ((home_team_id=? AND away_team_id=?) OR (home_team_id=? AND away_team_id=?))
    """, (hid, hid, aid, aid, hid))
    h2h = cur.fetchone()
    h2h_g, h2h_w, h2h_d = h2h
    h2h_l = (h2h_g or 0) - (h2h_w or 0) - (h2h_d or 0)

    home_stats = team_stats(hid, True)
    away_stats = team_stats(aid, False)

    # ──────────────────────────────────────────────────────────────
    # 포아송 기반 예측 (v2)
    # ──────────────────────────────────────────────────────────────

    def team_xg_avg(ss_id):
        """팀의 경기당 xG(for/against) — 2025+2026 시간 감쇠 가중 평균, xG null은 실점으로 fallback"""
        cur.execute("""
            SELECT e.id,
                   e.home_team_id=? AS is_home,
                   e.home_score, e.away_score,
                   (SELECT SUM(mps.expected_goals) FROM match_player_stats mps
                    WHERE mps.event_id=e.id AND mps.team_id=?) AS xg_for,
                   (SELECT SUM(mps.expected_goals) FROM match_player_stats mps
                    WHERE mps.event_id=e.id AND mps.team_id IS NOT NULL
                      AND mps.team_id != ?) AS xg_against
            FROM events e
            WHERE e.tournament_id=?
              AND (e.home_team_id=? OR e.away_team_id=?)
              AND e.home_score IS NOT NULL AND e.away_score IS NOT NULL
              AND strftime('%Y', datetime(e.date_ts,'unixepoch','localtime')) IN ('2025','2026')
            ORDER BY e.date_ts DESC
        """, (ss_id, ss_id, ss_id, tid_filter, ss_id, ss_id))
        rows = cur.fetchall()
        if not rows:
            return {"games": 0, "xg_for": 1.3, "xg_against": 1.3}
        _decay = _DECAY_LAMBDA
        wf = wa = wt = 0.0
        for rank, (_id, is_home, hs, as_, xg_f, xg_a) in enumerate(rows):
            w = _decay ** rank
            gf = hs if is_home else as_
            ga = as_ if is_home else hs
            wf += w * (float(xg_f) if xg_f is not None else float(gf or 0))
            wa += w * (float(xg_a) if xg_a is not None else float(ga or 0))
            wt += w
        return {
            "games": len(rows),
            "xg_for":  wf / wt,
            "xg_against": wa / wt,
        }

    home_xg = team_xg_avg(hid)
    away_xg = team_xg_avg(aid)

    # 리그 평균 팀당 득점(= 경기당 총득점 / 2) — 공격/수비 계수 정규화용
    cur.execute("""
        SELECT AVG(home_score + away_score) / 2.0
        FROM events
        WHERE tournament_id=? AND home_score IS NOT NULL AND away_score IS NOT NULL
          AND strftime('%Y', datetime(date_ts,'unixepoch','localtime'))=?
    """, (tid_filter, now_year))
    _row = cur.fetchone()
    league_avg = float(_row[0]) if _row and _row[0] else 1.3

    # 공격/수비 레이팅 (1.0 = 리그 평균)
    h_atk = (home_xg["xg_for"]    / league_avg) if league_avg else 1.0
    h_def = (home_xg["xg_against"] / league_avg) if league_avg else 1.0
    a_atk = (away_xg["xg_for"]    / league_avg) if league_avg else 1.0
    a_def = (away_xg["xg_against"] / league_avg) if league_avg else 1.0

    h_atk_adj = h_atk
    a_atk_adj = a_atk

    # 최종 람다
    _coefs   = _league_coefs(tid_filter)
    lam_home = max(0.1, h_atk_adj * a_def * league_avg * _coefs["home_adv"])
    lam_away = max(0.1, a_atk_adj * h_def * league_avg * _coefs["away_adj"])

    matrix     = _score_matrix(lam_home, lam_away, dc_rho=_coefs.get("dc_rho", 0.0))
    outcomes   = _matrix_outcomes(matrix, draw_boost=_coefs.get("draw_boost", 0.0))
    pred_home  = outcomes["home"]
    pred_draw  = outcomes["draw"]
    pred_away  = outcomes["away"]
    top_scores = outcomes["top_scores"]

    # 스코어 매트릭스 소수점 정리 (% 단위)
    score_matrix_pct = [[round(matrix[i][j] * 100, 1) for j in range(len(matrix))] for i in range(len(matrix))]

    # ──────────────────────────────────────────────────────────────
    # 신뢰도 배지
    # ──────────────────────────────────────────────────────────────
    h2h_games_cnt = h2h_g or 0
    season_games  = min(home_xg["games"], away_xg["games"])
    # 2026-05-12 임계값 재조정: high가 표본의 70%(K1 55/79)로 변별력 부족 +
    # K2 high<med 역전 → high 더 엄격(h2h≥8 AND season≥10)으로 표본 줄여 회복.
    # backtest 효과: K1 high 49.1%→51.1%, K2 high 43.6%→47.6%로 단조성(high>med>low) 회복.
    if h2h_games_cnt >= 8 and season_games >= 10:
        conf_level = "high"
    elif h2h_games_cnt >= 3 or season_games >= 6:
        conf_level = "med"
    else:
        conf_level = "low"

    # ──────────────────────────────────────────────────────────────
    # 최근 10경기 승점 이동(트렌드 라인용)
    # ──────────────────────────────────────────────────────────────
    def form_points(ss_id):
        cur.execute("""
            SELECT home_score, away_score, home_team_id, date_ts FROM events
            WHERE tournament_id=? AND (home_team_id=? OR away_team_id=?)
              AND home_score IS NOT NULL AND away_score IS NOT NULL
            ORDER BY date_ts DESC LIMIT 10
        """, (tid_filter, ss_id, ss_id))
        rows = list(reversed(cur.fetchall()))  # 과거→최근
        pts = []
        for hs, as_, ht, _dt in rows:
            is_home = ht == ss_id
            gf = hs if is_home else as_
            ga = as_ if is_home else hs
            pts.append(3 if gf > ga else 1 if gf == ga else 0)
        return pts

    home_form_pts = form_points(hid)
    away_form_pts = form_points(aid)

    # ──────────────────────────────────────────────────────────────
    # 골 타이밍 (시간대별 득점/실점) — 전후반 미니 차트용
    # ──────────────────────────────────────────────────────────────
    def goal_timing(ss_id):
        cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='goal_events'")
        if not cur.fetchone():
            return {"for": [0]*6, "against": [0]*6, "buckets": 6}
        # 15분 구간 6버킷: 0-15·16-30·31-45·46-60·61-75·76-90+ (added time는 45/90 경계 흡수)
        def _buckets(own):
            op = "=" if own else "!="
            cur.execute(f"""
                SELECT MIN(5, MAX(0, (g.minute - 1) / 15)) AS bk, COUNT(*)
                FROM goal_events g JOIN events e ON g.event_id=e.id
                WHERE e.tournament_id=? AND g.team_id {op} ?
                  AND (e.home_team_id=? OR e.away_team_id=?)
                  AND g.minute IS NOT NULL
                GROUP BY bk
            """, (tid_filter, ss_id, ss_id, ss_id))
            arr = [0]*6
            for bk, cnt in cur.fetchall():
                if bk is not None and 0 <= int(bk) <= 5:
                    arr[int(bk)] = int(cnt)
            return arr
        return {"for": _buckets(True), "against": _buckets(False), "buckets": 6}

    home_timing = goal_timing(hid)
    away_timing = goal_timing(aid)

    # ──────────────────────────────────────────────────────────────
    # 세트피스 분석 (fromSetPiece + penalty = 세트피스, regular = 오픈플레이, ownGoal = 별도)
    # ──────────────────────────────────────────────────────────────
    def setpiece_analysis(ss_id):
        cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='goal_events'")
        if not cur.fetchone():
            return {"goals_total": 0, "setpiece_goals": 0, "setpiece_pct": None,
                    "penalty_goals": 0, "freekick_goals": 0,
                    "conceded_total": 0, "setpiece_conceded": 0, "setpiece_conceded_pct": None}
        # 득점
        cur.execute("""
            SELECT COUNT(*),
                   SUM(CASE WHEN g.goal_type IN ('fromSetPiece','penalty') THEN 1 ELSE 0 END),
                   SUM(CASE WHEN g.goal_type='penalty' THEN 1 ELSE 0 END),
                   SUM(CASE WHEN g.goal_type='fromSetPiece' THEN 1 ELSE 0 END)
            FROM goal_events g JOIN events e ON g.event_id=e.id
            WHERE e.tournament_id=? AND g.team_id=?
              AND strftime('%Y', datetime(e.date_ts,'unixepoch','localtime'))=?
        """, (tid_filter, ss_id, now_year))
        r = cur.fetchone() or (0, 0, 0, 0)
        total, sp, pk, fk = (r[0] or 0), (r[1] or 0), (r[2] or 0), (r[3] or 0)

        # 실점 (상대가 우리 경기에서 넣은 골 중 세트피스)
        cur.execute("""
            SELECT COUNT(*),
                   SUM(CASE WHEN g.goal_type IN ('fromSetPiece','penalty') THEN 1 ELSE 0 END)
            FROM goal_events g JOIN events e ON g.event_id=e.id
            WHERE e.tournament_id=? AND g.team_id != ?
              AND (e.home_team_id=? OR e.away_team_id=?)
              AND strftime('%Y', datetime(e.date_ts,'unixepoch','localtime'))=?
        """, (tid_filter, ss_id, ss_id, ss_id, now_year))
        r2 = cur.fetchone() or (0, 0)
        conc_total, conc_sp = (r2[0] or 0), (r2[1] or 0)

        return {
            "goals_total":          total,
            "setpiece_goals":       sp,
            "setpiece_pct":         round(sp/total*100, 1) if total else None,
            "penalty_goals":        pk,
            "freekick_goals":       fk,
            "conceded_total":       conc_total,
            "setpiece_conceded":    conc_sp,
            "setpiece_conceded_pct": round(conc_sp/conc_total*100, 1) if conc_total else None,
        }

    home_sp = setpiece_analysis(hid)
    away_sp = setpiece_analysis(aid)

    # ── 카드(옐로/레드) 시즌 통계 ────────────────────────────
    # card_events 7K건 + events tournament/year 필터 → 가벼움
    def cards_analysis(ss_id):
        cur.execute("""
            SELECT COUNT(DISTINCT e.id) AS games,
                   COALESCE(SUM(CASE WHEN c.card_type IN ('yellow','yellowRed') THEN 1 ELSE 0 END), 0) AS yc,
                   COALESCE(SUM(CASE WHEN c.card_type='red' THEN 1 ELSE 0 END), 0) AS rc
            FROM events e
            LEFT JOIN card_events c ON c.event_id = e.id AND c.team_id = ?
            WHERE e.tournament_id=? AND e.home_score IS NOT NULL
              AND (e.home_team_id=? OR e.away_team_id=?)
              AND strftime('%Y', datetime(e.date_ts,'unixepoch','localtime'))=?
              AND e.id < 50000000
        """, (ss_id, tid_filter, ss_id, ss_id, now_year))
        r = cur.fetchone() or (0, 0, 0)
        games, yc, rc = (r[0] or 0), (r[1] or 0), (r[2] or 0)
        return {
            "games":      games,
            "yellow":     yc,
            "red":        rc,
            "y_per_game": round(yc/games, 2) if games else None,
            "r_per_game": round(rc/games, 3) if games else None,
        }

    home_cards = cards_analysis(hid)
    away_cards = cards_analysis(aid)

    # ── 팀 스타일(빌드업/경합/돌파) 시즌 통계 ───────────────
    # mps 시즌 집계 — long ball/cross 정확도, duel/aerial 승률, dribble 성공률
    def style_analysis(ss_id):
        cur.execute("""
            SELECT
                COUNT(DISTINCT m.event_id) AS games,
                COALESCE(SUM(m.total_long_balls), 0)    AS lb_t,
                COALESCE(SUM(m.accurate_long_balls), 0) AS lb_a,
                COALESCE(SUM(m.total_crosses), 0)       AS cr_t,
                COALESCE(SUM(m.accurate_crosses), 0)    AS cr_a,
                COALESCE(SUM(m.duel_won), 0)            AS du_w,
                COALESCE(SUM(m.duel_lost), 0)           AS du_l,
                COALESCE(SUM(m.aerial_won), 0)          AS ae_w,
                COALESCE(SUM(m.aerial_lost), 0)         AS ae_l,
                COALESCE(SUM(m.successful_dribbles), 0) AS dr_s,
                COALESCE(SUM(m.attempted_dribbles), 0)  AS dr_t
            FROM match_player_stats m
            JOIN events e ON m.event_id = e.id
            WHERE m.team_id = ? AND e.tournament_id = ?
              AND e.home_score IS NOT NULL
              AND strftime('%Y', datetime(e.date_ts,'unixepoch','localtime')) = ?
              AND e.id < 50000000
        """, (ss_id, tid_filter, now_year))
        r = cur.fetchone() or (0,)*11
        games, lb_t, lb_a, cr_t, cr_a, du_w, du_l, ae_w, ae_l, dr_s, dr_t = r
        return {
            "games":         games or 0,
            "long_ball_pct": round(lb_a/lb_t*100, 1) if lb_t else None,
            "long_ball_pg":  round(lb_t/games, 1)   if games else None,
            "cross_pct":     round(cr_a/cr_t*100, 1) if cr_t else None,
            "cross_pg":      round(cr_t/games, 1)    if games else None,
            "duel_pct":      round(du_w/(du_w+du_l)*100, 1) if (du_w+du_l) else None,
            "aerial_pct":    round(ae_w/(ae_w+ae_l)*100, 1) if (ae_w+ae_l) else None,
            "dribble_pct":   round(dr_s/dr_t*100, 1) if dr_t else None,
            "dribble_pg":    round(dr_t/games, 1)    if games else None,
        }

    # ── 팀 스타일 리그 순위 (타팀 대비 상위 능력 표시용) ──
    # 같은 지표 맞대결이 아니라, 각 팀이 리그에서 상위인 능력을 식별.
    def _style_league_ranks():
        cur.execute("""
            SELECT m.team_id,
                   SUM(m.accurate_long_balls)*1.0/NULLIF(SUM(m.total_long_balls),0)              AS lb,
                   SUM(m.accurate_crosses)*1.0/NULLIF(SUM(m.total_crosses),0)                    AS cr,
                   SUM(m.duel_won)*1.0/NULLIF(SUM(m.duel_won)+SUM(m.duel_lost),0)                AS du,
                   SUM(m.aerial_won)*1.0/NULLIF(SUM(m.aerial_won)+SUM(m.aerial_lost),0)          AS ae,
                   SUM(m.successful_dribbles)*1.0/NULLIF(SUM(m.attempted_dribbles),0)            AS dr,
                   COUNT(DISTINCT m.event_id)                                                    AS games
            FROM match_player_stats m JOIN events e ON m.event_id=e.id
            WHERE e.tournament_id=? AND e.home_score IS NOT NULL
              AND m.team_id IN (SELECT id FROM teams WHERE tournament_id=?)   -- 정규 리그 팀만 (분모 정확)
              AND strftime('%Y', datetime(e.date_ts,'unixepoch','localtime'))=? AND e.id < 50000000
            GROUP BY m.team_id
        """, (tid_filter, tid_filter, now_year))
        rows = [r for r in cur.fetchall() if (r[6] or 0) >= 3]   # 표본 3경기 이상만
        metrics = {"long_ball_pct": 1, "cross_pct": 2, "duel_pct": 3, "aerial_pct": 4, "dribble_pct": 5}
        ranks = {}   # team_id → {metric: {rank, total}}
        for mkey, idx in metrics.items():
            ordered = sorted([r for r in rows if r[idx] is not None], key=lambda r: r[idx], reverse=True)
            for pos, r in enumerate(ordered, 1):
                ranks.setdefault(r[0], {})[mkey] = {"rank": pos, "total": len(ordered)}
        return ranks

    _style_ranks = _style_league_ranks()
    home_style = style_analysis(hid)
    home_style["ranks"] = _style_ranks.get(hid, {})
    away_style = style_analysis(aid)
    away_style["ranks"] = _style_ranks.get(aid, {})

    # 휴식일 (현재 시각 기준 직전 경기로부터 일수)
    import time as _time
    _now_ts = int(_time.time())
    home_rest = _team_rest_days(cur, tid_filter, hid, _now_ts)
    away_rest = _team_rest_days(cur, tid_filter, aid, _now_ts)

    # ──────────────────────────────────────────────────────────────
    # 심판 정보 (K1 한정, K2는 원천 부재)
    # 양팀 마지막 경기에서 심판을 추정. 실제 매치업 심판은 사전에 발표돼야 알 수 있음.
    # ──────────────────────────────────────────────────────────────
    referee_info = None
    if tid_filter == 410:  # K1
        try:
            cur.execute("""
                SELECT r.id, r.name, r.career_games, r.career_yellow, r.career_red, r.career_yellow_red
                FROM referees r
                WHERE r.id IN (
                    SELECT e.referee_id FROM events e
                    WHERE e.tournament_id=? AND e.referee_id IS NOT NULL
                      AND ((e.home_team_id IN (?,?)) OR (e.away_team_id IN (?,?)))
                    ORDER BY e.date_ts DESC LIMIT 1
                )
            """, (tid_filter, hid, aid, hid, aid))
            rrow = cur.fetchone()
            if rrow:
                rid, rname, rgames, ry, rr, ryr = rrow
                referee_info = {
                    "id":              rid,
                    "name":            rname,
                    "career_games":    rgames or 0,
                    "yellow_per_game": round((ry or 0)/(rgames or 1), 2) if rgames else None,
                    "red_per_game":    round((rr or 0)/(rgames or 1), 3) if rgames else None,
                    "strictness":      ("엄격" if ((ry or 0)/(rgames or 1) > 3.5) else
                                        "관대" if ((ry or 0)/(rgames or 1) < 2.5) else "보통") if rgames else None,
                    "note":            "최근 양팀 경기 심판 — 실제 매치업 심판은 KFA 발표 후 확정",
                }
        except Exception:
            pass  # referees 테이블 없을 경우 무시

    conn.close()
    return jsonify({
        "home": {"id": home_id, "name": home_info["name"], **home_stats,
                 "form_points": home_form_pts, "goal_timing": home_timing,
                 "setpiece": home_sp, "cards": home_cards, "style": home_style,
                 "rest_days": home_rest,
                 "xg_for": round(home_xg["xg_for"], 2), "xg_against": round(home_xg["xg_against"], 2)},
        "away": {"id": away_id, "name": away_info["name"], **away_stats,
                 "form_points": away_form_pts, "goal_timing": away_timing,
                 "setpiece": away_sp, "cards": away_cards, "style": away_style,
                 "rest_days": away_rest,
                 "xg_for": round(away_xg["xg_for"], 2), "xg_against": round(away_xg["xg_against"], 2)},
        "h2h": {"games": h2h_g or 0, "home_w": h2h_w or 0, "draw": h2h_d or 0, "away_w": h2h_l},
        "prediction": {"home": pred_home, "draw": pred_draw, "away": pred_away},
        "poisson": {
            "lambda_home": round(lam_home, 2),
            "lambda_away": round(lam_away, 2),
            "league_avg":  round(league_avg, 2),
        },
        "score_matrix": score_matrix_pct,
        "top_scores":   top_scores,
        "confidence": {
            "level": conf_level,
            "h2h_games": h2h_games_cnt,
            "season_games": season_games,
        },
        "referee": referee_info,
    })


KLEAGUE_CODE_MAP = {
    "K01": "ulsan",  "K02": "suwon",    "K03": "pohang",  "K04": "jeju",
    "K05": "jeonbuk","K06": "busan",    "K07": "jeonnam", "K08": "seongnam",
    "K09": "fcseoul","K10": "daejeon",  "K17": "daegu",   "K18": "incheon",
    "K20": "gyeongnam","K21": "gangwon","K22": "gwangju", "K26": "bucheon",
    "K27": "anyang", "K29": "suwon_fc", "K31": "seouland","K32": "ansan",
    "K34": "asan",   "K35": "gimcheon", "K36": "gimpo",   "K37": "cheongju",
    "K38": "cheonan","K39": "hwaseong", "K40": "paju",    "K41": "gimhae",
    "K42": "yongin",
}
TEAMS_BY_ID = {t["id"]: t for t in TEAMS}


# ── 세트피스 효율 API (shotmap 기반 — 코너킥/프리킥/PK 분리) ──────────
def _setpiece_team_season(cur, ss_id, tournament_id, year):
    """팀의 시즌 세트피스 효율 (situation 분리). 매치 진행 여부 무관 누적.
    xG는 shotmap에 백필된 리그(K2)만 표시. 미백필 리그(K1 2026)는 None.
    """
    cur.execute("""
        SELECT s.situation,
               COUNT(*) shots,
               SUM(CASE WHEN s.outcome='goal' THEN 1 ELSE 0 END) goals,
               SUM(CASE WHEN s.xg IS NOT NULL THEN s.xg ELSE 0 END) xg_sum,
               SUM(CASE WHEN s.xg IS NOT NULL THEN 1 ELSE 0 END) xg_known
        FROM match_shotmap s
        JOIN events e ON s.event_id = e.id
        WHERE e.tournament_id = ?
          AND ((s.is_home=1 AND e.home_team_id=?) OR (s.is_home=0 AND e.away_team_id=?))
          AND s.situation IN ('corner','free-kick','penalty')
          AND strftime('%Y', datetime(e.date_ts, 'unixepoch', 'localtime')) = ?
        GROUP BY s.situation
    """, (tournament_id, ss_id, ss_id, year))
    out = {}
    for sit, shots, goals, xg_sum, xg_known in cur.fetchall():
        shots = shots or 0
        goals = goals or 0
        xg_sum = float(xg_sum or 0.0)
        has_xg = (xg_known or 0) > 0
        out[sit] = {
            "shots":          shots,
            "goals":          goals,
            "xg":             round(xg_sum, 2) if has_xg else None,
            "conversion_pct": round(goals / shots * 100, 1) if shots else None,
            "xg_per_shot":    round(xg_sum / shots, 3) if (has_xg and shots) else None,
            "xg_diff":        round(goals - xg_sum, 2) if has_xg else None,
        }
    for k in ("corner", "free-kick", "penalty"):
        if k not in out:
            out[k] = {"shots": 0, "goals": 0, "xg": None,
                      "conversion_pct": None, "xg_per_shot": None, "xg_diff": None}
    return out


def _setpiece_league_avg(cur, tournament_id, year):
    """리그 per-team 평균 세트피스 통계 (시즌 누적)."""
    cur.execute("""
        SELECT t.situation,
               AVG(t.shots) avg_shots,
               AVG(t.goals) avg_goals,
               AVG(t.xg)    avg_xg
        FROM (
            SELECT s.situation,
                   CASE WHEN s.is_home=1 THEN e.home_team_id ELSE e.away_team_id END team_id,
                   COUNT(*) shots,
                   SUM(CASE WHEN s.outcome='goal' THEN 1 ELSE 0 END) goals,
                   SUM(s.xg) xg
            FROM match_shotmap s
            JOIN events e ON s.event_id = e.id
            WHERE e.tournament_id = ?
              AND s.situation IN ('corner','free-kick','penalty')
              AND strftime('%Y', datetime(e.date_ts, 'unixepoch', 'localtime')) = ?
            GROUP BY s.situation, team_id
        ) t
        GROUP BY t.situation
    """, (tournament_id, year))
    out = {}
    for sit, ashots, agoals, axg in cur.fetchall():
        ashots = float(ashots or 0); agoals = float(agoals or 0); axg = float(axg or 0)
        out[sit] = {
            "avg_shots":          round(ashots, 1),
            "avg_goals":          round(agoals, 2),
            "avg_xg":             round(axg, 2),
            "avg_conversion_pct": round(agoals / ashots * 100, 1) if ashots else None,
        }
    for k in ("corner", "free-kick", "penalty"):
        if k not in out:
            out[k] = {"avg_shots": 0, "avg_goals": 0, "avg_xg": 0, "avg_conversion_pct": None}
    return out


def _setpiece_total(by_type):
    shots = sum(v["shots"] for v in by_type.values())
    goals = sum(v["goals"] for v in by_type.values())
    xg_vals = [v["xg"] for v in by_type.values() if v["xg"] is not None]
    has_xg = bool(xg_vals)
    xg_sum = round(sum(xg_vals), 2) if has_xg else None
    return {
        "shots":          shots,
        "goals":          goals,
        "xg":             xg_sum,
        "conversion_pct": round(goals / shots * 100, 1) if shots else None,
        "xg_diff":        round(goals - xg_sum, 2) if has_xg else None,
    }


def _setpiece_total_avg(by_type):
    ashots = sum(v["avg_shots"] for v in by_type.values())
    agoals = sum(v["avg_goals"] for v in by_type.values())
    axg    = round(sum(v["avg_xg"] for v in by_type.values()), 2)
    return {
        "avg_shots":          round(ashots, 1),
        "avg_goals":          round(agoals, 2),
        "avg_xg":             axg,
        "avg_conversion_pct": round(agoals / ashots * 100, 1) if ashots else None,
    }


def _setpiece_players(cur, ss_id, tournament_id, year, limit=5):
    """팀의 시즌 세트피스 슛 기여 선수 TOP N (상황별 집계 후 피벗)."""
    cur.execute("""
        SELECT ms.player_id,
               COALESCE(p.name_ko, p.name, ms2.player_name) AS name,
               ms.situation,
               COUNT(*)                                      AS shots,
               SUM(CASE WHEN ms.outcome='goal' THEN 1 ELSE 0 END) AS goals,
               ROUND(SUM(COALESCE(ms.xg, 0)), 2)            AS xg_sum
        FROM match_shotmap ms
        JOIN events e ON e.id = ms.event_id
        LEFT JOIN players p ON p.id = ms.player_id
        LEFT JOIN (
            SELECT DISTINCT player_id, player_name FROM match_player_stats
        ) ms2 ON ms2.player_id = ms.player_id
        WHERE e.tournament_id = ?
          AND ((ms.is_home=1 AND e.home_team_id=?) OR (ms.is_home=0 AND e.away_team_id=?))
          AND ms.situation IN ('corner','free-kick','penalty')
          AND strftime('%Y', datetime(e.date_ts,'unixepoch','localtime')) = ?
          AND ms.player_id IS NOT NULL
        GROUP BY ms.player_id, ms.situation
        ORDER BY shots DESC
    """, (tournament_id, ss_id, ss_id, year))

    # player_id → {name, situations: {sit: {shots,goals,xg}}, totals}
    players = {}
    for pid, name, sit, shots, goals, xg_sum in cur.fetchall():
        if pid not in players:
            players[pid] = {"player_id": pid, "name": name or "?",
                            "by_sit": {}, "total_shots": 0, "total_goals": 0, "total_xg": 0.0}
        p = players[pid]
        p["by_sit"][sit] = {"shots": shots, "goals": goals, "xg": round(float(xg_sum), 2)}
        p["total_shots"]  += shots
        p["total_goals"]  += goals
        p["total_xg"]     = round(p["total_xg"] + float(xg_sum), 2)

    ranked = sorted(players.values(), key=lambda x: (-x["total_goals"], -x["total_shots"]))
    return ranked[:limit]


@app.route("/api/setpiece-efficiency")
@cached_response(ttl=3600)
def setpiece_efficiency():
    """매치 양 팀의 시즌 세트피스 효율(코너킥/프리킥/PK 분리) + 리그 per-team 평균.

    shotmap 기반: situation IN (corner, free-kick, penalty). 매치 진행 여부 무관
    누적이라 예정 매치에도 작동. 리그는 home 팀 기준 (혼합 리그면 home 리그).
    """
    home_slug = request.args.get("home_slug", "").strip()
    away_slug = request.args.get("away_slug", "").strip()
    year      = request.args.get("year", "2026").strip()
    if not home_slug or not away_slug:
        return jsonify({"error": "home_slug and away_slug required"}), 400

    home_info = next((t for t in TEAMS if t["id"] == home_slug), None)
    away_info = next((t for t in TEAMS if t["id"] == away_slug), None)
    if not home_info or not away_info:
        return jsonify({"ready": False, "reason": "unknown_team"})

    league = home_info.get("league", "K2")
    tid    = 410 if league == "K1" else 777
    # K1 shotmap xG는 자체 모델 추정(build_k1_xg/backfill_k1_shotmap_xg), K2는 SofaScore 실측.
    xg_estimated = (league == "K1")

    conn = sqlite3.connect(DB_PATH)
    cur  = conn.cursor()
    try:
        home_ss = home_info["sofascore_id"]
        away_ss = away_info["sofascore_id"]
        home_sp      = _setpiece_team_season(cur, home_ss, tid, year)
        away_sp      = _setpiece_team_season(cur, away_ss, tid, year)
        league_avg   = _setpiece_league_avg(cur, tid, year)
        home_players = _setpiece_players(cur, home_ss, tid, year)
        away_players = _setpiece_players(cur, away_ss, tid, year)
    finally:
        conn.close()

    # 양 팀 모두 데이터 없으면 not-ready (시즌 초반 또는 K3 등)
    home_total_shots = sum(v["shots"] for v in home_sp.values())
    away_total_shots = sum(v["shots"] for v in away_sp.values())
    if home_total_shots == 0 and away_total_shots == 0:
        return jsonify({"ready": False, "reason": "no_setpiece_data", "year": year, "league": league})

    return jsonify({
        "ready":   True,
        "year":    year,
        "league":  league,
        "xg_estimated": xg_estimated,
        "home": {
            "slug":    home_slug,
            "name":    home_info["name"],
            "short":   home_info["short"],
            "primary": home_info.get("primary"),
            "by_type": home_sp,
            "total":   _setpiece_total(home_sp),
            "players": home_players,
        },
        "away": {
            "slug":    away_slug,
            "name":    away_info["name"],
            "short":   away_info["short"],
            "primary": away_info.get("primary"),
            "by_type": away_sp,
            "total":   _setpiece_total(away_sp),
            "players": away_players,
        },
        "league_avg": {
            "by_type": league_avg,
            "total":   _setpiece_total_avg(league_avg),
        },
    })


@app.route("/api/standings")
@cached_response(ttl=1800)
def get_standings():
    try:
        req = urllib.request.Request(
            "https://www.kleague.com/api/clubRank.do",
            data=b"{}",
            headers={"Content-Type": "application/json; charset=UTF-8",
                     "Accept": "application/json", "User-Agent": "Mozilla/5.0"},
        )
        with urllib.request.urlopen(req, timeout=8) as r:
            raw_data = json.loads(r.read().decode("utf-8"))
    except Exception as e:
        return jsonify({"error": str(e)}), 502

    result = {}
    for league_key in ("league1", "league2"):
        rows = raw_data.get("data", {}).get(league_key, [])
        cleaned = []
        for row in rows:
            team_code = row.get("teamId", "")
            internal_id = KLEAGUE_CODE_MAP.get(team_code)
            team_info = TEAMS_BY_ID.get(internal_id, {}) if internal_id else {}
            recent = []
            for i in range(1, 7):
                g = row.get(f"game0{i}", "").strip()
                if g:
                    recent.append(g)
            cleaned.append({
                "rank":    row.get("rank"),
                "teamId":  internal_id or team_code,
                "name":    team_info.get("name", team_code),
                "short":   team_info.get("short", team_code),
                "emblem":  team_info.get("emblem", ""),
                "primary": team_info.get("primary", "#333"),
                "games":   row.get("gameCount", 0),
                "w":       row.get("winCnt", 0),
                "d":       row.get("tieCnt", 0),
                "l":       row.get("lossCnt", 0),
                "gf":      row.get("gainGoal", 0),
                "ga":      row.get("lossGoal", 0),
                "gd":      row.get("gapCnt", 0),
                "pts":     row.get("gainPoint", 0),
                "recent":  recent,
            })
        result[league_key] = cleaned
    return jsonify(result)


# ── DB 설정 + 인덱스 ────────────────────────────────────
DB_PATH = os.path.join(BASE_DIR, "players.db")

def _ensure_indexes():
    """자주 쿼리되는 컬럼에 인덱스를 생성한다 (이미 있으면 무시)."""
    if not os.path.exists(DB_PATH):
        return
    conn = sqlite3.connect(DB_PATH)
    indexes = [
        "CREATE INDEX IF NOT EXISTS idx_events_tournament ON events(tournament_id)",
        "CREATE INDEX IF NOT EXISTS idx_events_date ON events(date_ts)",
        "CREATE INDEX IF NOT EXISTS idx_mps_position ON match_player_stats(position)",
        "CREATE INDEX IF NOT EXISTS idx_mps_team_player ON match_player_stats(team_id, player_id)",
        "CREATE INDEX IF NOT EXISTS idx_mps_match_date ON match_player_stats(match_date)",
        "CREATE INDEX IF NOT EXISTS idx_heatmap_player_event ON heatmap_points(player_id, event_id)",
        "CREATE INDEX IF NOT EXISTS idx_players_name_ko ON players(name_ko)",
        "CREATE INDEX IF NOT EXISTS idx_goal_events_player ON goal_events(player_id)",
        "CREATE INDEX IF NOT EXISTS idx_events_home_team ON events(home_team_id)",
        "CREATE INDEX IF NOT EXISTS idx_events_away_team ON events(away_team_id)",
        "CREATE INDEX IF NOT EXISTS idx_events_tourn_date ON events(tournament_id, date_ts)",
        "CREATE INDEX IF NOT EXISTS idx_mps_event_id ON match_player_stats(event_id)",
        "CREATE INDEX IF NOT EXISTS idx_mps_team_event ON match_player_stats(team_id, event_id)",
        "CREATE INDEX IF NOT EXISTS idx_heatmap_event ON heatmap_points(event_id)",
        "CREATE INDEX IF NOT EXISTS idx_lineups_event ON match_lineups(event_id)",
    ]
    for sql in indexes:
        try:
            conn.execute(sql)
        except Exception:
            pass  # 테이블이 아직 없을 수 있음
    conn.commit()
    conn.close()

_ensure_indexes()

# ── 히트맵 API ───────────────────────────────────────────

# sofascore_id → 한글 팀명 매핑
_SS_TO_KO = {t["sofascore_id"]: t["name"] for t in TEAMS}

def _ko_team(sofascore_id, fallback):
    return _SS_TO_KO.get(sofascore_id, fallback)

def _year_range(year_str):
    """연도 문자열 → (start_ts, end_ts) UTC 기준"""
    y = int(year_str)
    start = int(datetime(y,   1, 1).timestamp())
    end   = int(datetime(y+1, 1, 1).timestamp())
    return start, end

def _find_player(cur, name):
    """(player_id, team_id, matched_name) 반환, 없으면 (None, None, None)"""
    cur.execute("SELECT id, team_id, name_ko, name FROM players WHERE name_ko = ?", (name,))
    row = cur.fetchone()
    if not row:
        # 공백 제거 후 재시도 (예: '브루노 실바' vs '브루노실바')
        name_no_space = name.replace(" ", "")
        cur.execute("SELECT id, team_id, name_ko, name FROM players WHERE REPLACE(name_ko, ' ', '') = ?", (name_no_space,))
        row = cur.fetchone()
    if not row:
        cur.execute("SELECT id, team_id, name_ko, name FROM players WHERE name LIKE ?", (f"%{name}%",))
        row = cur.fetchone()
    if not row:
        return (None, None, None)
    matched = row["name_ko"] or row["name"]
    return (row["id"], row["team_id"], matched)

def _flip_points(rows, player_team_id):
    """away 경기 포인트를 x축 반전 (x→100-x)"""
    result = []
    for r in rows:
        if r["away_team_id"] == player_team_id:
            result.append({"x": 100 - r["x"], "y": r["y"]})
        else:
            result.append({"x": r["x"], "y": r["y"]})
    return result

CURRENT_YEAR = str(datetime.now().year)

@app.route("/api/heatmap")
@cached_response(ttl=3600)
def get_heatmap():
    name = request.args.get("name", "").strip()
    if not name:
        return jsonify({"error": "name required"}), 400
    if not os.path.exists(DB_PATH):
        return jsonify({"points": []})
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    player_id, player_team_id, matched_name = _find_player(cur, name)
    if not player_id:
        conn.close()
        return jsonify({"points": [], "found": False})

    event_id    = request.args.get("eventId", "").strip()
    opponent_id = request.args.get("opponentId", "").strip()
    year        = request.args.get("year", CURRENT_YEAR).strip()
    year_start, year_end = _year_range(year)

    # 특정 경기 히트맵 → AWAY면 API에서 flip
    if event_id:
        cur.execute("""
            SELECT h.x, h.y, e.away_team_id
            FROM heatmap_points h
            LEFT JOIN events e ON h.event_id = e.id
            WHERE h.player_id = ? AND h.event_id = ?
        """, (player_id, event_id))
        points = _flip_points(cur.fetchall(), player_team_id)
        conn.close()
        return jsonify({"points": points, "found": True, "playerId": player_id,
                        "filtered": True, "matchedName": matched_name})

    # 누적 히트맵 — AWAY 경기도 flip 정규화 (Sofascore와 동일하게)
    if opponent_id:
        cur.execute("""
            SELECT h.x, h.y, e.away_team_id
            FROM heatmap_points h
            JOIN events e ON h.event_id = e.id
            WHERE h.player_id = ?
              AND (e.home_team_id = ? OR e.away_team_id = ?)
              AND e.date_ts >= ? AND e.date_ts < ?
        """, (player_id, opponent_id, opponent_id, year_start, year_end))
    else:
        cur.execute("""
            SELECT h.x, h.y, e.away_team_id
            FROM heatmap_points h
            LEFT JOIN events e ON h.event_id = e.id
            WHERE h.player_id = ?
              AND (e.date_ts IS NULL OR (e.date_ts >= ? AND e.date_ts < ?))
        """, (player_id, year_start, year_end))

    points = _flip_points(cur.fetchall(), player_team_id)
    conn.close()
    return jsonify({"points": points, "found": True, "playerId": player_id,
                    "filtered": bool(opponent_id), "matchedName": matched_name})

@app.route("/api/player-matches")
@cached_response(ttl=1800)
def get_player_matches():
    name = request.args.get("name", "").strip()
    if not name:
        return jsonify({"error": "name required"}), 400
    if not os.path.exists(DB_PATH):
        return jsonify({"matches": []})
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    player_id, player_team_id, matched_name = _find_player(cur, name)
    if not player_id:
        conn.close()
        return jsonify({"matches": [], "found": False})

    year = request.args.get("year", "all").strip()

    if year == "all":
        cur.execute("""
            SELECT DISTINCT e.id, e.home_team_id, e.home_team_name,
                            e.away_team_id, e.away_team_name,
                            e.home_score, e.away_score, e.date_ts
            FROM heatmap_points h
            JOIN events e ON h.event_id = e.id
            WHERE h.player_id = ? AND e.date_ts IS NOT NULL
            ORDER BY e.date_ts DESC
        """, (player_id,))
    else:
        ys, ye = _year_range(year)
        cur.execute("""
            SELECT DISTINCT e.id, e.home_team_id, e.home_team_name,
                            e.away_team_id, e.away_team_name,
                            e.home_score, e.away_score, e.date_ts
            FROM heatmap_points h
            JOIN events e ON h.event_id = e.id
            WHERE h.player_id = ? AND e.date_ts >= ? AND e.date_ts < ?
            ORDER BY e.date_ts DESC
        """, (player_id, ys, ye))

    matches = []
    for r in cur.fetchall():
        matches.append({
            "id":        r["id"],
            "home":      _ko_team(r["home_team_id"], r["home_team_name"]),
            "away":      _ko_team(r["away_team_id"], r["away_team_name"]),
            "homeScore": r["home_score"],
            "awayScore": r["away_score"],
            "datets":    r["date_ts"],
            "isAway":    r["away_team_id"] == player_team_id,
        })
    conn.close()
    return jsonify({"matches": matches, "found": True, "playerId": player_id})


@app.route("/api/player-stat-report")
@cached_response(ttl=3600)
def get_player_stat_report():
    """선수 상세 스탯 보고서 - 포지션 대비 퍼센타일 포함"""
    import datetime as _dt
    name      = request.args.get("name", "").strip()
    player_id = request.args.get("playerId", type=int)
    year      = request.args.get("year")

    db_path = DB_PATH
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    # 선수 찾기
    if player_id:
        cur.execute("SELECT id, team_id, name_ko, name FROM players WHERE id=?", (player_id,))
        row = cur.fetchone()
        if row:
            pid, team_id_db = row["id"], row["team_id"]
            matched = row["name_ko"] or row["name"]
        else:
            pid, team_id_db, matched = None, None, None
    else:
        pid, team_id_db, matched = _find_player(cur, name)

    if not pid:
        conn.close()
        return jsonify({"found": False}), 404

    year_clause = "AND strftime('%Y', datetime(e.date_ts,'unixepoch','localtime'))=?" if year else ""
    yp = (year,) if year else ()

    # 선수 기본 정보
    cur.execute("SELECT * FROM players WHERE id=?", (pid,))
    prow = cur.fetchone()
    pos_raw = None
    height  = prow["height"] if prow else None

    # 출전 포지션 (mps에서 최빈값)
    cur.execute(f"""
        SELECT mps.position, COUNT(*) cnt
        FROM match_player_stats mps JOIN events e ON mps.event_id=e.id
        WHERE mps.player_id=? AND e.tournament_id=777 {year_clause}
        GROUP BY mps.position ORDER BY cnt DESC LIMIT 1
    """, (pid,) + yp)
    pr = cur.fetchone()
    pos_raw = pr[0] if pr else (prow["position"] if prow else "?")

    # 사용 가능 연도
    cur.execute("""
        SELECT DISTINCT strftime('%Y', datetime(e.date_ts,'unixepoch','localtime')) yr
        FROM match_player_stats mps JOIN events e ON mps.event_id=e.id
        WHERE mps.player_id=? AND e.tournament_id=777 ORDER BY yr
    """, (pid,))
    available_years = [r[0] for r in cur.fetchall()]

    # 대상 선수 집계 (90분 환산)
    cur.execute(f"""
        SELECT COUNT(*) games,
               SUM(mps.minutes_played) mins,
               SUM(mps.goals) goals, SUM(mps.assists) assists,
               SUM(mps.total_shots) shots, SUM(mps.shots_on_target) sot,
               AVG(mps.expected_goals) xg_avg,
               AVG(mps.accurate_passes_pct) pass_pct,
               SUM(mps.key_passes) key_passes,
               SUM(mps.total_passes) total_passes,
               SUM(mps.successful_dribbles) drib_s, SUM(mps.attempted_dribbles) drib_a,
               SUM(mps.tackles) tackles, SUM(mps.interceptions) ints,
               SUM(mps.clearances) clears, SUM(mps.blocked_shots) blocked,
               SUM(mps.aerial_won) aer_w, SUM(mps.aerial_lost) aer_l,
               SUM(mps.duel_won) duel_w, SUM(mps.duel_lost) duel_l,
               SUM(mps.fouls) fouls, SUM(mps.was_fouled) fouled,
               SUM(mps.yellow_cards) yellows, SUM(mps.red_cards) reds,
               SUM(mps.saves) saves, SUM(mps.goals_conceded) conceded,
               SUM(mps.touches) touches, SUM(mps.possession_lost) poss_lost,
               AVG(mps.rating) rating,
               SUM(mps.accurate_long_balls) long_b_s, SUM(mps.total_long_balls) long_b_a,
               SUM(mps.accurate_crosses) cross_s, SUM(mps.total_crosses) cross_a,
               SUM(mps.big_chances_missed) bcm
        FROM match_player_stats mps JOIN events e ON mps.event_id=e.id
        WHERE mps.player_id=? AND e.tournament_id=777 {year_clause}
    """, (pid,) + yp)
    p = cur.fetchone()
    mins = p["mins"] or 1
    games = p["games"] or 0

    def p90(v): return round((v or 0) / mins * 90, 3) if mins else 0
    def pct(a, b): return round((a or 0) / (b or 1) * 100, 1) if b else None

    # 팀명
    cur.execute("SELECT DISTINCT mps.team_id FROM match_player_stats mps WHERE mps.player_id=? LIMIT 1", (pid,))
    tid_row = cur.fetchone()
    ss_team_id = tid_row[0] if tid_row else team_id_db
    team_name = _ko_name_by_ss_id(ss_team_id) or str(ss_team_id)

    # 키 순위 (데이터 있는 경우)
    weight = prow["weight"] if prow and "weight" in prow.keys() else None

    _ALLOWED_PHYSICAL_COLS = {"height", "weight"}

    def physical_rank(col, val):
        if col not in _ALLOWED_PHYSICAL_COLS:
            raise ValueError(f"disallowed physical column: {col}")
        if not val: return None
        # 쿼리 2회 → 1회: 단일 EXISTS + 조건부 COUNT로 통합
        cur.execute(f"""
            SELECT SUM(CASE WHEN p2.{col} > ? THEN 1 ELSE 0 END) AS above,
                   COUNT(*) AS total
            FROM players p2
            WHERE p2.{col} IS NOT NULL AND p2.{col} > 0
              AND EXISTS (SELECT 1 FROM match_player_stats m2 JOIN events e2 ON m2.event_id=e2.id
                          WHERE m2.player_id=p2.id AND e2.tournament_id=777)
        """, (val,))
        row = cur.fetchone()
        above, total = row[0] or 0, row[1] or 0
        return {"rank": above+1, "total": total, "pct": round((1 - above/total)*100) if total else None}

    height_rank = physical_rank("height", height)
    weight_rank = physical_rank("weight", weight)

    # ── 같은 포지션 선수 집계 (퍼센타일 기준) ──────────────────
    cur.execute(f"""
        SELECT mps.player_id,
               SUM(mps.minutes_played)              mins,
               SUM(mps.goals)                       goals,
               SUM(mps.assists)                     assists,
               SUM(mps.total_shots)                 shots,
               SUM(mps.shots_on_target)             sot,
               AVG(mps.accurate_passes_pct)         pass_pct,
               SUM(mps.key_passes)                  key_passes,
               SUM(mps.successful_dribbles)         drib_s,
               SUM(mps.attempted_dribbles)          drib_a,
               SUM(mps.tackles)                     tackles,
               SUM(mps.interceptions)               ints,
               SUM(mps.clearances)                  clears,
               SUM(mps.blocked_shots)               blocked,
               SUM(mps.aerial_won)                  aer_w,
               SUM(mps.aerial_lost)                 aer_l,
               SUM(mps.duel_won)                    duel_w,
               SUM(mps.duel_lost)                   duel_l,
               SUM(mps.saves)                       saves,
               SUM(mps.goals_conceded)              conceded,
               SUM(mps.fouls)                       fouls,
               SUM(mps.was_fouled)                  fouled,
               SUM(mps.touches)                     touches,
               COUNT(*)                             games
        FROM match_player_stats mps JOIN events e ON mps.event_id=e.id
        WHERE e.tournament_id=777 AND mps.position=? {year_clause}
        GROUP BY mps.player_id
        HAVING mins >= 270 AND games >= 5
    """, (pos_raw,) + yp)

    peers = {}
    for r in cur.fetchall():
        m = r["mins"] or 1
        def v90(col): return (r[col] or 0) / m * 90
        peers[r["player_id"]] = {
            "goals":    v90("goals"),
            "assists":  v90("assists"),
            "shots":    v90("shots"),
            "sot":      v90("sot"),
            "pass_pct": r["pass_pct"] or 0,
            "key_passes": v90("key_passes"),
            "drib_s":   v90("drib_s"),
            "drib_pct": pct(r["drib_s"], r["drib_a"]) or 0,
            "tackles":  v90("tackles"),
            "ints":     v90("ints"),
            "clears":   v90("clears"),
            "blocked":  v90("blocked"),
            "aer_w":    v90("aer_w"),
            "aer_pct":  pct(r["aer_w"], (r["aer_w"] or 0)+(r["aer_l"] or 0)) or 0,
            "duel_w":   v90("duel_w"),
            "duel_pct": pct(r["duel_w"], (r["duel_w"] or 0)+(r["duel_l"] or 0)) or 0,
            "saves":    v90("saves"),
            "touches":  v90("touches"),
            "fouls":    v90("fouls"),
        }

    def percentile(key, val, higher_is_better=True):
        vals = [v[key] for v in peers.values() if v[key] is not None]
        if not vals: return 50
        if higher_is_better:
            below = sum(1 for v in vals if v < val)
        else:
            below = sum(1 for v in vals if v > val)
        return round(below / len(vals) * 100)

    # 대상 선수 90분 환산값
    my = {
        "goals":    p90(p["goals"]),
        "assists":  p90(p["assists"]),
        "shots":    p90(p["shots"]),
        "sot":      p90(p["sot"]),
        "pass_pct": p["pass_pct"] or 0,
        "key_passes": p90(p["key_passes"]),
        "drib_s":   p90(p["drib_s"]),
        "drib_pct": pct(p["drib_s"], p["drib_a"]) or 0,
        "tackles":  p90(p["tackles"]),
        "ints":     p90(p["ints"]),
        "clears":   p90(p["clears"]),
        "blocked":  p90(p["blocked"]),
        "aer_w":    p90(p["aer_w"]),
        "aer_pct":  pct(p["aer_w"], (p["aer_w"] or 0)+(p["aer_l"] or 0)) or 0,
        "duel_w":   p90(p["duel_w"]),
        "duel_pct": pct(p["duel_w"], (p["duel_w"] or 0)+(p["duel_l"] or 0)) or 0,
        "saves":    p90(p["saves"]),
        "touches":  p90(p["touches"]),
        "fouls":    p90(p["fouls"]),
    }

    # 퍼센타일 계산
    pctile = {k: percentile(k, my[k]) for k in my}
    pctile["fouls"] = percentile("fouls", my["fouls"], higher_is_better=False)

    # 포지션별 주요 지표 그룹
    POS_GROUPS = {
        "G": [
            {"key":"saves",    "label":"선방(90분)",         "icon":"🧤"},
            {"key":"aer_pct",  "label":"공중볼 장악률(%)",    "icon":"✈"},
            {"key":"pass_pct", "label":"패스 성공률(%)",      "icon":"🎯"},
            {"key":"touches",  "label":"볼터치(90분)",        "icon":"👟"},
        ],
        "D": [
            {"key":"tackles",  "label":"태클(90분)",          "icon":"🛡"},
            {"key":"ints",     "label":"인터셉트(90분)",       "icon":"✂"},
            {"key":"clears",   "label":"클리어링(90분)",       "icon":"🥊"},
            {"key":"aer_w",    "label":"공중볼 성공(90분)",    "icon":"✈"},
            {"key":"aer_pct",  "label":"공중볼 장악률(%)",     "icon":"📊"},
            {"key":"blocked",  "label":"슈팅 차단(90분)",      "icon":"🚫"},
            {"key":"duel_pct", "label":"지상 듀얼 승률(%)",    "icon":"⚔"},
            {"key":"pass_pct", "label":"패스 성공률(%)",       "icon":"🎯"},
        ],
        "M": [
            {"key":"key_passes","label":"키패스(90분)",        "icon":"🔑"},
            {"key":"pass_pct", "label":"패스 성공률(%)",       "icon":"🎯"},
            {"key":"assists",  "label":"도움(90분)",           "icon":"🎨"},
            {"key":"drib_s",   "label":"드리블 성공(90분)",    "icon":"💨"},
            {"key":"tackles",  "label":"태클(90분)",           "icon":"🛡"},
            {"key":"ints",     "label":"인터셉트(90분)",       "icon":"✂"},
            {"key":"goals",    "label":"득점(90분)",           "icon":"⚽"},
            {"key":"touches",  "label":"볼터치(90분)",         "icon":"👟"},
        ],
        "F": [
            {"key":"goals",    "label":"득점(90분)",           "icon":"⚽"},
            {"key":"assists",  "label":"도움(90분)",           "icon":"🎨"},
            {"key":"shots",    "label":"슈팅(90분)",           "icon":"🎯"},
            {"key":"sot",      "label":"유효슈팅(90분)",       "icon":"🎯"},
            {"key":"drib_s",   "label":"드리블 성공(90분)",    "icon":"💨"},
            {"key":"drib_pct", "label":"드리블 성공률(%)",     "icon":"📊"},
            {"key":"aer_w",    "label":"공중볼 성공(90분)",    "icon":"✈"},
            {"key":"fouls",    "label":"파울 유도(90분)",      "icon":"🤸"},
        ],
    }

    stat_groups = POS_GROUPS.get(pos_raw, POS_GROUPS["M"])
    stat_items = []
    for sg in stat_groups:
        k = sg["key"]
        raw_val = my.get(k, 0)
        stat_items.append({
            "key":     k,
            "label":   sg["label"],
            "icon":    sg["icon"],
            "val":     round(raw_val, 2),
            "pctile":  pctile.get(k, 50),
            "peer_cnt": len(peers),
        })

    # 활동량 지표 (전체 선수 대비)
    cur.execute(f"""
        SELECT mps.player_id,
               SUM(mps.touches)                              AS touches,
               SUM(mps.duel_won) + SUM(mps.duel_lost)       AS duels,
               SUM(mps.total_passes)                         AS passes,
               SUM(mps.tackles) + SUM(mps.interceptions)    AS def_acts,
               SUM(mps.attempted_dribbles)                   AS dribbles,
               SUM(mps.minutes_played)                       AS mins2,
               COUNT(*)                                      AS games2
        FROM match_player_stats mps JOIN events e ON mps.event_id=e.id
        WHERE e.tournament_id=777 {year_clause}
        GROUP BY mps.player_id
        HAVING games2 >= 3 AND mins2 >= 150
    """, yp)

    all_activity = {}
    for r in cur.fetchall():
        m2 = r["mins2"] or 1
        all_activity[r["player_id"]] = {
            "touches_p90":  (r["touches"]  or 0) / m2 * 90,
            "duels_p90":    (r["duels"]    or 0) / m2 * 90,
            "passes_p90":   (r["passes"]   or 0) / m2 * 90,
            "def_p90":      (r["def_acts"] or 0) / m2 * 90,
            "dribbles_p90": (r["dribbles"] or 0) / m2 * 90,
        }

    def _act_pct(axis, val):
        vals = [v[axis] for v in all_activity.values()]
        if not vals: return 0
        return round(sum(1 for v in vals if v < val) / len(vals) * 100)

    p_act = all_activity.get(pid, {})
    activity_score = 0
    activity_percentiles = {}
    if p_act:
        weights = {"touches_p90": 0.35, "duels_p90": 0.25,
                   "passes_p90": 0.20, "def_p90": 0.10, "dribbles_p90": 0.10}
        for axis, w in weights.items():
            pct2 = _act_pct(axis, p_act.get(axis, 0))
            activity_percentiles[axis] = pct2
            activity_score += pct2 * w
        activity_score = round(activity_score)

    league_avg_act = {}
    if all_activity:
        for axis in ["touches_p90", "duels_p90", "passes_p90", "def_p90", "dribbles_p90"]:
            vals = [v[axis] for v in all_activity.values()]
            league_avg_act[axis] = round(sum(vals) / len(vals), 1) if vals else 0

    # 레이더용 5개 지표 (포지션별)
    RADAR_KEYS = {
        "G": ["saves","aer_pct","pass_pct","touches","duel_pct"],
        "D": ["tackles","ints","aer_pct","blocked","pass_pct"],
        "M": ["key_passes","pass_pct","drib_s","tackles","goals"],
        "F": ["goals","shots","drib_s","aer_w","assists"],
    }
    radar_keys = RADAR_KEYS.get(pos_raw, RADAR_KEYS["M"])
    RADAR_LABELS = {
        "goals":"득점","assists":"도움","shots":"슈팅","sot":"유효슈팅",
        "pass_pct":"패스%","key_passes":"키패스","drib_s":"드리블",
        "tackles":"태클","ints":"인터셉트","aer_pct":"공중볼%",
        "blocked":"슈팅차단","saves":"선방","touches":"터치","duel_pct":"듀얼승률%",
    }
    radar = [{"label": RADAR_LABELS.get(k, k), "pctile": pctile.get(k, 50)} for k in radar_keys]

    # 최근 5경기 폼
    cur.execute("""
        SELECT e.date_ts,
               CASE WHEN mps.is_home=1 THEN e.away_team_id ELSE e.home_team_id END opp_id,
               mps.goals, mps.assists, mps.rating, mps.result, mps.is_home,
               e.home_score, e.away_score,
               mps.tackles, mps.interceptions, mps.clearances, mps.aerial_won,
               mps.saves, mps.shots_on_target, mps.key_passes
        FROM match_player_stats mps JOIN events e ON mps.event_id=e.id
        WHERE mps.player_id=? AND e.tournament_id=777 AND e.date_ts IS NOT NULL
        ORDER BY e.date_ts DESC LIMIT 5
    """, (pid,))
    recent_form = []
    for r in cur.fetchall():
        d = _dt.datetime.utcfromtimestamp(r[0])
        hs, aws, is_home = r[7], r[8], r[6]
        if hs is not None and aws is not None:
            my_score, opp_score = (hs, aws) if is_home else (aws, hs)
            calc_result = "W" if my_score > opp_score else ("D" if my_score == opp_score else "L")
        else:
            calc_result = "?"
        recent_form.append({
            "date":       f"{d.year}/{d.month}/{d.day}",
            "opponent":   _ko_name_by_ss_id(str(r[1])) or str(r[1]),
            "is_home":    bool(r[6]),
            "goals":      r[2] or 0,
            "assists":    r[3] or 0,
            "rating":     round(r[4], 1) if r[4] else None,
            "result":     calc_result,
            "score":      f"{r[7]}-{r[8]}",
            "tackles":    r[9] or 0,
            "ints":       r[10] or 0,
            "clears":     r[11] or 0,
            "aer_w":      r[12] or 0,
            "saves":      r[13] or 0,
            "sot":        r[14] or 0,
            "key_passes": r[15] or 0,
        })

    conn.close()
    pos_label = {"G":"GK","D":"DF","M":"MF","F":"FW"}.get(pos_raw, pos_raw or "?")
    return jsonify({
        "found":      True,
        "player": {
            "id":       pid,
            "name":     matched,
            "team":     team_name,
            "pos":      pos_raw,
            "pos_label": pos_label,
            "height":   height,
            "weight":   weight,
            "height_rank": height_rank,
            "weight_rank": weight_rank,
            "games":    games,
            "mins":     int(mins),
            "goals":    p["goals"] or 0,
            "assists":  p["assists"] or 0,
            "rating":   round(p["rating"], 2) if p["rating"] else None,
            "yellows":  p["yellows"] or 0,
            "reds":     p["reds"] or 0,
        },
        "available_years": available_years,
        "stat_items":  stat_items,
        "radar":       radar,
        "recent_form": recent_form,
        "peer_count":  len(peers),
        "activity": {
            "score":       activity_score,
            "values":      {k: round(v, 1) for k, v in p_act.items()} if p_act else {},
            "percentiles": activity_percentiles,
            "league_avg":  league_avg_act,
        },
    })


@app.route("/api/player-analytics")
@cached_response(ttl=1800)
def get_player_analytics():
    """선수 개인 분석 보고서"""
    import datetime as _dt
    player_id = request.args.get("playerId", type=int)
    year      = request.args.get("year")
    if not player_id:
        return jsonify({}), 400

    db_path = DB_PATH
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    # 선수 기본 정보
    cur.execute("""
        SELECT COALESCE(p.name_ko, p.name) nm, p.position pos, p.team_id, p.height, p.preferred_foot
        FROM players p WHERE p.id=?
    """, (player_id,))
    row = cur.fetchone()
    if not row:
        conn.close()
        return jsonify({}), 404

    name, position, team_id, height, preferred_foot = row["nm"], row["pos"], row["team_id"], row["height"], row["preferred_foot"]

    # 팀 한국어명 조회 + 소속 리그 판별 (가장 최근에 뛴 팀 기준)
    cur.execute("""
        SELECT mps.team_id
        FROM match_player_stats mps
        JOIN events e ON mps.event_id = e.id
        WHERE mps.player_id = ? AND e.date_ts IS NOT NULL
        ORDER BY e.date_ts DESC LIMIT 1
    """, (player_id,))
    tid_row = cur.fetchone()
    ss_team_id = tid_row[0] if tid_row else team_id
    team_name = _ko_name_by_ss_id(ss_team_id) or str(ss_team_id)
    league_key, tournament_id = _team_league(ss_team_id)

    year_clause = "AND strftime('%Y', datetime(e.date_ts,'unixepoch','localtime'))=?" if year else ""
    yp = (year,) if year else ()

    # 사용 가능 연도
    cur.execute("""
        SELECT DISTINCT strftime('%Y', datetime(e.date_ts,'unixepoch','localtime')) yr
        FROM match_player_stats mps JOIN events e ON mps.event_id=e.id
        WHERE mps.player_id=? AND e.tournament_id=? AND e.date_ts IS NOT NULL
        ORDER BY yr
    """, (player_id, tournament_id))
    available_years = [r[0] for r in cur.fetchall()]

    # 시즌별 집계
    cur.execute("""
        SELECT strftime('%Y', datetime(e.date_ts,'unixepoch','localtime')) yr,
               COUNT(*) games, SUM(mps.goals) goals, SUM(mps.assists) assists,
               AVG(mps.rating) rating, SUM(mps.minutes_played) minutes
        FROM match_player_stats mps JOIN events e ON mps.event_id=e.id
        WHERE mps.player_id=? AND e.tournament_id=?
        GROUP BY yr ORDER BY yr
    """, (player_id, tournament_id))
    season_summary = [
        {"year": r[0], "games": r[1], "goals": r[2] or 0, "assists": r[3] or 0,
         "rating": round(r[4], 2) if r[4] else None, "minutes": r[5] or 0}
        for r in cur.fetchall()
    ]

    # 월별 분석
    cur.execute(f"""
        SELECT CAST(strftime('%m', datetime(e.date_ts,'unixepoch','localtime')) AS INTEGER) mn,
               COUNT(*) games, SUM(mps.goals) goals, SUM(mps.assists) assists,
               AVG(mps.rating) rating
        FROM match_player_stats mps JOIN events e ON mps.event_id=e.id
        WHERE mps.player_id=? AND e.tournament_id=? {year_clause}
        GROUP BY mn ORDER BY mn
    """, (player_id, tournament_id) + yp)
    monthly = [
        {"month": r[0], "games": r[1], "goals": r[2] or 0, "assists": r[3] or 0,
         "rating": round(r[4], 2) if r[4] else None}
        for r in cur.fetchall()
    ]

    # 최근 10경기 폼
    cur.execute("""
        SELECT e.date_ts,
               CASE WHEN mps.is_home=1 THEN e.away_team_id ELSE e.home_team_id END opp_id,
               mps.goals, mps.assists, mps.rating, mps.result, mps.is_home,
               e.home_score, e.away_score
        FROM match_player_stats mps JOIN events e ON mps.event_id=e.id
        WHERE mps.player_id=? AND e.tournament_id=? AND e.date_ts IS NOT NULL
        ORDER BY e.date_ts DESC LIMIT 10
    """, (player_id, tournament_id))
    recent_form = []
    for r in cur.fetchall():
        d = _dt.datetime.utcfromtimestamp(r[0])
        opp_name = _ko_name_by_ss_id(str(r[1])) or str(r[1])
        hs2, aws2, is_home2 = r[7], r[8], r[6]
        if hs2 is not None and aws2 is not None:
            my2, opp2 = (hs2, aws2) if is_home2 else (aws2, hs2)
            calc_result2 = "W" if my2 > opp2 else ("D" if my2 == opp2 else "L")
        else:
            calc_result2 = "?"
        recent_form.append({
            "date": f"{d.year}/{d.month}/{d.day}",
            "opponent": opp_name,
            "is_home": bool(r[6]),
            "goals": r[2] or 0,
            "assists": r[3] or 0,
            "rating": round(r[4], 1) if r[4] else None,
            "result": calc_result2,
            "score": f"{r[7]}-{r[8]}" if r[7] is not None else "?"
        })

    # 레이더: 소속 리그 전체 선수 대비 백분위 (5경기 이상, 300분 이상)
    cur.execute(f"""
        SELECT mps.player_id,
               SUM(mps.goals) + SUM(mps.assists)        AS ga,
               SUM(mps.minutes_played)                   AS mins,
               AVG(mps.accurate_passes_pct)              AS pass_pct,
               SUM(mps.tackles) + SUM(mps.interceptions) + SUM(mps.clearances) AS def_acts,
               SUM(mps.shots_on_target)                  AS sot,
               SUM(mps.total_shots)                      AS ts,
               SUM(mps.successful_dribbles)              AS sdr,
               SUM(mps.attempted_dribbles)               AS adr,
               COUNT(*)                                  AS games
        FROM match_player_stats mps JOIN events e ON mps.event_id=e.id
        WHERE e.tournament_id=? {year_clause}
        GROUP BY mps.player_id
        HAVING games >= 5 AND mins >= 300
    """, (tournament_id,) + yp)

    all_stats = {}
    for r in cur.fetchall():
        pid, ga, mins, pass_pct, def_acts, sot, ts, sdr, adr, games = r
        if not mins: continue
        all_stats[pid] = {
            "attack":   (ga or 0) / mins * 90,
            "passing":  pass_pct or 0,
            "defense":  (def_acts or 0) / mins * 90,
            "shooting": ((sot or 0) / ts) * 100 if ts and ts >= 3 else 0,
            "dribble":  ((sdr or 0) / adr) * 100 if adr and adr >= 3 else 0,
        }

    radar = {}
    if player_id in all_stats:
        p_vals = all_stats[player_id]
        n = len(all_stats)
        for axis in ["attack", "passing", "defense", "shooting", "dribble"]:
            vals = [v[axis] for v in all_stats.values()]
            below = sum(1 for v in vals if v < p_vals[axis])
            radar[axis] = round(below / n * 100)
    else:
        radar = {k: 0 for k in ["attack", "passing", "defense", "shooting", "dribble"]}

    # 활동량 지표 (proxy metrics)
    cur.execute(f"""
        SELECT mps.player_id,
               SUM(mps.touches)                                        AS touches,
               SUM(mps.duel_won) + SUM(mps.duel_lost)                 AS duels,
               SUM(mps.total_passes)                                   AS passes,
               SUM(mps.tackles) + SUM(mps.interceptions)              AS def_acts,
               SUM(mps.attempted_dribbles)                             AS dribbles,
               SUM(mps.minutes_played)                                 AS mins,
               COUNT(*)                                                AS games
        FROM match_player_stats mps JOIN events e ON mps.event_id=e.id
        WHERE e.tournament_id=? {year_clause}
        GROUP BY mps.player_id
        HAVING games >= 3 AND mins >= 150
    """, (tournament_id,) + yp)

    all_activity = {}
    for r in cur.fetchall():
        pid2, touches, duels, passes, def_acts2, dribbles, mins2, games2 = r
        if not mins2: continue
        all_activity[pid2] = {
            "touches_p90":  round((touches or 0) / mins2 * 90, 1),
            "duels_p90":    round((duels or 0)   / mins2 * 90, 1),
            "passes_p90":   round((passes or 0)  / mins2 * 90, 1),
            "def_p90":      round((def_acts2 or 0) / mins2 * 90, 1),
            "dribbles_p90": round((dribbles or 0) / mins2 * 90, 1),
        }

    def _activity_pct(axis, val):
        vals = [v[axis] for v in all_activity.values()]
        if not vals: return 0
        below = sum(1 for v in vals if v < val)
        return round(below / len(vals) * 100)

    p_act = all_activity.get(player_id, {})
    activity_score = 0
    activity_percentiles = {}
    if p_act:
        weights = {"touches_p90": 0.35, "duels_p90": 0.25,
                   "passes_p90": 0.20, "def_p90": 0.10, "dribbles_p90": 0.10}
        for axis, w in weights.items():
            pct = _activity_pct(axis, p_act.get(axis, 0))
            activity_percentiles[axis] = pct
            activity_score += pct * w
        activity_score = round(activity_score)

    # 리그 평균 (기준값)
    league_avg_act = {}
    if all_activity:
        for axis in ["touches_p90", "duels_p90", "passes_p90", "def_p90", "dribbles_p90"]:
            vals = [v[axis] for v in all_activity.values()]
            league_avg_act[axis] = round(sum(vals) / len(vals), 1) if vals else 0

    # 경기별 트렌드 (시간 오름차순)
    cur.execute(f"""
        SELECT e.date_ts,
               CASE WHEN mps.is_home=1 THEN e.away_team_id ELSE e.home_team_id END opp_id,
               mps.goals, mps.assists, mps.rating, mps.is_home,
               e.home_score, e.away_score,
               mps.shots_on_target, mps.key_passes,
               mps.tackles + mps.interceptions, mps.saves
        FROM match_player_stats mps JOIN events e ON mps.event_id=e.id
        WHERE mps.player_id=? AND e.tournament_id=? AND e.date_ts IS NOT NULL
              AND mps.minutes_played > 0 {year_clause}
        ORDER BY e.date_ts ASC
    """, (player_id, tournament_id) + yp)
    trend = []
    for r in cur.fetchall():
        d = _dt.datetime.utcfromtimestamp(r[0])
        opp_name = _ko_name_by_ss_id(str(r[1])) or str(r[1])
        hs, aws, is_home = r[6], r[7], r[5]
        if hs is not None and aws is not None:
            my_s, opp_s = (hs, aws) if is_home else (aws, hs)
            res = "W" if my_s > opp_s else ("D" if my_s == opp_s else "L")
            score = f"{my_s}-{opp_s}"
        else:
            res = "?"; score = "?"
        trend.append({
            "date":    f"{d.month}/{d.day}",
            "year":    d.year,
            "opp":     opp_name,
            "result":  res,
            "score":   score,
            "rating":  round(r[4], 2) if r[4] else None,
            "goals":   r[2] or 0,
            "assists": r[3] or 0,
            "sot":     r[8] or 0,
            "kp":      r[9] or 0,
            "def":     r[10] or 0,
            "saves":   r[11] or 0,
        })

    # 전체 집계 (헤더용)
    cur.execute(f"""
        SELECT COUNT(*), SUM(mps.goals), SUM(mps.assists), AVG(mps.rating), SUM(mps.minutes_played),
               SUM(mps.yellow_cards), SUM(mps.red_cards)
        FROM match_player_stats mps JOIN events e ON mps.event_id=e.id
        WHERE mps.player_id=? AND e.tournament_id=? {year_clause}
    """, (player_id, tournament_id) + yp)
    agg = cur.fetchone()
    conn.close()

    return jsonify({
        "info": {
            "name": name,
            "position": position or "?",
            "team": team_name,
            "height": height,
            "preferred_foot": preferred_foot,
            "games":   agg[0] or 0,
            "goals":   agg[1] or 0,
            "assists": agg[2] or 0,
            "rating":  round(agg[3], 2) if agg[3] else None,
            "minutes": agg[4] or 0,
            "yellow_cards": agg[5] or 0,
            "red_cards":    agg[6] or 0,
        },
        "league":          league_key,
        "available_years": available_years,
        "season_summary":  season_summary,
        "monthly":         monthly,
        "recent_form":     recent_form,
        "radar":           radar,
        "activity": {
            "score":        activity_score,
            "values":       p_act,
            "percentiles":  activity_percentiles,
            "league_avg":   league_avg_act,
        },
        "trend": trend,
    })


@app.route("/api/league-dashboard")
@cached_response(ttl=1800)
def get_league_dashboard():
    """K리그 전체 선수 인사이트 대시보드 (league=k1|k2, 기본 k2)"""
    year = request.args.get("year")   # None → 전체
    tournament_id = _league_tid(request.args.get("league"))
    if tournament_id is None:
        return jsonify({"error": "invalid league"}), 400

    db_path = DB_PATH
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    year_clause = "AND strftime('%Y', datetime(e.date_ts,'unixepoch','localtime'))=?" if year else ""
    yp = (year,) if year else ()

    # 사용 가능 연도
    cur.execute("""
        SELECT DISTINCT strftime('%Y', datetime(e.date_ts,'unixepoch','localtime')) yr
        FROM events e WHERE e.tournament_id=? AND e.date_ts IS NOT NULL ORDER BY yr
    """, (tournament_id,))
    available_years = [r[0] for r in cur.fetchall()]

    # ── 랭킹 공통 쿼리 ─────────────────────────────────────────
    base_sql = f"""
        SELECT mps.player_id,
               COALESCE(p.name_ko, mps.player_name, p.name) name,
               mps.position pos,
               mps.team_id,
               COUNT(*)                   games,
               SUM(mps.goals)             goals,
               SUM(mps.assists)           assists,
               AVG(mps.rating)            rating,
               SUM(mps.minutes_played)    minutes,
               SUM(mps.total_shots)       shots,
               SUM(mps.shots_on_target)   sot,
               SUM(mps.key_passes)        key_passes,
               SUM(mps.tackles)           tackles,
               SUM(mps.interceptions)     interceptions,
               SUM(mps.successful_dribbles) dribbles,
               SUM(mps.attempted_dribbles) dribbles_att,
               SUM(mps.duel_won)          duel_won,
               SUM(mps.duel_lost)         duel_lost,
               SUM(mps.yellow_cards)      yellows,
               SUM(mps.red_cards)         reds,
               SUM(mps.saves)             saves
        FROM match_player_stats mps
        JOIN events e ON mps.event_id=e.id
        LEFT JOIN players p ON mps.player_id=p.id
        WHERE e.tournament_id=? {year_clause}
        GROUP BY mps.player_id
        HAVING games >= 3
    """
    cur.execute(base_sql, (tournament_id,) + yp)
    rows = cur.fetchall()

    def row_to_dict(r):
        tid = r["team_id"]
        return {
            "id":       r["player_id"],
            "name":     r["name"] or "?",
            "pos":      r["pos"] or "?",
            "team":     _ko_name_by_ss_id(tid) or str(tid),
            "games":    r["games"],
            "goals":    r["goals"] or 0,
            "assists":  r["assists"] or 0,
            "rating":   round(r["rating"], 2) if r["rating"] else None,
            "minutes":  r["minutes"] or 0,
            "shots":    r["shots"] or 0,
            "sot":      r["sot"] or 0,
            "key_passes": r["key_passes"] or 0,
            "tackles":  r["tackles"] or 0,
            "interceptions": r["interceptions"] or 0,
            "dribbles": r["dribbles"] or 0,
            "dribbles_att": r["dribbles_att"] or 0,
            "duel_won":  r["duel_won"] or 0,
            "duel_lost": r["duel_lost"] or 0,
            "duel_pct":  round((r["duel_won"] or 0) / max((r["duel_won"] or 0) + (r["duel_lost"] or 0), 1) * 100, 1),
            "tackles_p90": round((r["tackles"] or 0) / max(r["minutes"] or 1, 1) * 90, 2),
            "ints_p90":    round((r["interceptions"] or 0) / max(r["minutes"] or 1, 1) * 90, 2),
            "yellows":  r["yellows"] or 0,
            "reds":     r["reds"] or 0,
            "saves":    r["saves"] or 0,
        }

    all_players = [row_to_dict(r) for r in rows]

    # 랭킹 TOP20
    top_scorers  = sorted(all_players, key=lambda x: (-x["goals"],  -(x["assists"]), x["name"]))[:20]
    top_assists  = sorted(all_players, key=lambda x: (-x["assists"], -(x["goals"]),  x["name"]))[:20]
    top_rated    = sorted(
        [p for p in all_players if p["rating"] and p["minutes"] >= 270],
        key=lambda x: -x["rating"]
    )[:20]
    top_dribbles = sorted(
        [p for p in all_players if p["dribbles"] > 0],
        key=lambda x: -x["dribbles"]
    )[:20]
    top_defenders = sorted(
        [p for p in all_players if p["pos"] in ("D", "M") and (p["duel_won"] + p["duel_lost"]) >= 10],
        key=lambda x: (-x["duel_pct"], -(x["tackles_p90"] + x["ints_p90"]))
    )[:20]

    # ── 포지션별 평균 스탯 ─────────────────────────────────────
    pos_map = {"G": "GK", "D": "DF", "M": "MF", "F": "FW"}
    pos_stats = {}
    for p in all_players:
        pos = pos_map.get(p["pos"], "기타")
        if pos == "기타": continue
        if pos not in pos_stats:
            pos_stats[pos] = {"goals":0,"assists":0,"rating_sum":0,"rating_cnt":0,
                              "tackles":0,"dribbles":0,"key_passes":0,"shots":0,"cnt":0}
        s = pos_stats[pos]
        s["cnt"] += 1
        mins = p["minutes"] or 1
        s["goals"]    += p["goals"] / mins * 90
        s["assists"]  += p["assists"] / mins * 90
        s["tackles"]  += p["tackles"] / mins * 90
        s["dribbles"] += p["dribbles"] / mins * 90
        s["key_passes"] += p["key_passes"] / mins * 90
        s["shots"]    += p["shots"] / mins * 90
        if p["rating"]:
            s["rating_sum"] += p["rating"]; s["rating_cnt"] += 1

    position_avg = {}
    for pos, s in pos_stats.items():
        n = s["cnt"] or 1
        position_avg[pos] = {
            "goals":     round(s["goals"]/n, 3),
            "assists":   round(s["assists"]/n, 3),
            "tackles":   round(s["tackles"]/n, 3),
            "dribbles":  round(s["dribbles"]/n, 3),
            "key_passes":round(s["key_passes"]/n, 3),
            "shots":     round(s["shots"]/n, 3),
            "rating":    round(s["rating_sum"]/s["rating_cnt"], 2) if s["rating_cnt"] else None,
            "count":     s["cnt"],
        }

    # ── 팀별 공격력 ────────────────────────────────────────────
    team_stats = {}
    for p in all_players:
        t = p["team"]
        if t not in team_stats:
            team_stats[t] = {"goals":0,"assists":0,"rating_sum":0,"rating_cnt":0,
                             "players":0,"minutes":0}
        s = team_stats[t]
        s["goals"]   += p["goals"]
        s["assists"] += p["assists"]
        s["players"] += 1
        s["minutes"] += p["minutes"]
        if p["rating"]: s["rating_sum"] += p["rating"]; s["rating_cnt"] += 1

    team_attack = [
        {"team": t, "goals": s["goals"], "assists": s["assists"],
         "rating": round(s["rating_sum"]/s["rating_cnt"],2) if s["rating_cnt"] else None,
         "players": s["players"]}
        for t, s in team_stats.items()
    ]
    team_attack.sort(key=lambda x: -x["goals"])

    # ── 월별 리그 트렌드 ───────────────────────────────────────
    cur.execute(f"""
        SELECT CAST(strftime('%m', datetime(e.date_ts,'unixepoch','localtime')) AS INTEGER) mn,
               SUM(mps.goals) goals,
               SUM(mps.assists) assists,
               AVG(mps.rating) rating,
               COUNT(DISTINCT e.id) games
        FROM match_player_stats mps
        JOIN events e ON mps.event_id=e.id
        WHERE e.tournament_id=? {year_clause}
        GROUP BY mn ORDER BY mn
    """, (tournament_id,) + yp)
    monthly_trend = [
        {"month": r[0], "goals": r[1] or 0, "assists": r[2] or 0,
         "rating": round(r[3],2) if r[3] else None, "games": r[4]}
        for r in cur.fetchall()
    ]

    # ── 평점 분포 (히스토그램 버킷) ───────────────────────────
    rating_buckets = {}
    for p in all_players:
        if not p["rating"]: continue
        bucket = f"{int(p['rating']*10)//5 * 5 / 10:.1f}"
        rating_buckets[bucket] = rating_buckets.get(bucket, 0) + 1
    rating_dist = [{"bucket": k, "count": v}
                   for k, v in sorted(rating_buckets.items(), key=lambda x: float(x[0]))]

    conn.close()
    return jsonify({
        "available_years": available_years,
        "top_scorers":     top_scorers,
        "top_assists":     top_assists,
        "top_rated":       top_rated,
        "top_dribbles":    top_dribbles,
        "top_defenders":   top_defenders,
        "position_avg":    position_avg,
        "team_attack":     team_attack,
        "monthly_trend":   monthly_trend,
        "rating_dist":     rating_dist,
    })


@app.route("/api/team-goal-timing")
@cached_response(ttl=3600)
def get_team_goal_timing():
    """팀 득점/실점 시간대·전후반 분석"""
    team_id_str = request.args.get("teamId")
    year        = request.args.get("year")
    team_info   = next((t for t in TEAMS if t["id"] == team_id_str), None)
    if not team_info:
        return jsonify({"error": "team not found"}), 404

    ss_id   = team_info["sofascore_id"]
    db_path = DB_PATH
    conn    = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cur     = conn.cursor()

    # goal_events 테이블 없으면 빈 데이터 반환
    cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='goal_events'")
    if not cur.fetchone():
        conn.close()
        return jsonify({"ready": False})

    year_clause = ""
    yp = ()
    if year:
        year_clause = "AND strftime('%Y', datetime(e.date_ts,'unixepoch','localtime'))=?"
        yp = (year,)

    # 시간대 구간
    BANDS = [(1,15),(16,30),(31,45),(46,60),(61,75),(76,90),(91,120)]
    BAND_LABELS = ["1-15'","16-30'","31-45'","46-60'","61-75'","76-90'","90+'"]

    def count_goals(for_or_against):
        """for_or_against: 'for' = 득점, 'against' = 실점"""
        if for_or_against == "for":
            team_cond = "g.team_id = ?"
        else:
            # 실점 = 상대팀이 우리 팀 경기에서 넣은 골 (team_id != ss_id)
            team_cond = "g.team_id != ? AND (e.home_team_id=? OR e.away_team_id=?)"

        results = []
        for (s, e_min), label in zip(BANDS, BAND_LABELS):
            if for_or_against == "for":
                cur.execute(f"""
                    SELECT COUNT(*) FROM goal_events g
                    JOIN events e ON g.event_id = e.id
                    WHERE {team_cond}
                      AND (e.home_team_id=? OR e.away_team_id=?)
                      AND (g.minute + COALESCE(g.added_time,0)) >= ?
                      AND (g.minute + COALESCE(g.added_time,0)) <= ?
                      {year_clause}
                """, (ss_id, ss_id, ss_id, s, e_min) + yp)
            else:
                cur.execute(f"""
                    SELECT COUNT(*) FROM goal_events g
                    JOIN events e ON g.event_id = e.id
                    WHERE {team_cond}
                      AND (g.minute + COALESCE(g.added_time,0)) >= ?
                      AND (g.minute + COALESCE(g.added_time,0)) <= ?
                      {year_clause}
                """, (ss_id, ss_id, ss_id, s, e_min) + yp)
            _cr = cur.fetchone()
            results.append({"label": label, "count": _cr[0] if _cr else 0})
        return results

    gf_bands = count_goals("for")
    ga_bands = count_goals("against")

    # 전후반 집계
    def half_sum(bands, half):
        idxs = range(0, 3) if half == 1 else range(3, len(bands))
        return sum(bands[i]["count"] for i in idxs)

    gf_h1 = half_sum(gf_bands, 1)
    gf_h2 = half_sum(gf_bands, 2)
    ga_h1 = half_sum(ga_bands, 1)
    ga_h2 = half_sum(ga_bands, 2)

    # 전체 경기 수 (비율 계산용)
    cur.execute(f"""
        SELECT COUNT(*) FROM events e
        WHERE tournament_id=777 AND (home_team_id=? OR away_team_id=?)
        {year_clause}
    """, (ss_id, ss_id) + yp)
    total_games = cur.fetchone()[0] or 1

    conn.close()
    return jsonify({
        "ready": True,
        "team": team_info["name"],
        "total_games": total_games,
        "gf_bands":  gf_bands,
        "ga_bands":  ga_bands,
        "half": {
            "gf_h1": gf_h1, "gf_h2": gf_h2,
            "ga_h1": ga_h1, "ga_h2": ga_h2,
        }
    })


LEAGUE_TOURNAMENT_ID = {"k1": 410, "k2": 777}


def _league_tid(league_raw):
    """쿼리 파라미터 league → tournament_id. 기본값 k2(777). 잘못된 값은 None."""
    key = (league_raw or "k2").strip().lower()
    return LEAGUE_TOURNAMENT_ID.get(key)


def _heatmap_teams_for_league(tournament_id):
    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute("""
        SELECT DISTINCT mps.team_id
        FROM match_player_stats mps
        JOIN events e ON mps.event_id = e.id
        WHERE e.tournament_id = ? AND mps.team_id != 7652
        ORDER BY mps.team_id
    """, (tournament_id,)).fetchall()
    conn.close()
    team_map = {t["sofascore_id"]: t for t in TEAMS}
    result = []
    for (tid,) in rows:
        t = team_map.get(tid)
        if t:
            result.append({"id": t["id"], "sofascore_id": tid, "name": t["name"],
                           "short": t["short"], "emblem": t["emblem"], "primary": t["primary"]})
    result.sort(key=lambda x: x["name"])
    return result


def _heatmap_players_for_team(team_id, tournament_id):
    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute("""
        SELECT mps.player_id,
               COALESCE(NULLIF(mps.player_name,''), p.name_ko, p.name) AS name,
               COALESCE(mps.position, p.position) AS pos,
               COUNT(DISTINCT mps.event_id) as games,
               ROUND(AVG(mps.rating), 2) as avg_rating
        FROM match_player_stats mps
        JOIN events e ON mps.event_id = e.id
        LEFT JOIN players p ON mps.player_id = p.id
        WHERE mps.team_id = ? AND e.tournament_id = ?
        GROUP BY mps.player_id
        HAVING name IS NOT NULL
        ORDER BY games DESC, name
    """, (team_id, tournament_id)).fetchall()
    conn.close()
    return [{
        "playerId": r[0], "name": r[1], "position": r[2],
        "games": r[3], "avgRating": r[4]
    } for r in rows]


def _heatmap_points_for_player(player_id, team_id, event_id, tournament_id):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    if event_id:
        rows = conn.execute("""
            SELECT h.x, h.y, e.away_team_id
            FROM heatmap_points h
            LEFT JOIN events e ON h.event_id = e.id
            WHERE h.player_id = ? AND h.event_id = ? AND e.tournament_id = ?
        """, (player_id, event_id, tournament_id)).fetchall()
    else:
        rows = conn.execute("""
            SELECT h.x, h.y, e.away_team_id
            FROM heatmap_points h
            LEFT JOIN events e ON h.event_id = e.id
            WHERE h.player_id = ? AND e.tournament_id = ?
        """, (player_id, tournament_id)).fetchall()

    points = _flip_points(rows, int(team_id))

    matches_rows = conn.execute("""
        SELECT DISTINCT e.id, e.home_team_id, e.home_team_name,
               e.away_team_id, e.away_team_name,
               e.home_score, e.away_score, e.date_ts
        FROM heatmap_points h
        JOIN events e ON h.event_id = e.id
        WHERE h.player_id = ? AND e.tournament_id = ? AND e.date_ts IS NOT NULL
        ORDER BY e.date_ts DESC
    """, (player_id, tournament_id)).fetchall()

    matches = [{
        "id":        r["id"],
        "home":      _ko_team(r["home_team_id"], r["home_team_name"]),
        "away":      _ko_team(r["away_team_id"], r["away_team_name"]),
        "homeScore": r["home_score"],
        "awayScore": r["away_score"],
        "datets":    r["date_ts"],
        "isAway":    r["away_team_id"] == int(team_id),
    } for r in matches_rows]

    conn.close()
    return {"points": points, "matches": matches, "playerId": player_id}


@app.route("/api/kleague2/teams")
def get_kleague2_teams():
    """히트맵 데이터가 있는 K리그2 팀 목록 (수원 삼성 제외)"""
    if not os.path.exists(DB_PATH):
        return jsonify([])
    return jsonify(_heatmap_teams_for_league(LEAGUE_TOURNAMENT_ID["k2"]))


@app.route("/api/kleague1/teams")
def get_kleague1_teams():
    """히트맵 데이터가 있는 K리그1 팀 목록"""
    if not os.path.exists(DB_PATH):
        return jsonify([])
    return jsonify(_heatmap_teams_for_league(LEAGUE_TOURNAMENT_ID["k1"]))


@app.route("/api/kleague2/players")
def get_kleague2_players():
    """K리그2 팀별 선수 목록 (player_id + 이름)"""
    team_id = request.args.get("teamId", "").strip()
    if not team_id:
        return jsonify({"error": "teamId required"}), 400
    if not os.path.exists(DB_PATH):
        return jsonify([])
    return jsonify(_heatmap_players_for_team(team_id, LEAGUE_TOURNAMENT_ID["k2"]))


@app.route("/api/kleague1/players")
def get_kleague1_players():
    """K리그1 팀별 선수 목록 (player_id + 이름)"""
    team_id = request.args.get("teamId", "").strip()
    if not team_id:
        return jsonify({"error": "teamId required"}), 400
    if not os.path.exists(DB_PATH):
        return jsonify([])
    return jsonify(_heatmap_players_for_team(team_id, LEAGUE_TOURNAMENT_ID["k1"]))


@app.route("/api/kleague2/heatmap")
def get_kleague2_heatmap():
    """K리그2 선수 ID 기반 히트맵"""
    player_id = request.args.get("playerId", "").strip()
    team_id   = request.args.get("teamId", "").strip()
    event_id  = request.args.get("eventId", "").strip()
    if not player_id or not team_id:
        return jsonify({"error": "playerId and teamId required"}), 400
    if not os.path.exists(DB_PATH):
        return jsonify({"points": []})
    return jsonify(_heatmap_points_for_player(player_id, team_id, event_id, LEAGUE_TOURNAMENT_ID["k2"]))


@app.route("/api/kleague1/heatmap")
def get_kleague1_heatmap():
    """K리그1 선수 ID 기반 히트맵"""
    player_id = request.args.get("playerId", "").strip()
    team_id   = request.args.get("teamId", "").strip()
    event_id  = request.args.get("eventId", "").strip()
    if not player_id or not team_id:
        return jsonify({"error": "playerId and teamId required"}), 400
    if not os.path.exists(DB_PATH):
        return jsonify({"points": []})
    return jsonify(_heatmap_points_for_player(player_id, team_id, event_id, LEAGUE_TOURNAMENT_ID["k1"]))


# ── 포지션 인사이트 API ──────────────────────────────────

def _year_date_params(year):
    """year 파라미터를 안전한 SQL 조건절 + 바인딩 파라미터로 변환한다.
    반환: (sql_condition_string, params_tuple)
    - year == "all" -> ("", ())
    - year == "2026" -> ("AND match_date >= ? AND match_date < ?", ("2026-01-01", "2027-01-01"))
    """
    if not year or year == "all":
        return "", ()
    try:
        y = int(year)
    except (ValueError, TypeError):
        return "", ()
    return "AND match_date >= ? AND match_date < ?", (f"{y}-01-01", f"{y+1}-01-01")

def _league_team_filter(league):
    """league('k1'|'k2'|'all') → ('AND m.team_id IN (...)', ()) tuple. all이면 빈 필터."""
    league = (league or "all").lower()
    if league not in ("k1", "k2"):
        return "", ()
    label = "K1" if league == "k1" else "K2"
    ids = [t["sofascore_id"] for t in TEAMS if t.get("league") == label]
    if not ids:
        return "", ()
    placeholders = ",".join("?" * len(ids))
    return f"AND m.team_id IN ({placeholders})", tuple(ids)


@app.route("/api/insights/top-performers")
@cached_response(ttl=1800)
def insights_top_performers():
    """포지션별 TOP 퍼포머 (최소 3경기 이상, 90분 환산). league=k1|k2|all 필터 지원"""
    year = request.args.get("year", "2026")
    league = request.args.get("league", "all")
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    date_cond, date_params = _year_date_params(year)
    league_cond, league_params = _league_team_filter(league)

    def pinfo(r):
        return {
            "player_id": r["player_id"],
            "name": r["name_ko"] or r["player_name"] or "",
            "team": _ko_team(r["team_id"], ""),
            "games": r["games"], "mins": r["mins"],
        }

    result = {}

    rows = conn.execute(f"""
        SELECT m.player_id, COALESCE(p.name_ko, m.player_name, p.name) as name_ko, m.player_name, m.team_id,
               COUNT(*) as games, SUM(m.minutes_played) as mins,
               SUM(m.goals) as goals, SUM(COALESCE(m.expected_goals,0)) as xg,
               AVG(m.rating) as avg_rating,
               (SELECT COUNT(*) FROM goal_events g
                WHERE g.player_id=m.player_id AND g.is_penalty=1 AND g.is_own_goal=0
                AND g.event_id IN (
                    SELECT event_id FROM match_player_stats
                    WHERE player_id=m.player_id {date_cond})) as pk_goals
        FROM match_player_stats m LEFT JOIN players p ON m.player_id=p.id
        WHERE m.position='F' AND m.minutes_played>0 {date_cond} {league_cond}
        GROUP BY m.player_id HAVING games>=3 AND mins>=90
        ORDER BY goals DESC LIMIT 30
    """, date_params + date_params + league_params).fetchall()
    result["F"] = [{**pinfo(r),
        "goals": r["goals"] or 0,
        "pk_goals": r["pk_goals"] or 0,
        "np_goals": (r["goals"] or 0) - (r["pk_goals"] or 0),
        "goals_p90": round((r["goals"] or 0) / r["mins"] * 90, 2),
        "np_goals_p90": round(((r["goals"] or 0) - (r["pk_goals"] or 0)) / r["mins"] * 90, 2),
        "xg": round(r["xg"] or 0, 2),
        "xg_eff": round((r["goals"] or 0) / r["xg"], 2) if (r["xg"] or 0) > 0 else None,
        "rating": round(r["avg_rating"], 2) if r["avg_rating"] else None,
    } for r in rows]

    rows = conn.execute(f"""
        SELECT m.player_id, COALESCE(p.name_ko, m.player_name, p.name) as name_ko, m.player_name, m.team_id,
               COUNT(*) as games, SUM(m.minutes_played) as mins,
               SUM(m.total_passes) as tp, SUM(m.accurate_passes) as ap,
               SUM(m.tackles) as tkl, AVG(m.rating) as avg_rating
        FROM match_player_stats m LEFT JOIN players p ON m.player_id=p.id
        WHERE m.position='M' AND m.minutes_played>0 {date_cond} {league_cond}
        GROUP BY m.player_id HAVING games>=3 AND mins>=90 AND tp>0
        ORDER BY (CAST(ap AS REAL)/tp) DESC LIMIT 30
    """, date_params + league_params).fetchall()
    result["M"] = [{**pinfo(r),
        "pass_acc": round((r["ap"] or 0) / r["tp"] * 100, 1) if r["tp"] else None,
        "passes_p90": round((r["tp"] or 0) / r["mins"] * 90, 1),
        "tackles_p90": round((r["tkl"] or 0) / r["mins"] * 90, 2),
        "rating": round(r["avg_rating"], 2) if r["avg_rating"] else None,
    } for r in rows]

    rows = conn.execute(f"""
        SELECT m.player_id, COALESCE(p.name_ko, m.player_name, p.name) as name_ko, m.player_name, m.team_id,
               COUNT(*) as games, SUM(m.minutes_played) as mins,
               SUM(m.tackles) as tkl, SUM(COALESCE(m.interceptions,0)) as intc,
               SUM(m.clearances) as clr, SUM(m.aerial_won) as aer,
               SUM(m.duel_won) as duel, AVG(m.rating) as avg_rating
        FROM match_player_stats m LEFT JOIN players p ON m.player_id=p.id
        WHERE m.position='D' AND m.minutes_played>0 {date_cond} {league_cond}
        GROUP BY m.player_id HAVING games>=3 AND mins>=90
        ORDER BY (tkl + intc*1.5 + clr + aer + duel) / mins DESC LIMIT 30
    """, date_params + league_params).fetchall()
    result["D"] = [{**pinfo(r),
        "def_score_p90": round(
            ((r["tkl"] or 0) + (r["intc"] or 0)*1.5 + (r["clr"] or 0)
             + (r["aer"] or 0) + (r["duel"] or 0)) / r["mins"] * 90, 2),
        "tackles_p90": round((r["tkl"] or 0) / r["mins"] * 90, 2),
        "clearances_p90": round((r["clr"] or 0) / r["mins"] * 90, 2),
        "rating": round(r["avg_rating"], 2) if r["avg_rating"] else None,
    } for r in rows]

    conn.close()
    return jsonify(result)


@app.route("/api/insights/card-rankings")
@cached_response(ttl=1800)
def insights_card_rankings():
    """카드 수령 순위 — 선수별 + 팀별. year + league 필터 지원.
    옐로카드 TOP 10 + 레드카드 TOP 5 (선수별), 팀별 평균(/경기) TOP 8."""
    year   = request.args.get("year", "2026")
    league = request.args.get("league", "all")
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    date_cond, date_params = _year_date_params(year)
    league_cond, league_params = _league_team_filter(league)

    # card_events엔 date 컬럼 없으니 events 조인. year 필터는 e.date_ts 기준.
    ts_cond = ""
    ts_params: tuple = ()
    if year and year != "all":
        try:
            y = int(year)
            ts_cond = "AND e.date_ts >= strftime('%s', ?) AND e.date_ts < strftime('%s', ?)"
            ts_params = (f"{y}-01-01", f"{y+1}-01-01")
        except (ValueError, TypeError):
            pass
    ce_league_cond = league_cond.replace("m.team_id", "c.team_id")

    # 선수별 옐로 TOP 10
    yellow_rows = conn.execute(f"""
        SELECT c.player_id,
               COALESCE(p.name_ko, c.player_name, p.name) AS name,
               c.team_id,
               COUNT(DISTINCT c.event_id) AS games,
               SUM(CASE WHEN c.card_type IN ('yellow','yellowRed') THEN 1 ELSE 0 END) AS yc,
               SUM(CASE WHEN c.card_type IN ('red','yellowRed') THEN 1 ELSE 0 END) AS rc
        FROM card_events c
        JOIN events e ON c.event_id = e.id
        LEFT JOIN players p ON c.player_id = p.id
        WHERE c.player_id IS NOT NULL {ts_cond} {ce_league_cond}
        GROUP BY c.player_id HAVING yc >= 1
        ORDER BY yc DESC, rc DESC LIMIT 10
    """, ts_params + league_params).fetchall()

    # 선수별 레드 TOP 5
    red_rows = conn.execute(f"""
        SELECT c.player_id,
               COALESCE(p.name_ko, c.player_name, p.name) AS name,
               c.team_id,
               COUNT(DISTINCT c.event_id) AS games,
               SUM(CASE WHEN c.card_type IN ('yellow','yellowRed') THEN 1 ELSE 0 END) AS yc,
               SUM(CASE WHEN c.card_type IN ('red','yellowRed') THEN 1 ELSE 0 END) AS rc
        FROM card_events c
        JOIN events e ON c.event_id = e.id
        LEFT JOIN players p ON c.player_id = p.id
        WHERE c.player_id IS NOT NULL {ts_cond} {ce_league_cond}
        GROUP BY c.player_id HAVING rc >= 1
        ORDER BY rc DESC, yc DESC LIMIT 5
    """, ts_params + league_params).fetchall()

    # 팀별 — 카드 합계 / 시즌 경기수
    # events 기준 LEFT JOIN: 카드 0장 경기도 games에 포함, 시즌 카드 0회 팀도 결과에 포함.
    # league 필터는 t.id IN (...) 형태로 변환 (TEAMS 마스터 기반).
    team_league_cond = league_cond.replace("m.team_id", "t.id")
    team_league_params = league_params
    if league == "all":
        # K3/컵 매치 혼입 방지 — K1+K2 팀만
        kk_ids = [t["sofascore_id"] for t in TEAMS if t.get("league") in ("K1", "K2")]
        ph = ",".join("?" * len(kk_ids))
        team_league_cond = f"AND t.id IN ({ph})"
        team_league_params = tuple(kk_ids)
    # LIMIT 동적: K1=12, K2=17, all=29 (전체 노출)
    team_limit = {"k1": 12, "k2": 17}.get(league, 29)
    e_ts_cond = ts_cond  # e.date_ts 기준 (이미 e.* 참조)
    # synthetic event(SofaScore 미매칭, 9자리 ID) 제외 — 정규 매치 ID는 8자리 1500만대
    team_rows = conn.execute(f"""
        SELECT t.id AS team_id,
               COUNT(DISTINCT e.id) AS games,
               COALESCE(SUM(CASE WHEN c.card_type IN ('yellow','yellowRed') THEN 1 ELSE 0 END), 0) AS yc,
               COALESCE(SUM(CASE WHEN c.card_type IN ('red','yellowRed') THEN 1 ELSE 0 END), 0) AS rc
        FROM teams t
        JOIN events e ON (e.home_team_id = t.id OR e.away_team_id = t.id)
        LEFT JOIN card_events c ON c.event_id = e.id AND c.team_id = t.id
        WHERE e.home_score IS NOT NULL
          AND e.id < 50000000
          {e_ts_cond} {team_league_cond}
        GROUP BY t.id
        HAVING games >= 1
        ORDER BY (CAST(yc + rc * 2 AS REAL) / games) DESC, yc DESC, rc DESC
        LIMIT ?
    """, ts_params + team_league_params + (team_limit,)).fetchall()

    def player_row(r):
        games = r["games"] or 1
        return {
            "player_id":  r["player_id"],
            "name":       r["name"] or "",
            "team":       _ko_team(r["team_id"], ""),
            "games":      r["games"],
            "yellow":     r["yc"] or 0,
            "red":        r["rc"] or 0,
            "yc_per_g":   round((r["yc"] or 0) / games, 2),
        }

    def team_row(r):
        g = r["games"] or 1
        yc = r["yc"] or 0
        rc = r["rc"] or 0
        return {
            "team":      _ko_team(r["team_id"], "") or str(r["team_id"]),
            "team_id":   r["team_id"],
            "games":     g,
            "yellow":    yc,
            "red":       rc,
            "yc_per_g":  round(yc / g, 2),
            "rc_per_g":  round(rc / g, 3),
            "score":     round((yc + rc * 2.0) / g, 2),
        }

    conn.close()
    return jsonify({
        "year":   year,
        "league": league,
        "yellow_top": [player_row(r) for r in yellow_rows],
        "red_top":    [player_row(r) for r in red_rows],
        "team_top":   [team_row(r)   for r in team_rows],
    })


@app.route("/api/insights/xg-efficiency")
@cached_response(ttl=1800)
def insights_xg_efficiency():
    """xG 효율 — 포지션 F + minutes>0 + 시즌 ≥3경기 + xG ≥0.5.
    league(all|k1|k2) 필터, 정렬은 클라가 처리(절대 골/효율 등)."""
    year = request.args.get("year", "2026")
    league = request.args.get("league", "all")
    date_cond, date_params = _year_date_params(year)
    league_cond, league_params = _league_team_filter(league)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(f"""
        SELECT m.player_id, COALESCE(p.name_ko, m.player_name, p.name) as name_ko, m.team_id,
               COUNT(*) as games, SUM(m.goals) as goals,
               SUM(COALESCE(m.expected_goals,0)) as xg, SUM(m.total_shots) as shots,
               (SELECT COUNT(*) FROM goal_events g
                WHERE g.player_id=m.player_id AND g.is_penalty=1 AND g.is_own_goal=0
                AND g.event_id IN (
                    SELECT event_id FROM match_player_stats
                    WHERE player_id=m.player_id {date_cond})) as pk_goals
        FROM match_player_stats m LEFT JOIN players p ON m.player_id=p.id
        WHERE m.position='F' AND m.minutes_played>0 {date_cond} {league_cond}
        GROUP BY m.player_id HAVING games>=3 AND xg>0.5
        ORDER BY (SUM(m.goals) - SUM(COALESCE(m.expected_goals,0))) DESC
        LIMIT 20
    """, date_params * 2 + league_params).fetchall()
    conn.close()
    return jsonify([{
        "player_id": r["player_id"],
        "name": r["name_ko"] or "",
        "team": _ko_team(r["team_id"], ""),
        "games": r["games"],
        "goals": r["goals"] or 0,
        "pk_goals": r["pk_goals"] or 0,
        "np_goals": (r["goals"] or 0) - (r["pk_goals"] or 0),
        "xg": round(r["xg"], 2),
        "diff": round((r["goals"] or 0) - r["xg"], 2),
        "shots": r["shots"] or 0,
    } for r in rows])


@app.route("/api/insights/forward-goals")
@cached_response(ttl=1800)
def insights_forward_goals():
    player_id = request.args.get("playerId", "").strip()
    year = request.args.get("year", "all")

    if not player_id:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        date_cond, date_params = _year_date_params(year)
        rows = conn.execute(f"""
            SELECT m.player_id, COALESCE(p.name_ko, m.player_name, p.name) as name_ko, m.team_id,
                   SUM(m.goals) as total_goals,
                   (SELECT COUNT(*) FROM goal_events g
                    WHERE g.player_id=m.player_id AND g.is_penalty=1 AND g.is_own_goal=0
                    AND g.event_id IN (
                        SELECT event_id FROM match_player_stats
                        WHERE player_id=m.player_id {date_cond})) as pk_goals
            FROM match_player_stats m LEFT JOIN players p ON m.player_id=p.id
            WHERE m.position='F' AND m.minutes_played>0 AND m.goals>0 {date_cond}
            GROUP BY m.player_id ORDER BY total_goals DESC LIMIT 30
        """, date_params * 2).fetchall()
        conn.close()
        return jsonify([{
            "player_id": r["player_id"],
            "name": r["name_ko"] or "",
            "team": _ko_team(r["team_id"], ""),
            "goals": r["total_goals"],
            "pk_goals": r["pk_goals"] or 0,
            "np_goals": (r["total_goals"] or 0) - (r["pk_goals"] or 0),
        } for r in rows])

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    bands = [("1-15",1,15),("16-30",16,30),("31-45",31,45),
             ("46-60",46,60),("61-75",61,75),("76-90",76,120)]
    time_data = []
    for label, lo, hi in bands:
        row = conn.execute("""
            SELECT COUNT(*) as cnt FROM goal_events
            WHERE player_id=? AND minute>=? AND minute<=? AND is_own_goal=0
        """, (player_id, lo, hi)).fetchone()
        time_data.append({"band": label, "goals": row["cnt"]})

    opp_rows = conn.execute("""
        SELECT CASE WHEN g.is_home=1 THEN e.away_team_id ELSE e.home_team_id END as opp_id,
               CASE WHEN g.is_home=1 THEN e.away_team_name ELSE e.home_team_name END as opp_name,
               COUNT(*) as goals
        FROM goal_events g JOIN events e ON g.event_id = e.id
        WHERE g.player_id=? AND g.is_own_goal=0
        GROUP BY opp_id ORDER BY goals DESC
    """, (player_id,)).fetchall()

    info = conn.execute("""
        SELECT COALESCE(p.name_ko, m.player_name, p.name) as name_ko, m.team_id
        FROM match_player_stats m LEFT JOIN players p ON m.player_id=p.id
        WHERE m.player_id=? AND m.player_name IS NOT NULL LIMIT 1
    """, (player_id,)).fetchone()
    conn.close()

    return jsonify({
        "player_id": int(player_id),
        "name": info["name_ko"] if info else "",
        "team": _ko_team(info["team_id"], "") if info else "",
        "time_bands": time_data,
        "by_opponent": [
            {"opponent": _ko_team(r["opp_id"], r["opp_name"]), "goals": r["goals"]}
            for r in opp_rows
        ],
    })


@app.route("/api/insights/midfielder-pass")
@cached_response(ttl=1800)
def insights_midfielder_pass():
    year = request.args.get("year", "2026")
    date_cond, date_params = _year_date_params(year)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(f"""
        SELECT m.player_id, COALESCE(p.name_ko, m.player_name, p.name) as name_ko, m.team_id,
               COUNT(*) as games, SUM(m.minutes_played) as mins,
               SUM(m.total_passes) as tp, SUM(m.accurate_passes) as ap,
               AVG(m.rating) as avg_rating
        FROM match_player_stats m LEFT JOIN players p ON m.player_id=p.id
        WHERE m.position='M' AND m.minutes_played>0 {date_cond}
        GROUP BY m.player_id HAVING games>=3 AND tp>=50
        ORDER BY (CAST(ap AS REAL)/tp) DESC LIMIT 25
    """, date_params).fetchall()
    conn.close()
    return jsonify([{
        "player_id": r["player_id"],
        "name": r["name_ko"] or "",
        "team": _ko_team(r["team_id"], ""),
        "games": r["games"], "mins": r["mins"],
        "total_passes": r["tp"] or 0, "accurate_passes": r["ap"] or 0,
        "pass_acc": round((r["ap"] or 0) / r["tp"] * 100, 1) if r["tp"] else 0,
        "passes_p90": round((r["tp"] or 0) / r["mins"] * 90, 1) if r["mins"] else 0,
        "rating": round(r["avg_rating"], 2) if r["avg_rating"] else None,
    } for r in rows])


@app.route("/api/insights/defender-score")
@cached_response(ttl=1800)
def insights_defender_score():
    year = request.args.get("year", "2026")
    date_cond, date_params = _year_date_params(year)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(f"""
        SELECT m.player_id, COALESCE(p.name_ko, m.player_name, p.name) as name_ko, m.team_id,
               COUNT(*) as games, SUM(m.minutes_played) as mins,
               SUM(m.tackles) as tkl, SUM(COALESCE(m.interceptions,0)) as intc,
               SUM(m.clearances) as clr, SUM(m.aerial_won) as aer,
               SUM(m.duel_won) as duel, AVG(m.rating) as avg_rating
        FROM match_player_stats m LEFT JOIN players p ON m.player_id=p.id
        WHERE m.position='D' AND m.minutes_played>0 {date_cond}
        GROUP BY m.player_id HAVING games>=3 AND mins>=90
        ORDER BY (tkl + intc*1.5 + clr + aer + duel) / mins DESC LIMIT 25
    """, date_params).fetchall()
    conn.close()
    return jsonify([{
        "player_id": r["player_id"],
        "name": r["name_ko"] or "",
        "team": _ko_team(r["team_id"], ""),
        "games": r["games"], "mins": r["mins"],
        "tackles": r["tkl"] or 0, "interceptions": r["intc"] or 0,
        "clearances": r["clr"] or 0, "aerial_won": r["aer"] or 0,
        "duel_won": r["duel"] or 0,
        "def_score": round(
            ((r["tkl"] or 0) + (r["intc"] or 0)*1.5 + (r["clr"] or 0)
             + (r["aer"] or 0) + (r["duel"] or 0)) / r["mins"] * 90, 2),
        "rating": round(r["avg_rating"], 2) if r["avg_rating"] else None,
    } for r in rows])


@app.route("/api/insights/player-detail")
@cached_response(ttl=1800)
def insights_player_detail():
    player_id = request.args.get("playerId", "").strip()
    pos       = request.args.get("pos", "F")
    year      = request.args.get("year", "2026")
    if not player_id:
        return jsonify({"error": "playerId required"}), 400

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    # 기본 정보
    info = conn.execute("""
        SELECT COALESCE(p.name_ko, m.player_name, p.name) as name_ko, m.player_name, m.team_id, m.position
        FROM match_player_stats m LEFT JOIN players p ON m.player_id = p.id
        WHERE m.player_id = ? LIMIT 1
    """, (player_id,)).fetchone()

    if not info:
        conn.close()
        return jsonify({"error": "not found"}), 404

    # year 필터 (m.match_date 기준)
    year_cond = ""
    year_params: tuple = ()
    if year and year != "all":
        try:
            y = int(year)
            year_cond = "AND m.match_date >= ? AND m.match_date < ?"
            year_params = (f"{y}-01-01", f"{y+1}-01-01")
        except (ValueError, TypeError):
            year = "all"

    # 사용 가능한 시즌 목록 (UI 필터 옵션용)
    seasons = conn.execute("""
        SELECT DISTINCT substr(match_date, 1, 4) AS yr
        FROM match_player_stats
        WHERE player_id = ? AND minutes_played > 0 AND match_date IS NOT NULL
        ORDER BY yr DESC
    """, (player_id,)).fetchall()
    season_list = [r["yr"] for r in seasons if r["yr"]]

    # 경기별 스탯 (최신순, 최대 30경기, year 필터)
    rows = conn.execute(f"""
        SELECT m.match_date,
               e.home_team_id, e.away_team_id, e.home_team_name, e.away_team_name,
               e.home_score, e.away_score, m.is_home,
               m.minutes_played, m.rating,
               m.goals, COALESCE(m.expected_goals, 0) as xg,
               m.total_passes, m.accurate_passes, m.accurate_passes_pct,
               m.key_passes, m.assists,
               m.tackles, COALESCE(m.interceptions, 0) as interceptions,
               m.clearances, m.aerial_won, m.duel_won,
               m.total_shots, m.shots_on_target
        FROM match_player_stats m
        JOIN events e ON m.event_id = e.id
        WHERE m.player_id = ? AND m.minutes_played > 0 {year_cond}
        ORDER BY m.match_date DESC LIMIT 30
    """, (player_id,) + year_params).fetchall()

    matches = []
    for r in rows:
        opp_id   = r["away_team_id"] if r["is_home"] else r["home_team_id"]
        opp_name = r["away_team_name"] if r["is_home"] else r["home_team_name"]
        score    = f"{r['home_score']}-{r['away_score']}"
        def_score = round(
            ((r["tackles"] or 0) + (r["interceptions"] or 0)*1.5
             + (r["clearances"] or 0) + (r["aerial_won"] or 0) + (r["duel_won"] or 0))
            / r["minutes_played"] * 90, 2
        ) if r["minutes_played"] else 0
        matches.append({
            "date":       r["match_date"],
            "opponent":   _ko_team(opp_id, opp_name),
            "score":      score,
            "is_home":    bool(r["is_home"]),
            "mins":       r["minutes_played"],
            "rating":     round(r["rating"], 2) if r["rating"] else None,
            "goals":      r["goals"] or 0,
            "xg":         round(r["xg"], 2),
            "assists":    r["assists"] or 0,
            "pass_acc":   round(r["accurate_passes_pct"], 1) if r["accurate_passes_pct"] else None,
            "key_passes": r["key_passes"] or 0,
            "tackles":    r["tackles"] or 0,
            "def_score":  def_score,
            "shots":      r["total_shots"] or 0,
        })

    # 포지션 평균 (비교용) — year 일치
    avg = conn.execute(f"""
        SELECT ROUND(AVG(rating), 2) as avg_rating,
               ROUND(AVG(goals), 2) as avg_goals,
               ROUND(AVG(COALESCE(expected_goals,0)), 2) as avg_xg,
               ROUND(AVG(CAST(accurate_passes AS REAL)/NULLIF(total_passes,0)*100), 1) as avg_pass_acc,
               ROUND(AVG(tackles), 2) as avg_tackles
        FROM match_player_stats m
        WHERE position = ? AND minutes_played >= 45 {year_cond}
    """, (pos,) + year_params).fetchone()

    # 본인 시즌 요약 (KPI) — 평균/합계
    own = conn.execute(f"""
        SELECT COUNT(*) as games,
               SUM(minutes_played) as mins,
               ROUND(AVG(rating), 2) as avg_rating,
               SUM(goals) as goals,
               ROUND(SUM(COALESCE(expected_goals,0)), 2) as xg_sum,
               SUM(assists) as assists,
               SUM(key_passes) as key_passes,
               SUM(tackles) as tackles,
               ROUND(AVG(CAST(accurate_passes AS REAL)/NULLIF(total_passes,0)*100), 1) as pass_acc_avg
        FROM match_player_stats m
        WHERE player_id = ? AND minutes_played > 0 {year_cond}
    """, (player_id,) + year_params).fetchone()

    conn.close()
    return jsonify({
        "player_id": int(player_id),
        "name":  info["name_ko"] or info["player_name"] or "",
        "team":  _ko_team(info["team_id"], ""),
        "pos":   pos,
        "year":  year,
        "seasons": season_list,
        "matches": matches,
        "pos_avg": {
            "rating":   avg["avg_rating"],
            "goals":    avg["avg_goals"],
            "xg":       avg["avg_xg"],
            "pass_acc": avg["avg_pass_acc"],
            "tackles":  avg["avg_tackles"],
        },
        "own_summary": {
            "games":        own["games"] or 0,
            "mins":         own["mins"] or 0,
            "avg_rating":   own["avg_rating"],
            "goals":        own["goals"] or 0,
            "xg":           own["xg_sum"] or 0,
            "assists":      own["assists"] or 0,
            "key_passes":   own["key_passes"] or 0,
            "tackles":      own["tackles"] or 0,
            "pass_acc":     own["pass_acc_avg"],
        },
    })


# ── K리그2 다음 경기 일정 ─────────────────────────────────
KLEAGUE_TEAM_CODE = {
    # K2
    "K02": "suwon",   "K06": "busan",   "K07": "jeonnam", "K08": "seongnam",
    "K17": "daegu",   "K20": "gyeongnam","K29": "suwon_fc","K31": "seouland",
    "K32": "ansan",   "K34": "asan",    "K36": "gimpo",   "K37": "cheongju",
    "K38": "cheonan", "K39": "hwaseong","K40": "paju",    "K41": "gimhae",
    "K42": "yongin",
    # K1
    "K01": "ulsan",   "K03": "pohang",  "K04": "jeju",    "K05": "jeonbuk",
    "K09": "fcseoul", "K10": "daejeon", "K18": "incheon", "K21": "gangwon",
    "K22": "gwangju", "K26": "bucheon", "K27": "anyang",  "K35": "gimcheon",
}

def _fetch_k2_all_games(year=None):
    """K리그 공식 API에서 K2 전체 경기(완료+예정) 수집 — 1~12월"""
    import urllib.request, datetime
    url = "https://www.kleague.com/getScheduleList.do"
    if year is None:
        year = datetime.datetime.now().year
    games = []
    # 시즌 전체 12개월 fetch — 라운드 일정 전체 확보 (R1~R38 등)
    for m in range(1, 13):
        payload = json.dumps({"leagueId": "2", "year": str(year), "month": str(m).zfill(2)}).encode("utf-8")
        req = urllib.request.Request(url, data=payload,
            headers={"Content-Type": "application/json; charset=UTF-8", "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=8) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                games += data.get("data", {}).get("scheduleList", [])
        except Exception:
            pass
    return games

def _parse_k2_game(g):
    """K리그 API 경기 dict → 통일 포맷"""
    home_code = g.get("homeTeam", "")
    away_code = g.get("awayTeam", "")
    home_id   = KLEAGUE_TEAM_CODE.get(home_code)
    away_id   = KLEAGUE_TEAM_CODE.get(away_code)
    home_info = next((t for t in TEAMS if t["id"] == home_id), None)
    away_info = next((t for t in TEAMS if t["id"] == away_id), None)
    finished  = g.get("endYn") == "Y" or g.get("gameStatus") == "FE"
    return {
        "date":       g.get("gameDate", ""),
        "time":       g.get("gameTime", ""),
        "round":      g.get("roundId"),
        "home_code":  home_code,
        "away_code":  away_code,
        "home_id":    home_id,
        "away_id":    away_id,
        "home_name":  home_info["name"]  if home_info else g.get("homeTeamName", home_code),
        "away_name":  away_info["name"]  if away_info else g.get("awayTeamName", away_code),
        "home_short": home_info["short"] if home_info else g.get("homeTeamName", home_code),
        "away_short": away_info["short"] if away_info else g.get("awayTeamName", away_code),
        "venue":      g.get("fieldName", ""),
        "finished":   finished,
        "home_score": g.get("homeGoal") if finished else None,
        "away_score": g.get("awayGoal") if finished else None,
    }

@app.route("/api/k2/schedule")
@cached_response(ttl=600)  # 10분 (스케줄은 거의 안 바뀜)
def get_k2_schedule():
    """K2 예정 경기 + 팀별 다음 경기"""
    import datetime
    now_str = datetime.datetime.now().strftime("%Y.%m.%d")
    try:
        raw = _fetch_k2_all_games()
    except Exception:
        return jsonify({"upcoming": [], "next_by_team": {}}), 200

    upcoming = []
    for g in raw:
        if g.get("endYn") == "Y" or g.get("gameStatus") == "FE":
            continue
        if g.get("gameDate", "") < now_str:
            continue
        upcoming.append(_parse_k2_game(g))
    upcoming.sort(key=lambda x: (x["date"], x["time"]))

    next_by_team = {}
    for g in upcoming:
        for side in ("home_id", "away_id"):
            tid = g.get(side)
            if tid and tid not in next_by_team:
                next_by_team[tid] = {**g, "is_home": side == "home_id"}

    return jsonify({"upcoming": upcoming, "next_by_team": next_by_team})


@app.route("/api/k2/rounds")
@cached_response(ttl=600)
def get_k2_rounds():
    """K2 라운드 목록 + 각 라운드 경기 결과/예정"""
    import datetime
    try:
        raw = _fetch_k2_all_games()
    except Exception:
        return jsonify({"rounds": [], "current_round": None}), 200

    games_by_round = {}
    for g in raw:
        r = g.get("roundId")
        if not r:
            continue
        if r not in games_by_round:
            games_by_round[r] = []
        games_by_round[r].append(_parse_k2_game(g))

    rounds = []
    now_str = datetime.datetime.now().strftime("%Y.%m.%d")
    current_round = None
    for rnd in sorted(games_by_round.keys()):
        items = sorted(games_by_round[rnd], key=lambda x: (x["date"], x["time"]))
        finished_count = sum(1 for g in items if g["finished"])
        rounds.append({
            "round":    rnd,
            "games":    items,
            "finished": finished_count,
            "total":    len(items),
        })
        # 가장 최근 완료 라운드 or 진행 중 라운드를 current로
        if finished_count > 0:
            current_round = rnd

    return jsonify({"rounds": rounds, "current_round": current_round})


def _fetch_k1_all_games(year=None):
    """K리그 공식 API에서 K1 전체 경기(완료+예정) 수집 — 1~12월"""
    import urllib.request, datetime
    url = "https://www.kleague.com/getScheduleList.do"
    if year is None:
        year = datetime.datetime.now().year
    games = []
    # 시즌 전체 12개월 fetch — 라운드 일정 전체 확보 (R1~R38 등)
    for m in range(1, 13):
        payload = json.dumps({"leagueId": "1", "year": str(year), "month": str(m).zfill(2)}).encode("utf-8")
        req = urllib.request.Request(url, data=payload,
            headers={"Content-Type": "application/json; charset=UTF-8", "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=8) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                games += data.get("data", {}).get("scheduleList", [])
        except Exception:
            pass
    return games


def _parse_k1_game(g):
    """K1 API 경기 dict → 통일 포맷"""
    home_code = g.get("homeTeam", "")
    away_code = g.get("awayTeam", "")
    home_id   = KLEAGUE_TEAM_CODE.get(home_code)
    away_id   = KLEAGUE_TEAM_CODE.get(away_code)
    home_info = next((t for t in TEAMS if t["id"] == home_id), None)
    away_info = next((t for t in TEAMS if t["id"] == away_id), None)
    finished  = g.get("endYn") == "Y" or g.get("gameStatus") == "FE"
    return {
        "date":       g.get("gameDate", ""),
        "time":       g.get("gameTime", ""),
        "round":      g.get("roundId"),
        "home_code":  home_code,
        "away_code":  away_code,
        "home_id":    home_id,
        "away_id":    away_id,
        "home_name":  home_info["name"]  if home_info else g.get("homeTeamName", home_code),
        "away_name":  away_info["name"]  if away_info else g.get("awayTeamName", away_code),
        "home_short": home_info["short"] if home_info else g.get("homeTeamName", home_code),
        "away_short": away_info["short"] if away_info else g.get("awayTeamName", away_code),
        "venue":      g.get("fieldName", ""),
        "finished":   finished,
        "home_score": g.get("homeGoal") if finished else None,
        "away_score": g.get("awayGoal") if finished else None,
    }


@app.route("/api/k1/schedule")
@cached_response(ttl=600)
def get_k1_schedule():
    """K1 예정 경기 + 팀별 다음 경기"""
    import datetime
    now_str = datetime.datetime.now().strftime("%Y.%m.%d")
    try:
        raw = _fetch_k1_all_games()
    except Exception:
        return jsonify({"upcoming": [], "next_by_team": {}}), 200

    upcoming = []
    for g in raw:
        if g.get("endYn") == "Y" or g.get("gameStatus") == "FE":
            continue
        if g.get("gameDate", "") < now_str:
            continue
        upcoming.append(_parse_k1_game(g))
    upcoming.sort(key=lambda x: (x["date"], x["time"]))

    next_by_team = {}
    for g in upcoming:
        for side in ("home_id", "away_id"):
            tid = g.get(side)
            if tid and tid not in next_by_team:
                next_by_team[tid] = {**g, "is_home": side == "home_id"}

    return jsonify({"upcoming": upcoming, "next_by_team": next_by_team})


@app.route("/api/k1/rounds")
@cached_response(ttl=600)
def get_k1_rounds():
    """K1 라운드 목록 + 각 라운드 경기 결과/예정"""
    import datetime
    try:
        raw = _fetch_k1_all_games()
    except Exception:
        return jsonify({"rounds": [], "current_round": None}), 200

    games_by_round = {}
    for g in raw:
        r = g.get("roundId")
        if not r:
            continue
        if r not in games_by_round:
            games_by_round[r] = []
        games_by_round[r].append(_parse_k1_game(g))

    rounds = []
    current_round = None
    for rnd in sorted(games_by_round.keys()):
        items = sorted(games_by_round[rnd], key=lambda x: (x["date"], x["time"]))
        finished_count = sum(1 for g in items if g["finished"])
        rounds.append({
            "round":    rnd,
            "games":    items,
            "finished": finished_count,
            "total":    len(items),
        })
        if finished_count > 0:
            current_round = rnd

    return jsonify({"rounds": rounds, "current_round": current_round})


@app.route("/api/round-predictions")
@cached_response(ttl=1800)  # 30분 (라운드는 며칠 단위)
def round_predictions():
    """
    라운드별 사전 예측 — look-ahead bias 차단.
    각 경기의 예측은 해당 라운드 시작일(가장 이른 경기 날짜) 0시 cutoff로 산출.
    R1~R(N-1) 데이터만 사용해 RN을 예측.
    """
    import datetime as _dt
    league = request.args.get("league", "k2").lower()
    round_no = request.args.get("round", type=int)
    if not round_no:
        return jsonify({"error": "round required"}), 400
    tid = 410 if league == "k1" else 777

    try:
        raw = _fetch_k1_all_games() if league == "k1" else _fetch_k2_all_games()
    except Exception:
        return jsonify({"league": league.upper(), "round": round_no, "matches": []})

    parser = _parse_k1_game if league == "k1" else _parse_k2_game
    games = [parser(g) for g in raw if g.get("roundId") == round_no]
    if not games:
        return jsonify({"league": league.upper(), "round": round_no, "matches": []})

    games_sorted = sorted(games, key=lambda x: (x["date"], x["time"]))
    earliest_date = games_sorted[0]["date"]
    try:
        earliest_dt = _dt.datetime.strptime(earliest_date, "%Y.%m.%d")
    except ValueError:
        return jsonify({"league": league.upper(), "round": round_no, "matches": []})
    as_of_ts = int(earliest_dt.timestamp())
    year = str(earliest_dt.year)

    SLUG_TO_SS = {t["id"]: t["sofascore_id"] for t in TEAMS}

    conn = sqlite3.connect(DB_PATH)
    cur  = conn.cursor()

    matches = []
    n_pred = n_hit = 0
    for g in games_sorted:
        h_slug, a_slug = g["home_id"], g["away_id"]
        h_ss = SLUG_TO_SS.get(h_slug)
        a_ss = SLUG_TO_SS.get(a_slug)
        m = {
            "home_id":    h_slug,
            "away_id":    a_slug,
            "home_short": g["home_short"],
            "away_short": g["away_short"],
            "date":       g["date"],
            "time":       g["time"],
            "finished":   g["finished"],
            "actual_score": (
                {"home": g["home_score"], "away": g["away_score"]}
                if g["finished"] and g["home_score"] is not None else None
            ),
        }
        if not h_ss or not a_ss:
            m["pred"] = None
            m["note"] = "팀 매핑 누락"
            matches.append(m); continue

        pred = _predict_core(cur, h_ss, a_ss, tid, as_of_ts, year)
        if not pred:
            m["pred"] = None
            m["note"] = "표본 부족 (cold start)"
            matches.append(m); continue

        top = pred.get("top_scores") or []
        _p = {"home": pred["pred_home"], "draw": pred["pred_draw"], "away": pred["pred_away"]}
        pred_outcome = max(_p, key=_p.get)
        tsbo = pred.get("top_score_by_outcome") or {}
        m["pred"] = {
            "home_pct":  pred["pred_home"],
            "draw_pct":  pred["pred_draw"],
            "away_pct":  pred["pred_away"],
            "pred_outcome": pred_outcome,
            # 예측 결과(승/무/패)와 일치하는 최빈 스코어 (전체 최빈은 대개 1-0이라 모순 생김)
            "top_score": tsbo.get(pred_outcome) or (top[0] if top else None),
            "lam_home":  round(pred["lam_home"], 2),
            "lam_away":  round(pred["lam_away"], 2),
        }
        n_pred += 1
        if g["finished"] and g["home_score"] is not None:
            try:
                hs, ag = int(g["home_score"]), int(g["away_score"])
                actual = "home" if hs > ag else "away" if ag > hs else "draw"
                m["pred"]["actual"] = actual
                m["pred"]["hit"]    = (pred_outcome == actual)
                if pred_outcome == actual:
                    n_hit += 1
            except (TypeError, ValueError):
                pass
        matches.append(m)

    conn.close()
    summary = None
    if n_pred:
        n_judged = sum(1 for m in matches if m.get("pred", {}).get("actual"))
        n_judged_hit = sum(1 for m in matches if m.get("pred", {}).get("hit"))
        if n_judged:
            summary = {
                "n_total":   n_judged,
                "n_hit":     n_judged_hit,
                "hit_pct":   round(n_judged_hit / n_judged * 100, 1),
            }
    return jsonify({
        "league":     league.upper(),
        "round":      round_no,
        "as_of_date": earliest_date,
        "matches":    matches,
        "summary":    summary,
    })


@app.route("/api/player-vs-teams")
@cached_response(ttl=3600)
def get_player_vs_teams():
    """선수가 상대팀별로 기록한 성적 (평점·G+A·출전수)"""
    player_id = request.args.get("playerId", type=int)
    if not player_id:
        return jsonify([]), 400

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("""
        SELECT
            CASE WHEN mps.is_home=1 THEN e.away_team_id ELSE e.home_team_id END AS opp_ss_id,
            COUNT(*)                    AS games,
            SUM(mps.goals)              AS goals,
            SUM(mps.assists)            AS assists,
            SUM(mps.goals+mps.assists)  AS ga,
            AVG(mps.rating)             AS avg_rating,
            AVG(mps.minutes_played)     AS avg_mins,
            SUM(mps.shots_on_target)    AS sot,
            SUM(mps.key_passes)         AS key_passes
        FROM match_player_stats mps
        JOIN events e ON mps.event_id = e.id
        WHERE mps.player_id = ? AND e.tournament_id = 777
        GROUP BY opp_ss_id
        HAVING games >= 1
        ORDER BY avg_rating DESC NULLS LAST
    """, (player_id,)).fetchall()
    conn.close()

    result = []
    for r in rows:
        opp_info = next((t for t in TEAMS if t["sofascore_id"] == r["opp_ss_id"]), None)
        opp_name = opp_info["short"] if opp_info else str(r["opp_ss_id"])
        result.append({
            "opp_id":    r["opp_ss_id"],
            "opp_name":  opp_name,
            "games":     r["games"],
            "goals":     r["goals"] or 0,
            "assists":   r["assists"] or 0,
            "ga":        r["ga"] or 0,
            "avg_rating": round(r["avg_rating"], 2) if r["avg_rating"] else None,
            "avg_mins":  round(r["avg_mins"] or 0),
            "sot":       r["sot"] or 0,
            "key_passes": r["key_passes"] or 0,
        })
    return jsonify(result)


# ── 선수 상태 (부상/출전정지/정상) 관리 API ─────────────

def _load_status():
    if os.path.exists(STATUS_FILE):
        with open(STATUS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}

def _save_status(data):
    with open(STATUS_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

@app.route("/api/player-status", methods=["GET"])
def get_player_status():
    """전체 선수 상태 조회. ?teamId=xxx 로 팀 필터 가능."""
    data = _load_status()
    team_id = request.args.get("teamId", "")
    if team_id:
        data = {k: v for k, v in data.items() if v.get("teamId") == team_id}
    return jsonify(data)

@app.route("/api/player-status", methods=["POST"])
def update_player_status():
    """선수 상태 업데이트. body: {playerId, teamId, name, status, note, returnDate}
    status: "available" | "injured" | "suspended" | "doubtful"
    """
    body = request.get_json()
    pid = str(body.get("playerId", ""))
    if not pid:
        return jsonify({"error": "playerId required"}), 400
    data = _load_status()
    status = body.get("status", "available")
    if status == "available" and pid in data:
        del data[pid]
    else:
        data[pid] = {
            "playerId": pid,
            "teamId": body.get("teamId", ""),
            "name": body.get("name", ""),
            "status": status,
            "note": body.get("note", ""),
            "returnDate": body.get("returnDate", ""),
            "updatedAt": datetime.now().isoformat(),
        }
    _save_status(data)
    return jsonify({"ok": True, "total": len(data)})

@app.route("/api/player-status/<player_id>", methods=["DELETE"])
def delete_player_status(player_id):
    """선수 상태 삭제 (정상 복귀)"""
    data = _load_status()
    if player_id in data:
        del data[player_id]
        _save_status(data)
    return jsonify({"ok": True})


_BACKTEST_CACHE = {}  # {(league,year): {ts:..., data:...}}
_BACKTEST_TTL_SEC = 600


@app.route("/api/next-round")
@cached_response(ttl=1800)
def next_round():
    """
    다가오는 가장 빠른 라운드(같은 주차 묶음) 경기 + 모델 예측.
    누적 정확도(백테스트 hit/Brier)도 함께 반환해 사용자가 신뢰도 정직하게 인지.
    """
    import datetime as _dt, time as _time
    league = request.args.get("league", "k2").lower()
    tid = 410 if league == "k1" else 777

    db_path = DB_PATH
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    now_ts = int(_dt.datetime.now().timestamp())
    rows = cur.execute("""
        SELECT e.id, e.date_ts, e.home_team_id,
               COALESCE(th.short_name, e.home_team_name) AS home_name,
               e.away_team_id,
               COALESCE(ta.short_name, e.away_team_name) AS away_name,
               e.venue_name
        FROM events e
        LEFT JOIN teams th ON e.home_team_id = th.id
        LEFT JOIN teams ta ON e.away_team_id = ta.id
        WHERE e.tournament_id=? AND e.home_score IS NULL AND e.date_ts > ?
        ORDER BY e.date_ts ASC
    """, (tid, now_ts)).fetchall()

    if not rows:
        conn.close()
        return jsonify({"league": league.upper(), "matches": []})

    earliest_week = _dt.datetime.fromtimestamp(rows[0][1]).strftime("%Y-W%W")
    same_week = [r for r in rows if _dt.datetime.fromtimestamp(r[1]).strftime("%Y-W%W") == earliest_week]
    year = str(_dt.datetime.fromtimestamp(rows[0][1]).year)

    # 라운드 번호 추정 (백테스트와 동일: 같은 주차 = 같은 라운드)
    rounds = {}
    for (ts,) in cur.execute("""
        SELECT date_ts FROM events
        WHERE tournament_id=? AND home_score IS NOT NULL
          AND strftime('%Y', datetime(date_ts,'unixepoch','localtime'))=?
        ORDER BY date_ts ASC
    """, (tid, year)).fetchall():
        wk = _dt.datetime.fromtimestamp(ts).strftime("%Y-W%W")
        if wk not in rounds:
            rounds[wk] = len(rounds) + 1
    next_round_no = len(rounds) + 1

    def recent_formation(team_id):
        row = cur.execute("""
            SELECT ml.formation
            FROM match_lineups ml
            JOIN events e2 ON ml.event_id = e2.id
            WHERE ml.team_id=? AND ml.formation IS NOT NULL AND ml.formation != ''
              AND e2.tournament_id=? AND e2.home_score IS NOT NULL
            ORDER BY e2.date_ts DESC LIMIT 1
        """, (team_id, tid)).fetchone()
        return row[0] if row else None

    matches = []
    for r in same_week:
        eid, ts, hid, hn, aid, an, venue = r
        pred = _predict_core(cur, hid, aid, tid, ts, year)
        match_obj = {
            "id":      eid,
            "date_ts": ts,
            "home":    {"id": hid, "name": hn, "recent_formation": recent_formation(hid)},
            "away":    {"id": aid, "name": an, "recent_formation": recent_formation(aid)},
            "venue":   venue,
        }
        if pred:
            ts_list = pred.get("top_scores") or []
            match_obj["pred"] = {
                "home_pct":   pred["pred_home"],
                "draw_pct":   pred["pred_draw"],
                "away_pct":   pred["pred_away"],
                "top_score":  ts_list[0] if ts_list else None,
                "top_scores": ts_list[:3],
                "lam_home":   round(pred["lam_home"], 2),
                "lam_away":   round(pred["lam_away"], 2),
            }
        else:
            match_obj["pred"] = None
            match_obj["note"] = "표본 부족 (cold start)"
        matches.append(match_obj)

    accuracy = None
    cached_bt = _BACKTEST_CACHE.get((league, year))
    if cached_bt and (_time.time() - cached_bt["ts"] < _BACKTEST_TTL_SEC):
        d = cached_bt["data"]
        if d.get("ready"):
            accuracy = {
                "hit_1x2_pct": d["hit_1x2_pct"],
                "n_total":     d["n_total"],
                "brier_score": d["brier_score"],
            }

    conn.close()
    return jsonify({
        "league":           league.upper(),
        "round_no":         next_round_no,
        "round_label":      f"{next_round_no}R",
        "iso_week":         earliest_week,
        "matches":          matches,
        "accuracy_to_date": accuracy,
    })


@app.route("/api/season-simulation")
@cached_response(ttl=3600)
def season_simulation():
    """시즌 시뮬레이션 — 남은 매치 Monte Carlo로 최종 순위 분포 추정.

    1. 완료된 매치: 실제 결과로 현재 standings 산출.
    2. 남은 매치(finished=False): _predict_core 확률로 1X2 추첨 (1000회).
    3. 각 시뮬레이션별 최종 순위 누적 → 팀별 우승/AFC/강등 확률 산출.
    """
    import random as _rand
    league = request.args.get("league", "k1").lower()
    n_sim = int(request.args.get("n", "1000"))
    n_sim = max(100, min(n_sim, 3000))
    tid = 410 if league == "k1" else 777

    try:
        raw = _fetch_k1_all_games() if league == "k1" else _fetch_k2_all_games()
    except Exception:
        return jsonify({"ready": False, "reason": "no_schedule"})
    parser = _parse_k1_game if league == "k1" else _parse_k2_game
    games_all = [parser(g) for g in raw]
    if not games_all:
        return jsonify({"ready": False, "reason": "no_games"})

    SLUG_TO_SS = {t["id"]: t["sofascore_id"] for t in TEAMS}
    SS_TO_TEAM = {t["sofascore_id"]: t for t in TEAMS if t.get("sofascore_id")}

    # 현재 standings — 완료 매치 기준
    standings = {}  # slug → {W,D,L, gf, ga, pts}
    teams_in_season = set()
    finished_games = []
    pending_games = []
    for g in games_all:
        h, a = g["home_id"], g["away_id"]
        if not h or not a or h == "null" or a == "null": continue
        teams_in_season.add(h); teams_in_season.add(a)
        for t in (h, a):
            standings.setdefault(t, {"W":0,"D":0,"L":0,"gf":0,"ga":0,"pts":0,"played":0})
        if g["finished"] and g["home_score"] is not None and g["away_score"] is not None:
            hs, ass = g["home_score"], g["away_score"]
            standings[h]["gf"] += hs; standings[h]["ga"] += ass
            standings[a]["gf"] += ass; standings[a]["ga"] += hs
            standings[h]["played"] += 1; standings[a]["played"] += 1
            if hs > ass:
                standings[h]["W"] += 1; standings[h]["pts"] += 3
                standings[a]["L"] += 1
            elif hs < ass:
                standings[a]["W"] += 1; standings[a]["pts"] += 3
                standings[h]["L"] += 1
            else:
                standings[h]["D"] += 1; standings[h]["pts"] += 1
                standings[a]["D"] += 1; standings[a]["pts"] += 1
            finished_games.append(g)
        else:
            pending_games.append(g)

    # 시뮬레이션을 위해 pending 매치 예측 확률 (한 번만 산출, 모든 sim 공유)
    conn = sqlite3.connect(DB_PATH)
    cur  = conn.cursor()
    # cutoff = 가장 이른 pending 매치 직전. 단순화: 현재 시점.
    as_of_ts = int(datetime.now().timestamp())
    year_str = str(datetime.now().year)

    pending_probs = []
    for g in pending_games:
        h_ss = SLUG_TO_SS.get(g["home_id"])
        a_ss = SLUG_TO_SS.get(g["away_id"])
        if not h_ss or not a_ss: continue
        pred = _predict_core(cur, h_ss, a_ss, tid, as_of_ts, year_str)
        if not pred: continue
        pending_probs.append({
            "home": g["home_id"], "away": g["away_id"],
            "p_home": pred["pred_home"] / 100.0,
            "p_draw": pred["pred_draw"] / 100.0,
            "p_away": pred["pred_away"] / 100.0,
            "lam_home": pred["lam_home"],
            "lam_away": pred["lam_away"],
        })
    conn.close()

    # Monte Carlo 시뮬레이션
    team_list = sorted(teams_in_season)
    position_counts = {t: [0] * len(team_list) for t in team_list}  # 1위~N위 횟수

    for _ in range(n_sim):
        sim_pts = {t: standings[t]["pts"] for t in team_list}
        sim_gf  = {t: standings[t]["gf"]  for t in team_list}
        sim_ga  = {t: standings[t]["ga"]  for t in team_list}
        for pp in pending_probs:
            r = _rand.random()
            if r < pp["p_home"]:
                sim_pts[pp["home"]] += 3
            elif r < pp["p_home"] + pp["p_draw"]:
                sim_pts[pp["home"]] += 1; sim_pts[pp["away"]] += 1
            else:
                sim_pts[pp["away"]] += 3
            # 골차는 lam 기반 단순 누적 (poisson 단순 가정)
            # 정확 골 시뮬은 비용 큼 — pts 기반 순위만 산출 (tiebreaker는 gd 누적)
            sim_gf[pp["home"]] += pp["lam_home"]; sim_ga[pp["home"]] += pp["lam_away"]
            sim_gf[pp["away"]] += pp["lam_away"]; sim_ga[pp["away"]] += pp["lam_home"]

        # 최종 순위
        ranked = sorted(team_list, key=lambda t: (-sim_pts[t], -(sim_gf[t]-sim_ga[t]), -sim_gf[t]))
        for pos, t in enumerate(ranked):
            position_counts[t][pos] += 1

    # 결과 산출
    n_teams = len(team_list)
    afc_top = 4 if league == "k1" else 2  # K1 상위 4 AFC, K2 상위 2 승격
    rel_bot = 2 if league == "k1" else 2  # 강등권

    results = []
    for t in team_list:
        info = SS_TO_TEAM.get(SLUG_TO_SS.get(t), {})
        counts = position_counts[t]
        total = sum(counts)
        win_pct = counts[0] / total * 100 if total else 0
        afc_pct = sum(counts[:afc_top]) / total * 100 if total else 0
        rel_pct = sum(counts[n_teams - rel_bot:]) / total * 100 if total else 0
        avg_pos = sum((i + 1) * c for i, c in enumerate(counts)) / total if total else None
        results.append({
            "slug": t, "name": info.get("short") or t,
            "current_pts": standings[t]["pts"],
            "current_played": standings[t]["played"],
            "win_pct": round(win_pct, 1),
            "afc_pct": round(afc_pct, 1),
            "rel_pct": round(rel_pct, 1),
            "avg_pos": round(avg_pos, 1) if avg_pos else None,
            "median_pos": _median_position(counts),
            "position_dist": counts,  # 1위~N위 횟수
        })

    results.sort(key=lambda r: r["avg_pos"] if r["avg_pos"] else 999)

    return jsonify({
        "ready": True,
        "league": league.upper(),
        "n_simulations": n_sim,
        "n_teams": n_teams,
        "finished_games": len(finished_games),
        "pending_games": len(pending_games),
        "pending_predicted": len(pending_probs),
        "teams": results,
    })


def _median_position(counts):
    total = sum(counts)
    if not total: return None
    half = total / 2
    cum = 0
    for i, c in enumerate(counts):
        cum += c
        if cum >= half:
            return i + 1
    return None


@app.route("/api/prediction-backtest")
@cached_response(ttl=3600)  # 1시간 (시즌 누적, 자주 안 바뀜)
def prediction_backtest():
    """
    Rolling backtest: 각 종료 경기 직전까지의 데이터만으로 예측 → 실제 결과와 비교.
    1X2 적중률 / 정확 스코어 / TOP3 / Brier / λ MAE 산출.
    K2 한정으로 검증된 모델 (K1은 별도 캘리브레이션 필요).
    """
    league = request.args.get("league", "k2").lower()
    year   = request.args.get("year", "2026")
    tid    = 410 if league == "k1" else 777

    import time as _time
    cache_key = (league, year)
    cached = _BACKTEST_CACHE.get(cache_key)
    if cached and (_time.time() - cached["ts"] < _BACKTEST_TTL_SEC):
        return jsonify(cached["data"])

    db_path = DB_PATH
    conn = sqlite3.connect(db_path)
    cur  = conn.cursor()

    # round 컬럼이 있는지 확인 (events 테이블에 round 컬럼 없으면 날짜 기반으로 라운드 추정)
    cur.execute("PRAGMA table_info(events)")
    ev_cols = {r[1] for r in cur.fetchall()}
    has_round = "round" in ev_cols

    round_expr = "round" if has_round else "NULL"
    cur.execute(f"""
        SELECT id, date_ts, home_team_id, away_team_id, home_score, away_score, {round_expr}
        FROM events
        WHERE tournament_id=?
          AND home_score IS NOT NULL AND away_score IS NOT NULL
          AND strftime('%Y', datetime(date_ts,'unixepoch','localtime'))=?
        ORDER BY date_ts ASC
    """, (tid, year))
    games = cur.fetchall()

    # round 없으면 날짜 주차로 대체 (경기 몰린 주 = 같은 라운드)
    if not has_round:
        import datetime as _dt
        week_to_round = {}
        _counter = 0
        _games_aug = []
        for g in games:
            gid, ts, hid, aid, hs, as_, _r = g
            wk = _dt.datetime.fromtimestamp(ts).strftime("%Y-%W")
            if wk not in week_to_round:
                _counter += 1
                week_to_round[wk] = _counter
            _games_aug.append((gid, ts, hid, aid, hs, as_, week_to_round[wk]))
        games = _games_aug

    n_total = n_skipped = 0
    n_hit_1x2 = n_exact = n_top3 = 0
    sum_brier = sum_mae_h = sum_mae_a = 0.0
    n_pred_home_wins = n_pred_draws = n_pred_away_wins = 0
    n_actual_home_wins = n_actual_draws = n_actual_away_wins = 0
    confidence_buckets = {"high": [0, 0], "med": [0, 0], "low": [0, 0]}  # [hit, total]
    per_round_agg = {}  # {round: {"hit": n, "total": n}}
    match_records = []  # 잔차 분석용 — 매치별 (brier, pred, actual, conf) 누적

    for g in games:
        gid, ts, hid, aid, hs, as_, rnd = g
        pred = _predict_core(cur, hid, aid, tid, ts, year)
        if not pred:
            n_skipped += 1
            continue
        n_total += 1

        actual = "home" if hs > as_ else "away" if hs < as_ else "draw"
        outcome_p = {"home": pred["pred_home"], "draw": pred["pred_draw"], "away": pred["pred_away"]}
        pred_outcome = max(outcome_p, key=outcome_p.get)

        if pred_outcome == actual:
            n_hit_1x2 += 1

        actual_str = f"{int(hs)}-{int(as_)}"
        top_strs = [f"{s['home']}-{s['away']}" for s in pred["top_scores"]]
        if top_strs and top_strs[0] == actual_str:
            n_exact += 1
        if actual_str in top_strs[:3]:
            n_top3 += 1

        actual_p = {"home": 1 if actual == "home" else 0,
                    "draw": 1 if actual == "draw" else 0,
                    "away": 1 if actual == "away" else 0}
        brier = sum((outcome_p[k] / 100.0 - actual_p[k]) ** 2 for k in ("home", "draw", "away")) / 3
        sum_brier += brier
        sum_mae_h += abs(pred["lam_home"] - hs)
        sum_mae_a += abs(pred["lam_away"] - as_)

        if pred_outcome == "home": n_pred_home_wins += 1
        elif pred_outcome == "draw": n_pred_draws += 1
        else: n_pred_away_wins += 1

        if actual == "home": n_actual_home_wins += 1
        elif actual == "draw": n_actual_draws += 1
        else: n_actual_away_wins += 1

        # 신뢰도 버킷 (백테스트 시점 기준 표본 크기로 재계산)
        season_g = min(pred["h_games"], pred["a_games"])
        # H2H 사전 경기 수 (전 리그 — tournament_id 무관)
        cur.execute("""
            SELECT COUNT(*) FROM events
            WHERE ((home_team_id=? AND away_team_id=?) OR (home_team_id=? AND away_team_id=?))
              AND date_ts < ?
              AND home_score IS NOT NULL AND away_score IS NOT NULL
        """, (hid, aid, aid, hid, ts))
        h2h_g = cur.fetchone()[0] or 0
        bucket = "high" if (h2h_g >= 8 and season_g >= 10) else \
                 "med"  if (h2h_g >= 3 or  season_g >= 6) else "low"
        confidence_buckets[bucket][1] += 1
        if pred_outcome == actual:
            confidence_buckets[bucket][0] += 1

        # 라운드별 집계 (누적 차트용)
        if rnd is not None:
            bag = per_round_agg.setdefault(int(rnd), {"hit": 0, "total": 0})
            bag["total"] += 1
            if pred_outcome == actual:
                bag["hit"] += 1

        # 잔차 record (worst 잔차 분석용)
        match_records.append({
            "event_id":          gid,
            "date_ts":           ts,
            "home_ss_id":        hid,
            "away_ss_id":        aid,
            "home_score":        int(hs),
            "away_score":        int(as_),
            "actual":            actual,
            "predicted":         {"home": outcome_p["home"], "draw": outcome_p["draw"], "away": outcome_p["away"]},
            "predicted_outcome": pred_outcome,
            "top_score":         top_strs[0] if top_strs else None,
            "lam_home":          round(pred["lam_home"], 2),
            "lam_away":          round(pred["lam_away"], 2),
            "confidence":        bucket,
            "h_games":           pred["h_games"],
            "a_games":           pred["a_games"],
            "h2h_games":         h2h_g,
            "brier":             brier,
            "hit_1x2":           pred_outcome == actual,
        })

    conn.close()

    # per-round 누적 라인 생성
    per_round = []
    cum_hit = cum_total = 0
    for r in sorted(per_round_agg.keys()):
        a = per_round_agg[r]
        cum_hit   += a["hit"]
        cum_total += a["total"]
        per_round.append({
            "round":     r,
            "hit":       a["hit"],
            "total":     a["total"],
            "round_pct": round(a["hit"] / a["total"] * 100, 1) if a["total"] else None,
            "cum_hit":   cum_hit,
            "cum_total": cum_total,
            "cum_pct":   round(cum_hit / cum_total * 100, 1) if cum_total else None,
        })

    if n_total == 0:
        result = {"league": league.upper(), "year": year, "n_total": 0, "n_skipped": n_skipped,
                  "ready": False}
    else:
        # 예측 max prob bucket별 실측 적중률 (calibration curve용)
        # 신뢰도 isotonic 보정 1단계 — 사용자 신뢰도 텍스트에 실측 적중률 노출.
        def _prob_bucket(p):
            if p < 40: return "<40"
            if p < 50: return "40-50"
            if p < 60: return "50-60"
            if p < 70: return "60-70"
            return ">=70"
        _calib_agg = {}
        for r in match_records:
            p_max = max(r["predicted"]["home"], r["predicted"]["draw"], r["predicted"]["away"])
            b = _prob_bucket(p_max)
            bag = _calib_agg.setdefault(b, {"hit": 0, "total": 0})
            bag["total"] += 1
            if r["hit_1x2"]:
                bag["hit"] += 1
        calibration_curve = [
            {"bucket": b, "hit": v["hit"], "total": v["total"],
             "actual_pct": round(v["hit"] / v["total"] * 100, 1) if v["total"] else None}
            for b, v in sorted(_calib_agg.items(),
                               key=lambda kv: ("<40","40-50","50-60","60-70",">=70").index(kv[0]))
        ]

        # 잔차 큰 매치 5건 — brier 내림차순. 패턴 식별용 1단계 잔차 분석.
        def _fmt_record(r):
            home_info = _team_info_by_sofascore_id(r["home_ss_id"]) or {}
            away_info = _team_info_by_sofascore_id(r["away_ss_id"]) or {}
            return {
                "event_id":          r["event_id"],
                "date":              datetime.fromtimestamp(r["date_ts"]).strftime("%Y-%m-%d"),
                "home":              home_info.get("short") or home_info.get("name") or str(r["home_ss_id"]),
                "away":              away_info.get("short") or away_info.get("name") or str(r["away_ss_id"]),
                "actual_score":      f"{r['home_score']}-{r['away_score']}",
                "actual_outcome":    r["actual"],
                "predicted_top":     r["top_score"],
                "predicted_outcome": r["predicted_outcome"],
                "predicted_pct":     {k: round(v, 1) for k, v in r["predicted"].items()},
                "lam_home":          r["lam_home"],
                "lam_away":          r["lam_away"],
                "confidence":        r["confidence"],
                "h_games":           r["h_games"],
                "a_games":           r["a_games"],
                "h2h_games":         r["h2h_games"],
                "brier":             round(r["brier"], 3),
                "hit_1x2":           r["hit_1x2"],
            }
        worst = sorted(match_records, key=lambda r: -r["brier"])[:5]

        result = {
            "league":            league.upper(),
            "year":              year,
            "n_total":           n_total,
            "n_skipped":         n_skipped,
            "hit_1x2_pct":       round(n_hit_1x2 / n_total * 100, 1),
            "exact_score_pct":   round(n_exact   / n_total * 100, 1),
            "top3_score_pct":    round(n_top3    / n_total * 100, 1),
            "brier_score":       round(sum_brier / n_total, 3),
            "mae_lambda_home":   round(sum_mae_h / n_total, 2),
            "mae_lambda_away":   round(sum_mae_a / n_total, 2),
            "baseline_random":   33.3,
            "predicted_outcomes":  {"home": n_pred_home_wins, "draw": n_pred_draws, "away": n_pred_away_wins},
            "actual_outcomes":     {"home": n_actual_home_wins, "draw": n_actual_draws, "away": n_actual_away_wins},
            "by_confidence":     {
                k: {"hit": v[0], "total": v[1],
                    "pct": round(v[0] / v[1] * 100, 1) if v[1] else None}
                for k, v in confidence_buckets.items()
            },
            "per_round":         per_round,
            "calibration_curve": calibration_curve,
            "worst_residuals":   [_fmt_record(r) for r in worst],
            "ready": True,
        }

    _BACKTEST_CACHE[cache_key] = {"ts": _time.time(), "data": result}
    return jsonify(result)


def _compute_predicted_lineup_data(team_slug):
    """팀 예상 출전 라인업 계산 (가장 최근 완료 경기 + 출전시간 TOP11).
    /api/predicted-lineup 단건 라우트와 /api/predicted-lineup-pair 통합 라우트가 공유.
    return: {ready, team, team_id, league, based_on_event, based_on_date, formation, starters[]}
            또는 {ready: False, reason}
    """
    team_info = next((t for t in TEAMS if t["id"] == team_slug), None)
    if not team_info:
        return {"ready": False, "reason": "unknown_team"}
    ss_id  = team_info["sofascore_id"]
    league = team_info.get("league", "K2")
    tid    = 410 if league == "K1" else 777

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur  = conn.cursor()

    # 최근 경기 중 minutes_played 데이터가 있는 첫 경기 찾기 (최대 5경기까지 거슬러 올라감)
    cur.execute("""
        SELECT e.id, e.date_ts FROM events e
        WHERE e.tournament_id=?
          AND (e.home_team_id=? OR e.away_team_id=?)
          AND e.home_score IS NOT NULL
        ORDER BY e.date_ts DESC LIMIT 5
    """, (tid, ss_id, ss_id))
    recent_events = cur.fetchall()
    if not recent_events:
        conn.close()
        return {"ready": False, "reason": "no_recent_match"}

    last_eid = last_ts = None
    rows = []
    for re_row in recent_events:
        eid, ts = re_row["id"], re_row["date_ts"]
        cur.execute("""
            SELECT mps.player_id,
                   COALESCE(p.name_ko, mps.player_name, p.name) AS name,
                   mps.position, mps.shirt_number, mps.minutes_played, mps.rating
            FROM match_player_stats mps
            LEFT JOIN players p ON mps.player_id = p.id
            WHERE mps.event_id=? AND mps.team_id=?
              AND mps.minutes_played IS NOT NULL AND mps.minutes_played > 0
            ORDER BY mps.minutes_played DESC, mps.position
            LIMIT 11
        """, (eid, ss_id))
        rows = cur.fetchall()
        if len(rows) >= 11:
            last_eid, last_ts = eid, ts
            break

    if not rows or len(rows) < 11:
        conn.close()
        return {"ready": False, "reason": "insufficient_lineup_data"}

    player_status_map = _load_status()  # {str(player_id): {status, note, ...}}

    starters = []
    pos_counts = {"G": 0, "D": 0, "M": 0, "F": 0}
    for r in rows:
        pos = r["position"] or "?"
        pid_str = str(r["player_id"])
        ps = player_status_map.get(pid_str, {})
        s = {
            "player_id":    r["player_id"],
            "name":         r["name"],
            "position":     pos,
            "shirt_number": r["shirt_number"],
            "minutes":      r["minutes_played"],
            "rating":       round(r["rating"], 2) if r["rating"] is not None else None,
            "status":       ps.get("status") if ps.get("status") not in (None, "available") else None,
            "status_note":  ps.get("note") or None,
        }
        starters.append(s)
        if pos in pos_counts:
            pos_counts[pos] += 1

    if pos_counts["G"] == 1 and (pos_counts["D"] + pos_counts["M"] + pos_counts["F"]) == 10:
        formation = f'{pos_counts["D"]}-{pos_counts["M"]}-{pos_counts["F"]}'
    else:
        formation = None

    conn.close()
    return {
        "ready":          True,
        "team":           team_info["name"],
        "team_id":        team_slug,
        "league":         league,
        "based_on_event": last_eid,
        "based_on_date":  datetime.fromtimestamp(last_ts).strftime("%Y-%m-%d"),
        "formation":      formation,
        "starters":       starters,
    }


@app.route("/api/predicted-lineup")
@cached_response(ttl=1800)
def get_predicted_lineup():
    """팀 예상 출전 라인업 (가장 최근 완료 경기 + 출전시간 TOP11 기반)."""
    team_id = request.args.get("teamId", "")
    result = _compute_predicted_lineup_data(team_id)
    if not result.get("ready") and result.get("reason") == "unknown_team":
        return jsonify(result), 404
    return jsonify(result)


def _build_predicted_side_for_tactic(d, is_home):
    """predicted-lineup dict → match-lineup 응답 한 쪽 형식 변환.
    is_home으로 mirror(home=좌→우, away=우→좌) 결정.

    slot_order는 라인별(G→D→M→F) 단순 매핑. starters position(G/D/M/F)만으로
    formation 분포(rows)에 순차 배치. K리그 ground-truth가 없는 예측이라
    정교한 좌우 정렬은 생략(전술판 진입 후 사용자가 드래그로 조정).
    """
    slug = d["team_id"]
    team_info = next((t for t in TEAMS if t["id"] == slug), {}) or {}
    formation = d.get("formation") or "4-4-2"
    slots = _build_formation_slots(formation, mirror=(not is_home))

    by_line = {"G": [], "D": [], "M": [], "F": []}
    for st in (d.get("starters") or []):
        pos = st.get("position") or "?"
        if pos in by_line:
            by_line[pos].append(st)

    try:
        rows = [int(x) for x in formation.split("-")]
        nD = rows[0]
        nF = rows[-1]
        nM = sum(rows[1:-1]) if len(rows) >= 3 else 0
    except (ValueError, IndexError):
        nD, nM, nF = 4, 4, 2  # fallback

    def _wrap(st_in, label, slot_idx):
        return {
            "player_id":    st_in.get("player_id"),
            "name":         st_in.get("name", "") or "",
            "name_raw":     st_in.get("name", "") or "",
            "shirt_number": st_in.get("shirt_number"),
            "position":     label,
            "height":       None,
            "slot_order":   slot_idx,
        }

    starters_out = []
    idx = 0
    if by_line["G"]:
        starters_out.append(_wrap(by_line["G"][0], "G", 0))
    idx = 1
    for st_in in by_line["D"][:nD]:
        starters_out.append(_wrap(st_in, "D", idx)); idx += 1
    for st_in in by_line["M"][:nM]:
        starters_out.append(_wrap(st_in, "M", idx)); idx += 1
    for st_in in by_line["F"][:nF]:
        starters_out.append(_wrap(st_in, "F", idx)); idx += 1

    return {
        "team_id":    team_info.get("sofascore_id"),
        "slug":       slug,
        "name":       team_info.get("name") or d.get("team", ""),
        "short":      team_info.get("short") or (d.get("team", "") or ""),
        "emblem":     team_info.get("emblem"),
        "formation":  formation,
        "slots":      slots,
        "starters":   starters_out,
        "subs":       [],
    }


@app.route("/api/predicted-lineup-pair")
@cached_response(ttl=1800)
def predicted_lineup_pair():
    """홈/원정 두 팀 예상 라인업을 match-lineup 응답 형식으로 통합 반환.
    예측 패널 → 전술판 자동 적용 진입점 (matchLineupLoaded 이벤트와 동일 스키마).
    """
    home_slug = request.args.get("home_slug", "").strip()
    away_slug = request.args.get("away_slug", "").strip()
    if not home_slug or not away_slug:
        return jsonify({"error": "home_slug and away_slug required"}), 400
    if home_slug == away_slug:
        return jsonify({"error": "home and away must differ"}), 400

    home_pred = _compute_predicted_lineup_data(home_slug)
    away_pred = _compute_predicted_lineup_data(away_slug)

    if not home_pred.get("ready") or not away_pred.get("ready"):
        return jsonify({
            "ready":       False,
            "reason":      "predicted_lineup_unavailable",
            "home_ready":  bool(home_pred.get("ready")),
            "away_ready":  bool(away_pred.get("ready")),
            "home_reason": home_pred.get("reason"),
            "away_reason": away_pred.get("reason"),
        })

    home_side = _build_predicted_side_for_tactic(home_pred, is_home=True)
    away_side = _build_predicted_side_for_tactic(away_pred, is_home=False)

    return jsonify({
        "ready":         True,
        "source":        "predicted",
        "based_on_home": home_pred.get("based_on_date"),
        "based_on_away": away_pred.get("based_on_date"),
        "date":          "예상 라인업",  # showToast 표시용 라벨
        "home":          home_side,
        "away":          away_side,
    })


# ── 경기 라인업 불러오기 ─────────────────────────────────
# SofaScore lineup 데이터를 전술판에 그대로 로드하기 위한 API.
# crawlers/crawl_lineups.py 가 채운 match_lineups 테이블을 조회한다.

def _default_labels_for_rows(rows):
    """미지 포메이션(예: 4-5-1)용 기본 라벨 생성. rows=[4,5,1] -> ['GK','D1','D2','D3','D4','M1'...'F1']."""
    labels = ["GK"]
    prefixes = ("D", "M", "F")
    for i, count in enumerate(rows):
        prefix = prefixes[min(i, len(prefixes) - 1)] if i < len(prefixes) else "A"
        if count == 1:
            labels.append(prefix)
        else:
            for j in range(count):
                labels.append(f"{prefix}{j+1}")
    return labels


def _build_formation_slots(formation, mirror=False):
    """포메이션 문자열 -> [{slot_order, x, y, label}]. mirror=True면 원정팀용(x 반전).

    홈팀(mirror=False): y = 1-y 반전 적용. slot 1(RB) → 캔버스 아래쪽.
    원정팀(mirror=True): y 반전 없음. slot 1(RB, 원정 시선에서 오른쪽=broadcast 위쪽) → 캔버스 위쪽.
    수동 포메이션(FORMATIONS.teamB)과 동일한 방식으로 통일.
    """
    if not formation or not all(part.isdigit() for part in formation.split("-")):
        formation = "4-4-2"  # fallback
    if formation in POSITION_LABELS:
        labels = POSITION_LABELS[formation]
    else:
        rows = [int(x) for x in formation.split("-")]
        labels = _default_labels_for_rows(rows)
    labels = mirror_labels(labels)
    positions = compute_formation(formation)
    slots = []
    for i, pos in enumerate(positions):
        x = round(1.0 - pos["x"], 3) if mirror else pos["x"]
        y = pos["y"] if mirror else round(1.0 - pos["y"], 3)
        label = labels[i] if i < len(labels) else ""
        slots.append({"slot_order": i, "x": x, "y": y, "label": label})
    return slots


# O(n) 순회 제거 — sofascore_id → 팀 정보 O(1) 조회
_TEAM_INFO_BY_SS_ID = {
    t["sofascore_id"]: {
        "slug":      t["id"],
        "name":      t["name"],
        "short":     t["short"],
        "league":    t.get("league"),
        "emblem":    t.get("emblem"),
        "primary":   t.get("primary"),
        "secondary": t.get("secondary"),
        "accent":    t.get("accent"),
    }
    for t in TEAMS if t.get("sofascore_id")
}

def _team_info_by_sofascore_id(ss_id):
    return _TEAM_INFO_BY_SS_ID.get(ss_id)


@app.route("/api/matches-by-date")
@cached_response(ttl=600)
def matches_by_date():
    """
    특정 날짜에 치러진 경기 목록 반환.
    쿼리: ?date=YYYY-MM-DD  (없으면 라인업이 저장된 전체 경기)
        ?has_lineup=1     (라인업 데이터가 있는 경기만)
    """
    date_str   = request.args.get("date", "").strip()
    has_lineup = request.args.get("has_lineup") == "1"

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur  = conn.cursor()

    where   = []
    params  = []
    if date_str:
        try:
            dt = datetime.strptime(date_str, "%Y-%m-%d")
        except ValueError:
            conn.close()
            return jsonify({"error": "invalid date"}), 400
        start_ts = int(dt.timestamp())
        end_ts   = start_ts + 86400
        where.append("e.date_ts >= ? AND e.date_ts < ?")
        params.extend([start_ts, end_ts])

    if has_lineup:
        where.append("lu.event_id IS NOT NULL")

    # 코릴레이티드 서브쿼리 2개 → LEFT JOIN 1회로 교체 (idx_lineups_event 활용)
    sql = """
        SELECT e.id, e.home_team_id, e.home_team_name, e.away_team_id, e.away_team_name,
               e.date_ts, e.home_score, e.away_score, e.tournament_id,
               CASE WHEN lu.event_id IS NOT NULL THEN 1 ELSE 0 END AS has_lu
        FROM events e
        LEFT JOIN (SELECT DISTINCT event_id FROM match_lineups) lu ON lu.event_id = e.id
        WHERE e.tournament_id IN (410, 777)
          AND e.id NOT IN {excluded_ids}
    """.format(excluded_ids=EXCLUDED_EVENT_IDS_SQL)
    if where:
        sql += " AND " + " AND ".join(where)
    sql += " ORDER BY e.date_ts ASC, e.id ASC"
    cur.execute(sql, params)
    rows = cur.fetchall()

    out = []
    for r in rows:
        ts = r["date_ts"] or 0
        dt = datetime.fromtimestamp(ts) if ts else None
        home_info = _team_info_by_sofascore_id(r["home_team_id"])
        away_info = _team_info_by_sofascore_id(r["away_team_id"])
        out.append({
            "event_id":      r["id"],
            "date_ts":       ts,
            "date":          dt.strftime("%Y-%m-%d") if dt else "",
            "kickoff":       dt.strftime("%H:%M") if dt else "",
            "tournament_id": r["tournament_id"],
            "league":        "K1" if r["tournament_id"] == 410 else "K2",
            "home_score":    r["home_score"],
            "away_score":    r["away_score"],
            "has_lineup":    bool(r["has_lu"]),
            "home": {
                "team_id":   r["home_team_id"],
                "name":      r["home_team_name"],
                "slug":      home_info["slug"] if home_info else None,
                "short":     home_info["short"] if home_info else (r["home_team_name"] or ""),
                "emblem":    home_info["emblem"] if home_info else None,
            },
            "away": {
                "team_id":   r["away_team_id"],
                "name":      r["away_team_name"],
                "slug":      away_info["slug"] if away_info else None,
                "short":     away_info["short"] if away_info else (r["away_team_name"] or ""),
                "emblem":    away_info["emblem"] if away_info else None,
            },
        })

    conn.close()
    return jsonify(out)


@app.route("/api/matches-latest-lineup-date")
@cached_response(ttl=600)
def matches_latest_lineup_date():
    """라인업이 저장된 가장 최근 경기일(YYYY-MM-DD) 반환. 프론트 기본값용."""
    conn = sqlite3.connect(DB_PATH)
    row = conn.execute("""
        SELECT MAX(e.date_ts) FROM events e
        WHERE EXISTS (SELECT 1 FROM match_lineups m WHERE m.event_id = e.id)
    """).fetchone()
    conn.close()
    ts = row[0] if row else None
    if not ts:
        return jsonify({"date": None})
    return jsonify({"date": datetime.fromtimestamp(ts).strftime("%Y-%m-%d")})


@app.route("/api/match-lineup")
@cached_response(ttl=3600)
def match_lineup():
    """
    특정 경기의 홈/원정 라인업(포메이션 + 선발 + 교체) 반환.
    전술판이 그대로 적용할 수 있도록 슬롯 좌표까지 계산해서 내려준다.
    쿼리:
      - ?event_id=<int>                                (SofaScore event id 직접 지정)
      - ?date=YYYY-MM-DD(또는 YYYY.MM.DD)&home_slug=X&away_slug=Y
        (K리그 일정 패널 등 event_id 없을 때 팀 슬러그로 조회)
    """
    event_id = request.args.get("event_id", "").strip()
    date_str = request.args.get("date", "").strip()
    home_slug = request.args.get("home_slug", "").strip()
    away_slug = request.args.get("away_slug", "").strip()

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur  = conn.cursor()

    ev = None
    if event_id:
        try:
            event_id = int(event_id)
        except ValueError:
            conn.close()
            return jsonify({"error": "event_id must be int"}), 400
        if event_id in EXCLUDED_EVENT_IDS:
            conn.close()
            return jsonify({"ready": False, "reason": "excluded_event", "event_id": event_id}), 404
        ev = cur.execute("""
            SELECT id, home_team_id, home_team_name, away_team_id, away_team_name,
                   date_ts, home_score, away_score, tournament_id
            FROM events WHERE id = ?
        """, (event_id,)).fetchone()
    elif date_str and home_slug and away_slug:
        # date: "YYYY-MM-DD" 또는 "YYYY.MM.DD" 허용
        dt_str = date_str.replace(".", "-")
        try:
            dt = datetime.strptime(dt_str, "%Y-%m-%d")
        except ValueError:
            conn.close()
            return jsonify({"error": "invalid date"}), 400
        start_ts, end_ts = int(dt.timestamp()), int(dt.timestamp()) + 86400
        home_team = next((t for t in TEAMS if t["id"] == home_slug), None)
        away_team = next((t for t in TEAMS if t["id"] == away_slug), None)
        if not home_team or not away_team:
            conn.close()
            return jsonify({"error": "unknown team slug"}), 400
        ev = cur.execute(f"""
            SELECT id, home_team_id, home_team_name, away_team_id, away_team_name,
                   date_ts, home_score, away_score, tournament_id
            FROM events
            WHERE id NOT IN {EXCLUDED_EVENT_IDS_SQL}
              AND date_ts >= ? AND date_ts < ?
              AND home_team_id = ? AND away_team_id = ?
            LIMIT 1
        """, (start_ts, end_ts, home_team["sofascore_id"], away_team["sofascore_id"])).fetchone()
    else:
        conn.close()
        return jsonify({"error": "event_id or (date+home_slug+away_slug) required"}), 400

    if not ev:
        conn.close()
        return jsonify({"ready": False, "reason": "event_not_found"}), 404

    resolved_event_id = ev["id"]
    lu_rows = cur.execute("""
        SELECT ml.is_home, ml.team_id, ml.formation, ml.formation_sofa,
               ml.player_id, ml.player_name,
               ml.shirt_number, ml.position, ml.is_starter, ml.slot_order,
               ml.confirmed,
               COALESCE(p.name_ko, ml.player_name, p.name) AS name_display,
               p.height
        FROM match_lineups ml
        LEFT JOIN players p ON p.id = ml.player_id
        WHERE ml.event_id = ?
        ORDER BY ml.is_home DESC, ml.is_starter DESC, ml.slot_order ASC
    """, (resolved_event_id,)).fetchall()

    if not lu_rows:
        conn.close()
        return jsonify({"ready": False, "reason": "no_lineup", "event_id": resolved_event_id})

    # avg_position 사전 조회 — 같은 라인 내 starter 좌우 순서 재정렬에 사용 (B 방식).
    # 슬롯 좌표는 formation 격자 그대로 유지, starter의 slot_order만 재할당.
    avg_rows = conn.execute(
        "SELECT player_id, x, y FROM match_avg_positions WHERE event_id=?",
        (resolved_event_id,),
    ).fetchall()
    avg_by_pid = {r["player_id"]: (r["x"], r["y"]) for r in avg_rows}

    # K리그 포털 라인업(있으면 ground truth) — side별 player 목록.
    # build_side에서 라인 라벨(G/D/M/F) 재할당에 사용. 좌표 자체는 사용하지 않음
    # (전술판 격자 보존 위해). 매칭은 등번호 기반.
    kl_rows = conn.execute("""
        SELECT side, back_no, top_pct, left_pct, player_name
        FROM kleague_lineup WHERE sofa_event_id = ?
    """, (resolved_event_id,)).fetchall()
    kleague_by_side = {"home": [], "away": []}
    for r in kl_rows:
        kleague_by_side[r["side"]].append({
            "back_no": r["back_no"], "top_pct": r["top_pct"], "left_pct": r["left_pct"],
            "player_name": r["player_name"],
        })

    def _kleague_position_by_shirt(kl_players):
        """K리그 라인업 → ({shirt_number: 'G'|'D'|'M'|'F'}, formation,
                          {shirt_number: row_idx}).

        K리그 row 그대로 multi-row formation으로 변환.
        N=3 (D-M-F) 또는 N=4 (D-CDM-MF-F 등) row 그대로 사용.
        N=5+ 매치는 middle row 중 작은 인접 쌍을 합쳐 4-row로 축소.

        K리그 row index가 main.py compute_formation의 slot row와 1:1 매핑되어
        slot_order 재할당 시 사용. 라인 라벨(D/M/F)은 첫=D, 마지막=F, 나머지=M.
        """
        if len(kl_players) != 11:
            return None
        from collections import defaultdict
        by_top = defaultdict(list)
        for p in kl_players:
            by_top[round(p["top_pct"], 1)].append(p)
        tops_desc = sorted(by_top.keys(), reverse=True)
        if len(tops_desc) < 3:
            return None
        gk_line = by_top[tops_desc[0]]
        if len(gk_line) != 1:
            return None

        # outfield row 추출: (top, [players]) 리스트
        outfield = [(t, list(by_top[t])) for t in tops_desc[1:]]
        total_outfield = sum(len(p) for _, p in outfield)
        if total_outfield != 10:
            return None

        # 사전 병합: top% 차이가 작은(≤3.0) 인접 row는 같은 라인으로 (K리그 시각화의
        # 미세한 위치 차이로 라인이 분리 표시되는 케이스 — 용인 4-2-3-1을 4-3-2-1로
        # 잘못 분류하는 케이스 등). top% 차이 3 초과면 진짜 다른 라인.
        TOP_MERGE_THRESH = 3.0
        merged_outfield = []
        for t, players in outfield:
            if merged_outfield and (merged_outfield[-1][0] - t) <= TOP_MERGE_THRESH:
                # 인접 row와 합치기 (top%는 평균 유지하기 위해 첫 row의 값 유지)
                merged_outfield[-1] = (merged_outfield[-1][0], merged_outfield[-1][1] + players)
            else:
                merged_outfield.append((t, list(players)))
        outfield = merged_outfield

        # D 누적: 첫 row가 3명 미만이면 인접 row와 합쳐서 D 라인 형성
        # (K리그가 LB+CB+CB+RB를 2 row로 split 표시하는 경우 대응)
        while len(outfield) > 1 and len(outfield[0][1]) < 3:
            merged = (outfield[0][0], outfield[0][1] + outfield[1][1])
            outfield = [merged] + outfield[2:]
        if len(outfield) < 2 or len(outfield[0][1]) < 3:
            return None

        # 5+ row → 4-row까지 축소: middle row 중 합이 가장 작은 인접 쌍 합치기.
        # 동일 합 발생 시 더 뒤쪽(공격 라인 쪽) 우선 — 4-2-1-2-1 → 4-2-3-1 표준.
        while len(outfield) > 4:
            middle_indices = list(range(1, len(outfield) - 1))
            if len(middle_indices) < 2:
                merged = (outfield[0][0], outfield[0][1] + outfield[1][1])
                outfield = [merged] + outfield[2:]
                continue
            best_i, best_sum = None, 999
            for i in middle_indices[:-1]:
                s = len(outfield[i][1]) + len(outfield[i + 1][1])
                if s < best_sum or (s == best_sum and best_i is not None and i > best_i):
                    best_sum, best_i = s, i
            merged = (outfield[best_i][0], outfield[best_i][1] + outfield[best_i + 1][1])
            outfield = outfield[:best_i] + [merged] + outfield[best_i + 2:]

        # 이제 outfield는 3 또는 4 row
        row_counts = [len(p) for _, p in outfield]
        nD = row_counts[0]
        nF = row_counts[-1]
        nM = sum(row_counts[1:-1])
        if not (3 <= nD <= 6 and 1 <= nF <= 4 and nM >= 1):
            return None
        if nD + nM + nF != 10:
            return None

        formation = "-".join(str(c) for c in row_counts)

        # shirt_number → ('G'|'D'|'M'|'F', row_idx, left_pct)
        # 추가로 player_name(이름 정규화) → 동일 매핑 — 등번호 다른 매치 fallback용.
        pos_by_shirt = {gk_line[0]["back_no"]: "G"}
        row_idx_by_shirt = {gk_line[0]["back_no"]: 0}
        left_by_shirt = {gk_line[0]["back_no"]: gk_line[0]["left_pct"]}

        def _norm_name(nm):
            return (nm or "").replace("(c)", "").replace(" ", "").strip().lower()

        pos_by_name = {_norm_name(gk_line[0]["player_name"]): "G"}
        row_idx_by_name = {_norm_name(gk_line[0]["player_name"]): 0}
        left_by_name = {_norm_name(gk_line[0]["player_name"]): gk_line[0]["left_pct"]}

        for idx, (_, players) in enumerate(outfield):
            label = "D" if idx == 0 else ("F" if idx == len(outfield) - 1 else "M")
            for p in players:
                pos_by_shirt[p["back_no"]] = label
                row_idx_by_shirt[p["back_no"]] = idx + 1
                left_by_shirt[p["back_no"]] = p["left_pct"]
                nm = _norm_name(p["player_name"])
                pos_by_name[nm] = label
                row_idx_by_name[nm] = idx + 1
                left_by_name[nm] = p["left_pct"]

        return (pos_by_shirt, formation, row_idx_by_shirt, left_by_shirt,
                pos_by_name, row_idx_by_name, left_by_name)

    def build_side(is_home_flag, ss_team_id, ss_team_name):
        rows = [r for r in lu_rows if r["is_home"] == is_home_flag]
        if not rows:
            return None
        formation = next((r["formation"] for r in rows if r["formation"]), None)
        # formation_sofa = SofaScore가 실제로 보고한 포메이션 → 서브-row 구조까지 정확
        formation_sofa = next((r["formation_sofa"] for r in rows if r["formation_sofa"]), None)

        # 우선순위 0순위: K리그 포털 라벨 (공식 출처) → starter.position·formation 모두 override
        side_key = "home" if is_home_flag else "away"
        kl_players = kleague_by_side.get(side_key, [])
        kl_override = _kleague_position_by_shirt(kl_players)

        starter_rows_tmp = [r for r in rows if r["is_starter"]]

        # K리그 적용 가능 검사: 등번호 매칭 → 이름 매칭 fallback. 11/11 완전 매칭만 K리그 적용.
        kl_pos_by_pid = None
        kl_row_idx_by_pid = None
        kl_left_by_pid = None
        kl_formation = None
        if kl_override:
            (kl_pos_by_shirt, kl_formation, kl_row_idx_by_shirt, kl_left_by_shirt,
             kl_pos_by_name, kl_row_idx_by_name, kl_left_by_name) = kl_override

            def _norm_name(nm):
                return (nm or "").replace("(c)", "").replace(" ", "").strip().lower()

            kl_pos_by_pid = {}
            kl_row_idx_by_pid = {}
            kl_left_by_pid = {}
            matched_cnt = 0
            for r in starter_rows_tmp:
                shirt = r["shirt_number"]
                pid = r["player_id"]
                if shirt is not None and shirt in kl_pos_by_shirt:
                    kl_pos_by_pid[pid] = kl_pos_by_shirt[shirt]
                    kl_row_idx_by_pid[pid] = kl_row_idx_by_shirt[shirt]
                    kl_left_by_pid[pid] = kl_left_by_shirt[shirt]
                    matched_cnt += 1
                else:
                    # 등번호 매칭 실패 — 이름 매칭 시도 (등번호 변경 매치 대응)
                    n_ko = _norm_name(r["name_display"])
                    n_raw = _norm_name(r["player_name"])
                    n_match = None
                    if n_ko in kl_pos_by_name: n_match = n_ko
                    elif n_raw in kl_pos_by_name: n_match = n_raw
                    if n_match:
                        kl_pos_by_pid[pid] = kl_pos_by_name[n_match]
                        kl_row_idx_by_pid[pid] = kl_row_idx_by_name[n_match]
                        kl_left_by_pid[pid] = kl_left_by_name[n_match]
                        matched_cnt += 1
            # 11/11 완전 매칭일 때만 K리그 적용. 미만이면 SofaScore + B 방식 fallback.
            if matched_cnt < 11:
                kl_pos_by_pid = None
                kl_row_idx_by_pid = None
                kl_left_by_pid = None
                kl_formation = None

        # position 카운트: K리그 우선 → SofaScore fallback
        if kl_pos_by_pid:
            actual_d = sum(1 for pid in kl_pos_by_pid.values() if pid == "D")
            actual_m = sum(1 for pid in kl_pos_by_pid.values() if pid == "M")
            actual_f = sum(1 for pid in kl_pos_by_pid.values() if pid == "F")
            # K리그 포메이션 직접 사용
            formation = kl_formation
        else:
            actual_d = sum(1 for r in starter_rows_tmp if r["position"] == "D")
            actual_m = sum(1 for r in starter_rows_tmp if r["position"] == "M")
            actual_f = sum(1 for r in starter_rows_tmp if r["position"] == "F")
            if formation_sofa:
                # formation_sofa DF 행도 검증 — 틀리면 실측 분포로 재도출
                try:
                    if actual_d + actual_m + actual_f == 10 and int(formation_sofa.split("-")[0]) != actual_d:
                        raise ValueError
                    formation = formation_sofa
                except (ValueError, IndexError):
                    parts = []
                    if actual_d: parts.append(str(actual_d))
                    if actual_m: parts.append(str(actual_m))
                    if actual_f: parts.append(str(actual_f))
                    formation = "-".join(parts) if parts else formation
            elif actual_d + actual_m + actual_f == 10 and formation:
                try:
                    if int(formation.split("-")[0]) != actual_d:
                        parts = []
                        if actual_d: parts.append(str(actual_d))
                        if actual_m: parts.append(str(actual_m))
                        if actual_f: parts.append(str(actual_f))
                        formation = "-".join(parts) if parts else formation
                except (ValueError, IndexError):
                    pass

        slots     = _build_formation_slots(formation, mirror=(not is_home_flag))

        starters, subs = [], []
        for r in rows:
            pid = r["player_id"]
            # K리그 override 적용된 경우 position 교체
            kl_pos = kl_pos_by_pid.get(pid) if kl_pos_by_pid else None
            p = {
                "player_id":    pid,
                "name":         r["name_display"] or r["player_name"] or "",
                "name_raw":     r["player_name"] or "",
                "shirt_number": r["shirt_number"],
                "position":     kl_pos or r["position"],
                "height":       r["height"],
            }
            if r["is_starter"]:
                p["slot_order"] = r["slot_order"]
                starters.append(p)
            else:
                subs.append(p)

        from collections import defaultdict
        if kl_pos_by_pid and kl_row_idx_by_pid:
            # K리그 row index 기반 slot 매핑 — multi-row formation (4-2-3-1 등) 지원.
            # slot 인덱스: GK=0, row1=[1..r1], row2=[r1+1..r1+r2], ...
            row_counts = [int(c) for c in formation.split("-")]  # outfield row counts
            row_slot_idx = {0: [0]}  # GK
            cursor = 1
            for ridx, cnt in enumerate(row_counts):
                row_slot_idx[ridx + 1] = list(range(cursor, cursor + cnt))
                cursor += cnt

            by_row = defaultdict(list)
            for st in starters:
                rid = kl_row_idx_by_pid.get(st["player_id"])
                if rid is not None:
                    by_row[rid].append(st)

            for rid, line_sts in by_row.items():
                slot_indices = row_slot_idx.get(rid, [])
                if len(line_sts) != len(slot_indices) or not slot_indices:
                    continue
                # 라인 내 좌우 정렬: K리그 left% 기반.
                # broadcast 시각 표준:
                #   HOME: LB(본인 시점 좌측, K리그 left 작) → 캔버스 위쪽(slot.y 작)
                #   AWAY: LB(본인 시점 좌측, K리그 left 작) → 캔버스 아래쪽(slot.y 큰) [HOME과 mirror]
                # 따라서 HOME은 K리그 left ASC ↔ slot.y ASC,
                #         AWAY는 K리그 left ASC ↔ slot.y DESC (방향 반전).
                line_sorted = sorted(
                    line_sts,
                    key=lambda st: kl_left_by_pid.get(st["player_id"], 50),
                )
                slot_sorted = sorted(
                    slot_indices,
                    key=lambda i: slots[i]["y"],
                    reverse=(not is_home_flag),
                )
                for st, si in zip(line_sorted, slot_sorted):
                    st["slot_order"] = si
        elif avg_by_pid:
            # B 방식 fallback: SofaScore 라인 라벨 + avg_y 라인 내 정렬
            by_line = defaultdict(list)
            line_slot_orders = defaultdict(list)
            for st in starters:
                pos = st["position"]
                so  = st.get("slot_order")
                if pos in ("D", "M", "F") and so is not None and 0 <= so < len(slots):
                    by_line[pos].append(st)
                    line_slot_orders[pos].append(so)
            for pos, group in by_line.items():
                if len(group) < 2:
                    continue
                if not all(st["player_id"] in avg_by_pid for st in group):
                    continue
                sorted_starters = sorted(group, key=lambda st: avg_by_pid[st["player_id"]][1])
                sorted_sos      = sorted(line_slot_orders[pos], key=lambda so: slots[so]["y"])
                for st, new_so in zip(sorted_starters, sorted_sos):
                    st["slot_order"] = new_so

        team_info = _team_info_by_sofascore_id(ss_team_id) or {}
        return {
            "team_id":    ss_team_id,
            "slug":       team_info.get("slug"),
            "name":       team_info.get("name") or ss_team_name,
            "short":      team_info.get("short") or ss_team_name,
            "emblem":     team_info.get("emblem"),
            "formation":  formation or "4-4-2",
            "slots":      slots,
            "starters":   starters,
            "subs":       subs,
        }

    confirmed = any(r["confirmed"] for r in lu_rows)
    home = build_side(1, ev["home_team_id"], ev["home_team_name"])
    away = build_side(0, ev["away_team_id"], ev["away_team_name"])

    conn.close()
    ts = ev["date_ts"] or 0
    return jsonify({
        "ready":      True,
        "event_id":   ev["id"],
        "date_ts":    ts,
        "date":       datetime.fromtimestamp(ts).strftime("%Y-%m-%d") if ts else "",
        "kickoff":    datetime.fromtimestamp(ts).strftime("%H:%M") if ts else "",
        "home_score": ev["home_score"],
        "away_score": ev["away_score"],
        "league":     "K1" if ev["tournament_id"] == 410 else "K2",
        "confirmed":  confirmed,
        "home":       home,
        "away":       away,
    })


@app.route("/api/match-lineup.csv")
def match_lineup_csv():
    """매치 라인업 CSV 다운로드 — 분석가·코치 export 용도.

    응답: side, slot_order, position, shirt_number, player_name, slot_label,
          slot_x, slot_y, avg_x, avg_y, is_starter.
    매칭 ID는 event_id 쿼리 파라미터로 받음.
    """
    import csv
    import io as _io
    eid = request.args.get("event_id", type=int)
    if not eid:
        return ("event_id required", 400)

    # /api/match-lineup 응답 재활용 (test_client 호출 대신 직접 데이터 fetch)
    with app.test_request_context(f"/api/match-lineup?event_id={eid}"):
        resp = match_lineup()
        data = resp.get_json() if hasattr(resp, "get_json") else None
    if not data or not data.get("ready"):
        return ("not_ready", 404)

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    avg_rows = conn.execute(
        "SELECT player_id, x, y FROM match_avg_positions WHERE event_id=?", (eid,)
    ).fetchall()
    avg_by_pid = {r["player_id"]: (r["x"], r["y"]) for r in avg_rows}
    conn.close()

    buf = _io.StringIO()
    w = csv.writer(buf)
    w.writerow(["side","slot_order","position","shirt_number","player_id","player_name",
                "slot_label","slot_x","slot_y","avg_x","avg_y","is_starter"])
    for side_key in ("home", "away"):
        side = data.get(side_key) or {}
        slots = side.get("slots", [])
        for st in side.get("starters", []):
            so = st.get("slot_order")
            slot = slots[so] if so is not None and 0 <= so < len(slots) else {}
            ap = avg_by_pid.get(st.get("player_id"), (None, None))
            w.writerow([side_key, so, st.get("position",""), st.get("shirt_number",""),
                        st.get("player_id",""), st.get("name",""),
                        slot.get("label",""), slot.get("x",""), slot.get("y",""),
                        ap[0] if ap[0] is not None else "",
                        ap[1] if ap[1] is not None else "", 1])
        for sb in side.get("subs", []):
            ap = avg_by_pid.get(sb.get("player_id"), (None, None))
            w.writerow([side_key, "", sb.get("position",""), sb.get("shirt_number",""),
                        sb.get("player_id",""), sb.get("name",""), "", "", "",
                        ap[0] if ap[0] is not None else "",
                        ap[1] if ap[1] is not None else "", 0])
    out = buf.getvalue()
    dt = data.get("date", "match")
    home = (data.get("home") or {}).get("short") or "H"
    away = (data.get("away") or {}).get("short") or "A"
    fname = f"lineup_{dt}_{home}_vs_{away}_{eid}.csv"
    return out, 200, {
        "Content-Type": "text/csv; charset=utf-8-sig",
        "Content-Disposition": f'attachment; filename="{fname}"',
    }


# ── 자동 업데이트 스케줄러 ───────────────────────────────────────────────────

_KST = timezone(timedelta(hours=9))

_UPDATE_STATUS = {
    "last_run":    None,   # ISO 문자열 (KST)
    "last_result": None,   # "success" | "error"
    "last_msg":    "",
    "added":       0,      # 마지막 업데이트 시 추가된 경기 수
    "running":     False,
    "next_run":    None,   # ISO 문자열 (KST)
}


def _run_update_pipeline(triggered_by="scheduler"):
    """full update_data.py 실행 — score뿐 아니라 lineup/mps/heatmap/avg_pos/shotmap 전부 수집.
    (이전엔 update_results + sync 2개만 돌려 score만 갱신 → 전술 데이터가 자동 수집 안 됐음)"""
    if _UPDATE_STATUS["running"]:
        return {"ok": False, "msg": "이미 실행 중"}
    _UPDATE_STATUS["running"] = True
    _UPDATE_STATUS["last_run"] = datetime.now(_KST).strftime("%Y-%m-%d %H:%M KST")
    try:
        # SofaScore 수집 STEP은 playwright 필요 → 반드시 venv python (시스템 python엔 없음)
        venv_py = os.path.join(BASE_DIR, "venv", "bin", "python")
        py = venv_py if os.path.exists(venv_py) else "python"
        output_lines = []
        r = subprocess.run(
            [py, os.path.join(BASE_DIR, "update_data.py")],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=1800, cwd=BASE_DIR,   # full 파이프라인 ~17분, 여유 30분
        )
        output_lines.append(r.stdout.strip())
        if r.returncode != 0:
            raise RuntimeError(r.stderr[:300] or "update_data.py 실패")

        # 추가 경기 수 파싱 (sync 스크립트 출력에서)
        added = 0
        for line in "\n".join(output_lines).splitlines():
            if "삽입" in line:
                import re
                m = re.search(r"(\d+)", line)
                if m:
                    added = int(m.group(1))
                    break

        _UPDATE_STATUS["last_result"] = "success"
        _UPDATE_STATUS["last_msg"]    = f"경기 {added}건 추가 ({triggered_by})"
        _UPDATE_STATUS["added"]       = added
        # 백테스트 캐시 초기화 (새 데이터 반영)
        _BACKTEST_CACHE.clear()
        return {"ok": True, "added": added}
    except Exception as e:
        _UPDATE_STATUS["last_result"] = "error"
        _UPDATE_STATUS["last_msg"]    = str(e)[:120]
        return {"ok": False, "msg": str(e)[:120]}
    finally:
        _UPDATE_STATUS["running"] = False


def _scheduler_loop():
    """매일 23:00 KST 자동 실행 (K리그 최후 경기 종료 후)"""
    while True:
        now    = datetime.now(_KST)
        target = now.replace(hour=23, minute=0, second=0, microsecond=0)
        if now >= target:
            target += timedelta(days=1)
        _UPDATE_STATUS["next_run"] = target.strftime("%Y-%m-%d %H:%M KST")
        time.sleep((target - now).total_seconds())
        _run_update_pipeline(triggered_by="scheduler")


# Flask debug reloader 환경에서 워커 프로세스에서만 스레드 시작
if not os.environ.get("DISABLE_SCHEDULER") and (
    os.environ.get("WERKZEUG_RUN_MAIN") == "true" or not os.environ.get("FLASK_DEBUG")
):
    _sched_thread = threading.Thread(target=_scheduler_loop, daemon=True, name="auto-updater")
    _sched_thread.start()


@app.route("/api/goal-timing")
@cached_response(ttl=1800)
def goal_timing():
    """팀별 골 타이밍 분석 (15분 구간별 득점/실점)"""
    team_id_str = request.args.get("teamId")
    year        = request.args.get("year")

    team_info = next((t for t in TEAMS if t["id"] == team_id_str), None)
    if not team_info:
        return jsonify({"error": "team not found"}), 404

    ss_id = team_info["sofascore_id"]

    year_cond = ""
    yp: tuple = ()
    if year:
        year_cond = "AND strftime('%Y', datetime(e.date_ts,'unixepoch','localtime')) = ?"
        yp = (year,)

    bucket_expr = """
        CASE
            WHEN g.minute <= 15 THEN '1-15'
            WHEN g.minute <= 30 THEN '16-30'
            WHEN g.minute <= 45 THEN '31-45'
            WHEN g.minute <= 60 THEN '46-60'
            WHEN g.minute <= 75 THEN '61-75'
            WHEN g.minute = 90 AND g.added_time > 0 THEN '90+'
            WHEN g.minute <= 90 THEN '76-90'
            ELSE '90+'
        END
    """

    conn = sqlite3.connect(DB_PATH)
    cur  = conn.cursor()

    cur.execute(f"""
        SELECT {bucket_expr} AS bucket, COUNT(*) AS cnt
        FROM goal_events g
        JOIN events e ON g.event_id = e.id
        WHERE g.team_id = ? AND g.is_own_goal = 0
          AND (e.home_team_id = ? OR e.away_team_id = ?)
          {year_cond}
        GROUP BY bucket
    """, (ss_id, ss_id, ss_id) + yp)
    for_map = {r[0]: r[1] for r in cur.fetchall()}

    cur.execute(f"""
        SELECT {bucket_expr} AS bucket, COUNT(*) AS cnt
        FROM goal_events g
        JOIN events e ON g.event_id = e.id
        WHERE g.team_id != ? AND g.is_own_goal = 0
          AND (e.home_team_id = ? OR e.away_team_id = ?)
          {year_cond}
        GROUP BY bucket
    """, (ss_id, ss_id, ss_id) + yp)
    against_map = {r[0]: r[1] for r in cur.fetchall()}

    cur.execute("""
        SELECT DISTINCT strftime('%Y', datetime(e.date_ts,'unixepoch','localtime'))
        FROM goal_events g
        JOIN events e ON g.event_id = e.id
        WHERE (e.home_team_id = ? OR e.away_team_id = ?)
        ORDER BY 1
    """, (ss_id, ss_id))
    years = [r[0] for r in cur.fetchall()]

    conn.close()

    BUCKETS = ['1-15', '16-30', '31-45', '46-60', '61-75', '76-90', '90+']
    buckets = [{"label": b, "for": for_map.get(b, 0), "against": against_map.get(b, 0)} for b in BUCKETS]

    return jsonify({
        "buckets": buckets,
        "total_for":     sum(b["for"]     for b in buckets),
        "total_against": sum(b["against"] for b in buckets),
        "available_years": years,
    })


@app.route("/api/match-extras")
@cached_response(ttl=3600)
def match_extras():
    """
    경기별 평균 포지션 + 슛맵 데이터 반환.
    쿼리:
      - ?event_id=<int>
      - ?date=YYYY-MM-DD&home_slug=...&away_slug=...
    """
    event_id = request.args.get("event_id", "").strip()
    date_str = request.args.get("date", "").strip()
    home_slug = request.args.get("home_slug", "").strip()
    away_slug = request.args.get("away_slug", "").strip()

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    ev = None
    home_team = away_team = None
    if event_id:
        try:
            event_id = int(event_id)
        except ValueError:
            conn.close()
            return jsonify({"error": "event_id must be int"}), 400
        if event_id in EXCLUDED_EVENT_IDS:
            conn.close()
            return jsonify({"ready": False, "reason": "excluded_event", "event_id": event_id}), 404
        ev = cur.execute("SELECT id FROM events WHERE id = ?", (event_id,)).fetchone()
    elif date_str and home_slug and away_slug:
        dt_str = date_str.replace(".", "-")
        try:
            dt = datetime.strptime(dt_str, "%Y-%m-%d")
        except ValueError:
            conn.close()
            return jsonify({"error": "invalid date"}), 400
        start_ts, end_ts = int(dt.timestamp()), int(dt.timestamp()) + 86400
        home_team = next((t for t in TEAMS if t["id"] == home_slug), None)
        away_team = next((t for t in TEAMS if t["id"] == away_slug), None)
        if not home_team or not away_team:
            conn.close()
            return jsonify({"error": "unknown team slug"}), 400
        ev = cur.execute(f"""
            SELECT id FROM events
            WHERE id NOT IN {EXCLUDED_EVENT_IDS_SQL}
              AND date_ts >= ? AND date_ts < ?
              AND home_team_id = ? AND away_team_id = ?
            LIMIT 1
        """, (start_ts, end_ts, home_team["sofascore_id"], away_team["sofascore_id"])).fetchone()
    else:
        conn.close()
        return jsonify({"error": "event_id or (date+home_slug+away_slug) required"}), 400

    if not ev:
        conn.close()
        return jsonify({"ready": False, "reason": "event_not_found"}), 404

    eid = ev["id"]

    # 평균 포지션 + 라인업 join (한글이름·등번호·포지션 라벨)
    pos_rows = cur.execute("""
        SELECT ap.player_id, ap.is_home, ap.is_substitute, ap.x, ap.y,
               COALESCE(p.name_ko, ml.player_name, p.name) AS name,
               ml.shirt_number, ml.position,
               COALESCE(ml.is_starter, 0) AS is_starter
        FROM match_avg_positions ap
        LEFT JOIN match_lineups ml ON ml.event_id=ap.event_id AND ml.player_id=ap.player_id
        LEFT JOIN players p ON p.id=ap.player_id
        WHERE ap.event_id = ?
        ORDER BY ap.is_home DESC, ml.is_starter DESC, ml.slot_order
    """, (eid,)).fetchall()

    # 슛맵
    shot_rows = cur.execute("""
        SELECT s.shot_id, s.player_id, s.is_home, s.x, s.y, s.target_x, s.target_y,
               s.shot_type, s.body_part, s.situation, s.outcome, s.xg, s.time_min,
               COALESCE(p.name_ko, p.name) AS name
        FROM match_shotmap s
        LEFT JOIN players p ON p.id=s.player_id
        WHERE s.event_id = ?
        ORDER BY s.time_min, s.shot_id
    """, (eid,)).fetchall()

    # 교체 — SofaScore /incidents의 substitution event 직접 사용 (정확).
    # sub_events 테이블이 비어있는 옛 매치는 mins 추정 fallback.
    sub_events_check = cur.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='sub_events'"
    ).fetchone()
    real_subs = []
    if sub_events_check:
        real_subs = cur.execute("""
            SELECT se.is_home, se.minute, se.added_time,
                   se.player_in_id,  COALESCE(p_in.name_ko,  se.player_in_name,  p_in.name)  AS in_name,
                   ml_in.shirt_number  AS in_shirt,  ml_in.position  AS in_pos,
                   se.player_out_id, COALESCE(p_out.name_ko, se.player_out_name, p_out.name) AS out_name,
                   ml_out.shirt_number AS out_shirt, ml_out.position AS out_pos
            FROM sub_events se
            LEFT JOIN players p_in  ON p_in.id  = se.player_in_id
            LEFT JOIN players p_out ON p_out.id = se.player_out_id
            LEFT JOIN match_lineups ml_in
                ON ml_in.event_id  = se.event_id AND ml_in.player_id  = se.player_in_id
            LEFT JOIN match_lineups ml_out
                ON ml_out.event_id = se.event_id AND ml_out.player_id = se.player_out_id
            WHERE se.event_id = ?
            ORDER BY se.minute, se.added_time
        """, (eid,)).fetchall()

    if real_subs:
        # SofaScore 직접 데이터 사용 — OUT/IN/시각 정확
        subs = []
        for r in real_subs:
            minute = int(r["minute"] or 0)
            subs.append({
                "is_home": int(r["is_home"] or 0),
                "minute":  minute,
                "out": {
                    "player_id": r["player_out_id"],
                    "name":      r["out_name"] or "",
                    "shirt":     r["out_shirt"],
                    "position":  r["out_pos"],
                    "mins":      minute,
                } if r["player_out_id"] else None,
                "in": {
                    "player_id": r["player_in_id"],
                    "name":      r["in_name"] or "",
                    "shirt":     r["in_shirt"],
                    "position":  r["in_pos"],
                    "mins":      max(0, 90 - minute),
                } if r["player_in_id"] else None,
            })
        subs.sort(key=lambda s: (s["minute"], -s["is_home"]))
    else:
        # Fallback — sub_events 미수집 매치는 mps mins 추정 페어 매칭
        sub_rows = cur.execute("""
            SELECT ml.player_id, ml.is_home,
                   COALESCE(mps.minutes_played, 0) AS minutes_played,
                   COALESCE(p.name_ko, ml.player_name, p.name) AS name,
                   ml.shirt_number, ml.position, ml.is_starter
            FROM match_lineups ml
            LEFT JOIN match_player_stats mps ON mps.event_id=ml.event_id AND mps.player_id=ml.player_id
            LEFT JOIN players p ON p.id=ml.player_id
            WHERE ml.event_id = ?
        """, (eid,)).fetchall()

        from collections import defaultdict
        side_groups = defaultdict(lambda: {"out": [], "in": []})
        for r in sub_rows:
            mins = r["minutes_played"] or 0
            info = {
                "mins": mins,
                "player_id": r["player_id"],
                "name": r["name"] or "",
                "shirt": r["shirt_number"],
                "position": r["position"],
            }
            if r["is_starter"] and 0 < mins < 90:
                side_groups[r["is_home"]]["out"].append(info)
            elif not r["is_starter"] and mins > 0:
                side_groups[r["is_home"]]["in"].append(info)

        subs = []
        for is_home, grp in side_groups.items():
            outs = sorted(grp["out"], key=lambda x: -x["mins"])
            ins  = sorted(grp["in"],  key=lambda x:  x["mins"])
            n = max(len(outs), len(ins))
            for k in range(n):
                o = outs[k] if k < len(outs) else None
                i = ins[k]  if k < len(ins)  else None
                if o:
                    minute = max(1, o["mins"])
                elif i:
                    minute = max(1, 90 - i["mins"])
                else:
                    minute = 0
                subs.append({
                    "is_home": int(is_home),
                    "minute":  int(minute),
                    "out":     o,
                    "in":      i,
                })

        subs.sort(key=lambda s: (s["minute"], -s["is_home"]))

    conn.close()

    return jsonify({
        "ready":         True,
        "event_id":      eid,
        "avg_positions": [dict(r) for r in pos_rows],
        "shots":         [dict(r) for r in shot_rows],
        "subs":          subs,
    })


@app.route("/api/match-retrospective")
@cached_response(ttl=3600)
def match_retrospective():
    """finished 매치 사후 분석 — 실제 결과 + xG/세트피스/PK/자책골/레드카드.
    프론트가 prediction 응답과 비교해 적중·실패 핀인을 생성한다.
    """
    event_id = request.args.get("event_id", "").strip()
    date_str = request.args.get("date", "").strip()
    home_slug = request.args.get("home_slug", "").strip()
    away_slug = request.args.get("away_slug", "").strip()

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    ev = None
    if event_id:
        try:
            event_id = int(event_id)
        except ValueError:
            conn.close()
            return jsonify({"error": "event_id must be int"}), 400
        if event_id in EXCLUDED_EVENT_IDS:
            conn.close()
            return jsonify({"ready": False, "reason": "excluded_event", "event_id": event_id}), 404
        ev = cur.execute("""
            SELECT id, home_score, away_score FROM events WHERE id = ?
        """, (event_id,)).fetchone()
    elif date_str and home_slug and away_slug:
        dt_str = date_str.replace(".", "-")
        try:
            dt = datetime.strptime(dt_str, "%Y-%m-%d")
        except ValueError:
            conn.close()
            return jsonify({"error": "invalid date"}), 400
        start_ts, end_ts = int(dt.timestamp()), int(dt.timestamp()) + 86400
        home_team = next((t for t in TEAMS if t["id"] == home_slug), None)
        away_team = next((t for t in TEAMS if t["id"] == away_slug), None)
        if not home_team or not away_team:
            conn.close()
            return jsonify({"error": "unknown team slug"}), 400
        ev = cur.execute(f"""
            SELECT id, home_score, away_score FROM events
            WHERE id NOT IN {EXCLUDED_EVENT_IDS_SQL}
              AND date_ts >= ? AND date_ts < ?
              AND home_team_id = ? AND away_team_id = ?
            LIMIT 1
        """, (start_ts, end_ts, home_team["sofascore_id"], away_team["sofascore_id"])).fetchone()
    else:
        conn.close()
        return jsonify({"error": "event_id or (date+home_slug+away_slug) required"}), 400

    if not ev or ev["home_score"] is None or ev["away_score"] is None:
        conn.close()
        return jsonify({"ready": False, "reason": "not_finished"}), 404

    eid = ev["id"]

    # xG sum (shotmap 기반, K1/K2 공통)
    xg_row = cur.execute("""
        SELECT
            ROUND(SUM(CASE WHEN is_home=1 THEN COALESCE(xg,0) ELSE 0 END), 2) AS xg_home,
            ROUND(SUM(CASE WHEN is_home=0 THEN COALESCE(xg,0) ELSE 0 END), 2) AS xg_away,
            SUM(CASE WHEN is_home=1 THEN 1 ELSE 0 END) AS shots_home,
            SUM(CASE WHEN is_home=0 THEN 1 ELSE 0 END) AS shots_away,
            SUM(CASE WHEN is_home=1 AND shot_type='goal' THEN 1 ELSE 0 END) AS goals_home_shotmap,
            SUM(CASE WHEN is_home=0 AND shot_type='goal' THEN 1 ELSE 0 END) AS goals_away_shotmap
        FROM match_shotmap WHERE event_id = ?
    """, (eid,)).fetchone()

    # 골 incidents
    g_row = cur.execute("""
        SELECT
            SUM(CASE WHEN is_home=1 AND goal_type='fromSetPiece' THEN 1 ELSE 0 END) AS sp_home,
            SUM(CASE WHEN is_home=0 AND goal_type='fromSetPiece' THEN 1 ELSE 0 END) AS sp_away,
            SUM(CASE WHEN is_home=1 AND goal_type='penalty' THEN 1 ELSE 0 END) AS pk_home,
            SUM(CASE WHEN is_home=0 AND goal_type='penalty' THEN 1 ELSE 0 END) AS pk_away,
            SUM(CASE WHEN is_home=1 AND is_own_goal=1 THEN 1 ELSE 0 END) AS og_home,
            SUM(CASE WHEN is_home=0 AND is_own_goal=1 THEN 1 ELSE 0 END) AS og_away
        FROM goal_events WHERE event_id = ?
    """, (eid,)).fetchone()

    # 레드카드 (조기 퇴장이 매치 흐름에 영향)
    rc_row = cur.execute("""
        SELECT
            SUM(CASE WHEN is_home=1 AND card_type IN ('red','yellowRed') THEN 1 ELSE 0 END) AS rc_home,
            SUM(CASE WHEN is_home=0 AND card_type IN ('red','yellowRed') THEN 1 ELSE 0 END) AS rc_away,
            MIN(CASE WHEN card_type IN ('red','yellowRed') THEN minute END) AS earliest_min
        FROM card_events WHERE event_id = ?
    """, (eid,)).fetchone()

    conn.close()

    return jsonify({
        "ready": True,
        "event_id": eid,
        "result": {"home": ev["home_score"], "away": ev["away_score"]},
        "xg": {
            "home": xg_row["xg_home"] or 0,
            "away": xg_row["xg_away"] or 0,
            "shots_home": xg_row["shots_home"] or 0,
            "shots_away": xg_row["shots_away"] or 0,
        },
        "setpiece": {"home": g_row["sp_home"] or 0, "away": g_row["sp_away"] or 0},
        "penalty":  {"home": g_row["pk_home"] or 0, "away": g_row["pk_away"] or 0},
        "owngoal":  {"home": g_row["og_home"] or 0, "away": g_row["og_away"] or 0},
        "redcard":  {
            "home": rc_row["rc_home"] or 0,
            "away": rc_row["rc_away"] or 0,
            "earliest_min": rc_row["earliest_min"],
        },
    })


@app.route("/api/update-status")
def get_update_status():
    return jsonify(_UPDATE_STATUS)


@app.route("/api/cache-invalidate")
def cache_invalidate():
    """API 인메모리 캐시 강제 무효화 + 백그라운드 워밍업 재실행.
    update_data.py 종료 후 신규 매치 반영 위해 호출.
    허용 경로: ① 127.x 직접 호출 + X-Forwarded-For 없음(로컬 프로세스)
              ② UPDATE_SECRET 인증 통과 (X-Update-Secret 헤더 또는 ?secret=)
    nginx 경유 요청은 X-Forwarded-For가 주입되므로 ①로 우회 불가 (P7).
    """
    from flask import request as _req
    remote = _req.remote_addr or ""
    forwarded_for = _req.headers.get("X-Forwarded-For", "")
    is_local = (remote.startswith("127.") or remote == "::1") and not forwarded_for

    if not is_local:
        import hmac
        secret = os.environ.get("UPDATE_SECRET")
        token = _req.headers.get("X-Update-Secret") or _req.args.get("secret", "")
        if not secret or not token or not hmac.compare_digest(token, secret):
            return ("forbidden", 403)

    n = len(_API_CACHE)
    invalidate_api_cache()
    threading.Thread(target=_warm_cache, daemon=True).start()
    return jsonify({"ok": True, "cleared": n, "rewarming": True})


@app.route("/api/trigger-update", methods=["POST"])
def trigger_update():
    # fail-closed: UPDATE_SECRET 미설정이면 엔드포인트 자체를 비활성화 (P7 권고)
    secret = os.environ.get("UPDATE_SECRET")
    if not secret:
        return jsonify({"ok": False, "msg": "서비스 비활성화 (관리자 설정 필요)"}), 503
    token = request.headers.get("X-Update-Secret") or request.args.get("secret", "")
    # 상수 시간 비교로 타이밍 공격 방지
    import hmac
    if not hmac.compare_digest(token, secret):
        return jsonify({"ok": False, "msg": "인증 실패"}), 403
    if _UPDATE_STATUS["running"]:
        return jsonify({"ok": False, "msg": "이미 실행 중입니다"})
    t = threading.Thread(target=_run_update_pipeline, kwargs={"triggered_by": "manual"}, daemon=True)
    t.start()
    return jsonify({"ok": True, "msg": "업데이트를 시작했습니다"})


def _warm_cache():
    """서버 시작 시 백그라운드로 무거운 API 미리 호출 — 첫 사용자 대기 시간 제거.
    K1/K2 백테스트 + 스케줄/라운드 + 시즌 시뮬 + 라운드 예측 — 워밍업 후 영구 빠름.
    모든 URL을 병렬 스레드로 동시 호출 → 총 대기 시간 = max(개별 시간).
    """
    import urllib.request, time as _t
    warm_urls = [
        # 시즌 시뮬 + 백테스트 (가장 무거움, 15s 단위)
        "http://127.0.0.1:5000/api/prediction-backtest?league=k1&year=2026",
        "http://127.0.0.1:5000/api/prediction-backtest?league=k2&year=2026",
        "http://127.0.0.1:5000/api/season-simulation?league=k1&n=500",
        "http://127.0.0.1:5000/api/season-simulation?league=k2&n=500",
        # K리그 스케줄·라운드 (첫 화면 진입 호출)
        "http://127.0.0.1:5000/api/k1/schedule",
        "http://127.0.0.1:5000/api/k2/schedule",
        "http://127.0.0.1:5000/api/k1/rounds",
        "http://127.0.0.1:5000/api/k2/rounds",
        # 첫 화면 핵심 위젯 (순위·다음 라운드·매치 by date·대시보드)
        "http://127.0.0.1:5000/api/standings?league=K1",
        "http://127.0.0.1:5000/api/standings?league=K2",
        "http://127.0.0.1:5000/api/next-round?league=K1",
        "http://127.0.0.1:5000/api/next-round?league=K2",
        "http://127.0.0.1:5000/api/league-dashboard?league=K1",
        "http://127.0.0.1:5000/api/league-dashboard?league=K2",
        "http://127.0.0.1:5000/api/matches-by-date",
        # 인사이트 드로어 (사용자 자주 진입)
        "http://127.0.0.1:5000/api/insights/top-performers?league=K1",
        "http://127.0.0.1:5000/api/insights/top-performers?league=K2",
        "http://127.0.0.1:5000/api/insights/xg-efficiency?league=K1",
        "http://127.0.0.1:5000/api/insights/forward-goals?league=K1",
        "http://127.0.0.1:5000/api/insights/midfielder-pass?league=K1",
        "http://127.0.0.1:5000/api/insights/defender-score?league=K1",
        "http://127.0.0.1:5000/api/insights/card-rankings?league=K1",
    ]
    _t.sleep(2)  # 서버 listen 대기 (3→2초)
    def _fetch(u):
        try:
            urllib.request.urlopen(u, timeout=120).read()
        except Exception:
            pass
    threads = [threading.Thread(target=_fetch, args=(u,), daemon=True) for u in warm_urls]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=120)


# 서버 부팅 후 자동 워밍업 (production gunicorn에서도 동작)
threading.Thread(target=_warm_cache, daemon=True).start()


if __name__ == "__main__":
    app.run(debug=True, port=5000)
