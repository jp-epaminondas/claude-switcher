'use strict';

// Turns a free-form credentials note (like Rota7's .specs/server.md: a title line, then one
// value per line) into vault entries. Each value gets a name from what it looks like; the
// page lets the user fix any name afterwards.

const WORDS = (s) => s.trim().split(/\s+/).filter(Boolean);
const letters = (s) => s.replace(/[^A-Za-zÀ-ÿ]/g, '');

// "SERVER SSH", "PHPMYADMINok", "SYNCTHING - LOGIN (ajustar-syncthing.bat)" (a remark in
// parentheses doesn't count); or, first in its block, a few plain words like "api claude".
function isTitle(line, firstInBlock) {
  const head = line.replace(/\([^)]*\)/g, '').trim();
  if (!head || /[@\\/#$%&*=]/.test(head)) return false;
  const ls = letters(head);
  if (ls.length >= 5 && /^[A-Za-zÀ-ÿ]/.test(head)) {
    const upper = ls.replace(/[^A-ZÀ-Þ]/g, '').length / ls.length;
    if (upper >= 0.7 && (/\s/.test(head) || !/\d/.test(head))) return true;
  }
  return firstInBlock && /^[A-Za-zÀ-ÿ]+(?: [A-Za-zÀ-ÿ]+){1,3}$/.test(line);
}

// What a value line probably is: [name, secret].
function kindOf(line, entry) {
  if (/^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?$/.test(line)) return ['Host', false];
  if (/^(?:\/|[A-Za-z]:\\)/.test(line)) return ['Caminho', false];
  if (/^https?:\/\//.test(line)) return ['Endereço', false];
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(line)) return ['Login', false];
  if (/^(?:sk-|cfk_|ghp_|gho_|xox[bp]-|AKIA)/.test(line) || (line.length >= 24 && /^[A-Za-z0-9_\-.:]+$/.test(line))) return ['Chave', true];
  const hasUser = entry.fields.some((f) => f.name.startsWith('Usuário') || f.name.startsWith('Login'));
  if (!hasUser && /^[a-z][a-z0-9_.-]{1,31}$/.test(line)) return ['Usuário', false];
  return ['Senha', true];
}

function parseServerMd(text) {
  const entries = [];
  let entry = null;
  const start = (title) => entries.push((entry = { title, fields: [] }));
  const add = (name, value, secret) => {
    if (!entry) start('Sem nome');
    const same = entry.fields.filter((f) => f.name === name || f.name.startsWith(`${name} `)).length;
    entry.fields.push({ name: same ? `${name} ${same + 1}` : name, value, secret });
  };
  let firstInBlock = true;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      firstInBlock = true;
      continue;
    }
    if (isTitle(line, firstInBlock)) {
      start(line);
    } else if (WORDS(line).length >= 8) {
      // A sentence: a note of its own.
      start('Anotações');
      add('Nota', line, false);
    } else {
      const kv = /^([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ ]{0,29}):\s+(\S.*)$/.exec(line);
      if (kv) {
        add(kv[1].trim(), kv[2].trim(), true);
      } else {
        const [name, secret] = kindOf(line, entry || { fields: [] });
        add(name, line, secret);
      }
    }
    firstInBlock = false;
  }
  return entries.filter((e) => e.fields.length);
}

module.exports = { parseServerMd, isTitle };
