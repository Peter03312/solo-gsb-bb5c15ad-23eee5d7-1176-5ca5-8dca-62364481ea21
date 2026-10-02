'use strict';
// 设备停机（检修）窗口。
//
// 窗口为左闭右开区间 [start_at, end_at)：起点须早于终点；同设备 ACTIVE 窗口不可重叠，
// 首尾相接（相邻）允许。登记或调整窗口若覆盖（命中）已有加工/清洗事件，返回冲突事件并
// 整次拒绝（不产生窗口、不改变既有窗口与任何事件/推导结果）。
//
// 窗口生效期间该设备不能记录加工或清洗：
//   - 单条事件新增/更正、断网整包补录、换线整组预演与确认应用，均按“最终设备 + 最终时间”
//     核对窗口；命中即指出冲突窗口/事件，整次拒绝。
//   - 预演不写正式数据；窗口变动会使旧预演版本过期（见 replan 指纹）。
// 停机不等于清洗：窗口不参与时间线回放，不改变设备残留与过敏原推导。
//
// 取消（CANCELLED）为终态：取消后窗口不再拦截任何事件；取消后的窗口不可再调整，只能登记新窗口。

const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

class DowntimeError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = 'DowntimeError';
    this.code = code;
    this.details = (extra && extra.details) || [];
    if (extra) {
      this.conflict_events = extra.conflict_events || [];
      this.conflict_windows = extra.conflict_windows || [];
    }
  }
}

// 当前本地时间（分钟精度）：取消窗口未显式给 cancelled_at 时使用。
function nowMinute() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 窗口/事件时间统一到分钟精度（YYYY-MM-DDTHH:MM），便于左闭右开比较。
// 输入已由 TIME_RE 校验为合法 ISO（分钟或秒精度）。
function minuteOf(t) {
  return String(t).slice(0, 16);
}

// 解析并校验一个窗口的“设备 + 起止时间”（不含原因/操作人）。
function parseWindowSpec(db, body) {
  body = body || {};
  const equipment_id = parseInt(body.equipment_id, 10);
  if (!Number.isInteger(equipment_id)) {
    throw new DowntimeError('INVALID_REQUEST', '请选择设备 equipment_id');
  }
  const equip = db.prepare('SELECT id, code, name FROM equipment WHERE id = ?').get(equipment_id);
  if (!equip) {
    throw new DowntimeError('EQUIPMENT_NOT_FOUND', `设备 #${equipment_id} 不存在，请先登记设备`);
  }
  const start_at = String(body.start_at || body.start_time || '').trim();
  const end_at = String(body.end_at || body.end_time || '').trim();
  if (!TIME_RE.test(start_at)) {
    throw new DowntimeError('INVALID_REQUEST', '起始时间格式应为 YYYY-MM-DDTHH:MM，例如 2026-10-02T13:00');
  }
  if (!TIME_RE.test(end_at)) {
    throw new DowntimeError('INVALID_REQUEST', '结束时间格式应为 YYYY-MM-DDTHH:MM，例如 2026-10-02T16:00');
  }
  const s = minuteOf(start_at);
  const e = minuteOf(end_at);
  if (!(s < e)) {
    throw new DowntimeError(
      'INVALID_REQUEST',
      '停机窗口起点必须早于终点（左闭右开区间 [起始, 结束)）'
    );
  }
  return { equipment_id, equipment: equip, start_at: s, end_at: e };
}

// ---------- 事件命中核对 ----------
// 左闭右开判定：事件时间点落在 [start_at, end_at) 内（start_at <= t < end_at）。
function formatEvent(ev) {
  return {
    event_id: ev.id,
    event_time: ev.event_time,
    type: ev.type,
    equipment_id: ev.equipment_id,
    equipment_code: ev.equipment_code,
    equipment_name: ev.equipment_name,
    batch_id: ev.batch_id,
    batch_code: ev.batch_code,
    note: ev.note || ''
  };
}

// 取命中给定“设备 + 分钟时间点”的 ACTIVE 窗口；excludeId 指定调整时忽略的自身窗口。
function windowsCovering(db, equipmentId, atMinute, excludeId = null) {
  return db.prepare(
    `SELECT w.id, w.equipment_id, w.start_at, w.end_at, w.reason, w.operator, w.status,
            e.code AS equipment_code, e.name AS equipment_name
       FROM downtime_windows w JOIN equipment e ON e.id = w.equipment_id
      WHERE w.status = 'ACTIVE' AND w.equipment_id = ?
        AND w.start_at <= ? AND ? < w.end_at
        AND (? IS NULL OR w.id <> ?)`
  ).all(equipmentId, atMinute, atMinute, excludeId, excludeId);
}

