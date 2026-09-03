const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..', '..');
const live2dPath = path.join(projectRoot, 'static', 'live2d', 'live2d-core.js');
const vrmPath = path.join(projectRoot, 'static', 'vrm', 'vrm-core.js');
const mmdPath = path.join(projectRoot, 'static', 'mmd', 'mmd-core.js');

function resolvePreference({ pet = false, configured = '' } = {}) {
    const source = fs.readFileSync(live2dPath, 'utf8');
    const match = source.match(/function resolveAvatarWebGLPowerPreference\(\) \{[\s\S]*?\n\}/);
    assert.ok(match, 'Live2D WebGL preference resolver is missing');
    const resolver = vm.runInNewContext(`(${match[0]})`, {
        window: {
            __LANLAN_IS_ELECTRON_PET__: pet,
            __NEKO_WEBGL_POWER_PREFERENCE__: configured
        }
    });
    return resolver();
}

test('desktop pet defaults WebGL to the display-selected adapter', () => {
    assert.equal(resolvePreference({ pet: true }), 'default');
    assert.equal(resolvePreference({ pet: false }), 'high-performance');
});

test('explicit WebGL adapter preference remains available for diagnostics', () => {
    assert.equal(resolvePreference({ pet: true, configured: 'low-power' }), 'low-power');
    assert.equal(resolvePreference({ pet: true, configured: 'high-performance' }), 'high-performance');
    assert.equal(resolvePreference({ pet: true, configured: 'invalid' }), 'default');
});

test('VRM and MMD use the shared adapter policy instead of forcing the dGPU', () => {
    for (const file of [vrmPath, mmdPath]) {
        const source = fs.readFileSync(file, 'utf8');
        assert.match(source, /powerPreference,/, `${file} should pass the resolved preference`);
        assert.doesNotMatch(source, /powerPreference:\s*['"]high-performance['"]/, `${file} must not force high-performance WebGL`);
    }
});
