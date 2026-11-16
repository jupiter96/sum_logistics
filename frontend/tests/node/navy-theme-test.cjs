'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { NAVY, SOURCE_PALETTES, remapCss } = require('../../lib/navy-theme/remap');

const rgb = (hex) => [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));

function luminance(hex) {
    const [r, g, b] = rgb(hex).map((value) => {
        const channel = value / 255;
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
    const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (light + 0.05) / (dark + 0.05);
}

test('every blue and sky shade becomes the navy shade of the same step', () => {
    for (const palette of Object.values(SOURCE_PALETTES)) {
        for (const [shade, hex] of Object.entries(palette)) {
            assert.equal(remapCss(`a{color:${hex}}`), `a{color:${NAVY[shade]}}`, `${hex} -> navy-${shade}`);
        }
    }
});

test('rewrites the colour forms Tailwind and minifiers emit', () => {
    const [r, g, b] = rgb(NAVY[500]);
    const cases = [
        [
            '.bg-blue-500{--tw-bg-opacity:1;background-color:rgb(59 130 246 / var(--tw-bg-opacity))}',
            `.bg-blue-500{--tw-bg-opacity:1;background-color:rgb(${r} ${g} ${b} / var(--tw-bg-opacity))}`,
        ],
        ['a{color:rgb(59 130 246/var(--tw-text-opacity))}', `a{color:rgb(${r} ${g} ${b}/var(--tw-text-opacity))}`],
        ['a{color:rgba(59,130,246,.5)}', `a{color:rgba(${r},${g},${b},.5)}`],
        ['a{color:rgba( 59 , 130 , 246 , 1 )}', `a{color:rgba( ${r} , ${g} , ${b} , 1 )}`],
        ['a{color:rgb(59, 130, 246)}', `a{color:rgb(${r}, ${g}, ${b})}`],
        ['a{color:#3B82F6}', `a{color:${NAVY[500]}}`],
        ['a{color:#3b82f680}', `a{color:${NAVY[500]}80}`],
        ['a{background-image:url("data:image/svg+xml,%3csvg fill=\'%233b82f6\'/%3e")}', `a{background-image:url("data:image/svg+xml,%3csvg fill='%23${NAVY[500].slice(1)}'/%3e")}`],
        ['.btn-primary{background-color:#3485e2;border-color:#1c6cc7}', `.btn-primary{background-color:${NAVY[500]};border-color:${NAVY[600]}}`],
    ];

    for (const [input, expected] of cases) {
        assert.equal(remapCss(input), expected);
    }
});

test('leaves other colours and look-alike values untouched', () => {
    const css = [
        '.gray{color:#374151;background:rgb(17 24 39 / 1)}',
        '.indigo{color:#6366f1;box-shadow:0 0 0 1px rgba(99, 102, 241, 0.18)}',
        '.near{color:#3b82f7;background:rgb(59 130 247)}',
        '.longer{color:#3b82f6ff1}',
        '.percent{color:rgb(23% 51% 96%)}',
        '#app{width:3485px}',
    ].join('');

    assert.equal(remapCss(css), css);
});

test('leaves no blue or sky shade behind in a stylesheet that uses all of them', () => {
    const sources = Object.values(SOURCE_PALETTES).flatMap((palette) => Object.values(palette));
    const css = sources.map((hex, index) => `.a${index}{color:${hex};background:rgb(${rgb(hex).join(' ')} / .5)}`).join('');
    const output = remapCss(css).toLowerCase();

    for (const hex of sources) {
        assert.ok(!output.includes(hex), `${hex} survived`);
        assert.ok(!output.includes(`rgb(${rgb(hex).join(' ')} `), `rgb(${rgb(hex).join(' ')}) survived`);
    }
});

test('navy shades stay readable where the console uses them', () => {
    const white = '#ffffff';
    const gray800 = '#1f2937';
    const gray900 = '#111827';
    const pairs = [
        ['white text on primary buttons (500)', white, NAVY[500], 4.5],
        ['white text on 600', white, NAVY[600], 4.5],
        ['white text on hover (400)', white, NAVY[400], 3],
        ['links (600) on white', NAVY[600], white, 4.5],
        ['info text (900) on 50', NAVY[900], NAVY[50], 7],
        ['badge text (800) on 100', NAVY[800], NAVY[100], 7],
        ['dark-mode text (400) on gray-900', NAVY[400], gray900, 4.5],
        ['dark-mode text (400) on gray-800', NAVY[400], gray800, 4.5],
        ['dark-mode info text (300) on 900', NAVY[300], NAVY[900], 4.5],
    ];

    for (const [label, foreground, background, minimum] of pairs) {
        const ratio = contrast(foreground, background);
        assert.ok(ratio >= minimum, `${label}: ${ratio.toFixed(2)} < ${minimum}`);
    }
});