// 对一批“最终设备 + 最终时间”的事件描述统一核对窗口。
// specs: [{ key?, equipment_id, event_time }]；key 可选（回传便于调用方定位记录）。
// 返回 [{ spec, windows:[格式化窗口] }, ...]；为空表示全部不命中。
function findEventWindowConflicts(db, specs) {
  const conflicts = [];
  for (const spec of specs) {
    if (!spec || !Number.isInteger(spec.equipment_id) || !spec.event_time) continue;
    const at = minuteOf(spec.event_time);
    const wins = windowsCovering(db, spec.equipment_id, at, spec.exclude_window_id || null);
    if (wins.length) conflicts.push({ spec, windows: wins.map(formatWindowBrief) });
  }
  return conflicts;
}

// 单条事件新增/更正路径：写库后在同一事务内核对其最终设备与时间（命中即抛错回滚）。
function assertEventAllowed(db, equipmentId, eventTime) {
  const at = minuteOf(eventTime);
  const wins = windowsCovering(db, equipmentId, at);
  if (wins.length) {
    const conflict_windows = wins.map(formatWindowBrief);
    const details = conflict_windows.map((w) =>
      `设备 ${w.equipment_code} 在 ${at} 处于停机窗口 #${w.window_id}` +
      `（${w.start_at} ~ ${w.end_at}，左闭右开），检修期间不能记录加工或清洗` +
      (w.reason ? `：${w.reason}` : ''));
    throw new DowntimeError(
      'DOWNTIME_WINDOW_CONFLICT',
      `设备在 ${at} 处于停机检修窗口，检修期间不能记录加工或清洗；请先调整/取消窗口后再提交`,
      { details, conflict_windows }
    );
  }
}

// 断网整包补录 / 换线整组预演路径：对一组事件描述统一核对，命中即整次拒绝。
// label 用于详情前缀（如 “records[2]（外部记录号 X）”、“事件 #3 的更正”）。
function assertEventsAllowed(db, specs, { describe } = {}) {
  const conflicts = findEventWindowConflicts(db, specs);
  if (conflicts.length) {
    const conflict_windows = [];
    const seenWin = new Set();
    const details = conflicts.map((c) => {
      for (const w of c.windows) {
        if (!seenWin.has(w.window_id)) { seenWin.add(w.window_id); conflict_windows.push(w); }
      }
      const head = describe ? describe(c.spec) : `设备 #${c.spec.equipment_id} @ ${minuteOf(c.spec.event_time)}`;
      return `${head}：命中停机窗口 ${c.windows.map((w) =>
        `#${w.window_id}（${w.start_at} ~ ${w.end_at}${w.reason ? `，${w.reason}` : ''}）`).join('、')}` +
        '，检修期间不能记录加工或清洗';
    });
    throw new DowntimeError(
      'DOWNTIME_WINDOW_CONFLICT',
      '提交内容命中设备停机检修窗口：检修期间不能记录加工或清洗，整次拒绝且不改变任何数据',
      { details, conflict_windows }
    );
  }
}

function formatWindowBrief(w) {
  return {
    window_id: w.id,
    equipment_id: w.equipment_id,
    equipment_code: w.equipment_code,
    equipment_name: w.equipment_name,
    start_at: w.start_at,
    end_at: w.end_at,
    reason: w.reason || '',
    operator: w.operator || '',
    status: w.status
  };
}

// ---------- 窗口自身校验：同设备不重叠（相邻允许） + 不覆盖既有事件 ----------
function overlappingWindows(db, equipmentId, startAt, endAt, excludeId = null) {
  // 重叠判定（左闭右开、相邻不重叠）：a.start < b.end AND a.end > b.start
  return db.prepare(
    `SELECT w.*, e.code AS equipment_code, e.name AS equipment_name
       FROM downtime_windows w JOIN equipment e ON e.id = w.equipment_id
      WHERE w.status = 'ACTIVE' AND w.equipment_id = ?
        AND w.start_at < ? AND w.end_at > ?
        AND (? IS NULL OR w.id <> ?)
      ORDER BY w.start_at, w.id`
  ).all(equipmentId, endAt, startAt, excludeId, excludeId);
}

