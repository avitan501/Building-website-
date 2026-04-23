# Business Ops Tools Roadmap

## Working assumption
This business flow looks like:
1. Customer asks for materials
2. Multiple suppliers send quotes
3. Quotes must be normalized and compared line by line
4. Best buy decision is made
5. Your margin is added
6. Customer gets your final offer
7. Supplier delivers direct
8. You track profit, payment, and completion

## Best tools to build first

### 1) Quote inbox
- Take PDFs, photos, WhatsApp messages, and notes
- Extract items automatically
- Save supplier, date, customer, job, tax, total, delivery date

### 2) Exact item comparison engine
- Put supplier A / B / C side by side
- Mark exact match vs non-exact match
- Show subtotal, tax, total, delivery, and who is cheaper
- Highlight risky mismatches

### 3) Margin calculator
- Add your markup by dollars or percent
- Show profit per line and total profit per job
- Keep customer price separate from supplier cost

### 4) Customer proposal builder
- Generate a clean customer-facing quote
- Hide supplier identity when needed
- Show only your final selling price

### 5) Order tracker
- Stages: lead, quoted, sent, approved, ordered, delivered, paid, closed
- Track who owes money and what is still open

### 6) Price history
- Save every quote by supplier and item
- See last price, lowest price, average price, and recent movement

### 7) Supplier scorecard
- Cheapest
- Fastest delivery
- Best exact-match reliability
- Best payment terms
- Best overall for each category

### 8) Delivery and payment control
- Confirm delivery date promised vs actual
- Track balance due from customer
- Track amount owed to supplier

## Recommended build order

### Phase 1
- Quote inbox
- Extraction
- Exact comparison table

### Phase 2
- Margin calculator
- Customer proposal builder

### Phase 3
- Order tracker
- Profit dashboard

### Phase 4
- Price history
- Supplier scorecard
- Delivery/payment analytics

## Main risk
The biggest problem is usually not math. It is item matching.
So the system must clearly separate:
- exact same item
- likely same item
- different item

## Recommendation
Build the business around one core rule:
**Never compare prices unless the item match is exact or clearly flagged.**
