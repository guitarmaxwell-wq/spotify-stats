// A tiny in-memory stand-in for the parts of supabase-js the rule engine uses,
// so the load -> decide -> write path can be tested without a database.
//
// Deliberately NARROW: it implements select / in / eq / gte / gt / order /
// range / limit / maybeSingle, embedded many-to-one selects like
// `artists!inner(mbid)`, and upsert with ignoreDuplicates. There is no update
// or delete at all, so any attempt by the engine to revoke or modify a grant
// fails loudly in tests. `maxRows` emulates PostgREST's max_rows page cap.

// deno-lint-ignore-file no-explicit-any
type Row = Record<string, any>;

export class FakeDb {
  tables: Record<string, Row[]> = {};
  /** Every mutating call, for asserting that something never writes. */
  writes: { table: string; rows: Row[] }[] = [];
  requests = 0;
  constructor(public maxRows = 1000) {}

  from(table: string): FakeQuery {
    this.tables[table] ??= [];
    return new FakeQuery(this, table);
  }
}

interface Col { alias: string; path: string; embed?: { table: string; inner: boolean; cols: Col[] } }

function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function parseCols(s: string): Col[] {
  return splitTop(s).map((c) => {
    const m = /^(\w+)(!inner)?\((.*)\)$/.exec(c);
    if (m) return { alias: m[1], path: m[1], embed: { table: m[1], inner: !!m[2], cols: parseCols(m[3]) } };
    const [a, p] = c.includes(":") ? c.split(":") : [c, c];
    return { alias: a.trim(), path: p.trim() };
  });
}

function get(row: Row, path: string): any {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), row);
}

export class FakeQuery implements PromiseLike<{ data: any; error: any }> {
  private cols: Col[] = [];
  private filters: { path: string; test: (v: any) => boolean }[] = [];
  private orders: string[] = [];
  private from_ = 0;
  private to_ = Infinity;
  private single = false;
  private upsertRows: Row[] | null = null;
  private conflict: string[] = [];
  private returning: Col[] | null = null;

  constructor(private db: FakeDb, private table: string) {}

  select(cols = "*") {
    if (this.upsertRows) this.returning = parseCols(cols);
    else this.cols = parseCols(cols);
    return this;
  }
  in(path: string, vals: any[]) {
    this.filters.push({ path, test: (v) => vals.includes(v) });
    return this;
  }
  eq(path: string, val: any) {
    this.filters.push({ path, test: (v) => v === val });
    return this;
  }
  gte(path: string, val: any) {
    this.filters.push({ path, test: (v) => v >= val });
    return this;
  }
  gt(path: string, val: any) {
    this.filters.push({ path, test: (v) => v > val });
    return this;
  }
  order(col: string) {
    this.orders.push(col);
    return this;
  }
  range(from: number, to: number) {
    this.from_ = from;
    this.to_ = to;
    return this;
  }
  limit(n: number) {
    this.to_ = this.from_ + n - 1;
    return this;
  }
  maybeSingle() {
    this.single = true;
    return this;
  }
  upsert(rows: Row | Row[], opts: { onConflict: string; ignoreDuplicates?: boolean }) {
    if (!opts.ignoreDuplicates) throw new Error("fake: only ignoreDuplicates upserts are supported (grants must never update)");
    this.upsertRows = Array.isArray(rows) ? rows : [rows];
    this.conflict = opts.onConflict.split(",").map((s) => s.trim());
    return this;
  }

  private embed(row: Row, cols: Col[]): Row | null {
    const full: Row = { ...row };
    for (const c of cols) {
      if (!c.embed) continue;
      const fk = row[c.embed.table.replace(/s$/, "") + "_id"];
      const rel = this.db.tables[c.embed.table]?.find((r) => r.id === fk) ?? null;
      full[c.alias] = rel;
    }
    return full;
  }

  private project(row: Row, cols: Col[]): Row {
    if (cols.length === 1 && cols[0].path === "*") return { ...row };
    const out: Row = {};
    for (const c of cols) {
      if (c.embed) out[c.alias] = row[c.alias] == null ? null : this.project(row[c.alias], c.embed.cols);
      else out[c.alias] = row[c.path];
    }
    return out;
  }

  private run(): { data: any; error: any } {
    this.db.requests++;
    const t = this.db.tables[this.table];
    if (this.upsertRows) {
      const inserted: Row[] = [];
      for (const r of this.upsertRows) {
        const clash = t.some((x) => this.conflict.every((k) => x[k] === r[k]));
        if (clash) continue;
        const row = { granted_at: new Date().toISOString(), ...structuredClone(r) };
        t.push(row);
        inserted.push(row);
      }
      this.db.writes.push({ table: this.table, rows: inserted });
      return { data: this.returning ? inserted.map((r) => this.project(r, this.returning!)) : null, error: null };
    }
    let rows = t.map((r) => this.embed(r, this.cols)!);
    for (const f of this.filters) {
      const embedded = f.path.includes(".");
      rows = rows.filter((r) => {
        if (embedded) {
          const [rel] = f.path.split(".");
          if (r[rel] == null) return false;
        }
        return f.test(get(r, f.path));
      });
    }
    for (const c of this.cols) if (c.embed?.inner) rows = rows.filter((r) => r[c.alias] != null);
    if (this.orders.length) {
      rows.sort((a, b) => {
        for (const o of this.orders) {
          if (a[o] < b[o]) return -1;
          if (a[o] > b[o]) return 1;
        }
        return 0;
      });
    }
    const end = Math.min(this.to_ + 1, this.from_ + this.db.maxRows);
    rows = rows.slice(this.from_, end);
    const data = rows.map((r) => this.project(r, this.cols.length ? this.cols : [{ alias: "*", path: "*" }]));
    if (this.single) return { data: data[0] ?? null, error: null };
    return { data, error: null };
  }

  then<A, B>(ok?: ((v: { data: any; error: any }) => A | PromiseLike<A>) | null, err?: ((e: any) => B | PromiseLike<B>) | null) {
    return Promise.resolve().then(() => this.run()).then(ok, err);
  }
}
