'use strict';

const assert = require('assert');
const status = require('../lib/status');

(async () => {
    let nestedRan = false;
    const result = await status.withStatus('outer', async task => {
        task.update('preparing');
        await status.withStatus('nested', async nested => {
            nestedRan = true;
            nested.update('42%');
        });
        task.update('complete');
        return 'ok';
    });
    assert.strictEqual(result, 'ok');
    assert.strictEqual(nestedRan, true);
    assert.strictEqual(status.isActive(), false);

    await assert.rejects(
        status.withStatus('failure', async () => {
            await status.withStatus('child failure', async () => {
                throw new Error('expected test failure');
            });
        }),
        /expected test failure/
    );
    assert.strictEqual(status.isActive(), false);
    console.log('status manager tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
