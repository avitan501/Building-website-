# AI Construction Management Platform

## Goal
Build a mobile-first web app that lets users:
- create construction projects
- upload plans and photos
- run AI takeoff for draft material lists
- send results for admin review and edits
- let the client approve
- let the client pay
- send the order to suppliers
- track delivery

## Target users
- Homeowners
- Contractors
- Designers

## Core features
1. Projects
2. File upload (PDF + images)
3. AI takeoff (draft only)
4. Admin approval system
5. Product catalog
6. Pricing system
7. Proposal system
8. Payment system
9. Supplier orders
10. Delivery tracking
11. Google Drive storage
12. CRM system

## User roles
### Admin
- full control
- edit everything
- approve everything

### Staff
- limited editing

### Client
- view only
- approve
- pay

## Important rules
- All AI output must be draft first
- Nothing goes live without admin approval
- Client must not see:
  - margin
  - supplier
  - internal notes

## AI rules
- show confidence score
- highlight low-confidence results
- detect duplicates
- detect missing materials
- suggest alternatives but do not auto apply

## Quote upload
Accept:
- PDF
- images

Extract:
- materials
- quantities
- prices

Rules:
- never auto insert items
- always require admin approval
- allow compare multiple quotes

## Product rules
- SKU required
- cost and sell price
- margin hidden from client
- flexible units
- variants supported

## Payment rules
Supported methods:
- Stripe card
- ACH
- Zelle (manual)
- Pay later (code)

Rules:
- minimum order is $500
- deposit allowed

## Supplier rules
- supplier hidden from client
- assign supplier per item
- send orders by email or WhatsApp

## Files and storage
- auto-create a Google Drive folder per project
- save all uploads, takeoff files, marked plans, and orders
- versioning required: v1, v2, v3
- never overwrite files

## UX rules
- mobile first
- step-by-step screens
- minimal text
- one action per screen

## Coming Soon rules
- visible only to admin
- locked with owner password
- never shown to client

## Final rule
If something is not 100% ready, keep it in draft or Coming Soon.
