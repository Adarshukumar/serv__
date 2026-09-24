/** Tiny inline icon set — no icon dependency, no font loading. */

const base = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
}

export const SendIcon = (p) => (
  <svg {...base} {...p}>
    <path d="M4.5 12h13" />
    <path d="M12.5 6.5 19 12l-6.5 5.5" />
  </svg>
)

export const StopIcon = (p) => (
  <svg {...base} {...p}>
    <rect x="7" y="7" width="10" height="10" rx="2.2" fill="currentColor" stroke="none" />
  </svg>
)

export const PlusIcon = (p) => (
  <svg {...base} {...p}>
    <path d="M12 5v14M5 12h14" />
  </svg>
)

export const TrashIcon = (p) => (
  <svg {...base} {...p}>
    <path d="M4 7h16M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7" />
    <path d="M6.5 7l.8 12A1.8 1.8 0 0 0 9.1 20.7h5.8a1.8 1.8 0 0 0 1.8-1.7L17.5 7" />
    <path d="M10.5 11v6M13.5 11v6" />
  </svg>
)

export const CopyIcon = (p) => (
  <svg {...base} {...p}>
    <rect x="9" y="9" width="11" height="11" rx="2.4" />
    <path d="M15 6.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h.5" />
  </svg>
)

export const CheckIcon = (p) => (
  <svg {...base} {...p}>
    <path d="M5 13l4.2 4.2L19 7.5" />
  </svg>
)

export const RefreshIcon = (p) => (
  <svg {...base} {...p}>
    <path d="M20 11.5A8 8 0 0 0 6.3 6.3L4 8.5" />
    <path d="M4 4.5v4h4" />
    <path d="M4 12.5A8 8 0 0 0 17.7 17.7L20 15.5" />
    <path d="M20 19.5v-4h-4" />
  </svg>
)

export const GearIcon = (p) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M12 3.5v2M12 18.5v2M4.9 7.4l1.7 1M17.4 15.6l1.7 1M4.9 16.6l1.7-1M17.4 8.4l1.7-1" />
  </svg>
)

export const PulseIcon = (p) => (
  <svg {...base} {...p}>
    <path d="M3 12h3.2l2-5.5 3 11L14 12h7" />
  </svg>
)

export const CloseIcon = (p) => (
  <svg {...base} {...p}>
    <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
  </svg>
)

export const DownloadIcon = (p) => (
  <svg {...base} {...p}>
    <path d="M12 4.5v10" />
    <path d="M7.8 10.5 12 14.7l4.2-4.2" />
    <path d="M5 19.5h14" />
  </svg>
)

export const BrainIcon = (p) => (
  <svg {...base} {...p}>
    <path d="M9.5 5.2A2.7 2.7 0 0 0 6.8 8a2.6 2.6 0 0 0-1.6 4.6A2.7 2.7 0 0 0 7 17.4h1.3a1.2 1.2 0 0 0 1.2-1.2V6.4a1.2 1.2 0 0 0-1.2-1.2Z" />
    <path d="M14.5 5.2A2.7 2.7 0 0 1 17.2 8a2.6 2.6 0 0 1 1.6 4.6 2.7 2.7 0 0 1-1.8 4.8h-1.3a1.2 1.2 0 0 1-1.2-1.2V6.4a1.2 1.2 0 0 1 1.2-1.2Z" />
  </svg>
)

export const SparkIcon = (p) => (
  <svg {...base} {...p}>
    <path d="M12 3.5l1.6 4.6L18 9.7l-4.4 1.6L12 15.9l-1.6-4.6L6 9.7l4.4-1.6Z" />
    <path d="M18.5 15.5l.7 1.9 1.8.7-1.8.7-.7 1.9-.7-1.9-1.8-.7 1.8-.7Z" />
  </svg>
)

export const LinkIcon = (p) => (
  <svg {...base} {...p}>
    <path d="M10.5 13.5l3-3" />
    <path d="M8.8 15.2 7.3 16.7a2.9 2.9 0 0 1-4.1-4.1l2.4-2.4a2.9 2.9 0 0 1 4.1 0" />
    <path d="M15.2 8.8l1.5-1.5a2.9 2.9 0 0 1 4.1 4.1l-2.4 2.4a2.9 2.9 0 0 1-4.1 0" />
  </svg>
)
