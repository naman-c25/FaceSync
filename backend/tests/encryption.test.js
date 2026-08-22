import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  decryptEmbedding,
  encryptEmbedding,
  safeEqual,
} from '../src/services/encryption.js';

/** A 512-dimension float32 embedding, the shape actually stored. */
function embedding() {
  return randomBytes(512 * 4);
}

describe('embedding encryption', () => {
  it('round-trips an embedding exactly', () => {
    const original = embedding();
    assert.deepEqual(decryptEmbedding(encryptEmbedding(original)), original);
  });

  it('produces different ciphertext for identical input', () => {
    // A fresh IV per record. Without it, two users with similar embeddings
    // would produce visibly related ciphertext, leaking that they are similar
    // to anyone who can read the collection.
    const original = embedding();
    const first = encryptEmbedding(original);
    const second = encryptEmbedding(original);

    assert.notDeepEqual(first, second);
    assert.deepEqual(decryptEmbedding(first), decryptEmbedding(second));
  });

  it('refuses to decrypt a modified ciphertext', () => {
    // The point of GCM over CBC. A tampered record must fail loudly rather
    // than decrypt to plausible garbage that then gets matched against.
    const sealed = encryptEmbedding(embedding());
    sealed[sealed.length - 5] ^= 0xff;

    assert.throws(() => decryptEmbedding(sealed));
  });

  it('refuses to decrypt when the auth tag is altered', () => {
    const sealed = encryptEmbedding(embedding());
    sealed[20] ^= 0x01;

    assert.throws(() => decryptEmbedding(sealed));
  });

  it('reports a key version mismatch rather than failing obscurely', () => {
    const sealed = encryptEmbedding(embedding());
    sealed[0] = 99;

    assert.throws(() => decryptEmbedding(sealed), /key version 99/);
  });

  it('rejects input that is not a buffer of data', () => {
    assert.throws(() => encryptEmbedding('a string'), TypeError);
    assert.throws(() => encryptEmbedding(Buffer.alloc(0)), TypeError);
    assert.throws(() => decryptEmbedding(Buffer.alloc(4)), TypeError);
  });

  it('prefixes each record with its key version', () => {
    assert.equal(encryptEmbedding(embedding())[0], 1);
  });
});

describe('safeEqual', () => {
  it('matches identical values and rejects different ones', () => {
    assert.equal(safeEqual('4821', '4821'), true);
    assert.equal(safeEqual('4821', '4822'), false);
  });

  it('returns false for different lengths instead of throwing', () => {
    // timingSafeEqual throws on a length mismatch, which would leak the length
    // through an exception rather than a return value.
    assert.equal(safeEqual('4821', '48219'), false);
    assert.equal(safeEqual('', 'x'), false);
  });
});
