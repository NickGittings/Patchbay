const paths: Record<string, string> = {
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
