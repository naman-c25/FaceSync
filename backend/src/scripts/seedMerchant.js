import { randomBytes } from 'node:crypto';

import mongoose from 'mongoose';

import { config } from '../config/index.js';
import { Merchant } from '../models/Merchant.js';
import { hashPassword } from '../services/merchantAuth.js';

/**
 * Create a merchant terminal account.
 *
 *     node src/scripts/seedMerchant.js "Corner Store" corner@shop.test
 *     node src/scripts/seedMerchant.js "Corner Store" corner@shop.test --password mine
 *
 * There is no self-registration endpoint, on purpose. A merchant terminal can
 * charge a customer's face, so who gets one is an administrative decision, not
 * something anyone with an email address grants themselves. Deriving the role
 * from the email — treating "@merchant" in an address as authorisation — would
 * hand a terminal to whoever registered that address.
 */
const [, , name, email, ...rest] = process.argv;

if (!name || !email) {
  console.error('Usage: node src/scripts/seedMerchant.js "<name>" <email> [--password <pw>]');
  process.exit(1);
}

const flagIndex = rest.indexOf('--password');
const password =
  flagIndex >= 0 ? rest[flagIndex + 1] : randomBytes(9).toString('base64url');

const merchantId = email.split('@')[0].toLowerCase().replace(/[^a-z0-9-]/g, '-');

async function main() {
  await mongoose.connect(config.MONGODB_URI);

  const existing = await Merchant.findOne({ email: email.toLowerCase() });
  if (existing) {
    console.error(`A merchant already exists for ${email} (${existing.merchantId}).`);
    process.exitCode = 1;
    return;
  }

  const merchant = await Merchant.create({
    merchantId,
    name,
    email: email.toLowerCase(),
    passwordHash: hashPassword(password),
    role: 'merchant',
  });

  console.log(`\nMerchant created.\n`);
  console.log(`  name         ${merchant.name}`);
  console.log(`  merchantId   ${merchant.merchantId}`);
  console.log(`  email        ${merchant.email}`);
  console.log(`  password     ${password}`);
  console.log(
    flagIndex >= 0
      ? '\nKeep that password somewhere safe.'
      : '\nGenerated password — it is not stored anywhere in readable form, so copy it now.',
  );
}

main()
  .catch((error) => {
    console.error(`\n${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
