import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';

const WEB = fileURLToPath(new URL('../../web/src', import.meta.url));

function files(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.tsx?$/.test(f)) out.push(p);
  }
  return out;
}

/** Every text the interface passes to tr() or plural(), with where it is. */
function interfaceTexts(): Map<string, string> {
  const keys = new Map<string, string>();
  for (const file of files(WEB)) {
    if (file.includes('locales')) continue;
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const take = (e: ts.Expression | undefined): void => {
      if (!e) return;
      if (ts.isConditionalExpression(e)) return take(e.whenTrue), take(e.whenFalse);
      if (ts.isParenthesizedExpression(e)) return take(e.expression);
      if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) keys.set(e.text, relative(WEB, file));
    };
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const name = node.expression.getText(sf);
        if (name === 'tr') take(node.arguments[0]);
        if (name === 'plural') take(node.arguments[1]), take(node.arguments[2]);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return keys;
}

/** The Hebrew dictionary, read from its source. */
function hebrew(): Map<string, string> {
  const file = join(WEB, 'locales', 'he.ts');
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const out = new Map<string, string>();
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && (ts.isStringLiteral(node.name) || ts.isIdentifier(node.name)) && ts.isStringLiteral(node.initializer)) out.set(node.name.text, node.initializer.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const placeholders = (s: string) => new Set(s.match(/\{\d+\}/g) ?? []);

test('i18n: every interface text has a Hebrew translation, with only its own placeholders', () => {
  const keys = interfaceTexts();
  const he = hebrew();
  assert.ok(keys.size > 1000, 'the interface texts are found');
  const missing = [...keys].filter(([k]) => !he.has(k)).map(([k, f]) => `${f}: ${JSON.stringify(k)}`);
  assert.deepEqual(missing, [], 'texts without a Hebrew translation');
  const wrong = [...he].filter(([k, v]) => keys.has(k) && [...placeholders(v)].some((p) => !placeholders(k).has(p))).map(([k]) => k);
  assert.deepEqual(wrong, [], 'translations with placeholders their English text lacks');
  // A translation that kept the English by mistake (brand names and codes aside) would show up here.
  const untranslated = [...he].filter(([k, v]) => k === v && /[a-z]{4,} [a-z]{4,}/i.test(k));
  assert.deepEqual(untranslated, []);
});
