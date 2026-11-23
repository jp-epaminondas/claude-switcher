'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const pkg = require('../package.json');
const { SECTION, GROUPS, fmtMinutes, schemaOf, settingOf, parseNumber, projectValue } = require('../src/core/settings');
const { PERMISSIONS } = require('../src/core/access');

const keys = Object.keys(pkg.contributes.configuration.properties).map((k) => k.slice(SECTION.length + 1));
const commands = new Set(pkg.contributes.commands.map((c) => c.command));

test('a página Configurações mostra cada configuração do package.json uma vez', () => {
  const shown = GROUPS.flatMap((g) => g.items.map((s) => s.key));
  assert.deepEqual([...shown].sort(), [...keys].sort());
  assert.equal(new Set(shown).size, shown.length);
});

test('cada configuração sabe como se mostra e se muda', () => {
  for (const g of GROUPS) {
    assert.ok(g.permission === null || Object.hasOwn(PERMISSIONS, g.permission), g.id);
    for (const s of g.items) {
      const { type, minimum, maximum } = schemaOf(s.key);
      for (const c of [s.toggle, s.pick].filter(Boolean)) assert.ok(commands.has(c), `${s.key}: ${c}`);
      if (type === 'boolean') {
        assert.ok(!s.fmt && !s.choices && !s.pick, s.key);
        continue;
      }
      assert.equal(typeof s.fmt, 'function', s.key);
      if (s.pick) continue;
      assert.equal(type, 'number', s.key);
      for (const c of s.choices) assert.equal(parseNumber(s.key, String(c)), c, `${s.key}: ${c} fora de ${minimum}..${maximum}`);
    }
  }
  assert.equal(settingOf('credentials.lockMinutes').pick, 'claudeSwitcher.cred.lockTime');
  assert.equal(settingOf('naoExiste'), undefined);
});

test('número digitado: inteiro dentro dos limites do package.json', () => {
  assert.equal(parseNumber('switchAtPercent', ' 95 '), 95);
  assert.equal(parseNumber('switchAtPercent', '49'), null);
  assert.equal(parseNumber('switchAtPercent', '101'), null);
  assert.equal(parseNumber('pollIntervalMinutes', '0'), null);
  assert.equal(parseNumber('pollIntervalMinutes', '2.5'), null);
  assert.equal(parseNumber('pollIntervalMinutes', 'abc'), null);
  assert.equal(parseNumber('topicGuardMinContextK', '19'), null);
  assert.equal(parseNumber('topicGuardMinContextK', '500'), 500);
});

test('valor próprio do projeto e minutos por extenso', () => {
  assert.equal(projectValue({ globalValue: 60 }), undefined);
  assert.equal(projectValue({ globalValue: 60, workspaceValue: 30 }), 30);
  assert.equal(projectValue({ workspaceValue: 30, workspaceFolderValue: false }), false);
  assert.equal(projectValue(undefined), undefined);
  assert.equal(fmtMinutes(45), '45 min');
  assert.equal(fmtMinutes(60), '1 h');
  assert.equal(fmtMinutes(90), '1 h 30 min');
});
