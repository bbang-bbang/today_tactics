(function () {
    "use strict";

    const PITCH_RATIO = 105 / 68;
    const DEFAULT_A_COLOR = "BLUE";
    const DEFAULT_B_COLOR = "RED";
    const PLAYER_RADIUS = 16;
    const FIELD_GREEN = "#2d8a4e";
    const LINE_COLOR = "#ffffffcc";

    // ── State ──────────────────────────────────────────────
    const state = {
        mode: "select",         // "select" | "draw"
        drawStyle: "arrow",     // "arrow" | "dashedArrow" | "line" | "dashedLine"
        drawColor: "rgba(255,255,255,0.85)",
        players: [],            // {id, team, x, y, name, number}
        lines: [],              // {sx,sy,ex,ey, style, color, layer}
        activeLayer: 1,         // 현재 그리기 레이어 (1|2|3)
        layerVisible: { 1: true, 2: true, 3: true }, // 레이어별 가시성
        animations: [],         // {player, line, progress, duration}
        multiPoints: null,      // [{fx,fy},...] when drawing multi-point path
        multiPreviewEnd: null,  // {px,py} canvas coords of current mouse for preview
        dragging: null,
        dragOffset: { dx: 0, dy: 0 },
        drawingLine: null,
        draggingCurve: null,    // {line, t, px, py, moved}
        balls: [],               // [{id, x, y}] 드래그 가능한 축구공
        draggingBall: null,
        slots: { A: [], B: [] },  // 포메이션 슬롯 { idx, x, y, label, team }
        formations: {},
        formationA: "4-4-2",
        formationB: "4-4-2",
        teams: [],
        teamA: null,
        teamB: null,
        kitA: "home",           // "home" | "away"
        kitB: "home",
        nextId: 100,
        animSpeed: 1.0,
        highlightPlayerId: null, // 개인 강조 모드: 이 선수만 하이라이트
        showRoleTags: true,      // 롤 태그 기본 표시 (4-3-3 LW/RW vs 4-2-3-1 CDM/AM 구분용)
    };

    const canvas = document.getElementById("field");
    const ctx = canvas.getContext("2d");

    // ── Coordinate helpers ─────────────────────────────────
    const pad = 12;
    function fieldRect() { return { x: pad, y: pad, w: canvas.width - 2 * pad, h: canvas.height - 2 * pad }; }
    function fieldToCanvas(fx, fy) { const r = fieldRect(); return { px: r.x + fx * r.w, py: r.y + fy * r.h }; }
    function canvasToField(px, py) {
        const r = fieldRect();
        return { fx: Math.max(0, Math.min(1, (px - r.x) / r.w)), fy: Math.max(0, Math.min(1, (py - r.y) / r.h)) };
    }

    // ── Resize ─────────────────────────────────────────────
    function resize() {
        const container = document.getElementById("canvas-container");
        const toolbar = document.getElementById("left-toolbar");
        const bench = document.getElementById("bench-panel");
        const hud = document.getElementById("formation-hud");
        const toolbarW = toolbar ? toolbar.offsetWidth : 0;
        const benchW = bench ? bench.offsetWidth : 0;
        // HUD + gap(10px) 만큼 캔버스 세로 공간 축소
        const hudH = hud ? hud.offsetHeight + 10 : 0;
        const maxW = container.clientWidth - 32 - toolbarW - benchW;
        const maxH = container.clientHeight - 32 - hudH;
        let w = maxW, h = w / PITCH_RATIO;
        if (h > maxH) { h = maxH; w = h * PITCH_RATIO; }
        canvas.width = Math.floor(w);
        canvas.height = Math.floor(h);
        render();
    }

    // ── Draw field ─────────────────────────────────────────
    function drawField() {
        const r = fieldRect();
        ctx.fillStyle = FIELD_GREEN;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        const stripeCount = 12;
        for (let i = 0; i < stripeCount; i++) {
            if (i % 2 === 0) continue;
            ctx.fillStyle = "rgba(255,255,255,0.03)";
            ctx.fillRect(r.x + i * (r.w / stripeCount), r.y, r.w / stripeCount, r.h);
        }
        ctx.strokeStyle = LINE_COLOR; ctx.lineWidth = 2;
        ctx.strokeRect(r.x, r.y, r.w, r.h);
        const cx = r.x + r.w / 2;
        ctx.beginPath(); ctx.moveTo(cx, r.y); ctx.lineTo(cx, r.y + r.h); ctx.stroke();
        const ccr = (9.15 / 105) * r.w;
        ctx.beginPath(); ctx.arc(cx, r.y + r.h / 2, ccr, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = LINE_COLOR; ctx.beginPath(); ctx.arc(cx, r.y + r.h / 2, 3, 0, Math.PI * 2); ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = LINE_COLOR;
        const paW = (16.5 / 105) * r.w, paH = (40.32 / 68) * r.h, paY = r.y + (r.h - paH) / 2;
        ctx.strokeRect(r.x, paY, paW, paH); ctx.strokeRect(r.x + r.w - paW, paY, paW, paH);
        const gaW = (5.5 / 105) * r.w, gaH = (18.32 / 68) * r.h, gaY = r.y + (r.h - gaH) / 2;
        ctx.strokeRect(r.x, gaY, gaW, gaH); ctx.strokeRect(r.x + r.w - gaW, gaY, gaW, gaH);
        const psD = (11 / 105) * r.w;
        ctx.fillStyle = LINE_COLOR;
        for (const px of [r.x + psD, r.x + r.w - psD]) { ctx.beginPath(); ctx.arc(px, r.y + r.h / 2, 3, 0, Math.PI * 2); ctx.fill(); }
        const arcR = (9.15 / 105) * r.w, arcAngle = Math.acos(paW / arcR);
        ctx.beginPath(); ctx.arc(r.x + psD, r.y + r.h / 2, arcR, -arcAngle, arcAngle); ctx.stroke();
        ctx.beginPath(); ctx.arc(r.x + r.w - psD, r.y + r.h / 2, arcR, Math.PI - arcAngle, Math.PI + arcAngle); ctx.stroke();
        const car = (1 / 105) * r.w;
        [[r.x, r.y, 0, Math.PI / 2], [r.x + r.w, r.y, Math.PI / 2, Math.PI],
         [r.x + r.w, r.y + r.h, Math.PI, Math.PI * 1.5], [r.x, r.y + r.h, Math.PI * 1.5, Math.PI * 2]].forEach(([x, y, sa, ea]) => {
            ctx.beginPath(); ctx.arc(x, y, car, sa, ea); ctx.stroke();
        });
        const goalH = (7.32 / 68) * r.h, goalW = 6, goalY = r.y + (r.h - goalH) / 2;
        ctx.fillStyle = "rgba(255,255,255,0.15)";
        ctx.fillRect(r.x - goalW, goalY, goalW, goalH); ctx.fillRect(r.x + r.w, goalY, goalW, goalH);
        ctx.strokeRect(r.x - goalW, goalY, goalW, goalH); ctx.strokeRect(r.x + r.w, goalY, goalW, goalH);
    }

    // ── Draw lines/arrows ─────────────────────────────────
    function drawArrowHead(fromX, fromY, toX, toY, color) {
        const angle = Math.atan2(toY - fromY, toX - fromX), headLen = 12;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(toX, toY);
        ctx.lineTo(toX - headLen * Math.cos(angle - 0.4), toY - headLen * Math.sin(angle - 0.4));
        ctx.lineTo(toX - headLen * Math.cos(angle + 0.4), toY - headLen * Math.sin(angle + 0.4));
        ctx.closePath(); ctx.fill();
    }

    function drawOneLine(sx, sy, ex, ey, style, color, isPreview) {
        const from = fieldToCanvas(sx, sy), to = fieldToCanvas(ex, ey);
        const isDashed = style === "dashedArrow" || style === "dashedLine";
        const hasArrow = style === "arrow" || style === "dashedArrow";

        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = 2.5;
        ctx.setLineDash(isDashed ? [10, 7] : []);
        if (isPreview) ctx.globalAlpha = 0.6;

        ctx.beginPath(); ctx.moveTo(from.px, from.py); ctx.lineTo(to.px, to.py); ctx.stroke();
        ctx.setLineDash([]);

        if (hasArrow) drawArrowHead(from.px, from.py, to.px, to.py, color);
        ctx.globalAlpha = 1.0;
    }

    function calcCurveControlPoint(sx, sy, ex, ey) {
        const from = fieldToCanvas(sx, sy), to = fieldToCanvas(ex, ey);
        const mx = (from.px + to.px) / 2, my = (from.py + to.py) / 2;
        const dx = to.px - from.px, dy = to.py - from.py;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < 1) return { cx: sx, cy: sy };
        const offset = len * 0.3;
        const cp = canvasToField(mx - dy / len * offset, my + dx / len * offset);
        return { cx: cp.fx, cy: cp.fy };
    }

    function drawCurvedLine(sx, sy, cx, cy, ex, ey, color, isPreview) {
        const from = fieldToCanvas(sx, sy), ctrl = fieldToCanvas(cx, cy), to = fieldToCanvas(ex, ey);
        ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.setLineDash([]);
        if (isPreview) ctx.globalAlpha = 0.6;
        ctx.beginPath();
        ctx.moveTo(from.px, from.py);
        ctx.quadraticCurveTo(ctrl.px, ctrl.py, to.px, to.py);
        ctx.stroke();
        const tx = to.px - ctrl.px, ty = to.py - ctrl.py;
        const tlen = Math.sqrt(tx * tx + ty * ty);
        if (tlen > 0) drawArrowHead(to.px - tx / tlen * 20, to.py - ty / tlen * 20, to.px, to.py, color);
        ctx.globalAlpha = 1;
    }

    function drawMultiLine(points, color, isPreview, previewEnd) {
        if (points.length < 1) return;
        const all = points.map(p => fieldToCanvas(p.fx, p.fy));
        if (previewEnd) all.push(previewEnd);
        ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.setLineDash([]);
        if (isPreview) ctx.globalAlpha = 0.6;
        ctx.beginPath();
        ctx.moveTo(all[0].px, all[0].py);
        for (let i = 1; i < all.length; i++) ctx.lineTo(all[i].px, all[i].py);
        ctx.stroke();
        if (all.length >= 2) drawArrowHead(all[all.length - 2].px, all[all.length - 2].py, all[all.length - 1].px, all[all.length - 1].py, color);
        // 중간 꺾임 점 표시
        for (let i = 1; i < all.length - (previewEnd ? 0 : 1); i++) {
            ctx.beginPath(); ctx.arc(all[i].px, all[i].py, 3, 0, Math.PI * 2);
            ctx.fillStyle = color; ctx.fill();
        }
        ctx.globalAlpha = 1;
    }

    function closestTOnBezier(line, px, py) {
        let bestT = 0.5, bestDist = Infinity;
        for (let i = 0; i <= 20; i++) {
            const t = i / 20;
            const pt = getBezierPoint(line, t);
            const c = fieldToCanvas(pt.x, pt.y);
            const d = Math.sqrt((px - c.px) ** 2 + (py - c.py) ** 2);
            if (d < bestDist) { bestDist = d; bestT = t; }
        }
        return bestT;
    }

    function controlPointFromDrag(line, t, fx, fy) {
        const denom = 2 * t * (1 - t);
        if (denom < 0.01) return { cx: line.cx, cy: line.cy };
        return {
            cx: (fx - (1 - t) ** 2 * line.sx - t ** 2 * line.ex) / denom,
            cy: (fy - (1 - t) ** 2 * line.sy - t ** 2 * line.ey) / denom,
        };
    }

    function drawLines() {
        for (const l of state.lines) {
            const lyr = l.layer || 1;
            if (!state.layerVisible[lyr]) continue;
            if (l.style === 'curvedArrow') {
                drawCurvedLine(l.sx, l.sy, l.cx, l.cy, l.ex, l.ey, l.color, false);
            } else if (l.style === 'multiArrow') drawMultiLine(l.points, l.color, false, null);
            else drawOneLine(l.sx, l.sy, l.ex, l.ey, l.style, l.color, false);
            // 전술 노트 렌더링
            if (l.note) {
                let mx, my;
                if (l.style === 'curvedArrow') {
                    const mid = fieldToCanvas((l.sx + l.ex) / 2 * 0.5 + l.cx * 0.5, (l.sy + l.ey) / 2 * 0.5 + l.cy * 0.5);
                    mx = mid.px; my = mid.py;
                } else if (l.style === 'multiArrow' && l.points.length >= 2) {
                    const mi = Math.floor(l.points.length / 2);
                    const mid = fieldToCanvas(l.points[mi].fx, l.points[mi].fy);
                    mx = mid.px; my = mid.py;
                } else {
                    const mid = fieldToCanvas((l.sx + l.ex) / 2, (l.sy + l.ey) / 2);
                    mx = mid.px; my = mid.py;
                }
                ctx.save();
                ctx.font = "bold 9px 'Segoe UI', sans-serif";
                ctx.textAlign = "center"; ctx.textBaseline = "bottom";
                const tw = ctx.measureText(l.note).width;
                ctx.fillStyle = "rgba(0,0,0,0.7)";
                ctx.fillRect(mx - tw / 2 - 4, my - 14, tw + 8, 16);
                ctx.fillStyle = "#ffd700";
                ctx.fillText(l.note, mx, my);
                ctx.restore();
            }
        }
        if (state.drawingLine) {
            const l = state.drawingLine;
            if (l.style === 'curvedArrow') {
                if (l.phase === 'curve') drawCurvedLine(l.sx, l.sy, l.cx, l.cy, l.ex, l.ey, l.color, true);
                else drawOneLine(l.sx, l.sy, l.ex, l.ey, l.style, l.color, true); // phase 'end': 직선 프리뷰
            } else {
                drawOneLine(l.sx, l.sy, l.ex, l.ey, l.style, l.color, true);
            }
        }
        if (state.multiPoints && state.multiPoints.length > 0) {
            drawMultiLine(state.multiPoints, state.drawColor, true, state.multiPreviewEnd);
        }
    }

    // ── Team color helpers ────────────────────────────────
    function isAway(side) {
        return side === "A" ? state.kitA === "away" : state.kitB === "away";
    }
    function getTeamColor(side) {
        const team = side === "A" ? state.teamA : state.teamB;
        if (!team) return side === "A" ? DEFAULT_A_COLOR : DEFAULT_B_COLOR;
        return isAway(side) ? "#ffffff" : team.primary;
    }
    function getTeamStroke(side) {
        const team = side === "A" ? state.teamA : state.teamB;
        if (!team) return isAway(side) ? "#888888" : "#ffffff";
        return isAway(side)
            ? (team.border_away || team.primary)
            : (team.border_home || team.secondary);
    }
    function getTeamTextColor(side) {
        return isAway(side) ? "#000000" : "#ffffff";
    }

    // ── Draw players ───────────────────────────────────────
    function drawPlayers() {
        // 빈 슬롯 그리기 (선수가 배치되지 않은 슬롯만)
        for (const side of ["A", "B"]) {
            const filledIdxs = new Set(
                state.players.filter(p => p.team === side && p.onField !== false && p.slotIdx != null).map(p => p.slotIdx)
            );
            for (const slot of (state.slots[side] || [])) {
                if (filledIdxs.has(slot.idx)) continue;
                const { px, py } = fieldToCanvas(slot.x, slot.y);
                ctx.beginPath(); ctx.arc(px, py, PLAYER_RADIUS, 0, Math.PI * 2);
                ctx.fillStyle = "rgba(255,255,255,0.07)"; ctx.fill();
                ctx.strokeStyle = "rgba(255,255,255,0.25)"; ctx.lineWidth = 1.5; ctx.stroke();
                ctx.fillStyle = "rgba(255,255,255,0.35)";
                ctx.font = "bold 9px 'Segoe UI', sans-serif";
                ctx.textAlign = "center"; ctx.textBaseline = "middle";
                ctx.fillText(slot.label, px, py);
            }
        }
        // 배치된 선수 그리기 (항상 p.x/y 기준, slotIdx는 자국 표시 여부만 사용)
        const hl = state.highlightPlayerId;
        for (const p of state.players) {
            if (p.onField === false) continue;
            // 개인 강조 모드: 선택되지 않은 선수는 반투명
            const dimmed = hl && p.id !== hl;
            if (dimmed) ctx.globalAlpha = 0.25;

            const { px, py } = fieldToCanvas(p.x, p.y);
            const color = getTeamColor(p.team);
            const isDragging = state.dragging === p;
            const r = isDragging ? PLAYER_RADIUS + 3 : PLAYER_RADIUS;
            const isHighlighted = hl && p.id === hl;
            if (isDragging) { ctx.shadowColor = color; ctx.shadowBlur = 16; }
            if (isHighlighted) { ctx.shadowColor = "#ffd700"; ctx.shadowBlur = 20; }
            ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2);
            ctx.fillStyle = color; ctx.fill();
            ctx.strokeStyle = isHighlighted ? "#ffd700" : getTeamStroke(p.team);
            ctx.lineWidth = isHighlighted ? 3.5 : 2.5; ctx.stroke();
            ctx.shadowColor = "transparent"; ctx.shadowBlur = 0;
            const txtCol = getTeamTextColor(p.team);
            ctx.fillStyle = txtCol; ctx.font = "bold 11px 'Segoe UI', sans-serif";
            ctx.textAlign = "center"; ctx.textBaseline = "middle";
            ctx.fillText(p.number, px, py);
            // 롤 태그 표시 — 슬롯 라벨(LW/CDM/AM 등) 우선, 없으면 GK/DF/MF/FW
            if (state.showRoleTags && (p.slotLabel || p.position)) {
                ctx.font = "bold 8px 'Segoe UI', sans-serif";
                ctx.fillStyle = "rgba(255,255,200,0.9)";
                ctx.fillText(p.slotLabel || p.position, px, py - r - 5);
            }
            ctx.font = "bold 10px 'Segoe UI', sans-serif";
            ctx.fillStyle = "#fff";
            ctx.shadowColor = "rgba(0,0,0,0.8)"; ctx.shadowBlur = 3;
            const label = p.name + (!state.showRoleTags && p.position ? ` (${p.position})` : "");
            ctx.fillText(label, px, py + r + 12);
            ctx.shadowColor = "transparent"; ctx.shadowBlur = 0;

            if (dimmed) ctx.globalAlpha = 1;
        }
    }

    // ── Draw soccer ball ──────────────────────────────────
    function drawBall(bx, by, isDragging) {
        const r = fieldRect();
        const br = Math.max(4, r.w * 0.007);

        ctx.save();
        if (isDragging) { ctx.shadowColor = "rgba(255,255,255,0.6)"; ctx.shadowBlur = 10; }

        // 공 본체
        ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2);
        ctx.fillStyle = "#f5f5f5"; ctx.fill();
        ctx.strokeStyle = "rgba(0,0,0,0.3)"; ctx.lineWidth = 1; ctx.stroke();

        // 축구공 패치 패턴 (클리핑)
        ctx.save();
        ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2); ctx.clip();

        // 중앙 오각형
        ctx.fillStyle = "#1a1a1a";
        const drawPatch = (cx2, cy2, r2, rot) => {
            ctx.beginPath();
            for (let i = 0; i < 5; i++) {
                const a = rot + (i * 2 * Math.PI) / 5;
                i === 0 ? ctx.moveTo(cx2 + r2 * Math.cos(a), cy2 + r2 * Math.sin(a))
                        : ctx.lineTo(cx2 + r2 * Math.cos(a), cy2 + r2 * Math.sin(a));
            }
            ctx.closePath(); ctx.fill();
        };
        drawPatch(bx, by, br * 0.38, -Math.PI / 2);
        // 주변 오각형 5개
        const off = br * 0.72;
        for (let i = 0; i < 5; i++) {
            const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
            drawPatch(bx + off * Math.cos(a), by + off * Math.sin(a), br * 0.28, a + Math.PI / 5);
        }

        ctx.restore();

        // 외곽선
        ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(0,0,0,0.5)"; ctx.lineWidth = 1.5; ctx.stroke();

        ctx.restore();
    }

    function drawBalls() {
        for (const ball of state.balls) {
            const { px, py } = fieldToCanvas(ball.x, ball.y);
            drawBall(px, py, state.draggingBall === ball);
        }
    }

    // ── Heatmap overlay ────────────────────────────────────
    // ── 히트맵 상태 ───────────────────────────────────────
    const heatmapState = { active: false, points: [], playerName: null, teamSide: null };
    // 경기별 포인트 캐시: eventId → points[]
    const _matchCache = new Map();
    // 선택된 경기 ID 목록 (null = 2026 전체 누적)
    const _selectedMatches = new Set();
    let _allMatchPoints = [];  // 2026 전체 누적 포인트

    function drawHeatmap() {
        if (!heatmapState.active || heatmapState.points.length === 0) return;
        const r = fieldRect();
        const radius = r.w * 0.025;

        const off = document.createElement("canvas");
        off.width = canvas.width;
        off.height = canvas.height;
        const offCtx = off.getContext("2d");

        const flip = heatmapState.teamSide === "B";
        for (const pt of heatmapState.points) {
            const nx = flip ? pt.x : 100 - pt.x;
            const ny = flip ? pt.y : 100 - pt.y;
            const px = r.x + (nx / 100) * r.w;
            const py = r.y + (ny / 100) * r.h;
            const grad = offCtx.createRadialGradient(px, py, 0, px, py, radius);
            grad.addColorStop(0, "rgba(255,255,255,0.10)");
            grad.addColorStop(1, "rgba(255,255,255,0)");
            offCtx.fillStyle = grad;
            offCtx.beginPath();
            offCtx.arc(px, py, radius, 0, Math.PI * 2);
            offCtx.fill();
        }

        const imgData = offCtx.getImageData(0, 0, canvas.width, canvas.height);
        const d = imgData.data;
        for (let i = 0; i < d.length; i += 4) {
            const alpha = d[i + 3] / 255;
            if (alpha < 0.005) continue;
            const t = Math.min(Math.pow(alpha * 6, 0.6), 1);
            let r_, g_, b_;
            if (t < 0.25)      { const s = t / 0.25;       r_ = 0;                g_ = Math.round(s * 220); b_ = 255; }
            else if (t < 0.5)  { const s = (t-0.25)/0.25;  r_ = 0;                g_ = 220;                 b_ = Math.round(255*(1-s)); }
            else if (t < 0.75) { const s = (t-0.5)/0.25;   r_ = Math.round(s*255); g_ = 220;                b_ = 0; }
            else               { const s = (t-0.75)/0.25;  r_ = 255;              g_ = Math.round(220*(1-s)); b_ = 0; }
            d[i] = r_; d[i+1] = g_; d[i+2] = b_;
            d[i+3] = Math.round(Math.min(alpha * 8, 0.95) * 255);
        }
        offCtx.putImageData(imgData, 0, 0);

        ctx.save();
        ctx.globalAlpha = 0.85;
        ctx.drawImage(off, 0, 0);
        ctx.restore();

        // 선수 이름 + 선택 경기 수 레이블
        ctx.save();
        ctx.font = "bold 12px 'Segoe UI', sans-serif";
        ctx.fillStyle = "rgba(255,255,100,0.95)";
        ctx.textAlign = "left";
        const label = _selectedMatches.size > 0
            ? `히트맵: ${heatmapState.playerName} (${_selectedMatches.size}경기)`
            : `히트맵: ${heatmapState.playerName} (전체)`;
        ctx.fillText(label, r.x + 8, r.y + 20);
        ctx.restore();
    }

    // 선택된 경기들의 포인트를 합산해서 heatmapState에 반영
    function _rebuildHeatmapPoints() {
        if (_selectedMatches.size === 0) {
            heatmapState.active = false;
            heatmapState.points = [];
        } else {
            const combined = [];
            for (const eid of _selectedMatches) {
                for (const p of (_matchCache.get(eid) || [])) combined.push(p);
            }
            heatmapState.active = combined.length > 0;
            heatmapState.points = combined;
        }
        render();
    }

    async function loadHeatmap(playerName, playerTeamSide) {
        // 같은 선수 클릭 → 토글 off
        if (heatmapState.playerName === playerName && heatmapState.active) {
            heatmapState.active = false;
            heatmapState.points = [];
            heatmapState.playerName = null;
            _selectedMatches.clear();
            _matchCache.clear();
            _allMatchPoints = [];
            closeMatchPicker();
            render();
            return;
        }

        // 새 선수 → 초기화 후 2026 전체 로드
        _selectedMatches.clear();
        _matchCache.clear();
        _allMatchPoints = [];

        // 히트맵은 비운 채로 패널만 열기
        heatmapState.points = [];
        heatmapState.playerName = playerName;
        heatmapState.teamSide = playerTeamSide;
        heatmapState.active = false;
        render();
        openMatchPicker(playerName, playerTeamSide);
    }

    // 경기 하나의 포인트를 fetch (캐시 우선)
    async function _fetchMatchPoints(playerName, playerTeamSide, eventId) {
        if (_matchCache.has(eventId)) return _matchCache.get(eventId);
        try {
            const res = await fetch(`/api/heatmap?name=${encodeURIComponent(playerName)}&eventId=${eventId}`);
            const data = await res.json();
            const pts = (data.found && data.points.length > 0) ? data.points : [];
            _matchCache.set(eventId, pts);
            return pts;
        } catch { return []; }
    }

    // ── 경기별 선택 패널 ───────────────────────────────────
    let _matchPickerName = null;
    let _matchPickerSide = null;

    function closeMatchPicker() {
        const el = document.getElementById("match-picker");
        if (el) el.classList.add("hidden");
        _matchPickerName = null;
        _matchPickerSide = null;
    }

    async function openMatchPicker(playerName, playerTeamSide) {
        _matchPickerName = playerName;
        _matchPickerSide = playerTeamSide;
        const el = document.getElementById("match-picker");
        const list = document.getElementById("match-picker-list");
        const title = document.getElementById("match-picker-title");
        title.textContent = `${playerName} 경기별`;
        list.innerHTML = '<li class="mp-loading">불러오는 중...</li>';
        el.classList.remove("hidden");

        try {
            const res = await fetch(`/api/player-matches?name=${encodeURIComponent(playerName)}&year=2026`);
            const data = await res.json();
            list.innerHTML = "";

            // 전체 누적 항목 (기본 미선택)
            const allLi = document.createElement("li");
            allLi.className = "mp-item mp-item-all";
            allLi.innerHTML = `<span class="mp-check">☐</span><span>2026 전체 (누적)</span>`;
            allLi.dataset.all = "1";
            allLi.addEventListener("click", async () => {
                const isActive = allLi.classList.contains("active");
                if (isActive) {
                    // 해제 → 전체 선택 없애기
                    allLi.classList.remove("active");
                    allLi.querySelector(".mp-check").textContent = "☐";
                    _selectedMatches.clear();
                    _allMatchPoints = [];
                    heatmapState.active = false;
                    heatmapState.points = [];
                    render();
                } else {
                    // 선택 → 2026 전체 누적 로드
                    allLi.querySelector(".mp-check").textContent = "…";
                    list.querySelectorAll(".mp-item[data-eid]").forEach(x => {
                        x.classList.remove("active");
                        x.querySelector(".mp-check").textContent = "☐";
                    });
                    _selectedMatches.clear();
                    try {
                        const r2 = await fetch(`/api/heatmap?name=${encodeURIComponent(playerName)}&year=2026`);
                        const d2 = await r2.json();
                        _allMatchPoints = (d2.found && d2.points.length > 0) ? d2.points : [];
                    } catch { _allMatchPoints = []; }
                    allLi.classList.add("active");
                    allLi.querySelector(".mp-check").textContent = "☑";
                    heatmapState.active = _allMatchPoints.length > 0;
                    heatmapState.points = _allMatchPoints;
                    render();
                }
            });
            list.appendChild(allLi);

            if (!data.found || data.matches.length === 0) {
                list.appendChild(Object.assign(document.createElement("li"), { className: "mp-empty", textContent: "2026 경기 데이터 없음" }));
                return;
            }

            for (const m of data.matches) {
                const li = document.createElement("li");
                li.className = "mp-item";
                li.dataset.eid = m.id;
                const date = m.datets
                    ? new Date(m.datets * 1000).toLocaleDateString("ko-KR", { month: "2-digit", day: "2-digit" })
                    : "날짜미상";
                const score = (m.homeScore != null && m.awayScore != null) ? `${m.homeScore}:${m.awayScore}` : "-";
                const badge = m.isAway ? `<span class="mp-badge mp-away">AWAY</span>` : `<span class="mp-badge mp-home">HOME</span>`;
                li.innerHTML = `<span class="mp-check">☐</span><span class="mp-date">${date}</span>${badge}<span class="mp-home-team">${m.home}</span><span class="mp-vs">vs</span><span class="mp-away-team">${m.away}</span><span class="mp-score">${score}</span>`;

                li.addEventListener("click", async () => {
                    const eid = m.id;
                    const check = li.querySelector(".mp-check");
                    if (_selectedMatches.has(eid)) {
                        // 선택 해제
                        _selectedMatches.delete(eid);
                        li.classList.remove("active");
                        check.textContent = "☐";
                    } else {
                        // 선택 추가 → 전체 항목 체크 해제
                        allLi.classList.remove("active");
                        allLi.querySelector(".mp-check").textContent = "☐";
                        _selectedMatches.add(eid);
                        li.classList.add("active");
                        check.textContent = "☑";
                        // 아직 캐시 없으면 fetch
                        if (!_matchCache.has(eid)) {
                            check.textContent = "…";
                            await _fetchMatchPoints(playerName, playerTeamSide, eid);
                            check.textContent = "☑";
                        }
                    }
                    _rebuildHeatmapPoints();
                });
                list.appendChild(li);
            }
        } catch (e) {
            list.innerHTML = '<li class="mp-empty">불러오기 실패</li>';
        }
    }

    // ── Render ─────────────────────────────────────────────
    function render() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        drawField();
        drawHeatmap();
        drawLines(); drawPlayers(); drawBalls();
    }

    // 슬롯 라벨 -> 역할(GK/DF/MF/FW) 분류
    function roleOfLabel(label) {
        if (label === "GK" || label === "G") return "GK";
        if (["LB","RB","CB","LWB","RWB","D","D1","D2","D3","D4","D5"].includes(label)) return "DF";
        if (["LM","RM","CM","CDM","AM","M","M1","M2","M3","M4","M5"].includes(label)) return "MF";
        if (["ST","LW","RW","F","F1","F2","F3","A1","A2","A3"].includes(label)) return "FW";
        return null;
    }

    // ── Formation loading ──────────────────────────────────
    function loadFormationSide(side, name) {
        const f = state.formations[name];
        if (!f) return;
        if (side === "A") state.formationA = name; else state.formationB = name;

        const positions = side === "A" ? f.teamA : f.teamB;
        const labels = side === "A" ? f.labelsA : f.labelsB;

        // 슬롯 재구성
        state.slots[side] = positions.map((pos, i) => ({ idx: i, team: side, x: pos.x, y: pos.y, label: labels[i] || "" }));

        // 역할 기반 재배치: 선수(GK/DF/MF/FW)를 슬롯 역할에 매칭하여 x/y 갱신
        const slotsByRole = { GK: [], DF: [], MF: [], FW: [] };
        const leftoverSlots = [];
        for (const s of state.slots[side]) {
            const r = roleOfLabel(s.label);
            if (r && slotsByRole[r]) slotsByRole[r].push(s);
            else leftoverSlots.push(s);
        }

        const onField = state.players.filter(p => p.team === side && p.onField !== false);
        const playersByRole = { GK: [], DF: [], MF: [], FW: [] };
        const unknownPlayers = [];
        for (const p of onField) {
            if (playersByRole[p.position]) playersByRole[p.position].push(p);
            else unknownPlayers.push(p);
        }

        const placedIds = new Set();
        function placeGroup(plist, slist) {
            for (let i = 0; i < plist.length && i < slist.length; i++) {
                const p = plist[i], s = slist[i];
                p.x = s.x; p.y = s.y; p.slotIdx = s.idx; p.onField = true;
                placedIds.add(p.id);
            }
        }
        ["GK","DF","MF","FW"].forEach(r => placeGroup(playersByRole[r], slotsByRole[r]));

        // 역할 불일치(예: 4-4-2→4-3-3 시 MF 1명 여유, FW 1명 부족) 보정:
        // 아직 배치되지 않은 선수를 남은 슬롯에 순서대로 투입
        const usedSlotIdxs = new Set(
            onField.filter(p => placedIds.has(p.id)).map(p => p.slotIdx)
        );
        const openSlots = state.slots[side].filter(s => !usedSlotIdxs.has(s.idx));
        const orphanPlayers = [];
        ["GK","DF","MF","FW"].forEach(r => {
            const overflow = playersByRole[r].slice(slotsByRole[r].length);
            orphanPlayers.push(...overflow);
        });
        orphanPlayers.push(...unknownPlayers);
        for (let i = 0; i < orphanPlayers.length; i++) {
            const p = orphanPlayers[i];
            const s = openSlots[i];
            if (s) {
                p.x = s.x; p.y = s.y; p.slotIdx = s.idx; p.onField = true;
            } else {
                // 슬롯 부족: 벤치로
                p.onField = false; p.slotIdx = null;
            }
        }

        render();
        renderBench();
    }

    function loadFormation(name) {
        state.formationA = name;
        state.formationB = name;
        state.players = [];
        const f = state.formations[name];
        if (!f) return;
        state.slots.A = f.teamA.map((pos, i) => ({ idx: i, team: "A", x: pos.x, y: pos.y, label: f.labelsA[i] || "" }));
        state.slots.B = f.teamB.map((pos, i) => ({ idx: i, team: "B", x: pos.x, y: pos.y, label: f.labelsB[i] || "" }));
        document.querySelectorAll(".formation-select-team").forEach((sel) => { sel.value = name; });
        render();
        renderBench();
    }

    // ── Slot hit test ─────────────────────────────────────
    function hitTestEmptySlot(px, py) {
        for (const side of ["A", "B"]) {
            const filledIdxs = new Set(
                state.players.filter(p => p.team === side && p.onField !== false && p.slotIdx != null).map(p => p.slotIdx)
            );
            for (const slot of (state.slots[side] || [])) {
                if (filledIdxs.has(slot.idx)) continue;
                const { px: sx, py: sy } = fieldToCanvas(slot.x, slot.y);
                if (Math.sqrt((px - sx) ** 2 + (py - sy) ** 2) <= PLAYER_RADIUS + 4) return slot;
            }
        }
        return null;
    }

    // ── Ball hit test ──────────────────────────────────────
    function hitTestBall(px, py) {
        const r = fieldRect();
        const br = Math.max(5, r.w * 0.011) + 4;
        for (let i = state.balls.length - 1; i >= 0; i--) {
            const b = state.balls[i];
            const { px: bx, py: by } = fieldToCanvas(b.x, b.y);
            if (Math.sqrt((px - bx) ** 2 + (py - by) ** 2) <= br) return b;
        }
        return null;
    }

    // ── Hit test ───────────────────────────────────────────
    function getPlayerDrawPos(p) {
        return { x: p.x, y: p.y };
    }

    function hitTest(px, py) {
        for (let i = state.players.length - 1; i >= 0; i--) {
            const p = state.players[i];
            if (p.onField === false) continue;
            const pos = getPlayerDrawPos(p);
            const { px: cx, py: cy } = fieldToCanvas(pos.x, pos.y);
            if (Math.sqrt((px - cx) ** 2 + (py - cy) ** 2) <= PLAYER_RADIUS + 4) return p;
        }
        return null;
    }

    // ── Line hit test & animation helpers ─────────────────
    function distToSegment(px, py, x1, y1, x2, y2) {
        const dx = x2 - x1, dy = y2 - y1;
        const lenSq = dx * dx + dy * dy;
        if (lenSq === 0) return Math.sqrt((px - x1) ** 2 + (py - y1) ** 2);
        const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
        return Math.sqrt((px - (x1 + t * dx)) ** 2 + (py - (y1 + t * dy)) ** 2);
    }

    function hitTestLine(px, py) {
        for (let i = state.lines.length - 1; i >= 0; i--) {
            const l = state.lines[i];
            if (l.style === 'multiArrow') {
                const pts = l.points.map(p => fieldToCanvas(p.fx, p.fy));
                for (let j = 1; j < pts.length; j++) {
                    if (distToSegment(px, py, pts[j-1].px, pts[j-1].py, pts[j].px, pts[j].py) <= 8) return l;
                }
            } else if (l.style === 'curvedArrow') {
                const from = fieldToCanvas(l.sx, l.sy), ctrl = fieldToCanvas(l.cx, l.cy), to = fieldToCanvas(l.ex, l.ey);
                let prev = from;
                for (let t = 0.15; t <= 1.0; t += 0.15) {
                    const mt = 1 - t;
                    const cur = { px: mt*mt*from.px + 2*mt*t*ctrl.px + t*t*to.px, py: mt*mt*from.py + 2*mt*t*ctrl.py + t*t*to.py };
                    if (distToSegment(px, py, prev.px, prev.py, cur.px, cur.py) <= 8) return l;
                    prev = cur;
                }
            } else {
                const from = fieldToCanvas(l.sx, l.sy), to = fieldToCanvas(l.ex, l.ey);
                if (distToSegment(px, py, from.px, from.py, to.px, to.py) <= 8) return l;
            }
        }
        return null;
    }

    function getBezierPoint(line, t) {
        const mt = 1 - t;
        return { x: mt*mt*line.sx + 2*mt*t*line.cx + t*t*line.ex, y: mt*mt*line.sy + 2*mt*t*line.cy + t*t*line.ey };
    }

    function getMultiPathPoint(line, t) {
        const pts = line.points;
        const lengths = [];
        let total = 0;
        for (let i = 1; i < pts.length; i++) {
            const d = Math.sqrt((pts[i].fx - pts[i-1].fx)**2 + (pts[i].fy - pts[i-1].fy)**2);
            lengths.push(d); total += d;
        }
        if (total === 0) return { x: pts[pts.length-1].fx, y: pts[pts.length-1].fy };
        let target = t * total;
        for (let i = 0; i < lengths.length; i++) {
            if (target <= lengths[i] || i === lengths.length - 1) {
                const st = lengths[i] > 0 ? Math.min(1, target / lengths[i]) : 1;
                return { x: pts[i].fx + (pts[i+1].fx - pts[i].fx) * st, y: pts[i].fy + (pts[i+1].fy - pts[i].fy) * st };
            }
            target -= lengths[i];
        }
        return { x: pts[pts.length-1].fx, y: pts[pts.length-1].fy };
    }

    function getLinePoint(line, t) {
        if (line.style === 'curvedArrow') return getBezierPoint(line, t);
        if (line.style === 'multiArrow') return getMultiPathPoint(line, t);
        return { x: line.sx + (line.ex - line.sx) * t, y: line.sy + (line.ey - line.sy) * t };
    }

    function calcPathDuration(line) {
        let dist = 0;
        if (line.style === 'multiArrow') {
            const pts = line.points;
            for (let i = 1; i < pts.length; i++) dist += Math.sqrt((pts[i].fx - pts[i-1].fx)**2 + (pts[i].fy - pts[i-1].fy)**2);
        } else if (line.style === 'curvedArrow') {
            let prev = { x: line.sx, y: line.sy };
            for (let t = 0.1; t <= 1.0; t += 0.1) { const pos = getBezierPoint(line, t); dist += Math.sqrt((pos.x-prev.x)**2+(pos.y-prev.y)**2); prev = pos; }
        } else {
            dist = Math.sqrt((line.ex - line.sx)**2 + (line.ey - line.sy)**2);
        }
        return Math.max(200, Math.min(4000, dist * 4000)) / state.animSpeed;
    }

    function nearestPlayerToPoint(fx, fy) {
        let best = null, bestDist = Infinity;
        for (const p of state.players) {
            const d = Math.sqrt((p.x - fx) ** 2 + (p.y - fy) ** 2);
            if (d < bestDist) { bestDist = d; best = p; }
        }
        return best;
    }

    function easeInOut(t) { return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; }

    let animFrameId = null;
    let lastAnimTime = null;

    function animTick(ts) {
        if (!lastAnimTime) lastAnimTime = ts;
        const dt = ts - lastAnimTime;
        lastAnimTime = ts;
        let anyActive = false;
        for (const anim of state.animations) {
            anim.progress = Math.min(1, anim.progress + dt / anim.duration);
            const pos = getLinePoint(anim.line, easeInOut(anim.progress));
            anim.player.x = pos.x; anim.player.y = pos.y;
            if (anim.progress < 1) anyActive = true;
        }
        state.animations = state.animations.filter(a => a.progress < 1);
        render();
        if (anyActive) { animFrameId = requestAnimationFrame(animTick); }
        else { animFrameId = null; lastAnimTime = null; }
    }

    function startLineAnimation(line) {
        const startFx = line.style === 'multiArrow' ? line.points[0].fx : line.sx;
        const startFy = line.style === 'multiArrow' ? line.points[0].fy : line.sy;
        // 귀속된 선수 우선, 없으면 가장 가까운 선수
        const player = line.attachedPlayerId
            ? (state.players.find(p => p.id === line.attachedPlayerId) || nearestPlayerToPoint(startFx, startFy))
            : nearestPlayerToPoint(startFx, startFy);
        if (!player) return;
        state.animations = state.animations.filter(a => a.player !== player);
        player.x = startFx; player.y = startFy;
        state.animations.push({ player, line, progress: 0, duration: calcPathDuration(line) });
        if (!animFrameId) { lastAnimTime = null; animFrameId = requestAnimationFrame(animTick); }
    }

    // ── Play All (플래시맵) ────────────────────────────────
    let _flashPlaying = false;

    function playAllLines() {
        if (state.lines.length === 0) return;
        if (_flashPlaying) return;
        _flashPlaying = true;

        // 모든 선 애니메이션 시작
        state.animations = [];
        state.lines.forEach(line => startLineAnimation(line));

        const maxDuration = state.lines.reduce((max, line) => Math.max(max, calcPathDuration(line)), 0);
        const btnPlay = document.getElementById("btn-play-all");
        btnPlay.disabled = true;
        btnPlay.textContent = "⏹ 재생중";

        setTimeout(() => {
            _flashPlaying = false;
            btnPlay.disabled = false;
            btnPlay.textContent = "▶ 재생";
            // 재생 완료 후 라인 자동 제거 — 미관 (작전 다시 보려면 재드로잉)
            state.lines = [];
            render();
        }, maxDuration + 100);
    }

    // ── Pointer events ─────────────────────────────────────
    function getPointerPos(e) {
        const rect = canvas.getBoundingClientRect();
        return { px: (e.clientX - rect.left) * (canvas.width / rect.width), py: (e.clientY - rect.top) * (canvas.height / rect.height) };
    }

    canvas.addEventListener("pointerdown", (e) => {
        if (editingPlayer) return;
        const { px, py } = getPointerPos(e);
        const { fx, fy } = canvasToField(px, py);
        if (state.mode === "select") {
            const ball = hitTestBall(px, py);
            if (ball) {
                state.draggingBall = ball;
                const { px: bx, py: by } = fieldToCanvas(ball.x, ball.y);
                state.dragOffset = { dx: bx - px, dy: by - py };
                canvas.setPointerCapture(e.pointerId);
                return;
            }
            const player = hitTest(px, py);
            if (player) {
                state.dragging = player;
                state._clickedPlayer = player;
                state._pointerMoved = false;
                // 드래그 시작: 슬롯 좌표를 p.x/y로 동기화 (slotIdx 유지 → 슬롯 자국 안 보임)
                const drawPos = getPlayerDrawPos(player);
                player.x = drawPos.x; player.y = drawPos.y;
                state.dragOffset = { dx: 0, dy: 0 };
                canvas.setPointerCapture(e.pointerId);
            } else {
                const line = hitTestLine(px, py);
                if (line) {
                    if (line.style === 'curvedArrow') {
                        const t = closestTOnBezier(line, px, py);
                        state.draggingCurve = { line, t, px, py, moved: false };
                        canvas.setPointerCapture(e.pointerId);
                    } else {
                        startLineAnimation(line);
                    }
                } else {
                    // 선수도 라인도 없을 때만 빈 슬롯 체크
                    const emptySlot = hitTestEmptySlot(px, py);
                    if (emptySlot) openSlotPicker(emptySlot, e.clientX, e.clientY);
                    else if (state.highlightPlayerId) {
                        // 빈 영역 클릭 → 개인 강조 해제
                        state.highlightPlayerId = null; render();
                    }
                }
            }
        } else if (state.mode === "erase") {
            const line = hitTestLine(px, py);
            if (line) { state.lines = state.lines.filter(l => l !== line); render(); }
        } else if (state.mode === "draw") {
            // 시작점 근처 선수에 귀속
            const nearPlayer = hitTest(px, py) || nearestPlayerToPoint(fx, fy);
            const attachedPlayerId = nearPlayer && Math.sqrt((nearPlayer.x - fx) ** 2 + (nearPlayer.y - fy) ** 2) < 0.07
                ? nearPlayer.id : null;

            if (state.drawStyle === 'multiArrow') {
                if (!state.multiPoints) {
                    state.multiPoints = [{ fx, fy }];
                    state.multiAttachedPlayerId = attachedPlayerId;
                } else {
                    state.multiPoints.push({ fx, fy });
                }
                render();
            } else if (state.drawStyle === 'curvedArrow') {
                if (!state.drawingLine) {
                    // 1번 클릭: 시작점 설정
                    state.drawingLine = { sx: fx, sy: fy, ex: fx, ey: fy, cx: fx, cy: fy, phase: 'end', style: 'curvedArrow', color: state.drawColor, attachedPlayerId };
                } else if (state.drawingLine.phase === 'end') {
                    // 2번 클릭: 끝점 확정, 곡선 방향 설정 phase로
                    const cp = calcCurveControlPoint(state.drawingLine.sx, state.drawingLine.sy, fx, fy);
                    state.drawingLine.ex = fx; state.drawingLine.ey = fy;
                    state.drawingLine.cx = cp.cx; state.drawingLine.cy = cp.cy;
                    state.drawingLine.phase = 'curve';
                } else if (state.drawingLine.phase === 'curve') {
                    // 3번 클릭: 곡선 방향 확정 → 저장
                    const l = state.drawingLine;
                    if (Math.sqrt((l.ex - l.sx) ** 2 + (l.ey - l.sy) ** 2) > 0.01) {
                        state.lines.push({ sx: l.sx, sy: l.sy, ex: l.ex, ey: l.ey, cx: l.cx, cy: l.cy, style: 'curvedArrow', color: l.color, attachedPlayerId: l.attachedPlayerId, layer: state.activeLayer });
                    }
                    state.drawingLine = null;
                }
                render();
            } else {
                const dl = { sx: fx, sy: fy, ex: fx, ey: fy, style: state.drawStyle, color: state.drawColor, attachedPlayerId };
                state.drawingLine = dl;
                canvas.setPointerCapture(e.pointerId);
            }
        }
    });

    canvas.addEventListener("pointermove", (e) => {
        const { px, py } = getPointerPos(e);
        const { fx, fy } = canvasToField(px, py);
        if (state.mode === "select" && state.draggingBall) {
            const { fx, fy } = canvasToField(px + state.dragOffset.dx, py + state.dragOffset.dy);
            state.draggingBall.x = fx; state.draggingBall.y = fy; render();
        } else if (state.mode === "select" && state.dragging) {
            playerTooltip.style.display = "none"; tooltipTarget = null;
            const { fx: dfx, fy: dfy } = canvasToField(px, py);
            state.dragging.x = dfx; state.dragging.y = dfy;
            state._pointerMoved = true;
            render();
        } else if (state.mode === "select" && state.draggingCurve) {
            const dc = state.draggingCurve;
            if (!dc.moved && Math.sqrt((px - dc.px) ** 2 + (py - dc.py) ** 2) > 5) dc.moved = true;
            if (dc.moved) {
                const { cx, cy } = controlPointFromDrag(dc.line, dc.t, fx, fy);
                dc.line.cx = cx; dc.line.cy = cy; render();
            }
        } else if (state.mode === "draw" && state.drawingLine) {
            if (state.drawingLine.style === 'curvedArrow') {
                if (state.drawingLine.phase === 'end') {
                    state.drawingLine.ex = fx; state.drawingLine.ey = fy;
                } else if (state.drawingLine.phase === 'curve') {
                    state.drawingLine.cx = fx; state.drawingLine.cy = fy;
                }
            } else {
                state.drawingLine.ex = fx; state.drawingLine.ey = fy;
            }
            render();
        } else if (state.mode === "draw" && state.multiPoints) {
            state.multiPreviewEnd = { px, py };
            render();
        } else if (state.mode === "select") {
            const hovered = hitTest(px, py);
            showPlayerTooltip(hovered, e.clientX, e.clientY);
            if (hovered) canvas.style.cursor = "grab";
            else if (hitTestLine(px, py)) canvas.style.cursor = "pointer";
            else canvas.style.cursor = "default";
        } else if (state.mode === "erase") {
            canvas.style.cursor = hitTestLine(px, py) ? "not-allowed" : "cell";
        }
    });

    let _singleClickTimer = null;
    canvas.addEventListener("pointerup", () => {
        if (state.mode === "select") {
            if (state.dragging) {
                // 이동 없이 클릭만 한 경우 → 싱글클릭 판정 (더블클릭과 구분)
                if (!state._pointerMoved && state._clickedPlayer) {
                    const p = state._clickedPlayer;
                    clearTimeout(_singleClickTimer);
                    _singleClickTimer = setTimeout(() => {
                        // 개인 강조 토글
                        state.highlightPlayerId = (state.highlightPlayerId === p.id) ? null : p.id;
                        render();
                        if (p.name && p.name !== "선수") loadHeatmap(p.name, p.team);
                    }, 250);
                }
                state.dragging = null;
                state._clickedPlayer = null;
                state._pointerMoved = false;
            }
            if (state.draggingBall) { state.draggingBall = null; }
            if (state.draggingCurve) {
                if (!state.draggingCurve.moved) startLineAnimation(state.draggingCurve.line);
                state.draggingCurve = null;
            }
            render();
        }
        else if (state.mode === "draw" && state.drawingLine && state.drawingLine.style !== 'curvedArrow') {
            const l = state.drawingLine;
            if (Math.sqrt((l.ex - l.sx) ** 2 + (l.ey - l.sy) ** 2) > 0.04) {
                state.lines.push({ sx: l.sx, sy: l.sy, ex: l.ex, ey: l.ey, style: l.style, color: l.color, attachedPlayerId: l.attachedPlayerId, layer: state.activeLayer });
            }
            state.drawingLine = null; render();
        }
    });

    // ── Player edit popup (double-click) ───────────────────
    const editPopup = document.getElementById("player-edit-popup");
    const editNumber = document.getElementById("player-edit-number");
    const editName = document.getElementById("player-edit-name");
    const editConfirm  = document.getElementById("player-edit-confirm");
    const editHeatmap  = document.getElementById("player-edit-heatmap");
    const editReport   = document.getElementById("player-edit-report");
    const editClose    = document.getElementById("player-edit-close");
    const editTeamLabel = document.getElementById("player-edit-team-label");
    let editingPlayer = null;

    const editMeta     = document.getElementById("player-edit-meta");
    const editPos      = document.getElementById("player-edit-pos");
    const editBody     = document.getElementById("player-edit-body");
    const editDob      = document.getElementById("player-edit-dob");

    function openEditPopup(player, screenX, screenY) {
        editingPlayer = player;
        editNumber.value = player.number;
        editName.value = player.name;
        editTeamLabel.style.background = getTeamColor(player.team);
        editTeamLabel.textContent = player.team === "A" ? (state.teamA ? state.teamA.short : "HOME") : (state.teamB ? state.teamB.short : "AWAY");

        // 선수 추가 정보 (squad에서 로드된 경우)
        if (player.position || player.height || player.dob) {
            editPos.textContent = player.position || "—";
            const parts = [];
            if (player.height) parts.push(player.height + "cm");
            if (player.weight) parts.push(player.weight + "kg");
            editBody.textContent = parts.join(" / ");
            editDob.textContent = player.dob ? "생년월일 " + player.dob : "";
            editMeta.classList.remove("hidden");
        } else {
            editMeta.classList.add("hidden");
        }
        let left = screenX + 12, top = screenY - 20;
        if (left + 200 > window.innerWidth) left = screenX - 212;
        if (top + 160 > window.innerHeight) top = window.innerHeight - 168;
        if (top < 8) top = 8;
        editPopup.style.left = left + "px"; editPopup.style.top = top + "px";
        editPopup.classList.remove("hidden"); editName.focus(); editName.select();
    }
    function closeEditPopup() { editPopup.classList.add("hidden"); editingPlayer = null; }
    function confirmEdit() {
        if (!editingPlayer) return;
        const num = parseInt(editNumber.value, 10);
        if (!isNaN(num) && num >= 1 && num <= 99) editingPlayer.number = num;
        editingPlayer.name = editName.value.trim() || editingPlayer.name;
        closeEditPopup(); render(); renderBench();
    }
    editConfirm.addEventListener("click", confirmEdit);
    editHeatmap.addEventListener("click", () => {
        if (!editingPlayer) return;
        const name = editingPlayer.name;
        const side = editingPlayer.team;
        closeEditPopup();
        if (name && name !== "선수") loadHeatmap(name, side);
    });
    editReport.addEventListener("click", () => {
        if (!editingPlayer) return;
        const name = editingPlayer.name;
        closeEditPopup();
        if (name && name !== "선수") {
            document.dispatchEvent(new CustomEvent("openPlayerReport", { detail: { name } }));
            document.getElementById("player-report-section")?.scrollIntoView({ behavior: "smooth" });
        }
    });
    editClose.addEventListener("click", closeEditPopup);
    editPopup.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); confirmEdit(); } if (e.key === "Escape") closeEditPopup(); });
    document.addEventListener("pointerdown", (e) => { if (editingPlayer && !editPopup.contains(e.target) && e.target !== canvas) closeEditPopup(); });
    canvas.addEventListener("dblclick", (e) => {
        if (state.mode !== "select") return;
        clearTimeout(_singleClickTimer);
        const { px, py } = getPointerPos(e);
        const player = hitTest(px, py);
        if (player) { openEditPopup(player, e.clientX, e.clientY); return; }
        // 화살표 더블클릭 → 전술 노트 편집
        const line = hitTestLine(px, py);
        if (line) openNotePopup(line, e.clientX, e.clientY);
    });

    // ── Right-click: 꺾기 완료 or 선수 제거 ──────────────────
    canvas.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        if (state.mode === "draw" && state.multiPoints) {
            if (state.multiPoints.length >= 2) {
                const pts = state.multiPoints;
                state.lines.push({ style: 'multiArrow', color: state.drawColor, points: [...pts], sx: pts[0].fx, sy: pts[0].fy, ex: pts[pts.length-1].fx, ey: pts[pts.length-1].fy, attachedPlayerId: state.multiAttachedPlayerId || null, layer: state.activeLayer });
            }
            state.multiPoints = null; state.multiPreviewEnd = null; state.multiAttachedPlayerId = null; render();
            return;
        }
        if (state.mode === "select") {
            const { px, py } = getPointerPos(e);
            const ball = hitTestBall(px, py);
            if (ball) { state.balls = state.balls.filter(b => b !== ball); render(); return; }
            const player = hitTest(px, py);
            if (player) {
                // 완전 삭제 대신 벤치로 복귀
                player.onField = false;
                player.slotIdx = null;
                render(); renderBench();
            }
        }
    });

    // ── Mode & draw style ─────────────────────────────────
    const btnSelect = document.getElementById("btn-select");
    const btnErase = document.getElementById("btn-erase");
    const drawModeBtns = document.querySelectorAll(".draw-mode-btn");

    function setMode(mode, drawStyle) {
        state.mode = mode;
        if (drawStyle) state.drawStyle = drawStyle;
        if (state.multiPoints) { state.multiPoints = null; state.multiPreviewEnd = null; state.multiAttachedPlayerId = null; render(); }
        if (state.drawingLine) { state.drawingLine = null; render(); }
        btnSelect.classList.toggle("active", mode === "select");
        btnErase.classList.toggle("active", mode === "erase");
        drawModeBtns.forEach((b) => b.classList.toggle("active", mode === "draw" && b.dataset.draw === state.drawStyle));
        canvas.style.cursor = mode === "draw" ? "crosshair" : "default";
    }

    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && state.multiPoints) { state.multiPoints = null; state.multiPreviewEnd = null; render(); }
    });

    btnSelect.addEventListener("click", () => setMode("select"));
    btnErase.addEventListener("click", () => setMode("erase"));
    drawModeBtns.forEach((btn) => btn.addEventListener("click", () => setMode("draw", btn.dataset.draw)));

    // ── Color swatches ────────────────────────────────────
    const swatches = document.querySelectorAll(".color-swatch");
    swatches.forEach((sw) => sw.addEventListener("click", () => {
        swatches.forEach((s) => s.classList.remove("active"));
        sw.classList.add("active");
        state.drawColor = sw.dataset.color;
    }));

    // ── Speed slider ──────────────────────────────────────
    const speedSlider = document.getElementById("anim-speed");
    const speedLabel = document.getElementById("anim-speed-label");
    speedSlider.addEventListener("input", () => {
        state.animSpeed = parseFloat(speedSlider.value);
        speedLabel.textContent = state.animSpeed.toFixed(1) + "x";
    });

    // ── Toolbar actions ───────────────────────────────────
    document.getElementById("btn-add-ball").addEventListener("click", () => {
        // 토글: 공 있으면 제거(마지막 1개), 없으면 중앙에 추가 → 두 번 누르면 사라짐
        if (state.balls.length) {
            state.balls.pop();
        } else {
            state.balls.push({ id: state.nextId++, x: 0.5, y: 0.5 });
        }
        render();
    });

    document.getElementById("btn-play-all").addEventListener("click", playAllLines);
    document.getElementById("btn-clear-lines").addEventListener("click", () => { state.lines = []; render(); });
    document.getElementById("btn-undo-line").addEventListener("click", () => { state.lines.pop(); render(); });
    document.getElementById("btn-role-tag").addEventListener("click", (e) => {
        state.showRoleTags = !state.showRoleTags;
        e.target.classList.toggle("active", state.showRoleTags);
        render();
    });

    // ── 전술 노트 팝업 ────────────────────────────────────
    const notePopup    = document.getElementById("note-popup");
    const noteInput    = document.getElementById("note-popup-input");
    const noteClose    = document.getElementById("note-popup-close");
    const noteSave     = document.getElementById("note-popup-save");
    const noteDelete   = document.getElementById("note-popup-delete");
    let   _noteLine    = null;

    function openNotePopup(line, cx, cy) {
        _noteLine = line;
        noteInput.value = line.note || "";
        // 화면 경계 넘지 않게 위치 조정
        const pw = 224, ph = 130;
        const left = Math.min(cx + 8, window.innerWidth  - pw - 8);
        const top  = Math.min(cy + 8, window.innerHeight - ph - 8);
        notePopup.style.left = left + "px";
        notePopup.style.top  = top  + "px";
        notePopup.classList.remove("hidden");
        noteInput.focus();
        noteInput.select();
    }

    function closeNotePopup() {
        notePopup.classList.add("hidden");
        _noteLine = null;
    }

    function commitNote() {
        if (!_noteLine) return;
        const val = noteInput.value.trim();
        _noteLine.note = val || undefined;
        render();
        closeNotePopup();
        showToast(val ? "노트가 추가되었습니다." : "노트가 삭제되었습니다.");
    }

    noteSave.addEventListener("click", commitNote);
    noteDelete.addEventListener("click", () => {
        if (!_noteLine) return;
        _noteLine.note = undefined;
        render();
        closeNotePopup();
        showToast("노트가 삭제되었습니다.");
    });
    noteClose.addEventListener("click", closeNotePopup);
    noteInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitNote(); }
        if (e.key === "Escape") closeNotePopup();
    });
    // 팝업 바깥 클릭 시 닫기
    document.addEventListener("mousedown", (e) => {
        if (!notePopup.classList.contains("hidden") && !notePopup.contains(e.target)) closeNotePopup();
    });

    // ── 레이어 컨트롤 ─────────────────────────────────────
    function syncLayerUI() {
        document.querySelectorAll(".layer-select-btn").forEach(btn => {
            const n = parseInt(btn.dataset.layer);
            btn.classList.toggle("active", state.activeLayer === n);
        });
        document.querySelectorAll(".layer-vis-btn").forEach(btn => {
            const n = parseInt(btn.dataset.layer);
            const vis = state.layerVisible[n];
            btn.textContent = vis ? "👁" : "🚫";
            btn.title = vis ? `레이어 ${n} 숨기기` : `레이어 ${n} 표시`;
            btn.classList.toggle("layer-hidden", !vis);
        });
    }
    document.querySelectorAll(".layer-select-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            state.activeLayer = parseInt(btn.dataset.layer);
            syncLayerUI();
        });
    });
    document.querySelectorAll(".layer-vis-btn").forEach(btn => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            const n = parseInt(btn.dataset.layer);
            state.layerVisible[n] = !state.layerVisible[n];
            syncLayerUI(); render();
        });
    });
    syncLayerUI();
    document.getElementById("btn-reset").addEventListener("click", () => {
        state.lines = [];
        state.players.forEach(p => { p.onField = false; p.slotIdx = null; });
        state.balls = [];
        loadFormationSide("A", state.formationA);
        loadFormationSide("B", state.formationB);
    });

    document.querySelectorAll(".team-reset-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            const side = btn.dataset.side;
            state.players.filter(p => p.team === side).forEach(p => { p.onField = false; p.slotIdx = null; });
            loadFormationSide(side, side === "A" ? state.formationA : state.formationB);
            renderBenchList();
            render();
        });
    });
    document.querySelectorAll(".formation-select-team").forEach((sel) => {
        sel.addEventListener("change", (e) => {
            const val = e.target.value;
            if (val.startsWith("custom_delete:")) {
                // 삭제 확인
                const key = val.replace("custom_delete:", "");
                if (confirm(`"${key}" 포메이션을 삭제하시겠습니까?`)) {
                    delete state.formations[key];
                    const stored = JSON.parse(localStorage.getItem("customFormations") || "{}");
                    delete stored[key];
                    localStorage.setItem("customFormations", JSON.stringify(stored));
                    refreshFormationSelects();
                    showToast("포메이션이 삭제되었습니다.");
                }
                sel.value = sel.dataset.side === "A" ? state.formationA : state.formationB;
                return;
            }
            loadFormationSide(sel.dataset.side, val);
        });
    });

    // ── 커스텀 포메이션 저장 ──────────────────────────────
    function refreshFormationSelects() {
        const builtIn = ["4-4-2","4-3-3","3-5-2","4-2-3-1","4-1-4-1","3-4-3","5-3-2","5-4-1"];
        // _fromMatch 플래그가 붙은 포메이션(경기에서 로드된 임시 포메이션)은 "내 포메이션" 그룹에서 제외
        const customs = Object.keys(state.formations)
            .filter(k => !builtIn.includes(k) && !state.formations[k]?._fromMatch)
            .sort();
        document.querySelectorAll(".formation-select-team").forEach(sel => {
            const cur = sel.value;
            // 기존 커스텀 옵션 제거
            sel.querySelectorAll("option.custom-fm").forEach(o => o.remove());
            sel.querySelectorAll("optgroup.custom-fm-group").forEach(g => g.remove());
            if (customs.length > 0) {
                const group = document.createElement("optgroup");
                group.label = "내 포메이션";
                group.className = "custom-fm-group";
                customs.forEach(key => {
                    const opt = document.createElement("option");
                    opt.value = key; opt.textContent = key; opt.className = "custom-fm";
                    group.appendChild(opt);
                    // 삭제 옵션
                    const delOpt = document.createElement("option");
                    delOpt.value = "custom_delete:" + key;
                    delOpt.textContent = "  ✕ " + key + " 삭제";
                    delOpt.className = "custom-fm";
                    delOpt.style.color = "#e94560";
                    group.appendChild(delOpt);
                });
                sel.appendChild(group);
            }
            sel.value = cur;
        });
    }

    // 로컬스토리지에서 커스텀 포메이션 복원
    function loadCustomFormations() {
        const stored = JSON.parse(localStorage.getItem("customFormations") || "{}");
        Object.assign(state.formations, stored);
        refreshFormationSelects();
    }

    document.querySelectorAll(".formation-save-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            const side = btn.dataset.side;
            const onField = state.players.filter(p => p.team === side && p.onField !== false);
            if (onField.length === 0) { showToast("필드에 선수가 없습니다."); return; }

            const name = prompt("포메이션 이름을 입력하세요:", "");
            if (!name || !name.trim()) return;
            const key = name.trim();

            // 현재 선수 좌표를 포메이션 데이터로 변환
            const positions = onField.map(p => ({ x: p.x, y: p.y }));
            const labels = onField.map(p => p.position || "");
            // 반대편도 미러링 생성
            const mirrored = positions.map(pos => ({ x: 1 - pos.x, y: pos.y }));
            const mirLabels = labels.map(l => {
                if (l.startsWith("L")) return "R" + l.slice(1);
                if (l.startsWith("R")) return "L" + l.slice(1);
                return l;
            });

            state.formations[key] = {
                teamA: positions, teamB: mirrored,
                labelsA: labels, labelsB: mirLabels
            };

            // 로컬스토리지에 저장
            const stored = JSON.parse(localStorage.getItem("customFormations") || "{}");
            stored[key] = state.formations[key];
            localStorage.setItem("customFormations", JSON.stringify(stored));

            refreshFormationSelects();
            // 해당 side의 select를 새 포메이션으로 변경
            document.querySelector(`.formation-select-team[data-side="${side}"]`).value = key;
            if (side === "A") state.formationA = key; else state.formationB = key;
            showToast(`"${key}" 포메이션이 저장되었습니다.`);
        });
    });

    // ── 경기 선택 패널 닫기 ───────────────────────────────
    document.getElementById("match-picker-close").addEventListener("click", () => {
        heatmapState.active = false;
        heatmapState.points = [];
        heatmapState.playerName = null;
        _selectedMatches.clear();
        _matchCache.clear();
        _allMatchPoints = [];
        closeMatchPicker();
        render();
    });

    // ── Player tooltip ────────────────────────────────────
    const playerTooltip = document.getElementById("player-tooltip");
    let tooltipTarget = null;

    function calcAge(dob) {
        if (!dob) return null;
        const [y, m, d] = dob.split("/").map(Number);
        const today = new Date();
        let age = today.getFullYear() - y;
        if (today.getMonth() + 1 < m || (today.getMonth() + 1 === m && today.getDate() < d)) age--;
        return age;
    }

    function showPlayerTooltip(player, clientX, clientY) {
        if (!player) {
            playerTooltip.style.display = "none";
            tooltipTarget = null;
            return;
        }
        if (tooltipTarget === player) {
            // 위치만 업데이트
            const x = Math.min(clientX + 14, window.innerWidth - 160);
            const y = Math.min(clientY - 10, window.innerHeight - 140);
            playerTooltip.style.left = x + "px";
            playerTooltip.style.top = y + "px";
            return;
        }
        tooltipTarget = player;
        const age = calcAge(player.dob);
        const lines = [
            `<b>${player.name}</b>`,
            player.position ? `포지션: ${player.position}` : "",
            `등번호: ${player.number}`,
            player.height ? `신장: ${player.height}cm` : "",
            player.weight ? `체중: ${player.weight}kg` : "",
            age !== null ? `나이: ${age}세` : "",
            player.dob ? `생년월일: ${player.dob.replace(/\//g, ".")}` : "",
        ].filter(Boolean).join("<br>");
        playerTooltip.innerHTML = lines;
        const x = Math.min(clientX + 14, window.innerWidth - 160);
        const y = Math.min(clientY - 10, window.innerHeight - 140);
        playerTooltip.style.left = x + "px";
        playerTooltip.style.top = y + "px";
        playerTooltip.style.display = "block";
    }

    canvas.addEventListener("pointerleave", () => {
        playerTooltip.style.display = "none";
        tooltipTarget = null;
    });

    // ── Toast ─────────────────────────────────────────────
    let toastEl = document.createElement("div"); toastEl.className = "toast"; document.body.appendChild(toastEl);
    let toastTimer = null;
    function showToast(msg) { toastEl.textContent = msg; toastEl.classList.remove("toast-has-action"); toastEl.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2000); }

    function copyShareLink(id) {
        const url = `${location.origin}${location.pathname}?share=${encodeURIComponent(id)}`;
        if (navigator.clipboard) {
            navigator.clipboard.writeText(url).then(() => showToast("링크가 클립보드에 복사되었습니다!"));
        } else {
            prompt("아래 링크를 복사하세요:", url);
        }
    }

    function showLinkToast(saveId) {
        toastEl.innerHTML = "";
        const span = document.createElement("span");
        span.textContent = "전술이 저장되었습니다.";
        const btn = document.createElement("button");
        btn.className = "toast-link-btn";
        btn.textContent = "🔗 링크 복사";
        btn.onclick = () => copyShareLink(saveId);
        toastEl.appendChild(span);
        toastEl.appendChild(btn);
        toastEl.classList.add("show", "toast-has-action");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { toastEl.classList.remove("show", "toast-has-action"); toastEl.textContent = ""; }, 5000);
    }

    // ── Slot picker ───────────────────────────────────────
    const slotPicker = document.getElementById("slot-picker");
    const slotPickerLabel = document.getElementById("slot-picker-label");
    const slotPickerList = document.getElementById("slot-picker-list");
    document.getElementById("slot-picker-close").addEventListener("click", () => slotPicker.classList.add("hidden"));
    document.addEventListener("pointerdown", (e) => {
        if (!slotPicker.classList.contains("hidden") && !slotPicker.contains(e.target) && e.target !== canvas)
            slotPicker.classList.add("hidden");
    });

    const POS_MAP = { GK: ["GK"], DF: ["CB","LB","RB","LWB","RWB"], MF: ["CM","CDM","LM","RM","AM"], FW: ["ST","LW","RW"] };

    function openSlotPicker(slot, screenX, screenY) {
        const side = slot.team;
        const dotTeam = side === "A" ? state.teamA : state.teamB;
        const dotColor = dotTeam ? dotTeam.primary : (side === "A" ? DEFAULT_A_COLOR : DEFAULT_B_COLOR);

        // 해당 포지션에 맞는 벤치 선수 필터
        const matchPos = Object.entries(POS_MAP).find(([, labels]) => labels.includes(slot.label))?.[0];
        const bench = state.players.filter(p => p.team === side && p.onField === false);
        // 포지션 매칭 → 나머지 순
        const sorted = [
            ...bench.filter(p => p.position === matchPos),
            ...bench.filter(p => p.position !== matchPos),
        ];

        slotPickerLabel.textContent = `${slot.label} 슬롯 — 선수 선택`;
        slotPickerList.innerHTML = "";

        if (sorted.length === 0) {
            slotPickerList.innerHTML = '<div class="slot-picker-empty">벤치에 선수가 없습니다</div>';
        } else {
            for (const p of sorted) {
                const item = document.createElement("div");
                item.className = "slot-picker-item";
                const dot = document.createElement("div");
                dot.className = "slot-picker-dot";
                dot.style.background = dotColor;
                dot.textContent = p.number;
                const name = document.createElement("span");
                name.className = "slot-picker-name";
                name.textContent = p.name;
                const pos = document.createElement("span");
                pos.className = "slot-picker-pos";
                pos.textContent = p.position || "—";
                item.appendChild(dot); item.appendChild(name); item.appendChild(pos);
                item.addEventListener("click", () => {
                    p.x = slot.x; p.y = slot.y;
                    p.slotIdx = slot.idx;
                    p.onField = true;
                    slotPicker.classList.add("hidden");
                    render(); renderBench();
                });
                slotPickerList.appendChild(item);
            }
        }

        // 팝업 위치 조정
        let left = screenX + 10, top = screenY - 10;
        if (left + 220 > window.innerWidth) left = screenX - 220;
        if (top + 320 > window.innerHeight) top = window.innerHeight - 320;
        slotPicker.style.left = left + "px";
        slotPicker.style.top = Math.max(8, top) + "px";
        slotPicker.classList.remove("hidden");
    }

    // ── 선수 상태 관리 (부상/출전정지) ─────────────────────
    let _statusCache = {};
    function loadStatusCache() {
        return fetch("/api/player-status").then(r => r.json())
            .then(d => { _statusCache = d; return d; })
            .catch(() => ({}));
    }
    loadStatusCache();

    const STATUS_ICONS = { injured: "🏥", suspended: "🟥", doubtful: "🔶", available: "" };
    const STATUS_LABELS = { injured: "부상", suspended: "출전정지", doubtful: "출전 의문", available: "정상" };
    const STATUS_CYCLE = ["available", "injured", "suspended", "doubtful"];

    function togglePlayerStatus(player, teamId) {
        const pid = String(player.id);
        const current = _statusCache[pid]?.status || "available";
        const nextIdx = (STATUS_CYCLE.indexOf(current) + 1) % STATUS_CYCLE.length;
        const next = STATUS_CYCLE[nextIdx];

        if (next === "available") {
            fetch(`/api/player-status/${pid}`, { method: "DELETE" })
                .then(() => { delete _statusCache[pid]; renderBench(); showToast(`${player.name}: 정상 복귀`); });
        } else {
            fetch("/api/player-status", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ playerId: pid, teamId, name: player.name, status: next })
            }).then(() => {
                _statusCache[pid] = { playerId: pid, teamId, name: player.name, status: next };
                renderBench();
                showToast(`${player.name}: ${STATUS_LABELS[next]}`);
            });
        }
    }

    // ── Bench panel ───────────────────────────────────────
    const benchListA = document.getElementById("bench-list-a");
    const benchListB = document.getElementById("bench-list-b");
    const benchNameA = document.getElementById("bench-name-a");
    const benchNameB = document.getElementById("bench-name-b");

    function renderBench() {
        benchNameA.textContent = state.teamA ? state.teamA.short : "HOME";
        benchNameB.textContent = state.teamB ? state.teamB.short : "AWAY";
        renderBenchList("A", benchListA);
        renderBenchList("B", benchListB);
    }

    function renderBenchList(side, container) {
        container.innerHTML = "";
        const teamPlayers = state.players.filter((p) => p.team === side);
        if (teamPlayers.length === 0) {
            container.innerHTML = '<div style="color:#555;font-size:0.72rem;padding:8px;text-align:center">선수 없음</div>';
            return;
        }
        for (const p of teamPlayers) {
            const item = document.createElement("div");
            item.className = "bench-player-item";
            // 벤치 선수만 드래그 가능
            if (p.onField === false) {
                item.draggable = true;
                item.title = "필드로 드래그해서 배치";
                item.style.cursor = "grab";
                item.addEventListener("dragstart", (e) => {
                    e.dataTransfer.setData("playerId", String(p.id));
                    e.dataTransfer.effectAllowed = "move";
                    item.style.opacity = "0.4";
                });
                item.addEventListener("dragend", () => { item.style.opacity = ""; });
            }

            const dot = document.createElement("div");
            dot.className = "bench-player-dot";
            // 벤치 dot은 킷 여부와 무관하게 팀 primary 색상 사용
            const dotTeam = side === "A" ? state.teamA : state.teamB;
            dot.style.background = dotTeam ? dotTeam.primary : (side === "A" ? DEFAULT_A_COLOR : DEFAULT_B_COLOR);
            dot.style.color = "#ffffff";
            dot.textContent = p.number;

            const name = document.createElement("span");
            name.className = "bench-player-name";
            name.textContent = p.name + (p.position ? ` (${p.position})` : "");

            // 부상/출전정지 상태 표시
            const pid = String(p.id);
            const pStatus = _statusCache[pid]?.status || "available";
            if (pStatus !== "available") {
                item.classList.add("bench-player-" + pStatus);
                const statusIcon = document.createElement("span");
                statusIcon.className = "bench-status-icon";
                statusIcon.textContent = STATUS_ICONS[pStatus];
                statusIcon.title = STATUS_LABELS[pStatus];
                name.prepend(statusIcon);
            }

            // 상태 토글 버튼
            const teamObj = side === "A" ? state.teamA : state.teamB;
            const teamId = teamObj ? teamObj.id : "";
            const statusBtn = document.createElement("button");
            statusBtn.className = "bench-player-edit bench-status-btn";
            statusBtn.textContent = pStatus === "available" ? "+" : STATUS_ICONS[pStatus];
            statusBtn.title = `상태: ${STATUS_LABELS[pStatus]} (클릭하여 변경)`;
            statusBtn.addEventListener("click", (e) => { e.stopPropagation(); togglePlayerStatus(p, teamId); });

            const editBtn = document.createElement("button");
            editBtn.className = "bench-player-edit";
            editBtn.textContent = "✎";
            editBtn.title = "이름/등번호 수정";
            editBtn.addEventListener("click", () => {
                const rect = editBtn.getBoundingClientRect();
                openEditPopup(p, rect.left - 210, rect.top);
            });

            if (p.onField === false) {
                // 미배치 선수: 배치 버튼
                const placeBtn = document.createElement("button");
                placeBtn.className = "bench-player-edit";
                placeBtn.textContent = "⊕";
                placeBtn.title = "필드에 배치";
                placeBtn.addEventListener("click", () => {
                    const slots = state.slots[side] || [];
                    const filledIdxs = new Set(
                        state.players.filter(pl => pl.team === side && pl.onField !== false && pl.slotIdx != null).map(pl => pl.slotIdx)
                    );
                    // 포지션 라벨 매핑
                    const posMap = { GK: ["GK"], DF: ["CB","LB","RB","LWB","RWB"], MF: ["CM","CDM","LM","RM","AM"], FW: ["ST","LW","RW"] };
                    const preferred = posMap[p.position] || [];
                    const emptySlots = slots.filter(s => !filledIdxs.has(s.idx));
                    const targetSlot = emptySlots.find(s => preferred.includes(s.label)) || emptySlots[0];
                    if (targetSlot) {
                        p.slotIdx = targetSlot.idx;
                        p.x = targetSlot.x; p.y = targetSlot.y;
                        p.onField = true;
                    } else {
                        // 슬롯이 꽉 찬 경우: 자유 배치
                        p.x = side === "A" ? 0.25 : 0.75;
                        p.y = 0.5;
                        p.onField = true;
                    }
                    render(); renderBench();
                });
                item.style.opacity = "0.6";
                const removeBtn2 = document.createElement("button");
                removeBtn2.className = "bench-player-remove";
                removeBtn2.innerHTML = "&times;";
                removeBtn2.title = "삭제";
                removeBtn2.addEventListener("click", () => { state.players = state.players.filter(pl => pl !== p); renderBench(); });
                item.appendChild(dot); item.appendChild(name); item.appendChild(statusBtn); item.appendChild(editBtn); item.appendChild(placeBtn); item.appendChild(removeBtn2);
            } else {
                const unplaceBtn = document.createElement("button");
                unplaceBtn.className = "bench-player-edit";
                unplaceBtn.textContent = "↩";
                unplaceBtn.title = "필드에서 제거 (벤치로)";
                unplaceBtn.addEventListener("click", () => {
                    p.onField = false;
                    p.slotIdx = null;
                    render(); renderBench();
                });
                const removeBtn = document.createElement("button");
                removeBtn.className = "bench-player-remove";
                removeBtn.innerHTML = "&times;";
                removeBtn.title = "완전 삭제";
                removeBtn.addEventListener("click", () => {
                    state.players = state.players.filter((pl) => pl !== p);
                    render(); renderBench();
                });
                item.appendChild(dot); item.appendChild(name); item.appendChild(statusBtn); item.appendChild(editBtn); item.appendChild(unplaceBtn); item.appendChild(removeBtn);
            }
            container.appendChild(item);
        }
    }

    // ── Bench → Canvas drag-and-drop ─────────────────────
    canvas.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        // 가장 가까운 빈 슬롯 하이라이트
        const rect = canvas.getBoundingClientRect();
        const px = e.clientX - rect.left, py = e.clientY - rect.top;
        state._dragOverPos = { px, py };
        render();
        // 드롭 가능한 슬롯 강조
        for (const side of ["A", "B"]) {
            const filledIdxs = new Set(state.players.filter(pl => pl.team === side && pl.onField !== false && pl.slotIdx != null).map(pl => pl.slotIdx));
            for (const slot of (state.slots[side] || [])) {
                if (filledIdxs.has(slot.idx)) continue;
                const { px: sx, py: sy } = fieldToCanvas(slot.x, slot.y);
                const d = Math.sqrt((px - sx) ** 2 + (py - sy) ** 2);
                if (d < PLAYER_RADIUS * 3) {
                    ctx.beginPath(); ctx.arc(sx, sy, PLAYER_RADIUS + 4, 0, Math.PI * 2);
                    ctx.strokeStyle = "rgba(255,255,100,0.9)"; ctx.lineWidth = 2.5; ctx.stroke();
                }
            }
        }
    });

    canvas.addEventListener("dragleave", () => {
        state._dragOverPos = null; render();
    });

    canvas.addEventListener("drop", (e) => {
        e.preventDefault();
        state._dragOverPos = null;
        const playerId = parseInt(e.dataTransfer.getData("playerId"), 10);
        const p = state.players.find(pl => pl.id === playerId);
        if (!p || p.onField !== false) return;

        const rect = canvas.getBoundingClientRect();
        const px = e.clientX - rect.left, py = e.clientY - rect.top;

        // 가장 가까운 빈 슬롯 찾기
        const slots = state.slots[p.team] || [];
        const filledIdxs = new Set(state.players.filter(pl => pl.team === p.team && pl.onField !== false && pl.slotIdx != null).map(pl => pl.slotIdx));
        let nearest = null, minDist = Infinity;
        for (const slot of slots) {
            if (filledIdxs.has(slot.idx)) continue;
            const { px: sx, py: sy } = fieldToCanvas(slot.x, slot.y);
            const d = Math.sqrt((px - sx) ** 2 + (py - sy) ** 2);
            if (d < minDist) { minDist = d; nearest = slot; }
        }

        if (nearest) {
            p.slotIdx = nearest.idx;
            p.x = nearest.x; p.y = nearest.y;
        } else {
            // 빈 슬롯 없으면 드롭 위치에 자유 배치
            const { fx, fy } = canvasToField(px, py);
            p.x = fx; p.y = fy;
            p.slotIdx = null;
        }
        p.onField = true;
        render(); renderBench();
    });

    // ── Add player popup ──────────────────────────────────
    const addPopup = document.getElementById("add-player-popup");
    const addNumberInput = document.getElementById("add-player-number");
    const addNameInput = document.getElementById("add-player-name");
    const addTeamLabel = document.getElementById("add-player-team-label");
    let addingSide = null;

    function openAddPopup(side, anchorEl) {
        addingSide = side;
        const teamPlayers = state.players.filter(p => p.team === side);
        addNumberInput.value = teamPlayers.length + 1;
        addNameInput.value = "";
        addTeamLabel.style.background = getTeamColor(side);
        addTeamLabel.textContent = side === "A" ? (state.teamA ? state.teamA.short : "HOME") : (state.teamB ? state.teamB.short : "AWAY");
        const rect = anchorEl.getBoundingClientRect();
        addPopup.style.left = Math.min(rect.right + 8, window.innerWidth - 220) + "px";
        addPopup.style.top = Math.max(rect.top - 20, 8) + "px";
        addPopup.classList.remove("hidden");
        addNameInput.focus();
    }

    function confirmAddPlayer() {
        if (!addingSide) return;
        const num = parseInt(addNumberInput.value, 10);
        const name = addNameInput.value.trim() || "선수" + num;
        state.players.push({ id: state.nextId++, team: addingSide, onField: false, x: 0.5, y: 0.5, name, number: isNaN(num) ? state.nextId : num });
        addPopup.classList.add("hidden"); addingSide = null;
        renderBench();
    }

    document.getElementById("add-player-confirm").addEventListener("click", confirmAddPlayer);
    document.getElementById("add-player-close").addEventListener("click", () => { addPopup.classList.add("hidden"); addingSide = null; });
    addPopup.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); confirmAddPlayer(); } if (e.key === "Escape") { addPopup.classList.add("hidden"); addingSide = null; } });
    document.addEventListener("pointerdown", (e) => { if (addingSide && !addPopup.contains(e.target)) { addPopup.classList.add("hidden"); addingSide = null; } });

    document.querySelectorAll(".bench-add-btn").forEach((btn) => btn.addEventListener("click", () => openAddPopup(btn.dataset.side, btn)));

    // ── Save / Load helpers ───────────────────────────────
    function getStateSnapshot() {
        return {
            formation: state.formationA,
            formationA: state.formationA,
            formationB: state.formationB,
            slots: state.slots,
            players: state.players.map((p) => ({ id: p.id, team: p.team, x: p.x, y: p.y, onField: p.onField, slotIdx: p.slotIdx ?? null, name: p.name, number: p.number, position: p.position || "", height: p.height || null, weight: p.weight || null, dob: p.dob || "" })),
            lines: state.lines.map((l) => {
                const lyr = l.layer || 1;
                if (l.style === 'curvedArrow') return { sx: l.sx, sy: l.sy, ex: l.ex, ey: l.ey, cx: l.cx, cy: l.cy, style: l.style, color: l.color, attachedPlayerId: l.attachedPlayerId || null, note: l.note || undefined, layer: lyr };
                if (l.style === 'multiArrow') return { points: l.points, sx: l.sx, sy: l.sy, ex: l.ex, ey: l.ey, style: l.style, color: l.color, attachedPlayerId: l.attachedPlayerId || null, note: l.note || undefined, layer: lyr };
                return { sx: l.sx, sy: l.sy, ex: l.ex, ey: l.ey, style: l.style, color: l.color, attachedPlayerId: l.attachedPlayerId || null, note: l.note || undefined, layer: lyr };
            }),
            teamAId: state.teamA ? state.teamA.id : null,
            teamBId: state.teamB ? state.teamB.id : null,
            balls: state.balls.map(b => ({ id: b.id, x: b.x, y: b.y })),
        };
    }

    function applySnapshot(data) {
        if (data.teamAId && state.teams.length) state.teamA = state.teams.find((t) => t.id === data.teamAId) || null;
        if (data.teamBId && state.teams.length) state.teamB = state.teams.find((t) => t.id === data.teamBId) || null;
        updateBanner(); updateLegend();
        state.formationA = data.formationA || data.formation || "4-4-2";
        state.formationB = data.formationB || data.formation || "4-4-2";
        document.querySelector('.formation-select-team[data-side="A"]').value = state.formationA;
        document.querySelector('.formation-select-team[data-side="B"]').value = state.formationB;
        if (data.slots) state.slots = data.slots;
        state.players = (data.players || []).map(p => ({ ...p, slotIdx: p.slotIdx ?? null }));
        state.balls = (data.balls || []).map(b => ({ id: b.id ?? state.nextId++, x: b.x, y: b.y }));
        // backward compat: old saves use "arrows"
        state.lines = (data.lines || data.arrows || []).map((l) => {
            const lyr = l.layer || 1;
            if (l.style === 'curvedArrow') return { sx: l.sx, sy: l.sy, ex: l.ex, ey: l.ey, cx: l.cx ?? l.sx, cy: l.cy ?? l.sy, style: 'curvedArrow', color: l.color || "rgba(255,255,255,0.85)", attachedPlayerId: l.attachedPlayerId || null, note: l.note || undefined, layer: lyr };
            if (l.style === 'multiArrow') return { points: l.points || [], sx: l.sx, sy: l.sy, ex: l.ex, ey: l.ey, style: 'multiArrow', color: l.color || "rgba(255,255,255,0.85)", attachedPlayerId: l.attachedPlayerId || null, note: l.note || undefined, layer: lyr };
            return { sx: l.sx, sy: l.sy, ex: l.ex, ey: l.ey, style: l.style || "arrow", color: l.color || "rgba(255,255,255,0.85)", attachedPlayerId: l.attachedPlayerId || null, note: l.note || undefined, layer: lyr };
        });
        render(); renderBench();
    }

    function formatDate(iso) {
        if (!iso) return "";
        const d = new Date(iso), p = (n) => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }

    // ── Save modal ────────────────────────────────────────
    const saveModal = document.getElementById("save-modal");
    const saveModalTitle = document.getElementById("save-modal-title");
    const saveNameInput = document.getElementById("save-name-input");
    const saveModalCancel = document.getElementById("save-modal-cancel");
    const saveModalConfirm = document.getElementById("save-modal-confirm");
    let saveOverwriteId = null;

    function openSaveModal(overwriteId, defaultName) {
        saveOverwriteId = overwriteId || null;
        saveModalTitle.textContent = overwriteId ? "전술 덮어쓰기" : "전술 저장";
        saveModalConfirm.textContent = overwriteId ? "덮어쓰기" : "저장";
        saveNameInput.value = defaultName || "";
        saveModal.classList.remove("hidden"); saveNameInput.focus();
    }
    function closeSaveModal() { saveModal.classList.add("hidden"); saveOverwriteId = null; }
    saveModal.querySelector(".modal-backdrop").addEventListener("click", closeSaveModal);
    saveModalCancel.addEventListener("click", closeSaveModal);
    saveNameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") saveModalConfirm.click(); if (e.key === "Escape") closeSaveModal(); });

    saveModalConfirm.addEventListener("click", async () => {
        const name = saveNameInput.value.trim();
        if (!name) { saveNameInput.focus(); return; }
        const snap = getStateSnapshot(); snap.name = name;
        if (saveOverwriteId) {
            await fetch(`/api/saves/${saveOverwriteId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(snap) });
            showToast("전술이 덮어쓰기 되었습니다.");
        } else {
            const _saveRes = await fetch("/api/saves", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(snap) });
            const _saved = await _saveRes.json();
            showLinkToast(_saved.id);
        }
        closeSaveModal();
    });
    document.getElementById("btn-save").addEventListener("click", () => openSaveModal(null, ""));

    // ── 이미지 내보내기 (PNG) ─────────────────────────────
    document.getElementById("btn-export-png").addEventListener("click", () => {
        // 히트맵 포함 현재 상태 그대로 캡처
        const dataUrl = canvas.toDataURL("image/png");
        const link = document.createElement("a");
        const teamA = state.teamA ? state.teamA.short : "A";
        const teamB = state.teamB ? state.teamB.short : "B";
        const now = new Date();
        const ts = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,"0")}${String(now.getDate()).padStart(2,"0")}_${String(now.getHours()).padStart(2,"0")}${String(now.getMinutes()).padStart(2,"0")}`;
        link.download = `tactics_${teamA}_vs_${teamB}_${ts}.png`;
        link.href = dataUrl;
        link.click();
        showToast("이미지가 저장되었습니다.");
    });

    // ── Load modal ────────────────────────────────────────
    const loadModal = document.getElementById("load-modal");
    const savesList = document.getElementById("saves-list");
    const loadModalClose = document.getElementById("load-modal-close");
    function closeLoadModal() { loadModal.classList.add("hidden"); }
    loadModal.querySelector(".modal-backdrop").addEventListener("click", closeLoadModal);
    loadModalClose.addEventListener("click", closeLoadModal);

    function escapeHtml(str) { const d = document.createElement("div"); d.textContent = str; return d.innerHTML; }
    function escapeAttr(str) { return str.replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }

    async function openLoadModal() {
        loadModal.classList.remove("hidden");
        savesList.innerHTML = '<p class="empty-msg">불러오는 중...</p>';
        const res = await fetch("/api/saves"); const saves = await res.json();
        if (saves.length === 0) { savesList.innerHTML = '<p class="empty-msg">저장된 전술이 없습니다.</p>'; return; }
        savesList.innerHTML = "";
        for (const s of saves) {
            const item = document.createElement("div"); item.className = "save-item";
            item.innerHTML = `<div class="save-item-info"><div class="save-item-name">${escapeHtml(s.name)}</div><div class="save-item-meta">${s.formation} &middot; ${formatDate(s.updatedAt)}</div></div>
            <div class="save-item-actions"><button class="btn-load-item" data-id="${s.id}">불러오기</button><button class="btn-overwrite-item" data-id="${s.id}" data-name="${escapeAttr(s.name)}">덮어쓰기</button><button class="btn-link-item" data-id="${s.id}" title="공유 링크 복사">🔗</button><button class="btn-delete-item" data-id="${s.id}">삭제</button></div>`;
            savesList.appendChild(item);
        }
        savesList.onclick = async (e) => {
            const btn = e.target.closest("button"); if (!btn) return;
            const id = btn.dataset.id;
            if (btn.classList.contains("btn-load-item")) { const r = await fetch(`/api/saves/${id}`); applySnapshot(await r.json()); closeLoadModal(); showToast("전술을 불러왔습니다."); }
            else if (btn.classList.contains("btn-overwrite-item")) { closeLoadModal(); openSaveModal(id, btn.dataset.name); }
            else if (btn.classList.contains("btn-link-item")) { copyShareLink(id); }
            else if (btn.classList.contains("btn-delete-item")) { if (!confirm("정말 삭제하시겠습니까?")) return; await fetch(`/api/saves/${id}`, { method: "DELETE" }); showToast("삭제되었습니다."); openLoadModal(); }
        };
    }
    document.getElementById("btn-load").addEventListener("click", openLoadModal);

    // ── 경기 라인업 불러오기 (SofaScore) ─────────────────
    const matchLoadModal  = document.getElementById("match-load-modal");
    const matchLoadList   = document.getElementById("match-load-list");
    const matchLoadDate   = document.getElementById("match-load-date");
    const matchLoadClose  = document.getElementById("match-load-close");
    const matchLoadCheck  = document.getElementById("match-load-has-lineup");
    function closeMatchLoadModal() { matchLoadModal.classList.add("hidden"); }
    matchLoadModal.querySelector(".modal-backdrop").addEventListener("click", closeMatchLoadModal);
    matchLoadClose.addEventListener("click", closeMatchLoadModal);

    async function openMatchLoadModal() {
        matchLoadModal.classList.remove("hidden");
        if (!matchLoadDate.value) {
            // 오늘 날짜로 즉시 경기 목록 표시 (대기 없음)
            const t = new Date(); const p = n => String(n).padStart(2, "0");
            matchLoadDate.value = `${t.getFullYear()}-${p(t.getMonth()+1)}-${p(t.getDate())}`;
            // latest-lineup-date와 matches-by-date를 병렬 요청
            const [, latestRes] = await Promise.all([
                refreshMatchList(),
                fetch("/api/matches-latest-lineup-date").then(r => r.json()).catch(() => null),
            ]);
            // 최신 라인업 날짜가 오늘과 다르면 날짜 업데이트 후 재조회
            if (latestRes && latestRes.date && latestRes.date !== matchLoadDate.value) {
                matchLoadDate.value = latestRes.date;
                refreshMatchList();
            }
        } else {
            refreshMatchList();
        }
    }

    async function refreshMatchList() {
        const date = matchLoadDate.value;
        const onlyLineup = matchLoadCheck.checked ? "&has_lineup=1" : "";
        matchLoadList.innerHTML = '<p class="empty-msg">불러오는 중...</p>';
        if (!date) { matchLoadList.innerHTML = '<p class="empty-msg">날짜를 선택하세요.</p>'; return; }
        try {
            const r = await fetch(`/api/matches-by-date?date=${date}${onlyLineup}`);
            const matches = await r.json();
            if (!Array.isArray(matches) || matches.length === 0) {
                matchLoadList.innerHTML = '<p class="empty-msg">해당 날짜에 경기가 없습니다.</p>';
                return;
            }
            matchLoadList.innerHTML = "";
            for (const m of matches) {
                const item = document.createElement("div");
                item.className = "match-item" + (m.has_lineup ? "" : " no-lineup");
                item.dataset.eventId = m.event_id;
                item.dataset.hasLineup = m.has_lineup ? "1" : "0";

                const emblem = (slug, emblem) => emblem ? `<img src="/static/img/emblems/${emblem}" alt="${escapeHtml(slug||'')}" onerror="this.style.display='none'">` : "";
                const homeScore = (m.home_score != null) ? m.home_score : "-";
                const awayScore = (m.away_score != null) ? m.away_score : "-";
                const scoreCls = (m.home_score == null) ? "no-score" : "";

                item.innerHTML = `
                    <div>
                        <div class="match-item-kickoff">${m.kickoff || ""}</div>
                        <div class="match-item-league">${m.league}</div>
                    </div>
                    <div class="match-item-team home">
                        ${emblem(m.home.slug, m.home.emblem)}
                        <span class="match-item-team-name">${escapeHtml(m.home.short || m.home.name || "")}</span>
                    </div>
                    <div class="match-item-team away">
                        <span class="match-item-team-name">${escapeHtml(m.away.short || m.away.name || "")}</span>
                        ${emblem(m.away.slug, m.away.emblem)}
                    </div>
                    <div class="match-item-score ${scoreCls}">${homeScore} : ${awayScore}</div>
                    ${m.has_lineup ? "" : '<div class="match-item-nolu">라인업 데이터 없음</div>'}
                `;
                matchLoadList.appendChild(item);
            }
        } catch (e) {
            matchLoadList.innerHTML = '<p class="empty-msg">조회 중 오류가 발생했습니다.</p>';
        }
    }

    matchLoadDate.addEventListener("change", refreshMatchList);
    matchLoadCheck.addEventListener("change", refreshMatchList);
    matchLoadList.addEventListener("click", async (e) => {
        const item = e.target.closest(".match-item");
        if (!item) return;
        if (item.dataset.hasLineup !== "1") { showToast("이 경기는 라인업 데이터가 없습니다."); return; }
        const eid = item.dataset.eventId;
        matchLoadList.style.opacity = "0.5";
        try {
            const r = await fetch(`/api/match-lineup?event_id=${eid}`);
            const data = await r.json();
            if (!data.ready) { showToast("라인업을 불러올 수 없습니다: " + (data.reason || "")); return; }
            applyMatchLineup(data);
            closeMatchLoadModal();
            showToast(`${data.home.short} vs ${data.away.short} (${data.date}) 적용 완료`);
        } catch (err) {
            showToast("라인업 적용 실패");
        } finally {
            matchLoadList.style.opacity = "";
        }
    });

    function applyMatchLineup(data) {
        // 1) 팀 세팅 (TEAMS 리스트에서 slug 매칭; 없으면 최소 객체)
        function resolveTeam(sideData) {
            if (!sideData) return null;
            if (sideData.slug && state.teams.length) {
                const t = state.teams.find(x => x.id === sideData.slug);
                if (t) return t;
            }
            // fallback: K3 등 TEAMS에 없는 팀
            return {
                id: sideData.slug || `ss_${sideData.team_id}`,
                name: sideData.name, short: sideData.short,
                league: "", primary: "#888", secondary: "#ccc", accent: "#fff",
                emblem: sideData.emblem || "",
            };
        }
        state.teamA = resolveTeam(data.home);
        state.teamB = resolveTeam(data.away);
        state.kitA = "home"; state.kitB = "away";
        document.querySelectorAll('.kit-toggle-btn').forEach(b => {
            b.classList.toggle("active",
                (b.dataset.side === "A" && b.dataset.kit === "home") ||
                (b.dataset.side === "B" && b.dataset.kit === "away"));
        });

        // 2) 포메이션 세팅 (슬롯 좌표는 서버가 준 것을 그대로)
        state.formationA = data.home.formation;
        state.formationB = data.away.formation;
        state.slots.A = data.home.slots.map(s => ({ idx: s.slot_order, team: "A", x: s.x, y: s.y, label: s.label || "" }));
        state.slots.B = data.away.slots.map(s => ({ idx: s.slot_order, team: "B", x: s.x, y: s.y, label: s.label || "" }));

        // 포메이션 드롭다운에도 동기화 (미지 포메이션이면 옵션 동적 추가)
        document.querySelectorAll(".formation-select-team").forEach(sel => {
            const side = sel.dataset.side;
            const name = side === "A" ? state.formationA : state.formationB;
            if (name && !Array.from(sel.options).some(o => o.value === name)) {
                const opt = document.createElement("option");
                opt.value = name; opt.textContent = name;
                sel.appendChild(opt);
            }
            sel.value = name;
        });
        // state.formations 에 런타임 추가 (후속 로드 재사용용).
        // _fromMatch 플래그로 표시하여 "내 포메이션" 그룹에 섞이지 않게 한다.
        [["A", data.home], ["B", data.away]].forEach(([side, sd]) => {
            if (!sd.formation) return;
            if (!state.formations[sd.formation]) {
                state.formations[sd.formation] = { teamA: [], teamB: [], labelsA: [], labelsB: [], _fromMatch: true };
            }
            const f = state.formations[sd.formation];
            if (side === "A") {
                f.teamA  = sd.slots.map(s => ({ x: s.x, y: s.y }));
                f.labelsA = sd.slots.map(s => s.label || "");
            } else {
                f.teamB  = sd.slots.map(s => ({ x: s.x, y: s.y }));
                f.labelsB = sd.slots.map(s => s.label || "");
            }
        });

        // 3) 선수 목록 구성 (선발 → 슬롯 배치, 교체 → 벤치)
        const POS_SS_TO_APP = { G: "GK", D: "DF", M: "MF", F: "FW" };
        state.players = [];
        function pushSide(side, sd) {
            for (const p of (sd.starters || [])) {
                const slot = state.slots[side].find(s => s.idx === p.slot_order) || state.slots[side][0];
                state.players.push({
                    id: state.nextId++, team: side,
                    x: slot.x, y: slot.y, onField: true, slotIdx: slot.idx,
                    name: p.name || p.name_raw || "", number: p.shirt_number || null,
                    position: POS_SS_TO_APP[p.position] || "",
                    slotLabel: slot.label || "",  // 4-3-3/4-2-3-1 등 라인 구분용 디테일 라벨
                    height: p.height || null, weight: null, dob: "",
                    playerId: p.player_id,
                });
            }
            for (const p of (sd.subs || [])) {
                state.players.push({
                    id: state.nextId++, team: side,
                    x: 0, y: 0, onField: false, slotIdx: null,
                    name: p.name || p.name_raw || "", number: p.shirt_number || null,
                    position: POS_SS_TO_APP[p.position] || "",
                    height: p.height || null, weight: null, dob: "",
                    playerId: p.player_id,
                });
            }
        }
        pushSide("A", data.home);
        pushSide("B", data.away);

        // 4) 이전 그리기/애니메이션/공 제거 (깨끗한 보드로)
        state.lines = []; state.animations = []; state.balls = [];

        updateBanner(); updateLegend(); render(); renderBench();
    }

    document.getElementById("btn-match-load").addEventListener("click", openMatchLoadModal);

    // 외부(prediction.js 등)에서 경기 라인업 적용 요청 수신
    document.addEventListener("matchLineupLoaded", (e) => {
        if (!e.detail || !e.detail.ready) return;
        applyMatchLineup(e.detail);
        showToast(`${e.detail.home.short} vs ${e.detail.away.short} (${e.detail.date}) 전술판 적용`);
    });

    // 예정 매치/라인업 없는 매치 클릭 — 이전 전술판 잔류 제거 (새 매치 팀 + 기본 포메이션)
    document.addEventListener("matchLineupCleared", (e) => {
        const d = e.detail || {};
        const tA = state.teams.find(t => t.id === d.home);
        const tB = state.teams.find(t => t.id === d.away);
        if (tA) state.teamA = tA;
        if (tB) state.teamB = tB;
        state.lines = []; state.animations = []; state.balls = [];
        loadFormation("4-4-2");   // 선수 비우고 기본 포메이션 (render 포함)
    });

    // ── Team selection ────────────────────────────────────
    const teamModal = document.getElementById("team-modal");
    const teamModalTitle = document.getElementById("team-modal-title");
    const teamGrid = document.getElementById("team-grid");
    const teamModalClose = document.getElementById("team-modal-close");
    const leagueTabs = document.querySelectorAll(".league-tab");
    let pickingSide = "A", currentLeague = "K1";

    function createLogoBadge(team, size) {
        const el = document.createElement("div");
        Object.assign(el.style, { width: size+"px", height: size+"px", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: "0", overflow: "hidden", background: "#1a1a2e", border: `2px solid ${team.secondary}` });
        if (team.emblem) {
            const img = document.createElement("img");
            img.src = `/static/img/emblems/${team.emblem}`; img.alt = team.short;
            Object.assign(img.style, { width: "90%", height: "90%", objectFit: "contain" });
            img.onerror = () => { img.remove(); el.textContent = team.short; Object.assign(el.style, { fontWeight: "800", fontSize: (size*0.28)+"px", color: team.accent==="#000000"?"#000":"#fff", background: `linear-gradient(135deg,${team.primary} 60%,${team.accent} 100%)` }); };
            el.appendChild(img);
        } else {
            el.textContent = team.short;
            Object.assign(el.style, { fontWeight: "800", fontSize: (size*0.28)+"px", color: team.accent==="#000000"?"#000":"#fff", background: `linear-gradient(135deg,${team.primary} 60%,${team.accent} 100%)` });
        }
        return el;
    }

    function renderTeamGrid() {
        teamGrid.innerHTML = "";
        teamGrid.style.gridTemplateColumns = "";
        const filtered = state.teams.filter((t) => t.league === currentLeague);
        const cur = pickingSide === "A" ? state.teamA : state.teamB;
        for (const team of filtered) {
            const card = document.createElement("div"); card.className = "team-card";
            if (cur && cur.id === team.id) card.classList.add("selected");
            const logo = createLogoBadge(team, 36); logo.classList.add("team-card-logo");
            const nm = document.createElement("span"); nm.className = "team-card-name"; nm.textContent = team.name;
            card.appendChild(logo); card.appendChild(nm);
            card.addEventListener("click", () => selectTeam(team));
            teamGrid.appendChild(card);
        }
    }

    async function selectTeam(team) {
        const side = pickingSide;
        if (side === "A") state.teamA = team; else state.teamB = team;
        updateBanner(); updateLegend(); render();
        closeTeamModal();

        // 이 팀 선수 제거 후 squad 로드 → 포메이션 슬롯에 자동 배치
        state.players = state.players.filter((p) => p.team !== side);
        try {
            const res = await fetch(`/api/squads?teamId=${team.id}`);
            const squads = await res.json();
            if (squads.length > 0) {
                const r = await fetch(`/api/squads/${squads[0].id}`);
                const squadData = await r.json();
                const slots = state.slots[side] || [];
                const usedSlots = new Set();

                // 선수 객체 먼저 생성
                const allPlayers = (squadData.players || []).map(sp => ({
                    id: state.nextId++, team: side,
                    x: 0, y: 0, onField: false, slotIdx: null,
                    name: sp.name, number: sp.number,
                    position: sp.position || "",
                    height: sp.height || null,
                    weight: sp.weight || null,
                    dob: sp.dob || "",
                }));

                // 슬롯별 포지션 매핑으로 자동 배치
                for (const slot of slots) {
                    const matchPos = Object.entries(POS_MAP).find(([, labels]) => labels.includes(slot.label))?.[0];
                    // 해당 포지션 미배치 선수 중 첫 번째
                    const candidate = allPlayers.find(p =>
                        !p.onField && (p.position === matchPos || (!matchPos && !p.onField))
                    );
                    if (candidate) {
                        candidate.x = slot.x; candidate.y = slot.y;
                        candidate.onField = true; candidate.slotIdx = slot.idx;
                        usedSlots.add(slot.idx);
                    }
                }

                state.players.push(...allPlayers);
                showToast(`${team.name} 선택 완료 (${allPlayers.length}명)`);
            } else {
                showToast(`${team.name} 선택 완료`);
            }
        } catch (e) {
            showToast(`${team.name} 선택 완료`);
        }
        render(); renderBench();
    }

    // HUD의 팀 칩(엠블럼 + 이름)도 동기화
    function setHudChip(side, team, fallbackLetter) {
        const badgeEl = document.getElementById("fhud-badge-" + side.toLowerCase());
        const nameEl  = document.getElementById("fhud-name-"  + side.toLowerCase());
        if (!badgeEl || !nameEl) return;
        badgeEl.innerHTML = "";
        if (team) {
            if (team.emblem) {
                const img = document.createElement("img");
                img.src = `/static/img/emblems/${team.emblem}`;
                img.alt = team.short || "";
                img.onerror = () => {
                    img.remove();
                    badgeEl.style.background = `linear-gradient(135deg,${team.primary || "#333"} 60%,${team.accent || "#888"} 100%)`;
                    badgeEl.innerHTML = `<span class="fhud-chip-letter">${(team.short || "?")[0]}</span>`;
                };
                badgeEl.appendChild(img);
                badgeEl.style.background = "#1a1a2e";
            } else {
                badgeEl.style.background = `linear-gradient(135deg,${team.primary || "#333"} 60%,${team.accent || "#888"} 100%)`;
                badgeEl.innerHTML = `<span class="fhud-chip-letter">${(team.short || "?")[0]}</span>`;
            }
            nameEl.textContent = team.short || team.name || "";
        } else {
            // 미선택: 기본 색상 복귀 (CSS의 :not-selected 스타일)
            badgeEl.style.background = "";  // CSS 기본값 사용
            badgeEl.innerHTML = `<span class="fhud-chip-letter">${fallbackLetter}</span>`;
            nameEl.textContent = side === "A" ? "HOME" : "AWAY";
        }
    }

    function updateBanner() {
        setHudChip("A", state.teamA, "H");
        setHudChip("B", state.teamB, "A");
        updateTeamColors();
    }

    function updateTeamColors() {
        const root = document.documentElement;
        const colorA = state.teamA ? (state.teamA.primary || "#2563eb") : "#2563eb";
        const colorB = state.teamB ? (state.teamB.primary || "#dc2626") : "#dc2626";
        root.style.setProperty("--team-a", colorA);
        root.style.setProperty("--team-b", colorB);

        const toolbar = document.getElementById("toolbar");
        if (!toolbar) return;

        if (state.teamA || state.teamB) {
            const gradA = colorA + "40";
            const gradB = colorB + "40";
            toolbar.style.background = `linear-gradient(135deg, ${gradA} 0%, var(--bg-surface) 40%, var(--bg-surface) 60%, ${gradB} 100%)`;
        } else {
            toolbar.style.background = "";
        }

        let strip = document.getElementById("toolbar-team-strip");
        if (!strip) {
            strip = document.createElement("div");
            strip.id = "toolbar-team-strip";
            toolbar.appendChild(strip);
        }
        if (state.teamA || state.teamB) {
            strip.style.background = `linear-gradient(90deg, ${colorA} 50%, ${colorB} 50%)`;
            strip.style.display = "";
        } else {
            strip.style.display = "none";
        }
    }

    function updateLegend() {
        const la = document.querySelector(".legend-item.team-a"), lb = document.querySelector(".legend-item.team-b");
        if (!la || !lb) return;
        la.textContent = state.teamA ? state.teamA.short : "HOME";
        lb.textContent = state.teamB ? state.teamB.short : "AWAY";
        la.style.setProperty("--team-color", getTeamColor("A"));
        lb.style.setProperty("--team-color", getTeamColor("B"));
    }

    function openTeamModal(side) { pickingSide = side; teamModalTitle.textContent = side === "A" ? "HOME 팀 선택" : "AWAY 팀 선택"; teamModal.classList.remove("hidden"); renderTeamGrid(); }
    function closeTeamModal() { teamModal.classList.add("hidden"); }
    teamModal.querySelector(".modal-backdrop").addEventListener("click", closeTeamModal);
    teamModalClose.addEventListener("click", closeTeamModal);
    leagueTabs.forEach((tab) => tab.addEventListener("click", () => { leagueTabs.forEach((t) => t.classList.remove("active")); tab.classList.add("active"); currentLeague = tab.dataset.league; renderTeamGrid(); }));
    document.querySelectorAll(".team-pick-btn").forEach((btn) => btn.addEventListener("click", () => openTeamModal(btn.dataset.side)));

    // ── HOME / AWAY kit toggle ──────────────────────────
    document.querySelectorAll(".kit-toggle-btn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            const side = btn.dataset.side;
            const kit = btn.dataset.kit;
            if (side === "A") state.kitA = kit; else state.kitB = kit;
            // update button states
            document.querySelectorAll(`.kit-toggle-btn[data-side="${side}"]`).forEach((b) => {
                b.classList.toggle("active", b.dataset.kit === kit);
            });
            render(); renderBench();
        });
    });

    // ── Squad save / load ─────────────────────────────────
    const squadModal = document.getElementById("squad-modal");
    const squadModalTitle = document.getElementById("squad-modal-title");
    const squadList = document.getElementById("squad-list");
    const squadModalClose = document.getElementById("squad-modal-close");
    let squadLoadSide = "A";

    function closeSquadModal() { squadModal.classList.add("hidden"); }
    squadModal.querySelector(".modal-backdrop").addEventListener("click", closeSquadModal);
    squadModalClose.addEventListener("click", closeSquadModal);

    document.querySelectorAll(".squad-save-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
            const side = btn.dataset.side;
            const team = side === "A" ? state.teamA : state.teamB;
            const teamPlayers = state.players.filter((p) => p.team === side);
            if (teamPlayers.length === 0) { showToast("저장할 선수가 없습니다."); return; }

            const teamName = team ? team.short : (side === "A" ? "HOME" : "AWAY");
            const name = prompt(`스쿼드 이름을 입력하세요:`, teamName + " 스쿼드");
            if (!name) return;

            await fetch("/api/squads", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    teamId: team ? team.id : "",
                    name: name,
                    players: teamPlayers.map((p) => ({
                        number: p.number, name: p.name,
                        position: p.position || "",
                        height: p.height || null, weight: p.weight || null, dob: p.dob || "",
                        x: p.x, y: p.y, onField: p.onField, slotIdx: p.slotIdx ?? null,
                    })),
                }),
            });
            showToast("스쿼드가 저장되었습니다.");
        });
    });

    document.querySelectorAll(".squad-load-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
            squadLoadSide = btn.dataset.side;
            const team = squadLoadSide === "A" ? state.teamA : state.teamB;
            squadModalTitle.textContent = (team ? team.short : (squadLoadSide === "A" ? "HOME" : "AWAY")) + " 스쿼드 불러오기";
            squadModal.classList.remove("hidden");
            squadList.innerHTML = '<p class="empty-msg">불러오는 중...</p>';

            const url = team ? `/api/squads?teamId=${team.id}` : "/api/squads";
            const res = await fetch(url);
            const squads = await res.json();
            if (squads.length === 0) { squadList.innerHTML = '<p class="empty-msg">저장된 스쿼드가 없습니다.</p>'; return; }

            squadList.innerHTML = "";
            for (const s of squads) {
                const item = document.createElement("div"); item.className = "save-item";
                const teamObj = state.teams.find((t) => t.id === s.teamId);
                const teamLabel = teamObj ? teamObj.short : "";
                item.innerHTML = `<div class="save-item-info"><div class="save-item-name">${escapeHtml(s.name)}</div><div class="save-item-meta">${teamLabel} &middot; ${s.playerCount}명</div></div>
                <div class="save-item-actions"><button class="btn-load-item" data-id="${s.id}">적용</button><button class="btn-delete-item" data-id="${s.id}">삭제</button></div>`;
                squadList.appendChild(item);
            }
            squadList.onclick = async (e) => {
                const btn2 = e.target.closest("button"); if (!btn2) return;
                const id = btn2.dataset.id;
                if (btn2.classList.contains("btn-load-item")) {
                    const r = await fetch(`/api/squads/${id}`);
                    const data = await r.json();
                    applySquad(squadLoadSide, data);
                    closeSquadModal();
                    showToast("스쿼드를 적용했습니다.");
                } else if (btn2.classList.contains("btn-delete-item")) {
                    if (!confirm("정말 삭제하시겠습니까?")) return;
                    const delRes = await fetch(`/api/squads/${id}`, { method: "DELETE" });
                    if (!delRes.ok) { showToast("삭제 실패"); return; }
                    showToast("삭제되었습니다.");
                    // 목록 새로고침
                    const url2 = (squadLoadSide === "A" ? state.teamA : state.teamB)
                        ? `/api/squads?teamId=${(squadLoadSide === "A" ? state.teamA : state.teamB).id}`
                        : "/api/squads";
                    const res2 = await fetch(url2);
                    const squads2 = await res2.json();
                    if (squads2.length === 0) { squadList.innerHTML = '<p class="empty-msg">저장된 스쿼드가 없습니다.</p>'; return; }
                    squadList.innerHTML = "";
                    for (const s2 of squads2) {
                        const item2 = document.createElement("div"); item2.className = "save-item";
                        const teamObj2 = state.teams.find((t) => t.id === s2.teamId);
                        item2.innerHTML = `<div class="save-item-info"><div class="save-item-name">${escapeHtml(s2.name)}</div><div class="save-item-meta">${teamObj2 ? teamObj2.short : ""} &middot; ${s2.playerCount}명</div></div>
                        <div class="save-item-actions"><button class="btn-load-item" data-id="${s2.id}">적용</button><button class="btn-delete-item" data-id="${s2.id}">삭제</button></div>`;
                        squadList.appendChild(item2);
                    }
                }
            };
        });
    });

    function applySquad(side, squadData) {
        state.players = state.players.filter((p) => p.team !== side);

        const allPlayers = (squadData.players || []).map(sp => ({
            id: state.nextId++, team: side,
            x: sp.x ?? 0, y: sp.y ?? 0,
            onField: sp.onField ?? false,
            slotIdx: sp.slotIdx ?? null,
            name: sp.name, number: sp.number,
            position: sp.position || "",
            height: sp.height || null,
            weight: sp.weight || null,
            dob: sp.dob || "",
        }));

        // 위치 정보가 없는 구버전 스쿼드 → 포지션 매칭으로 자동 배치
        const hasPosition = allPlayers.some(p => p.onField);
        if (!hasPosition) {
            const slots = state.slots[side] || [];
            for (const slot of slots) {
                const matchPos = Object.entries(POS_MAP).find(([, labels]) => labels.includes(slot.label))?.[0];
                const candidate = allPlayers.find(p =>
                    !p.onField && p.position === matchPos
                );
                if (candidate) {
                    candidate.x = slot.x; candidate.y = slot.y;
                    candidate.onField = true; candidate.slotIdx = slot.idx;
                }
            }
        }

        state.players.push(...allPlayers);

        if (squadData.teamId) {
            const team = state.teams.find((t) => t.id === squadData.teamId);
            if (team) {
                if (side === "A") state.teamA = team; else state.teamB = team;
                updateBanner(); updateLegend();
            }
        }
        render(); renderBench();
    }

    // ── Snapshot: include kit + icon color state ─────────
    const _origSnapshot = getStateSnapshot;
    getStateSnapshot = function () {
        const snap = _origSnapshot();
        snap.kitA = state.kitA;
        snap.kitB = state.kitB;
        return snap;
    };
    const _origApply = applySnapshot;
    applySnapshot = function (data) {
        state.kitA = data.kitA || "home";
        state.kitB = data.kitB || "home";
        document.querySelectorAll('.kit-toggle-btn[data-side="A"]').forEach((b) => b.classList.toggle("active", b.dataset.kit === state.kitA));
        document.querySelectorAll('.kit-toggle-btn[data-side="B"]').forEach((b) => b.classList.toggle("active", b.dataset.kit === state.kitB));
        _origApply(data);
    };

    // ── Init ───────────────────────────────────────────────
    window.addEventListener("resize", resize);
    Promise.all([
        fetch("/api/formations").then((r) => r.json()),
        fetch("/api/teams").then((r) => r.json()),
    ]).then(([formData, teamData]) => {
        state.formations = formData; state.teams = teamData;
        loadCustomFormations();
        resize(); loadFormation("4-4-2");
        const _shareId = new URLSearchParams(location.search).get("share");
        if (_shareId) {
            fetch(`/api/saves/${encodeURIComponent(_shareId)}`)
                .then(r => r.ok ? r.json() : null)
                .then(data => { if (data && !data.error) { applySnapshot(data); showToast(`"${data.name}" 전술을 불러왔습니다.`); } });
        }
    });
})();