function eventsWithin(db, equipmentId, startAt, endAt) {
  // 事件被窗口覆盖：start_at <= event_time < end_at
  return db.prepare(
    `SELECT ev.id, ev.event_time, ev.type, ev.equipment_id,
            ev.batch_id, b.code AS batch_code, ev.note,
            e.code AS equipment_code, e.name AS equipment_name
       FROM events ev
       LEFT JOIN batches b ON b.id = ev.batch_id
       JOIN equipment e ON e.id = ev.equipment_id
      WHERE ev.equipment_id = ? AND ev.event_time >= ? AND ev.event_time < ?
      ORDER BY ev.event_time, ev.id`
  ).all(equipmentId, startAt, endAt).map(formatEvent);
}

// 登记/调整窗口前的统一核对：起点早于终点（parseWindowSpec 已保证）、
// 同设备 ACTIVE 窗口不重叠、不覆盖既有加工/清洗事件。任一不满足整次拒绝。
function assertWindowPlaceable(db, spec, excludeId = null) {
  const overlaps = overlappingWindows(db, spec.equipment_id, spec.start_at, spec.end_at, excludeId);
  const covered = eventsWithin(db, spec.equipment_id, spec.start_at, spec.end_at);
  if (overlaps.length || covered.length) {
    const details = [];
    details.push(...overlaps.map((w) =>
      `与同设备已有停机窗口 #${w.id}（${w.start_at} ~ ${w.end_at}，左闭右开）重叠；` +
      '同设备窗口不可重叠，首尾相接的相邻窗口允许'));
    details.push(...covered.map((ev) =>
      `覆盖已有${ev.type === 'PROCESS' ? '加工' : '清洗'}事件 #${ev.event_id}` +
      `（${ev.event_time}${ev.batch_code ? '，' + ev.batch_code : ''}）：` +
      '停机窗口不能覆盖已记录的加工/清洗事件，整次拒绝'));
    throw new DowntimeError('DOWNTIME_WINDOW_CONFLICT',
      '停机窗口与同设备既有窗口重叠或覆盖已有加工/清洗事件，整次拒绝且未做任何改动', {
        details,
        conflict_windows: overlaps.map((w) => formatWindowBrief(w)),
        conflict_events: covered
      });
  }
}

// ---------- 登记 / 调整 / 取消 ----------
function createWindow(db, body) {
  const spec = parseWindowSpec(db, body);
  const reason = String((body && body.reason) || '').trim();
  const operator = String((body && body.operator) || (body && body.registered_by) || '').trim();
  if (!operator) throw new DowntimeError('INVALID_REQUEST', '操作人 operator 不能为空');

  let id;
  db.transaction(() => {
    assertWindowPlaceable(db, spec, null);
    id = db.prepare(
      `INSERT INTO downtime_windows (equipment_id, start_at, end_at, reason, operator)
       VALUES (?,?,?,?,?)`
    ).run(spec.equipment_id, spec.start_at, spec.end_at, reason, operator).lastInsertRowid;
  })();
  return getWindow(db, id);
}

function updateWindow(db, id, body) {
  const win = db.prepare('SELECT * FROM downtime_windows WHERE id = ?').get(id);
  if (!win) throw new DowntimeError('WINDOW_NOT_FOUND', `停机窗口 #${id} 不存在`);
  if (win.status !== 'ACTIVE') {
    throw new DowntimeError('WINDOW_NOT_ACTIVE',
      `停机窗口 #${id} 已取消，取消为终态不能再调整；请登记新的停机窗口`);
  }
  const spec = parseWindowSpec(db, body);
  const reason = String((body && body.reason) || '').trim();
  const operator = String((body && body.operator) || (body && body.updated_by) || '').trim();
  if (!operator) throw new DowntimeError('INVALID_REQUEST', '操作人 operator 不能为空');

  db.transaction(() => {
    assertWindowPlaceable(db, spec, id);
    db.prepare(
      `UPDATE downtime_windows
          SET equipment_id = ?, start_at = ?, end_at = ?, reason = ?, operator = ?,
              updated_at = datetime('now')
        WHERE id = ?`
    ).run(spec.equipment_id, spec.start_at, spec.end_at, reason, operator, id);
  })();
  return getWindow(db, id);
}

