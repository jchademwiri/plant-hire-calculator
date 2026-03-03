# Plant Hire Calculator — Data Architecture
Stack: Next.js 15 App Router · Supabase · Drizzle ORM · TypeScript
Mode: Solo / Personal Tool · Per-machine per-month invoicing

---

## What "Solo Tool" Changes

No multi-tenancy. No team roles. No organisation tables.
One Supabase Auth user = the entire app. RLS policies are simple (auth.uid() = user_id).
The schema is lean — you are not building for thousands of users, you're building
a personal financial tool that happens to be on the web.

This also means you can move faster: no invite flows, no permission checks, no
org-level billing. Just auth → data → analytics.

---

## Core Design Decision: Snapshot + Inputs

Store BOTH the raw inputs and the computed snapshot:

  Raw inputs    (equipment[], idleDays[], rates)  →  re-editable, source of truth
  Computed rows (line items pre-calculated)        →  analytics, fast reads, audit record

The computed snapshot is written ONCE at save time and never recalculated.
If business rules change later, historical invoices are unaffected.
If the user needs to amend an invoice, they load the raw inputs, make changes,
and save a new snapshot — the old one becomes 'superseded'.

---

## Entity Relationship

```
user (Supabase Auth)
  └── clients           one user → many clients (City of Tshwane, etc.)
  └── projects          one client → many projects (R21 Phase 2, Sewer Upgrade)
  └── equipment         reusable machine registry (Dropside 8T, TLB, etc.)
  └── invoices          one invoice = one billing month
        ├── invoice_line_items   one row per machine × tier × day type
        └── invoice_inputs       raw JSON snapshot for re-editing
```

Note on clients/projects: even though invoices are scoped per-machine per-month,
you still want to GROUP them for analytics ("show me all revenue from Tshwane in 2025").
Clients and projects are lightweight tags, not complex entities.

---

## Drizzle Schema

File: src/db/schema.ts

