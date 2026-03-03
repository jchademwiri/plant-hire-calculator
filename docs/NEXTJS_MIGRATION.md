# Plant Hire Calculator - Astro to Next.js 15 Migration Guide

Stack: Next.js 15 App Router, Supabase, Drizzle ORM, Tailwind CSS v4, TypeScript

---

## When to Migrate

The Astro beta is the right tool right now. Migrate when you need any of these:
saving invoices to a database, Supabase Auth with protected routes, analytics
dashboard, PDF storage, or background jobs. Ship the Astro version first and
collect real feedback before migrating.

---

## What Moves Across Unchanged

Every file in src/components/PlantHireCalculator/ is framework-agnostic React.
This is the bulk of your codebase and requires zero changes.

components/     All UI components, copy verbatim
hooks/          useEquipmentManager, usePersistedEquipment, copy verbatim
utils/          calculations.ts, formatters, copy verbatim
types/          All TypeScript interfaces, copy verbatim
lib/            buildSavedInvoice.ts once written, copy verbatim

What changes is only the shell around this code: Astro .astro files become
Next.js layout.tsx and page.tsx files, astro.config.mjs becomes next.config.ts,
and Astro client:load islands become the use client directive.

---

## Step 1 - Scaffold (Day 1)

```bash
bunx create-next-app@latest plant-hire-web \
  --typescript \
  --tailwind \
  --eslint \
  --app \
  --src-dir \
  --import-alias "@/*"

cd plant-hire-web

bun add drizzle-orm @supabase/supabase-js @supabase/ssr @react-pdf/renderer lucide-react
bun add -d drizzle-kit
```

Tailwind v4 setup (Next.js scaffolds v3 by default):

```bash
bun add tailwindcss@next @tailwindcss/postcss@next
```

Update postcss.config.mjs:
```js
export default {
  plugins: { '@tailwindcss/postcss': {} },
};
```

Update src/app/globals.css:
```css
@import "tailwindcss";
```

Remove tailwind.config.ts entirely. v4 needs no config file.

Copy your component tree:
```bash
cp -r ../your-astro-project/src/components/PlantHireCalculator ./src/components/
cp -r ../your-astro-project/src/lib ./src/lib/
```

Add use client to the top of src/components/PlantHireCalculator/index.tsx:
```typescript
'use client';
// rest of file unchanged
```

---

## Step 2 - Directory Structure

```
src/
  app/
    layout.tsx                     Root layout
    page.tsx                       Landing or redirect to /app/calculator
    (auth)/
      login/page.tsx
    app/                           Protected area
      layout.tsx                   Auth check + nav shell
      calculator/page.tsx          Main calculator
      invoices/
        page.tsx                   Invoice list
        [id]/page.tsx              Single invoice view
      equipment/page.tsx
      clients/page.tsx
      projects/page.tsx
      analytics/page.tsx
  components/
    PlantHireCalculator/           Copied verbatim from Astro
  db/
    index.ts                       Drizzle client
    schema.ts                      Full schema from DATA_ARCHITECTURE.md
  lib/
    supabase/
      client.ts                    Browser Supabase client
      server.ts                    Server Supabase client with SSR cookies
    buildSavedInvoice.ts           Pure transform function
  actions/
    invoices.ts                    Server actions for save and load
  middleware.ts                    Route protection
```

---

## Step 3 - Environment Variables

Create .env.local:
```
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
DATABASE_URL=postgresql://postgres:[password]@db.your-project.supabase.co:5432/postgres
```

---

## Step 4 - Supabase Clients

You need two separate clients: one for the browser, one for the server.

src/lib/supabase/client.ts:
```typescript
import { createBrowserClient } from '@supabase/ssr';

export const createClient = () =>
  createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
```

src/lib/supabase/server.ts:
```typescript
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

export const createServerSupabaseClient = async () => {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet) => {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Server Component context - middleware handles session refresh
          }
        },
      },
    }
  );
};
```

