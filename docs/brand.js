/**
 * Brand presets, switchable in Settings (admin only) and stored server-side so
 * every manager's phone picks up the change.
 */
export const BRANDS = {
  noodles: {
    id: 'noodles',
    name: 'Noodles <span class="brand-amp">&</span> Company',
    plainName: 'Noodles & Company',
    tagline: 'Manager Accountability',
    accent: '#c9a96e',
    accentDark: '#b98860',
    primary: '#1a1a1a',
    surface: '#faf8f5',
    surfaceAlt: '#f0ede6',
  },
  generic: {
    id: 'generic',
    name: 'Manager Accountability',
    plainName: 'Manager Accountability',
    tagline: 'Shift accountability',
    accent: '#c9a96e',
    accentDark: '#b98860',
    primary: '#1a1a1a',
    surface: '#faf8f5',
    surfaceAlt: '#f0ede6',
  },
};

export const DEFAULT_BRAND = 'noodles';

export function applyBrand(brandId) {
  const brand = BRANDS[brandId] || BRANDS[DEFAULT_BRAND];
  const root = document.documentElement;
  root.style.setProperty('--accent', brand.accent);
  root.style.setProperty('--accent-dark', brand.accentDark);
  root.style.setProperty('--primary', brand.primary);
  root.style.setProperty('--surface', brand.surface);
  root.style.setProperty('--surface-alt', brand.surfaceAlt);
  document.title = `${brand.plainName} — ${brand.tagline}`;
  document.querySelectorAll('[data-brand-name]').forEach((node) => {
    node.innerHTML = brand.name;
  });
  document.querySelectorAll('[data-brand-tagline]').forEach((node) => {
    node.textContent = brand.tagline;
  });
  return brand;
}
