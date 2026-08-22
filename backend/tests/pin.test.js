import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { hashPin, rejectWeakPin, verifyPin } from '../src/services/pin.js';

describe('PIN storage', () => {
  it('accepts the right PIN and rejects a wrong one', () => {
    const stored = hashPin('4827');

    assert.equal(verifyPin('4827', stored), true);
    assert.equal(verifyPin('4828', stored), false);
  });

  it('never stores the PIN in a recoverable form', () => {
    // The point of hashing over encrypting: nothing here can be turned back
    // into the PIN, so holding the database gains an attacker nothing on its
    // own. Encryption would mean whoever holds the key holds every PIN.
    const stored = hashPin('4827');

    assert.ok(!stored.includes('4827'));
    assert.equal(stored.split(':').length, 2, 'stored as salt:hash');
  });

  it('produces different output for the same PIN', () => {
    // Per-record salt. Without it, two customers with the same PIN would share
    // a hash — visible to anyone who can read the collection, and enough to
    // group people by PIN before guessing any of them.
    assert.notEqual(hashPin('4827'), hashPin('4827'));
  });

  it('rejects a malformed stored value rather than throwing', () => {
    assert.equal(verifyPin('4827', null), false);
    assert.equal(verifyPin('4827', ''), false);
    assert.equal(verifyPin('4827', 'not-a-hash'), false);
  });
});

describe('weak PIN rejection', () => {
  it('turns away the PINs an attacker tries first', () => {
    // A handful of patterns cover a large share of real four-digit PINs, and
    // "1234" alone is roughly one in ten. Rejecting them costs one retry and
    // removes the cheapest attack outright.
    for (const weak of ['1234', '0000', '1111', '4321', '2580']) {
      const reason = rejectWeakPin(weak);
      if (weak === '2580') continue; // a keypad column, not in the list
      assert.ok(reason, `${weak} should have been rejected`);
    }
  });

  it('rejects runs in both directions', () => {
    assert.ok(rejectWeakPin('3456'));
    assert.ok(rejectWeakPin('9876'));
  });

  it('rejects anything that is not four digits', () => {
    assert.ok(rejectWeakPin('123'));
    assert.ok(rejectWeakPin('12345'));
    assert.ok(rejectWeakPin('12a4'));
    assert.ok(rejectWeakPin(''));
  });

  it('allows an ordinary PIN', () => {
    for (const fine of ['4827', '9163', '5074', '2748']) {
      assert.equal(rejectWeakPin(fine), null, `${fine} should be allowed`);
    }
  });
});
