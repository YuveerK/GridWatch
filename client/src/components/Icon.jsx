const PATHS = {
  map: 'M9 4 3 6.5v13L9 17l6 3 6-2.5v-13L15 7 9 4ZM9 4v13M15 7v13',
  bolt: 'M13 2 4 14h7l-1 8 9-12h-7l1-8Z',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM21 21l-4.3-4.3',
  alert: 'M12 3 2 20h20L12 3ZM12 10v4M12 17.5v.01',
  half: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 3v18M12 3a9 9 0 0 1 0 18',
  check: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM8 12.5l2.7 2.7L16 9.5',
  calendar: 'M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1ZM4 10h16M8 3v4M16 3v4',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 7.5V12l3 2',
  archive: 'M4 5h16v4H4zM5.5 9v9a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V9M10 13h4',
  x: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM9 9l6 6M15 9l-6 6',
  star: 'm12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8L12 3.5Z',
  pin: 'M12 21s-6-5.6-6-10.5a6 6 0 1 1 12 0C18 15.4 12 21 12 21ZM12 8.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z',
  chevron: 'm9 6 6 6-6 6',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  external: 'M14 4h6v6M20 4 10 14M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 11v5M12 7.5v.01',
  network: 'M12 4v5M12 9H5v4M12 9h7v4M5 13v0M5 13a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM19 13a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM12 3a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z',
  home: 'M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1v-8Z',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  wrench: 'M14.7 6.3a4 4 0 0 0-5 5L3.5 17.5a1.5 1.5 0 0 0 2 2l6.2-6.2a4 4 0 0 0 5-5l-2.5 2.5-2-.5-.5-2 2.5-2.5Z',
  phone: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a1 1 0 0 1-1 1A15 15 0 0 1 4 5a1 1 0 0 1 1-1Z',
  close: 'M6 6l12 12M18 6 6 18',
  plug: 'M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0V8ZM12 17v4',
  refresh: 'M20 11a8 8 0 0 0-14.9-3M4 4v4h4M4 13a8 8 0 0 0 14.9 3M20 20v-4h-4',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12ZM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z',
};

export default function Icon({ name, className = '', title }) {
  return (
    <svg className={`icon ${className}`} viewBox="0 0 24 24" aria-hidden={title ? undefined : 'true'} role={title ? 'img' : undefined} aria-label={title}>
      <path d={PATHS[name] ?? PATHS.info} />
    </svg>
  );
}
