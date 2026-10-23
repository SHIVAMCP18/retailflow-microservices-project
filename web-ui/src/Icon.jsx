import React from 'react';

// Small stroke icons (24x24 grid) so the UI doesn't depend on emoji or an icon font.
const PATHS = {
  shop: 'M6 7h12l-1 13H7L6 7Zm3 0a3 3 0 0 1 6 0',
  orders: 'M4 7l8-4 8 4-8 4-8-4Zm0 0v10l8 4m-8-14 8 4m8-4v10l-8 4m0-10v10',
  invoice: 'M7 3h10v18l-2.5-1.5L12 21l-2.5-1.5L7 21V3Zm3 5h4m-4 4h4m-4 4h2',
  bell: 'M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16Zm4 4a2 2 0 0 0 4 0',
  admin: 'M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6l7-3Z',
  system: 'M4 5h7v6H4V5Zm9 0h7v6h-7V5ZM4 13h7v6H4v-6Zm9 3h7m-3.5-3.5v7',
  logout: 'M14 4h5v16h-5M10 8l-4 4 4 4m-4-4h11',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6',
  arrowLeft: 'M19 12H5m6-6-6 6 6 6',
  external: 'M14 4h6v6m0-6-9 9M18 14v6H4V6h6'
};

export default function Icon({ name, size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}
