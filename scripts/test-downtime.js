'use strict';
// 设备停机（检修）窗口 端到端 HTTP 测试。
// 启动使用临时 SQLite 文件的真实服务（空白库，自建数据），验证：
//   登记/调整/取消/查询窗口；左闭右开 [start,end)；起点早于终点；
//   同设备窗口不重叠（相邻允许、跨设备允许）；
//   登记/调整覆盖已有加工/清洗事件 -> 整次拒绝并返回冲突事件，窗口与事件均不变；
//   窗口内单条事件新增/更正（PROCESS/CLEAN，含闭起点/开终点边界）-> 409 整次拒绝；
//   停机不等于清洗：窗口不截断设备残留、不改变过敏原推导；
//   断网整包补录命中窗口 -> 409 整包回滚（无事件、无台账），取消窗口后补录成功且重试幂等；
//   换线整组预演命中窗口 -> 400 REPLAN_REJECTED 不写正式数据；
//   预演后窗口变动 -> 确认应用 409 VERSION_EXPIRED，重新预演后确认成功；
//   /api/state 含 downtime_windows；有窗口台账的设备不可删除。
//   node scripts/test-downtime.js
// 退出码 0 表示全部通过。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = '39153';
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'downtime-test-'));
const dbPath = path.join(tmpDir, 'test.db');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.error(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : '');
  }
}

async function api(method, urlPath, body) {
  const res = await fetch(BASE + urlPath, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* 非 JSON */ }
  return { status: res.status, json };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady(proc) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(BASE + '/api/state');
      if (res.ok) return;
    } catch (_) { /* 未就绪 */ }
    if (proc.exitCode !== null) throw new Error('服务提前退出');
    await sleep(250);
  }
  throw new Error('服务启动超时');
}

const D = '2026-10-02T';

