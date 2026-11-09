export const ME = {
  name: "Alex Reid",
  email: "alex@cumuluscloud.app",
  cid: "cid:alex",
  plan: "Free",
  quotaGb: 15,
} as const;

export type Person = { name: string; email: string };

export type FolderId = "inbox" | "sent" | "drafts" | "archive" | "trash";

export type BoxId = FolderId | "starred" | "outbox" | "snoozed" | "scheduled";

export type RuleAction = "star" | "archive" | "label";

export type MailRule = {
  id: string;
  from: string;
  action: RuleAction;
  label?: string;
};

/** A file on a message. `id` is its key in Cumulus file storage (absent on old, name-only entries). */
export type Attachment = { name: string; size: number; id?: string; type?: string };

export type DeliveryHop = {
  email: string;
  status: "inside" | "outbound" | "bounced";
  detail: string;
};

export type MailMessage = {
  id: string;
  threadId: string;
  folder: FolderId;
  from: Person;
  to: Person[];
  cc: Person[];
  subject: string;
  body: string;
  at: string;
  unread: boolean;
  starred: boolean;
  labels: string[];
  attachments?: Attachment[];
  /** Where each recipient's copy went: inside Cumulus, out to the relay, or bounced. */
  delivery?: DeliveryHop[];
  snoozeUntil?: string;
  /** Drafts only: send this on its own at this time (Schedule send). */
  sendAt?: string;
  /** FIRM Wallet payment sent with this message (pay by mail). */
  payment?: MailPayment;
  /** Sent by a Cumulus product (security notice, Cloud share, wallet receipt). */
  system?: string;
  /** Came through the Cumulus Tunnel: sealed to the recipient, signed by the sender's Cumulus://ID. */
  tunnel?: { verified: boolean; fingerprint: string };
  /** At rest only: content that couldn't be opened with this server's keys. */
  locked?: boolean;
};

export type MailPayment = {
  asset: string;
  amount: string;
  txId: string;
  ledgerHash?: string;
};

export type ArchitectTask = {
  id: string;
  title: string;
  detail: string;
  done: boolean;
  messageId?: string;
};

export type Contact = {
  id: string;
  name: string;
  email: string;
  org: string;
  note: string;
};

export type CalEvent = {
  id: string;
  title: string;
  whenLabel: string;
  where: string;
  with: string;
  sort: string;
};

export type ViewId = "mail" | "calendar" | "contacts" | "tasks";

const alex: Person = { name: ME.name, email: ME.email };

