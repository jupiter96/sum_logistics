/* eslint-env node */
'use strict';

const fs = require('fs');
const path = require('path');
const Funnel = require('broccoli-funnel');
const mergeTrees = require('broccoli-merge-trees');
const { remapCss } = require('./remap');

// broccoli-plugin is not a direct dependency of the console. Load the copy that
// broccoli-merge-trees is built on, which also resolves under pnpm's strict layout.
// eslint-disable-next-line n/no-missing-require -- resolved from broccoli-merge-trees, not the console
const Plugin = require(require.resolve('broccoli-plugin', { paths: [path.dirname(require.resolve('broccoli-merge-trees'))] }));

function listFiles(root, directory = '') {
    return fs.readdirSync(path.join(root, directory)).flatMap((name) => {
        const relative = path.join(directory, name);
        return fs.statSync(path.join(root, relative)).isDirectory() ? listFiles(root, relative) : [relative];
    });
}

class RemapCssColors extends Plugin {
    constructor(inputNode) {
        super([inputNode], { annotation: 'navy-theme: remap CSS colours', persistentOutput: false, needsCache: false });
    }

    build() {
        const [inputPath] = this.inputPaths;
        for (const file of listFiles(inputPath)) {
            const target = path.join(this.outputPath, file);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, remapCss(fs.readFileSync(path.join(inputPath, file), 'utf8')));
        }
    }
}

module.exports = {
    name: require('./package').name,

    // Runs on the finished build, so it covers the app, ember-ui and every lazy
    // engine's stylesheet. Ordered before fingerprinting and SRI (see package.json)
    // so asset hashes match the recoloured files.
    postprocessTree(type, tree) {
        if (type !== 'all') {
            return tree;
        }

        const css = new Funnel(tree, { include: ['**/*.css'], annotation: 'navy-theme: stylesheets' });
        return mergeTrees([tree, new RemapCssColors(css)], { overwrite: true, annotation: 'navy-theme: recoloured stylesheets' });
    },
};
