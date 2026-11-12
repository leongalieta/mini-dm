import { test } from "node:test";
import assert from "node:assert";
import { addSchedule, getDueSchedules, updateScheduleStatus, removeSchedule, filterLogs, exportLogs, exportStats } from "../lib/store.js";

const baseStore = {
  settings: { dryRun: true },
  rules: [],
  seen: {},
  log: [],
  schedules: []
};

test("addSchedule adiciona agendamento com status pending", () => {
  const store = { ...baseStore, schedules: [] };
  const sched = addSchedule(store, {
    username: "cliente",
    comment: "Oi",
    channel: "dm",
    runAt: "2026-12-01T10:00:00Z"
  });
  assert.strictEqual(sched.status, "pending");
  assert.strictEqual(sched.username, "cliente");
  assert.strictEqual(store.schedules.length, 1);
});

test("getDueSchedules retorna apenas agendamentos vencidos e pendentes", () => {
  const store = { ...baseStore, schedules: [] };
  addSchedule(store, { username: "a", comment: "vencedo", channel: "dm", runAt: "2020-01-01T00:00:00Z" });
  addSchedule(store, { username: "b", comment: "futuro", channel: "dm", runAt: "2099-01-01T00:00:00Z" });
  addSchedule(store, { username: "c", comment: "cancelado", channel: "dm", runAt: "2020-01-01T00:00:00Z" });
  updateScheduleStatus(store, store.schedules[2].id, "cancelled");

  const due = getDueSchedules(store);
  assert.strictEqual(due.length, 1);
  assert.strictEqual(due[0].username, "a");
});

test("updateScheduleStatus muda o status", () => {
  const store = { ...baseStore, schedules: [] };
  const sched = addSchedule(store, { username: "a", comment: "x", channel: "dm", runAt: "2026-01-01T00:00:00Z" });
  const updated = updateScheduleStatus(store, sched.id, "sent", "enviado com sucesso");
  assert.strictEqual(updated.status, "sent");
  assert.strictEqual(updated.detail, "enviado com sucesso");
});

test("removeSchedule remove o agendamento", () => {
  const store = { ...baseStore, schedules: [] };
  const sched = addSchedule(store, { username: "a", comment: "x", channel: "dm", runAt: "2026-01-01T00:00:00Z" });
  assert.strictEqual(store.schedules.length, 1);
  assert.strictEqual(removeSchedule(store, sched.id), true);
  assert.strictEqual(store.schedules.length, 0);
  assert.strictEqual(removeSchedule(store, "inexistente"), false);
});

test("filterLogs filtra por query e status", () => {
  const store = {
    ...baseStore,
    log: [
      { at: "2026-01-01T00:00:00Z", mode: "teste", username: "mara", comment: "preço", keyword: "preço", ruleName: "r1", status: "enviado", detail: "ok" },
      { at: "2026-01-02T00:00:00Z", mode: "teste", username: "joao", comment: "oi", keyword: "oi", ruleName: "r2", status: "erro", detail: "falha" }
    ]
  };

  const r1 = filterLogs(store, { query: "mara" });
  assert.strictEqual(r1.items.length, 1);

  const r2 = filterLogs(store, { status: "erro" });
  assert.strictEqual(r2.items.length, 1);
  assert.strictEqual(r2.items[0].username, "joao");

  const r3 = filterLogs(store, { page: 1, pageSize: 1 });
  assert.strictEqual(r3.items.length, 1);
  assert.strictEqual(r3.total, 2);
  assert.strictEqual(r3.totalPages, 2);
});

test("exportLogs gera CSV com cabeçalho", () => {
  const store = {
    ...baseStore,
    log: [
      { at: "2026-01-01T00:00:00Z", mode: "teste", username: "mara", comment: "oi", keyword: "oi", ruleName: "r1", status: "enviado", detail: "ok" }
    ]
  };
  const csv = exportLogs(store);
  assert.ok(csv.includes("at,mode,username,comment,keyword,rule,status,detail"));
  assert.ok(csv.includes("mara"));
  assert.ok(csv.includes("enviado"));
});

test("exportStats aceita data como Date (Postgres) e como string", () => {
  const store = {
    ...baseStore,
    log: [
      { at: new Date("2026-11-12T15:00:00Z"), status: "enviado", ruleName: "r1" },
      { at: "2026-11-12T16:00:00Z", status: "simulado", ruleName: "r1" }
    ]
  };
  const csv = exportStats(store);
  assert.ok(csv.includes("2026-11-12,2"));
});
