/** Data model for +SPCTR's growth features: smart lists, forms, calendars, automations, conversations. */

/* ---------------- Smart lists ---------------- */

export interface SmartListFilter {
  /** Contact must have every one of these tags. */
  tags?: string[];
  /** Contact must have at least one of these tags. */
  anyTags?: string[];
  source?: string;
  minScore?: number;
  hasEmail?: boolean;
  hasPhone?: boolean;
  companyId?: string;
  /** Added in the last N days. */
  createdWithinDays?: number;
  /** No activity in the last N days. */
  quietForDays?: number;
  /** Custom field equals value. */
  field?: { key: string; value: string };
  /** Free-text match on name, email, phone, title or company. */
  text?: string;
}

export interface SmartList {
  id: string;
  workspace: string;
  name: string;
  filter: SmartListFilter;
  createdAt: string;
}

/* ---------------- Forms ---------------- */

export type FormFieldType = "text" | "email" | "phone" | "textarea" | "select";
/** Where a form answer goes on the contact. "field:<key>" stores it as a custom field. */
export type FormFieldMap = "name" | "email" | "phone" | "title" | "company" | `field:${string}`;

export interface FormField {
  key: string;
  label: string;
  type: FormFieldType;
  required?: boolean;
  options?: string[];
  map: FormFieldMap;
}

export interface Form {
  id: string;
  workspace: string;
  name: string;
  headline?: string;
  fields: FormField[];
  /** Tags added to every contact who submits. */
  tags: string[];
  successMessage: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FormSubmission {
  id: string;
  workspace: string;
  formId: string;
  contactId: string;
  answers: Record<string, string>;
  at: string;
  /** Page the form was embedded on, if the browser sent it. */
  referrer?: string;
}

/* ---------------- Calendars ---------------- */

export interface TimeRange {
  start: string; // "09:00"
  end: string; // "17:00"
}

export interface Calendar {
  id: string;
  workspace: string;
  name: string;
  description?: string;
  durationMin: number;
  bufferMin: number;
  /** IANA zone the availability is expressed in, e.g. "Europe/Moscow". */
  timezone: string;
  /** Weekly hours keyed by weekday 0 (Sunday) to 6 (Saturday). */
  availability: Record<string, TimeRange[]>;
  minNoticeHours: number;
  horizonDays: number;
  ownerCid: string;
  tags: string[];
  active: boolean;
  createdAt: string;
}

export interface Appointment {
  id: string;
  workspace: string;
  calendarId: string;
  contactId: string;
  start: string; // ISO UTC
  end: string; // ISO UTC
  status: "booked" | "cancelled";
  notes?: string;
  createdAt: string;
  activityId?: string;
}

/* ---------------- Automations ---------------- */

export type TriggerType = "contact.created" | "tag.added" | "form.submitted" | "appointment.booked" | "deal.stage_changed";

/** Events that start automations. `depth` counts how many automations led to it (loop guard). */
export type GrowthEvent = (
  | { type: "contact.created"; contactId: string }
  | { type: "tag.added"; contactId: string; tag: string }
  | { type: "form.submitted"; contactId: string; formId: string }
  | { type: "appointment.booked"; contactId: string; calendarId: string; appointmentId: string }
  | { type: "deal.stage_changed"; dealId: string; toStage: string }
) & { depth?: number };

export interface Trigger {
  type: TriggerType;
  /** Narrow the trigger: a tag, a form, a calendar, or a target stage. */
  tag?: string;
  formId?: string;
  calendarId?: string;
  toStage?: string;
}

export type WorkflowStep =
  | { type: "add_tag"; tag: string }
  | { type: "remove_tag"; tag: string }
  | { type: "create_task"; summary: string; dueInDays?: number }
  | { type: "move_deal"; stage: string }
  | { type: "send_email"; subject: string; body: string }
  | { type: "send_sms"; body: string }
  | { type: "wait"; minutes: number }
  | { type: "note"; text: string };

export interface Workflow {
  id: string;
  workspace: string;
  name: string;
  active: boolean;
  trigger: Trigger;
  steps: WorkflowStep[];
  createdAt: string;
  updatedAt: string;
  stats: { started: number; completed: number; failed: number };
}

export interface WorkflowJob {
  id: string;
  workspace: string;
  workflowId: string;
  /** Next step to run. */
  stepIndex: number;
  runAt: string;
  contactId?: string;
  dealId?: string;
  /** How many automations led to the event that started this job (loop guard). */
  depth?: number;
  status: "waiting" | "done" | "failed" | "cancelled";
  log: { at: string; step: string; result: string }[];
  createdAt: string;
}

/* ---------------- Conversations ---------------- */

export type Channel = "email" | "sms" | "note";

export interface Message {
  id: string;
  workspace: string;
  contactId: string;
  channel: Channel;
  direction: "out" | "in";
  subject?: string;
  body: string;
  /** sent = handed to the provider; draft = saved only (no provider connected); failed = provider refused. */
  status: "sent" | "draft" | "failed" | "received";
  provider?: string;
  providerId?: string;
  error?: string;
  at: string;
  /** CID of the person, or "automation:<id>". */
  by: string;
  read?: boolean;
}
