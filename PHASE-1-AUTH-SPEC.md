# Phase 1, Authentication MVP

## Recommendation
Use:
- Next.js
- Supabase Auth
- Postgres
- mobile-first UI
- wizard flow, one action per screen

This is the fastest safe stack for Phase 1 and leaves room for later phases.

## Goal
Finish authentication completely before any project, upload, AI, pricing, or payment work.

## Active MVP roles
- admin
- staff
- client

## Reserved future roles
Keep the schema ready for:
- supplier
- accountant
- reviewer

Do not build their full flows yet.

## Screens
1. Welcome screen
2. Login screen
3. Register screen
4. Forgot password screen
5. OTP/email verification screen
6. Profile completion screen
7. Role-based landing screen

## Rules
- one action per screen
- mobile first
- clear separation between auth data, app data, and AI data
- no mixed admin/client screens
- every protected route must check session + role

## Auth flow
### Client
Welcome -> Register/Login -> Verify -> Complete profile -> Client home

### Staff/Admin
Login -> Verify -> Role check -> Staff/Admin home

## Data model, minimum
### users
- id
- full_name
- phone
- email
- password/auth provider reference
- status
- created_at

### user_roles
- id
- user_id
- role
- active

### user_profiles
- id
- user_id
- display_name
- company_name
- phone
- avatar_url

## Acceptance criteria
Phase 1 is only done when:
- user can register
- user can log in
- user can reset password
- session persists correctly
- protected pages reject unauthenticated users
- role guard works
- mobile screens are usable end to end
- admin and client do not land on the same dashboard

## Out of scope for Phase 1
- project system
- file upload
- AI takeoff
- pricing
- proposals
- payments
- supplier flows

## Next step after approval
Build the fresh app shell and implement only:
- auth pages
- role guard
- session handling
- role-based landing pages
