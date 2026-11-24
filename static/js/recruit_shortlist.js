/* recruit_shortlist.js — 영입 추천 '후보 목록' (2026-11-24)
 * 팀별 후보 담기(localStorage, 팀당 최대 10명) · 비교 패널 HTML · CSV 내보내기.
 * 담는 순간의 스냅샷을 저장(국내·해외 후보를 함께 다시 조회할 API가 없어서) — 담은 날짜를 같이 보여 준다.
 * localStorage 값은 사용자가 조작할 수 있는 입력 — 읽을 때 sanitize, 그릴 때 esc(ttEsc).
 * 순수 로직이라 node 테스트(tests/js/recruit_shortlist.test.js) — storage 를 인자로 받는다. */
(function (root) {
    "use strict";
    const KEY = "tt_recruit_shortlist_v1";
    const MAX = 10;
    const STR_MAX = 120;
    const NUMS = ["age", "mins", "goals", "assists", "score", "fit"];
    const STRS = ["team", "league", "detail", "fitLabel", "mode", "saved"];

    function str(v) { return typeof v === "string" ? v.slice(0, STR_MAX) : ""; }
    function num(v) {
        if (v === null || v === undefined || v === "") return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    }

    function entryId(e) {
        return e.src === "kr" ? `kr:${e.player_id}` : `os:${e.name}|${e.team || ""}`;
    }

    function sanitize(raw) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
        if (raw.src !== "kr" && raw.src !== "os") return null;
        const name = str(raw.name).trim();
        if (!name) return null;
        const e = { src: raw.src, name };
        if (raw.src === "kr") {
            const pid = Number(raw.player_id);
            if (!Number.isInteger(pid) || pid <= 0) return null;
            e.player_id = pid;
        }
        STRS.forEach(k => { e[k] = str(raw[k]); });
        NUMS.forEach(k => { e[k] = num(raw[k]); });
        e.metrics = (Array.isArray(raw.metrics) ? raw.metrics : [])
            .filter(m => m && typeof m === "object" && typeof m.label === "string" && m.label)
            .slice(0, 8)
            .map(m => ({ label: str(m.label), pct: num(m.pct) }));
        return e;
    }

    function load(storage) {
        let obj;
        try { obj = JSON.parse(storage.getItem(KEY) || "{}"); } catch (_) { return {}; }
        if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
        const out = {};
        Object.keys(obj).forEach(team => {
            if (!Array.isArray(obj[team])) return;
            const seen = new Set();
            const list = [];
            obj[team].forEach(r => {
                const e = sanitize(r);
                if (!e) return;
                const id = entryId(e);
                if (seen.has(id) || list.length >= MAX) return;
                seen.add(id); list.push(e);
            });
            out[team] = list;
        });
        return out;
    }

    function save(storage, all) {
        try { storage.setItem(KEY, JSON.stringify(all)); return true; } catch (_) { return false; }
    }

    // 버튼이 가리키는 표 스냅샷 행 — 인덱스와 버튼의 id 가 일치할 때만(늦게 온 응답이 행 배열을 바꾼 경우 방어)
    function pick(rows, idx, id) {
        const e = Array.isArray(rows) ? rows[idx] : null;
        return e && entryId(e) === id ? e : null;
    }

    function list(storage, team) { return load(storage)[team] || []; }
    function has(storage, team, id) { return list(storage, team).some(e => entryId(e) === id); }

    function add(storage, team, entry) {
        const e = sanitize(entry);
        if (!e) return "invalid";
        const all = load(storage);
        const cur = all[team] || [];
        if (cur.some(x => entryId(x) === entryId(e))) return "exists";
        if (cur.length >= MAX) return "full";
        all[team] = cur.concat([e]);
        return save(storage, all) ? "added" : "invalid";
    }

    function remove(storage, team, id) {
        const all = load(storage);
        if (!all[team]) return;
        all[team] = all[team].filter(e => entryId(e) !== id);
        save(storage, all);
    }

    function clear(storage, team) {
        const all = load(storage);
        delete all[team];
        save(storage, all);
    }

    // ── CSV ── 엑셀 수식 인젝션 방어: = + - @ 탭 CR 로 시작하면 ' 접두
    function csvCell(v) {
        let s = v === null || v === undefined ? "" : String(v);
        if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
        return `"${s.replace(/"/g, '""')}"`;
    }
    const HEAD = ["구분", "이름", "소속", "리그", "나이", "출전", "골", "도움", "세부 포지션", "점수 이름", "점수", "지표", "추천 방식", "담은 날짜"];
    const MODE_LBL = { position: "포지션 보강", style: "플레이 보강", similar: "비슷한 선수" };
    function toCsv(entries) {
        const rows = [HEAD].concat(entries.map(e => [
            e.src === "kr" ? "국내" : "해외", e.name, e.team, e.league, e.age, e.mins, e.goals, e.assists,
            e.detail, e.fitLabel, e.fit,
            (e.metrics || []).map(m => `${m.label}:${m.pct == null ? "-" : m.pct}`).join(";"),
            MODE_LBL[e.mode] || e.mode, e.saved,
        ]));
        return "﻿" + rows.map(r => r.map(csvCell).join(",")).join("\r\n");
    }
    function csvName(teamName, date) {
        const t = String(teamName || "팀").replace(/[\/\\:*?"<>|]/g, "_");
        return `영입후보_${t}_${String(date || "").replace(/-/g, "")}.csv`;
    }

    // ── 비교 패널 ── 국내·해외 구역 분리(지표 정의가 달라 같은 줄 비교 금지)
    function cardHtml(e, esc) {
        const id = entryId(e);
        const v = (x, unit) => (x == null ? "-" : esc(x) + (unit || ""));
        const metrics = (e.metrics || []).map(m => {
            const p = m.pct == null ? 0 : Math.max(0, Math.min(100, m.pct));
            return `<li><span>${esc(m.label)}</span><span class="rc-pbar" aria-hidden="true"><i style="width:${p}%"></i></span><b>${v(m.pct)}</b></li>`;
        }).join("");
        return `<article class="rc-sl-card">
            <div class="rc-sl-card-head"><b class="rc-sl-name">${esc(e.name)}</b>
                <button type="button" class="rc-sl-x" data-sl-remove="${esc(id)}" aria-label="후보 목록에서 빼기: ${esc(e.name)}">✕</button></div>
            <div class="rc-sub">${esc(e.team)}${e.league ? " · " + esc(e.league) : ""}${e.detail ? " · " + esc(e.detail) : ""}</div>
            <dl class="rc-sl-facts">
                <div><dt>나이</dt><dd>${v(e.age)}</dd></div><div><dt>출전</dt><dd>${v(e.mins, "분")}</dd></div>
                <div><dt>골·도움</dt><dd>${v(e.goals)}·${v(e.assists)}</dd></div>
                <div><dt>${esc(e.fitLabel || "점수")}</dt><dd><b>${v(e.fit)}</b></dd></div>
            </dl>
            ${metrics ? `<ul class="rc-sl-metrics">${metrics}</ul>` : ""}
            <div class="rc-sl-saved rc-muted">${[MODE_LBL[e.mode] || e.mode, e.saved ? "담은 날짜 " + e.saved : ""].filter(Boolean).map(esc).join(" · ")}</div>
        </article>`;
    }
    function panelHtml(entries, esc) {
        if (!entries.length) return `<p class="rc-empty">담은 후보가 없습니다 — 후보 표에서 ☆를 눌러 담으세요.</p>`;
        const sec = (title, list, note) => list.length ? `<section class="rc-sl-sec" aria-label="${title}">
            <h4>${title} <span class="rc-muted">${list.length}명</span></h4>${note || ""}
            <div class="rc-sl-cards">${list.map(e => cardHtml(e, esc)).join("")}</div></section>` : "";
        const kr = entries.filter(e => e.src === "kr"), os = entries.filter(e => e.src === "os");
        return sec("국내 후보", kr) +
            sec("해외 후보", os, `<p class="rc-sl-note">지표 정의가 다른 리그(해외 API)라 국내 후보와 수치를 직접 비교하지 마세요.</p>`) +
            `<div class="rc-sl-actions"><button type="button" class="rc-sl-act" data-sl-csv>CSV 내보내기</button>
                <button type="button" class="rc-sl-act rc-sl-act--danger" data-sl-clear>모두 비우기</button></div>`;
    }

    const api = { KEY, MAX, entryId, pick, sanitize, load, save, list, has, add, remove, clear, csvCell, toCsv, csvName, panelHtml };
    if (root) root.ttShortlist = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : null);
