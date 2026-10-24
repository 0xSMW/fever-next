/**
 * PHP 8 stable Zend sort, adapted to array indexes from PHP-8.5 Zend/zend_sort.c.
 * https://github.com/php/php-src/blob/PHP-8.5/Zend/zend_sort.c
 * Copyright Zend Technologies Ltd.; see php-sort-LICENSE.txt (Zend License 2.00).
 * The partition algorithm also carries the MIT/libc++ notice in that file.
 * Comparison order matters: PHP SORT_REGULAR with mixed numeric/string keys
 * is not transitive, so JavaScript Array.sort can produce a different order.
 */
export function phpStableSort<T>(input: readonly T[], compare: (left: T, right: T) => number): T[] {
  const rows = input.map((value, index) => ({ value, index }));
  const cmp = (a: number, b: number) => compare(rows[a].value, rows[b].value) || rows[a].index - rows[b].index;
  const swap = (a: number, b: number) => { [rows[a], rows[b]] = [rows[b], rows[a]]; };
  const sort2 = (a: number, b: number) => { if (cmp(a, b) > 0) swap(a, b); };
  const sort3 = (a: number, b: number, c: number) => {
    if (!(cmp(a, b) > 0)) {
      if (!(cmp(b, c) > 0)) return;
      swap(b, c);
      if (cmp(a, b) > 0) swap(a, b);
      return;
    }
    if (!(cmp(c, b) > 0)) { swap(a, c); return; }
    swap(a, b);
    if (cmp(b, c) > 0) swap(b, c);
  };
  const sort4 = (a: number, b: number, c: number, d: number) => {
    sort3(a, b, c);
    if (cmp(c, d) > 0) { swap(c, d); if (cmp(b, c) > 0) { swap(b, c); sort2(a, b); } }
  };
  const sort5 = (a: number, b: number, c: number, d: number, e: number) => {
    sort4(a, b, c, d);
    if (cmp(d, e) > 0) { swap(d, e); if (cmp(c, d) > 0) { swap(c, d); if (cmp(b, c) > 0) { swap(b, c); sort2(a, b); } } }
  };
  const insertSort = (start: number, count: number) => {
    if (count < 2) return;
    if (count === 2) return sort2(start, start + 1);
    if (count === 3) return sort3(start, start + 1, start + 2);
    if (count === 4) return sort4(start, start + 1, start + 2, start + 3);
    if (count === 5) return sort5(start, start + 1, start + 2, start + 3, start + 4);
    const sentry = start + 6, end = start + count;
    for (let i = start + 1; i < sentry; i++) {
      let j = i - 1;
      if (!(cmp(j, i) > 0)) continue;
      while (j !== start) { j--; if (!(cmp(j, i) > 0)) { j++; break; } }
      for (let k = i; k > j; k--) swap(k, k - 1);
    }
    for (let i = sentry; i < end; i++) {
      let j = i - 1;
      if (!(cmp(j, i) > 0)) continue;
      while (true) {
        j -= 2;
        if (!(cmp(j, i) > 0)) { j++; if (!(cmp(j, i) > 0)) j++; break; }
        if (j === start) break;
        if (j === start + 1) { j--; if (cmp(i, j) > 0) j++; break; }
      }
      for (let k = i; k > j; k--) swap(k, k - 1);
    }
  };
  const sort = (initialStart: number, initialCount: number) => {
    let start = initialStart, count = initialCount;
    while (true) {
      if (count <= 16) { insertSort(start, count); return; }
      const end = start + count, offset = count >> 1;
      let pivot = start + offset;
      if (count >> 10) {
        const delta = offset >> 1;
        sort5(start, start + delta, pivot, pivot + delta, end - 1);
      } else sort3(start, pivot, end - 1);
      swap(start + 1, pivot);
      pivot = start + 1;
      let i = pivot + 1, j = end - 1;
      partition: while (true) {
        while (cmp(pivot, i) > 0) { i++; if (i === j) break partition; }
        j--;
        if (j === i) break;
        while (cmp(j, pivot) > 0) { j--; if (j === i) break partition; }
        swap(i, j);
        i++;
        if (i === j) break;
      }
      swap(pivot, i - 1);
      if (i - 1 - start < end - i) {
        sort(start, i - start - 1);
        start = i; count = end - i;
      } else {
        sort(i, end - i);
        count = i - start - 1;
      }
    }
  };
  sort(0, rows.length);
  return rows.map(row => row.value);
}
