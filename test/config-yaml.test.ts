import assert from "node:assert/strict";
import test from "node:test";
import { parseYamlDocument } from "../src/config/yaml.js";

// The configuration files are YAML 1.2 (ticket #72): comments and anchors are part of the
// format, while duplicate keys, extra documents, custom tags, merge keys and runaway alias
// expansion are refused with a reason and a position — never with the file's content.

const value = (text: string): unknown => {
  const parsed = parseYamlDocument(text);
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.message);
  return parsed.ok ? parsed.value : undefined;
};
const refusal = (text: string): string => {
  const parsed = parseYamlDocument(text);
  assert.equal(parsed.ok, false, `deveria recusar: ${JSON.stringify(text)}`);
  return parsed.ok ? "" : parsed.message;
};

test("comments, block maps, sequences and plain scalars become data", () => {
  const text = [
    "# configuração da instância",
    "name: pessoal   # comentário ao lado do valor",
    "projects:",
    "  - name: app",
    "    enabled: true",
    "  - name: outro",
    "    enabled: false",
  ].join("\n");
  assert.deepEqual(value(text), {
    name: "pessoal",
    projects: [{ name: "app", enabled: true }, { name: "outro", enabled: false }],
  });
});

test("YAML 1.2: yes, no, on and off are text, not booleans", () => {
  assert.deepEqual(value("a: yes\nb: no\nc: on\nd: off\ne: true\nf: false"), {
    a: "yes", b: "no", c: "on", d: "off", e: true, f: false,
  });
});

test("numbers, null and quoted text keep their types", () => {
  assert.deepEqual(value("a: 600\nb: 1.5\nc: ~\nd:\ne: \"600\"\nf: 'yes'"), {
    a: 600, b: 1.5, c: null, d: null, e: "600", f: "yes",
  });
});

test("an anchor and its alias inside the same document are accepted", () => {
  const text = [
    "defaults: &modelos",
    "  implementer: acme/um",
    "primeiro:",
    "  models: *modelos",
  ].join("\n");
  assert.deepEqual(value(text), {
    defaults: { implementer: "acme/um" },
    primeiro: { models: { implementer: "acme/um" } },
  });
});

test("an empty document is no configuration at all", () => {
  assert.equal(value(""), undefined);
  assert.equal(value("# só comentários\n"), undefined);
});

test("a duplicate key is refused and points at the repeated line", () => {
  const message = refusal("a: 1\nb: 2\na: 3\n");
  assert.match(message, /chave duplicada/);
  assert.match(message, /linha 3, coluna 1/);
});

test("more than one document is refused", () => {
  assert.match(refusal("a: 1\n---\nb: 2\n"), /mais de um documento/);
});

test("a custom tag is refused instead of silently read as text", () => {
  assert.match(refusal("a: !segredo valor\n"), /tag personalizada/);
});

test("a merge key is refused even though it is not expanded", () => {
  const text = "base: &b\n  x: 1\nprojeto:\n  <<: *b\n  y: 2\n";
  assert.match(refusal(text), /merge key/);
});

test("a YAML 1.1 declaration is refused: this parser reads 1.2", () => {
  assert.match(refusal("%YAML 1.1\n---\na: 1\n"), /versão YAML 1\.1/);
});

test("a tab as indentation is refused with its position", () => {
  const message = refusal("a:\n\t- 1\n");
  assert.match(message, /tabulador/);
  assert.match(message, /linha 2, coluna 1/);
});

test("an alias without a previous anchor is refused", () => {
  assert.match(refusal("a: *nada\n"), /alias sem âncora anterior/);
});

test("an anchor that references its own node is refused", () => {
  assert.match(refusal("a: &x\n  b: *x\n"), /ciclo/);
});

test("more aliases than the limit is refused", () => {
  const lines = ["base: &b { x: 1 }"];
  for (let index = 0; index <= 100; index += 1) lines.push(`c${index}: *b`);
  assert.match(refusal(`${lines.join("\n")}\n`), /mais de 100 aliases/);
});

test("a message never carries the file's content or values", () => {
  const secret = "SEGREDO-NAO-VAZAR";
  for (const text of [
    `a: ${secret}\na: 2\n`,
    `a: !tag ${secret}\n`,
    `a: ${secret}\n  b: 2\n`,
  ]) {
    const message = refusal(text);
    assert.doesNotMatch(message, new RegExp(secret), `mensagem vazou o valor: ${message}`);
  }
});
