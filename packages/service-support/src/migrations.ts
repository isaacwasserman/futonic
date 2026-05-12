/**
 * SQL DDL for the support service's tables.
 *
 * Hosts run these statements before `host.init()` so Kysely sees the
 * tables. Table names are prefixed with `support_` to match the service id.
 */

export const SQLITE_UP = `
CREATE TABLE IF NOT EXISTS support_tickets (
	id TEXT PRIMARY KEY NOT NULL,
	customer_id TEXT NOT NULL,
	subject TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'open',
	priority TEXT NOT NULL DEFAULT 'normal',
	assignee_id TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	closed_at TEXT
);

CREATE INDEX IF NOT EXISTS support_tickets_customer_id ON support_tickets(customer_id);
CREATE INDEX IF NOT EXISTS support_tickets_status ON support_tickets(status);
CREATE INDEX IF NOT EXISTS support_tickets_assignee_id ON support_tickets(assignee_id);

CREATE TABLE IF NOT EXISTS support_ticket_comments (
	id TEXT PRIMARY KEY NOT NULL,
	ticket_id TEXT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
	author_id TEXT NOT NULL,
	author_role TEXT NOT NULL,
	body TEXT NOT NULL,
	created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS support_ticket_comments_ticket_id ON support_ticket_comments(ticket_id);
`;
