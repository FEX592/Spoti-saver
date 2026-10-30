'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { defaultBaseDir } = require('./utils');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

function defaultOutputPath() {
    return defaultBaseDir();
}

function readConfig() {
    try {
        const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
        const config = JSON.parse(raw);
        return config && typeof config === 'object' ? config : {};
    } catch (_) {
        return {};
    }
}

function writeConfig(config) {
    const tempPath = `${CONFIG_PATH}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, CONFIG_PATH);
}

function expandPath(value) {
    let result = String(value).trim();
    if (result.startsWith('~')) {
        result = path.join(os.homedir(), result.slice(1));
    }
    result = result.replace(/%([^%]+)%/g, (_, name) => process.env[name] || `%${name}%`);
    result = result.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] || '${' + name + '}');
    return path.normalize(result);
}

function getOutputPath(cliOverride) {
    if (cliOverride) return expandPath(cliOverride);
    const configured = readConfig().outputPath;
    return expandPath(configured || defaultOutputPath());
}

function setOutputPath(outputPath) {
    const normalized = expandPath(outputPath);
    const config = readConfig();
    config.outputPath = normalized;
    writeConfig(config);
    return normalized;
}

module.exports = {
    CONFIG_PATH,
    defaultOutputPath,
    expandPath,
    getOutputPath,
    readConfig,
    setOutputPath,
};
