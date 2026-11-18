import { test } from "node:test";
import assert from "node:assert";
import { normalize, matchRule, render } from "../lib/engine.js";

test("normalize remove acentos e caracteres especiais", () => {
  assert.strictEqual(normalize("Preço!"), "preco");
  assert.strictEqual(normalize("  Espaços  "), "espacos");
  assert.strictEqual(normalize("QUALQUER COISA"), "qualquer coisa");
});

test("matchRule encontra palavra-chave", () => {
  const rules = [
    { id: "r1", name: "Preço", channel: "comment", keywords: ["preço", "valor"], active: true }
  ];
  const found = matchRule("Qual o preço?", rules, "comment");
  assert.ok(found);
  assert.strictEqual(found.keyword, "preço");
});

test("matchRule não encontra palavra inativa", () => {
  const rules = [
    { id: "r1", name: "Preço", channel: "comment", keywords: ["preço"], active: false }
  ];
  assert.strictEqual(matchRule("preço", rules, "comment"), null);
});

test("matchRule respeita canal", () => {
  const rules = [
    { id: "r1", name: "DM", channel: "dm", keywords: ["oi"], active: true }
  ];
  assert.strictEqual(matchRule("oi", rules, "comment"), null);
  const found = matchRule("oi", rules, "dm");
  assert.ok(found);
});

test("render substitui variáveis", () => {
  assert.strictEqual(render("Oi {{nome}}!", { nome: "João" }), "Oi João!");
  assert.strictEqual(render("Oi {{nome}}!", {}), "Oi !");
});

test("normalize trata string vazia", () => {
  assert.strictEqual(normalize(""), "");
  assert.strictEqual(normalize(null), "");
});

test("regra do post tem prioridade e só responde na própria publicação", () => {
  const general = { id: "geral", active: true, keywords: ["agenda"] };
  const scoped = { id: "post", postId: "123", active: true, keywords: ["agenda"] };
  const rules = [general, scoped];
  assert.equal(matchRule("agenda", rules, "comment", "123").rule, scoped);
  assert.equal(matchRule("agenda", rules, "comment", "456").rule, general);
  assert.equal(matchRule("agenda", rules, "comment", "456", false), null);
  assert.equal(matchRule("agenda", [scoped], "dm", "123"), null);
});