---

## Step 5 - Drizzle Client

src/db/index.ts:
```typescript
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const client = postgres(process.env.DATABASE_URL!, {
  prepare: false, // Required for Supabase pgBouncer - do not remove
});

export const db = drizzle(client, { schema });
```

drizzle.config.ts (project root):
```typescript
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema:  './src/db/schema.ts',
  out:     './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! },
});
```

Push schema to Supabase:
```bash
bunx drizzle-kit push
```

---

## Step 6 - Middleware

src/middleware.ts:
```typescript
import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet) => {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // Always refresh session - do not remove this call
  const { data: { user } } = await supabase.auth.getUser();

  if (!user && request.nextUrl.pathname.startsWith('/app')) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  if (user && request.nextUrl.pathname === '/login') {
    return NextResponse.redirect(new URL('/app/calculator', request.url));
  }

  return supabaseResponse;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|webp)$).*)',],
};
```

---

## Step 7 - Layouts and Pages

src/app/layout.tsx:
```typescript
import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title:       'Plant Hire Calculator · South Africa',
  description: 'Municipal-compliant plant hire invoicing.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

src/app/app/layout.tsx (protected shell):
```typescript
import { redirect } from 'next/navigation';
import { createServerSupabaseClient } from '@/lib/supabase/server';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  return (
    <div className="min-h-screen bg-slate-50">
      <nav className="border-b border-slate-200 bg-white px-6 py-3 flex items-center gap-6">
        <span className="font-semibold text-emerald-700 text-sm">Plant Hire</span>
        <a href="/app/calculator" className="text-sm text-slate-600 hover:text-slate-900">Calculator</a>
        <a href="/app/invoices"   className="text-sm text-slate-600 hover:text-slate-900">Invoices</a>
        <a href="/app/analytics"  className="text-sm text-slate-600 hover:text-slate-900">Analytics</a>
        <a href="/app/clients"    className="text-sm text-slate-600 hover:text-slate-900">Clients</a>
        <a href="/app/equipment"  className="text-sm text-slate-600 hover:text-slate-900">Equipment</a>
      </nav>
      <main>{children}</main>
    </div>
  );
}
```

Calculator page migration (Astro client:load becomes a plain Next.js page):
```typescript
// src/app/app/calculator/page.tsx
import { PlantHireCalculator } from '@/components/PlantHireCalculator';

export default function CalculatorPage() {
  return <PlantHireCalculator />;
}
```

Login page:
```typescript
// src/app/(auth)/login/page.tsx
'use client';
import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';

