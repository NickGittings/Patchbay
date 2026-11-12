const paths: Record<string, string> = {
  branch:
    'M6 7v10 M9 19a3 3 0 1 1-6 0 3 3 0 0 1 6 0 M9 4a3 3 0 1 1-6 0 3 3 0 0 1 6 0 M6 13h7a5 5 0 0 0 5-5 M21 5a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9 M10 21h4',
  error: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 7v6 M12 17h.01',
  success: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 m-5 9 3 3 7-7',
  needsInput: 'M4 4h16v12H9l-5 4Z M12 7v4 M12 14h.01',
  finished: 'm4 12 5 5L20 6',
  warning: 'm12 3 10 18H2Z M12 9v5 M12 17h.01',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 11v6 M12 7h.01',
  project: 'M3 7V5h6l2 2h10v13H3Z',
  worktree: 'M6 6v12m0-6h7a5 5 0 0 0 5-5V6 M4 3h4v4H4Z M4 17h4v4H4Z M16 3h4v4h-4Z',
  navigation: 'M4 4h6v6H4Z M14 14h6v6h-6Z M7 10v7h7 M10 7h7v7',
  plan: 'M8 5h12 M8 12h12 M8 19h12 M3 5h1 M3 12h1 M3 19h1',
  implementation: 'm4 6 4 6-4 6 M11 18h9',
  review: 'm4 12 5 5L20 6',
  chat: 'M4 4h16v12H9l-5 4Z M8 8h8 M8 12h5',
  auto: 'M19 8a8 8 0 1 0 1 8 M19 3v6h-6 M12 8v4l3 2',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  stack: 'm12 3 9 5-9 5-9-5Z M3 13l9 5 9-5 M3 17l9 5 9-5',
  usage: 'M4 18a9 9 0 1 1 16 0 M12 13l5-5 M6 18h12 M5 10l2 1 M12 4v3 M19 10l-2 1',
  sessions: 'M3 4h18v16H3Z M3 9h18 M8 9v11',
  settings: 'M9 3h6l1 4 4 1v8l-4 1-1 4H9l-1-4-4-1V8l4-1Z M9 12a3 3 0 1 0 6 0 3 3 0 0 0-6 0',
  tests: 'M9 3h6 M10 3v6l-6 10a1 1 0 0 0 1 2h14a1 1 0 0 0 1-2L14 9V3 M7 15h10',
  issues: 'm12 3 10 18H2Z M12 9v5 M12 17h.01',
  changes: 'M14 3H5v18h14V8Z M14 3v5h5 M8 12h8 M8 16h5',
  running: 'M3 4h18v16H3Z m4 4 4 4-4 4 M13 16h4',
}
export default function RailIcon({ name }: { name: string }) {
  return (
    <svg
      aria-hidden="true"
      width="21"
      height="21"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[name]} />
    </svg>
  )
}
