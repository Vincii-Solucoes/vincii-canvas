'use strict';
// Biblioteca de ícones dos hosts (SVG inline, monocromático — desenhado em branco
// sobre o avatar colorido). Tudo local: nada é carregado da rede (compatível com
// o CSP do modo desktop). Cada entrada: { label, cat, svg }.
// Chaves são slugs [a-z0-9-]; o servidor valida contra esse formato.

const HOST_ICONS = {
  // ----- Sistemas operacionais -----
  linux: {
    label: 'Linux (Tux)', cat: 'SO',
    svg: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2.6c-2.3 0-3.8 1.9-3.8 4.4 0 1 .2 1.7.2 2.4 0 .8-.5 1.5-1.2 2.5-.9 1.2-2 2.6-2.6 4-.5 1.1-.6 2.1-.2 2.7.3.5.9.6 1.5.5.3.6 1 1 1.9 1.2.9.2 1.5.2 2 .6.6.5 1.4.7 2.2.7s1.6-.2 2.2-.7c.5-.4 1.1-.4 2-.6.9-.2 1.6-.6 1.9-1.2.6.1 1.2 0 1.5-.5.4-.6.3-1.6-.2-2.7-.6-1.4-1.7-2.8-2.6-4-.7-1-1.2-1.7-1.2-2.5 0-.7.2-1.4.2-2.4 0-2.5-1.5-4.4-3.8-4.4Z"/>
      <ellipse cx="10.1" cy="7.2" rx="1.05" ry="1.35" fill="#0d1117"/>
      <ellipse cx="13.9" cy="7.2" rx="1.05" ry="1.35" fill="#0d1117"/>
      <circle cx="10.2" cy="7.5" r=".5" fill="#fff"/>
      <circle cx="13.8" cy="7.5" r=".5" fill="#fff"/>
      <path d="M12 8.2c-.9 0-1.7.6-1.7 1.1 0 .4.8.9 1.7.9s1.7-.5 1.7-.9c0-.5-.8-1.1-1.7-1.1Z" fill="#f9c513"/>
      <path d="M10 18.5c.6-1.2 3.4-1.2 4 0" fill="none" stroke="#0d1117" stroke-width="1.1" stroke-linecap="round"/>
      <path d="M8.7 20.6c-.5-.6-.4-1.7.3-2.4M15.3 20.6c.5-.6.4-1.7-.3-2.4" fill="#f9c513" stroke="#f9c513" stroke-width="1.4" stroke-linecap="round"/>
    </svg>`,
  },
  ubuntu: {
    label: 'Ubuntu', cat: 'SO',
    svg: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="12" cy="12" r="7.3" fill="none" stroke="currentColor" stroke-width="1.7"/>
      <circle cx="12" cy="4.9" r="2.2"/><circle cx="5.85" cy="15.4" r="2.2"/><circle cx="18.15" cy="15.4" r="2.2"/>
    </svg>`,
  },
  debian: {
    label: 'Debian', cat: 'SO',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
      <path d="M14.5 5.4a7.2 7.2 0 1 0 4.9 8.2"/>
      <path d="M14.2 8.5a4 4 0 1 0 2.3 5"/>
    </svg>`,
  },
  redhat: {
    label: 'Red Hat / Fedora', cat: 'SO',
    svg: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M3.8 14.8c2-1.1 5.2-1.8 8.2-1.8s6.2.7 8.2 1.8c.2 1.7-3.6 3.6-8.2 3.6s-8.4-1.9-8.2-3.6Z"/>
      <path d="M8.4 13.3c-.8-2.8-.1-5.6 2-6.9 1.2.7 1.1 2.2.6 3.3 1.5-1 3.5-1 4.9.2 1.1 1 1.6 2.3 1.8 3.5-2.7-.7-6.5-.8-9.3-.1Z"/>
    </svg>`,
  },
  windows: {
    label: 'Windows', cat: 'SO',
    svg: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="3.4" y="3.4" width="7.6" height="7.6" rx=".7"/><rect x="13" y="3.4" width="7.6" height="7.6" rx=".7"/>
      <rect x="3.4" y="13" width="7.6" height="7.6" rx=".7"/><rect x="13" y="13" width="7.6" height="7.6" rx=".7"/>
    </svg>`,
  },
  apple: {
    label: 'macOS / Apple', cat: 'SO',
    svg: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M16.7 12.7c0-2.1 1.6-3.1 1.7-3.2-1-1.4-2.4-1.6-2.9-1.6-1.2-.1-2.4.7-3 .7-.6 0-1.6-.7-2.7-.7-1.4 0-2.7.8-3.4 2.1-1.4 2.5-.4 6.2 1 8.2.7 1 1.4 2.1 2.5 2.1 1 0 1.4-.7 2.6-.7s1.5.7 2.6.6c1.1 0 1.7-1 2.4-2 .7-1.1 1-2.2 1-2.2s-1.9-.7-1.9-3.9Z"/>
      <path d="M14.4 6.3c.6-.7 1-1.7.9-2.7-.9 0-1.9.6-2.5 1.3-.5.6-1 1.6-.9 2.6 1 .1 2-.5 2.5-1.2Z"/>
    </svg>`,
  },
  freebsd: {
    label: 'BSD / Unix', cat: 'SO',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M6 4.5 8.5 7M18 4.5 15.5 7"/>
      <path d="M6.5 9.5c-1 2.4-1 5 .8 7 1.2 1.4 3 2.2 4.7 2.2s3.5-.8 4.7-2.2c1.8-2 1.8-4.6.8-7-1-2.3-3.2-3.5-5.5-3.5S7.5 7.2 6.5 9.5Z"/>
      <circle cx="10" cy="12" r=".9" fill="currentColor"/><circle cx="14" cy="12" r=".9" fill="currentColor"/>
    </svg>`,
  },

  // ----- Servidores / computação -----
  server: {
    label: 'Servidor', cat: 'Computação',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="7" rx="1.6"/><rect x="3" y="13" width="18" height="7" rx="1.6"/>
      <line x1="6.5" y1="7.5" x2="6.5" y2="7.5"/><line x1="6.5" y1="16.5" x2="6.5" y2="16.5"/>
      <line x1="15" y1="7.5" x2="18" y2="7.5"/><line x1="15" y1="16.5" x2="18" y2="16.5"/>
    </svg>`,
  },
  desktop: {
    label: 'Desktop', cat: 'Computação',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="12" rx="1.6"/><path d="M9 20h6M12 16v4"/>
    </svg>`,
  },
  laptop: {
    label: 'Notebook', cat: 'Computação',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="4" y="5" width="16" height="10" rx="1.4"/><path d="M2.5 18.5h19"/>
    </svg>`,
  },
  vm: {
    label: 'Máquina virtual', cat: 'Computação',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="14" height="11" rx="1.5"/><rect x="9" y="10" width="12" height="8" rx="1.5" fill="#0d1117"/>
      <path d="M13.2 12.5 16 14.9l2.6-3"/>
    </svg>`,
  },
  container: {
    label: 'Container', cat: 'Computação',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 2.7 20.5 7 20.5 17 12 21.3 3.5 17 3.5 7Z"/><path d="M3.5 7 12 11.5 20.5 7M12 11.5V21"/>
    </svg>`,
  },
  docker: {
    label: 'Docker', cat: 'Computação',
    svg: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6" y="9.3" width="2.5" height="2.4"/><rect x="9.1" y="9.3" width="2.5" height="2.4"/><rect x="12.2" y="9.3" width="2.5" height="2.4"/>
      <rect x="9.1" y="6.4" width="2.5" height="2.4"/><rect x="12.2" y="6.4" width="2.5" height="2.4"/>
      <path d="M3 12.6h16.2c.2 1.6-.5 3.3-2 4.4-1.3 1-3.2 1.5-5.2 1.5-3.6 0-6.9-1.8-8.4-4.6-.3-.5-.5-1-.6-1.3Z"/>
      <path d="M19.5 11.4c.7-.7 1.7-.8 2.4-.4-.2 1-1 1.6-1.9 1.6" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
    </svg>`,
  },
  kubernetes: {
    label: 'Kubernetes', cat: 'Computação',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">
      <path d="M12 2.8 19.4 6.4 17.6 14.4 12 18 6.4 14.4 4.6 6.4Z"/>
      <circle cx="12" cy="10.2" r="2.4"/>
      <path d="M12 3.4v4.4M12 12.6v4.8M9.8 11.4 6 13.6M14.2 11.4 18 13.6M10.1 8.7 6.6 6.6M13.9 8.7l3.5-2.1"/>
    </svg>`,
  },

  // ----- Rede -----
  router: {
    label: 'Roteador', cat: 'Rede',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="3" y="13" width="18" height="6.5" rx="1.6"/>
      <line x1="6.5" y1="16.2" x2="6.5" y2="16.2"/><line x1="10" y1="16.2" x2="14.5" y2="16.2"/>
      <path d="M8 13V6.5M16 13V6.5"/><path d="M6 5.2 8 6.5 10 5.2M14 5.2 16 6.5 18 5.2"/>
    </svg>`,
  },
  switch: {
    label: 'Switch', cat: 'Rede',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="2.5" y="8" width="19" height="8" rx="1.6"/>
      <path d="M5.5 11.3h2.6M9.7 11.3h2.6M13.9 11.3h2.6M5.5 13.3h13"/>
    </svg>`,
  },
  firewall: {
    label: 'Firewall', cat: 'Rede',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="3" y="5.5" width="18" height="13" rx="1.3"/>
      <path d="M3 10h18M3 14.5h18M8.5 5.5V10M15.5 5.5V10M6 10v4.5M12 10v4.5M18 10v4.5M9.5 14.5v4M14.5 14.5v4"/>
    </svg>`,
  },
  wifi: {
    label: 'Access point / Wi-Fi', cat: 'Rede',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M4.5 9.5a11 11 0 0 1 15 0M7.2 12.6a7 7 0 0 1 9.6 0M9.8 15.7a3.2 3.2 0 0 1 4.4 0"/>
      <circle cx="12" cy="18.6" r="1.1" fill="currentColor"/>
    </svg>`,
  },
  globe: {
    label: 'Web / Internet', cat: 'Rede',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.4 3.9 5.6 3.9 9S14.5 18.6 12 21c-2.5-2.4-3.9-5.6-3.9-9S9.5 5.4 12 3Z"/>
    </svg>`,
  },
  loadbalancer: {
    label: 'Load balancer / Proxy', cat: 'Rede',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="5" r="2.3"/><circle cx="4.8" cy="19" r="2.3"/><circle cx="12" cy="19" r="2.3"/><circle cx="19.2" cy="19" r="2.3"/>
      <path d="M12 7.3v4M12 11.3H4.8v5.4M12 11.3v5.4M12 11.3h7.2v5.4"/>
    </svg>`,
  },

  // ----- Armazenamento / dados -----
  database: {
    label: 'Banco de dados', cat: 'Dados',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <ellipse cx="12" cy="5.8" rx="7" ry="3"/><path d="M5 5.8v12.4c0 1.7 3.1 3 7 3s7-1.3 7-3V5.8"/><path d="M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/>
    </svg>`,
  },
  storage: {
    label: 'Storage / NAS', cat: 'Dados',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="3.5" y="4.5" width="17" height="5.5" rx="1.4"/><rect x="3.5" y="12" width="17" height="5.5" rx="1.4"/>
      <circle cx="7" cy="7.2" r=".6" fill="currentColor"/><circle cx="7" cy="14.7" r=".6" fill="currentColor"/>
      <path d="M11 7.2h6M11 14.7h6"/>
    </svg>`,
  },
  cloud: {
    label: 'Nuvem', cat: 'Dados',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M7 18.5h10a4 4 0 0 0 .6-8 6 6 0 0 0-11.6 1.4A3.6 3.6 0 0 0 7 18.5Z"/>
    </svg>`,
  },

  // ----- Genéricos / função -----
  terminal: {
    label: 'Terminal / Shell', cat: 'Outros',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M7 9.5 10 12l-3 2.5M12.5 15h4.5"/>
    </svg>`,
  },
  shield: {
    label: 'Segurança', cat: 'Outros',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 3 5 6v5c0 4.4 3 7.6 7 9 4-1.4 7-4.6 7-9V6Z"/><path d="M9 12l2 2 4-4"/>
    </svg>`,
  },
  raspberry: {
    label: 'Raspberry Pi', cat: 'Outros',
    svg: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M9.3 4.6c1 .5 1.8 1.3 2.2 2.4.5-1.3 1.4-2.2 2.6-2.6 1.3-.2 1.8.8 1.3 1.8-.4.8-1.2 1.3-2 1.5 1 .3 1.9.9 2.4 1.8.6-.2 1.6-.3 2.1.5.5.9-.1 1.8-1 2 .2.8 0 1.7-.5 2.4-1 1.6-2.9 2.7-4.9 2.9v1.9h-2v-1.9c-2-.2-3.9-1.3-4.9-2.9-.5-.7-.7-1.6-.5-2.4-.9-.2-1.5-1.1-1-2 .5-.8 1.5-.7 2.1-.5.5-.9 1.4-1.5 2.4-1.8-.8-.2-1.6-.7-2-1.5-.5-1 0-2 1.6-1.6Z"/>
    </svg>`,
  },
  question: {
    label: 'Genérico', cat: 'Outros',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.2 2.4c-.7.3-1.2.9-1.2 1.6v.3"/><circle cx="11.5" cy="16.4" r="1" fill="currentColor"/>
    </svg>`,
  },
};

// Paleta de cores para o avatar (matiz HSL; saturação/brilho fixos no makeAvatar).
// '' (vazio) = automática, derivada do nome do host.
const HOST_COLORS = {
  teal: 172, cyan: 190, blue: 212, indigo: 246, violet: 278,
  magenta: 322, red: 356, orange: 26, amber: 44, green: 145,
};

if (typeof window !== 'undefined') { window.HOST_ICONS = HOST_ICONS; window.HOST_COLORS = HOST_COLORS; }