export const SEED_MESSAGES: MailMessage[] = [
  {
    id: "m-pipe-1",
    threadId: "th-pipe",
    folder: "inbox",
    from: { name: "Mira Chen", email: "mira.chen@cumuluscloud.app" },
    to: [alex],
    cc: [],
    subject: "VYRAL London — hold the forecast",
    body: "Alex,\n\nHolding the Q4 forecast on VYRAL as you asked. Win probability is still 62%, explained mostly by the open security review, not by budget.\n\nNext best action has not changed: send the security appendix before Thursday’s call. Architect already logged it and is waiting on you.\n\nBuying committee is one seat short. We still do not have their comms lead in the room. Priya can bring them if the appendix is in their hands first.\n\nMira\nSpectre · account team",
    at: "2026-11-05T12:40:00.000Z",
    unread: true,
    starred: true,
    labels: ["Spectre"],
  },
  {
    id: "m-pipe-2",
    threadId: "th-pipe",
    folder: "sent",
    from: alex,
    to: [{ name: "Mira Chen", email: "mira.chen@cumuluscloud.app" }],
    cc: [],
    subject: "Re: VYRAL London — hold the forecast",
    body: "Mira,\n\nHold the forecast. I will send the appendix before the Thursday call. Do not move stage until Priya confirms the comms lead has it.\n\nAlex",
    at: "2026-11-04T18:22:00.000Z",
    unread: false,
    starred: false,
    labels: ["Spectre"],
  },
  {
    id: "m-pipe-3",
    threadId: "th-pipe",
    folder: "inbox",
    from: { name: "Mira Chen", email: "mira.chen@cumuluscloud.app" },
    to: [alex],
    cc: [{ name: "Jordan Hale", email: "jordan.hale@cumuluscloud.app" }],
    subject: "VYRAL London — Q4 account review",
    body: "Alex,\n\nSpectre finished the Q4 pass on VYRAL London.\n\nWin probability: 62%.\nWhy: security review is the only open objection. Budget and timeline are already agreed.\nRisk: the appendix is three days late against the date we gave Priya.\nForecast: leave it in Commit only after the appendix is sent. Until then it stays in Best case.\n\nWarmest path is still you → Priya Nair. No other path reaches their comms lead.\n\nMira",
    at: "2026-11-03T16:48:00.000Z",
    unread: false,
    starred: false,
    labels: ["Spectre"],
  },
  {
    id: "m-sec-1",
    threadId: "th-sec",
    folder: "inbox",
    from: { name: "CID Security", email: "security@cumuluscloud.app" },
    to: [alex],
    cc: [],
    subject: "New passkey on your Cumulus://ID",
    body: "A passkey was added to cid:alex.\n\nWhen: Thursday 5 Nov 2026, 08:02 UTC\nWhere: Washington, D.C.\nDevice: security key\n\nIf this was you, no action is required.\n\nIf this was not you, revoke the session from your Cumulus://ID and retire the passkey. Grants already recorded on Firmament Network stay in the audit log either way.\n\nCumulus://ID security\nThis mailbox is encrypted at rest. This notice was not used to profile you.",
    at: "2026-11-05T08:05:00.000Z",
    unread: true,
    starred: false,
    labels: ["CID"],
  },
  {
    id: "m-scalvs-1",
    threadId: "th-scalvs",
    folder: "inbox",
    from: { name: "SCALVS", email: "scalvs@cumuluscloud.app" },
    to: [alex],
    cc: [],
    subject: "Three things need you",
    body: "Weekly run, finished Wednesday.\n\n14 tasks completed without you. 3 need a person:\n\n1. PRPGND deal has had no activity in 19 days. Spectre flagged it stale.\n2. VYRAL buying committee is missing the comms lead. Same gap Mira wrote about.\n3. Cumulus Drive folder “ODIN briefing” is inside the retention window you set. Leah’s note is the only file still inside it.\n\nNothing here was scanned for advertising. Ask for a brief on any thread and SCALVS will read only that thread.\n\nSCALVS.ai",
    at: "2026-11-04T09:14:00.000Z",
    unread: false,
    starred: false,
    labels: ["SCALVS"],
  },
  {
    id: "m-cond-1",
    threadId: "th-cond",
    folder: "inbox",
    from: { name: "Jordan Hale", email: "jordan.hale@cumuluscloud.app" },
    to: [alex],
    cc: [],
    subject: "Score 0.81 — security appendix for VYRAL",
    body: "Alex,\n\nArchitect scored “Send the security appendix to VYRAL London”.\n\nScore: 0.81\nIntent we read: you told Mira you would send it before Thursday’s call.\nEvidence: your sent note, Mira’s hold, Priya’s request to move the briefing to 15:00 ET.\nStatus: waiting on you. I will not send mail on your behalf.\n\nHand it back when the appendix is out and I will mark the task performed.\n\nJordan\n:\\ARCHITECT\\",
    at: "2026-11-05T11:05:00.000Z",
    unread: true,
    starred: false,
    labels: ["Architect"],
  },
  {
    id: "m-firm-1",
    threadId: "th-firm",
    folder: "inbox",
    from: { name: "Firmament Network", email: "ledger@cumuluscloud.app" },
    to: [alex],
    cc: [],
    subject: "Spectre can read your calendar — until you say otherwise",
    body: "A grant was recorded for cid:alex.\n\nApp: +SPCTR (Spectre)\nScope: calendar, read\nRecorded: Tuesday 3 Nov 2026\nLedger: Firmament Network, append-only\n\nSpectre can see event titles and times. It cannot see mail. You can revoke this from Cumulus://ID. Revocation is also written to the ledger. The earlier grant stays in the history.\n\nFirmament Network",
    at: "2026-11-03T13:11:00.000Z",
    unread: false,
    starred: false,
    labels: ["Firmament"],
  },
  {
    id: "m-leah-1",
    threadId: "th-leah",
    folder: "inbox",
    from: { name: "Leah Okonkwo", email: "leah@cumuluscloud.app" },
    to: [alex],
    cc: [],
    subject: "ODIN briefing notes are in Drive",
    body: "Alex,\n\nThe briefing notes are in the ODIN folder on Cumulus Drive, shared only with your CID.\n\nThis note is end-to-end between our Cumulus://Mail accounts. Please do not forward it outside Cumulus — a forward to VYRAL or PRPGND would leave the encrypted channel.\n\nRetention on that folder closes next week. If you still need the notes, say so and I will extend it.\n\nLeah",
    at: "2026-11-04T15:36:00.000Z",
    unread: false,
    starred: true,
    labels: ["Personal"],
  },
  {
    id: "m-ex-1",
    threadId: "th-ex",
    folder: "inbox",
    from: { name: "Data Exchange", email: "exchange@cumuluscloud.app" },
    to: [alex],
    cc: [],
    subject: "License settled — you keep 85%",
    body: "A dataset you opted in was licensed.\n\nSet: anonymized workflow timings\nBuyer: recorded on Firmament as a CDAT license\nGross: 240.00 USDC\nYour share: 85% · 204.00 USDC\nNetwork: Base\n\nPrivate mail and government workloads were not part of this set. You can turn the listing off from the Data Exchange. This sale stays in the ledger.\n\nCumulus Data Exchange",
    at: "2026-11-02T13:05:00.000Z",
    unread: false,
    starred: false,
    labels: ["Exchange"],
  },
  {
    id: "m-priya-1",
    threadId: "th-priya",
    folder: "inbox",
    from: { name: "Priya Nair", email: "priya@vyral.london" },
    to: [alex],
    cc: [],
    subject: "Thursday briefing — 15:00 ET?",
    body: "Alex,\n\nCan we move Thursday’s METATRON briefing to 15:00 ET? Our comms lead can join then, which I know your team has been asking for.\n\nIf 15:00 holds, send the security appendix ahead of the call so they can read it. A Cumulus calendar hold is fine.\n\nPriya Nair\nVYRAL London",
    at: "2026-11-05T10:18:00.000Z",
    unread: true,
    starred: false,
    labels: ["External"],
  },
  {
    id: "m-veil-1",
    threadId: "th-veil",
    folder: "inbox",
    from: { name: "VEIL", email: "veil@cumuluscloud.app" },
    to: [alex],
    cc: [],
    subject: "Your $VEIL statement",
    body: "November statement for cid:alex.\n\nAccrued this period: 128 $VEIL\nFrom: private browsing rewards in VEIL\nNot from: mail, Drive contents, or anything you did not opt into\n\nRewards can offset Infinitum service costs. They are not a payout of your mailbox. Mail is never mined for this.\n\nVEIL</>",
    at: "2026-11-01T11:20:00.000Z",
    unread: false,
    starred: false,
    labels: ["VEIL"],
  },
  {
    id: "m-draft-1",
    threadId: "th-priya",
    folder: "drafts",
    from: alex,
    to: [{ name: "Priya Nair", email: "priya@vyral.london" }],
    cc: [],
    subject: "Re: Thursday briefing — 15:00 ET?",
    body: "Priya,\n\n15:00 ET works. I will send a calendar hold and the security appendix before we start.\n\nAlex",
    at: "2026-11-05T12:55:00.000Z",
    unread: false,
    starred: false,
    labels: ["External"],
  },
  {
    id: "m-sent-1",
    threadId: "th-intro",
    folder: "sent",
    from: alex,
    to: [{ name: "Daniel Cho", email: "dcho@prpgnd.com" }],
    cc: [],
    subject: "Introduction — Cumulus for the DC studio",
    body: "Daniel,\n\nGood to meet you last week. Cumulus://Mail is the address I actually read: alex@cumuluscloud.app.\n\nI will send a short note on what we would run for PRPGND after Spectre clears the stale activity on your account. No deck until then.\n\nAlex Reid\nInfinitum",
    at: "2026-10-28T15:00:00.000Z",
    unread: false,
    starred: false,
    labels: ["External"],
  },
  {
    id: "m-trash-1",
    threadId: "th-trash",
    folder: "trash",
    from: { name: "FIRM Office", email: "office@cumuluscloud.app" },
    to: [alex],
    cc: [],
    subject: "Office hours you already declined",
    body: "This invitation was declined. It is kept in trash so the decline stays auditable.\n\nFIRM office hours · 28 Oct",
    at: "2026-10-27T15:00:00.000Z",
    unread: false,
    starred: false,
    labels: ["FIRM"],
  },
];