function cancelWindow(db, id, body) {
  const win = db.prepare('SELECT * FROM downtime_windows WHERE id = ?').get(id);
  if (!win) throw new DowntimeError('WINDOW_NOT_FOUND', `停机窗口 #${id} 不存在`);
  if (win.status !== 'ACTIVE') {
    throw new DowntimeError('WINDOW_NOT_ACTIVE', `停机窗口 #${id} 已取消，不能重复取消`);
  }
  const cancelled_by = String(
    (body && (body.cancelled_by || body.operator)) || ''
  ).trim() || win.operator || '未署名';
  const rawCancelledAt = String((body && body.cancelled_at) || '').trim();
  if (rawCancelledAt && !TIME_RE.test(rawCancelledAt)) {
    throw new DowntimeError('INVALID_REQUEST', '取消时间格式应为 YYYY-MM-DDTHH:MM');
  }
  const cancelled_at = rawCancelledAt ? minuteOf(rawCancelledAt) : nowMinute();
  db.transaction(() => {
    db.prepare(
      `UPDATE downtime_windows
          SET status = 'CANCELLED', cancelled_at = ?, cancelled_by = ?,
              updated_at = datetime('now')
        WHERE id = ?`
    ).run(cancelled_at || nowMinute(), cancelled_by, id);
  })();
  return getWindow(db, id);
}

// ---------- 查询 ----------
function getWindowRow(db, id) {
  return db.prepare(
    `SELECT w.*, e.code AS equipment_code, e.name AS equipment_name
       FROM downtime_windows w JOIN equipment e ON e.id = w.equipment_id
      WHERE w.id = ?`
  ).get(id);
}

function formatWindow(row) {
  return {
    id: row.id,
    equipment_id: row.equipment_id,
    equipment_code: row.equipment_code,
    equipment_name: row.equipment_name,
    start_at: row.start_at,
    end_at: row.end_at,
    reason: row.reason || '',
    operator: row.operator || '',
    status: row.status,
    active: row.status === 'ACTIVE',
    cancelled_at: row.cancelled_at || null,
    cancelled_by: row.cancelled_by || '',
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

// 查询窗口：附区间内命中的加工/清洗事件（只读提示；取消后的窗口同样保留该信息）。
function getWindow(db, id) {
  const row = getWindowRow(db, id);
  if (!row) return null;
  const out = formatWindow(row);
  out.conflict_events = eventsWithin(db, row.equipment_id, row.start_at, row.end_at);
  return out;
}

function listWindows(db, { equipment_id = null, status = null, include_events = false } = {}) {
  let sql =
    `SELECT w.*, e.code AS equipment_code, e.name AS equipment_name
       FROM downtime_windows w JOIN equipment e ON e.id = w.equipment_id`;
  const where = [];
  const args = [];
  if (equipment_id != null) { where.push('w.equipment_id = ?'); args.push(equipment_id); }
  if (status) { where.push('w.status = ?'); args.push(status); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY w.start_at DESC, w.id DESC';
  const rows = db.prepare(sql).all(...args).map(formatWindow);
  if (include_events) {
    for (const w of rows) {
      w.conflict_events = eventsWithin(db, w.equipment_id, w.start_at, w.end_at);
    }
  }
  return rows;
}

// 预检查询（不写库）：给定拟登记/调整的区间，返回覆盖的既有事件与重叠的其它窗口。
// excludeId 用于“调整前预检查”时忽略自身。
function checkWindow(db, body, excludeId = null) {
  const spec = parseWindowSpec(db, body);
  const overlaps = overlappingWindows(db, spec.equipment_id, spec.start_at, spec.end_at, excludeId)
    .map(formatWindowBrief);
  const conflict_events = eventsWithin(db, spec.equipment_id, spec.start_at, spec.end_at);
  const ok = overlaps.length === 0 && conflict_events.length === 0;
  return {
    ok,
    equipment_id: spec.equipment_id,
    equipment_code: spec.equipment.code,
    equipment_name: spec.equipment.name,
    start_at: spec.start_at,
    end_at: spec.end_at,
    conflict_events,
    overlapping_windows: overlaps
  };
}

module.exports = {
  DowntimeError,
  minuteOf,
  createWindow,
  updateWindow,
  cancelWindow,
  getWindow,
  listWindows,
  checkWindow,
  // 供 server.js / backfill.js / replan.js 集成：
  assertEventAllowed,
  assertEventsAllowed,
  findEventWindowConflicts
};