```typescript
import {
  pgTable, uuid, text, numeric, integer, boolean,
  timestamp, jsonb, index, uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

// ─── CLIENTS ──────────────────────────────────────────────────────────────────
// Lightweight — just a name to group invoices for analytics.
// "City of Tshwane", "Murray & Roberts", etc.
export const clients = pgTable('clients', {
  id:        uuid('id').primaryKey().defaultRandom(),
  userId:    uuid('user_id').notNull(),             // Supabase auth.uid()
  name:      text('name').notNull(),
  contact:   text('contact'),
  email:     text('email'),
  phone:     text('phone'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  userIdx: index('clients_user_idx').on(t.userId),
}));

// ─── PROJECTS ─────────────────────────────────────────────────────────────────
// Optional grouping under a client: "R21 Road Upgrade Phase 2"
// An invoice can exist without a project (ad-hoc billing)
export const projects = pgTable('projects', {
  id:          uuid('id').primaryKey().defaultRandom(),
  userId:      uuid('user_id').notNull(),
  clientId:    uuid('client_id').references(() => clients.id, { onDelete: 'set null' }),
  name:        text('name').notNull(),
  description: text('description'),
  isActive:    boolean('is_active').default(true).notNull(),
  createdAt:   timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  userIdx:   index('projects_user_idx').on(t.userId),
  clientIdx: index('projects_client_idx').on(t.clientId),
}));

// ─── EQUIPMENT REGISTRY ───────────────────────────────────────────────────────
// Define your machines once. Reuse across months. Default rate pre-fills
// the calculator so you do not re-enter the same base rate every month.
export const equipment = pgTable('equipment', {
  id:          uuid('id').primaryKey().defaultRandom(),
  userId:      uuid('user_id').notNull(),
  name:        text('name').notNull(),               // "Dropside 8T"
  description: text('description'),
  defaultRate: numeric('default_rate', { precision: 12, scale: 2 }),
  isActive:    boolean('is_active').default(true).notNull(),
  createdAt:   timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  userIdx: index('equipment_user_idx').on(t.userId),
}));

// ─── INVOICES ─────────────────────────────────────────────────────────────────
// One invoice = one billing month. Can be tagged to a client and/or project.
// Per-machine billing means a single invoice can contain multiple machines.
export const invoices = pgTable('invoices', {
  id:        uuid('id').primaryKey().defaultRandom(),
  userId:    uuid('user_id').notNull(),
  clientId:  uuid('client_id').references(() => clients.id,  { onDelete: 'set null' }),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),

  // Billing period
  billingYear:  integer('billing_year').notNull(),    // 2025
  billingMonth: integer('billing_month').notNull(),   // 1–12

  // Workflow status
  status: text('status', {
    enum: ['draft', 'finalised', 'sent', 'paid'],
  }).default('draft').notNull(),

  // Denormalised totals — written once, never recalculated
  totalExVat:  numeric('total_ex_vat',  { precision: 12, scale: 2 }).notNull(),
  vatAmount:   numeric('vat_amount',    { precision: 12, scale: 2 }).default('0').notNull(),
  totalIncVat: numeric('total_inc_vat', { precision: 12, scale: 2 }).notNull(),

  // Supabase Storage path once PDF is generated and saved
  pdfStoragePath: text('pdf_storage_path'),

  notes:     text('notes'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  userIdx:    index('invoices_user_idx').on(t.userId),
  clientIdx:  index('invoices_client_idx').on(t.clientId),
  projectIdx: index('invoices_project_idx').on(t.projectId),
  periodIdx:  index('invoices_period_idx').on(t.billingYear, t.billingMonth),
  // Prevent two invoices for the same project+month (still allow ad-hoc duplicates)
  uniquePeriod: uniqueIndex('invoices_project_period_unique')
    .on(t.projectId, t.billingYear, t.billingMonth)
    .where(sql`project_id IS NOT NULL`),
}));

// ─── INVOICE LINE ITEMS ───────────────────────────────────────────────────────
// The analytics source. One row per: machine × discount tier × day type.
// Written at save time from your existing calculation functions.
// Never modified after creation — amending creates a new invoice.
//
// Example rows for one machine in one month:
//   Dropside 8T | WEEKDAYS           | Standard (0%)  | 12 days | R520 | ...
//   Dropside 8T | WEEKDAYS           | Silver (5%)    |  8 days | R520 | ...
//   Dropside 8T | SATURDAYS          | Standard (0%)  |  4 days | R780 | ...
//   Dropside 8T | SUNDAYS_HOLIDAYS   | Standard (0%)  |  1 day  | R780 | ...
export const invoiceLineItems = pgTable('invoice_line_items', {
  id:          uuid('id').primaryKey().defaultRandom(),
  invoiceId:   uuid('invoice_id').notNull().references(() => invoices.id, { onDelete: 'cascade' }),
  equipmentId: uuid('equipment_id').references(() => equipment.id, { onDelete: 'set null' }),

  // Snapshot name — frozen at save time, safe if registry name changes later
  equipmentName: text('equipment_name').notNull(),

  dayType: text('day_type', {
    enum: ['WEEKDAYS', 'SATURDAYS', 'SUNDAYS_AND_HOLIDAYS'],
  }).notNull(),

  discountPercent: numeric('discount_percent', { precision: 5, scale: 2 }).notNull(),
  discountLabel:   text('discount_label').notNull(),    // "Standard" | "Silver" | "Gold"

  dayCount:    integer('day_count').notNull(),
  ratePerDay:  numeric('rate_per_day',  { precision: 12, scale: 2 }).notNull(),
  subtotal:    numeric('subtotal',      { precision: 12, scale: 2 }).notNull(),
  discountAmt: numeric('discount_amt',  { precision: 12, scale: 2 }).notNull(),
  lineTotal:   numeric('line_total',    { precision: 12, scale: 2 }).notNull(),

  // "1-5, 8-12" — stored so PDF never needs to re-derive day ranges
  dayRanges: text('day_ranges').notNull(),
}, (t) => ({
  invoiceIdx:   index('line_items_invoice_idx').on(t.invoiceId),
  equipmentIdx: index('line_items_equipment_idx').on(t.equipmentId),
  dayTypeIdx:   index('line_items_day_type_idx').on(t.dayType),
}));

// ─── INVOICE INPUTS ───────────────────────────────────────────────────────────
// The full Equipment[] array as JSON, serialised at save time.
// idleDays stored as ISO strings. Loaded back into the calculator for re-editing.
export const invoiceInputs = pgTable('invoice_inputs', {
  id:                uuid('id').primaryKey().defaultRandom(),
  invoiceId:         uuid('invoice_id').notNull()
                       .references(() => invoices.id, { onDelete: 'cascade' })
                       .unique(),
  equipmentSnapshot: jsonb('equipment_snapshot').notNull(),
}, (t) => ({
  invoiceIdx: index('inputs_invoice_idx').on(t.invoiceId),
}));

// ─── RELATIONS ────────────────────────────────────────────────────────────────
export const clientsRelations = relations(clients, ({ many }) => ({
  projects: many(projects),
  invoices: many(invoices),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  client:   one(clients,   { fields: [projects.clientId],  references: [clients.id] }),
  invoices: many(invoices),
}));

export const equipmentRelations = relations(equipment, ({ many }) => ({
  lineItems: many(invoiceLineItems),
}));

export const invoicesRelations = relations(invoices, ({ one, many }) => ({
  client:    one(clients,   { fields: [invoices.clientId],   references: [clients.id] }),
  project:   one(projects,  { fields: [invoices.projectId],  references: [projects.id] }),
  lineItems: many(invoiceLineItems),
  inputs:    one(invoiceInputs, {
    fields:     [invoices.id],
    references: [invoiceInputs.invoiceId],
  }),
}));

export const invoiceLineItemsRelations = relations(invoiceLineItems, ({ one }) => ({
  invoice:   one(invoices,  { fields: [invoiceLineItems.invoiceId],   references: [invoices.id] }),
  equipment: one(equipment, { fields: [invoiceLineItems.equipmentId], references: [equipment.id] }),
}));

export const invoiceInputsRelations = relations(invoiceInputs, ({ one }) => ({
  invoice: one(invoices, { fields: [invoiceInputs.invoiceId], references: [invoices.id] }),
}));
```

