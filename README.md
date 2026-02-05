# Plant Hire Calculator (South Africa)

A specialized **Next.js + React** application for generating accurate **plant hire payment certificates** and **invoice breakdowns** aligned with common South African municipal tender requirements.
The system automates complex pricing rules including **tiered discounts**, **overtime rate formulas**, and **South African public holiday logic**.

---

## 🚀 Key Features

### 🇿🇦 South African Context

* **Currency Formatting:** ZAR (Rand) with proper spacing
  Example: `R109 720.00`
* **Public Holiday Detection:**

  * Fixed South African public holidays
  * Dynamic Easter-based holidays
  * **Sunday Rule**: If a public holiday falls on a Sunday, the following Monday is treated as a holiday

### 🧮 Smart Rate Calculations

Rates are automatically derived from the **Base Daily Rate**:

| Day Type                  | Formula                  | Description             |
| ------------------------- | ------------------------ | ----------------------- |
| Weekdays                  | Base Rate                | Standard daily charge   |
| Saturdays                 | Base + (5% × Base × 1.5) | Time-and-a-half loading |
| Sundays & Public Holidays | Base + (5% × Base × 2.0) | Double-time loading     |

**Manual Override:** Any calculated rate can be manually edited to accommodate special contract terms.

---

### 🎯 Tiered Discount Logic (Continuous Work)

| Continuous Days Worked | Discount Applied   |
| ---------------------- | ------------------ |
| 1–4 Days               | 0% (Standard Rate) |
| 5–14 Days              | 5% Discount        |
| 15+ Days               | 10% Discount       |

**Important Rule:**
Any day marked as **Idle** breaks the continuity, resetting the discount cycle.

---

### 🧾 Invoice Generation

The system generates a structured breakdown aligned with municipal-style payment certificates:

* Groups line items by **Discount Tier** and **Day Type**
* Displays **date ranges** clearly (e.g., `Weekdays: 1–5, 8–12`)
* Calculates totals automatically based on rates, discounts, and working days

---

## 🛠️ Technology Stack

| Layer      | Technology           |
| ---------- | -------------------- |
| Framework  | Next.js (App Router) |
| UI Library | React                |
| Styling    | Tailwind CSS         |
| Icons      | Lucide React         |

---

## 📦 Installation & Setup

### 1️⃣ Clone the Repository

```bash
git clone https://github.com/your-username/plant-hire-calculator.git
cd plant-hire-calculator
```

### 2️⃣ Install Dependencies

```bash
npm install
# or
yarn install
# or
pnpm install
```

### 3️⃣ Run the Development Server

```bash
npm run dev
```

Open your browser and go to:

```
http://localhost:3000
```

---

## 🧮 Calculation Rules (Tender Compliance)

### 1️⃣ Discount Structure (Continuous Work)

| Days Worked | Rule                    |
| ----------- | ----------------------- |
| 1–4 Days    | No discount             |
| 5–14 Days   | 5% off applicable rate  |
| 15+ Days    | 10% off applicable rate |

---

### 2️⃣ Overtime Rate Formulas

All overtime rates are derived from the tender rule:

> **Rate = Base + (5% of Base × Factor)**

| Day Type                  | Factor | Formula                      |
| ------------------------- | ------ | ---------------------------- |
| Saturdays                 | 1.5    | `Base + (0.05 × Base × 1.5)` |
| Sundays & Public Holidays | 2.0    | `Base + (0.05 × Base × 2.0)` |

---

## 📂 Project Structure

```
├── app/
│   ├── globals.css        # Tailwind directives
│   ├── layout.tsx         # Root layout
│   └── page.tsx           # Main entry point
├── components/
│   └── PlantHireCalculator.tsx  # Core calculator logic
├── public/
└── tailwind.config.ts     # Tailwind configuration
```

---

## 📝 Usage Guide

### 1️⃣ Select Invoice Month

Use the arrow buttons at the top of the interface to choose the billing month.

### 2️⃣ Add Equipment

Enter:

* Machine/plant name (e.g., **Grader**)
* Base Daily Rate (**excluding VAT**)

### 3️⃣ Mark Idle Days

Click calendar dates to mark them as **Idle (Red)**:

* Idle days are **not billed**
* Idle days **break discount continuity**

### 4️⃣ Verify or Adjust Rates

Expand **Rates Config** to view calculated overtime rates. Adjust manually if contract-specific rules apply.

### 5️⃣ Review Invoice Breakdown

The invoice summary updates in real time and displays:

* Grouped billing lines
* Date ranges per rate category
* Discount tiers applied
* Final calculated total

---

## 📄 License

This project is licensed under the **MIT License**.