export default function LoginPage() {
  const [email, setEmail]     = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent]       = useState(false);
  const supabase = createClient();

  const handleLogin = async () => {
    setLoading(true);
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${location.origin}/app/calculator` },
    });
    if (!error) setSent(true);
    setLoading(false);
  };

  if (sent) return (
    <div className="min-h-screen flex items-center justify-center">
      <p className="text-slate-600 text-sm">Check your email for a login link.</p>
    </div>
  );

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <div className="bg-white rounded-xl border border-slate-200 p-8 w-full max-w-sm">
        <h1 className="text-xl font-bold text-slate-800 mb-6">Sign in</h1>
        <input
          type="email"
          placeholder="your@email.com"
          value={email}
          onChange={e => setEmail(e.target.value)}
          className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mb-3"
        />
        <button
          onClick={handleLogin}
          disabled={loading || !email}
          className="w-full bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50
                     text-white py-2 rounded-lg text-sm font-medium transition-colors"
        >
          {loading ? 'Sending...' : 'Send magic link'}
        </button>
      </div>
    </div>
  );
}
```

---

## Step 8 - Save Invoice Server Action

src/actions/invoices.ts:
```typescript
'use server';

import { redirect }           from 'next/navigation';
import { revalidatePath }     from 'next/cache';
import { db }                 from '@/db';
import { invoices, invoiceLineItems, invoiceInputs } from '@/db/schema';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { buildSavedInvoice }  from '@/lib/buildSavedInvoice';
import type { Equipment }     from '@/components/PlantHireCalculator/types';

export async function saveInvoiceAction(
  equipment: Equipment[],
  currentMonth: string,     // ISO string - Date serialises to string across the boundary
  options?: { clientId?: string; projectId?: string }
) {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // Rehydrate Date from ISO string (server action boundary serialises Dates)
  const month   = new Date(currentMonth);
  const invoice = buildSavedInvoice(equipment, month, options);

  await db.transaction(async (tx) => {
    const [saved] = await tx
      .insert(invoices)
      .values({
        userId:       user.id,
        clientId:     invoice.clientId  ?? null,
        projectId:    invoice.projectId ?? null,
        billingYear:  invoice.billingYear,
        billingMonth: invoice.billingMonth,
        status:       'draft',
        totalExVat:   invoice.totalExVat.toString(),
        vatAmount:    '0',
        totalIncVat:  invoice.totalExVat.toString(),
      })
      .returning();

    if (invoice.lineItems.length > 0) {
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
    }

    await tx.insert(invoiceInputs).values({
      invoiceId:         saved.id,
      equipmentSnapshot: invoice.equipment as any,
    });
  });

  revalidatePath('/app/invoices');
  return { success: true };
}
```

---

## Step 9 - Invoice List Page

src/app/app/invoices/page.tsx:
```typescript
import { db }                          from '@/db';
import { invoices, clients, projects } from '@/db/schema';
import { eq, desc }                    from 'drizzle-orm';
import { createServerSupabaseClient }  from '@/lib/supabase/server';
import { redirect }                    from 'next/navigation';

export default async function InvoicesPage() {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const results = await db
    .select({
      id:           invoices.id,
      billingYear:  invoices.billingYear,
      billingMonth: invoices.billingMonth,
      status:       invoices.status,
      totalExVat:   invoices.totalExVat,
      clientName:   clients.name,
      projectName:  projects.name,
    })
    .from(invoices)
    .leftJoin(clients,  eq(invoices.clientId,  clients.id))
    .leftJoin(projects, eq(invoices.projectId, projects.id))
    .where(eq(invoices.userId, user.id))
    .orderBy(desc(invoices.billingYear), desc(invoices.billingMonth));

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <h1 className="text-2xl font-bold text-slate-800 mb-6">Invoices</h1>
      <div className="space-y-2">
        {results.map(inv => (
          <a
            key={inv.id}
            href={`/app/invoices/${inv.id}`}
            className="flex items-center justify-between bg-white border border-slate-200
                       rounded-xl px-5 py-4 hover:border-emerald-300 transition-colors"
          >
            <div>
              <span className="font-medium text-slate-800 text-sm">
                {new Date(inv.billingYear, inv.billingMonth - 1)
                  .toLocaleDateString('en-ZA', { month: 'long', year: 'numeric' })}
              </span>
              {inv.clientName && (
                <span className="text-slate-400 text-xs ml-2">· {inv.clientName}</span>
              )}
            </div>
            <div className="flex items-center gap-3">
              <span className="text-sm font-semibold text-slate-700">
                R {Number(inv.totalExVat).toLocaleString('en-ZA', { minimumFractionDigits: 2 })}
              </span>
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                inv.status === 'paid'      ? 'bg-emerald-50 text-emerald-700' :
                inv.status === 'finalised' ? 'bg-blue-50 text-blue-700'      :
                inv.status === 'sent'      ? 'bg-yellow-50 text-yellow-700'  :
                                             'bg-slate-100 text-slate-500'
              }`}>
                {inv.status}
              </span>
            </div>
          </a>
        ))}
        {results.length === 0 && (
          <p className="text-slate-400 text-sm text-center py-12">
            No invoices yet. Save one from the calculator.
          </p>
        )}
      </div>
    </div>
  );
}
```

---

## Step 10 - next.config.ts

```typescript
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Prevents canvas errors when @react-pdf/renderer is in the bundle
  serverExternalPackages: ['@react-pdf/renderer'],
};

