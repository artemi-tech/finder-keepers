import {test} from 'node:test';
import assert from 'node:assert/strict';
import {reconciliationAction as action} from '../lib/reconciliation';
test('pending signatures cannot be released by timeout or blockhash expiry',()=>{for(const confirmationStatus of ['processed','confirmed',null])assert.equal(action({confirmationStatus},999,100),'wait');});
test('finalized transactions require on-chain result inspection',()=>{assert.equal(action({confirmationStatus:'finalized'},999,100),'finalize');});
test('only proven expired absent signatures release a reservation',()=>{assert.equal(action(null,100,100),'retry');assert.equal(action(null,99,100),'retry');assert.equal(action(null,101,100),'expire');});