---

## Supabase RLS Policies

Solo tool = simple RLS. Every row belongs to the authenticated user.
No org checks, no role checks.

```sql
-- Enable RLS on all tables
ALTER TABLE clients            ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects           ENABLE ROW LEVEL SECURITY;
ALTER TABLE equipment          ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices           ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_line_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_inputs     ENABLE ROW LEVEL SECURITY;

-- Direct ownership
CREATE POLICY "solo_access" ON clients
  FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "solo_access" ON projects
  FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "solo_access" ON equipment
  FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "solo_access" ON invoices
  FOR ALL USING (auth.uid() = user_id);

-- Child tables: access granted through parent invoice ownership
CREATE POLICY "via_invoice" ON invoice_line_items
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM invoices
      WHERE invoices.id = invoice_id
        AND invoices.user_id = auth.uid()
    )
  );

CREATE POLICY "via_invoice" ON invoice_inputs
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM invoices
      WHERE invoices.id = invoice_id
        AND invoices.user_id = auth.uid()
    )
  );
```

---

## Analytics Queries

All queries run as fast single-pass SELECTs. Numbers are pre-computed and indexed.
Use Drizzle's query builder or raw SQL — both work fine with Supabase.

### Monthly Revenue Per Machine
```sql
SELECT
  li.equipment_name,
  i.billing_year,
  i.billing_month,
  SUM(li.line_total)::numeric AS revenue
FROM invoice_line_items li
JOIN invoices i ON i.id = li.invoice_id
WHERE i.user_id = auth.uid()
  AND i.status != 'draft'
GROUP BY li.equipment_name, i.billing_year, i.billing_month
ORDER BY i.billing_year DESC, i.billing_month DESC;
```

### Machine Utilisation Rate (Working vs Idle Days)
```sql
SELECT
  li.equipment_name,
  i.billing_year,
  i.billing_month,
  SUM(li.day_count) AS working_days,
  (
    DATE_PART('day',
      DATE_TRUNC('month', MAKE_DATE(i.billing_year, i.billing_month, 1))
      + INTERVAL '1 month' - INTERVAL '1 day'
    )::int
  ) - SUM(li.day_count) AS idle_days
FROM invoice_line_items li
JOIN invoices i ON i.id = li.invoice_id
WHERE i.user_id = auth.uid()
GROUP BY li.equipment_name, i.billing_year, i.billing_month;
```

### Year-on-Year Revenue Comparison
```sql
SELECT
  i.billing_year,
  i.billing_month,
  SUM(i.total_ex_vat)::numeric AS monthly_revenue
FROM invoices i
WHERE i.user_id = auth.uid()
  AND i.status != 'draft'
GROUP BY i.billing_year, i.billing_month
ORDER BY i.billing_year DESC, i.billing_month ASC;
```

### Revenue Per Client
```sql
SELECT
  c.name              AS client,
  i.billing_year,
  SUM(i.total_ex_vat) AS total_billed,
  COUNT(i.id)         AS invoice_count
FROM invoices i
JOIN clients c ON c.id = i.client_id
WHERE i.user_id = auth.uid()
  AND i.status != 'draft'
GROUP BY c.name, i.billing_year
ORDER BY i.billing_year DESC, total_billed DESC;
```