export default nextConfig;
```

---

## Final Checklist

Step 1 - Scaffold
  [ ] create-next-app with flags above
  [ ] Install dependencies
  [ ] Configure Tailwind v4
  [ ] Copy PlantHireCalculator component tree
  [ ] Add use client to index.tsx
  [ ] Create calculator/page.tsx
  [ ] Verify: bun dev, calculator renders and works

Step 2 - Database
  [ ] Create Supabase project
  [ ] Add .env.local with all three env vars
  [ ] Write src/db/schema.ts (from DATA_ARCHITECTURE.md)
  [ ] Write src/db/index.ts with prepare: false
  [ ] Write drizzle.config.ts
  [ ] Run bunx drizzle-kit push
  [ ] Verify tables in Supabase dashboard
  [ ] Add RLS policies via SQL editor

Step 3 - Auth
  [ ] Write lib/supabase/client.ts
  [ ] Write lib/supabase/server.ts
  [ ] Write middleware.ts
  [ ] Write (auth)/login/page.tsx
  [ ] Write app/app/layout.tsx
  [ ] Enable Email provider in Supabase Auth settings
  [ ] Verify login flow end to end

Step 4 - Save Invoice
  [ ] Write actions/invoices.ts
  [ ] Add Save Invoice button to GrandTotalFooter
  [ ] Write app/app/invoices/page.tsx
  [ ] Write app/app/invoices/[id]/page.tsx
  [ ] Verify: save appears in list, detail view correct

Step 5 - Equipment, Clients, Projects
  [ ] CRUD pages for each
  [ ] Pre-fill calculator from equipment registry
  [ ] Client and project dropdowns on save

Step 6 - Analytics
  [ ] Write Drizzle queries (see DATA_ARCHITECTURE.md)
  [ ] /app/analytics with Recharts charts
  [ ] XLSX export via SheetJS

Step 7 - Deploy to Vercel
  [ ] Push to GitHub
  [ ] Import at vercel.com
  [ ] Add env vars in Vercel dashboard
  [ ] Add Vercel URL to Supabase Auth allowed URLs
  [ ] bun run build passes
  [ ] vercel --prod

---

## Common Gotchas

prepare: false is not optional
Supabase uses pgBouncer in transaction mode. Prepared statements break it silently.
Always set prepare: false in your postgres-js client.

Server vs Client Supabase client confusion
Use createServerSupabaseClient in Server Components, Server Actions, and Route Handlers.
Use createClient in use client components. Mixing them causes auth to silently fail.

react-pdf canvas error
Without serverExternalPackages in next.config.ts, Next.js tries to bundle
react-pdf for the server and hits a canvas dependency error at build time.

Date serialisation across Server Action boundary
Dates become ISO strings when passed to a Server Action. Always coerce back:
const month = new Date(currentMonthIsoString);

revalidatePath after mutations
Always call revalidatePath after a Server Action that writes to the database.
Without it, Next.js serves a stale cached version of list pages.

Tailwind v4 class detection
Remove tailwind.config.ts entirely. Do not use @tailwind base/components/utilities.
Use only @import "tailwindcss" in globals.css.

---

URL Structure

  /                       Landing page or redirect to /app
  /login                  Magic link auth
  /app/calculator         Main calculator
  /app/invoices           Invoice history
  /app/invoices/[id]      Single invoice + PDF download
  /app/equipment          Equipment registry
  /app/clients            Client management
  /app/projects           Project management
  /app/analytics          Charts and XLSX export

Plant Hire Calculator - Astro to Next.js Migration - South Africa