export const SEED_TASKS: ArchitectTask[] = [
  {
    id: "t1",
    title: "Send the security appendix to VYRAL",
    detail: "Score 0.81 · waiting on you · Thursday’s call",
    done: false,
    messageId: "m-cond-1",
  },
];

export const SEED_CONTACTS: Contact[] = [
  {
    id: "c-mira",
    name: "Mira Chen",
    email: "mira.chen@cumuluscloud.app",
    org: "Infinitum · Spectre",
    note: "Account team. Owns the VYRAL forecast.",
  },
  {
    id: "c-jordan",
    name: "Jordan Hale",
    email: "jordan.hale@cumuluscloud.app",
    org: "Infinitum · Architect",
    note: "Scores intent. Does not send mail for you.",
  },
  {
    id: "c-leah",
    name: "Leah Okonkwo",
    email: "leah@cumuluscloud.app",
    org: "Infinitum",
    note: "Drive shares stay inside Cumulus.",
  },
  {
    id: "c-priya",
    name: "Priya Nair",
    email: "priya@vyral.london",
    org: "VYRAL London",
    note: "External. Mail to this address is not end-to-end.",
  },
  {
    id: "c-daniel",
    name: "Daniel Cho",
    email: "dcho@prpgnd.com",
    org: "PRPGND · Washington",
    note: "Stale activity flagged by Spectre.",
  },
];

