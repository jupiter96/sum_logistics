'use strict';

/**
 * Navy theme colour map.
 *
 * The console's accent colour comes from Tailwind's `blue` and `sky` scales. Those
 * classes are compiled inside ember-ui and every engine with ember-ui's own Tailwind
 * config, so the console's tailwind.config.js cannot recolour them. Instead, every
 * blue/sky shade in the built CSS is rewritten to the matching navy shade
 * (blue-500 -> navy-500, sky-600 -> navy-600, ...).
 *
 * To adjust the theme, edit NAVY. Keep 500/600 dark enough for white text and
 * 100-400 light enough for text on dark-mode backgrounds (tests/node/navy-theme-test.cjs).
 */

const NAVY = {
    50: '#f2f5fb',
    100: '#e2e9f5',
    200: '#c4d3eb',
    300: '#9db4db',
    400: '#7392c7',
    500: '#2a4a8a',
    600: '#1f3d78',
    700: '#193264',
    800: '#142851',
    900: '#0f1f3f',
    950: '#0a152c',
};

const SOURCE_PALETTES = {
    // Tailwind's default `blue`.
    blue: {
        50: '#eff6ff',
        100: '#dbeafe',
        200: '#bfdbfe',
        300: '#93c5fd',
        400: '#60a5fa',
        500: '#3b82f6',
        600: '#2563eb',
        700: '#1d4ed8',
        800: '#1e40af',
        900: '#1e3a8a',
        950: '#172554',
    },
    // The console's `sky` (ember-ui's Tailwind config overrides 100-900; 50 and 950 are Tailwind's).
    sky: {
        50: '#f0f9ff',
        100: '#e6f0fb',
        200: '#bad5f5',
        300: '#8dbbef',
        400: '#61a0e8',
        500: '#3485e2',
        600: '#1c6cc7',
        700: '#16539a',
        800: '#103b6d',
        900: '#092341',
        950: '#082f49',
    },
    // Tailwind's default `sky`, for any bundle compiled without the override above.
    tailwindSky: {
        100: '#e0f2fe',
        200: '#bae6fd',
        300: '#7dd3fc',
        400: '#38bdf8',
        500: '#0ea5e9',
        600: '#0284c7',
        700: '#0369a1',
        800: '#075985',
        900: '#0c4a6e',
    },
};

const strip = (hex) => hex.slice(1).toLowerCase();

const COLOR_MAP = new Map(Object.values(SOURCE_PALETTES).flatMap((palette) => Object.entries(palette).map(([shade, hex]) => [strip(hex), strip(NAVY[shade])])));

// `#3b82f6`, `#3b82f680` and the URL-encoded `%233b82f6` used inside SVG data URIs.
const HEX = /(#|%23)([0-9a-f]{6})([0-9a-f]{2})?(?![0-9a-f])/gi;
// The red, green and blue channels of `rgb(59 130 246 / 0.5)` or `rgba(59,130,246,.5)`.
const RGB = /(rgba?\(\s*)(\d{1,3})(\s*,\s*|\s+)(\d{1,3})(\s*,\s*|\s+)(\d{1,3})(?=\s*[,/)])/gi;

const toHex = (...channels) => channels.map((value) => Number(value).toString(16).padStart(2, '0')).join('');
const toChannels = (hex) => [0, 2, 4].map((index) => parseInt(hex.slice(index, index + 2), 16));

function remapCss(css) {
    return css
        .replace(HEX, (match, prefix, hex, alpha = '') => {
            const target = COLOR_MAP.get(hex.toLowerCase());
            return target ? `${prefix}${target}${alpha}` : match;
        })
        .replace(RGB, (match, open, red, sep1, green, sep2, blue) => {
            const target = COLOR_MAP.get(toHex(red, green, blue));
            if (!target) {
                return match;
            }
            const [r, g, b] = toChannels(target);
            return `${open}${r}${sep1}${g}${sep2}${b}`;
        });
}

module.exports = { NAVY, SOURCE_PALETTES, remapCss };
