/**
 * Every list here is the verbatim content extracted from the Base44 app.
 * Admin can override wording in-app (stored in settings), so edit there rather
 * than here unless you are changing the shipped default.
 */

export const MORNING_TASKS = [
  'Turn on equipment at the right temp with coolers on.',
  'Turn on water to the steam table, pasta cooker, noodle sinks. (Hint: turn off water after use.)',
  'Turn on dishwasher, fill up dish pit sinks for here bowls.',
  'Check email daily, journal book, snap picture.',
  'Do deployment sheet, snap photo.',
  'Make sure noodles will be done by 10:30.',
  'Count drawer, and put drawer in register.',
  'Tea, rugs, and sanitary buckets.',
  'Shift ready sheets done.',
  'Check all stations have correct items and ready to serve.',
  'Lead shift rally and assign cleaning tasks.',
  'Pasta cooker cleaned, Noodle sinks cleaned.',
  'Put daily op goals on chart.',
  'Check prep date outs on the line items.',
  'Flip everything at 1:30 that is online.',
  "Review team members' routines to make sure everybody is on track.",
  'Do PM/night prep sheet.',
  'Run to bank do change out.',
  'Change sanitary buckets.',
  'Do shift ready sheets before 3pm.',
  'Leave notes for a general manager if necessary.',
  'Before leaving count drawer.',
  'Make sure a truck is put away on Tuesday and Friday.',
];

export const NIGHT_TASKS = [
  'Check email, look for catering orders, put in calendar if there are any.',
  'Print off all documents.',
  'Talk to morning manager, how today went.',
  'Check all stations are filled and in good condition.',
  'Check prep sheet.',
  'Look at deployment sheet, make game plan for night shift.',
  "Pick cleaning tasks from on track through the table and/or the app that's on the phone and upload photo.",
  'Do routine cleaning: lanes, walls, check restrooms, windows/all glass, restock lids, bowls, cups.',
  'Ready for dinner rush.',
  'Do slack racks.',
  'Get everybody on break.',
  'Pre-close following routine sheet.',
  'Make sure people are wiping out bottom of coolers.',
  'Walk through line, pull out everything that could be flipped.',
  'Do the prep sheet. Count everything on hand. Do the predicted for the next day. Now we are on point.',
  'Check shift ready sheets.',
  'Help fill up mop bucket, help make sure crew stay on track.',
  "Check where everybody's at on routine sheet and help ensure everyone gets out at the same time.",
  'Lock front door.',
  'Close all open checks on register.',
  'Plug in iPad.',
  'Count main drawer at 10:30 and do deposit.',
  'When done, follow up with crew to ensure everyone will get out on time.',
  'When everybody has one item left, double-check key things: steamers done, front of house change, mop water twice, everything put away.',
  'Do KPI when everybody is leaving.',
  'Enter in waste.',
  'Walk around kitchen. Ensure everything is the way it needs to be in order for morning crew to succeed.',
  'Leave notes to the manager if necessary.',
  'Check make sure everyone clocked out.',
  'Make sure all red buckets are in the back, rigs hung up and put away.',
];

export const NON_NEGOTIABLES = [
  'Prep N Pull: ALL on-hands must be recorded in AM and PM (Mid Shift). Keep last 7 days on file.',
  'Cooling log must be completely filled out daily.',
  'Noodle Cooking log must be 100% completed daily.',
  "Daily Journey book must be completed daily (Big Bucket Item). Draw a line through any ICIMS or Workday items — those don't apply to us.",
  'A checkmark is NOT sufficient — the manager in charge must record their initials.',
  'MOD Tasks require attention from BOTH Opening MOD and Closing MOD.',
  'Employee Illness tracking sheets must be updated as needed at end of each period.',
  'BI-Weekly Management Meeting Agendas must be completed and communicated to junior management. If unable to hold a meeting, cover it in one-on-ones. Initials of each management person should verify it was covered.',
];

export const AUDIT_ITEMS = [
  'Personal hygiene observed (clean uniform, hair restrained)',
  'Proper handwashing technique followed',
  'No bare-hand contact with ready-to-eat foods',
  'Food stored at correct temperatures',
  'Hot foods held above 135°F / 57°C',
  'Cold foods held below 41°F / 5°C',
  'Proper date labeling on all items',
  'FIFO (first in, first out) rotation in use',
  'Raw proteins stored below ready-to-eat foods',
  'Separate cutting boards used for different food types',
  'Sanitizer buckets available and at correct concentration',
  'Food contact surfaces cleaned and sanitized',
  'No signs of pest activity observed',
  'Allergen awareness demonstrated',
  'Proper glove use when handling food',
  'Thermometer calibrated and available',
  'Cooling logs completed correctly',
  'Prep logs completed correctly',
];

export const VIDEO_SECTIONS = [
  { key: 'cash_drawers', title: 'How to Do Cash Drawers', slots: 2 },
  { key: 'kpi', title: 'How to Do KPI', slots: 1 },
];

export const URGENCY = [
  { value: '1', label: '1 — Most Urgent', tone: 'bad' },
  { value: '2', label: '2 — Medium Urgent', tone: 'warn' },
  { value: '3', label: '3 — Low Urgent', tone: 'ok' },
];

export const DEFAULT_COMPLETION_MESSAGES = {
  morning: 'Good work this morning!:)',
  night: 'Good job tonight. Keep it up!',
};

export const SHIFT_BANNER = '🔴 TOP PRIORITY: Rollout videos must be completed by all crew members';

export function tasksFor(shiftType) {
  return shiftType === 'morning' ? MORNING_TASKS : NIGHT_TASKS;
}