export const EVENTS: CalEvent[] = [
  {
    id: "e1",
    title: "METATRON briefing",
    whenLabel: "Thu 5 Nov · 15:00 ET",
    where: "Cumulus calendar hold · not confirmed",
    with: "Priya Nair, VYRAL comms lead",
    sort: "2026-11-05T20:00:00.000Z",
  },
  {
    id: "e2",
    title: "Pipeline review",
    whenLabel: "Fri 6 Nov · 15:00 UTC",
    where: "Spectre",
    with: "Mira Chen",
    sort: "2026-11-06T15:00:00.000Z",
  },
  {
    id: "e3",
    title: "Firmament audit window",
    whenLabel: "Mon 9 Nov · 14:00 UTC",
    where: "Ledger review",
    with: "Your CID only",
    sort: "2026-11-09T14:00:00.000Z",
  },
  {
    id: "e4",
    title: "Security appendix walkthrough",
    whenLabel: "Wed 12 Nov · 16:30 UTC",
    where: "Only if Thursday moves",
    with: "VYRAL London",
    sort: "2026-11-12T16:30:00.000Z",
  },
];

export const BOXES: { id: BoxId; label: string }[] = [
  { id: "inbox", label: "Inbox" },
  { id: "snoozed", label: "Snoozed" },
  { id: "scheduled", label: "Scheduled" },
  { id: "outbox", label: "Outbox" },
  { id: "starred", label: "Starred" },
  { id: "sent", label: "Sent" },
  { id: "drafts", label: "Drafts" },
  { id: "archive", label: "Archive" },
  { id: "trash", label: "Trash" },
];
