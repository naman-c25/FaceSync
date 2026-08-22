import { randomBytes } from 'node:crypto';

/**
 * Print a fresh AES-256 key.
 *
 *     npm run keygen
 *
 * Put the result in .env as ENCRYPTION_KEY. Losing it means every stored
 * embedding becomes unreadable and every user has to enrol again — so treat it
 * the way you would a database password, and never commit it.
 */
console.log(`ENCRYPTION_KEY=${randomBytes(32).toString('hex')}`);