async function main() {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, PORT, HOST: '127.0.0.1', DB_PATH: dbPath, SEED_DEMO: 'false' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  proc.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

  try {
    await waitReady(proc);
    console.log('服务已就绪，开始测试');

    const newId = async (url, body) => (await api('POST', url, body)).json.id;
    const MILK = await newId('/api/materials', { code: 'MILK', name: '全脂奶粉', allergens: ['乳'] });
    const SALT = await newId('/api/materials', { code: 'SALT', name: '食用盐', allergens: [] });
    const L1 = await newId('/api/equipment', { code: 'L1', name: '一号线' });
    const L2 = await newId('/api/equipment', { code: 'L2', name: '二号线' });
    let r;

    const winBody = (over = {}) => ({
      equipment_id: L1, start_at: D + '10:00', end_at: D + '12:00',
      reason: '计划检修', operator: '设备员-周工', ...over
    });

    // ---------- 1. 入参校验 ----------
    console.log('1) 窗口登记入参校验');
    r = await api('POST', '/api/downtime-windows', { start_at: D + '10:00', end_at: D + '12:00', operator: '周工' });
    check('缺设备 -> 400', r.status === 400 && r.json.code === 'INVALID_REQUEST', r.json);
    r = await api('POST', '/api/downtime-windows', { equipment_id: L1, start_at: D + '10:00', end_at: 'bad', operator: '周工' });
    check('结束时间格式错 -> 400', r.status === 400 && r.json.code === 'INVALID_REQUEST', r.json);
    r = await api('POST', '/api/downtime-windows', winBody({ end_at: D + '10:00' }));
    check('起点不早于终点（相等）-> 400', r.status === 400 && r.json.code === 'INVALID_REQUEST', r.json);
    r = await api('POST', '/api/downtime-windows', winBody({ end_at: D + '09:00' }));
    check('起点晚于终点 -> 400', r.status === 400 && r.json.code === 'INVALID_REQUEST', r.json);
    r = await api('POST', '/api/downtime-windows', winBody({ operator: '' }));
    check('缺操作人 -> 400', r.status === 400 && r.json.code === 'INVALID_REQUEST', r.json);
    r = await api('POST', '/api/downtime-windows', winBody({ equipment_id: 999 }));
    check('未知设备 -> 404', r.status === 404 && r.json.code === 'EQUIPMENT_NOT_FOUND', r.json);
    r = await api('GET', '/api/downtime-windows/999');
    check('查询不存在窗口 -> 404', r.status === 404 && r.json.code === 'WINDOW_NOT_FOUND', r.json);

    // ---------- 2. 覆盖已有事件：整次拒绝并返回冲突事件 ----------
    console.log('2) 窗口覆盖已有加工/清洗事件 -> 整次拒绝');
    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: D + '09:00', equipment_id: L1,
      batch_code: 'B1', material_ids: [MILK]
    });
    check('窗口前 09:00 加工正常登记', r.status === 200, r.json);
    const ev09 = r.json.id;
    r = await api('POST', '/api/events', { type: 'CLEAN', event_time: D + '09:30', equipment_id: L1 });
    check('窗口前 09:30 清洗正常登记', r.status === 200, r.json);
    const clean0930 = r.json.id;

    r = await api('POST', '/api/downtime-windows', winBody({ start_at: D + '08:00', end_at: D + '09:30' }));
    check('覆盖 09:00 加工（不含 09:30）-> 409', r.status === 409 && r.json.code === 'DOWNTIME_WINDOW_CONFLICT', r.json);
    check('返回冲突事件 B1',
      (r.json.conflict_events || []).some((e) => e.event_id === ev09 && e.batch_code === 'B1'), r.json);
    check('不含开区间终点 09:30 清洗',
      !(r.json.conflict_events || []).some((e) => e.event_id === clean0930), r.json);
    r = await api('GET', '/api/downtime-windows');
    check('整次拒绝：没有产生窗口', r.json.downtime_windows.length === 0, r.json);

    r = await api('POST', '/api/downtime-windows', winBody({ start_at: D + '09:30', end_at: D + '10:00' }));
    check('闭起点 09:30 覆盖清洗 -> 409', r.status === 409 &&
      (r.json.conflict_events || []).some((e) => e.event_id === clean0930), r.json);

    // ---------- 3. 登记成功 / 重叠 / 相邻 / 跨设备 ----------
    console.log('3) 窗口登记：重叠拒绝、相邻与跨设备允许');
    r = await api('POST', '/api/downtime-windows', winBody());
    check('登记 10:00-12:00 窗口成功', r.status === 200 && r.json.id === 1 && r.json.active === true, r.json);
    const W1 = r.json.id;
    r = await api('POST', '/api/downtime-windows', winBody({ start_at: D + '11:00', end_at: D + '13:00' }));
    check('同设备重叠 -> 409', r.status === 409 &&
      (r.json.conflict_windows || []).some((w) => w.window_id === W1), r.json);
    r = await api('POST', '/api/downtime-windows', winBody({ start_at: D + '12:00', end_at: D + '13:00' }));
    check('同设备相邻（12:00 首尾相接）-> 成功', r.status === 200, r.json);
    const W2 = r.json.id;
    r = await api('POST', '/api/downtime-windows', winBody({
      equipment_id: L2, start_at: D + '11:00', end_at: D + '12:00'
    }));
    check('跨设备同一时段 -> 成功', r.status === 200, r.json);
    const WL2 = r.json.id;

    // ---------- 4. 窗口内事件新增/更正：PROCESS/CLEAN 与边界 ----------
    console.log('4) 窗口内单条事件新增/更正 -> 整次拒绝（左闭右开）');
    for (const t of ['10:00', '11:59', '11:00']) {
      r = await api('POST', '/api/events', {
        type: 'PROCESS', event_time: D + t, equipment_id: L1,
        batch_code: 'BX-' + t, material_ids: [MILK]
      });
      check(`${t}（窗口内/闭起点）加工 -> 409`, r.status === 409 &&
        r.json.code === 'DOWNTIME_WINDOW_CONFLICT' &&
        (r.json.conflict_windows || []).some((w) => w.window_id === W1), r.json);
    }
    r = await api('POST', '/api/events', { type: 'CLEAN', event_time: D + '11:30', equipment_id: L1 });
    check('11:30 清洗 -> 409', r.status === 409 && r.json.code === 'DOWNTIME_WINDOW_CONFLICT', r.json);
    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: D + '12:00', equipment_id: L1,
      batch_code: 'B2', material_ids: [SALT]
    });
    check('12:00（开终点，且是下一窗口闭起点）-> 409（属于 W2）', r.status === 409 &&
      (r.json.conflict_windows || []).some((w) => w.window_id === W2) &&
      !(r.json.conflict_windows || []).some((w) => w.window_id === W1), r.json);

    // 取消 W2 后，12:00 落在 W1 开终点上 -> 允许
    r = await api('POST', `/api/downtime-windows/${W2}/cancel`, { cancelled_by: '周工' });
    check('取消相邻窗口 W2', r.status === 200 && r.json.status === 'CANCELLED', r.json);
    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: D + '12:00', equipment_id: L1,
      batch_code: 'B2', material_ids: [SALT]
    });
    check('取消后 12:00（W1 开终点）加工 -> 成功', r.status === 200, r.json);
    const ev12 = r.json.id;

    // 命中的是已取消窗口的时间 -> 允许
    r = await api('POST', '/api/events', { type: 'CLEAN', event_time: D + '12:30', equipment_id: L1 });
    check('12:30（W2 已取消）清洗 -> 成功', r.status === 200, r.json);

    // 更正事件到窗口内 -> 拒绝且事件保持原样
    r = await api('PUT', `/api/events/${ev12}`, {
      type: 'PROCESS', event_time: D + '11:00', equipment_id: L1,
      batch_code: 'B2', material_ids: [SALT]
    });
    check('把 12:00 事件更正进窗口 -> 409', r.status === 409 &&
      r.json.code === 'DOWNTIME_WINDOW_CONFLICT', r.json);
    const stateAfterReject = (await api('GET', '/api/state')).json;
    const ev12row = stateAfterReject.events.find((e) => e.id === ev12);
    check('整次拒绝：事件时间仍为 12:00', ev12row.event_time === D + '12:00', ev12row);

    // 更正到另一设备的窗口内（按最终设备核对）
    r = await api('PUT', `/api/events/${ev12}`, {
      type: 'PROCESS', event_time: D + '11:30', equipment_id: L2,
      batch_code: 'B2', material_ids: [SALT]
    });
    check('更正到 L2 窗口时段 -> 409（按最终设备核对）', r.status === 409, r.json);

    // 重复取消 / 调整已取消窗口
    r = await api('POST', `/api/downtime-windows/${W2}/cancel`, {});
    check('重复取消 -> 409 WINDOW_NOT_ACTIVE', r.status === 409 && r.json.code === 'WINDOW_NOT_ACTIVE', r.json);
    r = await api('PUT', `/api/downtime-windows/${W2}`, winBody({ start_at: D + '13:00', end_at: D + '14:00' }));
    check('调整已取消窗口 -> 409', r.status === 409 && r.json.code === 'WINDOW_NOT_ACTIVE', r.json);

    // ---------- 5. 调整窗口：覆盖事件拒绝且原窗口不变；合法调整成功 ----------
    console.log('5) 调整窗口');
    r = await api('PUT', `/api/downtime-windows/${W1}`, winBody({ start_at: D + '08:30', end_at: D + '09:30' }));
    check('调整为覆盖 09:00 事件 -> 409', r.status === 409 &&
      (r.json.conflict_events || []).some((e) => e.event_id === ev09), r.json);
    r = await api('GET', `/api/downtime-windows/${W1}`);
    check('整次拒绝：窗口仍是 10:00-12:00', r.json.start_at === D + '10:00' && r.json.end_at === D + '12:00', r.json);

    r = await api('PUT', `/api/downtime-windows/${W1}`, winBody({
      start_at: D + '14:00', end_at: D + '15:00', reason: '改期检修', operator: '设备员-吴工'
    }));
    check('调整窗口到 14:00-15:00 -> 成功', r.status === 200 &&
      r.json.start_at === D + '14:00' && r.json.operator === '设备员-吴工', r.json);
    // 调整后原时段可记录事件
    r = await api('POST', '/api/events', { type: 'CLEAN', event_time: D + '11:00', equipment_id: L1 });
    check('调整后 11:00 清洗 -> 成功', r.status === 200, r.json);

    // 取消 W1 与 L2 窗口，为后续补录/换线测试清空停机约束
    r = await api('POST', `/api/downtime-windows/${W1}/cancel`, { cancelled_by: '吴工' });
    check('取消 W1', r.status === 200 && r.json.status === 'CANCELLED', r.json);

    // ---------- 6. 查询 / state / 预检查 ----------
    console.log('6) 查询窗口、/api/state 与预检查');
    r = await api('GET', '/api/downtime-windows?status=ACTIVE');
    check('按 ACTIVE 过滤只剩 L2 窗口', r.json.downtime_windows.length === 1 &&
      r.json.downtime_windows[0].id === WL2, r.json);
    r = await api('GET', `/api/downtime-windows?equipment_id=${L1}&with_events=1`);
    const l1wins = r.json.downtime_windows;
    const w2detail = l1wins.find((w) => w.id === W2);
    check('with_events=1 附区间冲突事件（W2 12:00-13:00 含 12:00 加工与 12:30 清洗）',
      w2detail && (w2detail.conflict_events || []).length === 2, w2detail);
    r = await api('GET', '/api/state');
    check('/api/state 顶层含全部窗口', Array.isArray(r.json.downtime_windows) &&
      r.json.downtime_windows.length === 3, r.json.downtime_windows);
    r = await api('POST', '/api/downtime-windows/check', {
      equipment_id: L1, start_at: D + '09:00', end_at: D + '09:31'
    });
    check('预检查返回将覆盖的事件', r.status === 200 && r.json.ok === false &&
      (r.json.conflict_events || []).length === 2, r.json);
    r = await api('POST', '/api/downtime-windows/check', {
      equipment_id: L1, start_at: D + '16:00', end_at: D + '17:00'
    });
    check('空闲区间预检查 ok=true', r.status === 200 && r.json.ok === true &&
      r.json.conflict_events.length === 0, r.json);

    // ---------- 7. 停机不等于清洗：残留照常穿过窗口 ----------
    console.log('7) 停机不等于清洗：窗口不截断设备残留');
    // 时间线：09:00 B1 投乳 -> 09:30 全清 -> 12:00 B2 盐 -> 12:30 全清 -> 11:00 全清（补记）
    // -> 13:00 B4 投乳（乳残留留在 L1）-> 登记 16:00-17:00 停机窗口 ->
    // 17:00（开终点）B5 只投食用盐。停机不等于清洗：B5 必须经设备残留含“乳”。
    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: D + '13:00', equipment_id: L1,
      batch_code: 'B4', material_ids: [MILK]
    });
    check('13:00 投乳加工 B4', r.status === 200, r.json);
    r = await api('POST', '/api/downtime-windows', winBody({
      start_at: D + '16:00', end_at: D + '17:00', reason: '验证窗口不清洗', operator: '周工'
    }));
    check('登记 16:00-17:00 窗口', r.status === 200, r.json);
    const W3 = r.json.id;
    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: D + '17:00', equipment_id: L1,
      batch_code: 'B5', material_ids: [SALT]
    });
    check('17:00（开终点）加工 B5 成功', r.status === 200, r.json);
    let st = (await api('GET', '/api/state')).json;
    const b5 = st.batches.find((b) => b.code === 'B5');
    check('B5 经设备残留含“乳”（停机窗口未截断残留）',
      b5.allergens.includes('乳'), b5 && b5.allergens);
    const l1res = st.equipment.find((q) => q.id === L1);
    check('L1 设备残留仍含乳', l1res.allergens.includes('乳'), l1res.allergens);
    check('最近清洗时间不受窗口影响（仍为最近一次已核实清洗 12:30）', l1res.last_cleaned_at === D + '12:30', l1res.last_cleaned_at);

    // ---------- 8. 断网整包补录命中窗口：整包回滚 ----------
    console.log('8) 断网补录按最终设备/时间核对窗口');
    const backfillPkg = (code, t) => ({
      backfill_code: code,
      records: [
        { external_ref: 'X-1', type: 'CLEAN', event_time: D + '15:30', equipment_id: L1, note: '断网清洗' },
        { external_ref: 'X-2', type: 'PROCESS', event_time: D + t, equipment_id: L1,
          batch_code: 'BF-' + code, material_inputs: [{ material_id: MILK }] }
      ]
    });
    r = await api('POST', '/api/backfills', backfillPkg('BF-A', '16:30'));
    check('补录包内 16:30 加工命中窗口 -> 409', r.status === 409 &&
      r.json.code === 'DOWNTIME_WINDOW_CONFLICT' &&
      (r.json.details || []).some((x) => x.includes('X-2')), r.json);
    st = (await api('GET', '/api/state')).json;
    check('整包回滚：无 BF-A 批次/事件',
      !st.batches.some((b) => b.code === 'BF-A') &&
      !st.events.some((e) => e.note === '断网清洗'), st.events.map((e) => e.note));
    const bfList = (await api('GET', '/api/backfills')).json;
    check('整包回滚：补录台账无 BF-A',
      !bfList.backfills.some((x) => x.backfill_code === 'BF-A'), bfList);

    // 取消窗口后补录成功；同号同内容重试返回原结果
    r = await api('POST', `/api/downtime-windows/${W3}/cancel`, { cancelled_by: '周工' });
    check('取消 W3', r.status === 200, r.json);
    r = await api('POST', '/api/backfills', backfillPkg('BF-A', '16:30'));
    check('取消窗口后补录成功', r.status === 200 && r.json.ok === true, r.json);
    const firstMapping = r.json.event_mapping;
    r = await api('POST', '/api/backfills', backfillPkg('BF-A', '16:30'));
    check('同号同内容重试幂等返回原结果', r.status === 200 && r.json.idempotent === true &&
      JSON.stringify(r.json.event_mapping) === JSON.stringify(firstMapping), r.json);

    // ---------- 9. 换线整组预演 / 确认 ----------
    console.log('9) 换线整组预演与确认按最终设备/时间核对窗口；窗口变动使旧预演过期');
    // 新窗口 18:00-19:00（不覆盖任何既有事件）；把 B5(17:00) 更正到 18:30 应在预演即拒绝。
    r = await api('POST', '/api/downtime-windows', winBody({
      start_at: D + '18:00', end_at: D + '19:00', reason: '晚间检修', operator: '周工'
    }));
    check('登记 18:00-19:00 窗口', r.status === 200, r.json);
    const W4 = r.json.id;
    const b5event = (await api('GET', '/api/state')).json.events.find((e) => e.batch_code === 'B5');
    const moveChange = (t) => ({
      op: 'update', event_id: b5event.id, type: 'PROCESS',
      event_time: D + t, equipment_id: L1, note: '移入窗口预演',
      batch_code: 'B5', material_ids: [SALT], ref_batch_ids: []
    });
    r = await api('POST', '/api/replan/preview', { changes: [moveChange('18:30')] });
    check('预演把事件移入窗口 -> 400 REPLAN_REJECTED（不写正式数据）',
      r.status === 400 && r.json.code === 'REPLAN_REJECTED' &&
      (r.json.details || []).some((x) => x.includes('停机窗口')), r.json);
    st = (await api('GET', '/api/state')).json;
    check('预演不写正式数据：B5 仍在 17:00',
      st.events.find((e) => e.id === b5event.id).event_time === D + '17:00', st);

    // 预演一个合法变更（B5 仍 17:00，只改备注）拿到版本
    const okChanges = [{
      op: 'update', event_id: b5event.id, type: 'PROCESS',
      event_time: D + '17:00', equipment_id: L1, note: '预演备注',
      batch_code: 'B5', material_ids: [SALT], ref_batch_ids: []
    }];
    r = await api('POST', '/api/replan/preview', { changes: okChanges });
    check('合法预演成功', r.status === 200 && r.json.phase === 'PREVIEW', r.json);
    const version = r.json.version;

    // 预演后窗口变动 -> 旧版本确认必须重新核对（VERSION_EXPIRED）
    r = await api('POST', `/api/downtime-windows/${W4}/cancel`, { cancelled_by: '周工' });
    check('预演后取消窗口', r.status === 200 && r.json.status === 'CANCELLED', r.json);
    r = await api('POST', '/api/replan/apply', { version, changes: okChanges });
    check('窗口变动后确认旧预演 -> 409 VERSION_EXPIRED 且无改动',
      r.status === 409 && r.json.code === 'VERSION_EXPIRED', r.json);
    st = (await api('GET', '/api/state')).json;
    check('确认被拒：事件备注未改变',
      st.events.find((e) => e.id === b5event.id).note !== '预演备注', st);

    // 重新登记窗口后：insert_clean 落入窗口 -> 预演拒绝
    r = await api('POST', '/api/downtime-windows', winBody({
      start_at: D + '18:00', end_at: D + '19:00', reason: '晚间检修（再次登记）', operator: '周工'
    }));
    check('再次登记窗口', r.status === 200, r.json);
    const W5 = r.json.id;
    r = await api('POST', '/api/replan/preview', {
      changes: [{ op: 'insert_clean', client_key: 'c1', event_time: D + '18:30',
        equipment_id: L1, note: '插一个清洗' }]
    });
    check('insert_clean 落入窗口 -> 预演 400', r.status === 400 &&
      r.json.code === 'REPLAN_REJECTED', r.json);

    // 重新预演合法变更并确认成功（窗口在 18-19，事件在 17:00 不命中）
    r = await api('POST', '/api/replan/preview', { changes: okChanges });
    check('重新预演成功', r.status === 200, r.json);
    r = await api('POST', '/api/replan/apply', { version: r.json.version, changes: okChanges });
    check('确认应用成功', r.status === 200 && r.json.phase === 'APPLIED', r.json);
    await api('POST', `/api/downtime-windows/${W5}/cancel`, { cancelled_by: '周工' });

    // ---------- 10. 有窗口台账的设备不可删除 ----------
    console.log('10) 设备删除约束');
    r = await api('DELETE', `/api/equipment/${L1}`);
    check('L1 下有事件本就不能删除', r.status === 400, r.json);
    const L3 = await newId('/api/equipment', { code: 'L3', name: '三号线' });
    r = await api('POST', '/api/downtime-windows', winBody({
      equipment_id: L3, start_at: D + '20:00', end_at: D + '21:00'
    }));
    check('L3 登记窗口（无事件）', r.status === 200, r.json);
    r = await api('DELETE', `/api/equipment/${L3}`);
    check('有窗口台账（即使无事件）-> 不可删除设备', r.status === 400, r.json);

    console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
  } finally {
    proc.kill();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