### Discount Tier Distribution (How Often You Hit Gold)
```sql
SELECT
  li.discount_label,
  COUNT(*)             AS line_count,
  SUM(li.line_total)   AS revenue,
  SUM(li.discount_amt) AS total_discount_given
FROM invoice_line_items li
JOIN invoices i ON i.id = li.invoice_id
WHERE i.user_id = auth.uid()
GROUP BY li.discount_label
ORDER BY li.discount_percent ASC;
```

---

## Types to Add Now (Beta-Compatible, Production-Ready)

Add to: src/components/PlantHireCalculator/types/index.ts

These types match the DB schema exactly. When you migrate to Supabase,
the INSERT calls map 1:1 — no structural changes.

```typescript
export type DayTypeKey = 'WEEKDAYS' | 'SATURDAYS' | 'SUNDAYS_AND_HOLIDAYS';
export type InvoiceStatus = 'draft' | 'finalised' | 'sent' | 'paid';

// Maps to invoice_line_items table
export interface ComputedLineItem {
  equipmentName:   string;
  dayType:         DayTypeKey;
  discountPercent: number;
  discountLabel:   string;
  dayCount:        number;
  ratePerDay:      number;
  subtotal:        number;
  discountAmt:     number;
  lineTotal:       number;
  dayRanges:       string;
}

// Maps to invoices + invoice_line_items + invoice_inputs
export interface SavedInvoice {
  id:           string;         // uuid
  billingYear:  number;         // 2025
  billingMonth: number;         // 1–12
  status:       InvoiceStatus;
  totalExVat:   number;
  lineItems:    ComputedLineItem[];
  equipment:    Equipment[];    // raw inputs for re-editing
  clientId?:    string;
  projectId?:   string;
  createdAt:    string;         // ISO string
}
```

---

## buildSavedInvoice — Write Once, Works Everywhere

File: src/lib/buildSavedInvoice.ts

This pure function is the bridge between your calculator and the database.
It works identically for localStorage (beta) and Supabase (production).
The ONLY thing that changes between phases is the final persistence call.

```typescript
import {
  calculatePeriods,
  getSAHolidays,
  formatDayRanges,
} from '@/components/PlantHireCalculator/utils/calculations';
import type {
  Equipment,
  SavedInvoice,
  ComputedLineItem,
  DayTypeKey,
} from '@/components/PlantHireCalculator/types';

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export const buildSavedInvoice = (
  equipment: Equipment[],
  currentMonth: Date,
  options?: { clientId?: string; projectId?: string }
): SavedInvoice => {
  const year       = currentMonth.getFullYear();
  const monthIdx   = currentMonth.getMonth();   // 0-indexed
  const saHolidays = getSAHolidays(year);
  const lineItems: ComputedLineItem[] = [];
  let   totalExVat = 0;

  equipment.forEach(item => {
    const periods = calculatePeriods(item.idleDays, currentMonth);

    // Accumulate day numbers per tier × dayType bucket
    type Bucket = { days: number[]; discount: number; label: string };
    const buckets = new Map<string, Bucket>();

    periods.forEach(period => {
      for (let d = period.start; d <= period.end; d++) {
        const date  = new Date(year, monthIdx, d);
        const isHol = saHolidays.some(h =>
          h.getDate() === d &&
          h.getMonth() === monthIdx &&
          h.getFullYear() === year
        );
        const dayType: DayTypeKey =
          isHol || date.getDay() === 0 ? 'SUNDAYS_AND_HOLIDAYS' :
          date.getDay() === 6          ? 'SATURDAYS'            :
                                         'WEEKDAYS';

        const key = `${period.tier.discount}__${dayType}`;
        if (!buckets.has(key)) {
          buckets.set(key, {
            days:     [],
            discount: period.tier.discount,
            label:    period.tier.label,
          });
        }
        buckets.get(key)!.days.push(d);
      }
    });

    // Emit one ComputedLineItem per bucket
    buckets.forEach((bucket, key) => {
      if (bucket.days.length === 0) return;
      const dayType = key.split('__')[1] as DayTypeKey;

      const rate =
        dayType === 'WEEKDAYS'  ? item.rates.weekday  :
        dayType === 'SATURDAYS' ? item.rates.saturday : item.rates.sunday;

      const subtotal    = r2(bucket.days.length * rate);
      const discountAmt = r2(subtotal * (bucket.discount / 100));
      const lineTotal   = r2(subtotal - discountAmt);

      totalExVat += lineTotal;

      lineItems.push({
        equipmentName:   item.name,
        dayType,
        discountPercent: bucket.discount,
        discountLabel:   bucket.label,
        dayCount:        bucket.days.length,
        ratePerDay:      rate,
        subtotal,
        discountAmt,
        lineTotal,
        dayRanges:       formatDayRanges(bucket.days),
      });
    });
  });

  return {
    id:           crypto.randomUUID(),
    billingYear:  year,
    billingMonth: monthIdx + 1,   // store as 1–12
    status:       'draft',
    totalExVat:   r2(totalExVat),
    lineItems,
    equipment,                    // raw inputs for re-editing
    clientId:     options?.clientId,
    projectId:    options?.projectId,
    createdAt:    new Date().toISOString(),
  };
};
```

