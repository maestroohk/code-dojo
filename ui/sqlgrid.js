// A result grid for SQL: columns (with their types when known), rows, NULL shown as NULL,
// numbers right-aligned. Used by SQL lesson steps and the Database studio.
import { h } from './util.js';

const NUM = /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i;

/**
 * @param table  { columns: [...], rows: [[...]], types?: [...], truncated?: bool }
 * @param cap    most rows to draw
 */
export function sqlGrid(table, { cap = 200, caption = true } = {}) {
  const cols = table.columns || [];
  const rows = (table.rows || []).slice(0, cap);
  const types = table.types || [];
  const numeric = cols.map((_, i) => rows.length > 0 && rows.every(r => r[i] == null || NUM.test(r[i])));
  const grid = h('table.sql-grid',
    h('thead', h('tr', h('th.sql-rownum', '#'), cols.map((c, i) => h('th', { className: numeric[i] ? 'num' : '' },
      h('span.sql-col', c), types[i] && h('span.sql-type', types[i].toLowerCase()))))),
    h('tbody', rows.map((r, n) => h('tr', h('td.sql-rownum', n + 1),
      r.map((v, i) => v == null ? h('td.null', 'NULL') : h('td', { className: numeric[i] ? 'num' : '', title: v.length > 60 ? v : null }, v))))));
  const total = (table.rows || []).length;
  return h('div.sql-result',
    h('div.sql-grid-wrap', cols.length ? grid : h('div.muted.small', 'No columns.')),
    caption && h('div.sql-caption.muted.small',
      `${total} row${total === 1 ? '' : 's'}`,
      table.truncated ? ' (more rows were left out)' : '',
      total > cap ? `, showing the first ${cap}` : ''));
}

/** Rows to CSV text (RFC 4180 quoting). */
export function toCsv(table) {
  const q = v => v == null ? '' : /[",\n\r]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  return [table.columns.map(q).join(','), ...table.rows.map(r => r.map(q).join(','))].join('\r\n') + '\r\n';
}
