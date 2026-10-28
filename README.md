# CMS Workspace — PostgreSQL / Express / Node / React

A clean, extensible CMS workspace inspired by modern productivity tools such as Linear. The UI and implementation are original.

## Stack

- React + React Router + CSS
- Node.js + Express
- PostgreSQL
- `pg` raw parameterized SQL
- JWT authentication
- bcrypt password hashing

No ORM is used.

## Current hierarchy

Organization
  -> Project
      -> Task

Organization membership is separate from the global user role.

### Organization roles

- admin
- member

Each organization can have a maximum of 3 admins. The creator automatically becomes the first admin.

### Project assignment rule

A project member MUST already belong to the project's organization. This is checked by the backend, not only by React.

### Task assignment rule

A task assignee MUST be a member of the project.

## Database

Create a PostgreSQL database named:

cms

Copy `Backend/.env.example` to `Backend/.env` and set your local PostgreSQL
password and a unique `JWT_SECRET`. Keep `.env` private and out of version
control. OpenRouter and SendGrid settings are optional; their features require
valid provider credentials.

## Start backend

Open terminal:

cd Backend
npm install
npm run db:migrate
npm run dev

Backend runs at:

http://localhost:5001

## Start frontend

Open another terminal:

cd Frontend
npm install

Optional:
copy `Frontend/.env.example` to `Frontend/.env` to override the API/socket URLs.

Then:

npm run dev

Frontend normally runs at:

http://localhost:5173

## Important first-user note

Signup creates a normal system-level user.

When that user creates an organization, the backend creates an organization membership for that user with role `admin`.

The system-level `users.role` and organization-level `organization_members.role` are intentionally different.

## API overview

Authentication:
POST /api/auth/signup
POST /api/auth/login
GET  /api/auth/me

Organizations:
GET    /api/organizations
POST   /api/organizations
GET    /api/organizations/:id
PUT    /api/organizations/:id
DELETE /api/organizations/:id

Members:
GET    /api/organizations/:id/members
POST   /api/organizations/:id/members
PUT    /api/organizations/:id/members/:userId
DELETE /api/organizations/:id/members/:userId

Projects:
GET    /api/projects?organizationId=:id
POST   /api/projects
GET    /api/projects/:id
PUT    /api/projects/:id
DELETE /api/projects/:id

Project members:
GET    /api/projects/:id/members
POST   /api/projects/:id/members
DELETE /api/projects/:id/members/:userId

Tasks:
GET    /api/tasks?projectId=:id
POST   /api/tasks
GET    /api/tasks/:id
PUT    /api/tasks/:id
DELETE /api/tasks/:id

## Architecture

Backend:
- config: database connection
- controllers: HTTP request handling
- middleware: authentication
- routes: REST endpoint definitions
- services/repositories can be introduced as the application grows
- db/migrations: SQL schema

Frontend:
- pages: screen-level components
- components: reusable UI
- services: API calls
- context: authentication state
- styles: centralized CSS

## Extending later

The schema is prepared for:
- comments
- activity history
- labels
- notifications
- attachments
- invitations
- custom statuses
- audit logs
- dashboards and reports

Build these as separate modules rather than placing everything in one large component/controller.