---

## The Migration Is Just a Storage Swap

```typescript
// ─── BETA (localStorage) ──────────────────────────────────────────────────
const invoice = buildSavedInvoice(equipment, currentMonth);
const all = JSON.parse(localStorage.getItem('invoices') ?? '[]');
localStorage.setItem('invoices', JSON.stringify([...all, invoice]));

// ─── PRODUCTION (Supabase via Drizzle) ────────────────────────────────────
const invoice = buildSavedInvoice(equipment, currentMonth, { clientId, projectId });

await db.transaction(async (tx) => {
  const [saved] = await tx.insert(invoices).values({
    userId:      session.user.id,
    clientId:    invoice.clientId ?? null,
    projectId:   invoice.projectId ?? null,
    billingYear:  invoice.billingYear,
    billingMonth: invoice.billingMonth,
    status:      'draft',
    totalExVat:  invoice.totalExVat.toString(),
    vatAmount:   '0',
    totalIncVat: invoice.totalExVat.toString(),
  }).returning();

  await tx.insert(invoiceLineItems).values(
    invoice.lineItems.map(li => ({
      invoiceId:       saved.id,
      equipmentName:   li.equipmentName,
      dayType:         li.dayType,
      discountPercent: li.discountPercent.toString(),
      discountLabel:   li.discountLabel,
      dayCount:        li.dayCount,
      ratePerDay:      li.ratePerDay.toString(),
      subtotal:        li.subtotal.toString(),
      discountAmt:     li.discountAmt.toString(),
      lineTotal:       li.lineTotal.toString(),
      dayRanges:       li.dayRanges,
    }))
  );

  await tx.insert(invoiceInputs).values({
    invoiceId:         saved.id,
    equipmentSnapshot: invoice.equipment,  // Drizzle handles jsonb serialisation
  });
});
```

Zero logic changes. buildSavedInvoice() is identical. Only the persistence target changes.

---

## Post-Beta Implementation Phases

Phase A — Auth + Schema (Week 1 after beta)
  Migrate to Next.js 15 App Router
  bun add drizzle-orm drizzle-kit @supabase/ssr @supabase/supabase-js
  Create Supabase project, set DATABASE_URL in .env
  Run: bunx drizzle-kit push
  Wire Supabase Auth (magic link or Google OAuth — no password needed for solo tool)
  Add middleware.ts to protect /app routes

Phase B — Save + List Invoices (Week 2)
  Server action: saveInvoice(equipment[], month, clientId?, projectId?)
  "Save Invoice" button in GrandTotalFooter
  /app/invoices — list view, filterable by month and status
  /app/invoices/[id] — single invoice view, reading from line_items
  "Download PDF" wired to saved data (no recalculation)

Phase C — Equipment Registry (Week 2-3)
  /app/equipment — manage machines and default rates
  New invoice pre-fills from registry

Phase D — Clients + Projects (Week 3)
  /app/clients — simple CRUD
  /app/projects — CRUD, linked to a client
  Invoice form: optional client/project dropdown

Phase E — Analytics (Week 4-6)
  /app/analytics
  Monthly revenue chart (Recharts — already in your stack)
  Machine utilisation heatmap
  Year-on-year comparison
  Revenue per client bar chart
  XLSX export for accountant (SheetJS)

---

## Summary

The schema is intentionally lean for a solo tool. No organisations, no teams,
no permissions — just auth.uid() = user_id on every table.

The key architectural win is writing ComputedLineItem rows at save time.
Every analytics query becomes a cheap GROUP BY on indexed columns.
No recalculation, no complex joins, no aggregation on raw inputs.

buildSavedInvoice() is the only function that matters for migration.
Write it once today, use it in localStorage beta, and when Supabase is ready,
swap the two lines at the bottom that do the actual persist.
Everything else — the calculator, the PDF export, the UI — stays identical.
